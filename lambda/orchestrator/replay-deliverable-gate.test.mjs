import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * DL-035 replays through the REAL index.mjs, from the production rows:
 *
 *   33rea7 / f7jj7j — dead-code sweeps that found nothing. Both paged a human
 *     Merge Approval (review.needed + a Telegram gate.requested) for a PR that
 *     never existed. With the gate's condition deliverable_present(kind=pr), the
 *     orchestrator writes its own skip record (workflowId, evidence_kind
 *     "skipped", reason deliverable_absent) BEFORE resolving the gate Done, and
 *     nobody is paged. A PR URL, an unknown predicate or a failed skip-record
 *     write all page exactly as before.
 *   1ykx9f — the run that closed under open human tickets. Completion now holds
 *     while a non-follow-up human ticket is open; human follow-ups do not block.
 *
 * Tickets are rebuilt from the run's own ticket.created events. Those events do
 * not carry blockedBy, so the one edge the gate path reads — Merge Approval is
 * blocked by the "Ship:" ticket — is set here. Only the I/O seams are mocked
 * (AWS SDK clients, workflow-store), as in cd-handoff.test.mjs; the config is the
 * repo's real workflows.json + agents.json.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));
const repoFile = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    s3Objects: /** @type {Record<string, string>} */ ({}),
    failPut: /** @type {RegExp | null} */ (null),
    ops: /** @type {any[]} */ ([]),
    events: /** @type {any[]} */ ([]),
    notifications: /** @type {any[]} */ ([]),
    completions: /** @type {any[]} */ ([]),
    deliveries: /** @type {any[]} */ ([]),
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
            const s = cmd.input.ExpressionAttributeValues?.[":s"];
            const t = h.state.tickets[cmd.input.Key?.ticketId];
            if (s && String(cmd.input.UpdateExpression).includes("#s = :s")) {
              h.state.ops.push({ op: "status", ticketId: cmd.input.Key?.ticketId, status: s });
              if (t) t.status = s;
            }
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
    async send() { return { Payload: new TextEncoder().encode(JSON.stringify({ statusCode: 200, body: "{}" })) }; }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === "PutObjectCommand") {
        if (h.state.failPut?.test(cmd.input.Key)) throw new Error("AccessDenied");
        h.state.ops.push({ op: "put", key: cmd.input.Key });
        h.state.s3Objects[cmd.input.Key] = cmd.input.Body;
        return {};
      }
      if (name !== "GetObjectCommand") return {};
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
  claimInvocation: vi.fn(async () => true),
  putTaskEntry: vi.fn(async () => {}),
  trackTicket: vi.fn(async () => {}),
  setTaskStatus: vi.fn(async () => {}),
  completeTaskEntry: vi.fn(async () => {}),
  mergeTaskMetadata: vi.fn(async () => {}),
  advancePhase: vi.fn(async () => true),
  adoptFeatureBranch: vi.fn(async () => {}),
  setResumeContext: vi.fn(async () => {}),
  removeResumeContext: vi.fn(async () => {}),
  setRepoCheck: vi.fn(async () => {}),
  appendReviewNotificationOnce: vi.fn(async (wfId, tid, n) => { h.state.notifications.push(n); return true; }),
  appendNotification: vi.fn(async (wfId, n) => { h.state.notifications.push(n); }),
  ackNotifications: vi.fn(async () => {}),
  completeWorkflow: vi.fn(async (id, ts) => { h.state.completions.push({ id, ts }); return true; }),
  claimTerminalOutcome: vi.fn(async () => true),
  claimFinalization: vi.fn(async () => false),
  markFinalized: vi.fn(async () => {}),
  setDelivery: vi.fn(async (id, d) => { h.state.deliveries.push({ id, d }); }),
}));

process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.REPO_CHECK_MODE = "off";
process.env.SHIP_MERGE_VERIFY = "off";

const REGISTRY = JSON.stringify({
  version: 1,
  repos: [
    { repo: "tycenjmccann/juno", pipeline: "hub-juno-deploy", region: "us-west-2" },
    { repo: "tycenjmccann/agentcore-hub", pipeline: "agentcore-hub-deploy", region: "us-west-2" },
  ],
});

const RM = "agentcore_hub_release_manager";
const eventsOf = (type) => h.state.events.filter((e) => e.type === type);
const statusOps = (ticketId, status) => h.state.ops.filter((o) => o.op === "status" && o.ticketId === ticketId && o.status === status);

let handler, completeWorkflow, isWorkflowComplete;

async function load(workflowsConfig = repoFile("src/config/workflows.json")) {
  h.state.s3Objects = {
    "config/agents.json": repoFile("src/config/agents.json"),
    "config/workflows.json": workflowsConfig,
    "config/cd-registry.json": REGISTRY,
  };
  vi.resetModules();
  ({ handler, completeWorkflow, isWorkflowComplete } = await import("./index.mjs"));
  await handler({ Records: [] }); // primes roster / defs / registry caches
}

/** The run as it stood when its last ship blocker closed: not terminal, no stamps. */
function liveRow(id) {
  const { completedAt, finalizedAt, delivery, ...row } = fixture(`workflow-${id}.json`);
  return { ...row, id: row.id || row.workflowId, phase: "ship", humanNotifications: [] };
}

/** Tickets from the run's ticket.created events (first sighting wins), all Done. */
function ticketsOf(id, workflow) {
  const out = {};
  for (const e of fixture(`events-${id}.json`)) {
    if (e.type !== "ticket.created" || !e.detail?.ticket) continue;
    const t = e.detail.ticket;
    if (out[t.id]) continue;
    out[t.id] = {
      ticketId: t.id, parentId: workflow.epicId, workflowId: workflow.id, type: "task",
      assignee: t.assignee, title: t.title, labels: t.labels || [], status: "done", blockedBy: [],
    };
  }
  return out;
}

/** Sweep run with its Merge Approval gate just Ready (blocked by the Ship ticket). */
function sweepAtGate(id) {
  const workflow = liveRow(id);
  const tickets = ticketsOf(id, workflow);
  const all = Object.values(tickets);
  const gate = all.find((t) => t.assignee.startsWith("human:") && /^Merge Approval/.test(t.title));
  const ship = all.find((t) => t.assignee === RM && /^Ship:/.test(t.title));
  gate.status = "ready";
  gate.labels = ["human-review", "reviewer:engineer"];
  gate.blockedBy = [ship.ticketId];
  h.state.workflow = workflow;
  h.state.tickets = tickets;
  h.state.children = all;
  return { workflow, gate, ship };
}

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

beforeEach(() => {
  h.state.ops.length = 0;
  h.state.events.length = 0;
  h.state.notifications.length = 0;
  h.state.completions.length = 0;
  h.state.deliveries.length = 0;
  h.state.failPut = null;
});

for (const id of ["33rea7", "f7jj7j"]) {
  describe(`${id} replay — deliverable_present(kind=pr) Merge Approval`, () => {
    it("no PR: skip record (workflowId, skipped, deliverable_absent) BEFORE Done; never paged", async () => {
      await load();
      const { workflow, gate } = sweepAtGate(id);
      await handler(readyRecord(gate.ticketId));

      const key = `completions/${gate.ticketId}.json`;
      expect(JSON.parse(h.state.s3Objects[key])).toMatchObject({
        ticketId: gate.ticketId,
        workflowId: workflow.id,
        evidence_kind: "skipped",
        skipped: true,
        reason: "deliverable_absent",
      });
      const putAt = h.state.ops.findIndex((o) => o.op === "put" && o.key === key);
      const doneAt = h.state.ops.findIndex((o) => o.op === "status" && o.ticketId === gate.ticketId && o.status === "done");
      expect(putAt).toBeGreaterThanOrEqual(0);
      expect(doneAt).toBeGreaterThan(putAt);

      expect(statusOps(gate.ticketId, "in_review")).toHaveLength(0);
      expect(eventsOf("review.needed")).toHaveLength(0);
      expect(h.state.notifications).toHaveLength(0);
      expect(eventsOf("gate.skipped")).toHaveLength(1);
      expect(eventsOf("gate.skipped")[0].detail).toMatchObject({ ticketId: gate.ticketId, reason: "deliverable_absent", phase: "ship" });
    });

    it("with a PR URL on a task, the gate pages as today", async () => {
      await load();
      const { workflow, gate, ship } = sweepAtGate(id);
      workflow.agentTasks[ship.ticketId] = { ...workflow.agentTasks[ship.ticketId], prUrl: "https://github.com/o/r/pull/7" };
      await handler(readyRecord(gate.ticketId));
      expect(statusOps(gate.ticketId, "in_review")).toHaveLength(1);
      expect(statusOps(gate.ticketId, "done")).toHaveLength(0);
      expect(eventsOf("review.needed")).toHaveLength(1);
      expect(h.state.s3Objects[`completions/${gate.ticketId}.json`]).toBeUndefined();
    });

    it("a PR URL only on a blocker's completion record still pages (harvest race closed)", async () => {
      await load();
      const { gate, ship } = sweepAtGate(id);
      h.state.s3Objects[`completions/${ship.ticketId}.json`] = JSON.stringify({ ticketId: ship.ticketId, pr_url: "https://github.com/o/r/pull/9" });
      await handler(readyRecord(gate.ticketId));
      expect(statusOps(gate.ticketId, "in_review")).toHaveLength(1);
      expect(eventsOf("review.needed")).toHaveLength(1);
    });

    it("an unknown predicate pages", async () => {
      const cfg = JSON.parse(repoFile("src/config/workflows.json"));
      cfg.workflows.find((w) => w.id === "dead-code-sweep").reviewGates[0].condition = "deliverable_present(kind=zip)";
      await load(JSON.stringify(cfg));
      const { gate } = sweepAtGate(id);
      await handler(readyRecord(gate.ticketId));
      expect(statusOps(gate.ticketId, "in_review")).toHaveLength(1);
      expect(eventsOf("review.needed")).toHaveLength(1);
      expect(eventsOf("gate.skipped")).toHaveLength(0);
    });

    it("a failed skip-record write pages as today (and never resolves the gate)", async () => {
      await load();
      const { gate } = sweepAtGate(id);
      h.state.failPut = /^completions\//;
      await handler(readyRecord(gate.ticketId));
      expect(statusOps(gate.ticketId, "done")).toHaveLength(0);
      expect(statusOps(gate.ticketId, "in_review")).toHaveLength(1);
      expect(eventsOf("review.needed")).toHaveLength(1);
    });

    it("completion: delivery outcome empty_sweep with no prState, and workflow.complete carries it", async () => {
      await load();
      const { workflow } = sweepAtGate(id);
      await completeWorkflow(workflow);
      expect(h.state.deliveries).toHaveLength(1);
      expect(h.state.deliveries[0].d.outcome).toBe("empty_sweep");
      expect(h.state.deliveries[0].d).not.toHaveProperty("prState");
      const done = eventsOf("workflow.complete");
      expect(done).toHaveLength(1);
      expect(done[0].detail.outcome).toBe("empty_sweep");
    });
  });
}

describe("1ykx9f replay — an open human ticket holds completion (TEAM-4954)", () => {
  function atClose() {
    const workflow = liveRow("1ykx9f");
    workflow.phase = "verification";
    const tickets = ticketsOf("1ykx9f", workflow);
    h.state.workflow = workflow;
    h.state.tickets = tickets;
    h.state.children = Object.values(tickets);
    return { workflow, tickets };
  }
  const DEV = "agentcore_hub_backend_dev";

  it("every ticket Done → complete (the control)", async () => {
    await load();
    const { workflow } = atClose();
    expect(await isWorkflowComplete(workflow.epicId, workflow, DEV)).toBe(true);
  });

  it("no completion while the non-follow-up human ticket (TEAM-4939 escalation) is open", async () => {
    await load();
    const { workflow, tickets } = atClose();
    for (const status of ["ready", "in_review"]) {
      tickets["TEAM-4939"].status = status;
      expect(await isWorkflowComplete(workflow.epicId, workflow, DEV)).toBe(false);
    }
  });

  it("human follow-ups ([fu:] title — TEAM-4931, TEAM-4954) do not block", async () => {
    await load();
    const { workflow, tickets } = atClose();
    expect(tickets["TEAM-4954"].title).toMatch(/\[fu:[0-9a-f]{8}\]\s*$/);
    tickets["TEAM-4931"].status = "ready";
    tickets["TEAM-4954"].status = "in_review";
    expect(await isWorkflowComplete(workflow.epicId, workflow, DEV)).toBe(true);
  });
});
