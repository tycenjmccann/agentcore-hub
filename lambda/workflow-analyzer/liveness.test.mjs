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
  it("emits the namespace, mode field, and four zeroed metrics", () => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
    emitLivenessMetrics({ mode: "shadow" });
    expect(spy).toHaveBeenCalledTimes(1);
    const rec = JSON.parse(spy.mock.calls[0][0]);
    expect(rec._aws.CloudWatchMetrics[0].Namespace).toBe("AgentCoreHub/Orchestrator");
    const names = rec._aws.CloudWatchMetrics[0].Metrics.map((m) => m.Name).sort();
    expect(names).toEqual(["LivenessShadowDivergence", "LivenessSpanFreshSkips", "LivenessStaleTickets", "LivenessWatchFired"]);
    expect(rec.LivenessMode).toBe("shadow");
    expect(rec.LivenessStaleTickets).toBe(0);
    expect(rec.LivenessWatchFired).toBe(0);
    expect(rec.LivenessSpanFreshSkips).toBe(0);
    expect(rec.LivenessShadowDivergence).toBe(0);
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
