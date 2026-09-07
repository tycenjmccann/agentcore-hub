import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4185 F4 — the create-time DERIVED awaited-edge hook must run on EVERY
 * delivery, not only the one that wins the tracking CAS.
 *
 * TEAM-4166 D1 §1.4 put the hook at the tail of trackTicketCreation, which sits
 * behind two early returns:
 *   1. `workflow.agentTasks?.[ticketId]` — the ticket is already tracked
 *   2. `!created` — store.trackTicket's conditional write lost the race
 * Both are correct for TRACKING (it is a write-once entry) and wrong for the
 * derived EDGE (it is convergent, and the origin needs it regardless of who
 * tracked the fix). The f50ucz shape is exactly case 1: a DynamoDB Streams
 * redelivery — or the Jira `todo` twin arriving after the DDB INSERT already
 * tracked the row — skipped the derivation entirely, so the release-manager
 * origin was left with no `blockedBy` edge and no `preconditionUnmet` stamp, and
 * nothing re-woke it when the fix landed.
 *
 * These pin the extracted `deriveAwaitedEdgeOnCreate`: the edge is attempted on
 * all three paths (fresh create, already tracked, lost CAS), on BOTH creation
 * twins, and AWAITED_IDS_MODE=off is still provably zero-I/O — the awaited-ids
 * surface is never even constructed.
 *
 * index.mjs is imported for real; only its I/O seams and the awaited-ids factory
 * are mocked (the factory so the hook's calls are observable without standing up
 * the whole write seam).
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    workflow: /** @type {any} */ (null),
    events: /** @type {any[]} */ ([]),
    tracked: /** @type {any[]} */ ([]),
    // trackTicket's CAS result — false models "concurrently tracked".
    trackTicketReturns: true,
    // Every applyAwaitedEdgesForSpawn call the hook makes.
    spawnCalls: /** @type {any[]} */ ([]),
    // How many times createAwaitedIds() ran. AWAITED_IDS_MODE=off must keep this
    // at 0 — the mode gate gets to short-circuit BEFORE the surface is built.
    awaitedFactoryCalls: 0,
    spawnThrows: false,
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
          if (name === "QueryCommand") return { Items: [] };
          if (name === "PutCommand") { h.state.events.push(cmd.input.Item); return {}; }
          return {};
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class { async send() { return {}; } },
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

vi.mock("./workflow-store.mjs", () => ({
  initWorkflowStore: vi.fn(() => {}),
  getWorkflow: vi.fn(async (id) => (h.state.workflow?.id === id ? h.state.workflow : null)),
  trackTicket: vi.fn(async (wfId, ticketId, entry) => {
    h.state.tracked.push({ wfId, ticketId, entry });
    return h.state.trackTicketReturns;
  }),
}));

/**
 * Only createAwaitedIds is replaced — parkEvidence / awaitedWaitedMs stay REAL,
 * because cascade.mjs and dead-session-detector.mjs import them from this module
 * and a blanket factory mock would break their imports at load time.
 */
vi.mock("./awaited-ids.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createAwaitedIds: () => {
      h.state.awaitedFactoryCalls++;
      return {
        applyAwaitedEdgesForSpawn: vi.fn(async (fixTicketId, spawnedBy, source) => {
          h.state.spawnCalls.push({ fixTicketId, spawnedBy, source });
          if (h.state.spawnThrows) throw new Error("addBlockers unavailable");
          return { written: 1, present: 0 };
        }),
        applyAwaitedEdges: vi.fn(async () => ({ written: 0, present: 0 })),
        deriveAwaitedIds: actual.createAwaitedIds({ mode: "off" }).deriveAwaitedIds,
        checkAwaitTimeout: () => null,
        emitAwaitTimeoutOnce: vi.fn(async () => false),
        emitAwaitedMetrics: vi.fn(),
        newMetrics: vi.fn(() => ({})),
        mode: process.env.AWAITED_IDS_MODE || "enforce",
      };
    },
  };
});

const TICKET = "TEAM-77";
const PARENT = "TEAM-1";
const ORIGIN = "TEAM-42";
const ASSIGNEE = "agentcore_hub_backend_dev";

let handler;

/** TICKET_PROVIDER + AWAITED_IDS_MODE are snapshotted at load, so each re-imports. */
async function load(provider, awaitedMode = "enforce") {
  if (provider === undefined) delete process.env.TICKET_PROVIDER;
  else process.env.TICKET_PROVIDER = provider;
  process.env.AWAITED_IDS_MODE = awaitedMode;
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
}

/**
 * A DDB-stream INSERT of a qa_fix ticket. `blocked` with no old image is the
 * creation-time dependency block (TEAM-4044), so the routing switch below the
 * INSERT branch breaks immediately — this exercises the creation hooks alone.
 */
const insertEvent = () => ({
  Records: [{
    eventName: "INSERT",
    eventSource: "aws:dynamodb",
    dynamodb: {
      NewImage: {
        ticketId: { S: TICKET },
        status: { S: "blocked" },
        assignee: { S: ASSIGNEE },
        workflowId: { S: "wf_1" },
        parentId: { S: PARENT },
        type: { S: "task" },
        blockedBy: { L: [{ S: "TEAM-2" }] },
        spawnedBy: { M: { kind: { S: "qa_fix" }, qaTicketId: { S: ORIGIN } } },
      },
    },
  }],
});

beforeEach(() => {
  h.state.tickets = {
    [TICKET]: {
      ticketId: TICKET, workflowId: "wf_1", parentId: PARENT, assignee: ASSIGNEE,
      status: "blocked", type: "task", blockedBy: ["TEAM-2"],
      spawnedBy: { kind: "qa_fix", qaTicketId: ORIGIN },
    },
    [ORIGIN]: {
      ticketId: ORIGIN, workflowId: "wf_1", parentId: PARENT,
      assignee: "agentcore_hub_release_manager", status: "in_progress", type: "task",
    },
  };
  h.state.events.length = 0;
  h.state.tracked.length = 0;
  h.state.spawnCalls.length = 0;
  h.state.trackTicketReturns = true;
  h.state.awaitedFactoryCalls = 0;
  h.state.spawnThrows = false;
  h.state.workflow = { id: "wf_1", workflowDefId: "software-delivery", agentTasks: {}, resumeContexts: {}, humanNotifications: [] };
});

afterEach(() => {
  delete process.env.TICKET_PROVIDER;
  delete process.env.AWAITED_IDS_MODE;
  delete process.env.JIRA_SITE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
});

describe("TEAM-4185 F4 — the derived awaited-edge hook on the DDB-stream INSERT twin", () => {
  beforeEach(async () => { await load(undefined); }); // dynamodb is the default

  it("baseline: a FIRST delivery that wins the CAS derives the edge once", async () => {
    await handler(insertEvent());

    expect(h.state.tracked).toHaveLength(1);
    expect(h.state.spawnCalls).toHaveLength(1);
    expect(h.state.spawnCalls[0]).toMatchObject({
      fixTicketId: TICKET,
      spawnedBy: { kind: "qa_fix", qaTicketId: ORIGIN },
      source: "spawnedBy",
    });
  });

  it("a REDELIVERED insert whose task is ALREADY TRACKED still derives the edge", async () => {
    // The f50ucz shape: the first delivery tracked the row, then died (or the
    // Jira twin followed the DDB INSERT). Pre-4185 this returned before the hook.
    h.state.workflow.agentTasks[TICKET] = { id: "task_1", agentId: ASSIGNEE, ticketId: TICKET, status: "pending" };

    await handler(insertEvent());

    // Tracking is untouched — still write-once.
    expect(h.state.tracked).toHaveLength(0);
    // But the convergent edge is attempted.
    expect(h.state.spawnCalls).toHaveLength(1);
    expect(h.state.spawnCalls[0]).toMatchObject({ fixTicketId: TICKET, source: "spawnedBy" });
  });

  it("a delivery that LOSES the trackTicket CAS still derives the edge", async () => {
    h.state.trackTicketReturns = false;

    await handler(insertEvent());

    expect(h.state.tracked).toHaveLength(1); // it tried…
    expect(h.state.spawnCalls).toHaveLength(1); // …lost, and still wrote the edge
  });

  it("the ticket.created publish is NOT duplicated on the already-tracked path", async () => {
    h.state.workflow.agentTasks[TICKET] = { id: "task_1", agentId: ASSIGNEE, ticketId: TICKET, status: "pending" };

    await handler(insertEvent());

    // ticket.created stays behind the tracking CAS — only the edge escaped it.
    expect(h.state.events.filter((e) => e.type === "ticket.created")).toHaveLength(0);
    expect(h.state.spawnCalls).toHaveLength(1);
  });

  it("a throwing hook is non-fatal — the handler still resolves", async () => {
    h.state.spawnThrows = true;
    await expect(handler(insertEvent())).resolves.toBeUndefined();
    expect(h.state.spawnCalls).toHaveLength(1);
  });
});

describe("TEAM-4185 F4 — the Jira-webhook twin (processStatusChange todo) behaves identically", () => {
  const jsonResp = (obj, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(obj) });
  const ORIGINAL_FETCH = global.fetch;

  const jiraIssue = () => ({
    key: TICKET,
    fields: {
      summary: "Fix (QA): auth — expired token 500s",
      status: { name: "To Do" },
      labels: ["wf:wf_1", `agent:${ASSIGNEE}`, "fix:qa_fix", `origin:${ORIGIN}`, "phase:verification"],
      issuetype: { name: "Task" },
      parent: { key: PARENT },
      issuelinks: [],
      comment: { comments: [] },
    },
  });

  beforeEach(async () => {
    process.env.JIRA_SITE_URL = "jira.test";
    process.env.JIRA_EMAIL = "bot@test";
    process.env.JIRA_API_TOKEN = "t";
    await load("jira");
    global.fetch = vi.fn(async () => jsonResp(jiraIssue()));
  });
  afterEach(() => { global.fetch = ORIGINAL_FETCH; });

  const webhook = () => ({ source: "jira-webhook", ticketId: TICKET, newStatus: "todo", oldStatus: null });

  it("derives the edge on a first delivery", async () => {
    await handler(webhook());
    expect(h.state.spawnCalls).toHaveLength(1);
    expect(h.state.spawnCalls[0]).toMatchObject({ fixTicketId: TICKET, source: "spawnedBy" });
  });

  it("derives the edge on an ALREADY-TRACKED redelivery (the DDB-INSERT-then-todo order)", async () => {
    h.state.workflow.agentTasks[TICKET] = { id: "task_1", agentId: ASSIGNEE, ticketId: TICKET, status: "pending" };

    await handler(webhook());

    expect(h.state.tracked).toHaveLength(0);
    expect(h.state.spawnCalls).toHaveLength(1);
  });

  it("derives the edge when the trackTicket CAS is lost", async () => {
    h.state.trackTicketReturns = false;
    await handler(webhook());
    expect(h.state.spawnCalls).toHaveLength(1);
  });
});

/**
 * The mode gate is the load-bearing safety property: AWAITED_IDS_MODE=off must be
 * provably zero-I/O, and the check has to come BEFORE getAwaitedIds() so the
 * surface (and its write seams) is never even constructed. Pinned on all three
 * delivery paths, because the hook now has three call sites.
 */
describe("TEAM-4185 F4 — AWAITED_IDS_MODE=off is zero awaited-ids I/O on every path", () => {
  beforeEach(async () => { await load(undefined, "off"); });

  it("fresh create: no factory, no calls", async () => {
    await handler(insertEvent());
    expect(h.state.tracked).toHaveLength(1); // tracking still happens
    expect(h.state.spawnCalls).toHaveLength(0);
    expect(h.state.awaitedFactoryCalls).toBe(0);
  });

  it("already tracked: no factory, no calls", async () => {
    h.state.workflow.agentTasks[TICKET] = { id: "task_1", agentId: ASSIGNEE, ticketId: TICKET, status: "pending" };
    await handler(insertEvent());
    expect(h.state.spawnCalls).toHaveLength(0);
    expect(h.state.awaitedFactoryCalls).toBe(0);
  });

  it("lost CAS: no factory, no calls", async () => {
    h.state.trackTicketReturns = false;
    await handler(insertEvent());
    expect(h.state.spawnCalls).toHaveLength(0);
    expect(h.state.awaitedFactoryCalls).toBe(0);
  });
});
