import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * TEAM-4247 D2 ACCEPTANCE REPLAY — wf_1788780725940_c2uqki, epic TEAM-4228.
 *
 * A dead-code sweep of tycenjmccann/ember that found NOTHING to remove, and then
 * ran the entire delivery pipeline anyway.
 *
 * ══ WHAT ACTUALLY HAPPENED (every value below is in the fixture) ══════════════
 * | when (UTC) | what the dossier records                                       |
 * |------------|----------------------------------------------------------------|
 * | 11:42:10   | TEAM-4229 (requirements_analyst) done — "handoff: PR for the    |
 * |            | owning team (CD_REGISTERED: false)"                            |
 * | 12:12:24   | TEAM-4230 (code_sweeper) done — "OUTCOME: ZERO verified-dead    |
 * |            | removals (valid terminal state per R7). PR #58 opened and left  |
 * |            | OPEN" … and the cascade unblocked TEAM-4231 anyway              |
 * | 12:30:13   | ticket.created TEAM-4241 "Fix (review): REMOVAL_LEDGER.md — 3   |
 * |            | findings", filed by the reviewer BEFORE it closed its own task  |
 * | 12:30:58   | TEAM-4231 (code_reviewer) done — "VERDICT: CHANGES NEEDED       |
 * |            | (ledger-accuracy findings only; ZERO …)" → QA unblocked         |
 * | 12:44:26   | TEAM-4241 done                                                 |
 * | 12:53:27   | ticket.created TEAM-4242 "Fix (QA): REMOVAL_LEDGER.md:205 …"    |
 * | 12:55:09   | TEAM-4232 (qa_verifier) done — "Verdict: FAIL (ledger-accuracy  |
 * |            | only → fix ticket TEAM-4242)" → CI unblocked                    |
 * | 13:01:12   | TEAM-4242 done                                                 |
 * | 13:17:38   | TEAM-4233 (ci_agent) done — "CI VERDICT: PASS"                  |
 * | 13:17:42   | workflow.complete, delivery mode "handoff", PR #60 — a run that |
 * |            | deleted not one line reported as a completed delivery, and its  |
 * |            | zero-task cost card went into the sweep def's baselines         |
 *
 * Four gate personas, two fix tickets and a unified PR were spent verifying a diff
 * whose only content was a candidate ledger. That is hole D2 closes: the run had no
 * terminal outcome for "nothing to remove", so it borrowed `complete`.
 *
 * ══ WHICH LAYER THIS EXERCISES ═══════════════════════════════════════════════
 * The REAL orchestrator: `handler` over DynamoDB-stream records → processRecord →
 * handleTicketDone → the real cascade.mjs, the real completion.mjs gate, the real
 * observeSweepDetection / closeWorkflowNothingToRemove, the real dispatch path
 * (buildAgentContext → invokeAgent). Only the AWS seams are mocked. Nothing here
 * re-implements a D2 decision; every assertion reads what those modules published.
 *
 * ══ SYNTHESIZED, AND WHY ═════════════════════════════════════════════════════
 *  1. TICKET_PROVIDER is left UNSET (→ "dynamodb"), so `handler` takes the stream
 *     branch. c2uqki was really a jira-mode run whose cascade came through
 *     handleTicketDoneUnified; the two done twins are pinned byte-identical in
 *     done-handlers-cascade.test.mjs, and the twin is driven directly once here
 *     (see "one close, whichever twin delivers it").
 *  2. THE DETECTION STAMP. Commit 4 splits the sweep into a `detection` phase and a
 *     `development` sweep phase; c2uqki predates it, so its rows carry no `phase` at
 *     all. TEAM-4230 — the ticket that reported the yield — is re-stamped
 *     `phase: "detection"`, and TEAM-4231 keeps the fixture's own
 *     `blockedBy: [TEAM-4230]` edge. A SECOND (development) sweep ticket is
 *     deliberately NOT synthesized: under `enforce` the run ends AT the detection
 *     ticket, so a successor sweep row would never be reached, and adding one would
 *     move the `off` baseline away from the shape the dossier actually recorded.
 *  3. THE YIELD NUMBER. TEAM-4230's fixture record has no `verified_removable` and
 *     no `candidates` — that absence IS the hole: its prose already says "OUTCOME:
 *     ZERO verified-dead removals", and prose is not something the orchestrator may
 *     act on. The replay seeds the record the way commit 1's report_completion now
 *     writes it: `verified_removable: 0`, `candidates: 93` (the ledger's own count,
 *     from the same summary). Every other field is the fixture's.
 *  4. THE LABELLED PR IS #58, NOT #60. `closeWorkflowNothingToRemove` labels the PR
 *     the detection record names, and TEAM-4230's record names PR #58. PR #60 is the
 *     unified handoff PR `completeWorkflow` opened at 13:17 — it exists only because
 *     the run went the whole way, which is precisely what a no-op close precedes.
 *  5. NO config/cd-registry.json IS SERVED, so cd-registry.mjs reads an empty
 *     registry and this repo is a HANDOFF — which is what c2uqki was
 *     (`delivery.mode: "handoff"`, no Ship/Merge/CD tickets on the board). The ship
 *     phase and its Merge Approval gate are therefore stripped from the effective
 *     def, exactly as they were in production.
 *  6. The two fix tickets' `spawnedBy`. The dossier's ticket projection has no
 *     `spawnedBy` key at all (jira-mode keeps the kind in a label), so each marker is
 *     synthesized from the row's own title — "Fix (review): …" → `review_fix` with
 *     KIND_TO_ORIGIN_KEY's `gateTicketId` → its filer TEAM-4231, "Fix (QA): …" →
 *     `qa_fix` / `qaTicketId` → TEAM-4232.
 */

const h = vi.hoisted(() => ({
  state: {
    /** The live board, ticketId → row. Mutated by the real handlers' writes. */
    board: /** @type {Map<string, any>} */ (new Map()),
    /** The live workflow row (agentTasks mutate in place, as in production). */
    workflow: /** @type {any} */ (null),
    /** completions/<ticketId>.json, by ticketId. */
    completions: /** @type {Record<string, any>} */ ({}),
    /** Every EventBridge entry, in publish order. */
    ebEvents: /** @type {any[]} */ ([]),
    /** Every S3 GetObject key, in order — how "off reads nothing extra" is proven. */
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
    /** Every outbound GitHub call (the sweep:no-op label rides on one). */
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
   * `preserveStatusIf` status guard), because FIX_BEFORE_VERIFY's whole idempotency
   * story rides on those conditions failing rather than on the caller remembering
   * what it already wrote.
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
      // Agent dispatch: the rendered context travels as `prompt`, which is where the
      // FR-D2.6 yield note has to land for a persona to ever read it.
      if (String(cmd.input?.FunctionName || "").includes("agent-invoker")) {
        h.state.invokes.push(payload || {});
        return {};
      }
      if (tool.startsWith("Tickets___create_ticket")) {
        const params = payload.parameters || {};
        h.state.nextTicketNum += 1;
        const key = `TEAM-43${String(h.state.nextTicketNum).padStart(2, "0")}`;
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
      // The two config objects the deploy syncs to the artifact bucket. Without
      // config/workflows.json the orchestrator falls back to FALLBACK_WORKFLOW_DEF,
      // which has NO detection phase — isSweepDetectionTicket's def fallback could
      // never match and every D2 assertion here would go vacuous. agents.json is
      // what makes the sweep def's personas dispatchable, so "enforce dispatched
      // nobody" is a fact about the gate and not about an empty roster.
      // config/cd-registry.json is deliberately NOT served: see SYNTHESIZED note 5.
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
 * PARTIAL mock (importOriginal): every pure helper stays the real one — notably
 * `completionBlockedKey`, so the CAS key and escalation ids are production's. Only
 * the seams that talk to DynamoDB are replaced, each with the real tri-state.
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
    // a dispatch into a later phase (the QA verifier here) goes through it, and the
    // real function needs the store's own DynamoDB client, which initWorkflowStore
    // above no longer creates.
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
    // The real CAS: the FIRST terminal claim wins and every later one loses, which
    // is what makes twin delivery / redelivery a one-close story rather than a
    // "the caller remembered" story.
    claimTerminalOutcome: vi.fn(async (workflowId, outcome, completedAt, reason) => {
      h.state.terminalClaims.push({ workflowId, outcome, completedAt, reason });
      if (h.state.terminalOutcome) return false;
      h.state.terminalOutcome = outcome;
      return true;
    }),
    setDelivery: vi.fn(async () => {}),
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
    fileURLToPath(new URL("../../deploy/workflow-manager/toolkit/fixtures/c2uqki-dossier.json", import.meta.url)),
    "utf8",
  ),
);

/** The repo's own copies of the two config objects the deploy syncs to the artifact
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

/** Fixture rows by id — these throw if the vendored dossier moves under us. */
function fixtureTicket(ticketId) {
  const row = DOSSIER.tickets.find((t) => t.ticketId === ticketId);
  if (!row) throw new Error(`c2uqki fixture has no ticket ${ticketId}`);
  return row;
}
function fixtureCompletion(ticketId) {
  const rec = DOSSIER.completions?.[ticketId];
  if (!rec) throw new Error(`c2uqki fixture has no completion record for ${ticketId}`);
  return rec;
}

const WF_ID = "wf_1788780725940_c2uqki";
const EPIC = "TEAM-4228";
const ANALYST = "TEAM-4229";  // requirements_analyst — intake
const DETECT = "TEAM-4230";   // code_sweeper — ZERO verified-dead removals, PR #58
const REVIEW = "TEAM-4231";   // code_reviewer — CHANGES NEEDED (ledger accuracy)
const QA = "TEAM-4232";       // qa_verifier — FAIL (ledger accuracy) → TEAM-4242
const CI = "TEAM-4233";       // ci_agent — PASS
const REVIEW_FIX = "TEAM-4241";
const QA_FIX = "TEAM-4242";
const CHAIN = [ANALYST, DETECT, REVIEW, QA, CI];
const FIXES = [REVIEW_FIX, QA_FIX];

const SWEEPER_ID = "agentcore_hub_code_sweeper";
const REVIEWER_ID = "agentcore_hub_code_reviewer";
const QA_ID = "agentcore_hub_qa_verifier";
const CI_ID = "agentcore_hub_ci_agent";

/** The PR the detection record names — the one a no-op close labels (note 4). */
const DETECT_PR = fixtureCompletion(DETECT).pr_url;      // …/ember/pull/58
/** The unified handoff PR completeWorkflow opened at 13:17, after the fact. */
const UNIFIED_PR = DOSSIER.workflow.delivery.prUrl;      // …/ember/pull/60

/** The candidate count the sweeper's own summary reports (note 3). */
const CANDIDATES = 93;

// ─── Board / workflow / records, built from the fixture ──────────────────────

/** The fix markers each row's own title implies (see SYNTHESIZED note 6). */
const FIX_SPAWNED_BY = {
  [REVIEW_FIX]: { kind: "review_fix", gateTicketId: REVIEW, phase: "development" },
  [QA_FIX]: { kind: "qa_fix", qaTicketId: QA, phase: "development" },
};

/**
 * The board as it read at 11:42Z: the intake ticket and the sweeper in flight, the
 * three gates blocked behind them in the fixture's own chain, neither fix filed yet.
 * TEAM-4230 carries the detection stamp commit 4 introduced (note 2).
 */
function buildBoard() {
  const board = new Map();
  for (const t of DOSSIER.tickets) {
    const row = JSON.parse(JSON.stringify(t));
    row.blockedBy = Array.isArray(row.blockedBy) ? row.blockedBy : [];
    if (FIXES.includes(row.ticketId)) continue; // filed mid-run, INSERTed by the replay
    if (CHAIN.includes(row.ticketId)) {
      row.status = row.ticketId === ANALYST || row.ticketId === DETECT ? "in_progress" : "blocked";
      delete row.completedAt;
    }
    if (row.ticketId === DETECT) row.phase = "detection";
    board.set(row.ticketId, row);
  }
  return board;
}

/**
 * The workflow row, verbatim from the fixture apart from `phase` (the fixture's is
 * the post-hoc "complete"), the delivery (recorded at 13:17, after everything this
 * replay decides) and the agentTasks of the replayed tickets, which are rewound so
 * the real harvest fills them from the records.
 */
function buildWorkflow() {
  const wf = JSON.parse(JSON.stringify(DOSSIER.workflow));
  wf.id = WF_ID;
  wf.workflowId = WF_ID;
  wf.epicId = EPIC;
  wf.phase = "detection";
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
    // with it already there would make the FR-D2.6 note self-fulfilling.
    delete entry.verifiedRemovable;
    delete entry.candidates;
  }
  for (const id of FIXES) delete wf.agentTasks?.[id];
  return wf;
}

/**
 * The completion records as the personas would write them after commit 1. Every
 * value is the fixture's own except TEAM-4230's `verified_removable`/`candidates`,
 * the two fields the run never had (note 3).
 */
function buildCompletions() {
  const out = {};
  for (const [ticketId, rec] of Object.entries(DOSSIER.completions || {})) {
    out[ticketId] = JSON.parse(JSON.stringify(rec));
  }
  out[DETECT].verified_removable = 0;
  out[DETECT].candidates = CANDIDATES;
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

/** The INSERT record create_ticket emitted for a fix ticket, mid-run. */
function insertFixRecord(ticketId) {
  const row = {
    ...JSON.parse(JSON.stringify(fixtureTicket(ticketId))),
    status: (fixtureTicket(ticketId).blockedBy || []).length ? "blocked" : "todo",
    spawnedBy: FIX_SPAWNED_BY[ticketId],
  };
  row.blockedBy = Array.isArray(row.blockedBy) ? row.blockedBy : [];
  delete row.completedAt;
  h.state.board.set(ticketId, row);
  return { eventName: "INSERT", eventSource: "aws:dynamodb", dynamodb: { NewImage: toImage(row) } };
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
 * The three cascade/completion event types the `off` baseline compares, in order.
 * Dispatch events (agent.invoked / orchestrator.agent_invoked / agent.started) are
 * excluded: they ride on the `ready` records the baseline replay does not deliver,
 * so they are the harness's shape, not the cascade's decision.
 */
const CASCADE_TYPES = new Set(["orchestrator.unblocked", "agent.complete", "workflow.complete"]);
const cascadeShape = () =>
  allEvents()
    .filter((e) => CASCADE_TYPES.has(e.type))
    .map((e) => ({
      type: e.type,
      ticketId: e.detail.ticketId ?? null,
      unblocked: e.type === "agent.complete" ? (e.detail.unblocked ?? null) : undefined,
      unblockedBy: e.type === "orchestrator.unblocked" ? (e.detail.unblockedBy ?? null) : undefined,
    }));

/**
 * The SAME shape, read out of the fixture's OWN event stream — the pre-D2 baseline
 * the `off` mode must reproduce. Only the replayed window is kept.
 */
function fixtureCascadeShape() {
  const replayed = new Set([...CHAIN, ...FIXES]);
  const out = [];
  for (const e of DOSSIER.events || []) {
    const ticketId = e.detail?.ticketId ?? e.ticketId ?? null;
    if (e.type === "orchestrator.unblocked") {
      if (!replayed.has(e.detail?.unblockedBy)) continue;
      out.push({ type: e.type, ticketId, unblocked: undefined, unblockedBy: e.detail.unblockedBy });
    } else if (e.type === "agent.complete") {
      if (!replayed.has(ticketId)) continue;
      out.push({ type: e.type, ticketId, unblocked: e.detail?.unblocked ?? null, unblockedBy: undefined });
    } else if (e.type === "workflow.complete") {
      out.push({ type: e.type, ticketId, unblocked: undefined, unblockedBy: undefined });
    }
  }
  return out;
}

/** Everything a dispatch leaves behind, by persona. */
const dispatchedTo = (agentId) => h.state.invokes.filter((p) => p.agentId === agentId);
const promptFor = (agentId) => (dispatchedTo(agentId)[0]?.prompt || "");
/** The statuses that make a ticket runnable — the write every dispatch is triggered off. */
const RUNNABLE = new Set(["todo", "ready", "in_progress"]);
const madeRunnable = () => h.state.statusWrites.filter((w) => RUNNABLE.has(w.status));

// ─── The driver ──────────────────────────────────────────────────────────────

let handler;
let handleTicketDoneUnified;
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
  ({ handler, handleTicketDoneUnified, stripUnenforcedDetectionPhase } = await import("./index.mjs"));
  // Warm the module exactly as production does: the roster, the workflow defs and
  // the CD registry are loaded by `handler`, not by the twins.
  await handler({ Records: [] });
  h.state.s3Gets.length = 0;
}

/** One stream delivery, through the real handler. */
const deliver = (record) => handler({ Records: [record] });

/**
 * The run, in the order the fixture records it: intake, the sweeper's zero-yield
 * report, and then the whole gate chain with its two fix tickets — each ticket's
 * cascade deciding whether the next may start.
 */
async function replay() {
  await deliver(doneRecord(ANALYST));
  await deliver(doneRecord(DETECT));
  await deliver(insertFixRecord(REVIEW_FIX));
  await deliver(doneRecord(REVIEW));
  await deliver(doneRecord(REVIEW_FIX));
  await deliver(insertFixRecord(QA_FIX));
  await deliver(doneRecord(QA));
  await deliver(doneRecord(QA_FIX));
  await deliver(doneRecord(CI));
}

// The dispatch path resolves each persona's runtime from the env, and a missing ARN
// publishes agent.error instead of invoking — which would make every "what the
// persona was told" assertion below vacuous.
const RUNTIME = (name) => `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${name}`;
process.env.RUNTIME_ARN_AGENTCORE_HUB_CODE_SWEEPER = RUNTIME("code-sweeper");
process.env.RUNTIME_ARN_AGENTCORE_HUB_CODE_REVIEWER = RUNTIME("code-reviewer");
process.env.RUNTIME_ARN_AGENTCORE_HUB_QA_VERIFIER = RUNTIME("qa-verifier");
process.env.RUNTIME_ARN_AGENTCORE_HUB_CI_AGENT = RUNTIME("ci-agent");

describe("c2uqki replay — the fixture still says what this replay claims", () => {
  it("records a sweep that removed nothing, in prose only", () => {
    expect(DOSSIER.workflow.workflowDefId).toBe("dead-code-sweep");
    expect(DOSSIER.workflow.delivery.mode).toBe("handoff");

    // Hole D2: the yield existed only as a sentence, so nothing could act on it.
    const rec = fixtureCompletion(DETECT);
    expect(rec.verified_removable).toBeUndefined();
    expect(rec.candidates).toBeUndefined();
    expect(rec.summary).toContain("ZERO verified-dead removals");
    expect(rec.summary).toContain("left OPEN");
    expect(DOSSIER.tickets.every((t) => t.phase === undefined)).toBe(true);

    // The two PRs of note 4 are different objects.
    expect(DETECT_PR).toMatch(/\/tycenjmccann\/ember\/pull\/58$/);
    expect(UNIFIED_PR).toMatch(/\/tycenjmccann\/ember\/pull\/60$/);
  });

  it("spent four personas and two fix tickets on it, then reported a completed delivery", () => {
    const shape = fixtureCascadeShape();
    expect(shape.filter((s) => s.type === "orchestrator.unblocked").map((s) => s.ticketId))
      .toEqual([REVIEW, QA, CI]);
    expect(shape.filter((s) => s.type === "workflow.complete")).toHaveLength(1);
    expect(fixtureTicket(REVIEW).assignee).toBe(REVIEWER_ID);
    expect(fixtureTicket(QA).assignee).toBe(QA_ID);
    expect(fixtureTicket(CI).assignee).toBe(CI_ID);
    // …and its zero-task cost card went into the sweep def's baselines.
    expect((DOSSIER.events || []).filter((e) => e.type === "workflow.performance")).toHaveLength(1);
  });
});

describe("c2uqki replay — SWEEP_DETECTION_PHASE", () => {
  beforeEach(() => {
    h.state.board = buildBoard();
    h.state.workflow = buildWorkflow();
    h.state.completions = buildCompletions();
    h.state.ebEvents.length = 0;
    h.state.s3Gets.length = 0;
    h.state.createdTickets.length = 0;
    h.state.invokes.length = 0;
    h.state.blockerWrites.length = 0;
    h.state.statusWrites.length = 0;
    h.state.terminalClaims.length = 0;
    h.state.terminalOutcome = null;
    h.state.storeCompletions.length = 0;
    h.state.finalized.length = 0;
    h.state.notifications.length = 0;
    h.state.githubCalls.length = 0;
    h.state.blockedKeys.clear();
    h.state.reverifySlots.clear();
    h.state.nextTicketNum = 0;
    process.env.ARTIFACT_BUCKET = "test-artifacts";
    process.env.EVENT_BUS = "test-bus";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (url, init) => {
      h.state.githubCalls.push({ url: String(url), method: init?.method, body: init?.body });
      return { ok: true, status: 200, text: async () => "[]" };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.SWEEP_DETECTION_PHASE;
    delete process.env.VERDICT_GATE;
    delete process.env.FIX_BEFORE_VERIFY;
    delete process.env.VERIFIED_HEAD_COMPLETION;
    delete process.env.ARTIFACT_BUCKET;
    delete process.env.EVENT_BUS;
    delete process.env.GITHUB_PAT;
  });

  // ── (1) enforce ────────────────────────────────────────────────────────────
  describe("enforce — the orchestrator ends the run at the detection ticket", () => {
    /** The window that decided everything: intake, then the zero-yield report. */
    async function replayToDetection() {
      await deliver(doneRecord(ANALYST));
      await deliver(doneRecord(DETECT));
    }

    it("closes the run as nothing-to-remove, carrying the yield on the event", async () => {
      process.env.GITHUB_PAT = "ghp_test";
      await loadWith({ sweep: "enforce" });
      await replayToDetection();

      // The terminal claim, with the honest outcome — not "complete".
      expect(h.state.terminalClaims).toHaveLength(1);
      expect(h.state.terminalClaims[0]).toMatchObject({ workflowId: WF_ID, outcome: "nothing-to-remove" });
      expect(h.state.terminalClaims[0].reason).toMatch(/zero removals/i);
      expect(h.state.finalized).toEqual([WF_ID]);

      // Exactly one run-closing event, carrying the yield so no consumer has to
      // re-read S3 to know why the run ended.
      const closed = detailsOfType("workflow.nothing_to_remove");
      expect(closed).toHaveLength(1);
      expect(closed[0]).toMatchObject({
        workflowId: WF_ID,
        outcome: "nothing-to-remove",
        verifiedRemovable: 0,
        candidates: CANDIDATES,
        ticketId: DETECT,
        featureBranch: DOSSIER.workflow.featureBranch,
      });
      // The PR the DETECTION record names (note 4) — the unified #60 does not exist
      // on this path, because completeWorkflow is never reached.
      expect(closed[0].prUrl).toBe(DETECT_PR);
      expect(closed[0].prUrl).not.toBe(UNIFIED_PR);

      // NOT a completion. This is the assertion the whole gate exists for.
      expect(countOfType("workflow.complete")).toBe(0);
      expect(h.state.storeCompletions).toEqual([]);

      // The ticket still finished, and in the right order — the UI's own signal.
      const complete = detailsOfType("agent.complete");
      expect(complete.map((d) => d.ticketId)).toEqual([ANALYST, DETECT]);
      expect(indexOfType("agent.complete")).toBeLessThan(indexOfType("workflow.nothing_to_remove"));
    });

    it("labels the sweep PR sweep:no-op", async () => {
      process.env.GITHUB_PAT = "ghp_test";
      await loadWith({ sweep: "enforce" });
      await replayToDetection();

      const labelCalls = h.state.githubCalls.filter((c) => /\/issues\/\d+\/labels$/.test(c.url));
      expect(labelCalls).toHaveLength(1);
      expect(labelCalls[0].url).toContain("/repos/tycenjmccann/ember/issues/58/labels");
      expect(labelCalls[0].method).toBe("POST");
      expect(JSON.parse(labelCalls[0].body)).toEqual({ labels: ["sweep:no-op"] });
    });

    it("dispatches NOBODY — no reviewer, no QA verifier, no CI agent", async () => {
      await loadWith({ sweep: "enforce" });
      await replayToDetection();

      // The cascade never ran, so nothing was unblocked…
      expect(countOfType("orchestrator.unblocked")).toBe(0);
      expect(allEvents().filter((e) => e.detail?.unblockedBy)).toEqual([]);
      // …no successor was made runnable (the write a dispatch is triggered off)…
      expect(madeRunnable().filter((w) => [REVIEW, QA, CI].includes(w.ticketId))).toEqual([]);
      // …and nothing was invoked on this hop either, by any of the three names a
      // dispatch would leave behind.
      for (const agentId of [REVIEWER_ID, QA_ID, CI_ID]) {
        expect(dispatchedTo(agentId), agentId).toEqual([]);
        expect(detailsOfType("orchestrator.agent_invoked").filter((d) => d.agentId === agentId), agentId).toEqual([]);
        expect(detailsOfType("agent.invoked").filter((d) => d.agentId === agentId), agentId).toEqual([]);
      }
      expect(detailsOfType("orchestrator.unblocked").map((d) => d.ticketId)).toEqual([]);
    });

    it("refuses a late ready/todo delivery for the reviewer once the run is closed", async () => {
      await loadWith({ sweep: "enforce" });
      await replayToDetection();
      expect(h.state.finalized).toEqual([WF_ID]);

      for (const status of ["ready", "todo"]) {
        h.state.ebEvents.length = 0;
        h.state.invokes.length = 0;
        h.state.statusWrites.length = 0;

        await deliver(readyRecord(REVIEW, status));

        expect(dispatchedTo(REVIEWER_ID), status).toEqual([]);
        expect(countOfType("orchestrator.agent_invoked"), status).toBe(0);
        expect(h.state.statusWrites.filter((w) => w.status === "in_progress"), status).toEqual([]);
      }
    });

    it("one close, whichever twin delivers it (redelivery + the webhook twin)", async () => {
      await loadWith({ sweep: "enforce" });
      await deliver(doneRecord(ANALYST));

      const record = doneRecord(DETECT);
      await deliver(record);
      await deliver(record);              // the stream's own at-least-once redelivery
      await handleTicketDoneUnified(DETECT); // the jira-mode twin, on the same board

      // The redelivery reached the CAS and LOST there — not because the caller
      // remembered what it had already written. (The webhook twin never gets that
      // far: its own markTaskComplete idempotency guard sees the task entry already
      // done and skips the whole tail, cascade included, which is why there are two
      // claims for three deliveries and not three.)
      expect(h.state.terminalClaims).toHaveLength(2);
      expect(h.state.terminalClaims.every((c) => c.outcome === "nothing-to-remove")).toBe(true);
      expect(countOfType("workflow.nothing_to_remove")).toBe(1);
      expect(h.state.finalized).toEqual([WF_ID]);
      expect(countOfType("workflow.complete")).toBe(0);
      expect(dispatchedTo(REVIEWER_ID)).toEqual([]);
    });
  });

  // ── (2) shadow ─────────────────────────────────────────────────────────────
  describe("shadow (the default) — observed, and the run goes on", () => {
    it("publishes sweep.detection_observed once and still cascades", async () => {
      await loadWith({ sweep: undefined });   // unset → shadow
      await replay();

      const observed = detailsOfType("sweep.detection_observed");
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        workflowId: WF_ID,
        ticketId: DETECT,
        verifiedRemovable: 0,
        candidates: CANDIDATES,
        wouldClose: true,
      });

      // Nothing was claimed and nothing was labelled — shadow only watches.
      expect(h.state.terminalClaims.filter((c) => c.outcome === "nothing-to-remove")).toEqual([]);
      expect(h.state.githubCalls.filter((c) => /\/labels$/.test(c.url))).toEqual([]);

      // …and the chain the fixture recorded still happened: the reviewer was
      // released by the detection ticket, exactly as it was in production.
      expect(detailsOfType("orchestrator.unblocked").map((d) => d.ticketId)).toEqual([REVIEW, QA, CI]);
      expect(detailsOfType("orchestrator.unblocked")[0].unblockedBy).toBe(DETECT);
      expect(countOfType("workflow.complete")).toBe(1);
    });

    /**
     * FR-D2.6 — the gates are told the yield, in the prompt they are actually
     * dispatched with. Dispatch is level-triggered: the cascade sets the successor
     * runnable, and the resulting stream record is the hop that invokes it. So the
     * unblocks and the ready records are interleaved the way the stream delivers them.
     */
    async function replayWithDispatches() {
      await deliver(doneRecord(ANALYST));
      await deliver(doneRecord(DETECT));
      await deliver(readyRecord(REVIEW));
      await deliver(doneRecord(REVIEW));
      await deliver(readyRecord(QA));
      await deliver(doneRecord(QA));
      await deliver(readyRecord(CI));
    }

    const LEDGER_ONLY = "ledger-accuracy QA only (no fresh-clone build + runtime smoke); CI builds once.";
    const RETAINED = "ledger re-verification is retained in full";

    it("tells the QA verifier and the CI agent the diff is deletion-free, and the reviewer the opposite", async () => {
      await loadWith({ sweep: undefined });
      await replayWithDispatches();

      // Non-vacuity: commit 1's harvest is what put the yield on the task entry.
      expect(h.state.workflow.agentTasks[DETECT]).toMatchObject({ verifiedRemovable: 0, candidates: CANDIDATES });

      for (const agentId of [QA_ID, CI_ID]) {
        const prompt = promptFor(agentId);
        expect(dispatchedTo(agentId), agentId).toHaveLength(1);
        expect(prompt, agentId).toContain("## Sweep Yield");
        expect(prompt, agentId).toContain(`Detection: ${CANDIDATES} candidates, 0 verified removable`);
        expect(prompt, agentId).toContain(LEDGER_ONLY);
        expect(prompt, agentId).not.toContain(RETAINED);
      }

      // The reviewer's line says the opposite on purpose: blueprints/code-reviewer.md
      // is untouched by D2 and its removal-ledger re-verification is retained.
      const reviewerPrompt = promptFor(REVIEWER_ID);
      expect(reviewerPrompt).toContain("## Sweep Yield");
      expect(reviewerPrompt).toContain(RETAINED);
      expect(reviewerPrompt).not.toContain("no fresh-clone build");
    });

    it("dispatches exactly one CI ticket", async () => {
      await loadWith({ sweep: undefined });
      await replayWithDispatches();

      expect(dispatchedTo(CI_ID)).toHaveLength(1);
      expect(dispatchedTo(CI_ID)[0].ticketId).toBe(CI);
      expect(detailsOfType("orchestrator.agent_invoked").filter((d) => d.agentId === CI_ID)).toHaveLength(1);
    });
  });

  // ── (3) off ────────────────────────────────────────────────────────────────
  describe("off — byte-identical to the run the dossier recorded", () => {
    it("reproduces the fixture's own cascade shape, paying nothing", async () => {
      await loadWith({ sweep: "off" });
      await replay();

      // The pre-D2 baseline, straight out of the dossier: the reviewer, QA and CI
      // each released in turn, every agent.complete carrying the same `unblocked`
      // array, one workflow.complete.
      expect(cascadeShape()).toEqual(fixtureCascadeShape());

      // Not one D2 event, and not one D2 side effect.
      expect(allEvents().filter((e) => /^sweep\./.test(e.type) || e.type === "workflow.nothing_to_remove")).toEqual([]);
      expect(h.state.terminalClaims.filter((c) => c.outcome === "nothing-to-remove")).toEqual([]);
      expect(h.state.githubCalls.filter((c) => /\/labels$/.test(c.url))).toEqual([]);
      expect(h.state.createdTickets).toEqual([]);
      expect(h.state.blockerWrites).toEqual([]);
    });

    it("does not read the detection record beyond the harvest's own read", async () => {
      await loadWith({ sweep: "off" });
      await replay();
      const offReads = h.state.s3Gets.filter((k) => k === `completions/${DETECT}.json`).length;

      // `off` returns before readCompletionRecord — so the read count is the
      // harvest's alone, and identical to what shadow (which DOES look) spends,
      // because readCompletionRecord memoizes per Lambda container.
      expect(offReads).toBe(1);
    });
  });

  // ── (4) detection is a real ticket phase ───────────────────────────────────
  describe("detection is a valid ticket phase", () => {
    it("the repo's own def declares it as an agent phase", () => {
      const def = SWEEP_DEF;
      const detection = def.phases.find((p) => p.agentPhase === "detection");
      expect(detection).toMatchObject({ id: "detection", type: "agent", agentPhase: "detection" });
      // Its agent is what isSweepDetectionTicket falls back to when intake forgot
      // the stamp — the c2uqki sweeper.
      expect(detection.agentId).toBe(SWEEPER_ID);
      expect(def.completionRequiresAgentPhases).toContain("detection");
    });

    it("only enforce requires it — off and shadow strip it out of the completion gate", async () => {
      for (const mode of ["off", undefined, "enforce"]) {
        await loadWith({ sweep: mode });
        const required = stripUnenforcedDetectionPhase(SWEEP_DEF).completionRequiresAgentPhases;
        if (mode === "enforce") expect(required, String(mode)).toContain("detection");
        else expect(required, String(mode)).not.toContain("detection");
        // The phase itself is never removed: the def still HAS a detection phase, so
        // the stamp fallback and the intake plan keep working in every mode.
        expect(stripUnenforcedDetectionPhase(SWEEP_DEF).phases.some((p) => p.agentPhase === "detection")).toBe(true);
      }
    });

    it("the completion gate accepts a stamped detection ticket, over its assignee's roster phase", async () => {
      const { isWorkflowComplete } = await import("./completion.mjs");
      const roster = JSON.parse(
        readFileSync(fileURLToPath(new URL("../../src/config/agents.json", import.meta.url)), "utf8"),
      ).agents;
      const getAgentPhase = (assignee) => roster.find((a) => a.agentId === assignee)?.phase;
      // The sweeper's ROSTER phase is development — the stamp is the only thing that
      // can make its ticket satisfy `detection`.
      expect(getAgentPhase(SWEEPER_ID)).toBe("development");

      const def = { completionRequiresAgentPhases: ["detection"], reviewGates: [] };
      const stamped = [{ ticketId: DETECT, assignee: SWEEPER_ID, phase: "detection", status: "done" }];
      expect(isWorkflowComplete(stamped, def, { getAgentPhase })).toBe(true);
      // Unstamped, the same row lands in `development` and the phase is unsatisfied.
      const unstamped = [{ ticketId: DETECT, assignee: SWEEPER_ID, status: "done" }];
      expect(isWorkflowComplete(unstamped, def, { getAgentPhase })).toBe(false);
      // And an open stamped ticket does not satisfy it either.
      const open = [{ ticketId: DETECT, assignee: SWEEPER_ID, phase: "detection", status: "in_progress" }];
      expect(isWorkflowComplete(open, def, { getAgentPhase })).toBe(false);
    });
  });

  // ── (5) FR-D1.7 — a fix filed mid-run blocks the open verifiers ────────────
  describe("FIX_BEFORE_VERIFY=enforce — no verifier runs against unfixed code", () => {
    it("QA does not start until TEAM-4241 completes, and CI not until TEAM-4242 does", async () => {
      await loadWith({ sweep: "off", fixBefore: "enforce" });
      await deliver(doneRecord(ANALYST));
      await deliver(doneRecord(DETECT));

      // 12:30:13 — the reviewer files its fix while QA and CI are still open.
      await deliver(insertFixRecord(REVIEW_FIX));
      const afterReviewFix = h.state.blockerWrites.filter((w) => w.ids.includes(REVIEW_FIX));
      expect(afterReviewFix.map((w) => w.ticketId).sort()).toEqual([QA, CI].sort());
      expect(h.state.board.get(QA).blockedBy).toContain(REVIEW_FIX);

      await deliver(doneRecord(REVIEW));
      await deliver(doneRecord(REVIEW_FIX));

      // 12:53:27 — QA files its own fix, 1m42s before closing its own ticket, so
      // BOTH open verifiers are held: CI has not run yet, and QA's own re-verify
      // round must not start against the unfixed ledger either.
      await deliver(insertFixRecord(QA_FIX));
      expect(h.state.blockerWrites.filter((w) => w.ids.includes(QA_FIX)).map((w) => w.ticketId).sort())
        .toEqual([QA, CI].sort());
      expect(h.state.board.get(CI).blockedBy).toContain(QA_FIX);
    });
  });

  // ── FR-D2.8 — the card side of the same outcome ────────────────────────────
  /**
   * There is no workflow.performance event in this replay: the card is written by the
   * cost-report Lambda, which is not in this harness. So the assertion is made against
   * the predicate the card side actually uses, fed the outcome the orchestrator just
   * published — the wire value, not a literal typed twice.
   */
  it("the published outcome is not baseline-eligible and raises no performance alert", async () => {
    process.env.GITHUB_PAT = "ghp_test";
    await loadWith({ sweep: "enforce" });
    await deliver(doneRecord(ANALYST));
    await deliver(doneRecord(DETECT));
    const outcome = detailsOfType("workflow.nothing_to_remove")[0].outcome;

    // cost-report constructs AWS clients at module load, but the constructors do no
    // I/O, so a plain import is safe here (same precedent as event-id.test.mjs).
    const { isBaselineEligible, shouldAlert, isNoOpOutcome } = await import("../cost-report/index.mjs");

    expect(isNoOpOutcome({ outcome })).toBe(true);
    expect(isBaselineEligible({ outcome, cost: { total: 4.12 } })).toBe(false);
    expect(shouldAlert({ run: { outcome } })).toBe(false);

    // Non-vacuous: the SAME shapes with the outcome this run used to borrow are
    // both eligible and alertable.
    expect(isBaselineEligible({ outcome: "complete", cost: { total: 4.12 } })).toBe(true);
    expect(shouldAlert({ run: { outcome: "complete" } })).toBe(true);
  });
});
