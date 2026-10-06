import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import agentsConfig from "../../src/config/agents.json";
import workflowsConfig from "../../src/config/workflows.json";
import { modelCancel } from "./fixtures/closeout-model.mjs";

/**
 * TEAM-5359 (wf_1791311636588_rfq233) — close-out replays on four real stopped or
 * force-closed runs (fixtures/README.md). Each test builds the board the run had
 * when it was stopped from its exported events, applies the test-only cancel model
 * (fixtures/closeout-model.mjs: FR-3 cancel + FR-5 follow-up moves) and then
 * drives the REAL orchestrator (index.mjs + cascade.mjs, I/O seams mocked, real
 * src/config roster and defs) over the post-cancel board:
 *   - every run ends cancelled and nothing re-opens a completion: no
 *     store.completeWorkflow, no workflow.complete;
 *   - the same run with real Ship + CD records completes exactly once;
 *   - znl7a4's completion_blocked row with no override is refused (FR-2);
 *   - R2: two open human gates, one stopped, never unblock the dependent (FR-8).
 * The counts asserted are the MEASURED ones; the README lists the delta against
 * the design's 9/12/16/>=2 and 5/5/10 targets with ticket ids. All four runs were
 * closed `complete` by an OPERATOR path (closedBy/completeReason on the row), not
 * by the orchestrator: these replays pin that the orchestrator adds no completion
 * of its own; the operator lever is the hub routes' (FR-1/FR-3, api_dev).
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(FIXTURES + name, "utf8"));

const h = vi.hoisted(() => ({
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
  },
}));

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
          if (name === "GetCommand") return { Item: h.state.board[cmd.input.Key?.ticketId] || null };
          if (name === "QueryCommand") {
            if (cmd.input.TableName === "agentcore-hub-events") return { Items: [] };
            const parent = cmd.input.ExpressionAttributeValues?.[":pid"] ?? cmd.input.ExpressionAttributeValues?.[":p"];
            return { Items: Object.values(h.state.board).filter((t) => parent === undefined || t.parentId === parent) };
          }
          if (name === "UpdateCommand") {
            h.state.updates.push(cmd.input);
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
  LambdaClient: class { async send(cmd) { h.state.lambdaInvokes.push(cmd.input); return {}; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
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

process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.SHIP_MERGE_VERIFY = "off"; // no GitHub probe in a replay
delete process.env.GITHUB_PAT;

const RUNS = ["TEAM-5259", "TEAM-5226", "znl7a4", "o1l3to"];
const PHASE = Object.fromEntries((agentsConfig.agents || agentsConfig).map((a) => [a.agentId, a.phase]));
const MANIFEST = fixture("closeout-manifest.json");

function loadRun(run) {
  const workflow = fixture(`workflow-${run}.json`);
  const completions = fixture(`${run}-completions.json`);
  const model = modelCancel({ workflow, events: fixture(`events-${run}.json`), completions, phaseOf: (a) => PHASE[a] });
  return { workflow, completions, model };
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

/** agentTasks as they stood at the stop: done tickets complete, live ones running. */
function tasksAtStop(workflow, board) {
  const out = {};
  for (const t of board) {
    const task = workflow.agentTasks?.[t.ticketId];
    if (!task) continue;
    if (t.status === "done") out[t.ticketId] = { ...task, ticketId: t.ticketId, status: "complete" };
    else if (t.status === "in_progress") {
      const { completedAt: _c, output: _o, ...rest } = task;
      out[t.ticketId] = { ...rest, ticketId: t.ticketId, status: "running" };
    }
  }
  return out;
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
  for (const k of ["lambdaInvokes", "ebEvents", "events", "updates", "claims", "terminal", "s3Gets"]) h.state[k].length = 0;
  quiet = ["log", "warn", "error"].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((s) => s.mockRestore()));

// Measured buckets (README "Cancel model"). Follow-ups that move are NOT counted
// as cancelled; `nonDoneWithout` = cancelled + moved.
const EXPECTED = {
  "TEAM-5259": {
    live: ["TEAM-5264"],
    cancelled: ["TEAM-5265", "TEAM-5266", "TEAM-5267", "TEAM-5279"],
    moved: ["TEAM-5268", "TEAM-5270", "TEAM-5275", "TEAM-5276", "TEAM-5277"],
    cd: "TEAM-5267",
  },
  "TEAM-5226": {
    live: ["TEAM-5231"],
    cancelled: ["TEAM-5232", "TEAM-5233", "TEAM-5234", "TEAM-5258"],
    moved: ["TEAM-5236", "TEAM-5237", "TEAM-5241", "TEAM-5253", "TEAM-5256", "TEAM-5257"],
    cd: "TEAM-5234",
  },
  znl7a4: {
    live: ["TEAM-5325"],
    cancelled: ["TEAM-5326", "TEAM-5327", "TEAM-5328", "TEAM-5329", "TEAM-5330", "TEAM-5331", "TEAM-5352"],
    moved: ["TEAM-5333", "TEAM-5334", "TEAM-5335", "TEAM-5341", "TEAM-5342", "TEAM-5343", "TEAM-5344", "TEAM-5349", "TEAM-5350", "TEAM-5351"],
    cd: "TEAM-5330",
  },
  o1l3to: {
    live: ["TEAM-5305"],
    cancelled: ["TEAM-5306", "TEAM-5307", "TEAM-5314"],
    moved: [],
    cd: "TEAM-5307",
  },
};

describe("cancel model over the four fixtures (FR-3 + FR-5, measured)", () => {
  it.each(RUNS)("%s: buckets", (run) => {
    const { model } = loadRun(run);
    const want = EXPECTED[run];
    const m = MANIFEST.runs.find((r) => r.run === run);
    expect(model.stopAt).toBe(m.stopAt); // same stop rule as export-closeout.cjs
    expect(model.buckets.cdTicketId).toBe(want.cd);
    expect(model.buckets.nonDoneWithCompletion).toEqual([]); // every record holder was done before the stop
    expect(model.buckets.nonDoneLiveSession).toEqual(want.live);
    expect(model.buckets.cancelled).toEqual(want.cancelled);
    expect(model.buckets.followUpsMoved).toEqual(want.moved);
    expect(model.buckets.nonDoneWithout).toEqual([...want.cancelled, ...want.moved].sort());
    // Every non-done ticket was later force-Done by the stop burst, none with a record.
    expect(model.buckets.forceDoneWithoutCompletion).toEqual([...want.live, ...model.buckets.nonDoneWithout].sort());
    expect(model.buckets.doneBeforeStop).toHaveLength(m.doneBeforeStop);
    expect(model.children.some((t) => t.ticketId === model.buckets.epic)).toBe(false);
  });

  it.each(RUNS)("%s: follow-ups move under the post-run epic, unblocked, never Done", (run) => {
    const { model, workflow } = loadRun(run);
    const wfId = workflow.workflowId;
    expect(model.followUpMoves.map((t) => t.ticketId)).toEqual(EXPECTED[run].moved);
    expect(model.postRunEpic.title).toBe(`Post-run follow-ups ${wfId}`);
    for (const t of model.followUpMoves) {
      expect(t.parentId).toBe(model.postRunEpic.ticketId);
      expect(t.blockedBy).toEqual([]);
      expect(["done", "cancelled"]).not.toContain(t.status);
      expect(model.children.some((c) => c.ticketId === t.ticketId)).toBe(false);
    }
  });

  it("TEAM-5256 (security, XSS) is assigned human:engineer; no other follow-up changes owner", () => {
    const changed = RUNS.flatMap((run) => {
      const { model } = loadRun(run);
      return model.followUpMoves.filter((t) => t.assignee !== model.board.find((b) => b.ticketId === t.ticketId).assignee);
    });
    expect(changed.map((t) => [t.ticketId, t.assignee])).toEqual([["TEAM-5256", "human:engineer"]]);
  });

  it("TEAM-5226's sixth follow-up is TEAM-5237: a human console handoff blocked only by CD TEAM-5234", () => {
    const { model } = loadRun("TEAM-5226");
    const t = model.board.find((b) => b.ticketId === "TEAM-5237");
    expect(t.assignee).toBe("human:engineer");
    expect(t.blockedBy).toEqual(["TEAM-5234"]);
    expect(t.status).not.toBe("done");
  });
});

describe("post-cancel replay through the real orchestrator: every run ends cancelled", () => {
  async function replayCancel(run, rowPhase) {
    const loaded = loadRun(run);
    const { model, workflow } = loaded;
    seed(loaded, model.children, {
      phase: rowPhase === "cancelled" ? "cancelled" : workflow.previousPhase || "verification",
      agentTasks: tasksAtStop(workflow, model.board),
      humanNotifications: (workflow.humanNotifications || []).filter((n) => n.timestamp < model.stopAt),
    });
    await load();
    // The cancel route's DynamoDB sweep: one stream MODIFY per cancelled ticket.
    await mod.handler({ Records: model.buckets.cancelled.map((id) => streamRecord(h.state.board[id], "ready")) });
    // The human's re-check lever (dedup re-Done, index.mjs) and a stream re-Done,
    // on the last ticket that was genuinely done before the stop.
    const last = model.buckets.doneBeforeStop[model.buckets.doneBeforeStop.length - 1];
    await mod.handleTicketDoneUnified(last);
    await mod.handleTicketDone(last, h.state.board[last]);
    return model;
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

  it.each(RUNS)("%s: cancelled row + cancelled deliveries + re-Done → stays cancelled, no workflow.complete", async (run) => {
    await replayCancel(run, "cancelled");
    expectNoCompletion();
    expect(h.state.workflow.phase).toBe("cancelled");
  });

  it.each(RUNS)("%s: same board while the row is still in flight (cancel step 2 not landed) → the board alone refuses", async (run) => {
    const model = await replayCancel(run, "in-flight");
    expectNoCompletion();
    expect(await mod.isWorkflowComplete(model.buckets.epic, h.state.workflow)).toBe(false);
  });
});

describe("control: the same run with real Ship + CD records completes exactly once", () => {
  it("o1l3to, every ticket genuinely done with records → one claim, one workflow.complete", async () => {
    const loaded = loadRun("o1l3to");
    const { model, workflow } = loaded;
    const SHIP = "TEAM-5305", MERGE = "TEAM-5306", CD = "TEAM-5307";
    const children = model.board.map((t) => ({ ...t, status: "done" }));
    // The Jira export carries no links; the Merge Approval gate guards the ship phase.
    children.find((t) => t.ticketId === MERGE).blockedBy = [SHIP];
    children.find((t) => t.ticketId === CD).blockedBy = [MERGE];
    const ship = (id, summary) => ({ ticket_id: id, summary, merge_commit: "9f1c2d3", outcome: "shipped", status: "done" });
    loaded.completions = { ...loaded.completions, [SHIP]: ship(SHIP, "PR #94 merged"), [CD]: ship(CD, "deployed 9f1c2d3") };
    const tasks = Object.fromEntries(children.filter((t) => t.ticketId !== CD).map((t) => [t.ticketId, { ...(workflow.agentTasks[t.ticketId] || {}), ticketId: t.ticketId, status: "complete" }]));
    tasks[CD] = { agentId: "agentcore_hub_release_manager", ticketId: CD, status: "running" };
    seed(loaded, children, { phase: "ship", agentTasks: tasks, humanNotifications: [] });
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
    const { model, workflow } = loaded;
    // The board seconds after the operator's Done burst: everything done.
    const children = model.board.map((t) => ({ ...t, status: "done" }));
    const tasks = Object.fromEntries(children.map((t) => [t.ticketId, { ...(workflow.agentTasks[t.ticketId] || {}), ticketId: t.ticketId, status: "complete" }]));
    for (const id of OFFENDERS) {
      delete tasks[id].output; delete tasks[id].artifactKey;
      if (evidenceLanded) loaded.completions[id] = { ticket_id: id, summary: `late record for ${id}`, status: "done" };
    }
    seed(loaded, children, { phase: "review", agentTasks: tasks });
    if (override) h.state.s3Objects[KEY] = override;
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

  it("an override naming every offender clears FR-2; the unmerged ship then closes static-ci-only, not complete", async () => {
    await replayForceClose({ by: "human:ops", reason: "operator force-close of znl7a4", offenders: OFFENDERS, at: "2026-10-06T18:11:50Z" });
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
    const { model, workflow } = loaded;
    // At-stop board; the Jira export has no links, so CD's two gate edges are synthesized.
    const children = model.board.map((t) => ({ ...t }));
    Object.assign(children.find((t) => t.ticketId === CD), { status: "blocked", blockedBy: [MERGE, ESC] });
    for (const g of [MERGE, ESC]) children.find((t) => t.ticketId === g).status = "in_review";
    seed(loaded, children, { phase: "verification", agentTasks: tasksAtStop(workflow, model.board) });
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
