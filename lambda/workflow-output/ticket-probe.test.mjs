import { describe, it, expect, beforeEach, vi } from "vitest";
import fixture from "./__fixtures__/db9sx9-provider-503.json";
import { fake, resetFake, seedTicket, expireVisibility, PROVIDER_503, SUSPENDED_BODY } from "./__fixtures__/ticket-fakes.mjs";

/**
 * TEAM-5592 AC2 — the ticket-provider probe, end to end through the cascade.
 *
 * The db9sx9 completion is queued during the outage, then three probe ticks run:
 *   1. /myself 503 ⇒ TicketProviderUnavailable=1, the queue is not read;
 *   2. /myself 200 ⇒ the follow-up, the gate brief and the Done land, once each;
 *   3. a redelivered message and a repeated webhook ⇒ nothing more happens.
 * The fake jira twin fires a webhook only on a real status change, as Jira does, and
 * each webhook is handed to the REAL orchestrator handleTicketDoneUnified (DDB-row
 * mode, I/O mocked as in lambda/orchestrator/done-handlers-cascade.test.mjs), so
 * "agent.complete exactly once" is the orchestrator's own answer, not a mock's.
 */

const FAKES = "./__fixtures__/ticket-fakes.mjs";
const h = vi.hoisted(() => ({ workflow: null, ddbUpdates: [], fetches: [], fetchStatus: 200 }));

vi.mock("@aws-sdk/client-s3", async () => (await import(FAKES)).s3Module());
vi.mock("@aws-sdk/client-lambda", async () => (await import(FAKES)).lambdaModule());
vi.mock("@aws-sdk/client-sqs", async () => (await import(FAKES)).sqsModule());
vi.mock("@aws-sdk/client-cloudwatch", async () => (await import(FAKES)).cloudwatchModule());
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed" }));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: class { async send() { return {}; } },
  PutEventsCommand: class { constructor(i) { this.input = i; } },
}));
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: class {},
  InvokeAgentCommand: class { constructor(i) { this.input = i; } },
}));
// One DynamoDB for both Lambdas: events Puts are captured on `fake.events`; the
// orchestrator's tickets-table reads are served from the fake jira board.
vi.mock("@aws-sdk/lib-dynamodb", async () => {
  const { fake: f } = await import(FAKES);
  // The orchestrator resolves a run only by a `wf_`-prefixed id on the row.
  const ORCH_WF = "wf_db9sx9";
  const ddbStatus = (t) => (/^done$/i.test(t.status) ? "done" : /progress/i.test(t.status) ? "in_progress" : t.blockedBy.length ? "blocked" : "todo");
  const ddbRow = (t) => ({
    ticketId: t.ticketId, parentId: t.parentKey || null, workflowId: ORCH_WF, assignee: t.assignee,
    title: t.title, status: ddbStatus(t), blockedBy: t.blockedBy, type: "task",
  });
  const named = (n) => ({ [n]: class { constructor(input) { this.input = input; } } })[n];
  return {
    GetCommand: named("GetCommand"), PutCommand: named("PutCommand"), UpdateCommand: named("UpdateCommand"),
    QueryCommand: named("QueryCommand"), ScanCommand: named("ScanCommand"),
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (c) => {
          const name = c.constructor.name;
          if (name === "GetCommand") {
            const t = f.tickets.get(c.input.Key?.ticketId);
            return { Item: t ? ddbRow(t) : undefined };
          }
          if (name === "QueryCommand") {
            if (c.input.TableName === "agentcore-hub-events") return { Items: [] };
            const parent = c.input.ExpressionAttributeValues?.[":pid"] ?? c.input.ExpressionAttributeValues?.[":parentId"];
            return { Items: [...f.tickets.values()].filter((t) => !parent || t.parentKey === parent).map(ddbRow) };
          }
          if (name === "UpdateCommand") { h.ddbUpdates.push(c.input); return {}; }
          if (name === "PutCommand") { f.events.push(c.input.Item); return {}; }
          return { Items: [] };
        },
      }),
    },
  };
});
vi.mock("../orchestrator/workflow-store.mjs", () => ({
  initWorkflowStore: vi.fn(() => {}),
  getWorkflow: vi.fn(async (id) => (h.workflow?.id === id ? h.workflow : null)),
  completeTaskEntry: vi.fn(async (wfId, tid, entry) => {
    if (h.workflow?.id === wfId) h.workflow.agentTasks[tid] = { ...(h.workflow.agentTasks[tid] || {}), ...entry };
  }),
  claimInvocation: vi.fn(async () => true),
  appendReviewNotificationOnce: vi.fn(async () => true),
  setTaskStatus: vi.fn(async () => {}),
  ackNotifications: vi.fn(async () => {}),
  mergeTaskMetadata: vi.fn(async (wfId, tid, fields) => {
    if (h.workflow?.id === wfId && h.workflow.agentTasks[tid]) Object.assign(h.workflow.agentTasks[tid], fields);
  }),
}));

vi.stubGlobal("fetch", async (url, init) => {
  h.fetches.push({ url: String(url), auth: init?.headers?.Authorization });
  return { ok: h.fetchStatus >= 200 && h.fetchStatus < 300, status: h.fetchStatus, text: async () => (h.fetchStatus === 503 ? JSON.stringify(SUSPENDED_BODY) : "") };
});

const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/agentcore-hub-ticket-replay.fifo";
Object.assign(process.env, {
  ARTIFACT_BUCKET: "test-bucket", TICKET_PROVIDER: "jira", TICKET_REPLAY_QUEUE_URL: QUEUE_URL,
  FOLLOW_UP_CLAIM_WAIT_MS: "1", CLAIM_RETRY_WAIT_MS: "1", EVENTS_TABLE: "agentcore-hub-events",
  JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com", JIRA_API_TOKEN: "t0ken",
});
const probe = await import("./ticket-probe.mjs");
const output = await import("./index.mjs");
// The orchestrator in DDB-row mode: its ticket reads come off the same board.
process.env.TICKET_PROVIDER = "dynamodb";
const { handleTicketDoneUnified } = await import("../orchestrator/index.mjs");
process.env.TICKET_PROVIDER = "jira";

const BUILD = "TEAM-5601";
const GATE = "TEAM-5602";
const call0 = fixture.calls[0];
const result = (res) => JSON.parse(res.content[0].text);
const record = () => JSON.parse(fake.objects.get(`completions/${BUILD}.json`));
const tools = (name) => fake.calls.filter((c) => c.tool === name);
const eventsOf = (type, ticketId) => fake.events.filter((e) => e.type === type && (!ticketId || e.detail?.ticketId === ticketId));

/** One EventBridge tick, then every webhook Jira fired during it, delivered to the orchestrator. */
async function tick(event = { source: "ticket-provider-probe" }) {
  const out = await probe.handler(event);
  const hooks = fake.webhooks.splice(0);
  for (const w of hooks) await handleTicketDoneUnified(w.ticketId);
  return { out, hooks };
}

beforeEach(async () => {
  resetFake();
  for (const t of fixture.tickets) seedTicket(t);
  fake.objects.set(fixture.mergeBrief.s3Key, fixture.mergeBrief.body);
  h.workflow = {
    id: "wf_db9sx9", workflowId: "wf_db9sx9", epicId: "TEAM-5600", workflowDefId: "software-delivery",
    input: { title: "db9sx9" }, humanNotifications: [], agentTasks: {},
  };
  h.ddbUpdates.length = 0;
  h.fetches.length = 0;
  // The outage: report_completion queues the operator's writes.
  fake.down = true;
  const res = result(await output.handler({ tool_name: call0.tool_name, arguments: call0.arguments }));
  expect(res).toMatchObject(fixture.expectedResponse);
  expect(fake.queue).toHaveLength(1);
});

describe("TEAM-5592 AC2 — probe ticks: 503, then 200, then a replay", () => {
  it("applies the queued writes exactly once and the orchestrator emits agent.complete exactly once", async () => {
    // Tick 1: Jira still down.
    h.fetchStatus = 503;
    const t1 = await tick();
    expect(t1.out).toMatchObject({ available: false, status: 503 });
    expect(t1.out.error).toMatch(/SUSPENDED_INACTIVITY/);
    expect(fake.metrics.at(-1)).toMatchObject({
      Namespace: "AgentCoreHub/TicketProvider",
      MetricData: [{ MetricName: "TicketProviderUnavailable", Dimensions: [{ Name: "Provider", Value: "jira" }], Value: 1 }],
    });
    expect(fake.queue).toHaveLength(1);
    expect(fake.queue[0].receives).toBe(0);
    expect(h.fetches[0]).toMatchObject({ url: "https://example.atlassian.net/rest/api/3/myself" });
    expect(h.fetches[0].auth).toBe(`Basic ${Buffer.from("bot@example.com:t0ken").toString("base64")}`);
    const queuedBody = fake.queue[0].Body;

    // Tick 2: Jira is back.
    fake.down = false;
    h.fetchStatus = 200;
    fake.calls.length = 0;
    const t2 = await tick();
    expect(t2.out).toMatchObject({ available: true, drained: { applied: 1, retried: 0 } });
    expect(fake.metrics.at(-1).MetricData[0].Value).toBe(0);
    expect(fake.queue).toHaveLength(0);
    // The follow-up, once, under the epic.
    expect(tools("Tickets___create_ticket")).toHaveLength(1);
    expect(tools("Tickets___create_ticket")[0].params).toMatchObject({ parent_key: "TEAM-5600", assignee: "human:engineer" });
    // The brief, once, on the gate — description and a marked comment.
    expect(tools("Tickets___update_ticket").map((c) => c.params.ticket_id)).toEqual([GATE]);
    expect(fake.tickets.get(GATE).description).toBe(fixture.mergeBrief.body.trim());
    expect(fake.tickets.get(GATE).comments).toHaveLength(1);
    expect(fake.tickets.get(GATE).comments[0]).toMatch(/^\[brief:[0-9a-f]{12}\]/);
    // The Done, once — so Jira fired one webhook.
    expect(tools("Tickets___transition_ticket")).toHaveLength(1);
    expect(t2.hooks).toEqual([{ ticketId: BUILD, status: "Done" }]);
    expect(record()).toMatchObject({ status: "complete", followUpsPending: false, ticketWrites: "applied" });
    expect(record().followUpsMaterialized.created).toHaveLength(1);
    expect(eventsOf("agent.complete", BUILD)).toHaveLength(1);
    expect(eventsOf("workflow.report_completion", BUILD)).toHaveLength(1);
    const unblocked = eventsOf("orchestrator.unblocked").length;

    // Tick 3: the same message again (a redelivery past the dedup window), and Jira
    // re-sending the webhook it already sent.
    fake.queue.push({ MessageId: "m-redelivered", Body: queuedBody, group: "db9sx9", inFlight: null, receives: 0 });
    fake.calls.length = 0;
    const t3 = await tick();
    expect(t3.out).toMatchObject({ available: true, drained: { applied: 0, dropped: 1 } });
    expect(fake.calls).toHaveLength(0);
    expect(fake.queue).toHaveLength(0);
    expect(t3.hooks).toHaveLength(0);
    await handleTicketDoneUnified(BUILD);
    expect(eventsOf("agent.complete", BUILD)).toHaveLength(1);
    expect(eventsOf("orchestrator.unblocked")).toHaveLength(unblocked);
    expect(eventsOf("workflow.report_completion", BUILD)).toHaveLength(1);
  });

  it("probeOnly checks Jira and publishes the metric without reading the queue", async () => {
    fake.down = false;
    h.fetchStatus = 200;
    const t = await tick({ probeOnly: true });
    expect(t.out).toMatchObject({ available: true, drained: null });
    expect(fake.metrics.at(-1).MetricData[0].Value).toBe(0);
    expect(fake.queue[0].receives).toBe(0);
  });

  it("an unset credential is a failed probe, not a crash", async () => {
    const saved = process.env.JIRA_API_TOKEN;
    delete process.env.JIRA_API_TOKEN;
    try {
      const t = await tick();
      expect(t.out).toMatchObject({ available: false });
      expect(fake.metrics.at(-1).MetricData[0].Value).toBe(1);
      expect(h.fetches).toHaveLength(0);
    } finally {
      process.env.JIRA_API_TOKEN = saved;
    }
  });
});

describe("TEAM-5592 — drain order and idempotency", () => {
  beforeEach(() => {
    fake.down = false;
    h.fetchStatus = 200;
  });

  it("a write still refused leaves the message, and the rest of its run waits behind it", async () => {
    // A second completion in the same run, queued behind the first.
    seedTicket({ ticketId: "TEAM-5603", title: "Docs", status: "In Progress", assignee: "agentcore_hub_tech_writer", parentKey: "TEAM-5600" });
    fake.down = true;
    await output.handler({ tool_name: call0.tool_name, arguments: { ...call0.arguments, ticket_id: "TEAM-5603", follow_ups: undefined, evidence_keys: "" } });
    fake.down = false;
    expect(fake.queue.map((m) => JSON.parse(m.Body).ticketId)).toEqual([BUILD, "TEAM-5603"]);

    // Jira answers /myself but still 503s the follow-up create.
    fake.failTool = { Tickets___create_ticket: PROVIDER_503 };
    const t1 = await tick();
    expect(t1.out.drained).toMatchObject({ applied: 0, retried: 1, released: 1 });
    expect(fake.queue).toHaveLength(2);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(fake.tickets.get("TEAM-5603").status).toBe("In Progress");

    fake.failTool = null;
    expireVisibility();
    const t2 = await tick();
    expect(t2.out.drained).toMatchObject({ applied: 2 });
    expect(t2.hooks.map((w) => w.ticketId)).toEqual([BUILD, "TEAM-5603"]);
    // The create that 503'd may have landed in Jira; the uncertain claim is reconciled
    // by title, so there is still exactly one follow-up.
    expect([...fake.tickets.values()].filter((t) => /\[fu:[0-9a-f]{8}\]$/.test(t.title))).toHaveLength(1);
  });

  it("a brief the operator already posted is not posted again", async () => {
    fake.tickets.get(GATE).comments.push(`Merge brief\n\n## Decision\n${fixture.mergeBrief.body.split("## Decision\n")[1].split("\n\n")[0]}`);
    const t = await tick();
    expect(t.out.drained.applied).toBe(1);
    expect(tools("Tickets___update_ticket")).toHaveLength(0);
    expect(fake.tickets.get(GATE).comments).toHaveLength(1);
  });

  it("a ticket someone already closed is not transitioned again (no second webhook)", async () => {
    fake.tickets.get(BUILD).status = "Done";
    const t = await tick();
    expect(t.out.drained.applied).toBe(1);
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(t.hooks).toHaveLength(0);
    expect(record().ticketWrites).toBe("applied");
  });

  it("a metric that cannot be published does not stop the drain", async () => {
    const real = (await import("@aws-sdk/client-cloudwatch")).CloudWatchClient.prototype.send;
    const spy = vi.spyOn((await import("@aws-sdk/client-cloudwatch")).CloudWatchClient.prototype, "send").mockRejectedValue(new Error("throttled"));
    try {
      const t = await tick();
      expect(t.out.drained.applied).toBe(1);
    } finally {
      spy.mockRestore();
      expect((await import("@aws-sdk/client-cloudwatch")).CloudWatchClient.prototype.send).toBe(real);
    }
  });

  // F2: a brief that cannot be targeted is never counted as delivered.
  it.each([
    ["two open gates and none is blocked by the ticket", () => {
      fake.tickets.get(GATE).blockedBy = [];
      seedTicket({ ticketId: "TEAM-5604", title: "Merge Approval: db9sx9 (hotfix)", status: "To Do", assignee: "human:approver", parentKey: "TEAM-5600" });
    }, /2 open Merge Approval gates \(TEAM-5602, TEAM-5604\)/],
    ["no open gate", () => { fake.tickets.get(GATE).status = "Done"; }, /no open Merge Approval gate/],
    ["the brief object is gone", () => { fake.objects.delete(fixture.mergeBrief.s3Key); }, /does not exist/],
  ])("%s ⇒ Done proceeds and the brief is recorded UNDELIVERED", async (_name, arrange, reason) => {
    arrange();
    fake.calls.length = 0;
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 1, retried: 0 });
    expect(tools("Tickets___update_ticket")).toHaveLength(0);
    expect(t.hooks).toEqual([{ ticketId: BUILD, status: "Done" }]);
    expect(record().ticketWrites).toBe("applied");
    expect(record().undelivered).toEqual([{ part: "brief", s3Key: fixture.mergeBrief.s3Key, reason: expect.stringMatching(reason) }]);
    expect(eventsOf("workflow.report_completion", BUILD)[0].detail.undelivered).toEqual(record().undelivered);
  });

  it("a brief write Jira refuses permanently (400) ⇒ Done proceeds, the brief is UNDELIVERED", async () => {
    fake.failTool = { Tickets___update_ticket: "Jira API 400: description is too long" };
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 1, retried: 0 });
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    expect(record().undelivered).toEqual([{ part: "brief", s3Key: fixture.mergeBrief.s3Key, reason: expect.stringMatching(/^update_ticket TEAM-5602: Jira API 400/) }]);
  });

  // F4: a permanent refusal on the replay is dropped and noted, never retried behind the group.
  it.each([
    ["get_issue 404s (the ticket was deleted)", { Tickets___get_issue: (p) => (p.ticket_id === BUILD ? `Jira API 404: Issue ${BUILD} does not exist` : null) }, "get_issue"],
    ["list_tickets 403s", { Tickets___list_tickets: (p) => (p.parent_id === "TEAM-5600" && !h.listed++ ? "Jira API 403: no permission to browse" : null) }, "list_tickets"],
    ["the Done 400s", { Tickets___transition_ticket: (p) => (p.ticket_id === BUILD ? "Jira API 400: a required field is missing" : null) }, "transition"],
  ])("%s ⇒ dropped and noted; the next completion in the run still applies this tick", async (_name, failTool, step) => {
    h.listed = 0;
    seedTicket({ ticketId: "TEAM-5603", title: "Docs", status: "In Progress", assignee: "agentcore_hub_tech_writer", parentKey: "TEAM-5600" });
    fake.down = true;
    await output.handler({ tool_name: call0.tool_name, arguments: { ...call0.arguments, ticket_id: "TEAM-5603", follow_ups: undefined, evidence_keys: "" } });
    fake.down = false;
    expect(fake.queue).toHaveLength(2);

    fake.failTool = failTool;
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1, applied: 1, retried: 0 });
    expect(fake.queue).toHaveLength(0);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(fake.tickets.get("TEAM-5603").status).toBe("Done");
    expect(record()).toMatchObject({ ticketWrites: "dropped", replayDropped: { step, error: expect.stringMatching(/^Jira API 4\d\d:/) } });
    expect(eventsOf("workflow.ticket_replay_dropped", BUILD)).toEqual([
      expect.objectContaining({ workflowId: fixture.workflowId, detail: expect.objectContaining({ ticketId: BUILD, step }) }),
    ]);
    expect(eventsOf("workflow.report_completion", BUILD)).toHaveLength(0);
  });

  it("a 429 on the replay is NOT permanent: retried, not dropped", async () => {
    fake.failTool = { Tickets___transition_ticket: "Jira API 429: rate limited" };
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 0, retried: 1, dropped: 0 });
    expect(record().ticketWrites).toBe("queued");
  });

  // P3: no message is started without the time to finish it.
  it("with under 30 s left on the invocation clock, no message is started", async () => {
    fake.calls.length = 0;
    const out = await probe.handler({ source: "ticket-provider-probe" }, { getRemainingTimeInMillis: () => 10_000 });
    expect(out.drained).toMatchObject({ applied: 0, retried: 0 });
    expect(fake.calls).toHaveLength(0);
    expect(fake.queue).toHaveLength(1);
    expect(fake.queue[0].inFlight).toBeNull();
  });

  it("a synthetic id is dropped without a ticket call", async () => {
    fake.queue.length = 0;
    fake.queue.push({ MessageId: "m-hc", Body: JSON.stringify({ v: 1, ticketId: "HEALTHCHECK-1", workflowId: "hc" }), group: "hc", inFlight: null, receives: 0 });
    fake.calls.length = 0;
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1 });
    expect(fake.calls).toHaveLength(0);
    expect(fake.queue).toHaveLength(0);
  });
});
