import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * TEAM-4247 D2 REGRESSION REPLAY — wf_1788175925679_iczquj, epic TEAM-3582.
 *
 * A dead-code sweep of tycenjmccann/ember that found EIGHT things to remove and
 * shipped them: detect → remove → review → QA → CI → Ship → human Merge Approval
 * → CD → merged. This is the run D2 must not touch. c2uqki proves the gate closes a
 * zero-yield sweep; this file proves the same gate is INERT on a productive one —
 * the f50ucz argument, one deliverable later.
 *
 * ══ WHAT ACTUALLY HAPPENED (every value below is in the fixture) ══════════════
 * | when (UTC) | what the dossier records                                       |
 * |------------|----------------------------------------------------------------|
 * | 11:42:37   | TEAM-3583 (requirements_analyst) done — plans the 7-ticket chain |
 * | 11:41:57   | review.rejected TEAM-3590 → reopened TEAM-3589: the release      |
 * |            | manager's first pass BLOCKED (the sweep had no branch and no PR  |
 * |            | yet), so Ship sat in_progress from a CORRECT self-block          |
 * | 12:03:22   | TEAM-3585 (code_sweeper) done — "8 removed … vs ~140 flagged     |
 * |            | candidates KEPT", branch sweep/dead-code-2026-08-31, PR #57      |
 * | 12:08:08   | TEAM-3586 (code_reviewer) done — "VERDICT: PASS — zero findings" |
 * | 12:21:22   | TEAM-3587 (qa_verifier) done — "QA VERDICT: PASS"               |
 * | 12:38:40   | TEAM-3588 (ci_agent) done — "CI GATE: PASS" … and unblocked=[]:  |
 * |            | the cascade to Ship was DROPPED (see SYNTHESIZED note 4)        |
 * | 12:51:44   | manager.intervention "Missed unblock cascade" — the workflow     |
 * |            | manager re-dispatched TEAM-3589 by hand                          |
 * | 12:57:09   | TEAM-3589 (release_manager) done — "SHIP VERDICT: PASS", PR #57  |
 * |            | left OPEN → human gate TEAM-3590 unblocked, review.needed       |
 * | 19:30:38   | TEAM-3590 approved by the engineer → CD TEAM-3591 unblocked     |
 * | 19:31:57   | agent.error — Bedrock ServiceUnavailableException killed the CD  |
 * |            | agent mid-plan; retried by hand at 22:42                         |
 * | 22:45:45   | TEAM-3591 done — PR #57 squash-merged as f754cd3, branch deleted |
 * | 22:45:46   | workflow.complete (prUrl "", the RM owned the PR)               |
 *
 * Eight verified-dead removals, a human approval and a merge: everything D2's
 * detection gate is NOT for. The claim under test is that all three of its modes
 * leave this run's cascade, its ship window, its completion and its gate prompts
 * exactly as they were.
 *
 * ══ WHICH LAYER THIS EXERCISES ═══════════════════════════════════════════════
 * The REAL orchestrator: `handler` over DynamoDB-stream records → processRecord →
 * handleTicketDone → the real cascade.mjs, the real completion.mjs gates (evidence,
 * ship verdict, merge-verify), the real observeSweepDetection / sweepYieldNote, the
 * real dispatch path (buildAgentContext → invokeAgent). Only the AWS seams are
 * mocked. Nothing here re-implements a D2 decision; every assertion reads what
 * those modules published.
 *
 * ══ SYNTHESIZED, AND WHY ═════════════════════════════════════════════════════
 *  1. TICKET_PROVIDER is left UNSET (→ "dynamodb"), so `handler` takes the stream
 *     branch. iczquj was really a jira-mode run whose cascade came through
 *     handleTicketDoneUnified; the two done twins are pinned byte-identical in
 *     done-handlers-cascade.test.mjs.
 *  2. THE TWO-TICKET SPLIT. Commit 4 gives the sweep def a `detection` phase in
 *     FRONT of its `development` sweep phase, and both are in
 *     completionRequiresAgentPhases. A ticket has exactly ONE phase (completion.mjs
 *     phaseOf trusts the stamp, else the roster), so the fixture's single sweeper
 *     row cannot satisfy both: TEAM-3585 is re-stamped `phase: "detection"` (the
 *     8a shape) and the removal half becomes a synthesized second code_sweeper row,
 *     TEAM-3592 — commit 4's two-ticket intake plan. TEAM-3586 is rewired behind it
 *     (fixture: behind TEAM-3585). That is the ONE extra hop this replay's cascade
 *     has over the dossier's, and the amendment-1 wedge check below is exactly why
 *     the second row is not optional: with only a detection row, `development` has
 *     no done ticket and NO mode of the flag can ever complete the run.
 *  3. THE YIELD NUMBER. TEAM-3585's record predates commit 1, so it has no
 *     `verified_removable` and no `candidates` — the count lives only in its prose
 *     ("COUNTS: 8 removed … vs ~140 flagged candidates KEPT"). The detection record
 *     is seeded the way commit 1's report_completion now writes it:
 *     `verified_removable: 8`, `candidates: 148` (8 removed + the ~140 kept — a
 *     documented literal read off that sentence, since the record carries no field).
 *     Every other value is the fixture's.
 *  4. THE DOSSIER'S OWN DROPPED UNBLOCK. TEAM-3588's `agent.complete` carries
 *     `unblocked: []` even though TEAM-3589.blockedBy is [TEAM-3588] — the cascade
 *     hop was lost, and the workflow manager repaired it by hand 13 minutes later
 *     ("Missed unblock cascade", manager.intervention 12:51:17). A correct cascade
 *     releases Ship there, so the `off` baseline is the dossier's shape WITH that
 *     hop restored; the reconciliation is asserted, not assumed (see
 *     "the dossier's chain has one hole in it").
 *  5. THE CD REGISTRY. config/cd-registry.json IS served here (c2uqki deliberately
 *     omits it), with one entry for tycenjmccann/ember and NO `pipeline`: the
 *     fixture's workflow row has no `delivery` key at all, so no pipeline name can be
 *     read off it, and TEAM-3591's own CD record says this repo has no pipeline and no
 *     DEPLOY.md ("merge to main completes this workflow"). Registration itself is
 *     proven by the board — Ship + human Merge Approval + CD tickets exist ONLY for
 *     a registered repo; unregistered, cd-registry.mjs strips the whole ship phase.
 *  6. THE MERGE PROOF. The fixture's agentTasks carry no `mergeCommit` (that harvest
 *     came later) and the release manager's report_completion has no merge_commit
 *     field, so the TEAM-3747 ship-verdict gate would close this run
 *     `static-ci-only` on a run that demonstrably merged. Production resolved it the
 *     way it always does — GitHub ground truth (SHIP_MERGE_VERIFY): PR #57 was
 *     squash-merged as f754cd3 at 22:44:08Z and its branch deleted. So the replay
 *     sets GITHUB_PAT, gives the row the `featureBranch` every persona's record
 *     names (the fixture row has no such key), and answers the merge probe with that
 *     merged PR. Every completion gate therefore runs at FULL strength — no
 *     COMPLETION_EVIDENCE_REQUIRED opt-out anywhere in this file.
 *  7. THE FIXTURE'S EVENT STREAM IS DOUBLED. Every event appears twice, once at
 *     millisecond precision and once truncated to seconds (two projections of the
 *     same row: `detail.timestamp` is identical, `eventId` is not). The baseline
 *     reader de-duplicates on (type, detail.timestamp, ticketId) — without that,
 *     every count off this dossier is exactly 2× the truth.
 *  8. NO FIX TICKETS. Unlike c2uqki, this run filed none (every gate persona passed),
 *     so there is no FIX_BEFORE_VERIFY window to exercise here — f50ucz owns that.
 *     The one D1 flag asserted below is VERDICT_GATE, because a chain of passing
 *     gates is precisely the case where it must not hold a cascade. Three of the four
 *     verdicts resolve to PASS off the prose; TEAM-3588's "CI GATE: ✅ PASS" resolves
 *     to NOTHING, which is verdict-contract.mjs's rule 1 working as designed and is
 *     asserted as such rather than worked around.
 */

const h = vi.hoisted(() => ({
  state: {
    /** The live board, ticketId → row. Mutated by the real handlers' writes. */
    board: /** @type {Map<string, any>} */ (new Map()),
    /** The live workflow row (agentTasks mutate in place, as in production). */
    workflow: /** @type {any} */ (null),
    /** completions/<ticketId>.json, by ticketId. */
    completions: /** @type {Record<string, any>} */ ({}),
    /** config/cd-registry.json, as the artifact bucket serves it (note 5). */
    cdRegistry: /** @type {any} */ (null),
    /** Every EventBridge entry, in publish order. */
    ebEvents: /** @type {any[]} */ ([]),
    /** Every S3 GetObject key, in order. */
    s3Gets: /** @type {string[]} */ ([]),
    /** Every Tickets___create_ticket parameter set, in order. */
    createdTickets: /** @type {any[]} */ ([]),
    /** Every agent dispatch payload (agentcore-hub-agent-invoker), in order. */
    invokes: /** @type {any[]} */ ([]),
    /** Every blocker edge that actually WROTE (applyBlockerEdge attempt 1 or 2). */
    blockerWrites: /** @type {any[]} */ ([]),
    /** Every status transition write (transitionToReady + friends). */
    statusWrites: /** @type {any[]} */ ([]),
    /** Every claimTerminalOutcome call, and the real CAS behind them. */
    terminalClaims: /** @type {any[]} */ ([]),
    terminalOutcome: /** @type {string | null} */ (null),
    storeCompletions: /** @type {any[]} */ ([]),
    finalized: /** @type {string[]} */ ([]),
    notifications: /** @type {any[]} */ ([]),
    /** Every outbound GitHub call — the merge probe and any label ride on these. */
    githubCalls: /** @type {any[]} */ ([]),
    blockedKeys: new Map(),
    reverifySlots: new Set(),
    nextTicketNum: 0,
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

/** ConditionalCheckFailedException, the way applyBlockerEdge recognises it. */
const ccfe = () => {
  const e = new Error("The conditional request failed");
  e.name = "ConditionalCheckFailedException";
  return e;
};

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand { constructor(input) { this.input = input; } }
  class PutCommand { constructor(input) { this.input = input; } }
  class UpdateCommand { constructor(input) { this.input = input; } }
  class QueryCommand { constructor(input) { this.input = input; } }
  class ScanCommand { constructor(input) { this.input = input; } }
  return {
    GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd) => {
          const name = cmd.constructor.name;
          const table = String(cmd.input?.TableName || "");
          if (name === "GetCommand") {
            const id = cmd.input.Key?.ticketId;
            return { Item: id ? h.state.board.get(id) : undefined };
          }
          if (name === "QueryCommand") {
            // The events table is read for lease/idempotency history; an empty
            // answer is the "nothing recorded yet" path, which is what a replay is.
            if (table.includes("events")) return { Items: [] };
            const parent =
              cmd.input.ExpressionAttributeValues?.[":parentId"] ??
              cmd.input.ExpressionAttributeValues?.[":pid"];
            const rows = [...h.state.board.values()];
            return { Items: parent ? rows.filter((t) => t.parentId === parent) : rows };
          }
          if (name === "UpdateCommand") return applyUpdate(cmd.input);
          return {};
        },
      }),
    },
  };

  /**
   * A faithful-enough in-memory DynamoDB update: it evaluates the two condition
   * expressions ticket-blockers.mjs relies on (already-present blocker, and the
   * `preserveStatusIf` status guard), because the blocker-edge idempotency story
   * rides on those conditions failing rather than on the caller remembering what it
   * already wrote.
   */
  function applyUpdate(input) {
    const id = input.Key?.ticketId;
    const row = id ? h.state.board.get(id) : null;
    const v = input.ExpressionAttributeValues || {};
    if (!row) return {};

    if (v[":one"]) {
      // ── applyBlockerEdge: SET blockedBy = list_append(…, :one) [, #s = :blocked]
      const preserve = Object.keys(v).filter((k) => /^:ps\d+$/.test(k)).map((k) => v[k]);
      const setsBlocked = ":blocked" in v;
      const current = Array.isArray(row.blockedBy) ? row.blockedBy : [];
      if (current.includes(v[":id"])) throw ccfe();          // NOT contains(blockedBy, :id)
      if (preserve.length) {
        const inPreserve = preserve.includes(row.status);
        if (setsBlocked && inPreserve) throw ccfe();          // attempt 1 guard
        if (!setsBlocked && !inPreserve) throw ccfe();        // attempt 2 requirement
      }
      row.blockedBy = [...current, ...v[":one"]];
      if (setsBlocked) row.status = v[":blocked"];
      h.state.blockerWrites.push({ ticketId: id, ids: [...v[":one"]], status: row.status });
      return {};
    }

    if (":s" in v) {
      row.status = v[":s"];
      h.state.statusWrites.push({ ticketId: id, status: v[":s"] });
    }
    return {};
  }
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      let payload = null;
      try { payload = JSON.parse(cmd.input?.Payload || "{}"); } catch { /* not JSON */ }
      const tool = String(payload?.tool_name || "");
      // Agent dispatch: the rendered context travels as `prompt`, which is where a
      // FR-D2.6 yield note would land — and where this replay proves there is none.
      if (String(cmd.input?.FunctionName || "").includes("agent-invoker")) {
        h.state.invokes.push(payload || {});
        return {};
      }
      if (tool.startsWith("Tickets___create_ticket")) {
        const params = payload.parameters || {};
        h.state.nextTicketNum += 1;
        const key = `TEAM-36${String(h.state.nextTicketNum).padStart(2, "0")}`;
        h.state.createdTickets.push({ ...params, key });
        // The created ticket joins the board, exactly as the stream would deliver it.
        h.state.board.set(key, {
          ticketId: key,
          title: params.summary,
          assignee: params.assignee,
          parentId: params.parent_key,
          workflowId: params.workflow_id,
          type: "task",
          status: (params.blocked_by || []).length ? "blocked" : "todo",
          blockedBy: [...(params.blocked_by || [])],
          spawnedBy: params.spawned_by ? { ...params.spawned_by } : null,
          fixContract: params.fix_contract || null,
        });
        return { Payload: new TextEncoder().encode(JSON.stringify({ key })) };
      }
      return {};
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const name = cmd.constructor.name;
      const key = String(cmd?.input?.Key || "");
      if (name === "PutObjectCommand") return {};
      if (name === "ListObjectsV2Command") return { Contents: [] };
      h.state.s3Gets.push(key);
      // The CD registry decides whether this run HAS a ship phase at all: with no
      // entry, cd-registry.mjs strips ship + the Merge Approval gate and the run
      // would complete the moment CI is done — TEAM-3589/3590/3591 would be dead
      // rows and every ship assertion here would be testing handoff (note 5).
      if (key.endsWith("config/cd-registry.json") && h.state.cdRegistry) {
        const body = JSON.stringify(h.state.cdRegistry);
        return { Body: { transformToString: async () => body } };
      }
      // The other two config objects the deploy syncs to the artifact bucket.
      // Without config/workflows.json the orchestrator falls back to
      // FALLBACK_WORKFLOW_DEF, which has NO detection phase and no ship phase — so
      // both the D2 gate and the ship window would go unasserted. agents.json is
      // what gives each persona its phase, which is what the completion gate reads.
      if (key.endsWith("config/workflows.json")) return REPO_CONFIG.workflows;
      if (key.endsWith("config/agents.json")) return REPO_CONFIG.agents;
      const m = /completions\/(.+)\.json$/.exec(key);
      const rec = m ? h.state.completions[m[1]] : null;
      if (!rec) {
        const e = new Error("The specified key does not exist.");
        e.name = "NoSuchKey";
        throw e;
      }
      const body = JSON.stringify(rec);
      return { Body: { transformToString: async () => body } };
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send(cmd) { h.state.ebEvents.push(cmd.input); return {}; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class {},
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient: class { async send() { return {}; } },
  InvokeAgentRuntimeCommand: class { constructor(i) { this.input = i; } },
}));

/**
 * PARTIAL mock (importOriginal): every pure helper stays the real one. Only the
 * seams that talk to DynamoDB are replaced, each with the real tri-state.
 */
vi.mock("./workflow-store.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initWorkflowStore: vi.fn(() => {}),
    getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
    trackTicket: vi.fn(async () => true),
    // The dispatch claim, so a ticket becoming ready runs to the end of its record
    // instead of dying on the real CAS — the invoke seam itself is captured above.
    claimInvocation: vi.fn(async () => true),
    setTaskStatus: vi.fn(async () => {}),
    // The phase advance write, applied to the live row the way the real one does —
    // this run crosses three agent phases, and the real function needs the store's
    // own DynamoDB client, which initWorkflowStore above no longer creates.
    advancePhase: vi.fn(async (id, phase, featureBranch) => {
      if (h.state.workflow?.id !== id) return;
      h.state.workflow.phase = phase;
      if (featureBranch) h.state.workflow.featureBranch = featureBranch;
    }),
    ackNotifications: vi.fn(async () => {}),
    appendReviewNotificationOnce: vi.fn(async () => true),
    completeTaskEntry: vi.fn(async () => true),
    completeWorkflow: vi.fn(async (id, ts) => { h.state.storeCompletions.push({ id, ts }); return true; }),
    claimFinalization: vi.fn(async () => false),
    markFinalized: vi.fn(async (id) => { h.state.finalized.push(id); }),
    // The real CAS: the FIRST terminal claim wins and every later one loses.
    claimTerminalOutcome: vi.fn(async (workflowId, outcome, completedAt, reason) => {
      h.state.terminalClaims.push({ workflowId, outcome, completedAt, reason });
      if (h.state.terminalOutcome) return false;
      h.state.terminalOutcome = outcome;
      return true;
    }),
    setDelivery: vi.fn(async (id, delivery) => {
      if (h.state.workflow?.id === id) h.state.workflow.delivery = delivery;
    }),
    appendNotification: vi.fn(async (id, n) => { h.state.notifications.push({ id, n }); }),
    mergeTaskMetadata: vi.fn(async (id, tid, fields) => {
      const tasks = h.state.workflow?.agentTasks;
      if (tasks) tasks[tid] = { ...(tasks[tid] || { ticketId: tid }), ...fields };
    }),
    claimCompletionBlocked: vi.fn(async (id, key) => {
      const result = h.state.blockedKeys.get(id) === key ? "taken" : "claimed";
      if (result === "claimed") h.state.blockedKeys.set(id, key);
      return result;
    }),
    claimReverifySlot: vi.fn(async (wfId, ticketId, slotSha) => {
      const slot = `${wfId}|${ticketId}|${slotSha}`;
      const result = h.state.reverifySlots.has(slot) ? "taken" : "claimed";
      if (result === "claimed") h.state.reverifySlots.add(slot);
      return result;
    }),
    releaseReverifySlot: vi.fn(async (wfId, ticketId, slotSha) => {
      h.state.reverifySlots.delete(`${wfId}|${ticketId}|${slotSha}`);
    }),
  };
});

// ─── The fixture ─────────────────────────────────────────────────────────────

const DOSSIER = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../deploy/workflow-manager/toolkit/fixtures/iczquj-dossier.json", import.meta.url)),
    "utf8",
  ),
);

/** The repo's own copies of the config objects the deploy syncs to the artifact
 *  bucket, served verbatim by the S3 mock above (read-only — never written). */
const readConfig = (rel) => {
  const text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  return { Body: { transformToString: async () => text } };
};
const REPO_CONFIG = {
  workflows: readConfig("../../src/config/workflows.json"),
  agents: readConfig("../../src/config/agents.json"),
};

/** The same dead-code-sweep def the S3 mock serves, as a value to assert on. */
const SWEEP_DEF = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/config/workflows.json", import.meta.url)), "utf8"),
).workflows.find((w) => w.id === "dead-code-sweep");

/** agents.json's phase per assignee — what completion.mjs's phaseOf falls back to. */
const ROSTER_PHASE = Object.fromEntries(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../src/config/agents.json", import.meta.url)), "utf8"))
    .agents.map((a) => [a.agentId, a.phase]),
);

/** Fixture rows by id — these throw if the vendored dossier moves under us. */
function fixtureTicket(ticketId) {
  const row = DOSSIER.tickets.find((t) => t.ticketId === ticketId);
  if (!row) throw new Error(`iczquj fixture has no ticket ${ticketId}`);
  return row;
}
function fixtureCompletion(ticketId) {
  const rec = DOSSIER.completions?.[ticketId];
  if (!rec) throw new Error(`iczquj fixture has no completion record for ${ticketId}`);
  return rec;
}

const WF_ID = "wf_1788175925679_iczquj";
const EPIC = "TEAM-3582";
const ANALYST = "TEAM-3583";  // requirements_analyst — intake
const DETECT = "TEAM-3585";   // code_sweeper — re-stamped phase "detection" (note 2)
const SWEEP = "TEAM-3592";    // code_sweeper — SYNTHESIZED removal row (note 2)
const REVIEW = "TEAM-3586";   // code_reviewer — PASS
const QA = "TEAM-3587";       // qa_verifier — PASS
const CI = "TEAM-3588";       // ci_agent — PASS
const SHIP = "TEAM-3589";     // release_manager — Ship, PASS, PR left open
const APPROVAL = "TEAM-3590"; // human:engineer — Merge Approval gate
const CD = "TEAM-3591";       // release_manager — CD, merged
const CHAIN = [ANALYST, DETECT, SWEEP, REVIEW, QA, CI, SHIP, APPROVAL, CD];

const SWEEPER_ID = "agentcore_hub_code_sweeper";
const REVIEWER_ID = "agentcore_hub_code_reviewer";
const QA_ID = "agentcore_hub_qa_verifier";
const CI_ID = "agentcore_hub_ci_agent";
const RM_ID = "agentcore_hub_release_manager";
/** Every persona the cascade dispatches after intake, in chain order. */
const DISPATCHED = [
  [SWEEP, SWEEPER_ID], [REVIEW, REVIEWER_ID], [QA, QA_ID], [CI, CI_ID], [SHIP, RM_ID], [CD, RM_ID],
];

/** The sweep's own numbers (note 3): 8 removed, ~140 flagged candidates kept. */
const VERIFIED_REMOVABLE = 8;
const CANDIDATES = 148;

/** The branch every persona's record names; the fixture's workflow row has no
 *  featureBranch key at all (note 6). */
const FEATURE_BRANCH = fixtureCompletion(DETECT).branch;   // sweep/dead-code-2026-08-31
const PR_URL = fixtureCompletion(DETECT).pr_url;           // …/ember/pull/57
/** The squash-merge commit TEAM-3591 recorded on main — GitHub's proof (note 6). */
const MERGE_COMMIT = fixtureCompletion(CD).commit_sha;     // f754cd36…
const MERGED_AT = "2026-08-31T22:44:08Z";

// ─── Board / workflow / records, built from the fixture ──────────────────────

/**
 * The board as it read at 11:42Z: intake and the detection sweep in flight, every
 * gate blocked behind the fixture's own chain — with TEAM-3585 stamped `detection`
 * and the synthesized removal row TEAM-3592 spliced in behind it (note 2).
 */
function buildBoard({ withRemovalTicket = true } = {}) {
  const board = new Map();
  for (const t of DOSSIER.tickets) {
    const row = JSON.parse(JSON.stringify(t));
    row.blockedBy = Array.isArray(row.blockedBy) ? row.blockedBy : [];
    if (CHAIN.includes(row.ticketId)) {
      row.status = row.ticketId === ANALYST || row.ticketId === DETECT ? "in_progress" : "blocked";
      delete row.completedAt;
    }
    if (row.ticketId === DETECT) row.phase = "detection";
    if (row.ticketId === REVIEW && withRemovalTicket) row.blockedBy = [SWEEP];
    board.set(row.ticketId, row);
  }
  if (withRemovalTicket) {
    const detect = fixtureTicket(DETECT);
    board.set(SWEEP, {
      ticketId: SWEEP,
      title: "Sweep: remove the verified-dead code and open the PR (Removal Ledger)",
      status: "blocked",
      assignee: SWEEPER_ID,          // roster phase "development" — no stamp needed
      parentId: EPIC,
      blockedBy: [DETECT],
      workflowId: WF_ID,
      type: "task",
      createdAt: detect.createdAt,
    });
  }
  return board;
}

/**
 * The workflow row, verbatim from the fixture apart from `phase` (the fixture's is
 * the post-hoc "complete"), the delivery/completion stamps (written at 22:45, after
 * everything this replay decides), the featureBranch (note 6) and the agentTasks of
 * the replayed tickets, which are rewound so the real harvest fills them.
 */
function buildWorkflow({ withRemovalTicket = true } = {}) {
  const wf = JSON.parse(JSON.stringify(DOSSIER.workflow));
  wf.id = WF_ID;
  wf.workflowId = WF_ID;
  wf.epicId = EPIC;
  wf.phase = "detection";
  wf.featureBranch = FEATURE_BRANCH;
  delete wf.delivery;
  delete wf.completedAt;
  delete wf.finalizedAt;
  wf.humanNotifications = wf.humanNotifications || [];
  wf.resumeContexts = wf.resumeContexts || {};
  for (const id of CHAIN) {
    const entry = wf.agentTasks?.[id];
    if (!entry) continue;
    entry.status = "running";
    delete entry.completedAt;
    // commit 1's harvest fill is what puts the yield on the task entry; starting
    // with it already there would make the FR-D2.6 assertions self-fulfilling.
    delete entry.verifiedRemovable;
    delete entry.candidates;
  }
  if (withRemovalTicket && wf.agentTasks) {
    // The task entry a dispatched TEAM-3592 would have, cloned off the sweeper's own.
    const detect = wf.agentTasks[DETECT];
    wf.agentTasks[SWEEP] = {
      agentId: SWEEPER_ID,
      id: `task_${SWEEP}_${SWEEPER_ID}`,
      ticketId: SWEEP,
      status: "running",
      createdAt: detect?.createdAt,
      startedAt: detect?.startedAt,
    };
  } else {
    delete wf.agentTasks?.[SWEEP];
  }
  return wf;
}

/**
 * The completion records as the personas would write them after commit 1. Every
 * value is the fixture's own except TEAM-3585's `verified_removable`/`candidates`
 * (note 3) and TEAM-3592's record, which is the removal half of the same report
 * (note 2) — the yield stays on the DETECTION record, which is the only one
 * observeSweepDetection and sweepYieldNote ever consult.
 */
function buildCompletions() {
  const out = {};
  for (const [ticketId, rec] of Object.entries(DOSSIER.completions || {})) {
    out[ticketId] = JSON.parse(JSON.stringify(rec));
  }
  out[DETECT].verified_removable = VERIFIED_REMOVABLE;
  out[DETECT].candidates = CANDIDATES;
  out[SWEEP] = { ...JSON.parse(JSON.stringify(out[DETECT])), ticket_id: SWEEP };
  delete out[SWEEP].verified_removable;
  delete out[SWEEP].candidates;
  return out;
}

// ─── Stream records ──────────────────────────────────────────────────────────

/** JS value → DynamoDB-stream AttributeValue, enough for the fixture's shapes. */
function toImage(obj) {
  const enc = (val) => {
    if (val === null || val === undefined) return { NULL: true };
    if (typeof val === "string") return { S: val };
    if (typeof val === "number") return { N: String(val) };
    if (typeof val === "boolean") return { BOOL: val };
    if (Array.isArray(val)) return { L: val.map(enc) };
    return { M: Object.fromEntries(Object.entries(val).map(([k, v]) => [k, enc(v)])) };
  };
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, enc(v)]));
}

/** The MODIFY record the tickets table emits when an agent moves itself to Done. */
function doneRecord(ticketId) {
  const row = h.state.board.get(ticketId);
  const next = { ...row, status: "done" };
  h.state.board.set(ticketId, next);
  return {
    eventName: "MODIFY",
    eventSource: "aws:dynamodb",
    dynamodb: { OldImage: toImage(row), NewImage: toImage(next) },
  };
}

/** The MODIFY record a cascade-unblocked successor produces on the next hop — the
 *  level-triggered delivery every agent dispatch actually rides on. */
function readyRecord(ticketId, status = "ready") {
  const row = h.state.board.get(ticketId);
  const next = { ...row, status };
  h.state.board.set(ticketId, next);
  return {
    eventName: "MODIFY",
    eventSource: "aws:dynamodb",
    dynamodb: { OldImage: toImage({ ...row, status: "blocked" }), NewImage: toImage(next) },
  };
}

// ─── Event log readers ───────────────────────────────────────────────────────

const allEvents = () =>
  h.state.ebEvents
    .flatMap((i) => i.Entries || [])
    .map((e) => ({ type: e.DetailType, detail: JSON.parse(e.Detail) }));

const detailsOfType = (type) => allEvents().filter((e) => e.type === type).map((e) => e.detail);
const countOfType = (type) => detailsOfType(type).length;
const indexOfType = (type) => allEvents().findIndex((e) => e.type === type);

/**
 * The cascade as HOPS: one entry per `agent.complete`, in order, carrying both the
 * `unblocked` array the twin published AND the successors the cascade actually
 * released (from the `orchestrator.unblocked` events that name it) — then the
 * terminal event.
 *
 * Publish ORDER within a hop is deliberately not compared: today's twins run
 * cascadeUnblock BEFORE the publish (index.mjs :4008 → :4016), so the unblocks come
 * out ahead of the `agent.complete` that caused them, while the dossier's stream has
 * them the other way round. The causal content is what a regression guard should
 * pin; the relative order of two events the same function writes microseconds apart
 * is not. Cross-hop order IS compared — that is the cascade.
 */
function hopsFrom(events) {
  const hops = [];
  const byTicket = new Map();
  for (const e of events) {
    if (e.type === "agent.complete") {
      const hop = { ticketId: e.detail?.ticketId ?? null, unblocked: e.detail?.unblocked ?? null, released: [] };
      hops.push(hop);
      byTicket.set(hop.ticketId, hop);
    } else if (e.type === "workflow.complete") {
      hops.push({ terminal: "workflow.complete", ticketId: e.detail?.ticketId ?? null });
    }
  }
  // Second pass, so an unblock published ahead of its own completer still lands on
  // that hop. An unblock naming a ticket that never completed is a real difference,
  // so it is appended rather than dropped.
  for (const e of events) {
    if (e.type !== "orchestrator.unblocked") continue;
    const hop = byTicket.get(e.detail?.unblockedBy);
    if (hop) hop.released.push(e.detail?.ticketId ?? null);
    else hops.push({ orphanUnblock: e.detail?.ticketId ?? null, unblockedBy: e.detail?.unblockedBy ?? null });
  }
  return hops;
}

const cascadeHops = () => hopsFrom(allEvents());

/**
 * The dossier's OWN event stream, de-duplicated (note 7) and restricted to the
 * cascade types and the replayed window.
 */
function fixtureEvents() {
  const seen = new Set();
  const out = [];
  for (const e of DOSSIER.events || []) {
    const detail = e.detail || {};
    const key = [e.type, detail.timestamp ?? e.timestamp, detail.ticketId ?? "", detail.unblockedBy ?? ""].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: e.type, detail });
  }
  return out;
}

const fixtureHops = () => {
  const replayed = new Set(CHAIN);
  return hopsFrom(
    fixtureEvents().filter((e) => {
      if (e.type === "agent.complete") return replayed.has(e.detail?.ticketId);
      if (e.type === "orchestrator.unblocked") return replayed.has(e.detail?.unblockedBy);
      return e.type === "workflow.complete";
    }),
  );
};

/**
 * The baseline `off` must reproduce: the dossier's own hops with the TWO documented
 * differences applied — the two-ticket split (note 2) and the repair of the dropped
 * TEAM-3588 → TEAM-3589 unblock the workflow manager had to make by hand (note 4).
 * Derived from the fixture rather than hand-copied, so a fixture edit cannot leave
 * a stale expectation behind.
 */
function expectedOffHops() {
  const out = [];
  for (const hop of fixtureHops()) {
    if (hop.ticketId === DETECT) {
      // Detection releases the removal row, which then releases the reviewer.
      out.push({ ticketId: DETECT, unblocked: [SWEEP], released: [SWEEP] });
      out.push({ ticketId: SWEEP, unblocked: [REVIEW], released: [REVIEW] });
      continue;
    }
    if (hop.ticketId === CI) {
      // The hop the dossier lost: CI green releases Ship.
      out.push({ ticketId: CI, unblocked: [SHIP], released: [SHIP] });
      continue;
    }
    out.push(hop);
  }
  return out;
}

/** Everything a dispatch leaves behind, by persona. */
const dispatchedTo = (agentId) => h.state.invokes.filter((p) => p.agentId === agentId);
const promptsFor = (agentId) => dispatchedTo(agentId).map((p) => p.prompt || "");
/** The statuses that make a ticket runnable — the write every dispatch is triggered off. */
const RUNNABLE = new Set(["todo", "ready", "in_progress"]);
const madeRunnable = () => h.state.statusWrites.filter((w) => RUNNABLE.has(w.status));

// ─── The driver ──────────────────────────────────────────────────────────────

let handler;
let stripUnenforcedDetectionPhase;

/**
 * Every flag is read at index.mjs module scope, so each mode needs a fresh module
 * graph. `undefined` means "leave unset", which is how the shadow default is
 * exercised rather than asserted by hand.
 */
async function loadWith({ sweep, verdict = "off", fixBefore = "off", verifiedHead = "off" } = {}) {
  const set = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  set("SWEEP_DETECTION_PHASE", sweep);
  set("VERDICT_GATE", verdict);
  set("FIX_BEFORE_VERIFY", fixBefore);
  set("VERIFIED_HEAD_COMPLETION", verifiedHead);
  vi.resetModules();
  ({ handler, stripUnenforcedDetectionPhase } = await import("./index.mjs"));
  // Warm the module exactly as production does: the roster, the workflow defs and
  // the CD registry are loaded by `handler`, not by the twins.
  await handler({ Records: [] });
  h.state.s3Gets.length = 0;
}

/** One stream delivery, through the real handler. */
const deliver = (record) => handler({ Records: [record] });

/**
 * The run, in the order the fixture records it: intake, detection, the removal, then
 * review → QA → CI → Ship → the human merge approval → CD, each ticket's cascade
 * deciding whether the next may start.
 */
async function replay() {
  for (const id of CHAIN) await deliver(doneRecord(id));
}

/**
 * The same run with the level-triggered dispatch hops interleaved: the cascade sets
 * the successor runnable, and the resulting stream record is what invokes it. This
 * is the variant that captures each persona's rendered context.
 */
async function replayWithDispatches() {
  await deliver(doneRecord(ANALYST));
  await deliver(doneRecord(DETECT));
  for (const [ticketId] of DISPATCHED) {
    await deliver(readyRecord(ticketId));
    if (ticketId === SHIP) {
      // The human gate is not dispatched to an agent; it is approved.
      await deliver(doneRecord(SHIP));
      await deliver(readyRecord(APPROVAL));
      await deliver(doneRecord(APPROVAL));
      continue;
    }
    await deliver(doneRecord(ticketId));
  }
}

// The dispatch path resolves each persona's runtime from the env, and a missing ARN
// publishes agent.error instead of invoking — which would make every "what the
// persona was told" assertion below vacuous.
const RUNTIME = (name) => `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${name}`;
process.env.RUNTIME_ARN_AGENTCORE_HUB_CODE_SWEEPER = RUNTIME("code-sweeper");
process.env.RUNTIME_ARN_AGENTCORE_HUB_CODE_REVIEWER = RUNTIME("code-reviewer");
process.env.RUNTIME_ARN_AGENTCORE_HUB_QA_VERIFIER = RUNTIME("qa-verifier");
process.env.RUNTIME_ARN_AGENTCORE_HUB_CI_AGENT = RUNTIME("ci-agent");
process.env.RUNTIME_ARN_AGENTCORE_HUB_RELEASE_MANAGER = RUNTIME("release-manager");

describe("iczquj replay — the fixture still says what this replay claims", () => {
  it("records a productive sweep that shipped through the human merge gate", () => {
    expect(DOSSIER.workflow.workflowDefId).toBe("dead-code-sweep");
    expect(DOSSIER.workflow.phase).toBe("complete");

    // Eight removals, in prose only — the fixture predates commit 1's field.
    const rec = fixtureCompletion(DETECT);
    expect(rec.verified_removable).toBeUndefined();
    expect(rec.summary).toContain("COUNTS: 8 removed");
    expect(rec.summary).toContain("~140 flagged candidates KEPT");
    expect(rec.pr_url).toMatch(/\/tycenjmccann\/ember\/pull\/57$/);

    // The ship window really is on the board, which is what "CD-registered" means.
    expect(fixtureTicket(SHIP).assignee).toBe(RM_ID);
    expect(fixtureTicket(APPROVAL).assignee).toBe("human:engineer");
    expect(fixtureTicket(CD).assignee).toBe(RM_ID);
    expect(fixtureCompletion(CD).summary).toContain("merged to main strictly after recorded human approval");

    // …and the pipeline the CD ticket did NOT use (note 5): the row records no
    // delivery at all, and the repo has neither a pipeline nor a DEPLOY.md.
    expect(DOSSIER.workflow.delivery).toBeUndefined();
    expect(DOSSIER.workflow.featureBranch).toBeUndefined();
    expect(fixtureCompletion(CD).summary).toContain("NO CI/CD pipeline");

    // The def AS IT RAN had no detection phase — that is commit 4's addition, and
    // why TEAM-3585 has to be stamped for this replay (note 2).
    expect(DOSSIER.workflowDef.completionRequiresAgentPhases).toEqual([
      "development", "verification", "review", "ship",
    ]);
    expect(DOSSIER.tickets.every((t) => t.phase === undefined)).toBe(true);
  });

  it("the dossier's event stream is doubled, and its chain has one hole in it", () => {
    // note 7 — every row appears at ms and at second precision.
    const raw = (DOSSIER.events || []).filter((e) => e.type === "workflow.complete");
    expect(raw).toHaveLength(2);
    expect(fixtureEvents().filter((e) => e.type === "workflow.complete")).toHaveLength(1);

    // note 4 — CI closed green and released nothing, though Ship was blocked on it.
    const hops = fixtureHops();
    expect(hops.find((s) => s.ticketId === CI)).toEqual({ ticketId: CI, unblocked: [], released: [] });
    expect(fixtureTicket(SHIP).blockedBy).toEqual([CI]);
    const repair = fixtureEvents().find(
      (e) => e.type === "manager.intervention" && /Missed unblock cascade/.test(String(e.detail?.note || "")),
    );
    expect(repair?.detail?.action).toBe("unstick");

    // Which is the ONLY hole: every other hop released exactly what the board said.
    expect(hops.filter((s) => s.orphanUnblock)).toEqual([]);
    expect(hops.map((s) => s.terminal ?? s.ticketId)).toEqual([
      ANALYST, DETECT, REVIEW, QA, CI, SHIP, APPROVAL, CD, "workflow.complete",
    ]);
  });
});

describe("iczquj replay — SWEEP_DETECTION_PHASE is inert on a productive sweep", () => {
  beforeEach(() => {
    Object.assign(h.state, {
      // The registry entry that made this a CD run (note 5): only `repo` is
      // required, and this repo has no pipeline to name.
      cdRegistry: { version: 1, repos: [{ repo: "tycenjmccann/ember" }] },
      board: buildBoard(),
      workflow: buildWorkflow(),
      completions: buildCompletions(),
      terminalOutcome: null,
      blockedKeys: new Map(),
      reverifySlots: new Set(),
      nextTicketNum: 0,
    });
    for (const key of [
      "ebEvents", "s3Gets", "createdTickets", "invokes", "blockerWrites",
      "statusWrites", "terminalClaims", "storeCompletions", "finalized",
      "notifications", "githubCalls",
    ]) h.state[key] = [];
    process.env.ARTIFACT_BUCKET = "test-artifacts";
    process.env.EVENT_BUS = "test-bus";
    // note 6 — the ship-verdict gate resolves this run's merge from GitHub, exactly
    // as production did; without the PAT it would close the run static-ci-only.
    process.env.GITHUB_PAT = "ghp_test";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (url, init) => {
      const u = String(url);
      h.state.githubCalls.push({ url: u, method: init?.method || "GET", body: init?.body });
      const json = (v) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) });
      // The merge probe's ground truth: PR #57 was squash-merged and its branch
      // deleted at 22:44:08Z (TEAM-3591's CD record).
      if (/\/pulls\?head=/.test(u)) {
        return json([{ number: 57, merged_at: MERGED_AT, merge_commit_sha: MERGE_COMMIT, html_url: PR_URL }]);
      }
      return json([]);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const name of [
      "SWEEP_DETECTION_PHASE", "VERDICT_GATE", "FIX_BEFORE_VERIFY",
      "VERIFIED_HEAD_COMPLETION", "ARTIFACT_BUCKET", "EVENT_BUS", "GITHUB_PAT",
    ]) delete process.env[name];
  });

  // ── (1) enforce ────────────────────────────────────────────────────────────
  describe("enforce — the gate looks, and lets the whole chain run", () => {
    it("never closes the run as nothing-to-remove", async () => {
      await loadWith({ sweep: "enforce" });
      await replay();

      // Not one D2 close, not one D2 event, not one D2 side effect.
      expect(h.state.terminalClaims.filter((c) => c.outcome === "nothing-to-remove")).toEqual([]);
      expect(countOfType("workflow.nothing_to_remove")).toBe(0);
      // There is no wouldClose:false observation to assert: observeSweepDetection
      // returns null on `record.verified_removable !== 0` BEFORE it publishes, so a
      // productive sweep is never observed in any mode. The observer exists to watch
      // the close it would have made, and here there is no close to watch.
      expect(detailsOfType("sweep.detection_observed")).toEqual([]);
      expect(allEvents().filter((e) => /^sweep\./.test(e.type))).toEqual([]);
      // No PR label either — sweep:no-op is the close's own side effect.
      expect(h.state.githubCalls.filter((c) => /\/labels$/.test(c.url))).toEqual([]);

      // Non-vacuity: the gate really did read the yield off the detection record.
      expect(h.state.workflow.agentTasks[DETECT]).toMatchObject({
        verifiedRemovable: VERIFIED_REMOVABLE, candidates: CANDIDATES,
      });
      expect(h.state.s3Gets).toContain(`completions/${DETECT}.json`);
    });

    it("dispatches the full chain and completes the run", async () => {
      await loadWith({ sweep: "enforce" });
      await replay();

      // Every successor released, in the fixture's order — with the removal row's
      // hop (note 2) and the dossier's dropped Ship unblock repaired (note 4).
      expect(detailsOfType("orchestrator.unblocked").map((d) => d.ticketId)).toEqual([
        SWEEP, REVIEW, QA, CI, SHIP, APPROVAL, CD,
      ]);
      expect(madeRunnable().map((w) => w.ticketId)).toEqual(
        expect.arrayContaining([SWEEP, REVIEW, QA, CI, SHIP, APPROVAL, CD]),
      );

      // The run's real terminal outcome, exactly as the dossier recorded it: one
      // workflow.complete, on the epic, last.
      const complete = detailsOfType("workflow.complete");
      expect(complete).toHaveLength(1);
      expect(complete[0]).toMatchObject({ workflowId: WF_ID, ticketId: EPIC, delivery: "cd" });
      expect(allEvents().at(-1).type).toBe("workflow.complete");
      expect(indexOfType("workflow.complete")).toBeGreaterThan(indexOfType("agent.complete"));
      expect(h.state.storeCompletions.map((c) => c.id)).toEqual([WF_ID]);
      expect(h.state.finalized).toEqual([WF_ID]);

      // …and it closed on GitHub's merge proof, not on a shortcut: the ship-verdict
      // gate stamped both ship tickets from the probe (note 6).
      for (const id of [SHIP, CD]) {
        expect(h.state.workflow.agentTasks[id], id).toMatchObject({
          mergeCommit: MERGE_COMMIT, mergeVerifiedBy: "github",
        });
      }
      expect(h.state.githubCalls.some((c) => /\/pulls\?head=/.test(c.url))).toBe(true);
    }, 20_000);

    it("tells no persona anything about the yield — verified_removable is 8", async () => {
      await loadWith({ sweep: "enforce" });
      await replayWithDispatches();

      // Non-vacuity: the yield IS on the task entry, and it is not zero.
      expect(h.state.workflow.agentTasks[DETECT].verifiedRemovable).toBe(VERIFIED_REMOVABLE);
      expect(Object.values(h.state.workflow.agentTasks).some((t) => t?.verifiedRemovable === 0)).toBe(false);

      for (const [ticketId, agentId] of DISPATCHED) {
        const prompts = promptsFor(agentId);
        expect(prompts.length, `${ticketId}/${agentId}`).toBeGreaterThan(0);
        for (const prompt of prompts) {
          expect(prompt, `${ticketId}/${agentId}`).not.toContain("## Sweep Yield");
          expect(prompt, `${ticketId}/${agentId}`).not.toContain("verified removable");
          expect(prompt, `${ticketId}/${agentId}`).not.toContain("deletion-free");
        }
      }
      // Each of the six agent tickets was dispatched exactly once.
      expect(h.state.invokes.map((p) => p.ticketId)).toEqual(DISPATCHED.map(([id]) => id));
      // The human gate is approved, never invoked.
      expect(h.state.invokes.filter((p) => String(p.agentId || "").startsWith("human:"))).toEqual([]);
    }, 20_000);
  });

  // ── (2) shadow (the default) ───────────────────────────────────────────────
  describe("shadow (the default) — nothing to observe, nothing observed", () => {
    it("is cascade-identical to off, and publishes no D2 event", async () => {
      await loadWith({ sweep: "off" });
      await replay();
      const off = cascadeHops();

      // A fresh board for the second pass — beforeEach only runs once per `it`.
      Object.assign(h.state, {
        board: buildBoard(), workflow: buildWorkflow(), completions: buildCompletions(),
        ebEvents: [], invokes: [], statusWrites: [], blockerWrites: [], createdTickets: [],
        terminalClaims: [], storeCompletions: [], finalized: [], terminalOutcome: null,
        blockedKeys: new Map(), reverifySlots: new Set(),
      });
      await loadWith({ sweep: undefined });   // unset → shadow
      await replay();

      expect(cascadeHops()).toEqual(off);
      expect(allEvents().filter((e) => /^sweep\./.test(e.type))).toEqual([]);
      expect(countOfType("workflow.nothing_to_remove")).toBe(0);
      expect(countOfType("workflow.complete")).toBe(1);
      expect(h.state.terminalClaims.filter((c) => c.outcome === "nothing-to-remove")).toEqual([]);
    }, 30_000);
  });

  // ── (3) off ────────────────────────────────────────────────────────────────
  describe("off — the run the dossier recorded", () => {
    it("reproduces the fixture's own cascade, paying nothing", async () => {
      await loadWith({ sweep: "off" });
      await replay();

      expect(cascadeHops()).toEqual(expectedOffHops());

      // Not one D2 event, and not one D2 side effect.
      expect(
        allEvents().filter((e) => /^sweep\./.test(e.type) || e.type === "workflow.nothing_to_remove"),
      ).toEqual([]);
      expect(h.state.terminalClaims.filter((c) => c.outcome === "nothing-to-remove")).toEqual([]);
      expect(h.state.githubCalls.filter((c) => /\/labels$/.test(c.url))).toEqual([]);
      // No fix ticket, no re-verify, no blocker edge: this run needed none.
      expect(h.state.createdTickets).toEqual([]);
      expect(h.state.blockerWrites).toEqual([]);
    }, 20_000);

    it("does not read the detection record beyond the harvest's own read", async () => {
      await loadWith({ sweep: "off" });
      await replay();

      // `off` returns before readCompletionRecord — so the read count is the
      // harvest's alone, and identical to what shadow (which DOES look) spends,
      // because readCompletionRecord memoizes per Lambda container.
      expect(h.state.s3Gets.filter((k) => k === `completions/${DETECT}.json`)).toHaveLength(1);
    }, 20_000);
  });

  // ── (4) the amendment-1 wedge: enforce requires TWO sweeper tickets ────────
  describe("the detection phase does not wedge a productive sweep", () => {
    it("completes under enforce with a stamped detection ticket AND a removal ticket", async () => {
      const { isWorkflowComplete } = await import("./completion.mjs");
      await loadWith({ sweep: "enforce" });
      const def = stripUnenforcedDetectionPhase(SWEEP_DEF);
      expect(def.completionRequiresAgentPhases).toContain("detection");

      const done = (t) => ({ ...t, status: "done" });
      const children = [...buildBoard().values()].filter((t) => t.type !== "epic").map(done);
      // The same two resolvers evaluateCompletionSnapshot supplies (index.mjs :4508):
      // an assignee's phase comes from the roster, and a human gate's guarded phase
      // from the phase of the ticket it blocks — the fixture's TEAM-3590 carries no
      // `phase` stamp, so without the second resolver the Merge Approval gate would
      // look unmatched and `ship` could never be satisfied.
      const byId = new Map(children.map((t) => [t.ticketId, t]));
      const opts = {
        getAgentPhase: (assignee) => ROSTER_PHASE[assignee],
        gatePhaseOf: (gate) =>
          typeof gate.phase === "string" && gate.phase
            ? gate.phase
            : (gate.blockedBy || []).map((up) => ROSTER_PHASE[byId.get(up)?.assignee]).find(Boolean),
      };

      // The sweeper's ROSTER phase is development, so the STAMP is the only thing
      // that can satisfy `detection` — and the second row is the only thing that
      // can still satisfy `development`.
      expect(ROSTER_PHASE[SWEEPER_ID]).toBe("development");
      expect(isWorkflowComplete(children, def, opts)).toBe(true);

      // Drop the synthesized removal row and enforce wedges: nothing is left in
      // `development`. This is amendment 1's wedge, and why commit 4's intake plans
      // two sweeper tickets rather than re-labelling one.
      const detectionOnly = children.filter((t) => t.ticketId !== SWEEP);
      expect(isWorkflowComplete(detectionOnly, def, opts)).toBe(false);
      // …and off/shadow, which strip `detection`, wedge on the mirror image: a
      // single row stamped `detection` satisfies neither list.
      const stripped = stripUnenforcedDetectionPhase({ ...SWEEP_DEF, __mode: "off" });
      expect(isWorkflowComplete(detectionOnly, stripped, opts)).toBe(false);
      expect(isWorkflowComplete(children, stripped, opts)).toBe(true);
    });

    it("holds the run open until the human merge gate is approved", async () => {
      await loadWith({ sweep: "enforce" });
      for (const id of [ANALYST, DETECT, SWEEP, REVIEW, QA, CI, SHIP]) await deliver(doneRecord(id));

      // Ship is done and the PR is merged on GitHub, but the blocking Merge
      // Approval gate is still open — no completion.
      expect(countOfType("workflow.complete")).toBe(0);
      expect(h.state.storeCompletions).toEqual([]);
      expect(detailsOfType("orchestrator.unblocked").map((d) => d.ticketId)).toEqual([
        SWEEP, REVIEW, QA, CI, SHIP, APPROVAL,
      ]);

      await deliver(doneRecord(APPROVAL));
      await deliver(doneRecord(CD));
      expect(countOfType("workflow.complete")).toBe(1);
    }, 20_000);
  });

  // ── (5) D1 stays where D1 was ──────────────────────────────────────────────
  it("VERDICT_GATE=enforce does not hold this chain — no gate persona says anything but PASS", async () => {
    const { deriveVerdict } = await import("./verdict-contract.mjs");
    await loadWith({ sweep: "enforce", verdict: "enforce" });
    await replay();

    // Three PASS verdicts, mapped off the personas' own prose by the shared ladder.
    const verdicts = Object.fromEntries(
      detailsOfType("agent.complete").filter((d) => d.verdict).map((d) => [d.ticketId, d.verdict]),
    );
    expect(verdicts).toEqual({ [REVIEW]: "PASS", [QA]: "PASS", [SHIP]: "PASS" });

    // The fourth, TEAM-3588, resolves NO verdict — and that is the ladder's rule 1,
    // not a bug this replay should paper over: the CI agent wrote "CI GATE: ✅ PASS",
    // which carries neither a `verdict:` label nor the release manager's round form,
    // and verdict-contract.mjs refuses to guess ("a wrong verdict is worse than no
    // verdict, because no verdict leaves today's behaviour in place"). So the gate
    // has nothing to hold on, which is exactly the pre-D1 cascade.
    expect(fixtureCompletion(CI).summary.startsWith("CI GATE: ✅ PASS")).toBe(true);
    expect(deriveVerdict(fixtureCompletion(CI).summary)).toBeNull();
    expect(verdicts[CI]).toBeUndefined();
    // So nothing was held, nothing was re-verified, and the run still completed.
    expect(detailsOfType("orchestrator.verdict_suppressed")).toEqual([]);
    expect(h.state.createdTickets).toEqual([]);
    expect(countOfType("workflow.complete")).toBe(1);
  }, 20_000);

  // ── (6) the card side of a productive sweep ────────────────────────────────
  it("the published outcome IS baseline-eligible — no-op exclusion does not catch it", async () => {
    await loadWith({ sweep: "enforce" });
    await replay();
    expect(countOfType("workflow.complete")).toBe(1);

    // cost-report constructs AWS clients at module load, but the constructors do no
    // I/O, so a plain import is safe here (same precedent as event-id.test.mjs).
    const { isBaselineEligible, shouldAlert, isNoOpOutcome } = await import("../cost-report/index.mjs");
    const outcome = "complete";   // the phase this run's completion claims

    expect(isNoOpOutcome({ outcome })).toBe(false);
    expect(isBaselineEligible({ outcome, cost: { total: 12.4 } })).toBe(true);
    expect(shouldAlert({ run: { outcome } })).toBe(true);
    // Non-vacuous: the SAME shapes with c2uqki's outcome are excluded.
    expect(isBaselineEligible({ outcome: "nothing-to-remove", cost: { total: 12.4 } })).toBe(false);
    expect(shouldAlert({ run: { outcome: "nothing-to-remove" } })).toBe(false);
  }, 20_000);
});
