import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLiveReverify } from "./live-reverify.mjs";
import { isReworkFix } from "./rework-loop-cap.mjs";

/**
 * TEAM-4121 FR-9 ACCEPTANCE REPLAY — the yteqfl "loop 2" that this FR exists to
 * prevent. Real data throughout, from
 *   deploy/workflow-manager/toolkit/fixtures/yteqfl-dossier.json
 * (reduced from s3://agentcore-hub-artifacts-838829463875-us-east-1/workflows/
 *  wf_1788582225496_yteqfl/analysis/*​/dossier.json).
 *
 * ══ WHAT ACTUALLY HAPPENED (every value below is in the fixture) ══════════════
 * | when (UTC)      | what                                                      |
 * |-----------------|-----------------------------------------------------------|
 * | 06:02:20.727Z   | ticket.created TEAM-4089 "Fix (QA): intake.ts — real SDK   |
 * |                 | bodiless-403 message "Unknown" leaks into S3 error detail  |
 * |                 | …; filter + regression test" — filed by the QA verifier,   |
 * |                 | assignee agentcore_hub_bug_fixer, parent TEAM-4054,        |
 * |                 | blockedBy [TEAM-4079]                                     |
 * | 06:05:32.747Z   | agent.invoked TEAM-4089 (phase development)                |
 * | 06:21:00.929Z   | report_completion TEAM-4089 → commit 0949f9d8814…,         |
 * |                 | branch feature/TEAM-4089-bug-fixer, PR #373.              |
 * |                 | The record carries summary/branch/sha/pr_url and NO        |
 * |                 | artifacts at all — prose, no live evidence.               |
 * | 06:21:08.290Z   | agent.complete TEAM-4089 (unblocked 4090, 4091) ← THE HOOK |
 * | 06:47:00.496Z   | agent.invoked TEAM-4092 "QA: Re-verify … after             |
 * |                 | TEAM-4089/4090/4091", blockedBy [4089,4090,4091]          |
 * | 07:08:16.147Z   | ticket.created TEAM-4105 "Fix (QA re-verify): intake.ts    |
 * |                 | checkS3Source — SDK placeholder name "Unknown" STILL leaks |
 * |                 | … (TEAM-4089 incomplete)" — a whole new dev loop          |
 * | 07:09:11.846Z   | report_completion TEAM-4092: "QA VERDICT TEAM-4092: FAIL   |
 * |                 | (zero-issue rule) — 1 low-severity finding, fix ticket     |
 * |                 | TEAM-4105 filed (qa_fix, phase=develop…"                   |
 * | 07:16:23.320Z   | TEAM-4105 done → commit 9ca1963427719c…, PR #376           |
 * | still open at   | TEAM-4066 "Ship: submit_workflow source validation fix",   |
 * | 06:21Z          | agentcore_hub_release_manager (phase ship) — it did not    |
 * |                 | reach done until 11:20:04Z                                 |
 * | not a ship      | TEAM-4067 "Merge Approval: …", assignee human:engineer —   |
 * | sibling         | no agent def, therefore no phase                          |
 *
 * So TEAM-4089's own live finding went un-rechecked at its head for 47m08s, and
 * the recheck, when it came, was a full second dev loop (TEAM-4105: invoke → fix
 * → PR → merge, done 07:16Z) instead of one QA re-run.
 *
 * ══ SYNTHESIZED, AND WHY ═════════════════════════════════════════════════════
 * This run PRE-DATES the fix contract (FR-8) — the dossier's ticket rows carry
 * neither `spawnedBy` nor `fixContract`. Both are synthesized here from what the
 * fixture DOES record: the title says "Fix (QA):" and TEAM-4092/TEAM-4105 prove
 * the QA verifier filed it by running the app, which is exactly the
 * `evidence_source: "live"` case, so the contract states that. The dossier's
 * `completions` were also reduced to {ticket_id, completed_at, commit_sha,
 * pr_url, branch} — but the un-reduced report_completion EVENT detail is in the
 * fixture verbatim and has no artifacts key either, and the prod outcome (the
 * repro still failed 47m later) corroborates that no live evidence existed.
 *
 * ══ WHICH LAYER THIS EXERCISES ═══════════════════════════════════════════════
 * The REAL live-reverify.mjs decision tree (createLiveReverify → onFixDone),
 * driven with the real fixture rows — the same layer Dev A's
 * replay-yteqfl-dead-session.test.mjs drives (real sweep/cascade/escalation over
 * an in-memory board). The index.mjs wiring above it — that the hook runs in BOTH
 * done twins, only for FIX_KINDS, and costs nothing when the flag is unset — is
 * pinned separately in done-handlers-cascade.test.mjs, and the ship-context
 * rendering in unverified-fixes-context.test.mjs.
 */

const DOSSIER = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../deploy/workflow-manager/toolkit/fixtures/yteqfl-dossier.json", import.meta.url)),
    "utf8"
  )
);

/** Fixture rows, by id — throws if the fixture moves under us. */
function fixtureTicket(ticketId) {
  const row = DOSSIER.tickets.find((t) => t.ticketId === ticketId);
  if (!row) throw new Error(`yteqfl fixture has no ticket ${ticketId}`);
  return row;
}
function fixtureCompletion(ticketId) {
  const rec = DOSSIER.completions?.[ticketId];
  if (!rec) throw new Error(`yteqfl fixture has no completion record for ${ticketId}`);
  return rec;
}

const WF_ID = "wf_1788582225496_yteqfl";
const EPIC = "TEAM-4054";
const FIX = "TEAM-4089";        // the live fix that closed with prose only
const QA_ORIGIN = "TEAM-4079";  // 4089's only recorded blocker — the QA/review ticket it came out of
const QA_RERUN = "TEAM-4092";   // the QA re-verify that caught it 47m later
const LOOP2 = "TEAM-4105";      // the second dev loop that should never have been needed
const SHIP = "TEAM-4066";       // open ship ticket at 06:21Z
const HUMAN_GATE = "TEAM-4067"; // Merge Approval — human:engineer, no agent def
const HEAD = "0949f9d881423ac7fe00a70e23d60fff5654078c";
const HEAD7 = "0949f9d";
const DONE_AT = "2026-09-05T06:21:08.290Z"; // agent.complete TEAM-4089
const REVERIFY = "TEAM-4200";               // what the ticket Lambda would have minted

/** Real agent phases (src/config/agents.json), so getAgentDef is not a guess. */
const AGENT_PHASES = JSON.parse(readFileSync(fileURLToPath(new URL("../../src/config/agents.json", import.meta.url)), "utf8"))
  .agents.reduce((acc, a) => ({ ...acc, [a.agentId]: a.phase }), {});

/**
 * The fix contract the QA verifier WOULD have set under FR-8. Synthesized (see
 * the header): pre-contract run. The invariant/repro are drawn from the real
 * TEAM-4089 title and the real TEAM-4105 root cause, so the "live" claim being
 * re-verified is the one prod actually failed.
 */
const SYNTHESIZED_CONTRACT = {
  kind: "qa_fix",
  invariant:
    'submit_workflow with an unreadable s3:// source surfaces the real S3 error, never the SDK placeholder name "Unknown"',
  evidenceSource: "live",
  evidenceRepro:
    "POST /api/workflow/start with source s3://agentcore-hub-artifacts-838829463875-us-east-1/nope.md and read the returned detail",
  citedLocation: ["src/lib/workflow/intake.ts:checkS3Source"],
  siblingScope: "none",
};
/** Synthesized too — the dossier's rows have no spawnedBy. */
const SYNTHESIZED_SPAWNED_BY = { kind: "qa_fix", qaTicketId: QA_ORIGIN };

/** The fix ticket as the orchestrator sees it at Done: fixture row + FR-8 fields. */
function fixTicketAtDone() {
  return { ...fixtureTicket(FIX), fixContract: SYNTHESIZED_CONTRACT, spawnedBy: SYNTHESIZED_SPAWNED_BY };
}

/**
 * The board + workflow row as they read at 06:21:08.290Z, from the fixture.
 * The ship ticket is in_progress (it was not done until 11:20:04Z) and the fix's
 * agentTasks entry is the real one, so `commitSha` — the sha the re-verification
 * pins to — is production's own value, not a literal typed here.
 */
function world({
  mode = "enforce",
  shipStatus = "in_progress",
  completionRecord = fixtureCompletion(FIX),
  // What the tickets Lambda answers create_ticket with. DynamoDB's shape by
  // default (this replay is a dynamodb-mode run); `jira` answers `{ ticketId }`
  // (TEAM-4156). This suite injects `invokeTickets` directly rather than mocking
  // the Lambda boundary, so the shape swap exercises live-reverify's own reader,
  // not index.mjs's normalization.
  createReply = () => ({ key: REVERIFY }),
} = {}) {
  const calls = { merges: [], creates: [], blockers: [], events: [], warns: [] };

  const workflow = {
    id: WF_ID,
    workflowId: WF_ID,
    epicId: EPIC,
    phase: "ship",
    workflowDefId: DOSSIER.workflow.workflowDefId,
    agentTasks: {
      [FIX]: { ...DOSSIER.workflow.agentTasks[FIX] },
      [SHIP]: { ...DOSSIER.workflow.agentTasks[SHIP], status: "running", completedAt: undefined },
    },
  };

  const siblings = [
    { ...fixtureTicket(FIX), status: "done" },
    { ...fixtureTicket(QA_RERUN), status: "in_progress" },
    { ...fixtureTicket(SHIP), status: shipStatus },
    { ...fixtureTicket(HUMAN_GATE), status: "todo" },
  ];

  const { onFixDone } = createLiveReverify({
    mode,
    store: {
      mergeTaskMetadata: async (wfId, tid, fields) => { calls.merges.push({ wfId, tid, fields }); },
    },
    invokeTickets: async (tool, params) => {
      calls.creates.push({ tool, params });
      return createReply(params);
    },
    getChildTickets: async (epicId) => (epicId === EPIC ? siblings : []),
    getAgentDef: (assignee) => (AGENT_PHASES[assignee] ? { agentId: assignee, phase: AGENT_PHASES[assignee] } : null),
    shipPhases: new Set(["ship"]),
    addBlockers: async (ticketId, ids) => { calls.blockers.push({ ticketId, ids }); return ids; },
    publishEvent: async (ticketId, type, detail) => { calls.events.push({ ticketId, type, detail }); },
    now: () => Date.parse(DONE_AT),
    log: { warn: (m) => calls.warns.push(m), log: () => {} },
  });

  return { onFixDone, workflow, siblings, calls, completionRecord };
}

const created = (calls) => calls.creates.filter((c) => c.tool === "create_ticket");

describe("yteqfl replay — the fixture still says what this replay claims", () => {
  it("TEAM-4089 is a QA-filed fix whose completion record carries no live artifact", () => {
    const row = fixtureTicket(FIX);
    expect(row.title).toContain("Fix (QA):");
    expect(row.assignee).toBe("agentcore_hub_bug_fixer");
    expect(row.parentId).toBe(EPIC);
    expect(row.status).toBe("done");

    const rec = fixtureCompletion(FIX);
    expect(rec.commit_sha).toBe(HEAD);
    expect(rec.branch).toBe("feature/TEAM-4089-bug-fixer");
    // No artifacts / evidence_keys / evidence_kind anywhere in it.
    expect(Object.keys(rec).sort()).toEqual(["branch", "commit_sha", "completed_at", "pr_url", "ticket_id"]);

    // …and the un-reduced report_completion event detail has no artifacts either,
    // so "no live evidence" is the fixture's own claim, not the reduction's.
    const doneEvent = DOSSIER.events.find(
      (e) => e.type === "workflow.report_completion" && (e.detail?.ticketId || e.ticketId) === FIX
    );
    expect(doneEvent).toBeTruthy();
    expect(doneEvent.detail.artifacts).toBeUndefined();
  });

  it("the run really did take a second dev loop 47 minutes later", () => {
    const loop2 = fixtureTicket(LOOP2);
    expect(loop2.title).toContain("TEAM-4089 incomplete");
    expect(loop2.assignee).toBe("agentcore_hub_bug_fixer"); // a DEV, not a re-check
    expect(fixtureCompletion(LOOP2).commit_sha).toBe("9ca1963427719c57232c8962815728f460c1a82a");

    const filed = DOSSIER.events.find((e) => e.type === "ticket.created" && (e.detail?.ticketId || e.ticketId) === LOOP2);
    const gapMs = Date.parse(filed.timestamp) - Date.parse(DONE_AT);
    expect(Math.round(gapMs / 60000)).toBe(47);
  });

  it("TEAM-4066 is the ship-phase sibling and TEAM-4067 is not", () => {
    expect(AGENT_PHASES[fixtureTicket(SHIP).assignee]).toBe("ship");
    expect(fixtureTicket(HUMAN_GATE).assignee).toBe("human:engineer");
    expect(AGENT_PHASES[fixtureTicket(HUMAN_GATE).assignee]).toBeUndefined();
  });
});

describe("yteqfl loop 2 under LIVE_REVERIFY=enforce", () => {
  it("marks TEAM-4089 unverified, files ONE re-verify at 0949f9d, and blocks TEAM-4066", async () => {
    const { onFixDone, workflow, calls, completionRecord } = world();

    const result = await onFixDone({ workflow, fixTicket: fixTicketAtDone(), completionRecord });

    expect(result).toEqual({ action: "created", reverifyTicketId: REVERIFY, sha7: HEAD7, unverified: true });

    // ── the unverified mark, which is what puts the row in the release manager's
    // ## Unverified Fixes block even if nobody looks at the re-verify ticket.
    expect(calls.merges[0]).toEqual({
      wfId: WF_ID,
      tid: FIX,
      fields: {
        verification: "unverified",
        verificationReason: "evidence_source=live but no live artifact in completion record",
      },
    });
    expect(workflow.agentTasks[FIX].verification).toBe("unverified");

    // ── exactly ONE re-verify ticket, at the real head, blocked on the real fix.
    expect(created(calls)).toHaveLength(1);
    const { params } = created(calls)[0];
    expect(params.summary).toBe(`Re-verify (QA): ${fixtureTicket(FIX).title} @ ${HEAD7}`);
    expect(params.assignee).toBe("agentcore_hub_qa_verifier");
    expect(params.blocked_by).toEqual([FIX]);
    expect(params.parent_key).toBe(EPIC);
    expect(params.workflow_id).toBe(WF_ID);
    expect(params.spawned_by).toEqual({
      kind: "qa_fix", qaTicketId: QA_ORIGIN, reverify: true, rearmOf: FIX, headSha: HEAD,
    });
    expect(params.fix_contract.evidence_source).toBe("live");
    expect(params.fix_contract.invariant).toBe(SYNTHESIZED_CONTRACT.invariant);

    // ── the open ship ticket cannot proceed past it; the human gate is untouched.
    expect(calls.blockers).toEqual([{ ticketId: SHIP, ids: [REVERIFY] }]);

    // ── and the marker that makes the whole thing idempotent.
    expect(calls.merges[1].fields).toEqual({ reverifyTicketId: REVERIFY, reverifySha: HEAD7 });
    expect(calls.events.map((e) => e.type)).toEqual(["fix.unverified", "fix.reverify_created"]);
  });

  it("the re-verification is ONE QA re-run, not a new rework round", async () => {
    const { onFixDone, workflow, calls, completionRecord } = world();
    await onFixDone({ workflow, fixTicket: fixTicketAtDone(), completionRecord });

    const reverifyTicket = { ticketId: REVERIFY, spawnedBy: created(calls)[0].params.spawned_by };

    // What prod did instead — TEAM-4105 — WAS a rework round: a dev ticket, a
    // branch, a PR, a merge. The re-verification must not be counted as one, or
    // the rework-loop cap would start escalating on ordinary re-checks.
    expect(isReworkFix(reverifyTicket)).toBe(false);
    expect(isReworkFix({ ticketId: LOOP2, spawnedBy: { kind: "qa_fix", qaTicketId: QA_RERUN } })).toBe(true);
    expect(reverifyTicket.spawnedBy.rearmOf).toBe(FIX);
  });

  it("replaying the trigger that spawned TEAM-4105 in prod is `already` — no second loop", async () => {
    const { onFixDone, workflow, calls, completionRecord } = world();
    await onFixDone({ workflow, fixTicket: fixTicketAtDone(), completionRecord });

    // Prod's second pass over the SAME head: the QA re-run found the bug still
    // present and filed TEAM-4105. The head never moved (0949f9d is still the
    // fix's commit), so a re-Done of TEAM-4089 at that head must be a no-op.
    const again = await onFixDone({ workflow, fixTicket: fixTicketAtDone(), completionRecord });

    expect(again).toEqual({ action: "already", reverifyTicketId: REVERIFY, sha7: HEAD7, unverified: true });
    expect(created(calls)).toHaveLength(1);
    expect(created(calls)[0].params.summary).not.toContain("TEAM-4105");
    expect(calls.blockers).toHaveLength(1); // TEAM-4066 blocked once, not twice
  });

  it("is `already` from the board alone when the metadata write was lost", async () => {
    const { onFixDone, workflow, siblings, calls, completionRecord } = world();
    // The re-verify ticket exists on the board but workflow.agentTasks never got
    // its marker (a lost write / an untracked task) — the sibling scan is the
    // authoritative guard, and it keys on the real head sha.
    siblings.push({
      ticketId: REVERIFY,
      assignee: "agentcore_hub_qa_verifier",
      status: "todo",
      spawnedBy: { kind: "qa_fix", qaTicketId: QA_ORIGIN, reverify: true, rearmOf: FIX, headSha: HEAD },
    });

    const result = await onFixDone({ workflow, fixTicket: fixTicketAtDone(), completionRecord });

    expect(result.action).toBe("already");
    expect(created(calls)).toHaveLength(0);
    expect(calls.blockers).toEqual([]);
  });

  it("TEAM-4105's own head IS a new claim (the re-verification is per head, not per fix)", async () => {
    const { onFixDone, workflow, calls, completionRecord } = world();
    await onFixDone({ workflow, fixTicket: fixTicketAtDone(), completionRecord });

    // Prod's real follow-up commit, 9ca1963 (TEAM-4105 → PR #376). Once the
    // branch moves, the earlier re-verification proved nothing about this head.
    workflow.agentTasks[FIX].commitSha = fixtureCompletion(LOOP2).commit_sha;
    const second = await onFixDone({ workflow, fixTicket: fixTicketAtDone(), completionRecord });

    expect(second.action).toBe("created");
    expect(second.sha7).toBe("9ca1963");
    expect(created(calls)).toHaveLength(2);
  });

  it("a ship ticket already done is not reopened", async () => {
    const { onFixDone, workflow, calls, completionRecord } = world({ shipStatus: "done" });

    await onFixDone({ workflow, fixTicket: fixTicketAtDone(), completionRecord });

    expect(created(calls)).toHaveLength(1); // the re-verification still happens…
    expect(calls.blockers).toEqual([]);     // …but a finished ship phase stays finished
  });

  it("had TEAM-4089 filed real live evidence, only the re-verification would fire", async () => {
    const { onFixDone, workflow, calls } = world();

    const result = await onFixDone({
      workflow,
      fixTicket: fixTicketAtDone(),
      // The record the FR-9 blueprints now ask for.
      completionRecord: {
        ...fixtureCompletion(FIX),
        evidence_kind: "live",
        evidence_keys: `workflows/${WF_ID}/shared/qa-evidence/intake-403-detail.log`,
      },
    });

    expect(result.unverified).toBe(false);
    expect(calls.merges.map((m) => m.fields.verification)).toEqual([undefined]);
    expect(calls.events.map((e) => e.type)).toEqual(["fix.reverify_created"]);
    // Still re-verified at the head: the artifact proves the ORIGINAL observation,
    // not the state after the fix — which is exactly what prod got wrong.
    expect(created(calls)).toHaveLength(1);
  });

  it("this same run under TICKET_PROVIDER=jira reaches the identical end state (TEAM-4156)", async () => {
    // yteqfl ran in dynamodb mode, but `.env.example` and the Dockerfile ship
    // jira — where create_ticket answers `{ ticketId }`, not `{ key }`. Before
    // TEAM-4156 that read null here, so TEAM-4066 shipped over an unverified fix
    // with a re-verify ticket sitting on the board that nothing pointed at.
    const { onFixDone, workflow, calls, completionRecord } = world({
      createReply: () => ({ ticketId: REVERIFY, status: "created", message: `Created ${REVERIFY}` }),
    });

    const result = await onFixDone({ workflow, fixTicket: fixTicketAtDone(), completionRecord });

    expect(result).toEqual({ action: "created", reverifyTicketId: REVERIFY, sha7: HEAD7, unverified: true });
    expect(created(calls)).toHaveLength(1);
    expect(calls.blockers).toEqual([{ ticketId: SHIP, ids: [REVERIFY] }]);
    expect(calls.merges[1].fields).toEqual({ reverifyTicketId: REVERIFY, reverifySha: HEAD7 });
    expect(workflow.agentTasks[FIX].reverifyTicketId).toBe(REVERIFY);
    expect(calls.events.map((e) => e.type)).toEqual(["fix.unverified", "fix.reverify_created"]);
    // The only warn is the pre-existing CAS-slot one this fixture always emits;
    // the id was read fine, so nothing complains about the ticket.
    expect(calls.warns.join("\n")).not.toMatch(/could not create the re-verify ticket/);
  });
});

describe("yteqfl loop 2 under LIVE_REVERIFY=shadow and off", () => {
  it("shadow measures the finding and writes nothing", async () => {
    const { onFixDone, workflow, calls, completionRecord } = world({ mode: "shadow" });

    const result = await onFixDone({ workflow, fixTicket: fixTicketAtDone(), completionRecord });

    expect(result).toEqual({ action: "planned", sha7: HEAD7, unverified: true });
    expect(calls.events).toEqual([
      {
        ticketId: FIX,
        type: "fix.reverify_planned",
        detail: {
          workflowId: WF_ID, fixTicketId: FIX, sha7: HEAD7,
          wouldCreate: true, wouldMarkUnverified: true, shadow: true,
        },
      },
    ]);
    expect(calls.creates).toEqual([]);
    expect(calls.merges).toEqual([]);
    expect(calls.blockers).toEqual([]);
    expect(workflow.agentTasks[FIX].verification).toBeUndefined();
  });

  it("off reproduces production byte-identically — the module is never even built", async () => {
    // index.mjs's observeLiveReverify returns before construction when the flag
    // is off (pinned in done-handlers-cascade.test.mjs), so the honest statement
    // of "off" at THIS layer is that nothing about the fixture state changes.
    const { workflow, siblings, calls } = world({ mode: "off" });
    const before = JSON.stringify({ workflow, siblings });

    // …no onFixDone call at all: that is what off means here.

    expect(JSON.stringify({ workflow, siblings })).toBe(before);
    expect(calls).toEqual({ merges: [], creates: [], blockers: [], events: [], warns: [] });
    expect(workflow.agentTasks[FIX].verification).toBeUndefined();
    expect(workflow.agentTasks[FIX].reverifyTicketId).toBeUndefined();
    // Which is prod: TEAM-4066 shipped with TEAM-4089's live claim unchecked, and
    // the recheck arrived 47m later as a second dev loop.
    expect(fixtureTicket(SHIP).status).toBe("done");
  });
});
