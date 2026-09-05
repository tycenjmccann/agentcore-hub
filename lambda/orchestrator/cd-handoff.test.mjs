import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * CD registry → delivery mode, end-to-end through the REAL index.mjs.
 *
 * A repo that is NOT in the hub's CD registry is HANDOFF: the hub never merges
 * or deploys it. Concretely —
 *   1. dispatch: a ship-phase agent ticket (release manager) that becomes Ready
 *      is resolved Done with a comment, never claimed/invoked;
 *   2. gates: a Merge Approval (ship-phase) human gate is resolved Done, never
 *      parked in review / paged;
 *   3. context: the intake agent is told CD_REGISTERED: false, is NOT offered
 *      ship-phase personas, and gets NO ship gate in ## Human Review Gates;
 *      no ## Pipeline Mode block is emitted for the repo;
 *   4. completion: the run completes without a ship phase and the orchestrator
 *      opens the unified PR with the handoff body, recording delivery=handoff.
 * A registered repo keeps every one of those behaviours as they were.
 *
 * Only the I/O seams are mocked (AWS SDK clients, workflow-store); the S3 mock
 * serves config/cd-registry.json so each test picks the registry it wants.
 */

const EPIC = "EPIC-1";
const RM = "agentcore_hub_release_manager";
const INTAKE = "agentcore_hub_requirements_analyst";
const DEV = "agentcore_hub_backend_dev";
const REPO_URL = "https://github.com/acme/juno";

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    s3Objects: /** @type {Record<string, string>} */ ({}),
    updates: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    lambdaInvokes: /** @type {any[]} */ ([]),
    claims: /** @type {any[]} */ ([]),
    notifications: /** @type {any[]} */ ([]),
    completions: /** @type {any[]} */ ([]),
    deliveries: /** @type {any[]} */ ([]),
    githubCalls: /** @type {any[]} */ ([]),
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
          if (name === "QueryCommand") {
            if (cmd.input.TableName === "agentcore-hub-events") return { Items: [] };
            return { Items: h.state.children };
          }
          if (name === "ScanCommand") return { Items: [] };
          if (name === "UpdateCommand") {
            h.state.updates.push(cmd.input);
            // keep the in-memory ticket honest for follow-up reads
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
      h.state.lambdaInvokes.push(cmd.input);
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

vi.mock("./workflow-store.mjs", () => ({
  initWorkflowStore: vi.fn(() => {}),
  getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
  claimInvocation: vi.fn(async (wfId, tid, entry) => { h.state.claims.push({ wfId, tid, entry }); return true; }),
  putTaskEntry: vi.fn(async () => {}),
  trackTicket: vi.fn(async () => {}),
  setTaskStatus: vi.fn(async () => {}),
  completeTaskEntry: vi.fn(async (wfId, tid, entry) => { if (h.state.workflow?.agentTasks) h.state.workflow.agentTasks[tid] = entry; }),
  mergeTaskMetadata: vi.fn(async () => {}),
  advancePhase: vi.fn(async () => {}),
  adoptFeatureBranch: vi.fn(async () => {}),
  setResumeContext: vi.fn(async () => {}),
  removeResumeContext: vi.fn(async () => {}),
  setRepoCheck: vi.fn(async () => {}),
  appendReviewNotificationOnce: vi.fn(async (wfId, tid, n) => { h.state.notifications.push(n); return true; }),
  appendNotification: vi.fn(async () => {}),
  ackNotifications: vi.fn(async () => {}),
  completeWorkflow: vi.fn(async (id, ts) => { h.state.completions.push({ id, ts }); return true; }),
  claimTerminalOutcome: vi.fn(async () => true),
  claimFinalization: vi.fn(async () => false),
  markFinalized: vi.fn(async () => {}),
  setDelivery: vi.fn(async (id, d) => { h.state.deliveries.push({ id, d }); }),
}));

process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.REPO_CHECK_MODE = "off";
process.env.GITHUB_PAT = "ghp_test";

const AGENTS_CONFIG = JSON.stringify({
  agents: [
    { agentId: INTAKE, phase: "requirements" },
    { agentId: DEV, phase: "development" },
    { agentId: "agentcore_hub_qa_verifier", phase: "verification" },
    { agentId: "agentcore_hub_ci_agent", phase: "review" },
    { agentId: RM, phase: "ship" },
  ],
});

const WORKFLOWS_CONFIG = JSON.stringify({
  workflows: [
    {
      id: "software-delivery",
      intakeAgentId: INTAKE,
      featureBranchPhase: "development",
      createsPullRequest: true,
      completionRequiresAgentPhases: ["development", "verification", "review", "ship"],
      reviewGates: [
        { afterPhase: "design", name: "Plan Approval", blocking: true, condition: "flagged", assignee: "human:engineer" },
        { afterPhase: "ship", name: "Merge Approval", blocking: true, condition: "always", assignee: "human:engineer" },
      ],
      phases: [
        { agentPhase: "requirements" },
        { agentPhase: "development" },
        { agentPhase: "verification", extraAgentPhases: ["review", "ship"] },
      ],
    },
  ],
});

const REGISTERED = JSON.stringify({ version: 1, repos: [{ repo: "acme/juno", pipeline: "juno-deploy", region: "us-west-2" }] });
const EMPTY = JSON.stringify({ version: 1, repos: [] });

function makeWorkflow(extra = {}) {
  return {
    id: "wf_1",
    workflowId: "wf_1",
    phase: "verification",
    epicId: EPIC,
    workflowDefId: "software-delivery",
    input: { title: "Highlight reel", description: "d" },
    repoConfig: { layout: "multi-repo", repos: [{ platform: "shared", url: REPO_URL, defaultBranch: "main" }] },
    featureBranch: "feature/EPIC-1-highlight-reel",
    agentTasks: {},
    humanNotifications: [],
    ...extra,
  };
}

let handler, buildAgentContext, completeWorkflow, isWorkflowComplete;

async function load(registry) {
  h.state.s3Objects = {
    "config/agents.json": AGENTS_CONFIG,
    "config/workflows.json": WORKFLOWS_CONFIG,
    ...(registry === undefined ? {} : { "config/cd-registry.json": registry }),
  };
  vi.resetModules();
  ({ handler, buildAgentContext, completeWorkflow, isWorkflowComplete } = await import("./index.mjs"));
  await handler({ Records: [] }); // primes roster / defs / registry caches
}

/** A ticket whose last blocker just closed → the DDB stream's MODIFY to ready. */
function readyRecord(ticketId) {
  const t = h.state.tickets[ticketId];
  return {
    Records: [{
      eventName: "MODIFY",
      dynamodb: {
        NewImage: { ticketId, status: "ready", assignee: t.assignee, parentId: t.parentId, workflowId: t.workflowId, type: "task", blockedBy: [] },
        OldImage: { ticketId, status: "blocked" },
      },
    }],
  };
}

const statusWrites = (ticketId, status) =>
  h.state.updates.filter((u) => u.Key?.ticketId === ticketId && u.ExpressionAttributeValues?.[":s"] === status);
const comments = (ticketId) =>
  h.state.updates.filter((u) => u.Key?.ticketId === ticketId && String(u.UpdateExpression).includes("list_append"));
const eventsOf = (type) => h.state.events.filter((e) => e.type === type);

beforeEach(() => {
  h.state.updates.length = 0;
  h.state.events.length = 0;
  h.state.lambdaInvokes.length = 0;
  h.state.claims.length = 0;
  h.state.notifications.length = 0;
  h.state.completions.length = 0;
  h.state.deliveries.length = 0;
  h.state.githubCalls.length = 0;
  h.state.children = [];
  h.state.workflow = makeWorkflow();
  h.state.tickets = {
    "TEAM-7": { ticketId: "TEAM-7", parentId: EPIC, workflowId: "wf_1", assignee: RM, type: "task", status: "ready", title: "Ship: Highlight reel", blockedBy: [] },
    "TEAM-8": { ticketId: "TEAM-8", parentId: EPIC, workflowId: "wf_1", assignee: "human:engineer", type: "task", status: "ready", title: "Merge Approval", labels: ["human-review", "reviewer:engineer"], blockedBy: ["TEAM-7"] },
    "TEAM-3": { ticketId: "TEAM-3", parentId: EPIC, workflowId: "wf_1", assignee: DEV, type: "task", status: "ready", title: "Backend", blockedBy: [] },
    "TEAM-0": { ticketId: "TEAM-0", parentId: EPIC, workflowId: "wf_1", assignee: INTAKE, type: "task", status: "ready", title: "Requirements", description: "plan it" },
  };
});

const ORIGINAL_FETCH = global.fetch;
afterEach(() => { global.fetch = ORIGINAL_FETCH; });

describe("1. dispatch — ship-phase agent ticket", () => {
  it("HANDOFF (repo not registered): resolved Done with a comment + cd.handoff_skip; never claimed or invoked", async () => {
    await load(EMPTY);
    await handler(readyRecord("TEAM-7"));

    expect(statusWrites("TEAM-7", "done")).toHaveLength(1);
    expect(statusWrites("TEAM-7", "in_progress")).toHaveLength(0);
    expect(h.state.claims).toHaveLength(0);
    expect(h.state.lambdaInvokes).toHaveLength(0);
    const note = comments("TEAM-7");
    expect(note).toHaveLength(1);
    expect(note[0].ExpressionAttributeValues[":n"][0].content).toContain("not in the hub's CD registry");
    expect(note[0].ExpressionAttributeValues[":n"][0].content).toContain("left OPEN for the owning team");
    const ev = eventsOf("cd.handoff_skip");
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toMatchObject({ ticketId: "TEAM-7", workflowId: "wf_1", kind: "ship_ticket", assignee: RM });
  });

  it("HANDOFF when no registry document exists at all (fresh install / S3 key absent)", async () => {
    await load(undefined);
    await handler(readyRecord("TEAM-7"));
    expect(statusWrites("TEAM-7", "done")).toHaveLength(1);
    expect(h.state.claims).toHaveLength(0);
  });

  it("CD (repo registered): the ship ticket is claimed and dispatched like any other", async () => {
    await load(REGISTERED);
    await handler(readyRecord("TEAM-7"));

    expect(statusWrites("TEAM-7", "done")).toHaveLength(0);
    expect(h.state.claims.map((c) => c.tid)).toEqual(["TEAM-7"]);
    expect(statusWrites("TEAM-7", "in_progress")).toHaveLength(1);
    expect(eventsOf("cd.handoff_skip")).toHaveLength(0);
  });

  it("non-ship tickets on a HANDOFF run dispatch normally (only the ship phase is removed)", async () => {
    await load(EMPTY);
    await handler(readyRecord("TEAM-3"));
    expect(h.state.claims.map((c) => c.tid)).toEqual(["TEAM-3"]);
    expect(statusWrites("TEAM-3", "done")).toHaveLength(0);
    expect(eventsOf("cd.handoff_skip")).toHaveLength(0);
  });
});

describe("2. gates — Merge Approval (ship-phase human gate)", () => {
  it("HANDOFF: resolved Done, not parked in_review, nobody paged", async () => {
    await load(EMPTY);
    await handler(readyRecord("TEAM-8"));

    expect(statusWrites("TEAM-8", "done")).toHaveLength(1);
    expect(statusWrites("TEAM-8", "in_review")).toHaveLength(0);
    expect(h.state.notifications).toHaveLength(0);
    expect(eventsOf("review.needed")).toHaveLength(0);
    const ev = eventsOf("cd.handoff_skip");
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toMatchObject({ ticketId: "TEAM-8", kind: "ship_gate", phase: "ship" });
    expect(comments("TEAM-8")[0].ExpressionAttributeValues[":n"][0].content).toContain("merge-approval gate does not apply");
  });

  it("CD: the gate parks in_review and pages the reviewer as before", async () => {
    await load(REGISTERED);
    await handler(readyRecord("TEAM-8"));

    expect(statusWrites("TEAM-8", "in_review")).toHaveLength(1);
    expect(statusWrites("TEAM-8", "done")).toHaveLength(0);
    expect(h.state.notifications).toHaveLength(1);
    expect(eventsOf("review.needed")).toHaveLength(1);
  });

  it("HANDOFF does not touch a NON-ship gate (Plan Approval after design still pages)", async () => {
    await load(EMPTY);
    h.state.tickets["TEAM-5"] = { ticketId: "TEAM-5", parentId: EPIC, workflowId: "wf_1", assignee: "agentcore_hub_frontend_designer", type: "task", status: "done" };
    h.state.tickets["TEAM-6"] = { ticketId: "TEAM-6", parentId: EPIC, workflowId: "wf_1", assignee: "human:engineer", type: "task", status: "ready", labels: ["human-review"], blockedBy: ["TEAM-5"] };
    await handler(readyRecord("TEAM-6"));
    expect(statusWrites("TEAM-6", "in_review")).toHaveLength(1);
    expect(statusWrites("TEAM-6", "done")).toHaveLength(0);
    expect(eventsOf("review.needed")).toHaveLength(1);
  });
});

describe("3. intake context — Delivery Mode, roster, gates, Pipeline Mode", () => {
  const intakeTicket = () => h.state.tickets["TEAM-0"];

  it("HANDOFF: CD_REGISTERED false, release manager NOT offered, ship gate absent, no Pipeline Mode", async () => {
    process.env.PIPELINE_ENABLED = "1";
    await load(EMPTY);
    const ctx = await buildAgentContext(intakeTicket(), h.state.workflow);
    delete process.env.PIPELINE_ENABLED;

    expect(ctx).toContain("## Delivery Mode\nCD_REGISTERED: false");
    expect(ctx).toContain("acme/juno is NOT in the hub's CD registry");
    expect(ctx).toContain("do NOT create Ship, Merge Approval or CD tickets");
    // roster: every non-ship persona, but not the release manager
    expect(ctx).toContain(`"${DEV}" (development)`);
    expect(ctx).toContain(`"agentcore_hub_ci_agent" (review)`);
    expect(ctx).not.toContain(RM);
    // gates: the always-on ship gate is gone (the only mention of "Merge
    // Approval" left is the Delivery Mode rule telling intake NOT to create it);
    // the flagged design gate is simply not requested by this run.
    expect(ctx).not.toContain('After phase "ship"');
    expect(ctx).not.toContain("## Human Review Gates");
    expect(ctx).not.toContain("## Pipeline Mode");
  });

  it("CD + pipeline + PIPELINE_ENABLED: CD_REGISTERED true, RM offered, Merge Approval gate required, Pipeline Mode names the pipeline", async () => {
    process.env.PIPELINE_ENABLED = "1";
    await load(REGISTERED);
    const ctx = await buildAgentContext(intakeTicket(), h.state.workflow);
    delete process.env.PIPELINE_ENABLED;

    expect(ctx).toContain("## Delivery Mode\nCD_REGISTERED: true");
    expect(ctx).toContain(`"${RM}" (ship)`);
    expect(ctx).toContain('After phase "ship": create a "Merge Approval" ticket');
    expect(ctx).toContain("## Pipeline Mode\nPIPELINE_ENABLED: true\npipeline_name: juno-deploy");
  });

  it("CD without PIPELINE_ENABLED: full ship phase but NO Pipeline Mode block (legacy DEPLOY.md path)", async () => {
    delete process.env.PIPELINE_ENABLED;
    await load(REGISTERED);
    const ctx = await buildAgentContext(intakeTicket(), h.state.workflow);
    expect(ctx).toContain("CD_REGISTERED: true");
    expect(ctx).toContain(`"${RM}" (ship)`);
    expect(ctx).not.toContain("## Pipeline Mode");
  });

  it("registering the repo takes effect on a warm container once the TTL lapses", async () => {
    process.env.CD_REGISTRY_TTL_MS = "1";
    await load(EMPTY);
    let ctx = await buildAgentContext(intakeTicket(), h.state.workflow);
    expect(ctx).toContain("CD_REGISTERED: false");
    h.state.s3Objects["config/cd-registry.json"] = REGISTERED;
    await new Promise((r) => setTimeout(r, 5));
    ctx = await buildAgentContext(intakeTicket(), h.state.workflow);
    expect(ctx).toContain("CD_REGISTERED: true");
    delete process.env.CD_REGISTRY_TTL_MS;
  });
});

describe("4. completion — HANDOFF run ends at the PR", () => {
  // Every NON-ship phase done with evidence; NO ship ticket exists at all (the
  // intake agent stopped the chain at CI, as instructed).
  const nonShipDone = () => {
    h.state.children = [
      { ticketId: "T-1", parentId: EPIC, assignee: DEV, type: "task", status: "done" },
      { ticketId: "T-2", parentId: EPIC, assignee: "agentcore_hub_qa_verifier", type: "task", status: "done" },
      { ticketId: "T-3", parentId: EPIC, assignee: "agentcore_hub_ci_agent", type: "task", status: "done" },
    ];
    h.state.workflow.agentTasks = {
      "T-1": { ticketId: "T-1", status: "complete", output: "implemented" },
      "T-2": { ticketId: "T-2", status: "complete", output: "verified" },
      "T-3": { ticketId: "T-3", status: "complete", output: "ci green" },
    };
  };

  function githubMock() {
    global.fetch = vi.fn(async (url, init) => {
      h.state.githubCalls.push({ url: String(url), method: init?.method || "GET", body: init?.body ? JSON.parse(init.body) : null });
      if (/\/pulls$/.test(String(url)) && init?.method === "POST") {
        const created = JSON.stringify({ html_url: "https://github.com/acme/juno/pull/42", number: 42 });
        return { ok: true, status: 201, json: async () => JSON.parse(created), text: async () => created };
      }
      return { ok: true, status: 200, json: async () => ([]), text: async () => "[]" };
    });
  }

  it("completes with no ship phase, opens the PR with the handoff body, records delivery=handoff", async () => {
    await load(EMPTY);
    nonShipDone();
    githubMock();

    // dev/QA/CI done, no ship ticket anywhere → complete (ship is not required)
    expect(await isWorkflowComplete(EPIC, h.state.workflow, DEV)).toBe(true);
    await completeWorkflow(h.state.workflow);

    expect(h.state.completions).toEqual([{ id: "wf_1", ts: expect.any(String) }]);
    const pr = h.state.githubCalls.find((c) => c.method === "POST" && /\/pulls$/.test(c.url));
    expect(pr).toBeTruthy();
    expect(pr.body.head).toBe("feature/EPIC-1-highlight-reel");
    expect(pr.body.base).toBe("main");
    expect(pr.body.body).toContain("not in the hub's CD registry");
    expect(pr.body.body).toContain("left open for the owning team");
    expect(h.state.deliveries).toEqual([{ id: "wf_1", d: expect.objectContaining({ mode: "handoff", prUrl: "https://github.com/acme/juno/pull/42" }) }]);
    const done = eventsOf("workflow.complete");
    expect(done).toHaveLength(1);
    expect(done[0].detail).toMatchObject({ prUrl: "https://github.com/acme/juno/pull/42", delivery: "handoff" });
  });

  it("CD: the same ticket set is NOT complete — the ship phase is still required", async () => {
    await load(REGISTERED);
    nonShipDone();
    githubMock();

    // The release manager owns the PR, the merge and the deploy on a CD repo:
    // without a done ship ticket (+ approved Merge Approval) the run stays open.
    expect(await isWorkflowComplete(EPIC, h.state.workflow, DEV)).toBe(false);
    expect(h.state.completions).toHaveLength(0);
    expect(h.state.githubCalls.filter((c) => c.method === "POST" && /\/pulls$/.test(c.url))).toHaveLength(0);
  });
});
