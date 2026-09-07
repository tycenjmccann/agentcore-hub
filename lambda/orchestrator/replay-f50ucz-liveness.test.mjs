import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FX, WF_ID, SHIP, FIX_A, FIX_B, FIX_CI, CLAIM_STARTED, COMPLETED, makeWorld,
} from "./replay-f50ucz-harness.mjs";

/**
 * TEAM-4166 D2 ACCEPTANCE REPLAY — the f50ucz liveness clock + evidence-gated
 * escalation (§2.6 FR-2.1 / 2.1b / 2.1c). Same shared harness as the D1 replay.
 *
 * The bug: at 08:15:10.430Z the reconcile sweep escalated TEAM-4126
 * dead_session_retry_exhausted — a manager_escalation that trips parkedOnHuman and
 * froze the whole run to a 19:46Z human nudge — even though the release manager had
 * exited CLEANLY at 07:45Z (it filed its ship-review fixes and parked itself on
 * them; it was awaiting work, not dead). D2's evidence guard reserves escalation
 * for the genuinely dead: a session that parked clean (preconditionUnmet stamped)
 * or completed is RE-WOKEN, capped, never escalated.
 */

const RM = "agentcore_hub_release_manager";

let quiet;
beforeEach(() => { quiet = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => quiet.mockRestore());

/** Arm the D1 state the guard reads: the awaited edges + the preconditionUnmet stamp. */
async function withStamp(opts) {
  const w = makeWorld(opts);
  await w.applySpawnEdges();
  await w.awaited.applyAwaitedEdges(SHIP, [FIX_B, FIX_CI], "tool");
  return w;
}

describe("f50ucz D2 — FR-2.1: the 08:15Z sweep does NOT escalate a clean-parked RM", () => {
  it("withholds the escalation while the awaited fixes are still open", async () => {
    // TEAM-4157 never lands inside this window (completes 08:27); hold it open so
    // the sweep sees the exact 08:15 state — TEAM-4126 parked, awaited work open.
    const w = await withStamp({ holdOpen: [FIX_CI] });

    // Sweep at 08:15:10Z, lease stale (the RM has been silent since 07:45Z).
    w.advanceTo("2026-09-06T08:15:10.430Z");
    const m = await w.sweep.runSweep("enforce");

    // The false positive is GONE: no dead-session escalation, no page.
    expect(w.eventsOfType("agent.escalated")).toHaveLength(0);
    expect(w.wf.humanNotifications.filter((n) => n.type === "manager_escalation")).toHaveLength(0);
    // Not re-woken either — its awaited union is still open, so the sweep leaves
    // it parked untouched (no clean-exit redispatch, no exited-ok).
    expect(m.exitedOk).toBe(0);
    expect(w.redispatchedIds).not.toContain(SHIP);
    expect(w.tickets[SHIP].status).toBe("in_progress");
    // The retry budget is NOT touched on this path (the escalation that would have
    // spent-and-blamed it never runs).
    expect(w.wf.deadSessionRetries[SHIP]).toBe(1);

    // AC-DEVIATION (reported): the brief's `ReconcileAwaiting >= 1` is not the
    // metric that fires here. TEAM-4126 is held at the sweep's CANDIDATE gate —
    // allBlockersResolved evaluates the SAME blockerUnion (blockedBy ∪
    // preconditionUnmet.awaitingIds) the anti-thrash inside stealWithRetryBudget
    // checks, so a ticket whose awaited union is open never reaches
    // stealWithRetryBudget (the only producer of the "awaiting" outcome). It is
    // filtered one step earlier, at zero cost. The substance of FR-2.1 — no
    // escalation of a clean-parked RM — is asserted above.
    expect(m.awaiting).toBe(0);
  });
});

describe("f50ucz D2 — FR-2.1b: once the last fix lands, the sweep RE-WAKES (not escalate)", () => {
  it("clean-exit re-dispatches TEAM-4126 exactly once, sparing the retry budget", async () => {
    const w = await withStamp();

    // 08:28Z — TEAM-4157 (the last awaited fix) has landed; the union is resolved.
    w.advanceTo("2026-09-06T08:28:00Z");
    expect(w.tickets[FIX_CI].status).toBe("done");

    const m = await w.sweep.runSweep("enforce");

    // Re-woken through the clean-exit path — NOT escalated.
    expect(m.exitedOk).toBeGreaterThanOrEqual(1);
    expect(w.eventsOfType("agent.escalated")).toHaveLength(0);
    expect(w.redispatchedIds.filter((id) => id === SHIP)).toEqual([SHIP]);
    // Counted on cleanExitRedispatches, NEVER on deadSessionRetries.
    expect(w.wf.cleanExitRedispatches[SHIP]).toBe(1);
    expect(w.wf.deadSessionRetries[SHIP]).toBe(1);

    // A follow-up sweep must not re-dispatch again — the fresh claim is now live.
    const before = w.redispatchedIds.length;
    const m2 = await w.sweep.runSweep("enforce");
    expect(w.redispatchedIds.length).toBe(before);
    expect(m2.exitedOk).toBe(0);
    expect(w.wf.cleanExitRedispatches[SHIP]).toBe(1);
  });
});

describe("f50ucz D2 — FR-2.1c: with NO evidence, the historical escalation STILL fires", () => {
  it("escalates dead_session_retry_exhausted with all six evidence fields", async () => {
    // D1 off: no preconditionUnmet stamp, no awaited edges — TEAM-4126's blockedBy
    // is frozen at [TEAM-4125] (done), exactly as prod read it. This is the
    // control: the guard's `else` branch (genuinely dead) is unchanged.
    const w = makeWorld({ awaitedMode: "off", holdOpen: [FIX_CI] });
    expect(w.tickets[SHIP].preconditionUnmet).toBeUndefined();

    // Same 07:43→08:16 window; sweep with the lease stale.
    w.advanceTo("2026-09-06T08:16:00Z");
    const m = await w.sweep.runSweep("enforce");

    // The escalation fires — this IS a dead session with no exculpating evidence.
    const escalations = w.eventsOfType("agent.escalated").filter((e) => e.ticketId === SHIP);
    expect(escalations).toHaveLength(1);
    expect(m.escalated).toBeGreaterThanOrEqual(1);

    const detail = escalations[0].detail;
    expect(detail.reason).toBe("dead_session_retry_exhausted");
    expect(detail.agentId).toBe(RM);

    // All six evidence fields are present so an operator can see WHY it concluded
    // the session was dead. With no completion + no clean-park stamp, three are null.
    const ev = detail.evidence;
    expect(ev).toBeTruthy();
    for (const k of ["lastSpanAt", "lastSpanStatus", "lastStreamAt", "completedAt", "preconditionAt", "exitReason"]) {
      expect(ev).toHaveProperty(k);
    }
    expect(ev.completedAt).toBeNull();   // the RM never reported completion
    expect(ev.preconditionAt).toBeNull(); // no clean-park stamp
    expect(ev.exitReason).toBeNull();     // the dead-escalate path carries none

    // The manager_escalation notification (the prod false positive this replay is
    // named for) is what appends when the escalation tree is unwired.
    expect(w.wf.humanNotifications.filter((n) => n.type === "manager_escalation")).toHaveLength(1);
    // TEAM-4126 is parked error, awaiting the human.
    expect(w.tickets[SHIP].status === "error" || w.wf.agentTasks[SHIP].status === "error").toBe(true);

    // The fixture records that this slice was reduced/synthesized from the dossier
    // (no raw agent.streaming rows; 20s heartbeats + spawnedBy reconstructed).
    expect(typeof FX._provenance?.note).toBe("string");
    expect(FX._provenance.note.length).toBeGreaterThan(0);
  });
});
