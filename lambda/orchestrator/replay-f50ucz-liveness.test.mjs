import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FX, WF_ID, EPIC, SHIP, FIX_A, FIX_B, FIX_CI, CLAIM_STARTED, COMPLETED, makeWorld,
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

/**
 * TEAM-4184 F1 (review finding of TEAM-4168) — FR-2.1d: the guard's evidence must
 * be about the CLAIM being inspected.
 *
 * Nothing ever CLEARS preconditionUnmet. The shipped guard tested only that the
 * stamp existed, so the very re-wake FR-2.1b prescribes turned the ticket
 * permanently un-escalatable: the clean-exit budget was spent on the correct
 * re-wake, and the re-woken session — no matter how dead — kept reading "parked
 * clean" off the 07:07Z stamp. Forever. No agent.escalated, no error status, no
 * page; deadSessionRetries frozen at 1.
 *
 * The fix scopes the stamp to the current claim generation. These four cases are
 * the whole matrix that matters in the replay: die after the re-wake (escalate) vs
 * legitimately re-park (still spared) — on BOTH providers, because prod is Jira.
 */
describe("f50ucz D2 — FR-2.1d: a stale stamp no longer disables escalation (TEAM-4184 F1)", () => {
  /** FR-2.1b's re-wake, replayed: returns with TEAM-4126 re-dispatched at 08:28Z. */
  async function afterCleanReWake(opts) {
    const w = await withStamp(opts);
    w.advanceTo("2026-09-06T08:28:00Z");
    await w.sweep.runSweep("enforce");
    expect(w.wf.cleanExitRedispatches[SHIP]).toBe(1);
    expect(w.eventsOfType("agent.escalated")).toHaveLength(0);
    return w;
  }

  /** The re-woken RM files a new fix and parks on it — a LEGITIMATE second park. */
  async function repark(w, newId, atIso) {
    w.advanceTo(atIso);
    w.tickets[newId] = {
      ticketId: newId, type: "task", status: "in_progress",
      assignee: "agentcore_hub_backend_dev", parentId: EPIC, blockedBy: [],
    };
    await w.awaited.applyAwaitedEdges(SHIP, [newId], "tool");
    w.deadClaims.add(SHIP); // it parked and exited, exactly as at 07:45Z
  }

  /** Sweep repeatedly with the lease stale, as the real reconcile loop does. */
  async function sweepRepeatedly(w, times, fromIso) {
    let at = Date.parse(fromIso);
    const metrics = [];
    for (let i = 0; i < times; i++) {
      w.advanceTo(new Date(at + i * 15 * 60 * 1000).toISOString());
      metrics.push(await w.sweep.runSweep("enforce"));
    }
    return metrics;
  }

  it("the reviewer's repro: the re-woken session dies → ESCALATES, once, reason stale-stamp", async () => {
    const w = await afterCleanReWake();

    // The stamp is 07:07Z evidence about the claim that ended at 07:45Z — it says
    // nothing about the 08:28Z claim the sweep is now inspecting.
    const stamp = w.tickets[SHIP].preconditionUnmet.reportedAt;
    expect(Date.parse(stamp)).toBeLessThan(Date.parse(w.wf.agentTasks[SHIP].startedAt));

    // The fresh claim goes silent too: no spans, no stream, no completion.
    w.deadClaims.add(SHIP);
    const metrics = await sweepRepeatedly(w, 8, "2026-09-06T09:00:00Z");

    const escalations = w.eventsOfType("agent.escalated").filter((e) => e.ticketId === SHIP);
    expect(escalations).toHaveLength(1); // once — not per sweep, and not never
    expect(metrics.reduce((n, m) => n + (m.escalated || 0), 0)).toBeGreaterThanOrEqual(1);

    const detail = escalations[0].detail;
    expect(detail.reason).toBe("dead_session_retry_exhausted");
    // The 7th evidence field says WHICH branch of the guard concluded this, so an
    // operator reading the page can tell a stale stamp from no stamp at all.
    expect(detail.evidence.parkEvidence).toBe("stale-stamp");
    expect(detail.evidence.preconditionAt).toBe(stamp);

    // The full escalation, not just the event.
    expect(w.store.setTaskStatus).toHaveBeenCalledWith(WF_ID, SHIP, "error");
    expect(w.blockTicket).toHaveBeenCalledWith(SHIP, "dead_session_retry_exhausted");
    expect(w.wf.humanNotifications.filter((n) => n.type === "manager_escalation")).toHaveLength(1);

    // The clean-exit budget was NOT burned further, and deadSessionRetries stays 1:
    // escalating IS the progression the exhausted budget calls for, so the counter
    // is deliberately not bumped again.
    expect(w.wf.cleanExitRedispatches[SHIP]).toBe(1);
    expect(w.wf.deadSessionRetries[SHIP]).toBe(1);
    // And the pre-fix symptom is gone: it never reports "awaiting" forever.
    expect(metrics.every((m) => m.awaiting === 0)).toBe(true);
  });

  it("(d) a LEGITIMATE re-park after the re-wake is still spared — dynamodb", async () => {
    const w = await afterCleanReWake();
    const NEW_FIX = "TEAM-4199";
    await repark(w, NEW_FIX, "2026-09-06T09:10:00Z");

    // The new fix lands; the awaited union is resolved again.
    w.advanceTo("2026-09-06T09:30:00Z");
    w.tickets[NEW_FIX].status = "done";
    const metrics = await sweepRepeatedly(w, 3, "2026-09-06T09:40:00Z");

    // Re-woken a SECOND time (cap is 3), never escalated.
    expect(w.eventsOfType("agent.escalated")).toHaveLength(0);
    expect(w.wf.humanNotifications.filter((n) => n.type === "manager_escalation")).toHaveLength(0);
    expect(w.wf.cleanExitRedispatches[SHIP]).toBe(2);
    expect(metrics.reduce((n, m) => n + (m.exitedOk || 0), 0)).toBeGreaterThanOrEqual(1);
    expect(w.wf.deadSessionRetries[SHIP]).toBe(1);
  });

  /**
   * The same (d) case in JIRA mode — the provider prod actually runs (Dockerfile /
   * .env.example ship TICKET_PROVIDER=jira). This is the case that FAILED before
   * the precondition-at label existed: Jira has no structured column, and the
   * sibling read the guard runs (getChildTicketsFromJira) fetches no `comment`, so
   * the re-park's reportedAt was simply ABSENT. isStampCurrent would then be false,
   * the clean-exit budget was already 1, and a legitimately re-parked release
   * manager got escalated — the f50ucz bug class, re-introduced on the prod path.
   */
  it("(d) a LEGITIMATE re-park after the re-wake is still spared — JIRA (the label carries the clock)", async () => {
    const w = await afterCleanReWake({ provider: "jira" });
    const NEW_FIX = "TEAM-4199";
    await repark(w, NEW_FIX, "2026-09-06T09:10:00Z");

    // The mechanism, pinned: the stamp lives in labels, and exactly ONE monotonic
    // clock label survives, carrying the RE-PARK instant (not the 07:07Z one).
    const clocks = w.tickets[SHIP].labels.filter((l) => l.startsWith("precondition-at:"));
    expect(clocks).toHaveLength(1);
    const read = w.projectRead(w.tickets[SHIP]).preconditionUnmet;
    expect(read.reportedAt).toBe("2026-09-06T09:10:00.000Z");
    expect(read.awaitingIds).toContain(NEW_FIX);
    expect(Date.parse(read.reportedAt)).toBeGreaterThan(Date.parse(w.wf.agentTasks[SHIP].startedAt));

    w.advanceTo("2026-09-06T09:30:00Z");
    w.tickets[NEW_FIX].status = "done";
    await sweepRepeatedly(w, 3, "2026-09-06T09:40:00Z");

    expect(w.eventsOfType("agent.escalated")).toHaveLength(0);
    expect(w.wf.humanNotifications.filter((n) => n.type === "manager_escalation")).toHaveLength(0);
    expect(w.wf.cleanExitRedispatches[SHIP]).toBe(2);
  });

  it("the JIRA twin of the genuine death: no re-park, so the label clock stays pre-claim → escalates", async () => {
    const w = await afterCleanReWake({ provider: "jira" });
    // No re-park: the only clock label is still the 07:07Z one, which predates the
    // 08:28Z claim. The label mechanism must not over-suppress escalation either.
    expect(w.projectRead(w.tickets[SHIP]).preconditionUnmet.reportedAt).toBe("2026-09-06T07:07:00.000Z");

    w.deadClaims.add(SHIP);
    await sweepRepeatedly(w, 4, "2026-09-06T09:00:00Z");

    const escalations = w.eventsOfType("agent.escalated").filter((e) => e.ticketId === SHIP);
    expect(escalations).toHaveLength(1);
    expect(escalations[0].detail.evidence.parkEvidence).toBe("stale-stamp");
    expect(w.blockTicket).toHaveBeenCalledWith(SHIP, "dead_session_retry_exhausted");
  });
});
