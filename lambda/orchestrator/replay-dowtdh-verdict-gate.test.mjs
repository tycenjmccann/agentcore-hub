import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * TEAM-4246 D1 ACCEPTANCE REPLAY — wf_1788731227559_dowtdh, epic TEAM-4162.
 *
 * ══ WHAT ACTUALLY HAPPENED (every value below is in the fixture) ══════════════
 * | when (UTC) | what the dossier records                                      |
 * |------------|---------------------------------------------------------------|
 * | 23:18:03   | ticket.created TEAM-4183 "Fix (review): ActivityFeed          |
 * |            | clear/undo — 3 findings", blockedBy [] → dispatched 3s later   |
 * | 23:19:17   | TEAM-4180 (code_reviewer) report_completion —                  |
 * |            | "VERDICT: CHANGES NEEDED (round 1)", PROSE ONLY, at 933ea6f    |
 * | 23:19:21   | orchestrator.unblocked TEAM-4181 → QA invoked ANYWAY, while    |
 * |            | TEAM-4183 was still in_progress                               |
 * | 23:36:28   | TEAM-4181 (qa_verifier) — "VERDICT: FAIL", evidence 12e9ac6    |
 * | 23:36:32   | orchestrator.unblocked TEAM-4182 → CI invoked ANYWAY           |
 * | 23:42:09   | TEAM-4182 (ci_agent) — "PASS … at tested head 12e9ac6" — QA's  |
 * |            | EVIDENCE commit, not the code head                            |
 * | 23:46:55   | TEAM-4183 done at 001259d                                     |
 * | 23:47:00   | workflow.complete — 5s after a fix landed at a head nothing    |
 * |            | had verified (QA 933ea6f/12e9ac6, CI 12e9ac6, PR 001259d)      |
 *
 * ══ WHICH LAYER THIS EXERCISES ═══════════════════════════════════════════════
 * The REAL orchestrator: `handler` over DynamoDB-stream records → processRecord →
 * handleTicketDone → the real cascade.mjs, the real live-reverify.mjs factory, the
 * real completion.mjs gate, the real completeWorkflow. Only the AWS seams are
 * mocked. Nothing in this file re-implements a D1 decision; every assertion reads
 * what those modules published.
 *
 * ══ SYNTHESIZED, AND WHY ═════════════════════════════════════════════════════
 *  1. TICKET_PROVIDER is left UNSET (→ "dynamodb"), so `handler` takes the stream
 *     branch. dowtdh was really a jira-mode run whose cascade came through
 *     handleTicketDoneUnified; the two done twins are pinned byte-identical in
 *     done-handlers-cascade.test.mjs, so replaying the stream twin replays both.
 *  2. Declared verdicts. The fixture's records carry NO `verdict`/`tested_head` —
 *     that absence is hole H1, the thing FR-D1.1 fixes. The replay seeds each gate
 *     record the way the persona's blueprint (item 13) now makes it report:
 *       TEAM-4180  CHANGES_NEEDED @ 933ea6f…  (the head it inspected)
 *       TEAM-4181  FAIL           @ 933ea6f…  (its own summary says QA must
 *                                              re-run at the CODE head; 12e9ac6
 *                                              is only where its evidence landed)
 *       TEAM-4182  PASS           @ 12e9ac6…  (ci_head_sha, the fixture's value)
 *     `inferred: true` replays the same run with the fixture's PROSE ONLY, to show
 *     the ladder reaches the identical holds. Both variants run every gate test.
 *  3. TEAM-4183's `spawnedBy`. The dossier's ticket projection has `spawnedBy: null`
 *     on every row (jira-mode keeps the kind in a label), so the fix marker is
 *     synthesized from the row's own title, "Fix (review): …" → `kind:"review_fix"`,
 *     with the fix contract's origin key for that kind — KIND_TO_ORIGIN_KEY
 *     `review_fix → gateTicketId` — pointing at TEAM-4180, its filer.
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
    /** Every Tickets___create_ticket parameter set, in order. */
    createdTickets: /** @type {any[]} */ ([]),
    /** Every blocker edge that actually WROTE (applyBlockerEdge attempt 1 or 2). */
    blockerWrites: /** @type {any[]} */ ([]),
    /** Every status transition write (transitionToReady + friends). */
    statusWrites: /** @type {any[]} */ ([]),
    storeCompletions: /** @type {any[]} */ ([]),
    finalized: /** @type {string[]} */ ([]),
    notifications: /** @type {any[]} */ ([]),
    blockedKeys: new Map(),
    reverifySlots: new Set(),
    /** Every claimReverifySlot call and the tri-state it returned. */
    reverifySlotClaims: /** @type {any[]} */ ([]),
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
   * `preserveStatusIf` status guard), because the whole idempotency story of the
   * verdict hold rides on those conditions failing rather than on the caller
   * remembering what it already wrote.
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
      try { payload = JSON.parse(cmd.input?.Payload || "{}"); } catch { /* agent invokes */ }
      const tool = String(payload?.tool_name || "");
      if (tool.startsWith("Tickets___create_ticket")) {
        const params = payload.parameters || {};
        h.state.nextTicketNum += 1;
        const key = `TEAM-42${String(h.state.nextTicketNum).padStart(2, "0")}`;
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
      const key = String(cmd?.input?.Key || "");
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
 * `completionBlockedKey`, so the CAS key and escalation ids are production's.
 * Only the seams that talk to DynamoDB are replaced, each with the real tri-state.
 */
vi.mock("./workflow-store.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initWorkflowStore: vi.fn(() => {}),
    getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
    trackTicket: vi.fn(async () => true),
    completeTaskEntry: vi.fn(async () => true),
    completeWorkflow: vi.fn(async (id, ts) => { h.state.storeCompletions.push({ id, ts }); return true; }),
    claimFinalization: vi.fn(async () => false),
    markFinalized: vi.fn(async (id) => { h.state.finalized.push(id); }),
    claimTerminalOutcome: vi.fn(async () => true),
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
      h.state.reverifySlotClaims.push({ ticketId, slotSha, result });
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
    fileURLToPath(new URL("../../deploy/workflow-manager/toolkit/fixtures/dowtdh-dossier.json", import.meta.url)),
    "utf8",
  ),
);

/** Fixture rows by id — these throw if the vendored dossier moves under us. */
function fixtureTicket(ticketId) {
  const row = DOSSIER.tickets.find((t) => t.ticketId === ticketId);
  if (!row) throw new Error(`dowtdh fixture has no ticket ${ticketId}`);
  return row;
}
function fixtureCompletion(ticketId) {
  const rec = DOSSIER.completions?.[ticketId];
  if (!rec) throw new Error(`dowtdh fixture has no completion record for ${ticketId}`);
  return rec;
}

const WF_ID = "wf_1788731227559_dowtdh";
const EPIC = "TEAM-4162";
const DEV = "TEAM-4179";      // backend dev, done at 1dab069
const REVIEW = "TEAM-4180";   // code_reviewer — CHANGES NEEDED at 933ea6f
const QA = "TEAM-4181";       // qa_verifier — FAIL, evidence at 12e9ac6
const CI = "TEAM-4182";       // ci_agent — PASS at 12e9ac6 (QA's evidence commit)
const FIX = "TEAM-4183";      // the review fix, done at 001259d, blockedBy []
const REPLAYED = [DEV, REVIEW, QA, CI, FIX];

const QA_VERIFIER_ID = "agentcore_hub_qa_verifier";
const CI_AGENT_ID = "agentcore_hub_ci_agent";

/** The code head the reviewer inspected and QA's summary tells QA to re-run at. */
const CODE_HEAD = fixtureCompletion(REVIEW).commit_sha;   // 933ea6f…
/** Where QA's evidence landed, and the head CI certified. */
const EVIDENCE_HEAD = fixtureCompletion(CI).ci_head_sha;  // 12e9ac6…
/** The head that actually shipped. */
const SHIPPED_HEAD = fixtureCompletion(FIX).commit_sha;   // 001259d…

// ─── Board / workflow / records, built from the fixture ──────────────────────

/** The fix marker the row's own title implies (see SYNTHESIZED note 3). */
const FIX_SPAWNED_BY = { kind: "review_fix", gateTicketId: REVIEW, phase: "development" };

/**
 * The board as it read at 23:19:00Z, from the fixture: everything up to the dev
 * ticket already done, the five replayed rows still open, TEAM-4183 not yet filed.
 */
function buildBoard() {
  const board = new Map();
  for (const t of DOSSIER.tickets) {
    const row = JSON.parse(JSON.stringify(t));
    row.blockedBy = Array.isArray(row.blockedBy) ? row.blockedBy : [];
    if (row.ticketId === FIX) continue; // filed mid-run, INSERTed by the replay
    if (REPLAYED.includes(row.ticketId)) {
      row.status = row.ticketId === DEV ? "in_progress" : "blocked";
      delete row.completedAt;
    }
    board.set(row.ticketId, row);
  }
  return board;
}

/**
 * The workflow row, verbatim from the fixture apart from `phase` (the fixture's is
 * the post-hoc "complete") and the agentTasks of the five replayed tickets, which
 * are rewound to "running" so the real harvest fills them from the records.
 */
function buildWorkflow() {
  const wf = JSON.parse(JSON.stringify(DOSSIER.workflow));
  wf.id = WF_ID;
  wf.workflowId = WF_ID;
  wf.epicId = EPIC;
  wf.phase = "review";
  wf.humanNotifications = wf.humanNotifications || [];
  wf.resumeContexts = wf.resumeContexts || {};
  for (const id of REPLAYED) {
    const entry = wf.agentTasks?.[id];
    if (!entry) continue;
    entry.status = "running";
    delete entry.completedAt;
  }
  delete wf.agentTasks?.[FIX];
  return wf;
}

/**
 * The completion records as the personas would write them under FR-D1.1. Every
 * value except `verdict`/`tested_head` is the fixture's own; those two are the
 * fields the run never had (hole H1). `inferred` drops them, leaving the fixture's
 * prose as the only signal, so the ladder is exercised on the real summaries.
 */
function buildCompletions({ inferred = false } = {}) {
  const out = {};
  for (const [ticketId, rec] of Object.entries(DOSSIER.completions || {})) {
    out[ticketId] = JSON.parse(JSON.stringify(rec));
  }
  if (!inferred) {
    out[REVIEW].verdict = "CHANGES_NEEDED";
    out[REVIEW].tested_head = CODE_HEAD;
    // QA's own summary says the re-run must happen at the CODE head — 12e9ac6 is
    // merely where its evidence artifacts landed, so the head it reports is 933ea6f.
    out[QA].verdict = "FAIL";
    out[QA].tested_head = CODE_HEAD;
    out[CI].verdict = "PASS";
    out[CI].tested_head = EVIDENCE_HEAD;
  }
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

/** The INSERT record create_ticket emitted for TEAM-4183 at 23:18:03Z. */
function insertFixRecord() {
  const row = {
    ...JSON.parse(JSON.stringify(fixtureTicket(FIX))),
    status: "todo",
    blockedBy: [],
    spawnedBy: FIX_SPAWNED_BY,
  };
  delete row.completedAt;
  h.state.board.set(FIX, row);
  return { eventName: "INSERT", eventSource: "aws:dynamodb", dynamodb: { NewImage: toImage(row) } };
}

// ─── Event log readers ───────────────────────────────────────────────────────

const allEvents = () =>
  h.state.ebEvents
    .flatMap((i) => i.Entries || [])
    .map((e) => ({ type: e.DetailType, detail: JSON.parse(e.Detail) }));

const detailsOfType = (type) => allEvents().filter((e) => e.type === type).map((e) => e.detail);

/**
 * The three cascade/completion event types criterion (e) compares, in order.
 * Dispatch events (agent.invoked / orchestrator.agent_invoked / agent.started) are
 * excluded: they ride on the `ready`/`in_progress` stream records this replay does
 * not deliver, so they are the harness's shape, not the cascade's decision.
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
 * The SAME shape, read out of the fixture's OWN event stream — the pre-D1 baseline
 * criterion (e) must reproduce. Only the replayed window is kept: the 22:45
 * `orchestrator.unblocked TEAM-4179` was unblocked by TEAM-4178, which this replay
 * never delivers.
 */
function fixtureCascadeShape() {
  const replayed = new Set(REPLAYED);
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

// ─── The driver ──────────────────────────────────────────────────────────────

let handler;
let completeWorkflow;

/**
 * The three flags are read at index.mjs module scope, so every mode change needs a
 * fresh module graph — the same reason verified-head-completion.test.mjs reloads
 * per test. `undefined` means "leave unset", which is how the shadow default is
 * exercised rather than asserted by hand.
 */
async function loadWith({ verdict, fixBefore, verifiedHead } = {}) {
  const set = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  set("VERDICT_GATE", verdict);
  set("FIX_BEFORE_VERIFY", fixBefore);
  set("VERIFIED_HEAD_COMPLETION", verifiedHead);
  vi.resetModules();
  ({ handler, completeWorkflow } = await import("./index.mjs"));
}

/** One stream delivery, through the real handler. */
const deliver = (record) => handler({ Records: [record] });

/**
 * The run, in the order the fixture records it: the reviewer files TEAM-4183, then
 * the four gate/dev tickets close one after another, each one's cascade deciding
 * whether the next may start.
 */
async function replay() {
  await deliver(doneRecord(DEV));
  await deliver(insertFixRecord());
  await deliver(doneRecord(REVIEW));
  await deliver(doneRecord(QA));
  await deliver(doneRecord(CI));
  await deliver(doneRecord(FIX));
}

const reverifyTickets = () => h.state.createdTickets.filter((t) => /Re-verify/i.test(String(t.summary || "")));

describe("dowtdh replay — the fixture still says what this replay claims", () => {
  it("records three different heads and not one structured verdict", () => {
    expect(CODE_HEAD.startsWith("933ea6f")).toBe(true);
    expect(EVIDENCE_HEAD.startsWith("12e9ac6")).toBe(true);
    expect(SHIPPED_HEAD.startsWith("001259d")).toBe(true);
    expect(new Set([CODE_HEAD, EVIDENCE_HEAD, SHIPPED_HEAD]).size).toBe(3);

    // Hole H1: the verdict existed only as prose, on every gate ticket.
    for (const id of [REVIEW, QA, CI]) {
      expect(fixtureCompletion(id).verdict).toBeUndefined();
      expect(fixtureCompletion(id).tested_head).toBeUndefined();
    }
    expect(fixtureCompletion(REVIEW).summary).toContain("CHANGES NEEDED");
    expect(fixtureCompletion(QA).summary).toContain("FAIL");

    // Hole H2's precondition: the fix was filed unblocked, and QA was next in line.
    expect(fixtureTicket(FIX).title).toContain("Fix (review):");
    expect(fixtureTicket(FIX).blockedBy).toEqual([]);
    expect(fixtureTicket(QA).blockedBy).toContain(REVIEW);
    expect(fixtureTicket(QA).assignee).toBe(QA_VERIFIER_ID);
    expect(fixtureTicket(CI).assignee).toBe(CI_AGENT_ID);
  });

  it("published workflow.complete with the cascade unblocking every gate in turn", () => {
    // The baseline criterion (e) reproduces, straight out of the dossier.
    const shape = fixtureCascadeShape();
    // Each gate released the next on `done` alone: the dev released the reviewer,
    // the reviewer released QA (over its own CHANGES NEEDED), QA released CI.
    expect(shape.filter((s) => s.type === "orchestrator.unblocked").map((s) => s.ticketId)).toEqual([REVIEW, QA, CI]);
    expect(shape.filter((s) => s.type === "workflow.complete")).toHaveLength(1);
  });
});

describe("dowtdh replay — the D1 flags", () => {
  beforeEach(() => {
    h.state.board = buildBoard();
    h.state.workflow = buildWorkflow();
    h.state.completions = buildCompletions();
    h.state.ebEvents.length = 0;
    h.state.createdTickets.length = 0;
    h.state.blockerWrites.length = 0;
    h.state.statusWrites.length = 0;
    h.state.storeCompletions.length = 0;
    h.state.finalized.length = 0;
    h.state.notifications.length = 0;
    h.state.blockedKeys.clear();
    h.state.reverifySlots.clear();
    h.state.reverifySlotClaims.length = 0;
    h.state.nextTicketNum = 0;
    process.env.ARTIFACT_BUCKET = "test-artifacts";
    process.env.EVENT_BUS = "test-bus";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VERDICT_GATE;
    delete process.env.FIX_BEFORE_VERIFY;
    delete process.env.VERIFIED_HEAD_COMPLETION;
    delete process.env.ARTIFACT_BUCKET;
    delete process.env.EVENT_BUS;
  });

  // ── (e) ────────────────────────────────────────────────────────────────────
  it("(e) all three flags off: the event sequence equals the pre-D1 baseline, with zero writes", async () => {
    await loadWith({ verdict: "off", fixBefore: "off", verifiedHead: "off" });
    await replay();

    // Byte-for-byte the run the dossier recorded: QA unblocked, CI unblocked,
    // every agent.complete carrying the same `unblocked` array, one workflow.complete.
    expect(cascadeShape()).toEqual(fixtureCascadeShape());

    // Nothing was created and nothing was blocked — `off` pays nothing.
    expect(h.state.createdTickets).toEqual([]);
    expect(h.state.blockerWrites).toEqual([]);

    // …and not one D1 event was published.
    const d1 = allEvents().filter(
      (e) => /verdict/.test(e.type) || e.type === "orchestrator.completion_blocked" || /fix_before_verify/.test(e.type),
    );
    expect(d1).toEqual([]);
  });

  it("(e) all three flags off: agent.complete carries the four keys on every ticket, at off defaults for non-gate personas", async () => {
    await loadWith({ verdict: "off", fixBefore: "off", verifiedHead: "off" });
    await replay();

    const byTicket = Object.fromEntries(detailsOfType("agent.complete").map((d) => [d.ticketId, d]));
    expect(Object.keys(byTicket).sort()).toEqual([...REPLAYED].sort());

    // enrichCompleteDetail is unconditional (the twins are one line), so all four
    // keys are always present. The dev and the fix are not gate personas, so theirs
    // are the empty values that mean "nobody asked".
    for (const id of [DEV, FIX]) {
      expect(byTicket[id]).toMatchObject({ verdict: null, verdictSource: null, spawnedTickets: [], testedHead: "" });
    }

    // The gate personas' verdicts, however, are reported even with VERDICT_GATE=off,
    // and that is deliberate rather than a leak: `off` is a promise about WRITES —
    // no ticket, no blocker edge, no suppressed unblock — not about observability.
    // The shadow-week rollout (risk 2) and the cost-report quality card both read
    // verdict/verdictSource off this event, so gating the enrichment on the flag
    // would blind the very measurement that decides when to move to enforce.
    expect(byTicket[REVIEW]).toMatchObject({
      verdict: "CHANGES_NEEDED",
      verdictSource: "declared",
      spawnedTickets: [FIX],
      testedHead: CODE_HEAD,
    });
    expect(byTicket[QA]).toMatchObject({ verdict: "FAIL", verdictSource: "declared", spawnedTickets: [] });
    expect(byTicket[CI]).toMatchObject({ verdict: "PASS", verdictSource: "declared", testedHead: EVIDENCE_HEAD });

    // …and the reported verdicts changed nothing: the run closed exactly as it did.
    expect(h.state.createdTickets).toEqual([]);
    expect(h.state.blockerWrites).toEqual([]);
  });

  // ── (f) ────────────────────────────────────────────────────────────────────
  it("(f) shadow (the default): verdict_observed x2 + completion_blocked, workflow.complete still published, zero writes", async () => {
    await loadWith({}); // unset → shadow on all three
    await replay();

    const observed = detailsOfType("orchestrator.verdict_observed");
    expect(observed).toHaveLength(2);
    expect(observed.map((o) => o.verdict)).toEqual(["CHANGES_NEEDED", "FAIL"]);
    expect(observed.map((o) => o.wouldSuppress)).toEqual([[QA], [CI]]);

    // The head divergence is reported too — and the run still closes green, which
    // is exactly what "shadow" promises and what makes the rollout safe.
    expect(detailsOfType("orchestrator.completion_blocked")).toHaveLength(1);
    expect(detailsOfType("workflow.complete")).toHaveLength(1);

    expect(h.state.createdTickets).toEqual([]);
    expect(h.state.blockerWrites).toEqual([]);
  });

  it("(f) shadow: the inferred ladder observes the same two verdicts from the fixture's prose alone", async () => {
    h.state.completions = buildCompletions({ inferred: true });
    await loadWith({});
    await replay();

    const observed = detailsOfType("orchestrator.verdict_observed");
    expect(observed.map((o) => [o.verdict, o.verdictSource])).toEqual([
      ["CHANGES_NEEDED", "inferred"],
      ["FAIL", "inferred"],
    ]);
    expect(h.state.createdTickets).toEqual([]);
  });

  // ── (a) ────────────────────────────────────────────────────────────────────
  /**
   * VERDICT_GATE alone. FIX_BEFORE_VERIFY is off on purpose: its creation-time edge
   * would block TEAM-4181 the moment TEAM-4183 was filed, and then the missing
   * unblock would prove nothing about the cascade gate.
   */
  const ENFORCE_VERDICT_ONLY = { verdict: "enforce", fixBefore: "off", verifiedHead: "off" };

  it("(a) enforce: after TEAM-4180 CHANGES_NEEDED no orchestrator.unblocked names TEAM-4181, TEAM-4181 is not dispatched, and verdict_suppressed's blockers hold TEAM-4183 + a re-verify id", async () => {
    await loadWith(ENFORCE_VERDICT_ONLY);
    await deliver(doneRecord(DEV));
    await deliver(insertFixRecord());
    await deliver(doneRecord(REVIEW));

    // The dev's own release still happens — only the non-PASS gate is held.
    const unblocked = detailsOfType("orchestrator.unblocked");
    expect(unblocked.map((u) => u.ticketId)).toEqual([REVIEW]);
    expect(unblocked.some((u) => u.ticketId === QA)).toBe(false);

    // Not transitioned, therefore never dispatched: the whole point of gating at the
    // top of cascadeUnblock is that transition, dispatch and event fall together.
    expect(h.state.statusWrites.filter((w) => w.ticketId === QA && w.status === "todo")).toEqual([]);
    expect(h.state.board.get(QA).status).toBe("blocked");

    const suppressed = detailsOfType("orchestrator.verdict_suppressed");
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toMatchObject({
      workflowId: WF_ID,
      verdict: "CHANGES_NEEDED",
      unblocked: [QA],          // what WOULD have been released
      spawnedTickets: [FIX],    // the reviewer's own fix ticket
    });

    // The reviewer filed a fix, so the hold rides on it — plus the re-verify that
    // makes the reviewer look again once the fix lands. Both, not either.
    const [rv] = reverifyTickets();
    expect(rv).toBeTruthy();
    expect(suppressed[0].blockers).toEqual([FIX, rv.key]);
    expect(rv.blocked_by).toEqual([FIX]);
  });

  it("(a) enforce: TEAM-4181.blockedBy gained TEAM-4183 and the reviewer re-verify, and TEAM-4183 completing releases the re-verify — not TEAM-4181", async () => {
    await loadWith(ENFORCE_VERDICT_ONLY);
    await deliver(doneRecord(DEV));
    await deliver(insertFixRecord());
    await deliver(doneRecord(REVIEW));

    const rvKey = reverifyTickets()[0].key;
    // The hold is an ordinary blocker edge — which is why the existing blocked→ready
    // cascade and the reconcile sweep already know how to release it.
    expect(h.state.board.get(QA).blockedBy).toEqual([REVIEW, FIX, rvKey]);
    expect(h.state.blockerWrites.map((w) => ({ ticketId: w.ticketId, ids: w.ids }))).toEqual([
      { ticketId: QA, ids: [FIX] },
      { ticketId: QA, ids: [rvKey] },
    ]);

    h.state.ebEvents.length = 0;
    await deliver(doneRecord(FIX));

    // What the graph correctly yields: the fix's only fully-unblocked successor is
    // the re-verify. TEAM-4181 is still held by it, and stays held until the
    // reviewer's second look closes — no verifier runs against unfixed code.
    expect(detailsOfType("orchestrator.unblocked").map((u) => u.ticketId)).toEqual([rvKey]);
    expect(h.state.board.get(rvKey).status).toBe("todo");
    expect(h.state.board.get(QA).status).toBe("blocked");
  });

  it("(a) enforce: the inferred ladder holds TEAM-4181 identically from the fixture's prose alone", async () => {
    // No declared verdict anywhere — the run exactly as it was recorded. This is the
    // path every pre-4246 agent still takes until the blueprints roll out, so the
    // hold cannot depend on the new field being present.
    h.state.completions = buildCompletions({ inferred: true });
    await loadWith(ENFORCE_VERDICT_ONLY);
    await deliver(doneRecord(DEV));
    await deliver(insertFixRecord());
    await deliver(doneRecord(REVIEW));

    const suppressed = detailsOfType("orchestrator.verdict_suppressed");
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toMatchObject({ verdict: "CHANGES_NEEDED", unblocked: [QA], spawnedTickets: [FIX] });
    expect(detailsOfType("orchestrator.unblocked").some((u) => u.ticketId === QA)).toBe(false);
    expect(reverifyTickets()).toHaveLength(1);
    expect(h.state.board.get(QA).blockedBy).toEqual([REVIEW, FIX, reverifyTickets()[0].key]);
  });

  // ── (b) ────────────────────────────────────────────────────────────────────
  it("(b) a Re-verify ticket owned by agentcore_hub_qa_verifier AND one owned by agentcore_hub_ci_agent exist, tied to TEAM-4183", async () => {
    await loadWith({ verdict: "enforce", fixBefore: "off", verifiedHead: "enforce" });
    await replay(); // history as it happened: the gate reacts, it does not rewrite the past

    // The cascade's own re-verify tickets are open FIX-kind rows, and the open-fix
    // clause runs before the head comparison — so completion cannot even be reached,
    // let alone diverge, until they close. They are closed here WITHOUT a new
    // certification (an output so the evidence gate — which runs first — is
    // satisfied, but no tested head), which is the design-faithful counterfactual:
    // a round that certifies nothing adds no head, so the heads the run really
    // proved still stand, and the divergence the gate must catch is still there.
    for (const row of h.state.board.values()) {
      if (row.status === "done" || row.status === "cancelled") continue;
      row.status = "done";
      row.completedAt = "2026-09-06T23:50:00.000Z";
      h.state.workflow.agentTasks[row.ticketId] = {
        ticketId: row.ticketId,
        agentId: row.assignee,
        status: "complete",
        completedAt: row.completedAt,
        output: "closed without re-certifying a head",
      };
    }
    await completeWorkflow(h.state.workflow);

    const owned = (assignee) => reverifyTickets().filter((t) => t.assignee === assignee);

    // ── The QA re-verify, from the cascade hold on TEAM-4181's FAIL.
    const [qaRv] = owned(QA_VERIFIER_ID);
    expect(qaRv).toBeTruthy();
    expect(qaRv.summary).toMatch(/^Re-verify \(round \d+\)/);
    expect(qaRv.spawned_by).toMatchObject({ kind: "qa_fix", reverify: true, rearmOf: QA, headSha: CODE_HEAD });

    // …and it is blocked on NOTHING, which is not a miss: dowtdh's QA filed no fix
    // ticket of its own. TEAM-4183 is the REVIEWER's fix, so it is the reviewer's
    // re-verify that carries it — the §1 empty-spawnedTickets path holds the
    // successor on the re-verify alone rather than failing open.
    expect(qaRv.blocked_by).toEqual([]);
    const [reviewerRv] = owned("agentcore_hub_code_reviewer");
    expect(reviewerRv.blocked_by).toEqual([FIX]);
    expect(reviewerRv.spawned_by).toMatchObject({ kind: "review_fix", reverify: true, rearmOf: REVIEW });

    // ── The CI re-verify. CI reported PASS, so no cascade hold fired for it; it
    // comes from the completion gate's stale-head remediation instead, which is the
    // only layer that can notice CI certified 12e9ac6 while 001259d shipped.
    const [ciRv] = owned(CI_AGENT_ID);
    expect(ciRv).toBeTruthy();
    expect(ciRv.summary).toMatch(/^Re-verify \(round \d+\)/);
    expect(ciRv.spawned_by).toMatchObject({ kind: "ci_fix", reverify: true, rearmOf: CI });

    // It is blocked on nothing BY DESIGN: TEAM-4183 is already done by the time
    // completion is attempted, so an edge onto it would be inert — and `reason` is
    // not a persisted spawnedBy field at all, it rides on the event.
    expect(ciRv.blocked_by).toEqual([]);
    expect(ciRv.spawned_by.headSha.startsWith("001259d")).toBe(true);
    expect(ciRv.spawned_by.headSha).toBe(SHIPPED_HEAD);
    const ciFiled = detailsOfType("fix.reverify_created").find((e) => e.owner === CI_AGENT_ID);
    expect(ciFiled).toMatchObject({ kind: "gate", reason: "stale-head", blockedBy: [] });

    // Both verifiers are re-armed at the head that actually shipped or the head they
    // were told to re-run at — which is the whole remediation.
    expect(reverifyTickets().every((t) => t.spawned_by.reverify === true)).toBe(true);
  });

  // ── (c) ────────────────────────────────────────────────────────────────────
  /**
   * The third hole in isolation: the run EXACTLY as it happened (cascade gate off,
   * so QA and CI really do run and really do close), with only the completion gate
   * armed. That is the counterfactual the criterion asks about — had this gate
   * existed on 2026-09-06, the run would not have closed.
   */
  it("(c) enforce: workflow.complete count 0 and exactly ONE orchestrator.completion_blocked with heads.qa 933ea6f, heads.pr 001259d, reason head-divergence", async () => {
    await loadWith({ verdict: "off", fixBefore: "off", verifiedHead: "enforce" });
    await replay();

    expect(detailsOfType("workflow.complete")).toHaveLength(0);
    expect(h.state.storeCompletions).toEqual([]);
    expect(h.state.finalized).toEqual([]);

    const blocked = detailsOfType("orchestrator.completion_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ workflowId: WF_ID, reason: "head-divergence", mode: "enforce" });
    expect(blocked[0].heads.qa.startsWith("933ea6f")).toBe(true); // the head QA was told to re-run at
    expect(blocked[0].heads.ci.startsWith("12e9ac6")).toBe(true); // the head CI actually certified
    expect(blocked[0].heads.pr.startsWith("001259d")).toBe(true); // the head that shipped
    expect(blocked[0].heads.qa).toBe(CODE_HEAD);
    expect(blocked[0].heads.pr).toBe(SHIPPED_HEAD);

    // The run is left OPEN for the remediation, not rewritten to a terminal state.
    expect(h.state.workflow.phase).not.toBe("complete");
  });

  // ── (d) ────────────────────────────────────────────────────────────────────
  /** The board + workflow at the moment TEAM-4181 reports FAIL, from the replay. */
  async function upToQaFail() {
    await loadWith(ENFORCE_VERDICT_ONLY);
    await deliver(doneRecord(DEV));
    await deliver(insertFixRecord());
    await deliver(doneRecord(REVIEW));
    await deliver(doneRecord(QA));
  }

  const qaReverifies = () =>
    reverifyTickets().filter((t) => t.assignee === QA_VERIFIER_ID && t.spawned_by?.rearmOf === QA);

  it("(d) the TEAM-4181 agent.complete delivered twice creates exactly one QA re-verify and leaves the blocker-edge writes unchanged", async () => {
    await upToQaFail();

    expect(qaReverifies()).toHaveLength(1);
    const rvKey = qaReverifies()[0].key;
    const blockersBefore = JSON.parse(JSON.stringify(h.state.blockerWrites));
    const ciBlockedBefore = [...h.state.board.get(CI).blockedBy];
    expect(ciBlockedBefore).toContain(rvKey);

    // The at-least-once redelivery: the SAME stream record, replayed. `done → done`
    // is not a status change, so the real handler needs the row to still read as the
    // pre-Done image — which is exactly what a duplicated stream record carries.
    const row = h.state.board.get(QA);
    h.state.board.set(QA, { ...row, status: "in_progress" });
    await deliver(doneRecord(QA));

    // Exactly one ticket, one edge set, one blockedBy — the three-layer idempotency
    // holding across a whole second pass through handler → cascade → reverify.
    expect(qaReverifies()).toHaveLength(1);
    expect(qaReverifies()[0].key).toBe(rvKey);
    expect(h.state.board.get(CI).blockedBy).toEqual(ciBlockedBefore);
    expect(h.state.blockerWrites).toEqual(blockersBefore);

    // Layer 1 (the agentTasks marker mergeTaskMetadata wrote) is what caught it, so
    // the CAS is never reached a second time — cheapest-first, by design.
    expect(h.state.workflow.agentTasks[QA].reverifyTicketId).toBe(rvKey);
    expect(h.state.reverifySlotClaims.filter((c) => c.ticketId === QA)).toHaveLength(1);
  });

  it("(d) …and still exactly one when the marker write was lost, on the CAS alone", async () => {
    await upToQaFail();
    const rvKey = qaReverifies()[0].key;

    // A lost mergeTaskMetadata write (or an untracked task): layer 1 is blind, so the
    // claim is the only thing standing between a redelivery and a duplicate ticket.
    delete h.state.workflow.agentTasks[QA].reverifyTicketId;
    delete h.state.workflow.agentTasks[QA].reverifySha;
    const row = h.state.board.get(QA);
    h.state.board.set(QA, { ...row, status: "in_progress" });
    await deliver(doneRecord(QA));

    expect(qaReverifies()).toHaveLength(1);
    expect(qaReverifies()[0].key).toBe(rvKey);
    const claims = h.state.reverifySlotClaims.filter((c) => c.ticketId === QA);
    expect(claims.map((c) => c.result)).toEqual(["claimed", "taken"]);
  });

  /**
   * The jira twin (handleTicketDoneUnified) is not driven here: it needs
   * TICKET_PROVIDER=jira, which makes `handler` ignore stream records entirely, so it
   * cannot share this harness's driver. The two twins are pinned byte-identical —
   * same enrichCompleteDetail call, same cascade entry — in
   * done-handlers-cascade.test.mjs, which is what makes replaying one replay both.
   */
});
