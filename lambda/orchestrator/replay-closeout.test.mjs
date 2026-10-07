import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import agentsConfig from "../../src/config/agents.json";
import workflowsConfig from "../../src/config/workflows.json";
import { POST as stopRun } from "../../src/app/api/workflow/[id]/stop/route.ts";
import { ADMIN_HEADERS, SSO_AUTH_MODE } from "../../src/lib/auth/admin-test-headers.ts";
import { boardAtStop } from "./fixtures/closeout-board.mjs";
import { createHmac } from "node:crypto";
import { canonicalJson, offenderSetHash, closeoutOffenderIds } from "./proof-record-verify.mjs";
import { missingEvidenceTickets, completionRecordHasEvidence } from "./completion.mjs";
import { isHumanGate } from "./fix-contract.mjs";

/**
 * TEAM-5359 / TEAM-5370 (wf_1791311636588_rfq233) — close-out replays on four real
 * stopped or force-closed runs (fixtures/README.md). Each test builds the board the
 * run had when it was stopped from its exported events (fixtures/closeout-board.mjs:
 * inputs only), then:
 *   - POSTs the REAL hub stop route (src/app/api/workflow/[id]/stop/route.ts →
 *     cancelRun in src/lib/workflow/cancel-run.ts: signed gate stops, the FR-3
 *     sweep, the FR-5 follow-up moves) with its AWS seams mocked: the tickets
 *     table and workflows row below, and a fake ticket Lambda twin. What is
 *     cancelled, kept running or moved is production's decision; the test asserts
 *     the exact ids it produced;
 *   - drives the REAL orchestrator (index.mjs + cascade.mjs, I/O seams mocked, real
 *     src/config roster and defs) over the board production left, replaying every
 *     status change as a stream MODIFY: no store.completeWorkflow, no
 *     workflow.complete;
 *   - the same run with real Ship + CD records completes exactly once;
 *   - znl7a4's completion_blocked row with no override is refused (FR-2);
 *   - R2: two open human gates, one stopped, never unblock the dependent (FR-8).
 * The counts differ from acceptance #1's 9/12/16/>=2 and 5/5/10; the per-run ids,
 * the arithmetic showing those targets exceed the tickets open at the stop, and the
 * proposed amendment are in docs/workflow/closeout-acceptance-evidence-TEAM-5370.md.
 * All four runs were closed `complete` by an OPERATOR path (closedBy/completeReason
 * on the row), not by the orchestrator.
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(FIXTURES + name, "utf8"));

const h = vi.hoisted(() => {
  // Read at module load by src/lib/workflow/cancel-run.ts (statically imported above).
  process.env.ARTIFACT_BUCKET = "test-bucket";
  process.env.GATE_DECISION_KEY = "test-gate-key"; // the hub's literal key = the orchestrator's secret below
  delete process.env.TICKET_PROVIDER; // dynamodb: the sweep's per-ticket conditional write
  delete process.env.TICKETS_TABLE;
  delete process.env.WORKFLOWS_TABLE;
  return {
    state: {
      board: /** @type {Record<string, any>} */ ({}), // tickets table, by ticketId
      workflow: /** @type {any} */ (null),
      s3Objects: /** @type {Record<string, any>} */ ({}),
      s3Gets: /** @type {string[]} */ ([]),
      lambdaInvokes: /** @type {any[]} */ ([]),
      ebEvents: /** @type {any[]} */ ([]),
      events: /** @type {any[]} */ ([]),
      updates: /** @type {any[]} */ ([]),
      claims: /** @type {string[]} */ ([]), // store.completeWorkflow calls
      terminal: /** @type {string[]} */ ([]), // store.claimTerminalOutcome outcomes
      configs: /** @type {Record<string, any>} */ ({}),
      // While the hub stop route runs: the workflows row is read/written by Key
      // workflowId and Tickets___* invokes go to the fake twin (twinCalls).
      hub: false,
      twinCalls: /** @type {Array<{ tool: string, params: any }>} */ ([]),
    },
  };
});

const ccf = () => Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
const TERMINAL = new Set(["complete", "error", "cancelled", "deploy-blocked", "static-ci-only"]);

/** cancel-run.ts's workflows-row writes: the cancel CAS, the post-run epic claim, an escalation, the lease release. */
function applyWorkflowUpdate(wf, input) {
  const v = input.ExpressionAttributeValues || {};
  const expr = input.UpdateExpression || "";
  if (expr.includes("#phase = :cancelled")) {
    if (wf.cancelledAt || TERMINAL.has(wf.phase)) throw ccf();
    Object.assign(wf, {
      phase: "cancelled", cancelledAt: v[":ts"], previousPhase: v[":prev"], cancelReason: v[":reason"], cancelledBy: v[":by"],
      cancelCloseoutPending: v[":pending"], cancelCloseoutLeaseUntil: v[":lease"], ...(v[":decision"] ? { cancelDecision: v[":decision"] } : {}),
    });
  } else if (":k" in v) {
    if (wf.postRunEpicKey) throw ccf();
    wf.postRunEpicKey = v[":k"];
  } else if (":n" in v) {
    wf.humanNotifications = [...(wf.humanNotifications || []), ...v[":n"]];
  } else if (expr.startsWith("REMOVE cancelCloseout")) {
    if (wf.cancelCloseoutLeaseUntil !== v[":lease"]) throw ccf();
    delete wf.cancelCloseoutLeaseUntil;
    if (":now" in v) { delete wf.cancelCloseoutPending; delete wf.cancelCloseoutError; wf.cancelCloseoutCompletedAt = v[":now"]; }
    else wf.cancelCloseoutError = v[":err"];
  } else throw new Error(`unmodelled workflows update: ${expr}`);
}

/** cancel-run.ts's cancelOneTicketDynamoDB: conditional on the status the sweep read, or "open". */
function applyTicketCancel(input) {
  const v = input.ExpressionAttributeValues;
  const t = h.state.board[input.Key.ticketId];
  if (":from" in v ? t?.status !== v[":from"] : !t || ["done", "cancelled"].includes(t.status)) throw ccf();
  Object.assign(t, { status: "cancelled", cancelledAt: v[":ts"] });
}

/** The ticket Lambda twin, as far as the stop route and cancelRun drive it. */
function ticketTwin(tool, p) {
  const t = h.state.board[p.ticket_id];
  if (tool === "Tickets___create_ticket") {
    const key = `POST-RUN-${Object.keys(h.state.board).length}`;
    h.state.board[key] = { ticketId: key, title: p.summary, type: p.issue_type, status: "todo", workflowId: p.workflow_id, description: p.description };
    return { key, status: "created" };
  }
  if (!t) return { content: [{ text: `Ticket ${p.ticket_id} not found` }] };
  if (tool === "Tickets___transition_ticket") {
    t.status = p.transition_id;
    return { key: t.ticketId, status: "transitioned" };
  }
  if (tool === "Tickets___update_ticket") {
    if ("parent" in p) t.parentId = p.parent;
    if ("blocked_by" in p) t.blockedBy = p.blocked_by;
    if ("assignee" in p) t.assignee = p.assignee;
    if ("description" in p) t.description = p.description;
    return { key: t.ticketId, status: "updated" };
  }
  return { content: [{ text: `unmodelled tool ${tool}` }] };
}

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
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
          const wfKey = h.state.hub ? cmd.input.Key?.workflowId : undefined;
          if (name === "GetCommand") {
            if (wfKey) return { Item: wfKey === h.state.workflow?.id ? h.state.workflow : undefined };
            return { Item: h.state.board[cmd.input.Key?.ticketId] || null };
          }
          if (name === "QueryCommand") {
            if (cmd.input.TableName === "agentcore-hub-events") return { Items: [] };
            const parent = cmd.input.ExpressionAttributeValues?.[":pid"] ?? cmd.input.ExpressionAttributeValues?.[":p"];
            return { Items: Object.values(h.state.board).filter((t) => parent === undefined || t.parentId === parent) };
          }
          if (name === "UpdateCommand") {
            h.state.updates.push(cmd.input);
            if (wfKey) { applyWorkflowUpdate(h.state.workflow, cmd.input); return {}; }
            if (h.state.hub && ":cancelled" in (cmd.input.ExpressionAttributeValues || {})) { applyTicketCancel(cmd.input); return {}; }
            // The cascade's ready write lands on the board, so a later read sees it.
            const t = h.state.board[cmd.input.Key?.ticketId];
            const s = cmd.input.ExpressionAttributeValues?.[":s"] ?? cmd.input.ExpressionAttributeValues?.[":status"];
            if (t && typeof s === "string") t.status = s;
            return {};
          }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          return { Items: [] };
        },
      }),
    },
  };
});
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      if (!h.state.hub) {
        h.state.lambdaInvokes.push(cmd.input);
        // TEAM-5380: the orchestrator's gate-class judgment reads a done human gate live
        // (Tickets___get_issue) to bind its decision record to the gate's current cycle.
        try {
          const { tool_name, parameters } = JSON.parse(Buffer.from(cmd.input.Payload).toString());
          if (tool_name === "Tickets___get_issue") {
            const t = h.state.board[parameters.ticket_id];
            const answer = t ? { key: t.ticketId, fields: { description: t.description || "" }, gateCycle: t.gateCycle ?? null } : { error: "not found" };
            return { Payload: new TextEncoder().encode(JSON.stringify(answer)) };
          }
        } catch { /* not a ticket-tool call */ }
        return {};
      }
      const { tool_name, parameters } = JSON.parse(Buffer.from(cmd.input.Payload).toString());
      h.state.twinCalls.push({ tool: tool_name, params: parameters });
      return { Payload: new TextEncoder().encode(JSON.stringify(ticketTwin(tool_name, parameters))) };
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
// DL-036: the gate-decision key the closeout override is verified with.
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    async send(cmd) {
      if (cmd.input.VersionStage !== "AWSCURRENT") throw Object.assign(new Error("none"), { name: "ResourceNotFoundException" });
      return { SecretString: "test-gate-key" };
    }
  },
  GetSecretValueCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const key = cmd?.input?.Key || "";
      h.state.s3Gets.push(key);
      const body = key in h.state.configs ? h.state.configs[key] : h.state.s3Objects[key];
      if (body === undefined) { const e = new Error(`NoSuchKey: ${key}`); e.name = "NoSuchKey"; throw e; }
      return { Body: { transformToString: async () => (typeof body === "string" ? body : JSON.stringify(body)) } };
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
vi.mock("./workflow-store.mjs", () => {
  const row = (id) => (h.state.workflow?.id === id ? h.state.workflow : null);
  return {
    initWorkflowStore: vi.fn(() => {}),
    getWorkflow: vi.fn(async (id) => row(id)),
    // Real CAS: only a non-terminal row can be claimed, so a redelivery loses.
    completeWorkflow: vi.fn(async (id) => {
      h.state.claims.push(id);
      const wf = row(id);
      if (!wf || wf.phase === "complete") return false;
      wf.phase = "complete";
      return true;
    }),
    claimFinalization: vi.fn(async () => false),
    markFinalized: vi.fn(async () => {}),
    setDelivery: vi.fn(async () => {}),
    claimTerminalOutcome: vi.fn(async (id, outcome) => {
      h.state.terminal.push(outcome);
      const wf = row(id);
      if (!wf || wf.phase === outcome) return false;
      wf.phase = outcome;
      return true;
    }),
    completeTaskEntry: vi.fn(async (id, tid) => {
      const t = row(id)?.agentTasks?.[tid];
      if (t) t.status = "complete";
    }),
    claimInvocation: vi.fn(async () => true),
    setTaskStatus: vi.fn(async () => {}),
    resetDeadSessionRetry: vi.fn(async () => {}),
    appendNotification: vi.fn(async (id, n) => { row(id)?.humanNotifications?.push(n); }),
    appendReviewNotificationOnce: vi.fn(async () => false),
    ackNotifications: vi.fn(async () => {}),
    mergeTaskMetadata: vi.fn(async (id, tid, fields) => {
      const wf = row(id);
      if (wf) wf.agentTasks[tid] = { ...(wf.agentTasks[tid] || { ticketId: tid }), ...fields };
    }),
  };
});

process.env.SHIP_MERGE_VERIFY = "off"; // no GitHub probe in a replay
delete process.env.GITHUB_PAT;

const RUNS = ["TEAM-5259", "TEAM-5226", "znl7a4", "o1l3to"];
const PHASE = Object.fromEntries((agentsConfig.agents || agentsConfig).map((a) => [a.agentId, a.phase]));
const MANIFEST = fixture("closeout-manifest.json");

function loadRun(run) {
  const workflow = fixture(`workflow-${run}.json`);
  const completions = fixture(`${run}-completions.json`);
  const at = boardAtStop({ run, workflow, events: fixture(`events-${run}.json`), completions });
  return { workflow, completions, at };
}

/** Seed the mocked world: tickets table, workflows row, completion records, config. */
function seed({ workflow, completions }, children, rowPatch = {}) {
  h.state.board = Object.fromEntries(children.map((t) => [t.ticketId, { ...t }]));
  h.state.s3Objects = Object.fromEntries(Object.entries(completions).map(([id, r]) => [`completions/${id}.json`, r]));
  const repo = (workflow.repoConfig?.repos?.[0]?.url || "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  h.state.configs = {
    "config/agents.json": agentsConfig,
    "config/workflows.json": workflowsConfig,
    "config/cd-registry.json": { version: 1, repos: [{ repo }] }, // registered: ship phase in force
  };
  h.state.workflow = { ...workflow, id: workflow.workflowId || workflow.id, ...rowPatch };
}

/**
 * TEAM-5380: back every DONE human gate on the seeded board with a standing v3 gate decision
 * (signed with the test key, in the gate's current cycle — the board carries none, so null).
 * The orchestrator now judges gate-class proof before every claim; a done human gate without
 * one is an offender. Call after seed().
 */
function backHumanGates(children) {
  const wf = h.state.workflow.id;
  for (const t of children) {
    if (String(t.status).toLowerCase() !== "done" || !isHumanGate(t)) continue;
    const rec = {
      v: 3, ticketId: t.ticketId, workflowId: wf, kind: "gate-decision", status: "done",
      decision: { option: "approve", override: false, channel: "console", by: "human:engineer" },
      decidedAt: "2026-10-02T17:00:00.000Z", scope: null, cycle: h.state.board[t.ticketId]?.gateCycle ?? null, labels: [],
    };
    h.state.s3Objects[`pipeline-artifacts/gate-decisions/${wf}/gates/${t.ticketId}.json`] =
      { ...rec, sig: createHmac("sha256", "test-gate-key").update(canonicalJson(rec)).digest("base64url") };
  }
}

const ebOfType = (type) => h.state.ebEvents.flatMap((i) => i.Entries || []).filter((e) => e.DetailType === type);
const tableOfType = (type) => h.state.events.filter((e) => e.type === type);
const agentDispatches = () => h.state.lambdaInvokes.filter((i) => {
  try { return !String(JSON.parse(i.Payload || "{}").tool_name || "").startsWith("Tickets___"); } catch { return true; }
});
const streamRecord = (t, oldStatus) => ({ eventName: "MODIFY", dynamodb: { NewImage: { ...t }, OldImage: { ticketId: t.ticketId, status: oldStatus } } });

let mod;
async function load() {
  vi.resetModules();
  mod = await import("./index.mjs");
  await mod.handler({ Records: [] }); // primes the roster/def caches from the S3 config
}

let quiet;
beforeEach(() => {
  for (const k of ["lambdaInvokes", "ebEvents", "events", "updates", "claims", "terminal", "s3Gets", "twinCalls"]) h.state[k].length = 0;
  h.state.hub = false;
  quiet = ["log", "warn", "error"].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((s) => s.mockRestore()));

/**
 * What PRODUCTION decides on each at-stop board (cancel-run.ts via POST /stop),
 * asserted exactly. `cancelled` = children only; `epicCancelled` says whether the
 * run epic is cancelled too (the response's ticketsCancelled counts it then).
 * `gates` = the human gates /stop closes with a signed stopped decision (they are
 * in `cancelled` as well). `moved` follow-ups stay open and are NOT in `cancelled`.
 *
 * Why the tickets the old model kept as "live" are cancelled (FR-3: cancel-run
 * keeps only an in_progress ticket whose agent session is live or complete, or
 * that has a completion record; a blocked ticket with no record is cancelled):
 *  - TEAM-5231 (TEAM-5226): blocked at the stop. Its last session event before the
 *    2026-10-02T19:41:56.279Z stop is orchestrator.claim_released reason
 *    agent_self_park at 2026-09-29T18:47:14.369Z (blockedBy … TEAM-5255, TEAM-5258;
 *    escalation TEAM-5258 still open); no agent.invoked / orchestrator.agent_invoked
 *    follows it. No completion record. → cancelled.
 *  - TEAM-5264 (TEAM-5259): blocked at the stop (fixtures/at-stop-evidence.json).
 *    Re-dispatched 2026-10-02T18:00:10.969Z; filed escalation TEAM-5279 at
 *    18:05:35.013Z; agent.streaming Tickets___transition_ticket at 18:05:42; its
 *    text at 18:06:02 "parked TEAM-5264 as blocked on it. I did not call
 *    report_completion"; no output after 18:06:05 until the force-Done at
 *    19:42:06.769Z, after the 19:41:52.720Z stop. No completion record. → cancelled.
 *  - TEAM-5325 (znl7a4) is genuinely live: agent.invoked 18:11:25.697Z, 253 ms
 *    before the 18:11:25.950Z stop (agent.died at 18:12:29 afterwards). → kept,
 *    so the epic stays open.
 *  - TEAM-5305 (o1l3to): orchestrator.agent_invoked 13:24:11.010Z with no park
 *    after it before the 17:13:47.249Z stop. → kept, epic open.
 */
const EXPECTED = {
  "TEAM-5259": {
    cd: "TEAM-5267",
    gates: ["TEAM-5266", "TEAM-5279"],
    cancelled: ["TEAM-5264", "TEAM-5265", "TEAM-5266", "TEAM-5267", "TEAM-5279"],
    kept: [],
    epicCancelled: true,
    moved: ["TEAM-5268", "TEAM-5270", "TEAM-5275", "TEAM-5276", "TEAM-5277"],
    security: [],
  },
  "TEAM-5226": {
    cd: "TEAM-5234",
    gates: ["TEAM-5233", "TEAM-5258"],
    cancelled: ["TEAM-5231", "TEAM-5232", "TEAM-5233", "TEAM-5234", "TEAM-5258"],
    kept: [],
    epicCancelled: true,
    moved: ["TEAM-5236", "TEAM-5237", "TEAM-5241", "TEAM-5253", "TEAM-5256", "TEAM-5257"],
    security: ["TEAM-5256"],
  },
  znl7a4: {
    cd: "TEAM-5330",
    gates: ["TEAM-5329", "TEAM-5352"],
    cancelled: ["TEAM-5326", "TEAM-5327", "TEAM-5328", "TEAM-5329", "TEAM-5330", "TEAM-5331", "TEAM-5352"],
    kept: ["TEAM-5325"],
    epicCancelled: false,
    moved: ["TEAM-5333", "TEAM-5334", "TEAM-5335", "TEAM-5341", "TEAM-5342", "TEAM-5343", "TEAM-5344", "TEAM-5349", "TEAM-5350", "TEAM-5351"],
    security: [],
  },
  o1l3to: {
    cd: "TEAM-5307",
    gates: ["TEAM-5306", "TEAM-5314"],
    cancelled: ["TEAM-5306", "TEAM-5307", "TEAM-5314"],
    kept: ["TEAM-5305"],
    epicCancelled: false,
    moved: [],
    security: [],
  },
};

describe("the at-stop board (fixtures/closeout-board.mjs) matches the manifest", () => {
  it.each(RUNS)("%s: stop time, done-before-stop and non-done tickets", (run) => {
    const { at } = loadRun(run);
    const m = MANIFEST.runs.find((r) => r.run === run);
    expect(at.stopAt).toBe(m.stopAt); // same stop rule as export-closeout.cjs
    expect(at.stopKind).toBe(m.stopKind);
    expect(at.board.filter((t) => t.status === "done")).toHaveLength(m.doneBeforeStop);
    expect(at.board.filter((t) => t.status !== "done").map((t) => t.ticketId)).toEqual(m.nonDoneAtStop);
    // Every non-done ticket at the stop is accounted for by production below.
    const w = EXPECTED[run];
    expect([...w.cancelled, ...w.kept, ...w.moved].sort()).toEqual(m.nonDoneAtStop);
  });

  it("TEAM-5231 and TEAM-5264 are blocked at the stop (self-parked), TEAM-5325 and TEAM-5305 in progress", () => {
    const status = (run, id) => loadRun(run).at.board.find((t) => t.ticketId === id).status;
    expect(status("TEAM-5226", "TEAM-5231")).toBe("blocked");
    expect(status("TEAM-5259", "TEAM-5264")).toBe("blocked");
    expect(status("znl7a4", "TEAM-5325")).toBe("in_progress");
    expect(status("o1l3to", "TEAM-5305")).toBe("in_progress");
  });

  it("TEAM-5226's sixth follow-up is TEAM-5237: a human console handoff blocked only by CD TEAM-5234", () => {
    const t = loadRun("TEAM-5226").at.board.find((b) => b.ticketId === "TEAM-5237");
    expect(t.assignee).toBe("human:engineer");
    expect(t.blockedBy).toEqual(["TEAM-5234"]);
    expect(t.status).not.toBe("done");
  });
});

/** Seed the at-stop board (+ the epic row) and POST the real /stop as a signed-in human. */
async function stopAtStop(run) {
  const loaded = loadRun(run);
  const { at, workflow } = loaded;
  seed(loaded, at.board, {
    phase: workflow.previousPhase || "verification",
    agentTasks: structuredClone(at.tasksAtStop),
    humanNotifications: (workflow.humanNotifications || []).filter((n) => n.timestamp < at.stopAt),
  });
  for (const k of ["cancelledAt", "cancelledBy", "cancelReason", "cancelDecision", "postRunEpicKey", "cancelCloseoutPending", "cancelCloseoutCompletedAt"]) delete h.state.workflow[k];
  const epicId = workflow.epicId;
  h.state.board[epicId] = { ticketId: epicId, type: "epic", status: "in_progress", workflowId: h.state.workflow.id };
  const before = structuredClone(h.state.board);
  const savedAuth = process.env.AUTH_MODE;
  process.env.AUTH_MODE = SSO_AUTH_MODE;
  h.state.hub = true;
  let res;
  try {
    res = await stopRun(
      new NextRequest(`http://localhost/api/workflow/${h.state.workflow.id}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json", ...ADMIN_HEADERS },
        body: JSON.stringify({ reason: `replay: stop ${run}` }),
      }),
      { params: { id: h.state.workflow.id } }
    );
  } finally {
    h.state.hub = false;
    if (savedAuth === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = savedAuth;
  }
  return { ...loaded, epicId, before, status: res.status, body: await res.json() };
}

const sorted = (a) => [...a].sort();

describe("Stop the run through the REAL /stop + cancelRun (FR-3, FR-5, FR-8)", () => {
  it.each(RUNS)("%s: exact cancelled / kept / moved ids", async (run) => {
    const w = EXPECTED[run];
    const { body, status, before, epicId, workflow } = await stopAtStop(run);
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "cancelled", decision: "stopped", gatesNotStopped: [], humanGatesLeftOpen: [], closeoutComplete: true });
    expect(sorted(body.gatesStopped)).toEqual(w.gates);
    expect(sorted(body.ticketsLeftRunning)).toEqual(w.kept);
    expect(body.followUpsMoved).toBe(w.moved.length);
    // The sweep's count: non-gate children (gates were cancelled by /stop first) + the epic.
    expect(body.tickets.cancelled).toBe(w.cancelled.length - w.gates.length + (w.epicCancelled ? 1 : 0));

    const children = Object.values(h.state.board).filter((t) => before[t.ticketId] && t.ticketId !== epicId);
    expect(sorted(children.filter((t) => t.status === "cancelled").map((t) => t.ticketId))).toEqual(w.cancelled);
    expect(h.state.board[epicId].status).toBe(w.epicCancelled ? "cancelled" : "in_progress");
    for (const id of w.kept) expect(h.state.board[id].status).toBe(before[id].status);
    // Nothing done before the stop was touched.
    for (const t of Object.values(before)) if (t.status === "done") expect(h.state.board[t.ticketId].status).toBe("done");
    expect(h.state.workflow.phase).toBe("cancelled");
    expect(h.state.workflow.cancelDecision).toBe("stopped");
    expect(tableOfType("workflow.cancelled")).toHaveLength(1);
    // TEAM-5391: the human's decision rides the cancelled event on BOTH sinks.
    const cancelledEb = ebOfType("workflow.cancelled");
    expect(cancelledEb).toHaveLength(1);
    expect(JSON.parse(cancelledEb[0].Detail).decision).toBe("stopped");
    expect(tableOfType("workflow.cancelled")[0].detail.decision).toBe("stopped");
    expect(ebOfType("workflow.complete")).toHaveLength(0);
    expect(tableOfType("workflow.complete")).toHaveLength(0);

    // FR-5: open, unblocked, under one "Post-run follow-ups <workflowId>" epic.
    const epicKey = h.state.workflow.postRunEpicKey;
    if (w.moved.length === 0) {
      expect(epicKey).toBeUndefined();
      return;
    }
    expect(h.state.board[epicKey]).toMatchObject({ title: `Post-run follow-ups ${workflow.workflowId}`, type: "epic" });
    expect(h.state.twinCalls.filter((c) => c.tool === "Tickets___create_ticket")).toHaveLength(1);
    const moved = Object.values(h.state.board).filter((t) => t.parentId === epicKey);
    expect(sorted(moved.map((t) => t.ticketId))).toEqual(w.moved);
    for (const t of moved) {
      expect(t.blockedBy).toEqual([]);
      expect(["done", "cancelled", "blocked"]).not.toContain(t.status);
      expect(t.description).toContain(`MOVED on cancel of ${workflow.workflowId}:`);
    }
    // No ticket left anywhere still waits on the CD ticket.
    expect(Object.values(h.state.board).filter((t) => t.status !== "cancelled" && (t.blockedBy || []).includes(w.cd))).toEqual([]);
  });

  it.each(RUNS)("%s: security follow-ups go to human:engineer and are paged once; no other owner changes", async (run) => {
    const w = EXPECTED[run];
    const { before } = await stopAtStop(run);
    const changed = Object.values(h.state.board).filter((t) => before[t.ticketId] && t.assignee !== before[t.ticketId].assignee);
    expect(changed.map((t) => [t.ticketId, t.assignee])).toEqual(w.security.map((id) => [id, "human:engineer"]));
    const pages = (h.state.workflow.humanNotifications || []).filter((n) => String(n.id).startsWith("notif_followup_security_"));
    expect(pages.map((n) => [n.id, n.type])).toEqual(w.security.map((id) => [`notif_followup_security_${id}`, "manager_escalation"]));
  });

  it("TEAM-5256 is recognised by its title alone: the board carries no security label", async () => {
    const { before } = await stopAtStop("TEAM-5226");
    expect(before["TEAM-5256"].labels).toEqual([]);
    expect(before["TEAM-5256"].title).toMatch(/^Security: CodeBlock\.tsx:78 dangerouslySetInnerHTML/);
    expect(before["TEAM-5256"].assignee).toBe("agentcore_hub_bug_fixer");
    expect(h.state.board["TEAM-5256"].assignee).toBe("human:engineer");
  });
});

describe("after the real stop, the real orchestrator adds no completion", () => {
  /** /stop, then every status change it made, replayed as a stream MODIFY, plus the human's re-Done lever. */
  async function replayCancel(run, rowPhase) {
    const stopped = await stopAtStop(run);
    if (rowPhase === "in-flight") h.state.workflow.phase = stopped.workflow.previousPhase || "verification";
    const changed = Object.values(h.state.board).filter((t) => stopped.before[t.ticketId] && t.status !== stopped.before[t.ticketId].status);
    expect(changed.length).toBeGreaterThan(0);
    for (const k of ["lambdaInvokes", "ebEvents", "events", "updates"]) h.state[k].length = 0;
    await load();
    await mod.handler({ Records: changed.map((t) => streamRecord(h.state.board[t.ticketId], stopped.before[t.ticketId].status)) });
    // The human's re-check lever (dedup re-Done, index.mjs) and a stream re-Done,
    // on the last ticket that was genuinely done before the stop.
    const done = stopped.at.board.filter((t) => t.status === "done").map((t) => t.ticketId);
    const last = done[done.length - 1];
    await mod.handleTicketDoneUnified(last);
    await mod.handleTicketDone(last, h.state.board[last]);
    return stopped;
  }
  function expectNoCompletion() {
    expect(h.state.claims).toEqual([]);
    expect(ebOfType("workflow.complete")).toHaveLength(0);
    expect(tableOfType("workflow.complete")).toHaveLength(0);
    expect(tableOfType("orchestrator.unblocked")).toHaveLength(0);
    expect(agentDispatches()).toHaveLength(0);
    // A stopped run is not escalated as "cannot complete" either (TEAM-3976 hygiene).
    expect(ebOfType("workflow.completion_blocked")).toHaveLength(0);
  }

  it.each(RUNS)("%s: cancelled row + the stop's ticket changes + re-Done → stays cancelled, no workflow.complete", async (run) => {
    await replayCancel(run, "cancelled");
    expectNoCompletion();
    expect(h.state.workflow.phase).toBe("cancelled");
  });

  it.each(RUNS)("%s: same board while the row is still in flight (the cancel CAS not landed) → the board alone refuses", async (run) => {
    const { epicId } = await replayCancel(run, "in-flight");
    expectNoCompletion();
    expect(await mod.isWorkflowComplete(epicId, h.state.workflow)).toBe(false);
  });
});

describe("control: the same run with real Ship + CD records completes exactly once", () => {
  it("o1l3to, every ticket genuinely done with records → one claim, one workflow.complete", async () => {
    const loaded = loadRun("o1l3to");
    const { at, workflow } = loaded;
    const SHIP = "TEAM-5305", MERGE = "TEAM-5306", CD = "TEAM-5307";
    const children = at.board.map((t) => ({ ...t, status: "done" }));
    // The Jira export carries no links; the Merge Approval gate guards the ship phase.
    children.find((t) => t.ticketId === MERGE).blockedBy = [SHIP];
    children.find((t) => t.ticketId === CD).blockedBy = [MERGE];
    const ship = (id, summary) => ({ ticket_id: id, summary, merge_commit: "9f1c2d3", outcome: "shipped", status: "done" });
    loaded.completions = { ...loaded.completions, [SHIP]: ship(SHIP, "PR #94 merged"), [CD]: ship(CD, "deployed 9f1c2d3") };
    const tasks = Object.fromEntries(children.filter((t) => t.ticketId !== CD).map((t) => [t.ticketId, { ...(workflow.agentTasks[t.ticketId] || {}), ticketId: t.ticketId, status: "complete" }]));
    tasks[CD] = { agentId: "agentcore_hub_release_manager", ticketId: CD, status: "running" };
    seed(loaded, children, { phase: "ship", agentTasks: tasks, humanNotifications: [] });
    backHumanGates(children); // Merge Approval TEAM-5306 and gate TEAM-5314 decided for real (TEAM-5380)
    await load();
    const cd = h.state.board[CD];
    await mod.handler({ Records: [streamRecord(cd, "in_progress")] });
    await mod.handler({ Records: [streamRecord(cd, "in_progress")] }); // stream redelivery
    await mod.handleTicketDoneUnified(CD); // and a human re-Done
    expect(h.state.workflow.phase).toBe("complete");
    expect(h.state.terminal).toEqual([]);
    expect(h.state.claims[0]).toBe(h.state.workflow.id); // the first claim won; redeliveries lose the CAS
    expect(ebOfType("workflow.complete")).toHaveLength(1);
  });
});

describe("znl7a4: completion_blocked on the row and no override → refused (FR-2)", () => {
  const OFFENDERS = ["TEAM-5325", "TEAM-5326", "TEAM-5327", "TEAM-5328", "TEAM-5330", "TEAM-5331", "TEAM-5334", "TEAM-5341", "TEAM-5342", "TEAM-5344", "TEAM-5349", "TEAM-5351"];
  const KEY = "workflows/wf_1791220686225_znl7a4/shared/closeout-override.json";
  async function replayForceClose(override, { evidenceLanded = false } = {}) {
    const loaded = loadRun("znl7a4");
    const { at, workflow } = loaded;
    // The board seconds after the operator's Done burst: everything done.
    const children = at.board.map((t) => ({ ...t, status: "done" }));
    const tasks = Object.fromEntries(children.map((t) => [t.ticketId, { ...(workflow.agentTasks[t.ticketId] || {}), ticketId: t.ticketId, status: "complete" }]));
    for (const id of OFFENDERS) {
      delete tasks[id].output; delete tasks[id].artifactKey;
      if (evidenceLanded) loaded.completions[id] = { ticket_id: id, summary: `late record for ${id}`, status: "done" };
    }
    seed(loaded, children, { phase: "review", agentTasks: tasks });
    if (evidenceLanded) backHumanGates(children); // "no offenders now" includes the six done human gates (TEAM-5380)
    if (override) h.state.s3Objects[KEY] = typeof override === "function" ? await override(children, tasks, h.state.workflow) : override;
    expect(h.state.workflow.humanNotifications.map((n) => n.id)).toContain("notif_completion_evidence_wf_1791220686225_znl7a4");
    await load();
    await mod.handleTicketDoneUnified("TEAM-5352"); // the re-Done that closed znl7a4 at 18:11:55Z
  }

  it("no override → no claim, no workflow.complete, the override was looked for", async () => {
    await replayForceClose(null);
    expect(h.state.claims).toEqual([]);
    expect(ebOfType("workflow.complete")).toHaveLength(0);
    expect(h.state.s3Gets).toContain(KEY);
    expect(quiet[2].mock.calls.some((c) => String(c[0]).includes("CompletionRejectedMissingEvidence"))).toBe(true);
  });

  it("the records land late (no offenders now) but the refusal is on the row and no override → still refused", async () => {
    await replayForceClose(null, { evidenceLanded: true });
    expect(h.state.claims).toEqual([]);
    expect(h.state.terminal).toEqual([]);
    expect(ebOfType("workflow.complete")).toHaveLength(0);
    expect(quiet[2].mock.calls.some((c) => String(c[0]).includes("prior refusal on record"))).toBe(true);
  });

  // DL-036: the set /complete would sign — missing evidence ∪ done gate-class tickets
  // with no record of their own — computed by the same exported predicate.
  const signedOverFullSet = async (children, tasks, wf) => {
    const required = workflowsConfig.workflows.find((d) => d.id === wf.workflowDefId).completionRequiresAgentPhases;
    const missing = missingEvidenceTickets(children, tasks, required, { getAgentPhase: (a) => PHASE[a] })
      .filter((m) => !completionRecordHasEvidence(h.state.s3Objects[`completions/${m.ticketId}.json`]));
    const offenders = await closeoutOffenderIds(children, {
      workflowId: wf.id, missingIds: missing.map((m) => m.ticketId), keys: ["test-gate-key"], phaseOf: (t) => t.phase || PHASE[t.assignee],
      readJson: async (k) => h.state.s3Objects[k] ?? null, hasEvidence: completionRecordHasEvidence, liveGate: async () => null,
    });
    expect(offenders).toEqual(expect.arrayContaining(OFFENDERS));
    const rec = { by: "human:ops", reason: "operator force-close of znl7a4", offenders, at: "2026-10-06T18:11:50Z", v: 1, kind: "closeout-override", workflowId: wf.id, offenderSetHash: offenderSetHash(offenders) };
    return { ...rec, sig: createHmac("sha256", "test-gate-key").update(canonicalJson(rec)).digest("base64url") };
  };

  it("an unsigned override naming every offender (the TEAM-5359 shape) is refused", async () => {
    await replayForceClose({ by: "human:ops", reason: "operator force-close of znl7a4", offenders: OFFENDERS, at: "2026-10-06T18:11:50Z" });
    expect(h.state.claims).toEqual([]);
    expect(h.state.terminal).toEqual([]);
    expect(quiet[2].mock.calls.some((c) => String(c[0]).includes("CompletionRejectedMissingEvidence"))).toBe(true);
  });

  it("a verified override naming the full offender set clears FR-2; the unmerged ship then closes static-ci-only, not complete", async () => {
    await replayForceClose(signedOverFullSet);
    expect(quiet[2].mock.calls.some((c) => String(c[0]).includes("CompletionRejectedMissingEvidence"))).toBe(false);
    expect(quiet[0].mock.calls.some((c) => String(c[0]).includes("closeout override by human:ops covers"))).toBe(true);
    // Ship TEAM-5328 / CD TEAM-5330 never merged: the D2 ship-verdict gate owns the outcome.
    expect(h.state.terminal).toEqual(["static-ci-only"]);
    expect(h.state.workflow.phase).toBe("static-ci-only");
    expect(h.state.claims).toEqual([]);
    expect(ebOfType("workflow.complete")).toHaveLength(0);
  });
});

describe("R2 via replay: TEAM-5259's two open human gates, one stopped (FR-8)", () => {
  const MERGE = "TEAM-5266", ESC = "TEAM-5279", CD = "TEAM-5267";
  async function setup() {
    const loaded = loadRun("TEAM-5259");
    const { at } = loaded;
    // At-stop board; the Jira export has no links, so CD's two gate edges are synthesized.
    const children = at.board.map((t) => ({ ...t }));
    Object.assign(children.find((t) => t.ticketId === CD), { status: "blocked", blockedBy: [MERGE, ESC] });
    for (const g of [MERGE, ESC]) children.find((t) => t.ticketId === g).status = "in_review";
    seed(loaded, children, { phase: "verification", agentTasks: structuredClone(at.tasksAtStop) });
    await load();
  }
  const set = async (id, status) => {
    const old = h.state.board[id].status;
    h.state.board[id].status = status;
    await mod.handler({ Records: [streamRecord(h.state.board[id], old)] });
  };
  const unblockedCd = () => tableOfType("orchestrator.unblocked").filter((e) => JSON.stringify(e).includes(CD));

  // (a) holds even without the FR-8 rule (there is no `cancelled` route, so the
  // stop itself cascades nothing); (b) is the case the rule decides.
  it("(a) approve Merge Approval, then stop the escalation → CD stays blocked", async () => {
    await setup();
    await set(MERGE, "done");
    await set(ESC, "cancelled");
    expect(h.state.board[CD].status).toBe("blocked");
    expect(unblockedCd()).toHaveLength(0);
  });

  it("(b) stop the escalation, then approve Merge Approval → CD stays blocked", async () => {
    await setup();
    await set(ESC, "cancelled");
    await set(MERGE, "done");
    expect(h.state.board[CD].status).toBe("blocked");
    expect(unblockedCd()).toHaveLength(0);
  });

  it("(c) approve both → CD readied exactly once", async () => {
    await setup();
    await set(MERGE, "done");
    await set(ESC, "done");
    expect(h.state.board[CD].status).not.toBe("blocked");
    expect(unblockedCd()).toHaveLength(1);
  });
});
