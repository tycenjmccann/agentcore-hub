import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * TEAM-4121 FR-8 — the `ticket.contract_warning` advisory.
 *
 * FIX_TICKET_CONTRACT=shadow's whole point is measurability: it accepts fix
 * tickets with an incomplete contract so the incompleteness can be counted BEFORE
 * enforce is switched on. Without this hook that count lives only in the ticket
 * Lambda's CloudWatch logs, which is the one place nobody looks — so the
 * orchestrator republishes it onto the run's own event stream at ticket creation.
 *
 * Both creation twins are pinned (they are separate code paths, as with every
 * other orchestrator hook): the Jira webhook's processStatusChange("todo") and
 * the DDB stream's INSERT branch. The advisory is best-effort by construction —
 * a ticket must never fail to be ROUTED because an advisory could not be
 * published — so the failure case is pinned too.
 *
 * index.mjs is imported for real; only its I/O seams are mocked.
 */

const h = vi.hoisted(() => ({
  state: {
    tickets: /** @type {Record<string, any>} */ ({}),
    workflow: /** @type {any} */ (null),
    events: /** @type {any[]} */ ([]),
    tracked: /** @type {any[]} */ ([]),
    // Make every event write fail, to exercise the non-fatal path.
    publishThrows: false,
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
          if (name === "PutCommand") {
            if (h.state.publishThrows) throw new Error("events table unavailable");
            h.state.events.push(cmd.input.Item);
            return {};
          }
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
  EventBridgeClient: class {
    async send() {
      if (h.state.publishThrows) throw new Error("event bus unavailable");
      return {};
    }
  },
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
    return true;
  }),
}));

const TICKET = "TEAM-77";
const PARENT = "TEAM-1";
const ASSIGNEE = "agentcore_hub_backend_dev";

let handler;

/** TICKET_PROVIDER is snapshotted at module load, so each provider re-imports. */
async function load(provider) {
  if (provider === undefined) delete process.env.TICKET_PROVIDER;
  else process.env.TICKET_PROVIDER = provider;
  vi.resetModules();
  ({ handler } = await import("./index.mjs"));
}

const warnings = () => h.state.events.filter((e) => e.type === "ticket.contract_warning");

/**
 * A DDB-stream INSERT of a fix ticket. Status `blocked` with no old image is the
 * creation-time dependency block (TEAM-4044), so the switch below the INSERT
 * branch breaks immediately — this exercises the advisory hook alone.
 */
const insertEvent = ({ spawnedBy, fixContract } = {}) => ({
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
        ...(spawnedBy ? { spawnedBy: { M: spawnedBy } } : {}),
        ...(fixContract ? { fixContract: { M: fixContract } } : {}),
      },
    },
  }],
});

/** The shadow-mode shape as the DynamoDB Lambda writes it. */
const SHADOW_IMAGE = {
  spawnedBy: { kind: { S: "qa_fix" }, qaTicketId: { S: "TEAM-42" } },
  fixContract: {
    version: { N: "1" },
    invariant: { S: "the retry budget is never negative" },
    warnings: { L: [{ S: "evidence_source" }, { S: "cited_location" }] },
  },
};

beforeEach(() => {
  h.state.tickets = {
    [TICKET]: {
      ticketId: TICKET, workflowId: "wf_1", parentId: PARENT, assignee: ASSIGNEE,
      status: "blocked", type: "task", blockedBy: ["TEAM-2"],
    },
  };
  h.state.events.length = 0;
  h.state.tracked.length = 0;
  h.state.publishThrows = false;
  h.state.workflow = { id: "wf_1", workflowDefId: "software-delivery", agentTasks: {}, resumeContexts: {}, humanNotifications: [] };
});

afterEach(() => {
  delete process.env.TICKET_PROVIDER;
  delete process.env.JIRA_SITE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_API_TOKEN;
});

describe("ticket.contract_warning — the DDB-stream INSERT twin", () => {
  beforeEach(async () => { await load(undefined); }); // dynamodb is the default

  it("emits exactly one advisory carrying the workflow, ticket, kind and missing fields", async () => {
    await handler(insertEvent(SHADOW_IMAGE));

    const emitted = warnings();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].detail).toMatchObject({
      workflowId: "wf_1",
      ticketId: TICKET,
      kind: "qa_fix",
      missing: ["evidence_source", "cited_location"],
    });
  });

  it("stays silent for a fix ticket whose contract is complete", async () => {
    await handler(insertEvent({
      spawnedBy: { kind: { S: "qa_fix" }, qaTicketId: { S: "TEAM-42" } },
      fixContract: { version: { N: "1" }, invariant: { S: "x" }, evidenceSource: { S: "unit" } },
    }));
    expect(warnings()).toHaveLength(0);
  });

  it("stays silent for a plain (non-fix) ticket, even with a warnings list", async () => {
    // No spawnedBy.kind → not a fix ticket → nothing to advise about.
    await handler(insertEvent({ fixContract: { version: { N: "1" }, warnings: { L: [{ S: "invariant" }] } } }));
    expect(warnings()).toHaveLength(0);
  });

  it("stays silent when there is no contract at all (mode=off, or a pre-FR-8 ticket)", async () => {
    await handler(insertEvent({ spawnedBy: { kind: { S: "qa_fix" }, qaTicketId: { S: "TEAM-42" } } }));
    expect(warnings()).toHaveLength(0);
  });

  it("an empty warnings list is not a warning", async () => {
    await handler(insertEvent({
      spawnedBy: { kind: { S: "qa_fix" } },
      fixContract: { version: { N: "1" }, warnings: { L: [] } },
    }));
    expect(warnings()).toHaveLength(0);
  });

  it("a failing publish is swallowed — the ticket is still tracked", async () => {
    h.state.publishThrows = true;

    // No throw out of the handler…
    await expect(handler(insertEvent(SHADOW_IMAGE))).resolves.toBeUndefined();
    // …and the creation-time bookkeeping the advisory rides alongside still ran.
    expect(h.state.tracked).toHaveLength(1);
    expect(h.state.tracked[0]).toMatchObject({ wfId: "wf_1", ticketId: TICKET });
  });
});

/**
 * The Jira twin. Here the warnings are reconstructed by mapJiraIssueToTicket from
 * the `contract:incomplete` label the jira Lambda stamps — Jira has nowhere to
 * store the field list, so the advisory reports the fact rather than a fabricated
 * list.
 */
describe("ticket.contract_warning — the Jira-webhook twin (processStatusChange todo)", () => {
  const jsonResp = (obj, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(obj) });
  const ORIGINAL_FETCH = global.fetch;

  const jiraIssue = (labels) => ({
    key: TICKET,
    fields: {
      summary: "Fix (QA): auth — expired token 500s",
      status: { name: "To Do" },
      labels,
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
  });
  afterEach(() => { global.fetch = ORIGINAL_FETCH; });

  const webhook = () => ({ source: "jira-webhook", ticketId: TICKET, newStatus: "todo", oldStatus: null });

  it("a contract:incomplete fix ticket emits one advisory reporting the unparsed contract", async () => {
    global.fetch = vi.fn(async () => jsonResp(jiraIssue([
      "wf:wf_1", `agent:${ASSIGNEE}`, "fix:qa_fix", "origin:TEAM-42", "phase:verification", "contract:incomplete",
    ])));

    await handler(webhook());

    const emitted = warnings();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].detail).toMatchObject({
      workflowId: "wf_1",
      ticketId: TICKET,
      kind: "qa_fix",
      // Jira carries no field list — the mapper records the fact, not a guess.
      missing: ["<unparsed>"],
    });
  });

  it("a fix ticket WITHOUT contract:incomplete emits nothing", async () => {
    global.fetch = vi.fn(async () => jsonResp(jiraIssue([
      "wf:wf_1", `agent:${ASSIGNEE}`, "fix:qa_fix", "origin:TEAM-42", "phase:verification", "evidence:unit",
    ])));

    await handler(webhook());

    expect(warnings()).toHaveLength(0);
  });
});
