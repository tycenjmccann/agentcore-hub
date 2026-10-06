import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * TEAM-5336 F10 — the human clear of a park, end to end with the REAL store.
 *
 * A release manager parked at the redispatch cap (manager_escalation, count 3,
 * plus a legacy deadSessionRetries leaf) is woken when a human Done's its
 * escalation gate: the REAL index.mjs handler → wakeHeldTicketAfterEscalationGate
 * → the REAL workflow-store.mjs resetDeadSessionRetry → unparkTicket, and the
 * release manager's next claimInvocation wins. workflow-store.mjs is NOT mocked:
 * index.mjs and the store share one stateful row fake (src/lib/workflow/
 * park-test-ddb.ts), which throws on any unmodelled expression, so a store
 * change that stops clearing the park fails here instead of in production.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoFile = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", async () => (await import("../../src/lib/workflow/park-test-ddb.ts")).mockLibDynamodb());

const h = vi.hoisted(() => ({ s3: /** @type {Record<string, string>} */ ({}), invokes: /** @type {any[]} */ ([]) }));

vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    async send(cmd) {
      h.invokes.push(cmd.input);
      return { Payload: new TextEncoder().encode(JSON.stringify({ statusCode: 200, body: "{}" })) };
    }
  },
  InvokeCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd) {
      if (cmd.constructor.name !== "GetObjectCommand") return {};
      const body = h.s3[cmd.input.Key];
      if (body === undefined) { const e = new Error("NoSuchKey"); e.name = "NoSuchKey"; throw e; }
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

process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.RUNTIME_ARN_AGENTCORE_HUB_RELEASE_MANAGER = "arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/agentcore_hub_release_manager";
process.env.REPO_CHECK_MODE = "off";
process.env.SHIP_MERGE_VERIFY = "off";

// Re-imported after every vi.resetModules(): the lib-dynamodb mock factory re-runs
// and imports a fresh park-test-ddb, which is the fake index.mjs and the store write.
let fake;

const WF = "wf_esc_1";
const EPIC = "TEAM-1";
const RM = "agentcore_hub_release_manager";
const SHIP = "TEAM-7";
const GATE = "TEAM-9";
const STALE = "2026-10-01T00:00:00.000Z";

let handler, store;

function seed() {
  fake.reset();
  fake.workflows[WF] = {
    workflowId: WF, id: WF, epicId: EPIC, phase: "ship", workflowDefId: "software-delivery",
    input: { title: "x", description: "d" },
    agentTasks: { [SHIP]: { agentId: RM, ticketId: SHIP, status: "running", startedAt: STALE } },
    parkedTickets: { [SHIP]: { parkedReason: "manager_escalation", parkedAt: STALE } },
    redispatchCounts: { [SHIP]: 3 },
    deadSessionRetries: { [SHIP]: 2 },
    humanNotifications: [],
  };
  fake.tickets[SHIP] = { ticketId: SHIP, parentId: EPIC, workflowId: WF, assignee: RM, type: "task", status: "in_progress", title: "Ship: x", blockedBy: [] };
  fake.tickets[GATE] = {
    ticketId: GATE, parentId: EPIC, workflowId: WF, assignee: "human:engineer", type: "task", status: "done",
    title: "Escalation #1: ship-review not converging on TEAM-7", labels: ["human-review"], blockedBy: [],
  };
}

const doneRecord = () => ({
  Records: [{
    eventName: "MODIFY",
    dynamodb: {
      NewImage: { ticketId: { S: GATE }, status: { S: "done" }, assignee: { S: "human:engineer" }, parentId: { S: EPIC }, workflowId: { S: WF }, title: { S: fake.tickets[GATE].title }, type: { S: "task" } },
      OldImage: { ticketId: { S: GATE }, status: { S: "in_review" } },
    },
  }],
});

beforeEach(async () => {
  h.s3 = {
    "config/agents.json": repoFile("src/config/agents.json"),
    "config/workflows.json": repoFile("src/config/workflows.json"),
    "config/cd-registry.json": JSON.stringify({ version: 1, repos: [] }),
  };
  h.invokes.length = 0;
  vi.resetModules();
  ({ fake } = await import("../../src/lib/workflow/park-test-ddb.ts"));
  ({ handler } = await import("./index.mjs"));
  store = await import("./workflow-store.mjs");
  await handler({ Records: [] });
  seed();
});

describe("escalation gate Done → un-park through the REAL store (TEAM-5336 F10)", () => {
  it("wakeHeldTicketAfterEscalationGate un-parks via the REAL workflow-store and the release manager's next claim wins", async () => {
    const before = structuredClone(fake.workflows[WF]);
    expect(before.parkedTickets).toHaveProperty(SHIP);
    // Parked: the claim CAS refuses even a stale-lease takeover.
    expect(await store.claimInvocation(WF, SHIP, { agentId: RM, ticketId: SHIP, status: "running", startedAt: new Date().toISOString() }, new Date().toISOString())).toBe(false);

    await handler(doneRecord());

    const row = fake.workflows[WF];
    expect(row.parkedTickets).not.toHaveProperty(SHIP);
    expect(row.redispatchCounts).not.toHaveProperty(SHIP);
    expect(row.deadSessionRetries).not.toHaveProperty(SHIP);
    expect(fake.events.filter((e) => e.type === "orchestrator.escalation_decided").map((e) => e.detail?.ticketId ?? e.ticketId)).toEqual([SHIP]);
    // The wake itself re-drove the release manager through the claim CAS.
    const claimed = row.agentTasks[SHIP];
    expect(claimed.startedAt).not.toBe(STALE);
    expect(claimed.agentId).toBe(RM);
    expect(claimed.status).toBe("running");
    expect(h.invokes.filter((i) => i.FunctionName === "agentcore-hub-agent-invoker")).toHaveLength(1);
    // A fresh budget: the next automatic re-dispatch is the first of three.
    expect(await store.incrementRedispatch(WF, SHIP)).toEqual({ allowed: true, count: 1 });
  });

  it("CONTROL: a non-escalation human gate Done leaves the park and the budget alone", async () => {
    fake.tickets[GATE].title = "Merge Approval: x";
    await handler(doneRecord());
    const row = fake.workflows[WF];
    expect(row.parkedTickets).toHaveProperty(SHIP);
    expect(row.redispatchCounts[SHIP]).toBe(3);
    expect(fake.events.filter((e) => e.type === "orchestrator.escalation_decided")).toHaveLength(0);
    expect(h.invokes.filter((i) => i.FunctionName === "agentcore-hub-agent-invoker")).toHaveLength(0);
  });
});
