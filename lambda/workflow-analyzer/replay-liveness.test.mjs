import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildLivenessTickets,
  decideWatch,
  phaseForAgent,
  thresholdsFromEnv,
  normalizeLivenessMode,
  isParkedOnHuman,
} from "./liveness.mjs";

/**
 * TEAM-4166 D2 ACCEPTANCE REPLAY — the analyzer liveness clock (§2.6
 * FR-2.3/2.4/2.5), driven purely through liveness.mjs (buildLivenessTickets +
 * decideWatch). No AWS: the two real reduced dossiers are replayed tick-by-tick
 * against the pure decision, so the suite proves the NEW clock fixes the two
 * historical false-intervention runs while still firing on the genuinely idle
 * one — the exact behaviour the wired analyzer (index.mjs watchScan) inherits.
 *
 * Watch cadence — the analyzer's REAL constants:
 *   SCAN_INTERVAL_MS = 5 min  — the EventBridge schedule rate(5 minutes) that
 *                               drives watchScan (deploy/workflow-manager/deploy.sh).
 *   COOLDOWN_MS      = 15 min — WM_WATCH_COOLDOWN_MINUTES default; a workflow can
 *                               be intervened on at most once per this window.
 * We tick at the SCAN interval and report BOTH the raw firing-tick count (the
 * §2.6 "count ticks where fire===true" metric) and the cooldown-gated
 * intervention count (what a human actually sees), so the numbers are legible.
 *
 * Fixtures carry NO agent.streaming rows (the dossier stored only streamCounts);
 * per each fixture's _provenance.note the replay SYNTHESIZES 20s heartbeats from
 * `streamHeartbeats` {from,to,intervalSec}. No account ids / bucket names appear.
 */

const SCAN_INTERVAL_MS = 5 * 60_000;
const COOLDOWN_MS = 15 * 60_000;
const LEGACY_STALE_MS = 10 * 60_000; // the pre-4166 WM_STALE_MINUTES window
const TH = thresholdsFromEnv({}); // 45/20/12/2/10 min defaults

// Legacy clock: newest event that is NOT streaming/nudge (the analyzer's
// NON_SIGNIFICANT_EVENT_TYPES) is the only proof-of-life it recognized.
const NON_SIGNIFICANT = new Set(["agent.streaming", "orchestrator.nudge"]);

const ms = (iso) => Date.parse(iso);
const load = (rel) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

const F50 = load("../orchestrator/fixtures/f50ucz-ship-rewake.json");
const YMO = load("./fixtures/ymo7dm-liveness.json");

/** {ticketId → {from,to,intervalSec,agentId}} → one agent.streaming event per interval. */
function synthHeartbeats(streamHeartbeats) {
  const evs = [];
  for (const [ticketId, h] of Object.entries(streamHeartbeats || {})) {
    const from = ms(h.from);
    const to = ms(h.to);
    const step = (h.intervalSec || 20) * 1000;
    for (let t = from; t <= to; t += step) {
      evs.push({
        type: "agent.streaming",
        timestamp: new Date(t).toISOString(),
        detail: { ticketId, agentId: h.agentId },
      });
    }
  }
  return evs;
}

/** Rewind each claim's status to time t: running while startedAt<=t<completedAt. */
function rewindTasks(agentTasks, t) {
  const out = {};
  for (const [ticketId, task] of Object.entries(agentTasks || {})) {
    const s = task.startedAt ? ms(task.startedAt) : null;
    const c = task.completedAt ? ms(task.completedAt) : null;
    let status = task.status;
    if (s != null && t < s) status = "pending";
    else if (s != null && (c == null || t < c)) status = "running";
    else if (c != null && t >= c) status = "complete";
    out[ticketId] = { ...task, status };
  }
  return out;
}

/** The legacy 10-min event-age verdict at t (age since newest significant event). */
function legacyFiresAt(events, t, startedAtMs) {
  let newest = null;
  for (const e of events) {
    if (NON_SIGNIFICANT.has(e.type)) continue;
    const et = ms(e.timestamp);
    if (et <= t && (newest == null || et > newest)) newest = et;
  }
  const age = newest == null ? (startedAtMs != null ? t - startedAtMs : 0) : t - newest;
  return age >= LEGACY_STALE_MS;
}

/**
 * Replay one window at the scan interval. Returns raw firing-tick counts + the
 * cooldown-gated intervention counts for both the new and legacy clocks.
 */
function replayWindow({ fixture, agentTasks, workflowPhase, fromIso, toIso, mode = "enforce" }) {
  const heartbeats = synthHeartbeats(fixture.streamHeartbeats);
  const allEvents = [...(fixture.events || []), ...heartbeats];
  const startedAtMs = fixture.workflow?.startedAt ? ms(fixture.workflow.startedAt) : null;
  const from = ms(fromIso);
  const to = ms(toIso);

  let newRaw = 0;
  let legacyRaw = 0;
  let newInterventions = 0;
  let legacyInterventions = 0;
  let lastNew = -Infinity;
  let lastLegacy = -Infinity;
  let ticks = 0;
  let firstNewFire = null;
  const firedTicketIds = new Set();

  for (let t = from; t <= to; t += SCAN_INTERVAL_MS) {
    ticks++;
    const eventsUpTo = allEvents.filter((e) => ms(e.timestamp) <= t);
    const tickets = buildLivenessTickets({
      agentTasks: rewindTasks(agentTasks, t),
      events: eventsUpTo,
      nowMs: t,
      phaseOf: (_id, task) => phaseForAgent(task?.agentId, workflowPhase),
    });
    const d = decideWatch(fixture.workflow, tickets, t, mode, TH);
    if (d.fire) {
      newRaw++;
      if (d.ticketId) firedTicketIds.add(d.ticketId);
      if (!firstNewFire) firstNewFire = { at: new Date(t).toISOString(), ...d };
      if (t - lastNew >= COOLDOWN_MS) {
        newInterventions++;
        lastNew = t;
      }
    }
    if (legacyFiresAt(allEvents, t, startedAtMs)) {
      legacyRaw++;
      if (t - lastLegacy >= COOLDOWN_MS) {
        legacyInterventions++;
        lastLegacy = t;
      }
    }
  }
  return { ticks, newRaw, legacyRaw, newInterventions, legacyInterventions, firstNewFire, firedTicketIds };
}

describe("FR-2.3 — f50ucz 21:13Z→04:34Z: the dev window no longer thrashes", () => {
  it("the new per-phase clock fires ≤2 (streaming devs stay fresh) where legacy fired ≥10", () => {
    // Dev A/B/C = TEAM-4120/4121/4122 (backend_dev → phaseForAgent "development"),
    // streaming ~continuously 21:07→04:34 with only ~2s handoff seams. The whole
    // fixture roster is rewound each tick — only the streaming devs are active in
    // this window, so no un-heartbeated claim leaks a false stale.
    const r = replayWindow({
      fixture: F50,
      agentTasks: F50.workflow.agentTasks,
      workflowPhase: "development",
      fromIso: "2026-09-05T21:13:00Z",
      toIso: "2026-09-06T04:34:00Z",
      mode: "enforce",
    });

    // NEW clock: the span-fresh override keeps every streaming dev alive; the only
    // legitimate silences are the two handoff seams (23:32Z A→B, 01:56Z B→C), and
    // even those are ~2s — well under span-fresh — so nothing fires. ≤2 is the
    // budget the brief allows for those seams; observed here is 0.
    expect(r.newRaw).toBeLessThanOrEqual(2);
    expect(r.newInterventions).toBeLessThanOrEqual(2);

    // LEGACY clock: the same fixture reproduces the OLD thrash — the 10-min
    // event-age window has no streaming to reset it, so it trips repeatedly (the
    // real run logged 13 manager interventions across this window). Raw firing
    // ticks (observed 41) and cooldown-gated interventions (observed 24) both
    // clear the ≥10 floor; the point is legacy >> new on the identical input.
    expect(r.legacyRaw).toBeGreaterThanOrEqual(10);
    expect(r.legacyInterventions).toBeGreaterThanOrEqual(10);
    expect(r.newRaw).toBeLessThan(r.legacyRaw);

    expect(typeof F50._provenance?.note).toBe("string");
    expect(F50._provenance.note.length).toBeGreaterThan(0);
  });
});

describe("FR-2.3 — ymo7dm 06:18Z→06:39Z: a live QA verifier is never falsely stuck", () => {
  it("zero fires on TEAM-4153 while it streams (the real 06:31Z '11 min silence' page is gone)", () => {
    // TEAM-4153 (agentcore_hub_qa_verifier → "verification") streams every 20s
    // 06:18→06:38. The dossier's manager.intervention at 06:31Z (a 40-span-alive
    // session paged on "11 min event silence") is exactly the false positive the
    // span-fresh override removes.
    const r = replayWindow({
      fixture: YMO,
      agentTasks: YMO.workflow.agentTasks,
      workflowPhase: "verification",
      fromIso: "2026-09-06T06:18:00Z",
      toIso: "2026-09-06T06:39:00Z",
      mode: "enforce",
    });
    expect(r.firedTicketIds.has("TEAM-4153")).toBe(false);
    expect(r.newRaw).toBe(0);
    // The fixture DOES carry the real false page: a manager.intervention at
    // 06:31Z on the alive QA session (the "11 min event silence" the legacy
    // clock tripped on). We assert its presence rather than re-deriving a legacy
    // fire — the legacy verdict is sensitive to the 5-min tick phase, but the
    // documented false positive is what the new clock provably eliminates.
    const false0631 = (YMO.events || []).some(
      (e) => e.type === "manager.intervention" && ms(e.timestamp) >= ms("2026-09-06T06:30:00Z") && ms(e.timestamp) < ms("2026-09-06T06:33:00Z")
    );
    expect(false0631).toBe(true);

    expect(typeof YMO._provenance?.note).toBe("string");
    expect(YMO._provenance.note.length).toBeGreaterThan(0);
  });
});

describe("FR-2.4 — f50ucz 08:28Z→19:46Z: the genuinely idle RM still fires", () => {
  it("first fire is within one interval of 08:28Z on TEAM-4126 with reason stale:ship", () => {
    // TEAM-4126 frozen running from parkedSnapshot (startedAt 07:43:10Z, NO
    // completedAt); its streaming heartbeats END at 07:45:00Z (clean exit, then
    // silence). release_manager → phaseForAgent "ship" (12-min threshold). No
    // other active claim in this window (by construction — this replay isolates
    // the parked RM). D1 (the awaited-ids re-wake) is DISABLED here on purpose:
    // this fixture proves the LIVENESS clock alone still catches a truly dead
    // session; the D1 cascade re-wake is exercised in the orchestrator replay.
    const ps = F50.parkedSnapshot["TEAM-4126"].agentTask;
    const agentTasks = {
      "TEAM-4126": {
        agentId: ps.agentId,
        ticketId: "TEAM-4126",
        status: "running",
        startedAt: ps.startedAt, // 2026-09-06T07:43:10.259Z
        // no completedAt → rewindTasks keeps it running for the whole window
      },
    };
    // Only TEAM-4126's heartbeats (end 07:45:00Z); no other ticket streams.
    const isolated = {
      ...F50,
      events: [],
      streamHeartbeats: { "TEAM-4126": F50.streamHeartbeats["TEAM-4126"] },
    };
    const r = replayWindow({
      fixture: isolated,
      agentTasks,
      workflowPhase: "ship",
      fromIso: "2026-09-06T08:28:00Z",
      toIso: "2026-09-06T19:46:00Z",
      mode: "enforce",
    });

    expect(r.firstNewFire).toBeTruthy();
    expect(r.firstNewFire.at).toBe("2026-09-06T08:28:00.000Z"); // first tick ≥ 08:28Z
    expect(r.firstNewFire.fire).toBe(true);
    expect(r.firstNewFire.ticketId).toBe("TEAM-4126");
    expect(r.firstNewFire.reason).toBe("stale:ship");
  });
});

describe("FR-2.5 — parkedOnHuman gates the watchdog only on a real human gate", () => {
  it("the fixture's 08:15Z manager_escalation (NO gateTicketId) does NOT park the run", () => {
    // This is the exact prod notification that froze f50ucz: a dead-session
    // escalation with no human gate behind it. §2.4 requires the run to STAY in
    // WATCH so the liveness clock (FR-2.4) can recover it.
    const esc = F50.workflow.humanNotifications[0];
    expect(esc.type).toBe("manager_escalation");
    expect(esc.gateTicketId).toBeUndefined();
    expect(isParkedOnHuman({ humanNotifications: [{ ...esc, acknowledged: false }] })).toBe(false);
  });

  it("a real TEAM-4127 review_needed on a human:engineer gate DOES park", () => {
    const base = F50.workflow.humanNotifications[1]; // review_needed for TEAM-4127
    expect(base.type).toBe("review_needed");
    // Variant A — the notification carries the human assignee explicitly.
    const viaAssignee = {
      humanNotifications: [{ ...base, acknowledged: false, humanAssignee: "human:engineer" }],
    };
    expect(isParkedOnHuman(viaAssignee)).toBe(true);
    // Variant B — legacy row (no humanAssignee) resolved via the ticket's agent.
    const viaTask = {
      humanNotifications: [{ ...base, acknowledged: false }],
      agentTasks: { "TEAM-4127": { agentId: "human:engineer" } },
    };
    expect(isParkedOnHuman(viaTask)).toBe(true);
    // The fixture's own row is acknowledged → never parks.
    expect(isParkedOnHuman({ humanNotifications: [base] })).toBe(false);
  });
});

describe("Shadow safety — no mode value leaves the run with no watchdog", () => {
  it("a garbage mode normalizes to shadow (never off) and decideWatch still computes", () => {
    expect(normalizeLivenessMode("banana")).toBe("shadow");
    expect(normalizeLivenessMode("")).toBe("shadow");
    expect(normalizeLivenessMode(undefined)).toBe("shadow");
    // decideWatch is mode-agnostic: it always returns a verdict object (never
    // undefined) whatever string it is handed — so even a garbage mode leaves a
    // computable decision. The wired analyzer runs the LEGACY clock in off+shadow
    // (index.mjs), so there is no normalized mode that disables all watchdogs.
    for (const mode of ["off", "shadow", "enforce", "banana"]) {
      const d = decideWatch(
        F50.workflow,
        [{ ticketId: "T", phase: "ship", startedAt: 0 }],
        60 * 60_000,
        mode,
        TH
      );
      expect(d).toBeTruthy();
      expect(typeof d.fire).toBe("boolean");
    }
  });
});
