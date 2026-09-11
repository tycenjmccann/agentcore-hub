import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4453 D1 — the orchestrator side of a hub-materialized intake skeleton.
 *
 * The hub now writes the operator run's whole skeleton at start time (BUILD →
 * Merge Approval gate → SHIP) instead of asking the operator to create it in an
 * INTAKE turn. Three things had to change here for that to work, and this file
 * replays the real ztg2xj-shaped stream to pin all three:
 *
 *   1. `ticket.phase` (the hub's stamp) drives phase advancement and the
 *      `agent.invoked` payload — NOT `agentDef.phase`. The operator persona's
 *      roster phase is "development", so under the old comparison its SHIP
 *      ticket could never advance the run past development: agentPhaseIdx ===
 *      currentPhaseIdx. A junk stamp is ignored (phaseOrder.includes guard) so a
 *      bad value can neither reach `agent.invoked` nor freeze advancement.
 *   2. A human gate ticket is published as `ticket.created` (so the board renders
 *      it the moment the hub writes it) but is NEVER written to
 *      `workflow.agentTasks` — nothing will ever dispatch it, and a pending
 *      agentTasks entry would hold completion open forever.
 *   3. The SR-1.1 sentinel release round-trip is inert until the last hop: the
 *      `edit_issue` blocker clear arrives as a same-status MODIFY (blocked →
 *      blocked, swallowed) and only the `unblock` MODIFY (blocked → todo)
 *      dispatches — exactly once.
 *
 * Harness shape is review-rejection.test.mjs's: index.mjs imported for real with
 * only its I/O seams mocked, ARTIFACT_BUCKET set before the import so the S3 mock
 * serves the roster / def / CD registry the run resolves.
 */

const OPERATOR = "agentcore_hub_operator";
const DEV = "agentcore_hub_backend_dev";
const EPIC = "TEAM-100";
const BUILD = "TEAM-101";
const GATE = "TEAM-102";
const SHIP = "TEAM-103";
const REPO_URL = "https://github.com/acme/juno";

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    workflow: /** @type {any} */ (null),
    s3Objects: /** @type {Record<string, string>} */ ({}),
    updates: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    lambdaInvokes: /** @type {any[]} */ ([]),
    tracked: /** @type {any[]} */ ([]),
    claims: /** @type {any[]} */ ([]),
    jira: /** @type {any} */ (null),
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
          if (name === "GetCommand") return { Item: h.state.tickets[cmd.input.Key.ticketId] || null };
          if (name === "ScanCommand") return { Items: [] }; // findCodingSession → none
          if (name === "QueryCommand") {
            if (cmd.input.IndexName === "parentId-index") {
              const pid = cmd.input.ExpressionAttributeValues?.[":pid"];
              return { Items: Object.values(h.state.tickets).filter((t) => t.parentId === pid) };
            }
            return { Items: [] };
          }
          if (name === "UpdateCommand") {
            h.state.updates.push(cmd.input);
            // Keep the in-memory tickets table honest for follow-up reads.
            const t = h.state.tickets[cmd.input.Key?.ticketId];
            const s = cmd.input.ExpressionAttributeValues?.[":s"];
            if (t && s && String(cmd.input.UpdateExpression).includes("#s = :s")) t.status = s;
            return {};
          }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      let payload = null;
      try { payload = JSON.parse(cmd.input.Payload); } catch { /* not a JSON payload */ }
      h.state.lambdaInvokes.push({ FunctionName: cmd.input.FunctionName, payload });
      return { Payload: new TextEncoder().encode(JSON.stringify({ statusCode: 200, body: "{}" })) };
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd.constructor.name !== "GetObjectCommand") return {};
      const body = h.state.s3Objects[cmd.input.Key];
      if (body === undefined) { const e = new Error("The specified key does not exist."); e.name = "NoSuchKey"; throw e; }
      return { Body: { transformToString: async () => body } };
    }
  },
  GetObjectCommand: class { constructor(i) { this.input = i; } },
  PutObjectCommand: class { constructor(i) { this.input = i; } },
  ListObjectsV2Command: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return {}; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class {},
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));

// In-memory store: agentTasks live on h.state.workflow so "the gate never enters
// agentTasks" is observable both as a store call and as final state.
vi.mock("./workflow-store.mjs", () => {
  const tasks = () => {
    const w = h.state.workflow;
    if (!w.agentTasks) w.agentTasks = {};
    return w.agentTasks;
  };
  return {
    initWorkflowStore: vi.fn(() => {}),
    getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
    trackTicket: vi.fn(async (_id, tid, entry) => {
      h.state.tracked.push({ ticketId: tid, entry });
      const t = tasks();
      if (t[tid]) return false;
      t[tid] = { ...entry };
      return true;
    }),
    claimInvocation: vi.fn(async (_id, tid, entry, staleBefore) => {
      const t = tasks();
      const cur = t[tid];
      const ok = !cur || cur.status !== "running" || (cur.startedAt || "") < staleBefore;
      h.state.claims.push({ ticketId: tid, ok });
      if (ok) t[tid] = { ...entry };
      return ok;
    }),
    advancePhase: vi.fn(async (_id, phase, featureBranch) => {
      h.state.workflow.phase = phase;
      if (featureBranch) h.state.workflow.featureBranch = featureBranch;
    }),
    setTaskStatus: vi.fn(async () => {}),
    putTaskEntry: vi.fn(async () => {}),
    completeTaskEntry: vi.fn(async () => {}),
    mergeTaskMetadata: vi.fn(async () => {}),
    adoptFeatureBranch: vi.fn(async () => {}),
    setResumeContext: vi.fn(async () => {}),
    removeResumeContext: vi.fn(async () => {}),
    setRepoCheck: vi.fn(async () => {}),
    ackNotifications: vi.fn(async () => {}),
    appendNotification: vi.fn(async () => {}),
    appendReviewNotificationOnce: vi.fn(async () => true),
    resetDeadSessionRetry: vi.fn(async () => {}),
    claimTerminalOutcome: vi.fn(async () => false),
    claimFinalization: vi.fn(async () => false),
    markFinalized: vi.fn(async () => {}),
    completeWorkflow: vi.fn(async () => {}),
    setDelivery: vi.fn(async () => {}),
    appendReviewRound: vi.fn(async () => {}),
  };
});

// ─── The live config the run resolves (mirrors src/config/*.json) ────────────

// The operator persona's roster phase is "development" — the whole point of the
// fix is that its SHIP ticket must still advance the run to "ship".
const AGENTS_CONFIG = JSON.stringify({
  agents: [
    { agentId: OPERATOR, phase: "development", workflowDefIds: ["operator"] },
    { agentId: DEV, phase: "development" },
  ],
});

// The `operator` def as src/config/workflows.json declares it → the derived
// phaseOrder is ["intake", "development", "ship", "complete"].
const WORKFLOWS_CONFIG = JSON.stringify({
  workflows: [
    {
      id: "operator",
      intakeAgentId: OPERATOR,
      featureBranchPhase: null,
      createsPullRequest: true,
      intakeMaterialization: "hub",
      completionRequiresAgentPhases: ["development", "ship"],
      reviewGates: [
        { afterPhase: "development", name: "Merge Approval", blocking: true, condition: "always", onReject: "rework", assignee: "human:engineer" },
      ],
      phases: [
        { id: "intake", name: "Intake", agentPhase: "intake" },
        { id: "build", name: "Build", agentPhase: "development" },
        { id: "ship", name: "Ship", agentPhase: "ship", agentId: OPERATOR },
      ],
    },
  ],
});

const REGISTERED = JSON.stringify({ version: 1, repos: [{ repo: "acme/juno", pipeline: "juno-deploy", region: "us-west-2" }] });

// ─── Stream-record helpers (real DynamoDB Streams shapes) ────────────────────

const S = (v) => ({ S: v });
const L = (arr) => ({ L: arr.map((v) => ({ S: v })) });

/** An image for one skeleton ticket. `phase` is the hub's stamp. */
function image(ticketId, { assignee, status, blockedBy = [], phase, title }) {
  const img = {
    ticketId: S(ticketId), status: S(status), assignee: S(assignee), title: S(title),
    parentId: S(EPIC), workflowId: S("wf_1"), type: S("task"), blockedBy: L(blockedBy),
  };
  if (phase !== undefined) img.phase = S(phase);
  return img;
}
const buildImage = (status, blockedBy, phase = "development") =>
  image(BUILD, { assignee: OPERATOR, status, blockedBy, phase, title: `Build: ${OPERATOR} — Add a retry to the uploader` });
const gateImage = (status, blockedBy = [BUILD]) =>
  image(GATE, { assignee: "human:engineer", status, blockedBy, phase: "development", title: "Merge Approval: Add a retry to the uploader" });
const shipImage = (status, blockedBy = [GATE]) =>
  image(SHIP, { assignee: OPERATOR, status, blockedBy, phase: "ship", title: `Ship: ${OPERATOR} — Add a retry to the uploader` });

const record = (eventName, NewImage, OldImage) => ({
  Records: [{ eventName, eventSource: "aws:dynamodb", dynamodb: OldImage ? { NewImage, OldImage } : { NewImage } }],
});

const eventsOf = (type) => h.state.events.filter((e) => e.type === type);
const invokedFor = (ticketId) => eventsOf("agent.invoked").filter((e) => e.detail.ticketId === ticketId);
const dispatchesFor = (ticketId) => h.state.lambdaInvokes.filter((i) => i.payload?.ticketId === ticketId);

let handler, storeMock;

async function load({ provider = "dynamodb" } = {}) {
  h.state.s3Objects = {
    "config/agents.json": AGENTS_CONFIG,
    "config/workflows.json": WORKFLOWS_CONFIG,
    "config/cd-registry.json": REGISTERED,
  };
  if (provider === "jira") {
    process.env.TICKET_PROVIDER = "jira";
    process.env.JIRA_SITE_URL = "jira.test";
    process.env.JIRA_EMAIL = "bot@test";
    process.env.JIRA_API_TOKEN = "t";
  } else {
    delete process.env.TICKET_PROVIDER;
  }
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
  storeMock = await import("./workflow-store.mjs");
  await handler({ Records: [] }); // primes the roster / def / registry caches
}

// index.mjs snapshots ARTIFACT_BUCKET at module load, so it must be set before
// the dynamic import above (loadCdRegistry early-returns without it).
process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.REPO_CHECK_MODE = "off";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  h.state.updates.length = 0;
  h.state.events.length = 0;
  h.state.lambdaInvokes.length = 0;
  h.state.tracked.length = 0;
  h.state.claims.length = 0;
  h.state.jira = null;
  // R6a: the hub seeds the row in "intake", so the first dispatch genuinely
  // advances the run (and emits the first workflow.phase_change).
  h.state.workflow = {
    id: "wf_1", epicId: EPIC, workflowDefId: "operator", phase: "intake",
    input: { title: "Add a retry to the uploader", description: "It fails on 502." },
    agentTasks: {}, humanNotifications: [], resumeContexts: {},
    repoConfig: { layout: "multi-repo", repos: [{ platform: "shared", url: REPO_URL, defaultBranch: "main" }] },
  };
  h.state.tickets = {
    [EPIC]: { ticketId: EPIC, workflowId: "wf_1", type: "epic", status: "in_progress", title: "Add a retry to the uploader" },
    [BUILD]: { ticketId: BUILD, parentId: EPIC, workflowId: "wf_1", assignee: OPERATOR, type: "task", status: "blocked", phase: "development", blockedBy: [EPIC], title: `Build: ${OPERATOR} — Add a retry to the uploader`, description: "Created by the hub at intake" },
    [GATE]: { ticketId: GATE, parentId: EPIC, workflowId: "wf_1", assignee: "human:engineer", type: "task", status: "blocked", phase: "development", blockedBy: [BUILD], labels: ["human-review", "reviewer:engineer", "gate:merge-approval"], title: "Merge Approval: Add a retry to the uploader" },
    [SHIP]: { ticketId: SHIP, parentId: EPIC, workflowId: "wf_1", assignee: OPERATOR, type: "task", status: "blocked", phase: "ship", blockedBy: [GATE], title: `Ship: ${OPERATOR} — Add a retry to the uploader` },
  };
  for (const a of [OPERATOR, DEV]) {
    process.env[`RUNTIME_ARN_${a.toUpperCase()}`] = `arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/${a}`;
  }
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  delete process.env.TICKET_PROVIDER;
  delete process.env.JIRA_SITE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
  for (const a of [OPERATOR, DEV]) delete process.env[`RUNTIME_ARN_${a.toUpperCase()}`];
});

/**
 * The ztg2xj write sequence as the stream delivers it: three INSERTs (item 0
 * behind the epic sentinel, the gate and ship behind their upstreams), then the
 * release pair on item 0.
 */
async function replaySkeletonWrites() {
  await handler(record("INSERT", buildImage("blocked", [EPIC])));
  await handler(record("INSERT", gateImage("blocked")));
  await handler(record("INSERT", shipImage("blocked")));
  // Sentinel release, step 1 — edit_issue clears blockedBy and leaves status
  // alone, so the MODIFY is same-status.
  await handler(record("MODIFY", buildImage("blocked", []), buildImage("blocked", [EPIC])));
  h.state.tickets[BUILD].blockedBy = [];
}

/** Sentinel release, step 2 — the `unblock` transition: blocked → todo. */
async function replaySentinelUnblock() {
  h.state.tickets[BUILD].status = "todo";
  await handler(record("MODIFY", buildImage("todo", []), buildImage("blocked", [])));
}

// ─── 1. The full replay ──────────────────────────────────────────────────────

describe("1. hub-materialized operator skeleton — the ztg2xj replay (DDB streams)", () => {
  beforeEach(async () => { await load(); });

  it("dispatches the build exactly ONCE, at phase development, and only on the unblock hop", async () => {
    await replaySkeletonWrites();

    // Nothing dispatched from the three INSERTs or the same-status clear: the
    // skeleton is written blocked, and the blocker clear is not a status change.
    expect(invokedFor(BUILD)).toHaveLength(0);
    expect(h.state.lambdaInvokes).toHaveLength(0);
    expect(eventsOf("workflow.phase_change")).toHaveLength(0);
    expect(h.state.workflow.phase).toBe("intake");

    await replaySentinelUnblock();

    expect(invokedFor(BUILD)).toHaveLength(1);
    expect(invokedFor(BUILD)[0].detail.phase).toBe("development");
    expect(invokedFor(BUILD)[0].detail.agentId).toBe(OPERATOR);
    expect(dispatchesFor(BUILD)).toHaveLength(1);
    expect(h.state.claims.filter((c) => c.ticketId === BUILD && c.ok)).toHaveLength(1);
  });

  it("advances intake → development → ship off ticket.phase: exactly 2 phase_change events, in order", async () => {
    await replaySkeletonWrites();
    await replaySentinelUnblock();

    expect(h.state.workflow.phase).toBe("development");

    // Build done, gate approved → the cascade Readies ship.
    h.state.tickets[BUILD].status = "done";
    h.state.tickets[GATE].status = "done";
    h.state.tickets[SHIP].status = "todo";
    h.state.tickets[SHIP].blockedBy = [];
    await handler(record("MODIFY", shipImage("todo", []), shipImage("blocked")));

    expect(invokedFor(SHIP)).toHaveLength(1);
    expect(dispatchesFor(SHIP)).toHaveLength(1);

    const changes = eventsOf("workflow.phase_change");
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(changes.map((e) => e.detail.phase)).toEqual(["development", "ship"]);
    expect(invokedFor(BUILD)[0].detail.phase).toBe("development");
    expect(invokedFor(SHIP)[0].detail.phase).toBe("ship");
    expect(h.state.workflow.phase).toBe("ship");
  });
});

// ─── 2. The pre-fix control ──────────────────────────────────────────────────

/**
 * PRE-FIX CONTROL. `agentcore_hub_operator`'s roster phase is "development", so
 * the old `agentDef.phase` comparison gave agentPhaseIdx === currentPhaseIdx for
 * the SHIP ticket: no advance, no workflow.phase_change, and `agent.invoked`
 * mislabelled the ship turn as "development". Both assertions below are
 * unreachable without the ticket.phase read.
 */
describe("2. a SHIP-phase ticket assigned to a development-phase persona still advances to ship", () => {
  beforeEach(async () => { await load(); });

  it("advances development → ship (impossible under the agentDef.phase comparison)", async () => {
    h.state.workflow.phase = "development";
    h.state.tickets[SHIP].status = "todo";
    h.state.tickets[SHIP].blockedBy = [];

    await handler(record("MODIFY", shipImage("todo", []), shipImage("blocked")));

    // The persona says development; the hub's stamp says ship, and the stamp wins.
    expect(invokedFor(SHIP)[0].detail.phase).toBe("ship");
    expect(eventsOf("workflow.phase_change").map((e) => e.detail.phase)).toEqual(["ship"]);
    expect(h.state.workflow.phase).toBe("ship");
  });
});

// ─── 3. The human gate ───────────────────────────────────────────────────────

describe("3. the human gate is published but never tracked as an agent task", () => {
  beforeEach(async () => { await load(); });

  it("gate INSERT → ticket.created with agentId null and the config assignee; ZERO trackTicket calls", async () => {
    await handler(record("INSERT", gateImage("blocked")));

    const created = eventsOf("ticket.created").filter((e) => e.detail.ticket.id === GATE);
    expect(created).toHaveLength(1);
    expect(created[0].detail.ticket).toMatchObject({
      id: GATE,
      assignee: "human:engineer",
      agentId: null, // no agent will ever run it
      parent: EPIC,
      status: "blocked",
    });
    expect(created[0].detail.workflowId).toBe("wf_1");

    // The load-bearing half: nothing entered agentTasks, so completion is not
    // held open by a "pending" entry no dispatcher will ever advance.
    expect(h.state.tracked.filter((t) => t.ticketId === GATE)).toEqual([]);
    expect(storeMock.trackTicket).not.toHaveBeenCalledWith("wf_1", GATE, expect.anything());
    expect(h.state.workflow.agentTasks[GATE]).toBeUndefined();

    // And the creation-time block is still not read as a "Request changes".
    expect(eventsOf("review.rejected")).toHaveLength(0);
  });

  it("an AGENT ticket's INSERT is still tracked, exactly as before", async () => {
    await handler(record("INSERT", buildImage("blocked", [EPIC])));

    expect(h.state.tracked.map((t) => t.ticketId)).toEqual([BUILD]);
    expect(h.state.workflow.agentTasks[BUILD]).toMatchObject({ agentId: OPERATOR, status: "pending" });
    const created = eventsOf("ticket.created").filter((e) => e.detail.ticket.id === BUILD);
    expect(created[0].detail.ticket.agentId).toBe(OPERATOR);
  });
});

// ─── 4. The junk-stamp guard ─────────────────────────────────────────────────

describe("4. a stamp that is not a phase of the def is ignored (never reaches agent.invoked)", () => {
  beforeEach(async () => { await load(); });

  it('phase "zz_bogus" falls back to agentDef.phase and still advances the run', async () => {
    h.state.tickets[BUILD].status = "todo";
    h.state.tickets[BUILD].blockedBy = [];

    await handler(record("MODIFY", buildImage("todo", [], "zz_bogus"), buildImage("blocked", [])));

    // Without the phaseOrder.includes guard this would publish "zz_bogus" and
    // indexOf === -1 would freeze the run in "intake" forever.
    expect(invokedFor(BUILD)).toHaveLength(1);
    expect(invokedFor(BUILD)[0].detail.phase).toBe("development");
    expect(eventsOf("workflow.phase_change").map((e) => e.detail.phase)).toEqual(["development"]);
    expect(h.state.workflow.phase).toBe("development");
  });

  it("no stamp at all → agentDef.phase, byte-identical to pre-TEAM-4453 behaviour", async () => {
    h.state.tickets[BUILD].status = "todo";
    h.state.tickets[BUILD].blockedBy = [];
    const unstamped = buildImage("todo", []);
    delete unstamped.phase;

    await handler(record("MODIFY", unstamped, buildImage("blocked", [])));

    expect(invokedFor(BUILD)[0].detail.phase).toBe("development");
    expect(h.state.workflow.phase).toBe("development");
  });
});

// ─── 5. Unknown assignee ─────────────────────────────────────────────────────

describe("5. an assignee that is neither a roster agent nor human:* is still ignored", () => {
  beforeEach(async () => { await load(); });

  it("no ticket.created, no trackTicket — the widened guard did not widen this far", async () => {
    await handler(record("INSERT", image("TEAM-199", {
      assignee: "someone_who_left", status: "blocked", blockedBy: [BUILD], phase: "development", title: "Mystery",
    })));

    expect(eventsOf("ticket.created")).toHaveLength(0);
    expect(h.state.tracked).toEqual([]);
    expect(storeMock.trackTicket).not.toHaveBeenCalled();
    expect(h.state.workflow.agentTasks["TEAM-199"]).toBeUndefined();
  });
});

// ─── 6. The Jira twin ────────────────────────────────────────────────────────

/**
 * Jira has no arbitrary columns, so the hub carries the stamp as the `phase:<p>`
 * label the jira Lambda already round-trips (mapJiraIssueToTicket rebuilds
 * `ticket.phase` from it). The unified handler must read it the same way the DDB
 * twin reads `image.phase`.
 */
describe("6. Jira twin — the phase:<p> label drives the dispatch", () => {
  const jsonResp = (obj, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(obj) });
  const jiraIssue = (key, { assignee, status, labels, blockedBy = [], summary }) => ({
    key,
    fields: {
      summary,
      status: { name: status },
      labels: [`agent:${assignee}`, "wf:wf_1", ...labels],
      issuetype: { name: "Task" },
      parent: { key: EPIC },
      issuelinks: blockedBy.map((k) => ({ type: { inward: "is blocked by" }, inwardIssue: { key: k } })),
      comment: { comments: [] },
    },
  });

  function installRouter(issues) {
    h.state.jira = { transitionPosts: [] };
    global.fetch = vi.fn(async (url, init = {}) => {
      const u = String(url);
      const method = (init.method || "GET").toUpperCase();
      const m = u.match(/\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/transitions|\/comment)?/);
      if (!m) return jsonResp({});
      const [, key, sub] = m;
      if (sub === "/transitions") {
        if (method === "GET") return jsonResp({ transitions: [{ id: "31", name: "In Progress", to: { name: "In Progress" } }] });
        h.state.jira.transitionPosts.push(key);
        return { ok: true, status: 204, text: async () => "" };
      }
      if (sub === "/comment") return jsonResp({}, 201);
      return issues[key] ? jsonResp(issues[key]) : { ok: false, status: 404, text: async () => "not found" };
    });
  }

  beforeEach(async () => { await load({ provider: "jira" }); });

  it('a Ready ship issue labelled phase:ship advances the run to ship', async () => {
    h.state.workflow.phase = "development";
    installRouter({
      [SHIP]: jiraIssue(SHIP, {
        assignee: OPERATOR, status: "Ready", labels: ["phase:ship"], summary: `Ship: ${OPERATOR} — Add a retry to the uploader`,
      }),
    });

    await handler({ source: "jira-webhook", ticketId: SHIP, newStatus: "ready", oldStatus: "blocked" });

    expect(invokedFor(SHIP)).toHaveLength(1);
    expect(invokedFor(SHIP)[0].detail.phase).toBe("ship");
    expect(eventsOf("workflow.phase_change").map((e) => e.detail.phase)).toEqual(["ship"]);
    expect(h.state.workflow.phase).toBe("ship");
    expect(h.state.jira.transitionPosts).toContain(SHIP); // → In Progress
  });

  it("a junk phase: label is ignored there too", async () => {
    installRouter({
      [BUILD]: jiraIssue(BUILD, {
        assignee: OPERATOR, status: "Ready", labels: ["phase:zz_bogus"], summary: `Build: ${OPERATOR} — Add a retry to the uploader`,
      }),
    });

    await handler({ source: "jira-webhook", ticketId: BUILD, newStatus: "ready", oldStatus: "blocked" });

    expect(invokedFor(BUILD)[0].detail.phase).toBe("development");
    expect(h.state.workflow.phase).toBe("development");
  });
});
