import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createdTicketId } from "./ticket-blockers.mjs";
// FR-1.6 — the sync-main mode normalizer, imported from the SAME module index.mjs
// takes it from, so the test pins the exact function the orchestrator consumes.
import { normalizeSyncMode } from "./sync-main.mjs";
import {
  FX, WF_ID, EPIC, SHIP, CI_DONE, FIX_A, FIX_B, FIX_CI, CLAIM_STARTED, COMPLETED, makeWorld,
} from "./replay-f50ucz-harness.mjs";

/**
 * TEAM-4166 D1 ACCEPTANCE REPLAY — the f50ucz ship re-wake (§1.7, "Fixtures").
 * The shared in-memory harness (board + workflow row + fake clock, wired to the
 * REAL awaited-ids + cascade + reconcile-sweep) and the fixture timeline live in
 * replay-f50ucz-harness.mjs. This file drives the D1 slice:
 *
 * THE FIX (D1): represent an awaited id as a REAL blockedBy edge (written through
 * the ONE provider-aware addBlockers seam with preserveStatusIf:["in_progress"],
 * so the parked RM stays in_progress) + a preconditionUnmet stamp. TEAM-4126 then
 * becomes an ordinary in_progress dependent: the cascade re-drives it the moment
 * the LAST awaited fix (TEAM-4157) closes — within one interval of 08:27:48Z
 * instead of the 19:46Z manual nudge.
 */

// The modules emit EMF summaries straight to console.log (their injected `log` is
// a no-op). Silence them — they are asserted in the unit suites, noise here.
let quiet;
beforeEach(() => { quiet = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => quiet.mockRestore());

describe("f50ucz D1 — deriving + tool-reporting the awaited edges (§1.3/§1.4)", () => {
  it("blocks TEAM-4126 on its ship fixes, skips the CI fix (origin DONE), preserves in_progress", async () => {
    const w = makeWorld();

    await w.applySpawnEdges();

    // The two ship fixes wrote real blockedBy edges onto their origin; the CI fix's
    // origin (TEAM-4125) is DONE, so its spawn edge is skipped.
    expect(w.tickets[SHIP].blockedBy).toEqual(expect.arrayContaining([FIX_A, FIX_B]));
    expect(w.tickets[SHIP].blockedBy).not.toContain(FIX_CI);
    // preserveStatusIf kept the parked RM in_progress — never yanked to blocked.
    expect(w.tickets[SHIP].status).toBe("in_progress");
    // The D2 evidence stamp: derived source.
    expect(w.tickets[SHIP].preconditionUnmet.source).toBe("derived");
    expect(w.tickets[SHIP].preconditionUnmet.awaitingIds).toEqual(expect.arrayContaining([FIX_A, FIX_B]));
  });

  it("the RM's report_precondition_unmet adds the CI-fix edge, and a re-report is idempotent", async () => {
    const w = makeWorld();
    await w.applySpawnEdges();

    // 07:44Z — the RM tool-reports it is awaiting TEAM-4156 + TEAM-4157.
    w.advanceTo("2026-09-06T07:44:00Z");
    const r1 = await w.awaited.applyAwaitedEdges(SHIP, [FIX_B, FIX_CI], "tool");
    expect(w.tickets[SHIP].blockedBy).toContain(FIX_CI);
    expect(r1.written).toBe(1); // TEAM-4157 newly written; TEAM-4156 already present
    expect(r1.present).toBe(1);

    // Re-report — idempotent: both edges already present, nothing newly written.
    const r2 = await w.awaited.applyAwaitedEdges(SHIP, [FIX_B, FIX_CI], "tool");
    expect(r2.written).toBe(0);
    expect(r2.present).toBe(2);
  });
});

describe("f50ucz D1 — the cascade re-wakes TEAM-4126 when the LAST awaited fix lands", () => {
  async function armed(provider = "dynamodb") {
    const w = makeWorld({ provider });
    await w.applySpawnEdges();
    await w.awaited.applyAwaitedEdges(SHIP, [FIX_B, FIX_CI], "tool"); // 4126 blocked on 4155,4156,4157
    return w;
  }

  it("stays parked while any awaited fix is open, then re-dispatches on the 4157 close (§2)", async () => {
    const w = await armed();

    // 07:42:38Z — TEAM-4155 closes. 4156 + 4157 still open → 4126 NOT re-driven.
    w.advanceTo(COMPLETED[FIX_A]);
    await w.cascade.cascadeUnblock(FIX_A, EPIC, w.wf);
    expect(w.redispatchedIds).not.toContain(SHIP);

    // 08:19:27Z — TEAM-4156 closes. 4157 still open → still parked.
    w.advanceTo(COMPLETED[FIX_B]);
    await w.cascade.cascadeUnblock(FIX_B, EPIC, w.wf);
    expect(w.redispatchedIds).not.toContain(SHIP);

    // 08:27:48Z — TEAM-4157, the LAST awaited fix, closes → the union is resolved
    // and the stale-lease parked RM is stolen + re-dispatched exactly once.
    w.advanceTo(COMPLETED[FIX_CI]);
    await w.cascade.cascadeUnblock(FIX_CI, EPIC, w.wf);
    expect(w.redispatchedIds.filter((id) => id === SHIP)).toEqual([SHIP]);
    // Steal CAS on the parked generation ran before the re-dispatch.
    expect(w.lease.stealClaim).toHaveBeenCalledWith(expect.anything(), "workflows", WF_ID, SHIP, CLAIM_STARTED);
    // The event-path re-wake NEVER burns the dead-session retry budget (that
    // counter belongs to the sweep's stealWithRetryBudget path, exercised in the
    // liveness replay — here handleInProgressDependent steals + redispatches
    // directly, touching no retry ledger).
    expect(w.store.incrementDeadSessionRetry).not.toHaveBeenCalled();
    expect(w.eventsOfType("agent.escalated")).toHaveLength(0);

    // The re-dispatched claim saw the full union it waited on (BOTH 4156 + 4157).
    const shipIdx = w.redispatchedIds.indexOf(SHIP);
    expect(w.redispatchedBlockedBy[shipIdx]).toEqual(expect.arrayContaining([FIX_B, FIX_CI]));

    // TEAM-4187 — the AC's "orchestrator.unblocked for TEAM-4126" is now literally
    // emitted. The parked in_progress re-wake used to be silent (only blocked/todo
    // →Ready transitions journaled), so this recovery left no trace at all.
    const un = w.eventsOfType("orchestrator.unblocked").filter((e) => e.detail.ticketId === SHIP);
    expect(un).toHaveLength(1);
    expect(un[0].detail.unblockedBy).toBe(FIX_CI);     // the LAST awaited fix closing
    expect(un[0].detail.source).toBe("cascade");        // event path, not the sweep
    expect(un[0].detail.previousStatus).toBe("in_progress"); // the re-wake shape
    expect(un[0].detail.reason).toBe("awaited_rewake"); // it carried awaitingIds
    expect(un[0].detail.workflowId).toBe(WF_ID);
    // The journal records the FULL union it waited on, not just the closer.
    expect(un[0].detail.blockedBy).toEqual(expect.arrayContaining([FIX_B, FIX_CI]));
    // Stamped from the injected clock — within one sweep interval of the close.
    const stamp = Date.parse(un[0].detail.timestamp);
    expect(stamp).toBeGreaterThanOrEqual(Date.parse(COMPLETED[FIX_CI]));
    expect(stamp).toBeLessThanOrEqual(Date.parse(COMPLETED[FIX_CI]) + 60_000);

    // A follow-up sweep must NOT re-dispatch again — the fresh claim is now live.
    const before = w.redispatchedIds.length;
    await w.sweep.runSweep("enforce");
    expect(w.redispatchedIds.length).toBe(before);
    // ...and therefore journals no second unblock: the event is one-per-redispatch.
    expect(w.eventsOfType("orchestrator.unblocked").filter((e) => e.detail.ticketId === SHIP))
      .toHaveLength(1);
  });

  it("TEAM-4187: the SWEEP re-wake journals orchestrator.unblocked too (source reconcile-sweep)", async () => {
    const w = await armed();

    // No cascadeUnblock at all — the fan-out was MISSED (the f50ucz failure mode).
    // All three fixes are done by 08:27:48Z; one interval later the sweep is the
    // only thing left to recover TEAM-4126.
    w.advanceTo("2026-09-06T08:28:48Z");
    const m = await w.sweep.runSweep("enforce");

    // The clean-park evidence gate routes it to the D2 clean-exit re-wake, which
    // tallies exitedOk (not redispatched) — but the re-dispatch is real, so the
    // journal fires exactly once.
    expect(m.candidates).toBe(1);
    expect(m.exitedOk).toBe(1);
    expect(m.redispatched).toBe(0);
    expect(m.rewoken).toBe(1);
    expect(w.redispatchedIds.filter((id) => id === SHIP)).toEqual([SHIP]);

    const un = w.eventsOfType("orchestrator.unblocked").filter((e) => e.detail.ticketId === SHIP);
    expect(un).toHaveLength(1);
    expect(un[0].detail.source).toBe("reconcile-sweep");
    expect(un[0].detail.unblockedBy).toBe("reconcile-sweep");
    expect(un[0].detail.previousStatus).toBe("in_progress");
    expect(un[0].detail.reason).toBe("awaited_rewake");
    expect(un[0].detail.blockedBy).toEqual(expect.arrayContaining([FIX_B, FIX_CI]));
    // The injected clock, exactly — not wall time (deterministicEventId keys off it).
    expect(un[0].detail.timestamp).toBe("2026-09-06T08:28:48.000Z");

    // Second sweep: the fresh claim is live, so no second re-dispatch and no
    // second journal record.
    const before = w.redispatchedIds.length;
    await w.sweep.runSweep("enforce");
    expect(w.redispatchedIds.length).toBe(before);
    expect(w.eventsOfType("orchestrator.unblocked").filter((e) => e.detail.ticketId === SHIP))
      .toHaveLength(1);
  });

  it("provider parity — jira issue-links reach the identical re-dispatch + event set", async () => {
    const ddbW = await armed("dynamodb");
    const jiraW = await armed("jira");

    for (const w of [ddbW, jiraW]) {
      w.advanceTo(COMPLETED[FIX_A]); await w.cascade.cascadeUnblock(FIX_A, EPIC, w.wf);
      w.advanceTo(COMPLETED[FIX_B]); await w.cascade.cascadeUnblock(FIX_B, EPIC, w.wf);
      w.advanceTo(COMPLETED[FIX_CI]); await w.cascade.cascadeUnblock(FIX_CI, EPIC, w.wf);
    }

    // Same outcome: TEAM-4126 re-dispatched once under either provider.
    expect(ddbW.redispatchedIds.filter((id) => id === SHIP)).toEqual([SHIP]);
    expect(jiraW.redispatchedIds).toEqual(ddbW.redispatchedIds);
    // jira wrote real is-blocked-by links; dynamodb wrote none.
    expect(jiraW.issueLinks.map((l) => l.inwardIssue)).toEqual(expect.arrayContaining([FIX_A, FIX_B, FIX_CI]));
    expect(ddbW.issueLinks).toEqual([]);
    // Identical event-type multiset.
    const types = (w) => w.events.map((e) => e.type).sort();
    expect(types(jiraW)).toEqual(types(ddbW));
  });
});

describe("f50ucz D1 — the wait-SLA backstop when an awaited fix never lands (FR-1.4)", () => {
  it("emits ONE orchestrator.await_timeout after the SLA, and never a second (CAS)", async () => {
    const w = makeWorld({ timeoutMinutes: 120, holdOpen: [FIX_CI] });
    await w.applySpawnEdges();
    await w.awaited.applyAwaitedEdges(SHIP, [FIX_B, FIX_CI], "tool");

    // TEAM-4157 never completes. Advance past the 120-min wait SLA (stamp ~07:08Z).
    w.advanceTo("2026-09-06T09:09:00Z");
    // Keep 4157 open: the sweep must see it non-terminal.
    expect(w.tickets[FIX_CI].status).not.toBe("done");

    const m1 = await w.sweep.runSweep("enforce");
    const timeouts = w.eventsOfType("orchestrator.await_timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].detail.ticketId).toBe(SHIP);
    expect(timeouts[0].detail.awaitingIds).toContain(FIX_CI);
    expect(timeouts[0].detail.waitedMs).toBeGreaterThanOrEqual(120 * 60000);
    expect(m1.awaitTimeouts).toBe(1);
    // TEAM-4126 stayed parked — no re-dispatch while a blocker is open.
    expect(w.redispatchedIds).not.toContain(SHIP);

    // Second sweep — the markAwaitTimeoutEmitted CAS suppresses a duplicate.
    const m2 = await w.sweep.runSweep("enforce");
    expect(w.eventsOfType("orchestrator.await_timeout")).toHaveLength(1);
    expect(m2.awaitTimeouts).toBe(0);
  });

  it("shadow mode computes the SLA breach but emits ZERO events", async () => {
    const w = makeWorld({ awaitedMode: "shadow", timeoutMinutes: 120, holdOpen: [FIX_CI] });
    // shadow writes no edges, so seed the stamp the sweep reads directly.
    w.tickets[SHIP].blockedBy = [CI_DONE, FIX_CI];
    w.tickets[SHIP].preconditionUnmet = { awaitingIds: [FIX_CI], source: "derived", reportedAt: "2026-09-06T07:08:00Z" };
    w.advanceTo("2026-09-06T09:09:00Z");

    const m = await w.sweep.runSweep("enforce"); // sweep enforce, but awaited module is shadow
    expect(w.eventsOfType("orchestrator.await_timeout")).toHaveLength(0);
    expect(m.awaitTimeouts).toBe(0);
  });
});

describe("f50ucz D1 — AWAITED_IDS_MODE=off is provably zero-effect (§1.3)", () => {
  it("writes no edges, stamps nothing, publishes nothing — board is byte-identical", async () => {
    const w = makeWorld({ awaitedMode: "off" });
    const before = structuredClone(w.tickets);

    await w.applySpawnEdges();
    await w.awaited.applyAwaitedEdges(SHIP, [FIX_B, FIX_CI], "tool");

    expect(w.addBlockers).not.toHaveBeenCalled();
    expect(w.annotatePreconditionUnmet).not.toHaveBeenCalled();
    expect(w.tickets[SHIP].blockedBy).toEqual([CI_DONE]); // still only TEAM-4125
    expect(w.events).toEqual([]);
    expect(w.tickets).toEqual(before);
  });
});

describe("f50ucz D1 — FR-1.6: sync-main is flag-driven, not merge-commit-driven", () => {
  it("SYNC_MAIN_BEFORE_CI is consumed from its normalized env flag", () => {
    // A present, recognized flag is honored — the run's decision to sync main
    // before CI comes from this value, NOT from whether TEAM-4126 already carries
    // a mergeCommit (the fixture's agentTasks[TEAM-4126].mergeCommit ff64a7db…).
    expect(normalizeSyncMode("enforce")).toBe("enforce");
    expect(normalizeSyncMode("shadow")).toBe("shadow");
    expect(normalizeSyncMode("off")).toBe("off");
    // The normalizer reads ONLY its argument — the merge commit is inert here.
    expect(FX.workflow.agentTasks[SHIP].mergeCommit).toBe("ff64a7db7059d21abd5025fd53329eb376c8b7c0");
    expect(normalizeSyncMode(FX.workflow.agentTasks[SHIP].mergeCommit)).toBe("off");

    // AC-DEVIATION (reported): the brief's literal `normalizeSyncMode("main-first")
    // !== "off"` cannot hold. SYNC_MAIN_BEFORE_CI's allow-list is off|shadow|enforce
    // and, because enforce PUSHES to a shared branch, any unrecognized value
    // fail-safes to OFF (sync-main.mjs normalizeSyncMode). "main-first" is not a
    // member, so it coerces to off — the safe direction.
    expect(normalizeSyncMode("main-first")).toBe("off");
  });
});

describe("f50ucz D1 — the create/annotate seam shapes (TEAM-4156 contract)", () => {
  it("createdTicketId reads BOTH provider create_ticket shapes", () => {
    // DynamoDB tickets Lambda → { key, ticket: { key } }.
    expect(createdTicketId({ key: "TEAM-4156", ticket: { key: "TEAM-4156" } })).toBe("TEAM-4156");
    // Jira Lambda → { ticketId }.
    expect(createdTicketId({ ticketId: "TEAM-4156" })).toBe("TEAM-4156");
    // A non-string id is not trusted (would corrupt a blocker edge).
    expect(createdTicketId({ key: { value: "X" } })).toBeNull();
  });

  it("annotate_precondition_unmet returns { ticketId, preconditionUnmet }", async () => {
    const w = makeWorld();
    await w.applySpawnEdges();
    // The stamp adapter returned the real annotate Lambda shape on every call.
    const ret = w.annotatePreconditionUnmet.mock.results[0].value
      ? await w.annotatePreconditionUnmet.mock.results[0].value
      : null;
    expect(ret).toMatchObject({ ticketId: SHIP });
    expect(ret.preconditionUnmet).toMatchObject({ source: "derived" });
    expect(Array.isArray(ret.preconditionUnmet.awaitingIds)).toBe(true);
  });
});
