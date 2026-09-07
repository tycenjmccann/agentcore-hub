import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { effectiveRoundCount, effectiveRoundCountDiffScoped, mergeRound } from "./ship-review.mjs";
import { evaluateShipVerdict, shipVerdictOf, SHIP_PHASES } from "./completion.mjs";

/**
 * TEAM-4246 D1 ACCEPTANCE REPLAY (FR-D1.13) — wf_1788637257831_f50ucz, epic TEAM-4116.
 *
 * The dowtdh replay proves D1 CHANGES the wrong outcome. This one proves it does
 * NOT change the right one: f50ucz is a run whose ship path worked — two ship-review
 * rounds, r1 CHANGES-NEEDED with three fix tickets, a CI re-certification of the
 * shared head, then r2 PASS, human merge approval, CD, complete. Every arithmetic
 * and cascade decision on that path must be bit-identical with the gate armed,
 * because a gate that perturbs a converging ship review would be worse than the
 * hole it closes.
 *
 * ══ WHAT ACTUALLY HAPPENED (every value below is in the fixture) ══════════════
 * | when (UTC) | what the dossier records                                       |
 * |------------|----------------------------------------------------------------|
 * | 06:53:00   | TEAM-4125 (ci_agent) PASS at tested head df1ed19 —              |
 * |            | "ci_status: github-actions-proxy (NOT certified)"               |
 * | 06:53:05   | orchestrator.unblocked TEAM-4126 → the release manager starts   |
 * | 07:07-08   | ticket.created ×3 — TEAM-4155 "Fix (ship-review r1): merge      |
 * |            | origin/main …" blockedBy [], TEAM-4156 blockedBy [4155],        |
 * |            | TEAM-4157 "Fix (CI): re-certify the shared branch head after    |
 * |            | ship-review r1 fixes" blockedBy [4155, 4156]                    |
 * | 07:42:36   | TEAM-4155 done at 2ac9ba4 → unblocks TEAM-4156                  |
 * | 08:19:23   | TEAM-4156 done at 7c2391b → unblocks TEAM-4157                  |
 * | 08:27:46   | TEAM-4157 done — PASS at 7c2391b, the new shared head           |
 * | 20:13:56   | TEAM-4126 done — "Ship review round 2 — PASS on head 7c2391b …  |
 * |            | (PR #395, effective round count 1/3)"                          |
 * | 20:14:02   | review.needed + orchestrator.unblocked TEAM-4127 (human gate)   |
 * | 20:36:19   | TEAM-4127 approved → orchestrator.unblocked TEAM-4128 (CD)      |
 * | 21:07:50   | TEAM-4128 done — PR #395 merged at ff64a7d, deployed           |
 * | 21:07:57   | workflow.complete                                              |
 *
 * The run's own hole (the f50ucz half of H3) is upstream of this window: QA
 * TEAM-4124 returned PASS on head 1e1591f, and the head that shipped was 7c2391b.
 * That divergence is what the dowtdh replay's criterion (c) pins; here it is only
 * the reason the completion gate is left OFF wherever this file drives completion —
 * arming it would refuse this run, which is correct behaviour but says nothing
 * about ship-review round accounting.
 *
 * ══ WHICH LAYER THIS EXERCISES ═══════════════════════════════════════════════
 * The REAL orchestrator, same as the dowtdh replay: `handler` over DynamoDB-stream
 * records → processRecord → handleTicketDone → the real cascade.mjs, the real
 * live-reverify factory, the real completion gates. Only AWS seams are mocked. The
 * ship-review arithmetic is called directly from ship-review.mjs / completion.mjs
 * (all four are pure exports), on the state the real handlers left behind.
 *
 * ══ SYNTHESIZED, AND WHY ═════════════════════════════════════════════════════
 *  1. TICKET_PROVIDER is left UNSET (→ "dynamodb") so `handler` takes the stream
 *     branch; f50ucz was a jira-mode run. The two done twins are pinned
 *     byte-identical in done-handlers-cascade.test.mjs, so this replays both.
 *  2. `spawnedBy`. Every dossier ticket row has `spawnedBy: null` — f50ucz predates
 *     the fix contract on this branch, and jira-mode kept the kind in a label. The
 *     three markers are synthesized from the rows' own titles and the fix
 *     contract's KIND_TO_ORIGIN_KEY: "Fix (ship-review r1)" → `ship_fix` /
 *     shipTicketId TEAM-4126, and TEAM-4157 "Fix (CI): re-certify … after
 *     ship-review r1 fixes" → the shape live-reverify.mjs's own factory stamps for
 *     a re-verification: `ci_fix` (GATE_OWNER_FIX_KIND[ci_agent]) + ciTicketId
 *     TEAM-4125 (the CI gate being re-armed) + `reverify: true` + `rearmOf`
 *     TEAM-4156 (the last fix it re-certifies) + `headSha`.
 *  3. The ship-review ledger. The RM kept its rounds in
 *     shared/ship-review-state.json — the dossier lists that artifact but does not
 *     inline it, and the workflow row has no `reviewGateHistory` at all. The two
 *     rounds are reconstructed from the RM's OWN r2 summary, which states the
 *     numbers this file then asserts: "effective round count 1/3", round-1 findings
 *     F1/F2/F4 (F1+F2 → TEAM-4156, F4 → TEAM-4155), r2 "0 IN-DIFF findings" with
 *     one advisory (→ TEAM-4159). r1's reviewed head is not recorded anywhere, so
 *     the replay uses the head it was dispatched on — CI TEAM-4125's certified
 *     df1ed19 — read from the fixture, never retyped.
 *  4. Declared verdicts (hole H1: the records carry none). TEAM-4126 r2 gets
 *     `verdict: "PASS"` @ 7c2391b; the r1 counterfactual gets the ledger's own
 *     hyphen spelling "CHANGES-NEEDED" @ df1ed19. See the note on the r1 delivery
 *     below for why a counterfactual is needed at all.
 */

const h = vi.hoisted(() => ({
  state: {
    board: /** @type {Map<string, any>} */ (new Map()),
    workflow: /** @type {any} */ (null),
    completions: /** @type {Record<string, any>} */ ({}),
    ebEvents: /** @type {any[]} */ ([]),
    createdTickets: /** @type {any[]} */ ([]),
    blockerWrites: /** @type {any[]} */ ([]),
    statusWrites: /** @type {any[]} */ ([]),
    storeCompletions: /** @type {any[]} */ ([]),
    finalized: /** @type {string[]} */ ([]),
    notifications: /** @type {any[]} */ ([]),
    blockedKeys: new Map(),
    reverifySlots: new Set(),
    reverifySlotClaims: /** @type {any[]} */ ([]),
    claims: /** @type {any[]} */ ([]),
    nextTicketNum: 0,
    /** config/cd-registry.json, as the artifact bucket serves it (see below). */
    cdRegistry: /** @type {any} */ (null),
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

  /** The same in-memory evaluator the dowtdh replay uses — ticket-blockers.mjs's
   * two condition expressions, so idempotency is decided by the conditions rather
   * than by the caller remembering what it wrote. */
  function applyUpdate(input) {
    const id = input.Key?.ticketId;
    const row = id ? h.state.board.get(id) : null;
    const v = input.ExpressionAttributeValues || {};
    if (!row) return {};

    if (v[":one"]) {
      const preserve = Object.keys(v).filter((k) => /^:ps\d+$/.test(k)).map((k) => v[k]);
      const setsBlocked = ":blocked" in v;
      const current = Array.isArray(row.blockedBy) ? row.blockedBy : [];
      if (current.includes(v[":id"])) throw ccfe();
      if (preserve.length) {
        const inPreserve = preserve.includes(row.status);
        if (setsBlocked && inPreserve) throw ccfe();
        if (!setsBlocked && !inPreserve) throw ccfe();
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
        const key = `TEAM-41${String(60 + h.state.nextTicketNum)}`;
        h.state.createdTickets.push({ ...params, key });
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
      // The CD registry decides whether this run HAS a ship phase at all:
      // unregistered → cd-registry.mjs strips it from the effective def, and the
      // run completes the moment QA/CI are done, before the release manager has
      // said anything. f50ucz shipped through the agentcore-hub-deploy pipeline
      // (workflow.delivery.mode "cd"), so the replay serves the entry that made
      // that true — otherwise every ship assertion here would be testing handoff.
      if (key.endsWith("config/cd-registry.json") && h.state.cdRegistry) {
        const body = JSON.stringify(h.state.cdRegistry);
        return { Body: { transformToString: async () => body } };
      }
      // The other two config objects the deploy syncs to the same bucket. Without
      // config/workflows.json the orchestrator falls back to FALLBACK_WORKFLOW_DEF,
      // whose completionRequiresAgentPhases is ["development","verification",
      // "review"] — NO "ship" — so the run would complete the moment the CI re-cert
      // lands and the whole ship window would go unasserted. f50ucz ran on
      // workflowDefId "software-delivery", which requires "ship" too and declares
      // the always-blocking Merge Approval gate; agents.json is what gives the
      // release manager that phase in the first place.
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

/** PARTIAL mock: every pure helper stays real (notably completionBlockedKey), only
 * the DynamoDB seams are replaced, each with its real tri-state. */
vi.mock("./workflow-store.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initWorkflowStore: vi.fn(() => {}),
    getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
    trackTicket: vi.fn(async () => true),
    // The dispatch claim, so a ticket becoming ready runs to the end of its record
    // instead of dying on the real CAS — the invoke seam itself is mocked away.
    claimInvocation: vi.fn(async (wfId, ticketId) => { h.state.claims.push({ wfId, ticketId }); return true; }),
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
    fileURLToPath(new URL("../../deploy/workflow-manager/toolkit/fixtures/f50ucz-dossier.json", import.meta.url)),
    "utf8",
  ),
);

/** The repo's own copies of the two config objects the deploy syncs to the artifact
 * bucket, served verbatim by the S3 mock above (read-only — never written). */
const readConfig = (rel) => {
  const text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  return { Body: { transformToString: async () => text } };
};
const REPO_CONFIG = {
  workflows: readConfig("../../src/config/workflows.json"),
  agents: readConfig("../../src/config/agents.json"),
};

function fixtureTicket(ticketId) {
  const row = DOSSIER.tickets.find((t) => t.ticketId === ticketId);
  if (!row) throw new Error(`f50ucz fixture has no ticket ${ticketId}`);
  return row;
}
function fixtureCompletion(ticketId) {
  const rec = DOSSIER.completions?.[ticketId];
  if (!rec) throw new Error(`f50ucz fixture has no completion record for ${ticketId}`);
  return rec;
}

const WF_ID = "wf_1788637257831_f50ucz";
const EPIC = "TEAM-4116";
const QA = "TEAM-4124";        // qa_verifier — PASS at 1e1591f (the run's own hole)
const CI1 = "TEAM-4125";       // ci_agent — PASS at df1ed19, the head r1 reviewed
const SHIP = "TEAM-4126";      // release_manager — ship review r1 then r2 PASS
const APPROVAL = "TEAM-4127";  // human:engineer — Merge Approval
const CD = "TEAM-4128";        // release_manager — CD
const FIX1 = "TEAM-4155";      // Fix (ship-review r1) F4, blockedBy []
const FIX2 = "TEAM-4156";      // Fix (ship-review r1) F1+F2, blockedBy [FIX1]
const RECERT = "TEAM-4157";    // Fix (CI): re-certify the shared head
const REPLAYED = [CI1, FIX1, FIX2, RECERT, SHIP, APPROVAL, CD];

const RELEASE_MANAGER_ID = "agentcore_hub_release_manager";
const CI_AGENT_ID = "agentcore_hub_ci_agent";

/** The head CI certified before the ship review, and the head r1 was dispatched on. */
const R1_HEAD = fixtureCompletion(CI1).commit_sha;      // df1ed19…
/** The shared-branch head after the r1 fixes — reviewed by r2 and re-certified by TEAM-4157. */
const SHIP_HEAD = fixtureCompletion(SHIP).commit_sha;   // 7c2391b…
/** Where QA looked, upstream of this window — the f50ucz half of hole H3. */
const QA_HEAD = fixtureCompletion(QA).commit_sha;       // 1e1591f…

/** All three flags off — the pre-D1 orchestrator. */
const ALL_OFF = { verdict: "off", fixBefore: "off", verifiedHead: "off" };
/**
 * The gate armed and nothing else. VERIFIED_HEAD_COMPLETION stays off throughout:
 * f50ucz's QA head really does differ from its shipped head, so that gate refuses
 * this run — a correct refusal (pinned by the dowtdh replay) that would mask every
 * ship-cascade claim this file makes.
 */
const ENFORCE_VERDICT_ONLY = { verdict: "enforce", fixBefore: "off", verifiedHead: "off" };

// ─── The ship-review ledger (SYNTHESIZED note 3) ─────────────────────────────

/**
 * Round 1: CHANGES-NEEDED, three IN-DIFF findings, no regressionOf — so
 * effectiveRoundCount weighs it 1, which is the "1/3" the RM's own r2 summary
 * reports. The hyphen spelling is the ledger's, verbatim: ship-review.mjs's
 * effectiveRoundCount compares that string literally, which is exactly why
 * normalizeVerdict reads all three spellings instead of a migration renaming them.
 */
const R1_ROUND = {
  round: 1,
  verdict: "CHANGES-NEEDED",
  reviewedHeadSha: R1_HEAD,
  at: "2026-09-06T07:07:15.694Z", // the first fix ticket.created — r1's findings becoming work
  findings: [
    { id: "F1", priority: "P1", classification: "IN-DIFF" },
    { id: "F2", priority: "P2", classification: "IN-DIFF" },
    { id: "F4", priority: "P1", classification: "IN-DIFF" },
  ],
};

/** Round 2: PASS on the re-certified head, 0 IN-DIFF findings, 1 advisory (TEAM-4159). */
const R2_ROUND = {
  round: 2,
  verdict: "PASS",
  reviewedHeadSha: SHIP_HEAD,
  at: fixtureCompletion(SHIP).completed_at,
  findings: [{ id: "r2-F1", priority: "P2", classification: "ADVISORY" }],
};

// ─── Board / workflow / records, built from the fixture ──────────────────────

/** The fix markers the rows' own titles imply (SYNTHESIZED note 2). */
const SPAWNED_BY = {
  [FIX1]: { kind: "ship_fix", shipTicketId: SHIP },
  [FIX2]: { kind: "ship_fix", shipTicketId: SHIP },
  [RECERT]: { kind: "ci_fix", ciTicketId: CI1, reverify: true, rearmOf: FIX2, headSha: SHIP_HEAD },
};

/**
 * The board as it read at 06:53:00Z: everything up to QA already done, the ship
 * window's rows still open, the three fix tickets not yet filed.
 */
function buildBoard() {
  const board = new Map();
  for (const t of DOSSIER.tickets) {
    const row = JSON.parse(JSON.stringify(t));
    row.blockedBy = Array.isArray(row.blockedBy) ? row.blockedBy : [];
    if ([FIX1, FIX2, RECERT].includes(row.ticketId)) continue; // filed mid-run by the replay
    if (REPLAYED.includes(row.ticketId)) {
      row.status = row.ticketId === CI1 ? "in_progress" : "blocked";
      delete row.completedAt;
    }
    board.set(row.ticketId, row);
  }
  return board;
}

/** The workflow row, verbatim apart from `phase`, the replayed tickets' rewound
 * agentTasks, and the reconstructed ship-review ledger. */
function buildWorkflow() {
  const wf = JSON.parse(JSON.stringify(DOSSIER.workflow));
  wf.id = WF_ID;
  wf.workflowId = WF_ID;
  wf.epicId = EPIC;
  wf.phase = "ship";
  wf.humanNotifications = wf.humanNotifications || [];
  wf.resumeContexts = wf.resumeContexts || {};
  // The ledger lives where review-cap.mjs reads it, keyed by the gate ticket.
  wf.reviewGateHistory = { [APPROVAL]: { rounds: [R1_ROUND, R2_ROUND], authorizations: [], escalations: [] } };
  for (const id of REPLAYED) {
    const entry = wf.agentTasks?.[id];
    if (!entry) continue;
    entry.status = "running";
    delete entry.completedAt;
  }
  for (const id of [FIX1, FIX2, RECERT]) delete wf.agentTasks?.[id];
  return wf;
}

/**
 * The completion records as FR-D1.1 has the personas write them. Every value except
 * `verdict`/`tested_head` is the fixture's own.
 *
 * `shipRound: 1` is the COUNTERFACTUAL. f50ucz's release manager never reported
 * done on a non-PASS round — it held TEAM-4126 in_progress across both rounds and
 * only closed on the r2 PASS, which is why the verdict gate is inert on the real
 * ship path (test 1) and why exercising it at all needs a synthesized r1 close.
 * The declared value is the ledger's own "CHANGES-NEEDED" while the summary prose
 * still says "PASS on head 7c2391b" — deliberately contradictory, because that is
 * what proves the mapping is read off the FIELD and not off the ladder.
 */
function buildCompletions({ shipRound = 2, shipVerdict } = {}) {
  const out = {};
  for (const [ticketId, rec] of Object.entries(DOSSIER.completions || {})) {
    out[ticketId] = JSON.parse(JSON.stringify(rec));
  }
  out[CI1].verdict = "PASS";
  out[CI1].tested_head = R1_HEAD;
  out[RECERT].verdict = "PASS";
  out[RECERT].tested_head = SHIP_HEAD;
  if (shipRound === 1) {
    out[SHIP].verdict = shipVerdict ?? R1_ROUND.verdict;
    out[SHIP].tested_head = R1_HEAD;
  } else {
    out[SHIP].verdict = shipVerdict ?? "PASS";
    out[SHIP].tested_head = SHIP_HEAD;
  }
  return out;
}

// ─── Stream records ──────────────────────────────────────────────────────────

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

/** The MODIFY record the tickets table emits when a ticket moves to Done. */
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

/** The INSERT record create_ticket emitted for one of the three r1 fix tickets. */
function insertFixRecord(ticketId) {
  const fixture = fixtureTicket(ticketId);
  const row = {
    ...JSON.parse(JSON.stringify(fixture)),
    status: (fixture.blockedBy || []).length ? "blocked" : "todo",
    blockedBy: [...(fixture.blockedBy || [])],
    spawnedBy: SPAWNED_BY[ticketId],
  };
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

/** The same shape read out of the fixture's OWN events — the pre-D1 baseline. Only
 * unblocks caused by a replayed ticket are kept (QA released CI1 in the real run,
 * and this replay starts at CI1). */
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

async function loadWith({ verdict, fixBefore, verifiedHead } = {}) {
  const set = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  set("VERDICT_GATE", verdict);
  set("FIX_BEFORE_VERIFY", fixBefore);
  set("VERIFIED_HEAD_COMPLETION", verifiedHead);
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
}

const deliver = (record) => handler({ Records: [record] });

/** The run in the order the fixture records it, up to and including the r1 fixes'
 * CI re-certification — everything before the release manager closes. */
async function replayToRecert() {
  await deliver(doneRecord(CI1));
  for (const id of [FIX1, FIX2, RECERT]) await deliver(insertFixRecord(id));
  await deliver(doneRecord(FIX1));
  await deliver(doneRecord(FIX2));
  await deliver(doneRecord(RECERT));
}

/** …then the r2 PASS, the human merge approval and CD, which closes the run. */
async function replayShipTail() {
  await deliver(doneRecord(SHIP));
  await deliver(doneRecord(APPROVAL));
  await deliver(doneRecord(CD));
}

const children = () => [...h.state.board.values()].filter((t) => t.parentId === EPIC);
const tasks = () => h.state.workflow?.agentTasks || {};
/** agents.json's phase for the personas this window touches — evaluateShipVerdict
 * needs it because no f50ucz ticket row carries an explicit `phase`. */
const ROSTER_PHASE = { [RELEASE_MANAGER_ID]: "ship", [CI_AGENT_ID]: "review", agentcore_hub_backend_dev: "development" };
const shipVerdictState = () =>
  evaluateShipVerdict(children(), tasks(), SHIP_PHASES, { getAgentPhase: (a) => ROSTER_PHASE[a] });

const reverifyTickets = () => h.state.createdTickets.filter((t) => /Re-verify/i.test(String(t.summary || "")));

beforeEach(() => {
  process.env.WORKFLOWS_TABLE = "wf";
  process.env.TICKETS_TABLE = "tickets";
  process.env.EVENTS_TABLE = "events";
  process.env.EVENT_BUS_NAME = "bus";
  process.env.TICKET_TOOLS_FUNCTION = "tickets-fn";
  process.env.ARTIFACT_BUCKET = "artifacts"; // so loadCdRegistry reads the entry below
  delete process.env.TICKET_PROVIDER;
  Object.assign(h.state, {
    cdRegistry: {
      version: 1,
      repos: [{
        repo: "tycenjmccann/agentcore-hub",
        pipeline: DOSSIER.workflow.delivery.pipeline,   // "agentcore-hub-deploy"
        region: "us-east-1",
      }],
    },
    board: buildBoard(),
    workflow: buildWorkflow(),
    completions: buildCompletions(),
    ebEvents: [],
    createdTickets: [],
    blockerWrites: [],
    statusWrites: [],
    storeCompletions: [],
    finalized: [],
    notifications: [],
    blockedKeys: new Map(),
    reverifySlots: new Set(),
    reverifySlotClaims: [],
    claims: [],
    nextTicketNum: 0,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  for (const name of ["VERDICT_GATE", "FIX_BEFORE_VERIFY", "VERIFIED_HEAD_COMPLETION", "LIVE_REVERIFY"]) {
    delete process.env[name];
  }
});

describe("f50ucz replay — the fixture still says what this replay claims", () => {
  it("records a converging two-round ship review whose CI re-cert the agent filed itself", () => {
    expect(R1_HEAD.startsWith("df1ed19")).toBe(true);
    expect(SHIP_HEAD.startsWith("7c2391b")).toBe(true);
    expect(QA_HEAD.startsWith("1e1591f")).toBe(true);

    // The RM's own numbers, which the reconstructed ledger reproduces below.
    expect(fixtureCompletion(SHIP).summary).toContain("Ship review round 2 — PASS");
    expect(fixtureCompletion(SHIP).summary).toContain("effective round count 1/3");
    expect(fixtureCompletion(SHIP).summary).toContain("0 IN-DIFF findings");

    // The fix chain, and the CI re-cert waiting on both fixes.
    expect(fixtureTicket(FIX1).title).toContain("Fix (ship-review r1)");
    expect(fixtureTicket(FIX2).title).toContain("Fix (ship-review r1)");
    expect(fixtureTicket(RECERT).title).toContain("re-certify the shared branch head");
    expect(fixtureTicket(RECERT).assignee).toBe(CI_AGENT_ID);
    expect(fixtureTicket(RECERT).blockedBy).toEqual([FIX1, FIX2]);

    // Hole H1 again, and the pre-contract markers this replay synthesizes.
    for (const id of [SHIP, RECERT, CI1]) expect(fixtureCompletion(id).verdict).toBeUndefined();
    for (const id of [FIX1, FIX2, RECERT]) expect(fixtureTicket(id).spawnedBy ?? null).toBeNull();
  });

  it("reconstructs the ledger the RM reported: effective round count 1 of 3", () => {
    const rounds = [R1_ROUND, R2_ROUND];
    expect(effectiveRoundCount(rounds)).toBe(1);
    // No round carries a changeSet, so diff-scoping is inert — identical answer.
    expect(effectiveRoundCountDiffScoped(rounds)).toBe(1);
    // mergeRound is keyed by round number: re-running r2 replaces it in place.
    expect(mergeRound(rounds, { ...R2_ROUND, reviewedHeadSha: SHIP_HEAD })).toHaveLength(2);
  });
});

describe("f50ucz replay — D1 leaves a converging ship review alone", () => {
  /**
   * The ship-review arithmetic and the ship verdict after every step of the ship
   * path. Everything here is read from the pure exports on the state the real
   * handlers left, so a cascade change that perturbed the ledger, the round
   * weighting or the merge verdict would show up as a diff between two modes.
   */
  async function shipAccountingTrace(mode) {
    await loadWith(mode);
    const trace = [];
    const ledger = () => h.state.workflow.reviewGateHistory?.[APPROVAL] || { rounds: [], authorizations: [] };
    const snap = (label) => {
      const { rounds, authorizations } = ledger();
      trace.push({
        label,
        rounds: JSON.parse(JSON.stringify(rounds)),
        effective: effectiveRoundCount(rounds, authorizations),
        effectiveDiffScoped: effectiveRoundCountDiffScoped(rounds, authorizations),
        // The next round the RM would write, merged the way review-cap merges it.
        merged: mergeRound(rounds, { ...R2_ROUND, round: 3, verdict: "PASS" }).map((r) => `${r.round}:${r.verdict}`),
        ship: shipVerdictState(),
        shipVerdictOfShip: shipVerdictOf(tasks()[SHIP]),
        shipVerdictOfCd: shipVerdictOf(tasks()[CD]),
      });
    };

    snap("dispatched");
    await deliver(doneRecord(CI1));
    snap("ci-certified");
    for (const id of [FIX1, FIX2, RECERT]) await deliver(insertFixRecord(id));
    snap("r1-fixes-filed");
    await deliver(doneRecord(FIX1));
    await deliver(doneRecord(FIX2));
    snap("r1-fixes-done");
    await deliver(doneRecord(RECERT));
    snap("head-re-certified");
    await replayShipTail();
    snap("shipped");
    return trace;
  }

  it("ship-review round accounting is identical under VERDICT_GATE=enforce vs off", async () => {
    const off = await shipAccountingTrace(ALL_OFF);

    // A fresh board/workflow for the second pass — beforeEach only runs once per it.
    Object.assign(h.state, { board: buildBoard(), workflow: buildWorkflow(), ebEvents: [], createdTickets: [], blockerWrites: [], statusWrites: [], reverifySlots: new Set(), reverifySlotClaims: [], nextTicketNum: 0 });
    const enforce = await shipAccountingTrace(ENFORCE_VERDICT_ONLY);

    expect(enforce).toEqual(off);
    // And the trace is not vacuous: the ledger is the RM's, the run ships.
    expect(off.map((s) => s.effective)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(off.at(-1).shipVerdictOfShip).toBe("shipped");
    expect(off.at(-1).ship).toMatchObject({ required: true, shipped: true, offenders: [] });
    // Two full passes, each paying COMPLETION_RECHECK_DELAY_MS on every fix-phase
    // trigger — the real re-read guard, not a harness sleep, so it is waited out.
  }, 60_000);

  it("flags off reproduces the fixture's own cascade shape, with zero writes", async () => {
    await loadWith(ALL_OFF);
    await replayToRecert();
    await replayShipTail();

    expect(cascadeShape()).toEqual(fixtureCascadeShape());
    // Which is to say: the ship path released each successor in turn and closed.
    expect(detailsOfType("orchestrator.unblocked").map((u) => u.ticketId)).toEqual([SHIP, FIX2, RECERT, APPROVAL, CD]);
    expect(detailsOfType("workflow.complete")).toHaveLength(1);

    // Nothing D1 owns fired, and nothing D1 owns wrote.
    for (const type of [
      "orchestrator.verdict_observed",
      "orchestrator.verdict_suppressed",
      "orchestrator.fix_before_verify_observed",
      "orchestrator.completion_blocked",
      "fix.reverify_created",
    ]) {
      expect(detailsOfType(type)).toEqual([]);
    }
    expect(h.state.createdTickets).toEqual([]);
    expect(h.state.blockerWrites).toEqual([]);
  });

  it("enforce does not hold the ship path on a mapped PASS", async () => {
    await loadWith(ENFORCE_VERDICT_ONLY);
    await replayToRecert();
    h.state.ebEvents.length = 0;
    await deliver(doneRecord(SHIP));

    // The r2 PASS releases the human merge gate exactly as it did in production.
    expect(detailsOfType("orchestrator.unblocked").map((u) => u.ticketId)).toEqual([APPROVAL]);
    expect(detailsOfType("orchestrator.verdict_suppressed")).toEqual([]);
    expect(h.state.board.get(APPROVAL).blockedBy).toEqual([SHIP]);
    expect(reverifyTickets()).toEqual([]);
  });
});

describe("f50ucz replay — the release manager's verdict is mapped, not inferred", () => {
  /** The agent.complete detail for one ticket, from the real done twin. */
  const completeDetail = (ticketId) => detailsOfType("agent.complete").find((d) => d.ticketId === ticketId);

  it("maps the r2 PASS and the CI re-cert off the declared field, with the reviewed head", async () => {
    await loadWith(ALL_OFF);
    await replayToRecert();
    await deliver(doneRecord(SHIP));

    expect(completeDetail(SHIP)).toMatchObject({
      verdict: "PASS",
      verdictSource: "declared",
      testedHead: SHIP_HEAD,
    });
    // The re-certification is a gate persona too, and it certified the same head.
    expect(completeDetail(RECERT)).toMatchObject({
      verdict: "PASS",
      verdictSource: "declared",
      testedHead: SHIP_HEAD,
    });
    // …while the fix tickets are not gate personas at all: the concept is null,
    // never "none" — that distinction is what keeps non-gate work out of the metrics.
    // NO_VERDICT_INFO's own values: null/null and the EMPTY STRING for the head —
    // resolveTestedHead is never even called, so the fix's own commit_sha (2ac9ba4)
    // does not leak into a field only a gate persona's head belongs in.
    expect(completeDetail(FIX1)).toMatchObject({ verdict: null, verdictSource: null, testedHead: "" });
  });

  it("maps the ledger's hyphen spelling and PASS-with-known-findings, both declared", async () => {
    // The counterfactual r1 close (see buildCompletions). The prose still says
    // "PASS on head 7c2391b" — if the ladder were consulted this would read PASS.
    h.state.completions = buildCompletions({ shipRound: 1 });
    await loadWith(ALL_OFF);
    await replayToRecert();
    await deliver(doneRecord(SHIP));

    expect(completeDetail(SHIP)).toMatchObject({
      verdict: "CHANGES_NEEDED",
      verdictSource: "declared",
      testedHead: R1_HEAD,
    });
    expect(fixtureCompletion(SHIP).summary).toContain("PASS on head");

    // review-cap's own spelling for a passing round with an advisory left standing —
    // f50ucz r2 is literally that shape (0 IN-DIFF, 1 ADVISORY → TEAM-4159).
    Object.assign(h.state, { board: buildBoard(), workflow: buildWorkflow(), ebEvents: [], createdTickets: [], blockerWrites: [], reverifySlots: new Set(), nextTicketNum: 0 });
    h.state.completions = buildCompletions({ shipVerdict: "PASS-with-known-findings" });
    await loadWith(ALL_OFF);
    await replayToRecert();
    await deliver(doneRecord(SHIP));
    expect(completeDetail(SHIP)).toMatchObject({ verdict: "PASS", verdictSource: "declared" });
  });
});

describe("f50ucz replay — a non-PASS ship round's re-verify comes from the factory", () => {
  /**
   * FR-D1.13's regression claim, on the counterfactual r1 close: TEAM-4157 was
   * filed BY the release manager (spawnedBy null, no reverify marker, no slot
   * claim). Under D1 the orchestrator files the re-verification itself, through
   * live-reverify.mjs's factory — one ticket per (gate, head), stamped
   * `reverify: true` in the gate owner's own fix lineage so completion.mjs's
   * open-fix gate counts it while the rework-loop cap does not.
   */
  async function r1Close(mode) {
    h.state.completions = buildCompletions({ shipRound: 1 });
    await loadWith(mode);
    await replayToRecert();
    // Rewind the fixes to open: r1's findings are what the gate must wait for, and
    // in the counterfactual the RM closes the round while they are still in flight.
    for (const id of [FIX1, FIX2]) h.state.board.get(id).status = "in_progress";
    h.state.ebEvents.length = 0; // the ship round's own events only
    await deliver(doneRecord(SHIP));
  }

  it("files exactly one ship_fix re-verify, blocked on every fix still open under the epic", async () => {
    process.env.LIVE_REVERIFY = "enforce";
    await r1Close(ENFORCE_VERDICT_ONLY);

    const rv = reverifyTickets();
    expect(rv).toHaveLength(1);
    expect(rv[0].assignee).toBe(RELEASE_MANAGER_ID);
    expect(rv[0].summary).toMatch(/^Re-verify \(round \d+\)/);
    expect(rv[0].spawned_by).toMatchObject({
      kind: "ship_fix",          // GATE_OWNER_FIX_KIND[release_manager]
      shipTicketId: SHIP,        // KIND_TO_ORIGIN_KEY.ship_fix
      reverify: true,
      rearmOf: SHIP,
      headSha: R1_HEAD,
    });
    // FR-D1.5/D1.6: both r1 fixes, and no self-reference to the re-cert, which is
    // itself a reverify row and so is excluded from the open-fix union.
    expect(rv[0].blocked_by).toEqual([FIX1, FIX2]);
    expect(detailsOfType("fix.reverify_created")[0]).toMatchObject({
      gateTicketId: SHIP,
      kind: "gate",
      owner: RELEASE_MANAGER_ID,
      reverifyTicketId: rv[0].key,
    });

    // The human merge gate is held behind the fixes and the re-verify — the whole
    // point: nobody is asked to approve a merge over an unresolved ship round.
    expect(h.state.board.get(APPROVAL).blockedBy).toEqual([SHIP, FIX1, FIX2, rv[0].key]);
    expect(detailsOfType("orchestrator.unblocked")).toEqual([]);
  });

  it("does not file a second one when the same round is redelivered", async () => {
    process.env.LIVE_REVERIFY = "enforce";
    await r1Close(ENFORCE_VERDICT_ONLY);
    const first = reverifyTickets()[0].key;
    const edges = h.state.board.get(APPROVAL).blockedBy.slice();

    // The stream at-least-once redelivery. done → done is not a status change, so
    // the row is rewound the way a real redelivery would present it.
    h.state.board.get(SHIP).status = "in_progress";
    await deliver(doneRecord(SHIP));

    expect(reverifyTickets().map((t) => t.key)).toEqual([first]);
    expect(h.state.board.get(APPROVAL).blockedBy).toEqual(edges);
  });
});
