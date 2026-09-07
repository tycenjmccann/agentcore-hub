import { describe, it, expect, vi, afterEach } from "vitest";
import {
  LIVENESS_MODES,
  normalizeLivenessMode,
  thresholdsFromEnv,
  computeSilenceMs,
  thresholdFor,
  computeStaleTickets,
  decideWatch,
  buildLivenessTickets,
  activeTicketIds,
  maxThresholdMs,
  eventsWindowFloor,
  missingSampleTicketIds,
  livenessWindowSatisfied,
  LEGACY_EVENT_WINDOW,
  NON_SIGNIFICANT_EVENT_TYPES,
  legacySignificantEventAge,
  phaseForAgent,
  isParkedOnHuman,
  parkedOnHuman,
  emitLivenessMetrics,
} from "./liveness.mjs";
// The mjs mirror + its TS twin must agree (both read src/config/liveness-constants.json).
import {
  LIVENESS_DEV_MS,
  LIVENESS_VERIFY_MS,
  LIVENESS_SHIP_MS,
  LIVENESS_SPAN_FRESH_MS,
  LIVENESS_DEFAULT_MS,
} from "./liveness-constants.mjs";
import * as tsConsts from "@/lib/workflow/liveness-constants";
// §2.1 sync anchors: the board STUCK thresholds + the lease TTL.
import { STALE_THRESHOLD_CLAUDE_CODE_MS } from "@/lib/workflow/stale";
import { LEASE_TTL_MS } from "../orchestrator/lease.mjs";

/**
 * TEAM-4166 D2 — unit suite for the pure liveness clock (lambda/workflow-analyzer/
 * liveness.mjs). Every branch runs against plain objects; no AWS, no real clock.
 */

const MIN = 60_000;
const DEFAULT_THRESHOLDS = thresholdsFromEnv({}); // 45/20/12/2/10 min

describe("normalizeLivenessMode — garbage coerces to SHADOW, never off", () => {
  it("passes the three known modes through unchanged (case/space-insensitive)", () => {
    expect(normalizeLivenessMode("off")).toBe("off");
    expect(normalizeLivenessMode("shadow")).toBe("shadow");
    expect(normalizeLivenessMode("enforce")).toBe("enforce");
    expect(normalizeLivenessMode("  ENFORCE ")).toBe("enforce");
  });

  it("coerces every unrecognized value to SHADOW (the fail-safe direction)", () => {
    const log = vi.fn();
    for (const bad of ["", "  ", undefined, null, "on", "true", "main-first", "0", "enforced"]) {
      expect(normalizeLivenessMode(bad, log)).toBe("shadow");
    }
    // Never off — a typo must not silently blind the watchdog.
    expect(normalizeLivenessMode("of", log)).toBe("shadow");
    expect(log).toHaveBeenCalled(); // logged via the injected log, not console
  });

  it("exposes the allow-list", () => {
    expect(LIVENESS_MODES).toEqual(["off", "shadow", "enforce"]);
  });
});

describe("thresholdsFromEnv — env overrides on top of the shared defaults", () => {
  it("defaults to 45/20/12/2/10 minutes when no env is set", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      devMs: 45 * MIN, verifyMs: 20 * MIN, shipMs: 12 * MIN, spanFreshMs: 2 * MIN, defaultMs: 10 * MIN,
    });
  });

  it("honors positive numeric overrides per knob", () => {
    const t = thresholdsFromEnv({
      WM_LIVENESS_DEV_MINUTES: "30", WM_LIVENESS_VERIFY_MINUTES: "15",
      WM_LIVENESS_SHIP_MINUTES: "8", WM_LIVENESS_SPAN_FRESH_MINUTES: "1", WM_LIVENESS_DEFAULT_MINUTES: "6",
    });
    expect(t).toEqual({ devMs: 30 * MIN, verifyMs: 15 * MIN, shipMs: 8 * MIN, spanFreshMs: 1 * MIN, defaultMs: 6 * MIN });
  });

  it("falls back to the default for a non-numeric or ≤0 override (that knob only)", () => {
    const t = thresholdsFromEnv({
      WM_LIVENESS_DEV_MINUTES: "abc", WM_LIVENESS_VERIFY_MINUTES: "0",
      WM_LIVENESS_SHIP_MINUTES: "-5", WM_LIVENESS_DEFAULT_MINUTES: "6",
    });
    expect(t.devMs).toBe(45 * MIN);    // non-numeric → default
    expect(t.verifyMs).toBe(20 * MIN); // 0 → default
    expect(t.shipMs).toBe(12 * MIN);   // negative → default
    expect(t.spanFreshMs).toBe(2 * MIN); // unset → default
    expect(t.defaultMs).toBe(6 * MIN); // valid override survives
  });
});

describe("span-fresh override — a streaming ticket is NEVER stale, any phase", () => {
  it("returns Infinity (never stale) when a stream landed within spanFreshMs", () => {
    const now = 10_000 * MIN;
    // Streaming every 20s: last stream 20s ago, but idle by any phase clock via startedAt.
    const t = {
      phase: "x", lastStreamAt: now - 20_000, lastSpanAt: now - 20_000,
      lastEventAt: now - 20_000, startedAt: now - 5 * 60 * MIN,
    };
    for (const phase of ["development", "verification", "ship", "gate", "default"]) {
      const th = thresholdFor(phase, { nowMs: now, lastStreamAt: t.lastStreamAt, lastSpanAt: t.lastSpanAt }, DEFAULT_THRESHOLDS);
      expect(th).toBe(Infinity);
    }
    expect(computeStaleTickets([{ ...t, phase: "ship" }], now, DEFAULT_THRESHOLDS)).toEqual([]);
  });

  it("does NOT apply once the last stream is older than spanFreshMs", () => {
    const now = 10_000 * MIN;
    const th = thresholdFor("development", { nowMs: now, lastStreamAt: now - 3 * MIN, lastSpanAt: now - 3 * MIN }, DEFAULT_THRESHOLDS);
    expect(th).toBe(45 * MIN); // 3 min > 2 min span-fresh → falls through to phase
  });
});

describe("thresholdFor — per-phase thresholds at the boundary", () => {
  const now = 10_000 * MIN;
  const noStream = { nowMs: now, lastStreamAt: null, lastSpanAt: null };
  it("maps each phase to its threshold", () => {
    expect(thresholdFor("development", noStream, DEFAULT_THRESHOLDS)).toBe(45 * MIN);
    expect(thresholdFor("verification", noStream, DEFAULT_THRESHOLDS)).toBe(20 * MIN);
    expect(thresholdFor("ship", noStream, DEFAULT_THRESHOLDS)).toBe(12 * MIN);
    expect(thresholdFor("gate", noStream, DEFAULT_THRESHOLDS)).toBe(12 * MIN);
    expect(thresholdFor("anything-else", noStream, DEFAULT_THRESHOLDS)).toBe(10 * MIN);
  });

  it("is stale at exactly the threshold, fresh one ms under it", () => {
    const atBoundary = { phase: "ship", startedAt: now - 12 * MIN }; // silence == shipMs
    const underBoundary = { phase: "ship", startedAt: now - 12 * MIN + 1 };
    expect(computeStaleTickets([atBoundary], now, DEFAULT_THRESHOLDS)).toHaveLength(1);
    expect(computeStaleTickets([underBoundary], now, DEFAULT_THRESHOLDS)).toHaveLength(0);
  });
});

describe("TEAM-4186 F6 legacySignificantEventAge — the legacy clock sees 25 rows", () => {
  const now = 10_000 * MIN;
  const iso = (ms) => new Date(ms).toISOString();
  const LEGACY_STALE_MS = 10 * MIN; // WM_STALE_MINUTES default, as in index.mjs

  /**
   * The PRE-EPIC decision, re-implemented here from the analyzer as it stood
   * before TEAM-4166: a Query with `Limit: 25` (no FilterExpression) followed by
   * the find. `rows` is the full newest-first table ordering, so `slice(0, 25)`
   * models exactly what that Query returned. This is the oracle — the fix is
   * correct iff the shipped function agrees with it on every window.
   */
  const preEpicOracle = (rows, nowMs) => {
    const items = (rows || []).slice(0, 25); // the Query's Limit
    const item = items.find((e) => !new Set(["agent.streaming", "orchestrator.nudge"]).has(e.type)) || items[0];
    if (!item?.timestamp) return null;
    return nowMs - Date.parse(item.timestamp);
  };

  /** n streaming rows, newest first, one every 2s — a healthy generating agent. */
  const streamingBurst = (n, fromMs) =>
    Array.from({ length: n }, (_, i) => ({ type: "agent.streaming", timestamp: iso(fromMs - i * 2_000) }));

  it("LEGACY_EVENT_WINDOW is 25 — the pre-epic Query limit, named", () => {
    expect(LEGACY_EVENT_WINDOW).toBe(25);
  });

  it("matches the pre-epic oracle on a 50-row burst whose first 25 are agent.streaming and agent.invoked sits at row 26", () => {
    const rows = [
      ...streamingBurst(25, now - 1_000),                        // rows 1-25: healthy chatter
      { type: "agent.invoked", timestamp: iso(now - 15 * MIN) }, // row 26: the trap
      ...streamingBurst(24, now - 16 * MIN),
    ];
    expect(rows).toHaveLength(50);
    const got = legacySignificantEventAge(rows.slice(0, LEGACY_EVENT_WINDOW), now);
    expect(got).toBe(preEpicOracle(rows, now));
    expect(got).toBe(1_000);                 // fell back to items[0], a streaming row
    expect(got).toBeLessThan(LEGACY_STALE_MS); // → no fire, as pre-epic
  });

  it("the slice is load-bearing: the unsliced 50-row answer WOULD fire (>= STALE_MS) where the sliced one does not", () => {
    const rows = [
      ...streamingBurst(25, now - 1_000),
      { type: "agent.invoked", timestamp: iso(now - 15 * MIN) },
      ...streamingBurst(24, now - 16 * MIN),
    ];
    const regressed = legacySignificantEventAge(rows, now);          // the TEAM-4166 behaviour
    const restored = legacySignificantEventAge(rows.slice(0, LEGACY_EVENT_WINDOW), now);
    expect(regressed).toBe(15 * MIN);
    expect(regressed >= LEGACY_STALE_MS).toBe(true);                 // fires on a healthy agent
    expect(restored >= LEGACY_STALE_MS).toBe(false);                 // F6: does not
  });

  it("boundary — a significant row at position 25 is seen, at 26 is not", () => {
    const at = (pos) => {
      const rows = streamingBurst(50, now - 1_000);
      rows[pos - 1] = { type: "agent.invoked", timestamp: iso(now - 15 * MIN) };
      return legacySignificantEventAge(rows.slice(0, LEGACY_EVENT_WINDOW), now);
    };
    expect(at(25)).toBe(15 * MIN);  // last row inside the window
    expect(at(26)).toBe(1_000);     // first row outside → items[0] fallback
  });

  it("an all-streaming window falls back to items[0] (age ~ 0 — the healthy-agent path)", () => {
    const rows = streamingBurst(25, now - 500);
    expect(legacySignificantEventAge(rows, now)).toBe(500);
    expect(legacySignificantEventAge(rows, now)).toBe(preEpicOracle(rows, now));
  });

  it("orchestrator.nudge is still non-significant (TEAM-3969)", () => {
    expect([...NON_SIGNIFICANT_EVENT_TYPES].sort()).toEqual(["agent.streaming", "orchestrator.nudge"]);
    const rows = [
      { type: "orchestrator.nudge", timestamp: iso(now - 1_000) },
      { type: "agent.streaming", timestamp: iso(now - 2_000) },
      { type: "tool_end", timestamp: iso(now - 30 * MIN) },
    ];
    expect(legacySignificantEventAge(rows, now)).toBe(30 * MIN); // skipped both
  });

  it("null for an empty/absent list or a timestamp-less row", () => {
    expect(legacySignificantEventAge([], now)).toBeNull();
    expect(legacySignificantEventAge(undefined, now)).toBeNull();
    expect(legacySignificantEventAge(null, now)).toBeNull();
    expect(legacySignificantEventAge([{ type: "tool_end" }], now)).toBeNull();
    expect(legacySignificantEventAge([{ type: "agent.streaming" }], now)).toBeNull();
  });
});

describe("buildLivenessTickets — bucketing, fallbacks, and no-data → not active", () => {
  const now = 10_000 * MIN;
  const iso = (ms) => new Date(ms).toISOString();

  it("keeps only active claims and picks the newest stream / event per ticket", () => {
    const agentTasks = {
      "T-1": { agentId: "agentcore_hub_backend_dev", ticketId: "T-1", status: "running", startedAt: iso(now - 40 * MIN) },
      "T-2": { agentId: "agentcore_hub_qa_engineer", ticketId: "T-2", status: "in_progress", startedAt: iso(now - 5 * MIN) },
      "T-done": { agentId: "x", ticketId: "T-done", status: "done", startedAt: iso(now - 1 * MIN) },
    };
    const events = [
      { type: "agent.streaming", timestamp: iso(now - 30 * MIN), detail: { ticketId: "T-1" } },
      { type: "agent.streaming", timestamp: iso(now - 10 * MIN), detail: { ticketId: "T-1" } }, // newest stream
      { type: "tool_end", timestamp: iso(now - 2 * MIN), detail: { ticketId: "T-1" } },          // newest event (non-stream)
      { type: "agent.started", timestamp: iso(now - 4 * MIN), detail: { ticketId: "T-2" } },
    ];
    const out = buildLivenessTickets({ agentTasks, events, nowMs: now, phaseOf: (_id, t) => phaseForAgent(t.agentId, "ship") });
    const byId = Object.fromEntries(out.map((t) => [t.ticketId, t]));
    expect(Object.keys(byId).sort()).toEqual(["T-1", "T-2"]); // done dropped
    expect(byId["T-1"].lastStreamAt).toBe(now - 10 * MIN);
    expect(byId["T-1"].lastSpanAt).toBe(now - 10 * MIN); // Q1 proxy = lastStreamAt
    expect(byId["T-1"].lastEventAt).toBe(now - 2 * MIN);  // newest of ANY type
    expect(byId["T-1"].phase).toBe("development");        // backend_dev
    expect(byId["T-2"].lastStreamAt).toBeNull();          // only a non-streaming event
    expect(byId["T-2"].lastEventAt).toBe(now - 4 * MIN);
    expect(byId["T-2"].phase).toBe("verification");       // qa
  });

  it("falls back to the claim startedAt when a ticket has no events", () => {
    const agentTasks = { "T-3": { agentId: "a", ticketId: "T-3", status: "running", startedAt: iso(now - 7 * MIN) } };
    const [t] = buildLivenessTickets({ agentTasks, events: [], nowMs: now });
    expect(t.lastStreamAt).toBeNull();
    expect(t.startedAt).toBe(now - 7 * MIN);
    expect(computeSilenceMs(t, now)).toBe(7 * MIN);
  });

  it("drops a ticket with NO timestamp at all (fail toward not firing)", () => {
    const agentTasks = { "T-4": { agentId: "a", ticketId: "T-4", status: "running" } }; // no startedAt, no events
    expect(buildLivenessTickets({ agentTasks, events: [], nowMs: now })).toEqual([]);
  });

  it("treats a live lease as active even for a non-running status", () => {
    const agentTasks = { "T-5": { agentId: "a", ticketId: "T-5", status: "in_review", startedAt: iso(now - 3 * MIN) } };
    const none = buildLivenessTickets({ agentTasks, events: [], nowMs: now });
    expect(none).toEqual([]); // in_review is not an active status on its own
    const live = buildLivenessTickets({ agentTasks, events: [], nowMs: now, isLeaseLive: () => true });
    expect(live).toHaveLength(1);
  });

  it("accepts ISO or epoch-ms event timestamps identically", () => {
    const agentTasks = { "T-6": { agentId: "a", ticketId: "T-6", status: "running", startedAt: now - 30 * MIN } };
    const events = [{ type: "agent.streaming", timestamp: now - 1 * MIN, detail: { ticketId: "T-6" } }];
    const [t] = buildLivenessTickets({ agentTasks, events, nowMs: now });
    expect(t.lastStreamAt).toBe(now - 1 * MIN);
    expect(t.startedAt).toBe(now - 30 * MIN); // numeric startedAt parsed too
  });
});

describe("TEAM-4186 F7 — the bounded event window cannot starve a sibling into a false stale", () => {
  const now = 10_000 * MIN;
  const iso = (ms) => new Date(ms).toISOString();
  const DEV = { phaseOf: () => "development" }; // devMs = 45 min
  const tasks = (startedAtMs) => ({
    "T-dev": { agentId: "agentcore_hub_backend_dev", ticketId: "T-dev", status: "running", startedAt: iso(startedAtMs) },
  });
  /** The window holds ONLY a chatty sibling's rows — T-dev is starved. */
  const siblingOnly = (fromMs, n = 3) =>
    Array.from({ length: n }, (_, i) => ({
      type: "agent.streaming",
      timestamp: iso(fromMs - i * 2_000),
      detail: { ticketId: "T-loud" },
    }));

  describe("window helpers — the READ and the DECISION agree on what is active", () => {
    it("activeTicketIds matches the tickets buildLivenessTickets keeps", () => {
      const agentTasks = {
        A: { agentId: "a", status: "running", startedAt: iso(now - MIN) },
        B: { agentId: "b", status: "in_progress", startedAt: iso(now - MIN) },
        C: { agentId: "c", status: "done", startedAt: iso(now - MIN) },
        D: { agentId: "d", status: "in_review", startedAt: iso(now - MIN) },
      };
      expect(activeTicketIds({ agentTasks }).sort()).toEqual(["A", "B"]);
      expect(buildLivenessTickets({ agentTasks, events: [], nowMs: now }).map((t) => t.ticketId).sort())
        .toEqual(activeTicketIds({ agentTasks }).sort());
      // a live lease is active on either side
      const live = { agentTasks, isLeaseLive: (t) => t?.agentId === "d" };
      expect(activeTicketIds(live).sort()).toEqual(["A", "B", "D"]);
      expect(buildLivenessTickets({ ...live, events: [], nowMs: now }).map((t) => t.ticketId).sort())
        .toEqual(activeTicketIds(live).sort());
      expect(activeTicketIds()).toEqual([]);
    });

    it("maxThresholdMs is the largest PHASE threshold and ignores spanFreshMs", () => {
      expect(maxThresholdMs(DEFAULT_THRESHOLDS)).toBe(45 * MIN); // dev dominates
      expect(maxThresholdMs({ devMs: 1, verifyMs: 2, shipMs: 3, defaultMs: 9, spanFreshMs: 999 })).toBe(9);
      expect(maxThresholdMs({})).toBe(0);
    });

    it("eventsWindowFloor is the OLDEST parseable row (null when there are none)", () => {
      const evs = [{ timestamp: iso(now - MIN) }, { ts: now - 30 * MIN }, { timestamp: "nonsense" }];
      expect(eventsWindowFloor(evs)).toBe(now - 30 * MIN);
      expect(eventsWindowFloor([])).toBeNull();
      expect(eventsWindowFloor(undefined)).toBeNull();
      expect(eventsWindowFloor([{ type: "x" }])).toBeNull();
    });

    it("missingSampleTicketIds names only the starved tickets", () => {
      const events = [...siblingOnly(now - 1_000), { type: "tool_end", timestamp: iso(now - MIN), detail: { ticketId: "T-dev" } }];
      expect(missingSampleTicketIds({ activeTicketIds: ["T-dev", "T-loud", "T-quiet"], events })).toEqual(["T-quiet"]);
      expect(missingSampleTicketIds({ activeTicketIds: [], events })).toEqual([]);
      expect(missingSampleTicketIds({ activeTicketIds: ["T-dev"], events: [] })).toEqual(["T-dev"]);
    });

    it("livenessWindowSatisfied — keep paging while a ticket is starved and the floor is recent", () => {
      const events = siblingOnly(now - 1_000); // floor ~ now, T-dev has nothing
      expect(livenessWindowSatisfied({
        activeTicketIds: ["T-dev", "T-loud"], events, nowMs: now, maxThresholdMs: 45 * MIN,
      })).toBe(false);
    });

    it("livenessWindowSatisfied — stop once every active ticket has a sample", () => {
      const events = [...siblingOnly(now - 1_000), { type: "tool_end", timestamp: iso(now - MIN), detail: { ticketId: "T-dev" } }];
      expect(livenessWindowSatisfied({
        activeTicketIds: ["T-dev", "T-loud"], events, nowMs: now, maxThresholdMs: 45 * MIN,
      })).toBe(true);
    });

    it("livenessWindowSatisfied — stop when the floor is already older than the max threshold (a starved ticket is decided)", () => {
      const events = siblingOnly(now - 46 * MIN); // floor > 45 min back
      expect(livenessWindowSatisfied({
        activeTicketIds: ["T-dev", "T-loud"], events, nowMs: now, maxThresholdMs: 45 * MIN,
      })).toBe(true);
      // exactly AT the horizon is not yet past it — keep reading
      expect(livenessWindowSatisfied({
        activeTicketIds: ["T-dev"], events: [{ timestamp: iso(now - 45 * MIN), detail: { ticketId: "T-loud" } }],
        nowMs: now, maxThresholdMs: 45 * MIN,
      })).toBe(false);
      // an EMPTY window decides nothing
      expect(livenessWindowSatisfied({ activeTicketIds: ["T-dev"], events: [], nowMs: now, maxThresholdMs: 45 * MIN })).toBe(false);
    });
  });

  describe("windowFloorAt — truncation is SOUND, not merely bounded", () => {
    it("a no-sample ticket under a truncated window is anchored at the window floor, not startedAt", () => {
      const floor = now - 40_000;            // the oldest row the cap let us read
      const agentTasks = tasks(now - 3 * 60 * MIN); // claimed 3 hours ago
      const events = siblingOnly(now - 1_000);
      const [t] = buildLivenessTickets({ agentTasks, events, nowMs: now, windowFloorMs: floor, ...DEV });
      expect(t.lastStreamAt).toBeNull();
      expect(t.lastEventAt).toBeNull();
      expect(t.windowFloorAt).toBe(floor);
      expect(computeSilenceMs(t, now)).toBe(40_000);             // NOT 3 hours
      expect(computeStaleTickets([t], now, DEFAULT_THRESHOLDS)).toEqual([]); // NOT stale
      expect(decideWatch({}, [t], now, "enforce", DEFAULT_THRESHOLDS).fire).toBe(false);

      // Load-bearing: without the floor this is exactly the F7 false positive.
      const [starved] = buildLivenessTickets({ agentTasks, events, nowMs: now, ...DEV });
      expect(starved.windowFloorAt).toBeNull();
      expect(computeSilenceMs(starved, now)).toBe(3 * 60 * MIN);
      expect(decideWatch({}, [starved], now, "enforce", DEFAULT_THRESHOLDS).fire).toBe(true);
    });

    it("…and IS stale once the floor itself is older than the threshold", () => {
      const floor = now - 50 * MIN;          // even the lower bound crosses devMs (45m)
      const [t] = buildLivenessTickets({
        agentTasks: tasks(now - 3 * 60 * MIN), events: siblingOnly(now - 1_000),
        nowMs: now, windowFloorMs: floor, ...DEV,
      });
      const [stale] = computeStaleTickets([t], now, DEFAULT_THRESHOLDS);
      expect(stale.ticketId).toBe("T-dev");
      expect(stale.staleAgeMs).toBe(now - floor);
      expect(stale.staleAgeMs).toBe(50 * MIN);
      expect(stale.thresholdMs).toBe(45 * MIN);
      // spanFresh cannot engage on a floor-anchored ticket: lastStreamAt is
      // UNKNOWN, not proven absent.
      const [v] = decideWatch({}, [t], now, "enforce", DEFAULT_THRESHOLDS).verdicts;
      expect(v.spanFresh).toBe(false);
      expect(v.stale).toBe(true);
    });

    it("a ticket WITH a sample ignores windowFloorAt", () => {
      const agentTasks = tasks(now - 3 * 60 * MIN);
      const events = [{ type: "tool_end", timestamp: iso(now - 2 * MIN), detail: { ticketId: "T-dev" } }];
      const [t] = buildLivenessTickets({ agentTasks, events, nowMs: now, windowFloorMs: now - 50 * MIN, ...DEV });
      expect(t.lastEventAt).toBe(now - 2 * MIN);
      expect(t.windowFloorAt).toBeNull();       // newest event known exactly
      expect(computeSilenceMs(t, now)).toBe(2 * MIN);
      expect(computeStaleTickets([t], now, DEFAULT_THRESHOLDS)).toEqual([]);
    });

    it("drops a no-sample ticket only when startedAt AND windowFloorAt are both absent", () => {
      const agentTasks = { "T-x": { agentId: "a", ticketId: "T-x", status: "running" } }; // no startedAt
      expect(buildLivenessTickets({ agentTasks, events: [], nowMs: now })).toEqual([]);
      const [t] = buildLivenessTickets({ agentTasks, events: [], nowMs: now, windowFloorMs: now - MIN });
      expect(t.windowFloorAt).toBe(now - MIN);  // still a candidate on the floor alone
      expect(computeSilenceMs(t, now)).toBe(MIN);
      // an unparseable floor is no floor at all
      expect(buildLivenessTickets({ agentTasks, events: [], nowMs: now, windowFloorMs: "nonsense" })).toEqual([]);
    });
  });
});

describe("decideWatch — fires on the WORST (longest-silent) stale ticket", () => {
  const now = 10_000 * MIN;
  it("picks the most-stalled ticket and reports its phase", () => {
    const tickets = [
      { ticketId: "A", phase: "ship", startedAt: now - 13 * MIN },        // stale by 13m (>12m)
      { ticketId: "B", phase: "development", startedAt: now - 50 * MIN }, // stale by 50m (>45m) — worst
      { ticketId: "C", phase: "development", startedAt: now - 5 * MIN },  // fresh
    ];
    const d = decideWatch({}, tickets, now, "enforce", DEFAULT_THRESHOLDS);
    expect(d.fire).toBe(true);
    expect(d.ticketId).toBe("B");
    expect(d.reason).toBe("stale:development");
    expect(d.staleAgeMs).toBe(50 * MIN);
    expect(d.verdicts.filter((v) => v.stale).map((v) => v.ticketId).sort()).toEqual(["A", "B"]);
  });

  it("does not fire when nothing is stale", () => {
    const tickets = [{ ticketId: "A", phase: "ship", startedAt: now - 1 * MIN }];
    const d = decideWatch({}, tickets, now, "enforce", DEFAULT_THRESHOLDS);
    expect(d).toMatchObject({ fire: false, ticketId: null, reason: null, staleAgeMs: 0 });
  });
});

describe("phaseForAgent — role → liveness phase", () => {
  it("maps the fleet roles and human gates", () => {
    expect(phaseForAgent("agentcore_hub_backend_dev", "ship")).toBe("development");
    expect(phaseForAgent("agentcore_hub_frontend_dev", "ship")).toBe("development");
    expect(phaseForAgent("agentcore_hub_qa_engineer", "ship")).toBe("verification");
    expect(phaseForAgent("agentcore_hub_ci_agent", "ship")).toBe("verification");
    expect(phaseForAgent("agentcore_hub_code_reviewer", "ship")).toBe("verification");
    expect(phaseForAgent("agentcore_hub_release_manager", "development")).toBe("ship");
    expect(phaseForAgent("human:alice", "development")).toBe("gate");
  });

  it("falls back to the workflow phase, then default", () => {
    expect(phaseForAgent("agentcore_hub_requirements_analyst", "design")).toBe("design");
    expect(phaseForAgent("", undefined)).toBe("default");
    expect(phaseForAgent(undefined, null)).toBe("default");
  });
});

describe("emitLivenessMetrics — one EMF record with explicit zeros", () => {
  let spy;
  afterEach(() => spy?.mockRestore());
  it("emits the namespace, mode field, and six zeroed metrics", () => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
    emitLivenessMetrics({ mode: "shadow" });
    expect(spy).toHaveBeenCalledTimes(1);
    const rec = JSON.parse(spy.mock.calls[0][0]);
    expect(rec._aws.CloudWatchMetrics[0].Namespace).toBe("AgentCoreHub/Orchestrator");
    const names = rec._aws.CloudWatchMetrics[0].Metrics.map((m) => m.Name).sort();
    expect(names).toEqual([
      "LivenessShadowDivergence", "LivenessSpanFreshSkips", "LivenessStaleTickets",
      "LivenessWatchFired", "LivenessWindowPages", "LivenessWindowTruncated",
    ]);
    expect(rec.LivenessMode).toBe("shadow");
    expect(rec.LivenessStaleTickets).toBe(0);
    expect(rec.LivenessWatchFired).toBe(0);
    expect(rec.LivenessSpanFreshSkips).toBe(0);
    expect(rec.LivenessShadowDivergence).toBe(0);
    expect(rec.LivenessWindowPages).toBe(0);      // TEAM-4186 F7
    expect(rec.LivenessWindowTruncated).toBe(0);
  });

  it("carries the window counters through when the read had to page", () => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
    emitLivenessMetrics({ mode: "enforce", windowPages: 7, windowTruncated: 2 });
    const rec = JSON.parse(spy.mock.calls[0][0]);
    expect(rec.LivenessWindowPages).toBe(7);
    expect(rec.LivenessWindowTruncated).toBe(2);
  });
});

describe("§2.1/§2.5 sync invariants — constants agree and dominate the anchors", () => {
  it("the TS twin and the mjs mirror carry identical values", () => {
    expect(tsConsts.LIVENESS_DEV_MS).toBe(LIVENESS_DEV_MS);
    expect(tsConsts.LIVENESS_VERIFY_MS).toBe(LIVENESS_VERIFY_MS);
    expect(tsConsts.LIVENESS_SHIP_MS).toBe(LIVENESS_SHIP_MS);
    expect(tsConsts.LIVENESS_SPAN_FRESH_MS).toBe(LIVENESS_SPAN_FRESH_MS);
    expect(tsConsts.LIVENESS_DEFAULT_MS).toBe(LIVENESS_DEFAULT_MS);
  });

  it("§2.5 — the dev window is at least the lease TTL (never fire before a lease could expire)", () => {
    expect(LIVENESS_DEV_MS).toBeGreaterThanOrEqual(LEASE_TTL_MS);
  });

  it("§2.1 — span-fresh < claude_code STUCK, dev window >= claude_code STUCK", () => {
    expect(LIVENESS_SPAN_FRESH_MS).toBeLessThan(STALE_THRESHOLD_CLAUDE_CODE_MS);
    expect(LIVENESS_DEV_MS).toBeGreaterThanOrEqual(STALE_THRESHOLD_CLAUDE_CODE_MS);
  });
});

describe("§2.4 parkedOnHuman / isParkedOnHuman — human-gate predicate", () => {
  it("a bare manager_escalation WITHOUT gateTicketId does NOT park (the f50ucz trap)", () => {
    const wf = { humanNotifications: [{ type: "manager_escalation", acknowledged: false }] };
    expect(isParkedOnHuman(wf)).toBe(false);
    expect(parkedOnHuman).toBe(isParkedOnHuman); // the alias is the same function
  });

  it("a manager_escalation WITH a non-empty gateTicketId parks", () => {
    const wf = { humanNotifications: [{ type: "manager_escalation", gateTicketId: "TEAM-9", acknowledged: false }] };
    expect(isParkedOnHuman(wf)).toBe(true);
    // empty string does not park.
    expect(isParkedOnHuman({ humanNotifications: [{ type: "manager_escalation", gateTicketId: "", acknowledged: false }] })).toBe(false);
  });

  it("review_needed parks iff a human owns it", () => {
    expect(isParkedOnHuman({ humanNotifications: [{ type: "review_needed", humanAssignee: "human:alice", acknowledged: false }] })).toBe(true);
    expect(isParkedOnHuman({ humanNotifications: [{ type: "review_needed", humanAssignee: "agentcore_hub_qa", acknowledged: false }] })).toBe(false);
  });

  it("a legacy review_needed (no humanAssignee) parks off the ticket's agent", () => {
    const human = {
      humanNotifications: [{ type: "review_needed", ticketId: "T-1", acknowledged: false }],
      agentTasks: { "T-1": { agentId: "human:bob" } },
    };
    const agent = {
      humanNotifications: [{ type: "review_needed", ticketId: "T-2", acknowledged: false }],
      agentTasks: { "T-2": { agentId: "agentcore_hub_release_manager" } },
    };
    expect(isParkedOnHuman(human)).toBe(true);
    expect(isParkedOnHuman(agent)).toBe(false);
  });

  it("an acknowledged notification never parks", () => {
    const wf = { humanNotifications: [{ type: "review_needed", humanAssignee: "human:alice", acknowledged: true }] };
    expect(isParkedOnHuman(wf)).toBe(false);
  });
});
