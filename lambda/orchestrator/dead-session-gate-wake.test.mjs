import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * TEAM-4120 FR-3 — the human's side of the park branch: what happens when
 * somebody moves an `Escalation: dead session on TEAM-x (agent)` gate to Done.
 *
 * The escalation tree parks the run on ONE gate and puts that gate in the held
 * ticket's blockedBy, so the gate's own done cascade is what unblocks the work.
 * The wake hook only has to do the two things the cascade cannot: hand back the
 * dead-session retry budget (the human decided, so the next silence is a NEW
 * episode) and announce the decision. Deliberately NO re-dispatch here — R3 says
 * this path never invokes an agent, and a second dispatch would race the cascade.
 *
 * index.mjs runs for real (the DDB-stream twin drives it); only the AWS + store
 * seams are mocked. The RM-escalation case is included because both titles reach
 * the SAME function: the dead-session branch must not swallow the TEAM-3971
 * release-manager wake.
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    children: /** @type {any[]} */ ([]),
    workflow: /** @type {any} */ (null),
    events: /** @type {any[]} */ ([]),
    resets: /** @type {any[]} */ ([]),
    invokes: /** @type {any[]} */ ([]),
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
            // No heartbeats: every lease reads stale. Tickets query = the siblings.
            if (String(cmd.input.TableName).includes("events")) return { Items: [] };
            return { Items: h.state.children };
          }
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send(cmd) { h.state.invokes.push(cmd.input); return {}; } },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { throw new Error("NoSuchKey"); } },
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

/**
 * index.mjs uses `import * as store`, and this path touches a long tail of
 * writers we do not care about here. Derive the stub set FROM the real module's
 * exports (so it cannot drift as writers are added) and override only the ones
 * whose return value steers the flow.
 *
 * NB: do NOT return a Proxy here — vitest probes the namespace object (`then`,
 * `default`, …) while resolving the mock, and a catch-all `get` trap makes it
 * look thenable, which hangs the import.
 */
vi.mock("./workflow-store.mjs", async () => {
  const actual = await vi.importActual("./workflow-store.mjs");
  const stubs = {};
  for (const key of Object.keys(actual)) {
    stubs[key] = typeof actual[key] === "function" ? vi.fn(async () => undefined) : actual[key];
  }
  return {
    ...stubs,
    initWorkflowStore: vi.fn(() => {}),
    getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
    resetDeadSessionRetry: vi.fn(async (wfId, ticketId) => { h.state.resets.push({ wfId, ticketId }); return true; }),
    appendReviewNotificationOnce: vi.fn(async () => true),
    claimInvocation: vi.fn(async () => true),
    markGateApproved: vi.fn(async () => ({ state: "approved", cycles: [] })),
    markGateRejected: vi.fn(async () => ({ state: "rejected", cycles: [] })),
    markGateRequested: vi.fn(async () => true),
  };
});

const PARENT = "TEAM-1";
const HELD = "TEAM-7";
const AGENT = "agentcore_hub_backend_dev";
const GATE = "TEAM-900";
const RM = "TEAM-50";
const RM_AGENT = "agentcore_hub_release_manager";

let handler;
let store;

beforeEach(async () => {
  h.state.events.length = 0;
  h.state.resets.length = 0;
  h.state.invokes.length = 0;
  h.state.children = [];
  h.state.tickets = {
    [GATE]: { ticketId: GATE, workflowId: "wf_1", parentId: PARENT, assignee: "human:engineer", status: "done", type: "task" },
    [HELD]: { ticketId: HELD, workflowId: "wf_1", parentId: PARENT, assignee: AGENT, status: "blocked", type: "task", blockedBy: [GATE] },
  };
  h.state.workflow = {
    id: "wf_1",
    workflowDefId: "software-delivery",
    humanNotifications: [],
    resumeContexts: {},
    deadSessionRetries: { [HELD]: 1 },
    agentTasks: { [HELD]: { ticketId: HELD, agentId: AGENT, status: "error", startedAt: "2026-09-05T06:00:00Z" } },
  };
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
  store = await import("./workflow-store.mjs");
});

/** A DDB-stream MODIFY moving a human gate to done. */
const gateDone = (title, ticketId = GATE) => ({
  Records: [{
    eventName: "MODIFY",
    eventSource: "aws:dynamodb",
    dynamodb: {
      NewImage: {
        ticketId: { S: ticketId }, status: { S: "done" }, assignee: { S: "human:engineer" },
        workflowId: { S: "wf_1" }, parentId: { S: PARENT }, type: { S: "task" }, title: { S: title },
      },
      OldImage: { ticketId: { S: ticketId }, status: { S: "in_review" }, assignee: { S: "human:engineer" } },
    },
  }],
});

const decided = () => h.state.events.filter((e) => e.type === "orchestrator.escalation_decided").map((e) => e.detail);

describe("a dead-session park gate reaching Done", () => {
  it("resets the held ticket's retry budget and announces the decision", async () => {
    await handler(gateDone(`Escalation: dead session on ${HELD} (${AGENT})`));

    // The ticket to wake is read straight off the gate's own title — no sibling
    // search, so it cannot pick the wrong ticket in a run with several deaths.
    expect(h.state.resets).toEqual([{ wfId: "wf_1", ticketId: HELD }]);
    expect(decided()).toHaveLength(1);
    expect(decided()[0]).toMatchObject({
      workflowId: "wf_1", gateTicketId: GATE, ticketId: HELD, agentId: AGENT,
    });
  });

  it("never re-dispatches the agent itself — the gate's own cascade unblocks it (R3)", async () => {
    await handler(gateDone(`Escalation: dead session on ${HELD} (${AGENT})`));

    // No agent-invoker invoke for the held ticket.
    const payloads = h.state.invokes.map((i) => String(i.Payload || ""));
    expect(payloads.some((p) => p.includes(HELD) && p.includes("agentId"))).toBe(false);
    // And it never steals the claim (that is the detector's job, not the human's) —
    // the dead-session branch returns before any of that.
    expect(store.setTaskStatus).not.toHaveBeenCalledWith("wf_1", HELD, "ready");
  });

  it("is idempotent: re-Done'ing the gate resets again rather than doing nothing", async () => {
    // A human correcting a decision is a real case; both steps are idempotent.
    await handler(gateDone(`Escalation: dead session on ${HELD} (${AGENT})`));
    await handler(gateDone(`Escalation: dead session on ${HELD} (${AGENT})`));

    expect(h.state.resets).toHaveLength(2);
    expect(decided()).toHaveLength(2);
  });

  it("matches the title case-insensitively and keeps the agent id verbatim", async () => {
    await handler(gateDone(`escalation: DEAD SESSION on ${HELD} (${AGENT})`));
    expect(h.state.resets).toEqual([{ wfId: "wf_1", ticketId: HELD }]);
    expect(decided()[0].agentId).toBe(AGENT);
  });

  it("a non-human assignee is not a gate at all: no reset, no announcement", async () => {
    const ev = gateDone(`Escalation: dead session on ${HELD} (${AGENT})`);
    ev.Records[0].dynamodb.NewImage.assignee = { S: AGENT };
    await handler(ev);

    expect(h.state.resets).toEqual([]);
    expect(decided()).toEqual([]);
  });

  it("an ordinary human gate title wakes nothing (neither branch matches)", async () => {
    await handler(gateDone("Human review: approve the API contract"));

    expect(h.state.resets).toEqual([]);
    expect(decided()).toEqual([]);
  });
});

describe("the release-manager escalation gate still takes the TEAM-3971 branch", () => {
  it("wakes the open release-manager ticket, not the dead-session path", async () => {
    h.state.children = [
      { ticketId: RM, parentId: PARENT, workflowId: "wf_1", assignee: RM_AGENT, status: "in_progress", type: "task" },
    ];
    h.state.workflow.agentTasks[RM] = { ticketId: RM, agentId: RM_AGENT, status: "running", startedAt: "2026-09-05T06:00:00Z" };

    await handler(gateDone("Escalation #1: ship-review not converging"));

    // The RM's OWN ticket is what gets the budget back and the announcement.
    expect(h.state.resets).toEqual([{ wfId: "wf_1", ticketId: RM }]);
    expect(decided()).toHaveLength(1);
    expect(decided()[0]).toMatchObject({ gateTicketId: GATE, ticketId: RM, agentId: RM_AGENT });
  });

  it("no open release-manager ticket → nothing to wake, and no dead-session reset", async () => {
    h.state.children = [
      { ticketId: RM, parentId: PARENT, workflowId: "wf_1", assignee: RM_AGENT, status: "done", type: "task" },
    ];

    await handler(gateDone("Escalation #1: ship-review not converging"));

    expect(h.state.resets).toEqual([]);
    expect(decided()).toEqual([]);
  });
});
