import { describe, it, expect, beforeEach, vi } from "vitest";
import fixture from "./__fixtures__/db9sx9-provider-503.json";
import workflowsConfig from "../../src/config/workflows.json";
import { fake, resetFake, seedTicket, expireVisibility, PROVIDER_503, SUSPENDED_BODY, awsError } from "./__fixtures__/ticket-fakes.mjs";

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
const h = vi.hoisted(() => ({ workflow: null, ddbUpdates: [], fetches: [], fetchStatus: 200, workflowRow: null, workflowRowError: null }));

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
            // TEAM-5995: workflow-output's GetItem on the run row (workflowDefId, repoConfig).
            if (c.input.TableName === "agentcore-hub-workflows" && c.input.Key?.workflowId !== undefined) {
              if (h.workflowRowError) throw h.workflowRowError;
              return { Item: h.workflowRow?.workflowId === c.input.Key.workflowId ? h.workflowRow : undefined };
            }
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
  FOLLOW_UP_CLAIM_WAIT_MS: "1", CLAIM_RETRY_WAIT_MS: "1", EVENTS_TABLE: "agentcore-hub-events", WORKFLOWS_TABLE: "agentcore-hub-workflows",
  JIRA_SITE_URL: "example.atlassian.net", JIRA_EMAIL: "bot@example.com", JIRA_API_TOKEN: "t0ken",
});
const probe = await import("./ticket-probe.mjs");
const output = await import("./index.mjs");
// The orchestrator in DDB-row mode: its ticket reads come off the same board.
process.env.TICKET_PROVIDER = "dynamodb";
const { handleTicketDoneUnified } = await import("../orchestrator/index.mjs");
process.env.TICKET_PROVIDER = "jira";

const BUILD = "TEAM-5601";
// Both ticket twins' DL-030 Done guard, judged on the record the drain left.
const TWIN_GUARDS = [() => import("../agentcore-hub-jira/gate-contract.mjs"), () => import("../agentcore-hub-tickets/gate-contract.mjs")];
const GATE = "TEAM-5602";
const call0 = fixture.calls[0];
const result = (res) => JSON.parse(res.content[0].text);
const record = () => JSON.parse(fake.objects.get(`completions/${BUILD}.json`));
const tools = (name) => fake.calls.filter((c) => c.tool === name);
const eventsOf = (type, ticketId) => fake.events.filter((e) => e.type === type && (!ticketId || e.detail?.ticketId === ticketId));
/**
 * A hold the drain stamps because the gate cannot be NAMED: two open Merge Approval
 * gates and neither blocked by the ticket (the "two open gates" row below). TEAM-5995:
 * a Done gate is no longer a hold (every gate Done releases it, gate_settled), so the
 * tests that need a hold arrange this instead; gateIdentifiable() undoes it.
 */
const gateUnidentifiable = () => {
  fake.tickets.get(GATE).blockedBy = [];
  seedTicket({ ticketId: "TEAM-5604", title: "Merge Approval: db9sx9 (hotfix)", status: "To Do", assignee: "human:approver", parentKey: "TEAM-5600" });
};
const gateIdentifiable = () => {
  fake.tickets.delete("TEAM-5604");
  fake.tickets.get(GATE).blockedBy = [BUILD];
};

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
  h.workflowRow = null;
  h.workflowRowError = null;
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

  // Round 2 #1 + round 4 F2: a brief that cannot go on its gate holds the Done (the
  // gate stays blocked, so the approver never sees a Ready gate without the brief).
  const briefComments = (id) => fake.tickets.get(id).comments.filter((c) => /^\[brief:[0-9a-f]{12}\]/.test(c));
  const dropNotices = (id, step = "") => fake.tickets.get(id).comments.filter((c) => c.startsWith(`[replay-dropped:${BUILD}:${step}`));
  const droppedMetrics = () => fake.metrics.flatMap((m) => m.MetricData || []).filter((d) => d.MetricName === "TicketReplayDropped");
  it.each([
    ["two open gates and none is blocked by the ticket", () => {
      fake.tickets.get(GATE).blockedBy = [];
      seedTicket({ ticketId: "TEAM-5604", title: "Merge Approval: db9sx9 (hotfix)", status: "To Do", assignee: "human:approver", parentKey: "TEAM-5600" });
    }, "off_gate", /2 open Merge Approval gates \(TEAM-5602, TEAM-5604\)/],
    ["no human gate, and whether the run owes one is unknown (TEAM-5995: fail closed)", () => { fake.tickets.get(GATE).assignee = "agentcore_hub_operator"; }, "off_gate", /no Merge Approval gate exists under TEAM-5600 but whether this run owes one could not be determined/],
    ["the gate write Jira refuses permanently (400)", () => {
      fake.failTool = { Tickets___update_ticket: "Jira API 400: description is too long" };
    }, "off_gate", /the gate TEAM-5602 refused it \(update_ticket TEAM-5602: Jira API 400/],
    ["the brief object is gone", () => { fake.objects.delete(fixture.mergeBrief.s3Key); }, "undelivered", /does not exist/],
  ])("%s ⇒ Done WITHHELD: brief pending, held-open notice on the ticket and epic, metric, message deleted, no loop", async (_name, arrange, delivered, reason) => {
    arrange();
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 0, dropped: 1, retried: 0 });
    expect(fake.queue).toHaveLength(0);
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(t.hooks).toHaveLength(0);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(record()).toMatchObject({
      ticketWrites: "dropped", briefPending: true, briefDelivered: delivered,
      replayDropped: { step: "brief", error: expect.stringMatching(/^merge brief .* is not on the Merge Approval gate/), notice: { target: BUILD, outcome: "posted" } },
    });
    expect(record().replayDropped.error).toMatch(reason);
    // Round 5 P2: the follow-up WAS filed, so the record says so: a brief-only hold
    // does not leave a stale followUpsPending for the twins' Done guard to refuse on.
    expect(record()).toMatchObject({ followUpsPending: false, status: "complete" });
    expect(record().followUpsMaterialized.created).toHaveLength(1);
    expect(tools("Tickets___create_ticket")).toHaveLength(1);
    // TEAM-5805: both twins' Done guard REFUSES this very record — a direct Done would
    // release the gate without its brief — through the record judge (ship-phase) and
    // the brief-hold judge (the operator's non-ship ticket, this one) alike. Once a
    // delivery to the gate restamps briefPending:false, both admit.
    const held = fake.objects.get(`completions/${BUILD}.json`);
    for (const twin of TWIN_GUARDS) {
      const m = await twin();
      expect(m.judgeCompletionRecord(`completions/${BUILD}.json`, held)).toMatchObject({ proven: false, why: expect.stringContaining(`has briefPending:true (brief ${delivered})`) });
      expect(m.judgeBriefHold(`completions/${BUILD}.json`, held)).toMatchObject({ proven: false });
      expect(output.isBriefHoldRefusal(m.judgeCompletionRecord(`completions/${BUILD}.json`, held).why)).toBe(true);
      const cleared = JSON.stringify({ ...JSON.parse(held), briefPending: false, briefDelivered: "gate" });
      expect(m.judgeCompletionRecord(`completions/${BUILD}.json`, cleared)).toMatchObject({ proven: true });
      expect(m.judgeBriefHold(`completions/${BUILD}.json`, cleared)).toBeNull();
    }
    expect(record().undelivered).toEqual([expect.objectContaining({ part: "brief", s3Key: fixture.mergeBrief.s3Key, reason: expect.stringMatching(reason) })]);
    for (const id of [BUILD, "TEAM-5600"]) {
      expect(dropNotices(id, "brief]")).toHaveLength(1);
      expect(dropNotices(id)[0]).toContain(`${BUILD} was LEFT OPEN (not transitioned to Done)`);
      expect(dropNotices(id)[0]).toContain("is not on the Merge Approval gate");
    }
    expect(droppedMetrics()).toEqual([expect.objectContaining({ Value: 1 })]);
    expect(eventsOf("workflow.ticket_replay_dropped", BUILD)).toEqual([expect.objectContaining({ detail: expect.objectContaining({ step: "brief" }) })]);
    expect(eventsOf("workflow.report_completion", BUILD)).toHaveLength(0);
    if (delivered === "off_gate") {
      for (const id of [BUILD, "TEAM-5600"]) {
        expect(briefComments(id)).toHaveLength(1);
        expect(briefComments(id)[0]).toContain(fixture.mergeBrief.body.trim());
        expect(briefComments(id)[0]).toContain("MERGE BRIEF NOT ON THE GATE");
      }
      expect(fake.tickets.get(GATE).comments).toHaveLength(0);
      expect(record()).toMatchObject({ briefTargets: [BUILD, "TEAM-5600"], briefFallbackReason: expect.stringMatching(reason) });
      expect(record().undelivered[0]).toMatchObject({ reason: expect.stringMatching(/^not on the gate: /), postedOn: [BUILD, "TEAM-5600"] });
    } else {
      expect(tools("Tickets___update_ticket")).toHaveLength(0);
      const missing = fake.tickets.get(BUILD).comments.filter((c) => c.startsWith("[brief-missing:"));
      expect(missing).toHaveLength(1);
      expect(missing[0]).toContain(`s3://test-bucket/${fixture.mergeBrief.s3Key}`);
    }
    // No loop: the message is gone, so the next tick has nothing to do.
    fake.calls.length = 0;
    const t2 = await tick();
    expect(t2.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 0 });
    expect(fake.calls).toHaveLength(0);
    expect(droppedMetrics()).toHaveLength(1);
  });

  it("a follow-up refused AND a brief off the gate ⇒ one follow_ups+brief hold, and the guard still refuses Done", async () => {
    gateUnidentifiable();
    fake.failTool = { Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1 });
    expect(record()).toMatchObject({ followUpsPending: true, status: "complete_pending_follow_ups", briefPending: true, replayDropped: { step: "follow_ups+brief" } });
    for (const twin of TWIN_GUARDS) {
      expect((await twin()).judgeCompletionRecord(`completions/${BUILD}.json`, fake.objects.get(`completions/${BUILD}.json`))).toMatchObject({ proven: false });
    }
  });

  it("a re-run report_completion after a brief hold keeps briefPending on the record", async () => {
    gateUnidentifiable();
    await tick();
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate" });
    await output.handler({ tool_name: call0.tool_name, arguments: call0.arguments });
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate", replayDropped: { step: "brief" } });
  });

  // TEAM-5805: the re-run is the clearing path. It re-delivers the brief through the
  // drain's own postQueuedBrief; only a brief on the gate lets the Done through.
  it("re-run with the gate still not identifiable ⇒ complete_pending_brief, no Done attempted, no throw", async () => {
    gateUnidentifiable();
    await tick();
    fake.calls.length = 0;
    const res = result(await output.handler({ tool_name: call0.tool_name, arguments: call0.arguments }));
    expect(res).toMatchObject({ status: "complete_pending_brief", next_action: "retry_report_completion" });
    expect(res.message).toContain("merge brief is not on the Merge Approval gate");
    expect(res.message).toMatch(/2 open Merge Approval gates/);
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(fake.queue).toHaveLength(0);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(record()).toMatchObject({ status: "complete_pending_brief", followUpsPending: false, briefPending: true, briefHoldReason: expect.stringMatching(/^off_gate: 2 open Merge Approval gates/) });
    // The off-gate fallback comments are marker-deduped: the re-run posted none again.
    for (const id of [BUILD, "TEAM-5600"]) expect(briefComments(id)).toHaveLength(1);
  });

  it("re-run once the gate is open again ⇒ brief on the gate, briefPending:false, ticket Done", async () => {
    gateUnidentifiable();
    await tick();
    gateIdentifiable();
    fake.calls.length = 0;
    const res = result(await output.handler({ tool_name: call0.tool_name, arguments: call0.arguments }));
    expect(res).toMatchObject({ status: "complete" });
    expect(res.next_action).toBeUndefined();
    expect(briefComments(GATE)).toHaveLength(1);
    expect(fake.tickets.get(GATE).description).toBe(fixture.mergeBrief.body.trim());
    expect(tools("Tickets___transition_ticket")).toHaveLength(1);
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    expect(record()).toMatchObject({ status: "complete", briefPending: false, briefDelivered: "gate", briefTargets: [GATE] });
    for (const twin of TWIN_GUARDS) {
      expect((await twin()).judgeCompletionRecord(`completions/${BUILD}.json`, fake.objects.get(`completions/${BUILD}.json`))).toMatchObject({ proven: true });
    }
  });

  it("re-run after a human put the brief on the gate by hand ⇒ already_posted clears the hold, nothing posted twice", async () => {
    gateUnidentifiable();
    await tick();
    gateIdentifiable();
    fake.tickets.get(GATE).comments.push(`Pasted by hand\n\n${fixture.mergeBrief.body.trim()}`);
    fake.calls.length = 0;
    const res = result(await output.handler({ tool_name: call0.tool_name, arguments: call0.arguments }));
    expect(res.status).toBe("complete");
    expect(tools("Tickets___update_ticket")).toHaveLength(0);
    expect(fake.tickets.get(GATE).comments).toHaveLength(1);
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate" });
    expect(fake.tickets.get(BUILD).status).toBe("Done");
  });

  it("the drain clears a hold once a later message lands the brief on the gate (step 6), then Done", async () => {
    const body = fake.queue[0].Body;
    gateUnidentifiable();
    await tick();
    expect(record()).toMatchObject({ briefPending: true });
    gateIdentifiable();
    fake.queue.push({ MessageId: "redelivered", Body: body, group: "wf_db9sx9", inFlight: null, receives: 0 });
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 1, dropped: 0 });
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE], ticketWrites: "applied" });
    expect(fake.tickets.get(BUILD).status).toBe("Done");
  });

  // TEAM-6024: the hold stamped `undelivered:[{part:"brief"}]`; once the brief is on the
  // gate that entry is stale and comes off, while any other undelivered part stays.
  const RESIDUAL = { part: "residual_findings", ticketId: "TEAM-5603", reason: "Jira API 400: ticket is archived" };
  const holdBrief = async ({ withResidual = false } = {}) => {
    gateUnidentifiable(); // TEAM-6097: a Done gate is a release now (TEAM-5995), not a hold
    await tick();
    expect(record()).toMatchObject({ briefPending: true, undelivered: [expect.objectContaining({ part: "brief" })] });
    if (withResidual) {
      fake.objects.set(`completions/${BUILD}.json`, JSON.stringify({ ...record(), undelivered: [...record().undelivered, RESIDUAL] }));
      fake.etags.set(`completions/${BUILD}.json`, `"e${++fake.etagSeq}"`);
    }
    gateIdentifiable();
  };

  it("TEAM-6024 re-run delivers the held brief to the gate ⇒ the stale brief entry is gone from undelivered", async () => {
    await holdBrief();
    const res = result(await output.handler({ tool_name: call0.tool_name, arguments: call0.arguments }));
    expect(res.status).toBe("complete");
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE] });
    expect(record().undelivered).toBeUndefined();
  });

  it("TEAM-6024 re-run delivers the held brief to the gate ⇒ only the brief entry comes off, other parts stay", async () => {
    await holdBrief({ withResidual: true });
    await output.handler({ tool_name: call0.tool_name, arguments: call0.arguments });
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate" });
    expect(record().undelivered).toEqual([RESIDUAL]);
  });

  it("TEAM-6024 drain step 6 lands the held brief on the gate ⇒ the stale brief entry is gone from undelivered", async () => {
    const body = fake.queue[0].Body;
    await holdBrief();
    fake.queue.push({ MessageId: "redelivered", Body: body, group: "wf_db9sx9", inFlight: null, receives: 0 });
    expect((await tick()).out.drained).toMatchObject({ applied: 1, dropped: 0 });
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE], ticketWrites: "applied" });
    expect(record().undelivered).toBeUndefined();
  });

  it("TEAM-6024 drain step 6 lands the held brief on the gate ⇒ only the brief entry comes off, other parts stay", async () => {
    const body = fake.queue[0].Body;
    await holdBrief({ withResidual: true });
    fake.queue.push({ MessageId: "redelivered", Body: body, group: "wf_db9sx9", inFlight: null, receives: 0 });
    expect((await tick()).out.drained).toMatchObject({ applied: 1, dropped: 0 });
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate", ticketWrites: "applied" });
    expect(record().undelivered).toEqual([RESIDUAL]);
  });

  // TEAM-6042: the off-gate hold also stamped `briefFallbackReason`; on the gate it is
  // stale with the brief entry, and a record reading briefDelivered:"gate" must not keep it.
  it("TEAM-6042 re-run delivers the held brief to the gate ⇒ the off-gate briefFallbackReason is gone", async () => {
    await holdBrief();
    expect(record().briefFallbackReason).toEqual(expect.stringMatching(/2 open Merge Approval gates/));
    const res = result(await output.handler({ tool_name: call0.tool_name, arguments: call0.arguments }));
    expect(res.status).toBe("complete");
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE] });
    expect(record().briefFallbackReason).toBeUndefined();
  });

  it("TEAM-6042 drain step 6 lands the held brief on the gate ⇒ the off-gate briefFallbackReason is gone", async () => {
    const body = fake.queue[0].Body;
    await holdBrief();
    expect(record().briefFallbackReason).toEqual(expect.stringMatching(/2 open Merge Approval gates/));
    fake.queue.push({ MessageId: "redelivered", Body: body, group: "wf_db9sx9", inFlight: null, receives: 0 });
    expect((await tick()).out.drained).toMatchObject({ applied: 1, dropped: 0 });
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE], ticketWrites: "applied" });
    expect(record().briefFallbackReason).toBeUndefined();
  });

  // TEAM-6029: the same delivery on the drop() path — a follow-up no retry can file keeps
  // the hold (follow_ups), but the brief is on the gate now, so the brief hold is cleared
  // and its stale entry comes off, as step 6 does; the twins refuse on the follow-ups only.
  const redeliverOverUnfiled = async ({ withResidual = false } = {}) => {
    const body = fake.queue[0].Body;
    fake.failTool = { Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };
    await holdBrief({ withResidual });
    expect(record()).toMatchObject({ followUpsPending: true, replayDropped: { step: "follow_ups+brief" } });
    fake.queue.push({ MessageId: "redelivered", Body: body, group: "wf_db9sx9", inFlight: null, receives: 0 });
    expect((await tick()).out.drained).toMatchObject({ applied: 0, dropped: 1 });
    expect(record()).toMatchObject({ followUpsPending: true, briefPending: false, briefDelivered: "gate", briefTargets: [GATE], ticketWrites: "dropped", replayDropped: { step: "follow_ups" } });
  };

  it("TEAM-6029 a redelivered drain lands the held brief on the gate while a follow-up still cannot be filed ⇒ briefPending:false, the stale brief entry gone", async () => {
    await redeliverOverUnfiled();
    expect(record().undelivered).toBeUndefined();
    for (const twin of TWIN_GUARDS) {
      const v = (await twin()).judgeCompletionRecord(`completions/${BUILD}.json`, fake.objects.get(`completions/${BUILD}.json`));
      expect(v).toMatchObject({ proven: false });
      expect(v.why).not.toMatch(/has briefPending:true/);
    }
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
  });

  it("TEAM-6029 a redelivered drain lands the held brief on the gate while a follow-up still cannot be filed ⇒ only the brief entry comes off, other parts stay", async () => {
    await redeliverOverUnfiled({ withResidual: true });
    expect(record().undelivered).toEqual([RESIDUAL]);
  });

  // TEAM-6052: a follow-ups-only drop() whose brief this drain put on the gate stamps the
  // gate delivery like every other gate path: briefPending:false, no briefFallbackReason,
  // no stale `part:"brief"` entry — the spread must not carry the earlier hold over it.
  it("TEAM-6052 a redelivered drain lands the held brief on the gate while a follow-up still cannot be filed ⇒ briefPending:false, briefFallbackReason and the brief entry gone", async () => {
    const body = fake.queue[0].Body;
    fake.failTool = { Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };
    gateUnidentifiable(); // TEAM-6097: a Done gate is a release now (TEAM-5995), not a hold
    await tick();
    expect(record()).toMatchObject({
      followUpsPending: true, briefPending: true, briefFallbackReason: expect.stringMatching(/2 open Merge Approval gates/),
      undelivered: [expect.objectContaining({ part: "brief" })], replayDropped: { step: "follow_ups+brief" },
    });
    gateIdentifiable();
    fake.queue.push({ MessageId: "redelivered", Body: body, group: "wf_db9sx9", inFlight: null, receives: 0 });
    expect((await tick()).out.drained).toMatchObject({ applied: 0, dropped: 1 });
    expect(record()).toMatchObject({ followUpsPending: true, briefPending: false, briefDelivered: "gate", briefTargets: [GATE], ticketWrites: "dropped", replayDropped: { step: "follow_ups" } });
    expect(record().briefFallbackReason).toBeUndefined();
    expect(record().undelivered).toBeUndefined();
    for (const twin of TWIN_GUARDS) {
      const v = (await twin()).judgeCompletionRecord(`completions/${BUILD}.json`, fake.objects.get(`completions/${BUILD}.json`));
      expect(v).toMatchObject({ proven: false });
      expect(v.why).not.toMatch(/has briefPending:true/);
    }
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
  });

  it("a Done the twins refuse on the brief hold is a surfaced drop, not a retry to the DLQ (step 7)", async () => {
    fake.failTool = { Tickets___transition_ticket: (p) => (p.ticket_id === BUILD ? `Cannot move ${BUILD} to Done: a ticket whose merge brief is held needs its completion record first — call WorkflowOutput___report_completion(ticket_id=…) (completions/${BUILD}.json has briefPending:true (brief off_gate) — the merge brief has not reached the Merge Approval gate; …)` : null) };
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 0, dropped: 1, retried: 0 });
    expect(fake.queue).toHaveLength(0);
    expect(record()).toMatchObject({ ticketWrites: "dropped", replayDropped: { step: "transition" } });
  });

  it("a gate write the provider cannot take (503) is still retried, not held", async () => {
    fake.failTool = { Tickets___update_ticket: PROVIDER_503 };
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 });
    expect(fake.queue).toHaveLength(1);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(record().ticketWrites).toBe("queued");
    expect(droppedMetrics()).toHaveLength(0);
  });

  it("a ticket a human already closed: no gate is only recorded undelivered, and the replay applies", async () => {
    fake.tickets.get(GATE).status = "Done";
    fake.tickets.get(BUILD).status = "Done";
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 1, dropped: 0 });
    expect(record()).toMatchObject({ ticketWrites: "applied", briefDelivered: "off_gate" });
    expect(record().briefPending).toBe(false); // TEAM-6124: a release states the hold false
    expect(droppedMetrics()).toHaveLength(0);
  });

  it("a fallback brief is not posted twice when the message comes back (marker dedup)", async () => {
    gateUnidentifiable();
    fake.failTool = { Tickets___add_comment: (p) => (p.comment.startsWith("[replay-dropped:") ? PROVIDER_503 : null) };
    const t1 = await tick();
    expect(t1.out.drained).toMatchObject({ dropped: 0, retried: 1 });
    expect(fake.queue).toHaveLength(1);
    fake.failTool = null;
    expireVisibility();
    const t2 = await tick();
    expect(t2.out.drained).toMatchObject({ dropped: 1 });
    for (const id of [BUILD, "TEAM-5600"]) {
      expect(briefComments(id)).toHaveLength(1);
      expect(dropNotices(id)).toHaveLength(1);
    }
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
  });

  it("a brief delivered to its gate is recorded as such", async () => {
    await tick();
    expect(record()).toMatchObject({ briefDelivered: "gate", briefTargets: [GATE] });
    expect(briefComments(GATE)).toHaveLength(1);
  });

  it("a missing-brief notice the provider cannot take (503) is retried, not skipped", async () => {
    fake.objects.delete(fixture.mergeBrief.s3Key);
    fake.failTool = { Tickets___add_comment: PROVIDER_503 };
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 0, retried: 1 });
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
  });

  // F4 + round 2 #3: a permanent refusal is dropped, said on the ticket (or epic), metered, then deleted.
  it.each([
    ["get_issue 404s (the ticket was deleted)", { Tickets___get_issue: (p) => (p.ticket_id === BUILD ? `Jira API 404: Issue ${BUILD} does not exist` : null) }, "get_issue", "TEAM-5600"],
    ["list_tickets 403s", { Tickets___list_tickets: (p) => (p.parent_id === "TEAM-5600" && !h.listed++ ? "Jira API 403: no permission to browse" : null) }, "list_tickets", BUILD],
    ["the Done 400s", { Tickets___transition_ticket: (p) => (p.ticket_id === BUILD ? "Jira API 400: a required field is missing" : null) }, "transition", BUILD],
  ])("%s ⇒ dropped, noted on the board + metric; the next completion in the run still applies this tick", async (_name, failTool, step, noticeOn) => {
    h.listed = 0;
    seedTicket({ ticketId: "TEAM-5603", title: "Docs", status: "In Progress", assignee: "agentcore_hub_tech_writer", parentKey: "TEAM-5600" });
    fake.down = true;
    await output.handler({ tool_name: call0.tool_name, arguments: { ...call0.arguments, ticket_id: "TEAM-5603", follow_ups: undefined, evidence_keys: "" } });
    fake.down = false;
    expect(fake.queue).toHaveLength(2);
    // The outage hid the epic at enqueue; a completion whose get_issue answered carries it.
    fake.queue[0].Body = JSON.stringify({ ...JSON.parse(fake.queue[0].Body), epicKey: "TEAM-5600" });

    fake.failTool = failTool;
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1, applied: 1, retried: 0 });
    expect(fake.queue).toHaveLength(0);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(fake.tickets.get("TEAM-5603").status).toBe("Done");
    expect(record()).toMatchObject({ ticketWrites: "dropped", replayDropped: { step, error: expect.stringMatching(/^Jira API 4\d\d:/), notice: { target: noticeOn, outcome: "posted" } } });
    expect(eventsOf("workflow.ticket_replay_dropped", BUILD)).toEqual([
      expect.objectContaining({ workflowId: fixture.workflowId, detail: expect.objectContaining({ ticketId: BUILD, step }) }),
    ]);
    expect(eventsOf("workflow.report_completion", BUILD)).toHaveLength(0);
    const notice = dropNotices(noticeOn);
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain(`the ${step} step could not be applied`);
    expect(notice[0]).toContain(`${BUILD} was LEFT OPEN`);
    expect(notice[0]).toContain(`s3://test-bucket/completions/${BUILD}.json is the source of truth`);
    expect(notice[0]).toContain(`A human must close ${BUILD}`);
    expect(droppedMetrics()).toEqual([expect.objectContaining({ Value: 1, Dimensions: [{ Name: "Provider", Value: "jira" }] })]);
  });

  it("a deleted ticket with no known epic is still dropped, metered and journaled", async () => {
    fake.failTool = { Tickets___get_issue: (p) => (p.ticket_id === BUILD ? `Jira API 404: Issue ${BUILD} does not exist` : null) };
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1 });
    expect(tools("Tickets___add_comment")).toHaveLength(0);
    expect(record().replayDropped).toMatchObject({ step: "get_issue", notice: null });
    expect(droppedMetrics()).toHaveLength(1);
  });

  it("a drop notice the provider cannot take (503) keeps the message: retried, not dropped", async () => {
    fake.failTool = {
      Tickets___transition_ticket: "Jira API 400: a required field is missing",
      Tickets___add_comment: (p) => (p.comment.startsWith("[replay-dropped:") ? PROVIDER_503 : null),
    };
    const t1 = await tick();
    expect(t1.out.drained).toMatchObject({ dropped: 0, retried: 1 });
    expect(fake.queue).toHaveLength(1);
    expect(record().ticketWrites).toBe("queued");
    expect(droppedMetrics()).toHaveLength(0);

    fake.failTool = { Tickets___transition_ticket: "Jira API 400: a required field is missing" };
    expireVisibility();
    const t2 = await tick();
    expect(t2.out.drained).toMatchObject({ dropped: 1 });
    expect(dropNotices(BUILD)).toHaveLength(1);
    expect(droppedMetrics()).toHaveLength(1);
    expect(fake.queue).toHaveLength(0);
  });

  // TEAM-5593 on the replay: a follow-up no retry can file is never dropped behind a Done.
  it("a queued follow-up Jira now refuses outright (original and triage) ⇒ unfiled notice, Done withheld, surfaced drop", async () => {
    fake.failTool = { Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1, applied: 0 });
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(t.hooks).toHaveLength(0);
    expect(record()).toMatchObject({ followUpsPending: true, ticketWrites: "dropped", replayDropped: { step: "follow_ups" } });
    expect(dropNotices(BUILD)).toHaveLength(1);
    expect(droppedMetrics()).toHaveLength(1);
    expect(eventsOf("workflow.report_completion", BUILD)).toHaveLength(0);
  });

  // Round 4 F1: the twin's refusals that WRAP a 4xx are permanent on the replay too,
  // so they reach the surfaced drop instead of retrying to the DLQ.
  it.each([
    ["the sibling-scan refusal wrapping a 400", "create_ticket refused: the sibling scan under TEAM-5600 failed (Jira API 400: invalid JQL), so the create was not attempted. Retry the call."],
    ["parent_type_unreadable wrapping a 404", "parent_type_unreadable: could not read parent TEAM-5600's issue type (Jira API 404: Issue does not exist); nothing was created. Retry the call."],
  ])("queued on 503, then %s on replay ⇒ unfiled, Done withheld, surfaced drop, message deleted", async (_name, wrapped) => {
    fake.failTool = { Tickets___create_ticket: wrapped };
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1, applied: 0, retried: 0 });
    expect(fake.queue).toHaveLength(0);
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(t.hooks).toHaveLength(0);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(record()).toMatchObject({ followUpsPending: true, ticketWrites: "dropped", replayDropped: { step: "follow_ups", error: expect.stringContaining(wrapped) } });
    expect(dropNotices(BUILD, "follow_ups]")).toHaveLength(1);
    expect(dropNotices(BUILD)[0]).toContain(`${BUILD} was LEFT OPEN`);
    expect(droppedMetrics()).toEqual([expect.objectContaining({ Value: 1 })]);
    expect(eventsOf("workflow.ticket_replay_dropped", BUILD)).toHaveLength(1);
    expect(eventsOf("workflow.report_completion", BUILD)).toHaveLength(0);
  });

  it("the same wrappers around a 503 stay retryable on the replay", async () => {
    fake.failTool = { Tickets___create_ticket: "create_ticket refused: the sibling scan under TEAM-5600 failed (Jira API 503: upstream), so the create was not attempted. Retry the call." };
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 0, retried: 1 });
    expect(fake.queue).toHaveLength(1);
    expect(droppedMetrics()).toHaveLength(0);
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
    expect(fake.metrics.flatMap((m) => m.MetricData || []).filter((d) => d.MetricName === "TicketReplayDropped")).toHaveLength(0);
  });
});

// TEAM-5830: the completion record is shared by two writers — the drain and a re-run
// report_completion — and it is the only place the twins' Done guard sees a brief hold.
// Each test moves S3 between one writer's read and its write, as the other writer does.
describe("TEAM-5830 — briefPending survives concurrent writers", () => {
  const KEY = `completions/${BUILD}.json`;
  const briefComments = (id) => fake.tickets.get(id).comments.filter((c) => /^\[brief:[0-9a-f]{12}\]/.test(c));
  /** Another writer's whole-record write landing now: the body changes and so does the ETag. */
  const stamp = (fields) => {
    fake.objects.set(KEY, JSON.stringify({ ...JSON.parse(fake.objects.get(KEY)), ...fields }));
    fake.etags.set(KEY, `"e${++fake.etagSeq}"`);
  };
  const HOLD = { briefPending: true, briefDelivered: "off_gate", briefHoldReason: "off_gate: 2 open Merge Approval gates (TEAM-5602, TEAM-5604) and none is blocked by TEAM-5601" };
  const REFUSAL = `Cannot move ${BUILD} to Done: a ticket whose merge brief is held needs its completion record first — call WorkflowOutput___report_completion(ticket_id=…) (${KEY} has briefPending:true (brief off_gate) — the merge brief has not reached the Merge Approval gate; …)`;
  /** Calls `fn` once, on the first completion-record PUT made from now on. */
  const onFirstRecordPut = (fn) => {
    let fired = false;
    fake.putError = (input) => {
      if (input.Key === KEY && !fired) { fired = true; fn(); }
      return null;
    };
  };
  const rerun = async () => result(await output.handler({ tool_name: call0.tool_name, arguments: call0.arguments }));

  beforeEach(() => {
    fake.down = false;
    h.fetchStatus = 200;
  });

  it("1. a brief-hold refusal of the re-run's Done leaves briefPending:true on the record (the drain stamped it after the re-run read)", async () => {
    let refused = 0;
    fake.failTool = { Tickets___transition_ticket: (p) => {
      if (p.ticket_id !== BUILD) return null;
      if (refused++ === 0) stamp(HOLD);
      return REFUSAL;
    } };
    const res = await rerun();
    expect(refused).toBe(1);
    expect(res).toMatchObject({ status: "complete_pending_brief" });
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(record()).toMatchObject({ status: "complete_pending_brief", briefPending: true, briefDelivered: "off_gate" });
    for (const twin of TWIN_GUARDS) {
      expect((await twin()).judgeCompletionRecord(KEY, fake.objects.get(KEY))).toMatchObject({ proven: false });
    }
  });

  it("2. a hold stamped between the re-run's read and its record write withholds Done", async () => {
    onFirstRecordPut(() => stamp(HOLD));
    const res = await rerun();
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(res).toMatchObject({ status: "complete_pending_brief", next_action: "retry_report_completion" });
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(record()).toMatchObject({ status: "complete_pending_brief", briefPending: true, briefDelivered: "off_gate" });
    for (const twin of TWIN_GUARDS) {
      expect((await twin()).judgeCompletionRecord(KEY, fake.objects.get(KEY))).toMatchObject({ proven: false });
    }
  });

  it("3. a stale re-run does not overwrite the drain's clear: briefPending:false stands and the ticket goes Done", async () => {
    gateUnidentifiable();
    await tick();
    expect(record()).toMatchObject({ briefPending: true });
    // The re-run still cannot name a gate (hold stands for it) — but before its write
    // lands, a drain put the brief on the reopened gate and cleared the hold.
    onFirstRecordPut(() => stamp({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE] }));
    const res = await rerun();
    expect(res.status).toBe("complete");
    expect(record()).toMatchObject({ status: "complete", briefPending: false, briefDelivered: "gate", briefTargets: [GATE] });
    expect(fake.tickets.get(BUILD).status).toBe("Done");
  });

  it("4. the drain's step-6 write is conditional: a record that moved since step 0 is a retry, not an overwrite", async () => {
    const body = fake.queue[0].Body;
    gateUnidentifiable();
    await tick();
    expect(record()).toMatchObject({ briefPending: true });
    gateIdentifiable();
    fake.queue.push({ MessageId: "redelivered", Body: body, group: "wf_db9sx9", inFlight: null, receives: 0 });
    // A re-run's write lands while the drain is posting the brief to the gate.
    let moved = false;
    fake.beforeTool = async (tool, p) => {
      if (!moved && tool === "Tickets___add_comment" && p.ticket_id === GATE) { moved = true; stamp({ rerunWrote: true }); }
    };
    const t = await tick();
    expect(moved).toBe(true);
    expect(t.out.drained).toMatchObject({ applied: 0, retried: 1 });
    expect(record()).toMatchObject({ rerunWrote: true, briefPending: true });
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    // The next tick re-reads, finds the brief already on the gate, and clears.
    fake.beforeTool = null;
    expireVisibility();
    const t2 = await tick();
    expect(t2.out.drained).toMatchObject({ applied: 1, retried: 0 });
    expect(record()).toMatchObject({ rerunWrote: true, briefPending: false, briefDelivered: "gate", ticketWrites: "applied" });
    expect(briefComments(GATE)).toHaveLength(1);
    expect(fake.tickets.get(BUILD).status).toBe("Done");
  });

  // Finding 3, documented rather than claimed: the brief marker dedupe is read-then-write,
  // so two actors that both read the gate before either posts each post one copy. That
  // is harmless — the marker's only reader is that same dedupe, the description write is
  // idempotent, the hold clears once and the Done happens once — and this pins it.
  it.each(["null", "[]", '"string"', "42"])("TEAM-5925: drain step 0 on a record that parses to a non-object (%s) is a retry - no record write, no Done", async (body) => {
    fake.objects.set(KEY, body);
    fake.etags.set(KEY, '"odd"');
    const putsBefore = fake.puts.length;
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 });
    expect(fake.queue).toHaveLength(1);
    expect(fake.puts.slice(putsBefore).filter((p) => p.Key === KEY)).toHaveLength(0);
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(fake.objects.get(KEY)).toBe(body);
  });

  it("9. concurrent drain + re-run on a held brief: both may post, the hold ends cleared, Done once, and two copies still dedupe", async () => {
    const body = fake.queue[0].Body;
    gateUnidentifiable();
    await tick();
    expect(record()).toMatchObject({ briefPending: true });
    gateIdentifiable();
    fake.queue.push({ MessageId: "redelivered", Body: body, group: "wf_db9sx9", inFlight: null, receives: 0 });
    fake.calls.length = 0;
    // Barrier: both actors read the gate before either posts.
    let arrived = 0;
    let open;
    const barrier = new Promise((r) => { open = r; });
    const timeout = setTimeout(() => open(), 2000);
    fake.beforeTool = async (tool, p) => {
      if (tool !== "Tickets___get_issue" || p.ticket_id !== GATE) return;
      if (++arrived === 2) open();
      await barrier;
    };
    const [t, res] = await Promise.all([tick(), rerun()]);
    clearTimeout(timeout);
    fake.beforeTool = null;
    expect(arrived).toBeGreaterThanOrEqual(2);
    const late = fake.webhooks.splice(0);
    for (const w of late) await handleTicketDoneUnified(w.ticketId);
    // The documented truth: two identical marked copies.
    expect(briefComments(GATE)).toHaveLength(2);
    expect(new Set(briefComments(GATE).map((c) => c.match(/^\[brief:[0-9a-f]{12}\]/)[0])).size).toBe(1);
    expect(res.status).toBe("complete");
    expect(t.out.drained.dropped).toBe(0);
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate" });
    for (const twin of TWIN_GUARDS) {
      expect((await twin()).judgeCompletionRecord(KEY, fake.objects.get(KEY))).toMatchObject({ proven: true });
    }
    // Done once: one real status change, so one webhook and one agent.complete.
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    expect([...t.hooks, ...late].filter((w) => w.ticketId === BUILD)).toEqual([{ ticketId: BUILD, status: "Done" }]);
    expect(eventsOf("agent.complete", BUILD)).toHaveLength(1);
    // Every record write was conditional, so the stored object is a CAS winner's, never a blind overwrite.
    expect(fake.puts.filter((p) => p.Key === KEY).every((p) => p.IfMatch !== undefined || p.IfNoneMatch === "*")).toBe(true);
    // Two copies still dedupe: a third actor posts nothing.
    expireVisibility();
    await tick();
    await rerun();
    expect(briefComments(GATE)).toHaveLength(2);
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate" });
    expect(eventsOf("agent.complete", BUILD)).toHaveLength(1);
  });

  // TEAM-6042: the re-run put the held brief on the gate (and pruned its entry), then a
  // drain stamped a newer off-gate hold and a twin refused the Done on it. The forceHold
  // rewrite must keep THAT hold whole — with its brief s3Key — not force `true` over the
  // re-run's own gate fields, which left a hold no later re-run could find the brief for.
  it("TEAM-6042 a brief-hold refusal after the re-run delivered: the record keeps the drain's hold WITH its brief key, and converges", async () => {
    gateUnidentifiable(); // TEAM-6097: a Done gate is a release now (TEAM-5995), not a hold
    await tick();
    expect(record()).toMatchObject({ briefPending: true, undelivered: [expect.objectContaining({ part: "brief" })] });
    gateIdentifiable();
    const DRAIN_HOLD = {
      briefPending: true, briefDelivered: "off_gate", briefTargets: [BUILD, "TEAM-5600"], briefFallbackReason: "no open Merge Approval gate under TEAM-5600",
      undelivered: [{ part: "brief", s3Key: fixture.mergeBrief.s3Key, reason: "not on the gate: no open Merge Approval gate under TEAM-5600", postedOn: [BUILD, "TEAM-5600"] }],
    };
    let refused = 0;
    fake.failTool = { Tickets___transition_ticket: (p) => {
      if (p.ticket_id !== BUILD) return null;
      if (refused++ === 0) stamp(DRAIN_HOLD);
      return REFUSAL;
    } };
    const res = await rerun();
    expect(refused).toBe(1);
    expect(res).toMatchObject({ status: "complete_pending_brief" });
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(record()).toMatchObject({ status: "complete_pending_brief", ...DRAIN_HOLD });
    for (const twin of TWIN_GUARDS) {
      expect((await twin()).judgeCompletionRecord(KEY, fake.objects.get(KEY))).toMatchObject({ proven: false });
    }
    // Converges: a re-run whose report names no brief finds it on the record.
    fake.failTool = null;
    const evidence = call0.arguments.evidence_keys.split(",").filter((k) => !k.endsWith("/merge-brief.md")).join(",");
    const res2 = result(await output.handler({ tool_name: call0.tool_name, arguments: { ...call0.arguments, evidence_keys: evidence } }));
    expect(res2.status).toBe("complete");
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE] });
    expect(record().briefFallbackReason).toBeUndefined();
    expect(fake.tickets.get(BUILD).status).toBe("Done");
  });

  it("TEAM-5866 (2): a hold stamp the record write cannot take (409s exhausted) keeps the message - retried, stamped next tick, never a deleted message with no hold", async () => {
    const droppedMetrics = () => fake.metrics.flatMap((m) => m.MetricData || []).filter((d) => d.MetricName === "TicketReplayDropped");
    const dropNotices = () => fake.tickets.get(BUILD).comments.filter((c) => c.startsWith(`[replay-dropped:${BUILD}:brief]`));
    // No open gate ⇒ the brief is off_gate and the drain holds the Done (as :290) — but
    // every PUT of the record 409s until conditionalPut gives up (CLAIM_CONFLICT_ATTEMPTS).
    gateUnidentifiable();
    fake.putError = (input) => (input.Key === KEY ? awsError("ConditionalRequestConflict", 409, "conflict") : null);
    const putsBefore = fake.puts.length;
    const t = await tick();
    // On 534490a: dropped:1, the message deleted, 3 puts, and the record still says nothing
    // about the brief — so both twins ADMIT a Done the gate never saw a brief for.
    expect(fake.puts.slice(putsBefore).filter((p) => p.Key === KEY)).toHaveLength(3);
    expect(t.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 });
    expect(fake.queue).toHaveLength(1);
    expect(record().briefPending).toBeUndefined();
    expect(droppedMetrics()).toHaveLength(0);
    expect(eventsOf("workflow.ticket_replay_dropped", BUILD)).toHaveLength(0);
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    // S3 takes writes again: the next tick stamps the hold, then the message goes.
    fake.putError = null;
    expireVisibility();
    const t2 = await tick();
    expect(t2.out.drained).toMatchObject({ dropped: 1, retried: 0 });
    expect(fake.queue).toHaveLength(0);
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate", ticketWrites: "dropped", replayDropped: { step: "brief" } });
    for (const twin of TWIN_GUARDS) {
      expect((await twin()).judgeBriefHold(KEY, fake.objects.get(KEY))).toMatchObject({ proven: false });
    }
    expect(dropNotices()).toHaveLength(1);
    expect(droppedMetrics()).toHaveLength(1);
    expect(eventsOf("workflow.ticket_replay_dropped", BUILD)).toHaveLength(1);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
  });

  // TEAM-6056 (QA R4-3): the re-run itself puts the brief on the gate, then a twin refuses
  // Done on a hold no writer stamped. forceHold correctly resurrects nothing (the record it
  // conditions on is this call's own delivery), so the status must not claim a hold either.
  it("TEAM-6056: a brief-hold refusal with no concurrent writer - the status follows the WRITTEN hold, no stale hold resurrected", async () => {
    gateUnidentifiable(); // TEAM-6097: a Done gate is a release now (TEAM-5995), not a hold
    await tick();
    expect(record()).toMatchObject({ briefPending: true });
    gateIdentifiable();
    fake.failTool = { Tickets___transition_ticket: (p) => (p.ticket_id === BUILD ? REFUSAL : null) };
    const res = await rerun();
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE], status: "complete_transition_failed" });
    expect(record().briefHoldReason).toBeUndefined();
    expect(record().status === "complete_pending_brief").toBe(record().briefPending === true);
    expect(res).toMatchObject({ status: "complete_transition_failed", next_action: "retry_report_completion", transition: { ok: false, error: REFUSAL } });
    expect(res.message).not.toMatch(/merge brief is not on the Merge Approval gate/);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
  });
});

// TEAM-5926 (TEAM-5799 ship-review F1): a twin's Done guard read the record before the
// drain's brief-hold stamp and committed the Done after it. The drain re-reads the ticket
// once the hold is durable; a Done it finds is converged on the next tick, never undone.
describe("TEAM-5926 — a Done that lands over the brief hold", () => {
  const KEY = `completions/${BUILD}.json`;
  const EPIC = "TEAM-5600";
  const released = (id) => fake.tickets.get(id).comments.filter((c) => c.startsWith(`[brief-hold-released:${BUILD}]`));
  const briefComments = (id) => fake.tickets.get(id).comments.filter((c) => /^\[brief:[0-9a-f]{12}\]/.test(c));
  const dropNotices = (id) => fake.tickets.get(id).comments.filter((c) => c.startsWith(`[replay-dropped:${BUILD}:`));
  const droppedMetrics = () => fake.metrics.flatMap((m) => m.MetricData || []).filter((d) => d.MetricName === "TicketReplayDropped");
  const bodyOf = (input) => JSON.parse(typeof input.Body === "string" ? input.Body : Buffer.from(input.Body).toString("utf8"));
  /** Calls `fn` once, as soon as the drain's brief-hold stamp has been sent. */
  const onHoldStamp = (fn) => {
    let fired = false;
    fake.putError = (input) => {
      if (input.Key === KEY && !fired && bodyOf(input).briefPending === true) { fired = true; fn(); }
      return null;
    };
  };

  beforeEach(() => {
    fake.down = false;
    h.fetchStatus = 200;
    gateUnidentifiable(); // no nameable gate ⇒ the brief goes off_gate ⇒ a hold
  });

  it("(d1) the ticket reaches Done right after the hold stamp ⇒ retry, then the next tick converges the record and says so - keeping the hold (TEAM-5958)", async () => {
    // The twin's Done committing between the drain's stamp and its re-read.
    onHoldStamp(() => { fake.tickets.get(BUILD).status = "Done"; });

    const t1 = await tick();
    expect(t1.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 });
    expect(fake.queue).toHaveLength(1);
    expect(record()).toMatchObject({ briefPending: true, ticketWrites: "dropped" });
    expect(droppedMetrics()).toHaveLength(0);
    expect(eventsOf("workflow.ticket_replay_dropped", BUILD)).toHaveLength(0);

    fake.putError = null;
    expireVisibility();
    const t2 = await tick();
    expect(t2.out.drained).toMatchObject({ applied: 1, dropped: 0, retried: 0 });
    expect(fake.queue).toHaveLength(0);
    // TEAM-5958 (TEAM-5799 F4): the brief is still off the gate, so the hold STAYS. The
    // Done is converged (applied, message gone, notice posted) but `briefPending` goes
    // false only on gate delivery - a reopen then finds the twins' guard still refusing.
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate", ticketWrites: "applied", status: "complete" });
    expect(record().undelivered[0]).toMatchObject({ part: "brief", reason: expect.stringMatching(/^not on the gate: /) });
    for (const twin of TWIN_GUARDS) {
      expect((await twin()).judgeBriefHold(KEY, fake.objects.get(KEY))).toMatchObject({ proven: false, why: expect.stringMatching(/has briefPending:true \(brief off_gate\)/) });
    }
    for (const id of [BUILD, EPIC]) {
      expect(released(id)).toHaveLength(1);
      expect(released(id)[0]).toMatch(/earlier "LEFT OPEN" replay notice is superseded/);
      expect(released(id)[0]).toMatch(/still holds briefPending:true/);
      expect(briefComments(id)).toHaveLength(1);
    }
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(droppedMetrics()).toHaveLength(0);
  });

  it("(d2) the ticket is still open on the re-read ⇒ the drop is unchanged: held, noticed, metered, deleted", async () => {
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 0, dropped: 1, retried: 0 });
    expect(fake.queue).toHaveLength(0);
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate", ticketWrites: "dropped", replayDropped: { step: "brief" } });
    expect(droppedMetrics()).toHaveLength(1);
    expect(eventsOf("workflow.ticket_replay_dropped", BUILD)).toHaveLength(1);
    for (const id of [BUILD, EPIC]) {
      expect(dropNotices(id)).toHaveLength(1);
      expect(released(id)).toHaveLength(0);
    }
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
  });

  it("(d3) the post-stamp re-read fails ⇒ retry; the redelivery posts nothing twice", async () => {
    let stamped = false;
    let failed = false;
    onHoldStamp(() => { stamped = true; });
    fake.failTool = { Tickets___get_issue: (p) => (stamped && !failed && p.ticket_id === BUILD ? ((failed = true), PROVIDER_503) : null) };

    const t1 = await tick();
    expect(t1.out.drained).toMatchObject({ dropped: 0, retried: 1 });
    expect(record()).toMatchObject({ briefPending: true });
    expect(droppedMetrics()).toHaveLength(0);

    fake.failTool = null;
    fake.putError = null;
    expireVisibility();
    const t2 = await tick();
    expect(t2.out.drained).toMatchObject({ dropped: 1, retried: 0 });
    for (const id of [BUILD, EPIC]) {
      expect(briefComments(id)).toHaveLength(1);
      expect(dropNotices(id)).toHaveLength(1);
    }
    expect(record()).toMatchObject({ briefPending: true, ticketWrites: "dropped" });
    expect(droppedMetrics()).toHaveLength(1);
  });

  it("(d3b) the re-read fails, the Done lands meanwhile ⇒ converged once; a duplicate message changes nothing", async () => {
    let stamped = false;
    let failed = false;
    onHoldStamp(() => { stamped = true; });
    fake.failTool = { Tickets___get_issue: (p) => (stamped && !failed && p.ticket_id === BUILD ? ((failed = true), PROVIDER_503) : null) };
    const body = fake.queue[0].Body;
    expect((await tick()).out.drained).toMatchObject({ retried: 1 });

    fake.failTool = null;
    fake.putError = null;
    fake.tickets.get(BUILD).status = "Done";
    expireVisibility();
    expect((await tick()).out.drained).toMatchObject({ applied: 1 });
    expect(record()).toMatchObject({ briefPending: true, ticketWrites: "applied" }); // TEAM-5958: the hold is kept

    const comments = [BUILD, EPIC].map((id) => fake.tickets.get(id).comments.length);
    fake.queue.push({ MessageId: "dup", Body: body, group: fake.queue[0]?.group || "g", inFlight: null, receives: 0 });
    await tick();
    expect([BUILD, EPIC].map((id) => fake.tickets.get(id).comments.length)).toEqual(comments);
    for (const id of [BUILD, EPIC]) expect(released(id)).toHaveLength(1);
    expect(record()).toMatchObject({ briefPending: true, ticketWrites: "applied" }); // TEAM-5958: the hold is kept
  });

  it("(d4) a follow-ups-only hold over a brief hold on a Done ticket ⇒ the follow-ups stamp KEEPS the brief hold and says the Done superseded the LEFT OPEN notice", async () => {
    // The (d1) state one step on: a hold stamped, the ticket Done, and now a follow-up
    // no retry can file. TEAM-5926 cleared briefPending here; TEAM-5958 keeps it - the
    // brief is still off the gate, and only gate delivery clears the hold. What this
    // guards: the follow-ups drop over a Done ticket is FINAL (dropped, not retry), the
    // superseded notice is posted once, and `{...record, ...extra}` carries the hold.
    fake.objects.set(KEY, JSON.stringify({ ...record(), briefPending: true, briefDelivered: "off_gate" }));
    fake.etags.set(KEY, `"e${++fake.etagSeq}"`);
    fake.tickets.get(BUILD).status = "Done";
    fake.failTool = { Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };

    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1 });
    expect(record()).toMatchObject({ followUpsPending: true, briefPending: true, briefDelivered: "off_gate", replayDropped: { step: "follow_ups" } });
    for (const id of [BUILD, EPIC]) expect(released(id)).toHaveLength(1);
    expect(fake.queue).toHaveLength(0); // final: the message is gone, the hold is on the record
  });

  it("(d5) neither twin's post-commit warning reads as a brief-hold refusal", async () => {
    for (const twin of TWIN_GUARDS) {
      const g = await twin();
      expect(output.isBriefHoldRefusal(g.DONE_OVER_BRIEF_HOLD_WARNING)).toBe(false);
      expect(output.isBriefHoldRefusal(g.DONE_OVER_FOLLOW_UPS_HOLD_WARNING)).toBe(false);
      expect(output.isBriefHoldRefusal(g.postCommitUncheckedWarning("could not read completions/X.json (InternalError 500)"))).toBe(false);
    }
  });

  it("(d6) a follow-ups hold stamped, then the ticket reaches Done ⇒ retry, then the already-Done follow_ups drop is final", async () => {
    // TEAM-5926 sibling: the brief is on its gate, a follow-up no retry can file holds
    // the ticket, and a twin's Done commits right after the followUpsPending:true stamp.
    gateIdentifiable();
    fake.failTool = { Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };
    let fired = false;
    fake.putError = (input) => {
      if (input.Key === KEY && !fired && bodyOf(input).followUpsPending === true) { fired = true; fake.tickets.get(BUILD).status = "Done"; }
      return null;
    };

    const t1 = await tick();
    expect(fired).toBe(true);
    expect(t1.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 });
    expect(fake.queue).toHaveLength(1);
    expect(record()).toMatchObject({ followUpsPending: true, ticketWrites: "dropped", replayDropped: { step: "follow_ups" } });
    expect(droppedMetrics()).toHaveLength(0);
    expect(eventsOf("workflow.ticket_replay_dropped", BUILD)).toHaveLength(0);

    // The next tick reads the ticket Done: the follow-ups are still unfiled, so it is the
    // already-Done path — the record keeps followUpsPending:true for the human who files
    // them, and the drop is final, said once.
    fake.putError = null;
    expireVisibility();
    const t2 = await tick();
    expect(t2.out.drained).toMatchObject({ applied: 0, dropped: 1, retried: 0 });
    expect(fake.queue).toHaveLength(0);
    expect(record()).toMatchObject({ followUpsPending: true, ticketWrites: "dropped", replayDropped: { step: "follow_ups" } });
    expect(record().briefPending).toBe(false); // TEAM-6124: a gate delivery states the hold false
    expect(droppedMetrics()).toHaveLength(1);
    expect(eventsOf("workflow.ticket_replay_dropped", BUILD)).toHaveLength(1);
    for (const id of [BUILD, EPIC]) {
      expect(dropNotices(id)).toHaveLength(1);
      expect(released(id)).toHaveLength(0);
    }
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(fake.tickets.get(BUILD).status).toBe("Done");
  });
});

// TEAM-5941 (TEAM-5799 ship-review r2 F1): the twins now write `doneIntent` onto the
// completion record (IfMatch) as the last step before their commit. The drain reads it
// (doneIntentFresh, mirroring gate-contract.mjs doneIntentOf): a FRESH intent on a ticket
// that is not Done yet means a Done is in flight — no hold is stamped, no LEFT OPEN notice
// is posted, the message retries; a STALE one (the twin died) is stripped by the next stamp.
describe("TEAM-5941 — the drain and a twin's Done-intent fence", () => {
  const KEY = `completions/${BUILD}.json`;
  const EPIC = "TEAM-5600";
  const released = (id) => fake.tickets.get(id).comments.filter((c) => c.startsWith(`[brief-hold-released:${BUILD}]`));
  const briefComments = (id) => fake.tickets.get(id).comments.filter((c) => /^\[brief:[0-9a-f]{12}\]/.test(c));
  const dropNotices = (id) => fake.tickets.get(id).comments.filter((c) => c.startsWith(`[replay-dropped:${BUILD}:`));
  const droppedMetrics = () => fake.metrics.flatMap((m) => m.MetricData || []).filter((d) => d.MetricName === "TicketReplayDropped");
  const bodyOf = (input) => JSON.parse(typeof input.Body === "string" ? input.Body : Buffer.from(input.Body).toString("utf8"));
  const INTENT = (at) => ({ at, provider: "jira", nonce: "0f8fad5b-d9cb-469f-a165-70867728950e" });
  /** What the real twin does inside a Done: rewrite the record with a fresh intent (new ETag). */
  const fenceRecord = (at = new Date().toISOString()) => {
    fake.objects.set(KEY, JSON.stringify({ ...record(), doneIntent: INTENT(at) }));
    fake.etags.set(KEY, `"e${++fake.etagSeq}"`);
  };
  const STALE_AT = () => new Date(Date.now() - (output.DONE_INTENT_TTL_MS + 60_000)).toISOString();

  beforeEach(() => {
    fake.down = false;
    h.fetchStatus = 200;
    gateUnidentifiable(); // no nameable gate ⇒ the brief goes off_gate ⇒ a hold
  });

  it("(g1) a fresh intent on an open ticket ⇒ retry: no hold stamped, no LEFT OPEN notice, no metric; the off-gate brief notice is still posted", async () => {
    fenceRecord();
    const etag = fake.etags.get(KEY);

    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 });
    expect(fake.queue).toHaveLength(1);
    expect(fake.etags.get(KEY)).toBe(etag); // not one record write
    expect(record().briefPending).toBeUndefined();
    expect(record().doneIntent).toEqual(INTENT(record().doneIntent.at));
    for (const id of [BUILD, EPIC]) {
      expect(dropNotices(id)).toHaveLength(0);
      expect(briefComments(id)).toHaveLength(1); // the brief's own fallback notice
      expect(released(id)).toHaveLength(0);
    }
    expect(droppedMetrics()).toHaveLength(0);
    expect(eventsOf("workflow.ticket_replay_dropped", BUILD)).toHaveLength(0);
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
  });

  it("(g2) …then the ticket reads Done ⇒ the next tick applies with NO hold: briefDelivered off_gate, the intent carried, both twins' guard admits, no released notice", async () => {
    fenceRecord();
    expect((await tick()).out.drained).toMatchObject({ retried: 1 });

    fake.tickets.get(BUILD).status = "Done";
    expireVisibility();
    const t2 = await tick();
    expect(t2.out.drained).toMatchObject({ applied: 1, dropped: 0, retried: 0 });
    expect(fake.queue).toHaveLength(0);
    expect(record()).toMatchObject({ briefDelivered: "off_gate", ticketWrites: "applied", status: "complete" });
    expect(record().briefPending).toBeUndefined();
    expect(record().doneIntent).toBeTruthy();
    for (const twin of TWIN_GUARDS) expect((await twin()).judgeBriefHold(KEY, fake.objects.get(KEY))).toBeNull();
    for (const id of [BUILD, EPIC]) {
      expect(released(id)).toHaveLength(0); // there was never a hold to release
      expect(briefComments(id)).toHaveLength(1); // deduped
      expect(dropNotices(id)).toHaveLength(0);
    }
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(droppedMetrics()).toHaveLength(0);
  });

  it("(g3) a STALE intent (the twin died) ⇒ the normal held drop, and the stamp strips the intent", async () => {
    fenceRecord(STALE_AT());

    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 0, dropped: 1, retried: 0 });
    expect(fake.queue).toHaveLength(0);
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate", ticketWrites: "dropped", replayDropped: { step: "brief" } });
    expect(record().doneIntent).toBeUndefined();
    for (const id of [BUILD, EPIC]) expect(dropNotices(id)).toHaveLength(1);
    expect(droppedMetrics()).toHaveLength(1);
    for (const twin of TWIN_GUARDS) expect((await twin()).judgeBriefHold(KEY, fake.objects.get(KEY))).toMatchObject({ proven: false });
  });

  it("(g4) the hold stamp loses the CAS to a fence landing between step 0 and the stamp ⇒ retry; the next tick sees the fresh intent and retries without a notice; Done ⇒ applied", async () => {
    let fenced = false;
    fake.putError = (input) => {
      if (input.Key === KEY && !fenced && bodyOf(input).briefPending === true) {
        fenced = true;
        fenceRecord(); // the twin's fence lands first…
        return awsError("PreconditionFailed", 412, "At least one of the pre-conditions you specified did not hold"); // …so the stamp 412s
      }
      return null;
    };

    const t1 = await tick();
    expect(fenced).toBe(true);
    expect(t1.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 });
    expect(record().briefPending).toBeUndefined();
    expect(record().doneIntent).toBeTruthy();
    // The LEFT OPEN notice went out before the stamp lost (TEAM-5866 posts notices first);
    // the Done that follows supersedes it. Documented residual.
    for (const id of [BUILD, EPIC]) expect(dropNotices(id)).toHaveLength(1);

    fake.putError = null;
    expireVisibility();
    const t2 = await tick();
    expect(t2.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 }); // a Done in flight
    expect(record().briefPending).toBeUndefined();
    for (const id of [BUILD, EPIC]) expect(dropNotices(id)).toHaveLength(1); // not a second one

    fake.tickets.get(BUILD).status = "Done";
    expireVisibility();
    const t3 = await tick();
    expect(t3.out.drained).toMatchObject({ applied: 1 });
    expect(record()).toMatchObject({ briefDelivered: "off_gate", ticketWrites: "applied" });
    expect(record().briefPending).toBeUndefined();
    expect(droppedMetrics()).toHaveLength(0);
  });

  it("(g5) a follow-ups hold (an unfilable follow-up) with a fresh intent on an open ticket ⇒ retry, nothing stamped, no notice", async () => {
    gateIdentifiable(); // the brief has its gate: no brief hold
    fake.failTool = { Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };
    fenceRecord();
    const etag = fake.etags.get(KEY);

    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 });
    expect(fake.etags.get(KEY)).toBe(etag);
    expect(record().ticketWrites).toBe("queued");
    for (const id of [BUILD, EPIC]) expect(dropNotices(id)).toHaveLength(0);
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
  });

  it("(g6) a follow-ups hold on a ticket ALREADY Done at step 1, fresh intent or not ⇒ stamped as before (nothing left to fence)", async () => {
    gateIdentifiable();
    fake.failTool = { Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };
    fake.tickets.get(BUILD).status = "Done";
    fenceRecord();

    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1 });
    expect(record()).toMatchObject({ followUpsPending: true, ticketWrites: "dropped", replayDropped: { step: "follow_ups" } });
    expect(record().doneIntent).toBeTruthy(); // fresh: carried, not stripped
    for (const id of [BUILD, EPIC]) expect(dropNotices(id)).toHaveLength(1);
  });

  it("(g8) the drain's OWN Done is fenced by the twin (the record is rewritten under the transition) ⇒ the applied stamp still lands and keeps the intent; a redelivered message is `already applied`", async () => {
    gateIdentifiable(); // brief on its gate, follow-up filed: a clean Done
    fake.onTransition = () => fenceRecord(); // what the real twin does inside transition_ticket

    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 1, dropped: 0, retried: 0 });
    expect(tools("Tickets___transition_ticket")).toHaveLength(1);
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    expect(record()).toMatchObject({ status: "complete", followUpsPending: false, ticketWrites: "applied" });
    expect(record().doneIntent).toBeTruthy(); // the twin's fence survives the applied stamp
    expect(fake.queue).toHaveLength(0);

    // A duplicate message: the `already applied` dedupe fires (it needs ticketWrites:"applied").
    const comments = [BUILD, EPIC].map((id) => fake.tickets.get(id).comments.length);
    fake.queue.push({ MessageId: "dup", Body: JSON.stringify({ ...JSON.parse(fake.sends[0].MessageBody), queuedAt: new Date().toISOString() }), group: "g", inFlight: null, receives: 0 });
    const t2 = await tick();
    expect(t2.out.drained).toMatchObject({ applied: 0, dropped: 1, retried: 0 });
    expect([BUILD, EPIC].map((id) => fake.tickets.get(id).comments.length)).toEqual(comments);
    expect(tools("Tickets___transition_ticket")).toHaveLength(1);
  });
});

// TEAM-6057: a later drain whose brief object is gone records briefDelivered:"undelivered".
// Both of its writes merge onto the prior record — step 6's Object.assign (ticket already
// Done) and drop()'s spread (the brief hold) — so an earlier outcome's briefTargets (the
// gate's, or an off-gate post's) and off-gate briefFallbackReason must come off with it.
describe("TEAM-6057 — an undelivered brief keeps no earlier outcome's targets", () => {
  const redeliverWithoutBrief = async () => {
    fake.objects.delete(fixture.mergeBrief.s3Key);
    fake.queue.push({ MessageId: "redelivered", Body: body0, group: "wf_db9sx9", inFlight: null, receives: 0 });
    return (await tick()).out.drained;
  };
  let body0;
  beforeEach(() => {
    fake.down = false;
    h.fetchStatus = 200;
    body0 = fake.queue[0].Body;
  });

  // Step 6 stamps the brief on the gate, then the Done 400s (step 7): a dropped record
  // carrying briefTargets:[GATE] that a redelivered message drains again.
  const gateThenDoneRefused = async () => {
    fake.failTool = { Tickets___transition_ticket: (p) => (p.ticket_id === BUILD ? "Jira API 400: a required field is missing" : null) };
    expect((await tick()).out.drained).toMatchObject({ applied: 0, dropped: 1 });
    expect(record()).toMatchObject({ briefDelivered: "gate", briefTargets: [GATE], ticketWrites: "dropped", replayDropped: { step: "transition" } });
    fake.failTool = null;
  };

  it("TEAM-6057 gate, then undelivered on step 6 (ticket already Done) ⇒ the gate's briefTargets is gone", async () => {
    await gateThenDoneRefused();
    fake.tickets.get(BUILD).status = "Done";
    expect(await redeliverWithoutBrief()).toMatchObject({ applied: 1, dropped: 0 });
    expect(record()).toMatchObject({ briefDelivered: "undelivered", ticketWrites: "applied" });
    expect(record().briefTargets).toBeUndefined();
    expect(record().briefFallbackReason).toBeUndefined();
    expect(record().undelivered).toEqual([expect.objectContaining({ part: "brief", reason: expect.stringMatching(/does not exist/) })]);
  });

  it("TEAM-6057 gate, then undelivered on the hold path (ticket still open) ⇒ the gate's briefTargets is gone, the hold stands", async () => {
    await gateThenDoneRefused();
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(await redeliverWithoutBrief()).toMatchObject({ applied: 0, dropped: 1 });
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "undelivered", ticketWrites: "dropped", replayDropped: { step: "brief" } });
    expect(record().briefTargets).toBeUndefined();
    expect(record().briefFallbackReason).toBeUndefined();
    for (const twin of TWIN_GUARDS) {
      const v = (await twin()).judgeCompletionRecord(`completions/${BUILD}.json`, fake.objects.get(`completions/${BUILD}.json`));
      expect(v).toMatchObject({ proven: false, why: expect.stringContaining("has briefPending:true (brief undelivered)") });
    }
  });

  it("TEAM-6057 off the gate, then undelivered ⇒ the off-gate briefTargets and briefFallbackReason are gone", async () => {
    gateUnidentifiable(); // TEAM-6097: a Done gate is a release now (TEAM-5995), not a hold
    await tick();
    expect(record()).toMatchObject({
      briefPending: true, briefDelivered: "off_gate", briefTargets: [BUILD, "TEAM-5600"],
      briefFallbackReason: expect.stringMatching(/2 open Merge Approval gates/),
    });
    expect(await redeliverWithoutBrief()).toMatchObject({ applied: 0, dropped: 1 });
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "undelivered", ticketWrites: "dropped" });
    expect(record().briefTargets).toBeUndefined();
    expect(record().briefFallbackReason).toBeUndefined();
    expect(record().undelivered).toEqual([expect.objectContaining({ part: "brief", reason: expect.stringMatching(/does not exist/) })]);
  });
});

// TEAM-5995 (TEAM-5799 F9): a brief hold the drain stamped because no OPEN gate exists
// never converged — the gate was already Done, or the run never gets one — since only a
// gate delivery cleared it. A hold is released WITHOUT a gate only on verified evidence
// that no gate needs the brief (briefDisposition); anything unknown keeps it.
describe("TEAM-5995 — a brief hold with no deliverable gate", () => {
  const KEY = `completions/${BUILD}.json`;
  const REPO = { repos: [{ url: "https://github.com/owner/repo" }] };
  const resolvedNotices = (id) => (fake.tickets.get(id)?.comments || []).filter((c) => c.startsWith(`[brief-resolved:${BUILD}]`));
  const briefComments = (id) => fake.tickets.get(id).comments.filter((c) => /^\[brief:[0-9a-f]{12}\]/.test(c));
  const rerun = async (args = {}) => result(await output.handler({ tool_name: call0.tool_name, arguments: { ...call0.arguments, ...args } }));
  const allGatesDone = () => { for (const t of fake.tickets.values()) if (/^Merge Approval:/.test(t.title)) t.status = "Done"; };
  /** The run's row as start/route.ts persists it: the def id and the target repo. */
  const runOf = (workflowDefId, repoConfig = REPO) => { h.workflowRow = { workflowId: "db9sx9", workflowDefId, repoConfig }; };
  const registry = (repos) => fake.objects.set("config/cd-registry.json", JSON.stringify({ version: 1, repos }));
  const noGate = () => fake.tickets.delete(GATE);
  const s3Refuses = (key, name, status) => {
    fake.getError = (input) => (input.Key === key ? Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } }) : null);
  };
  const twinsAdmit = async () => {
    for (const twin of TWIN_GUARDS) {
      const m = await twin();
      expect(m.judgeCompletionRecord(KEY, fake.objects.get(KEY))).toMatchObject({ proven: true });
      expect(m.judgeBriefHold(KEY, fake.objects.get(KEY))).toBeNull();
    }
  };
  const twinsRefuse = async () => {
    for (const twin of TWIN_GUARDS) expect((await twin()).judgeBriefHold(KEY, fake.objects.get(KEY))).toMatchObject({ proven: false });
  };
  /** list_tickets answers, but says its roster is truncated (TEAM-5168 `complete:false`). */
  const truncateRoster = async () => {
    const { LambdaClient } = await import("@aws-sdk/client-lambda");
    const real = LambdaClient.prototype.send;
    return vi.spyOn(LambdaClient.prototype, "send").mockImplementation(async function (c) {
      const out = await real.call(this, c);
      const raw = c?.input?.Payload;
      const call = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      if (call.tool_name !== "Tickets___list_tickets" || !out?.Payload) return out;
      const payload = JSON.parse(new TextDecoder().decode(out.Payload));
      return { ...out, Payload: new TextEncoder().encode(JSON.stringify({ ...payload, complete: false })) };
    });
  };

  beforeEach(() => {
    fake.down = false;
    h.fetchStatus = 200;
    fake.objects.set("config/workflows.json", JSON.stringify(workflowsConfig));
  });

  it("T1 drain: every Merge Approval gate Done ⇒ applied with no hold, briefDisposition gate_settled, audit on ticket/epic/gate, twins admit", async () => {
    fake.tickets.get(GATE).status = "Done";
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 1, dropped: 0, retried: 0 });
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    expect(record().briefPending).toBe(false); // TEAM-6124: stated, so the next report carries it
    expect(record()).toMatchObject({
      ticketWrites: "applied", briefDelivered: "off_gate",
      briefDisposition: { release: true, kind: "gate_settled", by: "drain", observed: [{ ticketId: GATE, status: "Done" }] },
    });
    expect(Date.parse(record().briefDisposition.at)).not.toBeNaN();
    for (const id of [BUILD, "TEAM-5600", GATE]) expect(resolvedNotices(id)).toHaveLength(1);
    expect(resolvedNotices(GATE)[0]).toContain(`${GATE}:Done`);
    expect(resolvedNotices(BUILD)[0]).toContain(KEY);
    for (const id of [BUILD, "TEAM-5600"]) {
      expect(briefComments(id)).toHaveLength(1);
      expect(briefComments(id)[0]).toContain("no gate needs it");
      expect(briefComments(id)[0]).not.toContain("MERGE BRIEF NOT ON THE GATE");
    }
    await twinsAdmit();
  });

  it("T2 retry: a hold installed under ambiguous gates releases once every gate is Done ⇒ complete, briefPending:false, Done, one [brief-resolved]; a second retry is idempotent", async () => {
    gateUnidentifiable();
    await tick();
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate" });
    allGatesDone();
    fake.calls.length = 0;
    const res = await rerun();
    expect(res).toMatchObject({ status: "complete" });
    expect(res.next_action).toBeUndefined();
    expect(tools("Tickets___transition_ticket")).toHaveLength(1);
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    expect(record()).toMatchObject({
      status: "complete", briefPending: false, briefDelivered: "off_gate",
      briefDisposition: { release: true, kind: "gate_settled", by: "report_completion" },
    });
    expect(record().briefDisposition.observed).toHaveLength(2);
    expect(record().briefDisposition.observed).toEqual(expect.arrayContaining([{ ticketId: GATE, status: "Done" }, { ticketId: "TEAM-5604", status: "Done" }]));
    expect(record().briefHoldReason).toBeUndefined();
    for (const id of [BUILD, "TEAM-5600", GATE, "TEAM-5604"]) expect(resolvedNotices(id)).toHaveLength(1);
    await twinsAdmit();
    const again = await rerun();
    expect(again.status).toBe("complete");
    for (const id of [BUILD, "TEAM-5600", GATE, "TEAM-5604"]) expect(resolvedNotices(id)).toHaveLength(1);
    expect(record()).toMatchObject({ briefPending: false, briefDisposition: { kind: "gate_settled" } });
  });

  it("T3 a later re-run carries briefDisposition (BRIEF_HOLD_FIELDS)", async () => {
    gateUnidentifiable();
    await tick();
    allGatesDone();
    await rerun();
    const disposition = record().briefDisposition;
    expect(disposition).toMatchObject({ release: true, kind: "gate_settled" });
    await rerun({ summary: `${call0.arguments.summary} (re-run)` });
    expect(record().briefDisposition).toEqual(disposition);
    expect(record().briefPending).toBe(false);
  });

  it("T5 a drain hold stamped over a released record drops briefDisposition and sets briefPending:true", async () => {
    fake.objects.set(KEY, JSON.stringify({ ...JSON.parse(fake.objects.get(KEY)), briefPending: false, briefDelivered: "off_gate", briefDisposition: { release: true, kind: "gate_settled", observed: [{ ticketId: GATE, status: "Done" }], at: "2026-10-14T00:00:00.000Z", by: "report_completion" } }));
    fake.etags.set(KEY, `"e${++fake.etagSeq}"`);
    // A second, open gate appeared since the release, and neither names the ticket.
    gateUnidentifiable();
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1 });
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate", replayDropped: { step: "brief" } });
    expect(record().briefDisposition).toBeUndefined();
    await twinsRefuse();
  });

  it("T6a gate Done but the roster is truncated (complete:false) ⇒ the hold stays (roster_incomplete)", async () => {
    gateUnidentifiable();
    await tick();
    allGatesDone();
    const spy = await truncateRoster();
    try {
      const res = await rerun({ follow_ups: undefined });
      expect(res.status).not.toBe("complete");
      expect(fake.tickets.get(BUILD).status).toBe("In Progress");
      expect(record()).toMatchObject({ briefPending: true });
      expect(record().briefDisposition).toBeUndefined();
      expect(record().briefHoldReason).toMatch(/roster is incomplete/);
    } finally {
      spy.mockRestore();
    }
    await twinsRefuse();
  });

  it("T6b no gate, and the run owes one (operator def) ⇒ the hold stays and says how to create the gate (no_gate)", async () => {
    noGate();
    runOf("operator");
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1 });
    expect(record()).toMatchObject({ briefPending: true });
    expect(record().briefDisposition).toBeUndefined();
    expect(record().replayDropped.error).toMatch(/this run owes one \(def operator/);
    expect(record().replayDropped.error).toMatch(/create ONE 'Merge Approval:' ticket/);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    await twinsRefuse();
  });

  it("T6c a Done gate plus an open one that does not name the ticket ⇒ the hold stays (gate_open)", async () => {
    fake.tickets.get(GATE).status = "Done";
    seedTicket({ ticketId: "TEAM-5604", title: "Merge Approval: db9sx9 (hotfix)", status: "To Do", assignee: "human:approver", parentKey: "TEAM-5600", blockedBy: ["TEAM-5699"] });
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1 });
    expect(record()).toMatchObject({ briefPending: true });
    expect(record().briefDisposition).toBeUndefined();
    expect(record().replayDropped.error).toMatch(/1 open Merge Approval gates \(TEAM-5604\) and none is blocked by TEAM-5601/);
    expect(resolvedNotices(BUILD)).toHaveLength(0);
    await twinsRefuse();
  });

  it("T6d briefGateDisposition: only a complete roster with every gate Done, or a verified never-gated run, releases", () => {
    const g = (ticketId, status, assignee = "human:approver") => ({ ticketId, summary: `Merge Approval: ${ticketId}`, status, assignee });
    const d = (over) => output.briefGateDisposition({ ticketId: BUILD, epicKey: "TEAM-5600", siblings: [], scanComplete: true, gateOwed: null, ...over });
    expect(d({ epicKey: null })).toMatchObject({ release: false, kind: "no_epic" });
    expect(d({ scanComplete: false, siblings: [g(GATE, "Done")] })).toMatchObject({ release: false, kind: "roster_incomplete" });
    expect(d({ scanComplete: undefined, siblings: [g(GATE, "Done")] })).toMatchObject({ release: false, kind: "roster_incomplete" });
    expect(d({ siblings: [g(GATE, "Done")] })).toMatchObject({ release: true, kind: "gate_settled", observed: [{ ticketId: GATE, status: "Done" }] });
    expect(d({ siblings: [g(GATE, "done"), g("TEAM-5604", "DONE")] })).toMatchObject({ release: true, kind: "gate_settled" });
    expect(d({ siblings: [g(GATE, "Done"), g("TEAM-5604", "In Review")] })).toMatchObject({ release: false, kind: "gate_open" });
    expect(d({ gateOwed: { owed: false, detail: "x" } })).toMatchObject({ release: true, kind: "absent_never_gated" });
    expect(d({ gateOwed: { owed: true, detail: "x" } })).toMatchObject({ release: false, kind: "no_gate" });
    expect(d({ gateOwed: { owed: "unknown", detail: "x" } })).toMatchObject({ release: false, kind: "gate_owed_unknown" });
    expect(d({ gateOwed: null })).toMatchObject({ release: false, kind: "gate_owed_unknown" });
    expect(d({ gateOwed: { owed: "false", detail: "x" } })).toMatchObject({ release: false, kind: "gate_owed_unknown" });
    // An agent-assigned "Merge Approval:" row is not a gate, and neither is the ticket itself.
    expect(d({ siblings: [g("TEAM-5605", "Done", "agentcore_hub_operator")], gateOwed: { owed: true, detail: "x" } })).toMatchObject({ release: false, kind: "no_gate" });
    expect(d({ siblings: [g(BUILD, "Done")], gateOwed: { owed: "unknown", detail: "x" } })).toMatchObject({ release: false, kind: "gate_owed_unknown" });
  });

  it.each([
    ["the run's row is missing", () => {}],
    ["the run's row is unreadable", () => { h.workflowRowError = Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" }); }],
    ["config/workflows.json is refused (403)", () => { runOf("software-delivery"); s3Refuses("config/workflows.json", "AccessDenied", 403); }],
    ["config/cd-registry.json cannot be read (503)", () => { runOf("software-delivery"); s3Refuses("config/cd-registry.json", "ServiceUnavailable", 503); }],
    ["the def id is unknown", () => { runOf("no-such-def"); }],
  ])("T6e no gate and %s ⇒ the hold stays (gate_owed_unknown)", async (_name, arrange) => {
    noGate();
    arrange();
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1 });
    expect(record()).toMatchObject({ briefPending: true });
    expect(record().briefDisposition).toBeUndefined();
    expect(record().replayDropped.error).toMatch(/whether this run owes one could not be determined/);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
  });

  it("T7 a 503 on the [brief-resolved] comment keeps the hold: the drain retries with the record untouched, and a retry answers complete_pending_brief", async () => {
    // Drain: nothing is recorded until the audit comment is on the board.
    fake.tickets.get(GATE).status = "Done";
    fake.failTool = { Tickets___add_comment: (p) => (p.comment.startsWith("[brief-resolved:") ? PROVIDER_503 : null) };
    const putsBefore = fake.puts.filter((p) => p.Key === KEY).length;
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 });
    expect(fake.puts.filter((p) => p.Key === KEY)).toHaveLength(putsBefore);
    expect(record().ticketWrites).toBe("queued");
    expect(record().briefDisposition).toBeUndefined();
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    // The comment lands on the next tick, then the release does.
    fake.failTool = null;
    expireVisibility();
    const t2 = await tick();
    expect(t2.out.drained).toMatchObject({ applied: 1 });
    expect(record()).toMatchObject({ briefDisposition: { kind: "gate_settled" } });
  });

  it("T7 (retry path) a 503 on the [brief-resolved] comment ⇒ the hold stays, no Done", async () => {
    gateUnidentifiable();
    await tick();
    allGatesDone();
    fake.failTool = { Tickets___add_comment: (p) => (p.comment.startsWith("[brief-resolved:") ? PROVIDER_503 : null) };
    fake.calls.length = 0;
    const res = await rerun();
    expect(res.status).not.toBe("complete");
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(record()).toMatchObject({ briefPending: true });
    expect(record().briefDisposition).toBeUndefined();
    await twinsRefuse();
    fake.failTool = null;
    expect((await rerun()).status).toBe("complete");
    expect(record()).toMatchObject({ briefPending: false, briefDisposition: { kind: "gate_settled" } });
  });

  it("T8 the ticket is reopened during the retry with every gate Done ⇒ the release still lands (the evidence is the gates, not the ticket) and the twins admit its Done", async () => {
    gateUnidentifiable();
    await tick();
    allGatesDone();
    fake.tickets.get(BUILD).status = "Done";
    let reopened = false;
    fake.beforeTool = async (tool, p) => {
      if (!reopened && tool === "Tickets___add_comment" && String(p.comment).startsWith("[brief-resolved:")) {
        reopened = true;
        fake.tickets.get(BUILD).status = "In Progress";
      }
    };
    await rerun();
    fake.beforeTool = null;
    expect(reopened).toBe(true);
    expect(record()).toMatchObject({ briefPending: false, briefDisposition: { release: true, kind: "gate_settled" } });
    await twinsAdmit();
  });

  it.each([
    ["software-delivery on a repo the CD registry does not list (handoff: the ship gate is stripped)", () => { runOf("software-delivery"); registry([{ repo: "acme/other", pipeline: "hub-other-deploy" }]); }, /handoff/],
    ["software-delivery with no CD registry in S3 (every repo is HANDOFF)", () => { runOf("software-delivery"); }, /handoff/],
    ["software-delivery with an empty CD registry", () => { runOf("software-delivery"); registry([]); }, /handoff/],
    ["legal (the def declares no Merge Approval gate)", () => { runOf("legal"); }, /def legal declares no Merge Approval gate/],
  ])("T9 verified absent: %s ⇒ released (absent_never_gated), audited, Done", async (_name, arrange, detail) => {
    noGate();
    arrange();
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 1, dropped: 0 });
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    expect(record().briefPending).toBe(false); // TEAM-6124
    expect(record()).toMatchObject({ briefDelivered: "off_gate", briefDisposition: { release: true, kind: "absent_never_gated", observed: [], gateOwed: { owed: false } } });
    expect(record().briefDisposition.gateOwed.detail).toMatch(detail);
    for (const id of [BUILD, "TEAM-5600"]) expect(resolvedNotices(id)).toHaveLength(1);
    await twinsAdmit();
  });

  it("T9 the same repo, CD-registered ⇒ the run owes the gate: the hold stays (no_gate)", async () => {
    noGate();
    runOf("software-delivery");
    registry([{ repo: "Owner/Repo", pipeline: "hub-repo-deploy" }]);
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1 });
    expect(record()).toMatchObject({ briefPending: true });
    expect(record().replayDropped.error).toMatch(/this run owes one \(def software-delivery: CD-registered/);
    await twinsRefuse();
  });

  it("T9 runOwesMergeGate: owed only by the effective def; every read it cannot make is unknown", async () => {
    const owed = async () => (await output.runOwesMergeGate("db9sx9")).owed;
    expect((await output.runOwesMergeGate("")).owed).toBe("unknown");
    expect(await owed()).toBe("unknown"); // no row
    runOf("no-such-def");
    expect(await owed()).toBe("unknown");
    for (const id of ["legal", "marketing", "sales"]) { runOf(id); expect(await owed()).toBe(false); }
    runOf("operator");
    expect(await owed()).toBe(true); // afterPhase development: never stripped
    for (const id of ["software-delivery", "bug-fix", "dead-code-sweep"]) {
      runOf(id);
      fake.objects.delete("config/cd-registry.json");
      expect(await owed()).toBe(false);
      registry([]);
      expect(await owed()).toBe(false);
      registry(["https://github.com/OWNER/repo.git"]);
      expect(await owed()).toBe(true);
      registry([{ repo: "owner/repo" }]);
      expect(await owed()).toBe(true);
      registry([{ repo: "owner/other" }]);
      expect(await owed()).toBe(false);
    }
    runOf("software-delivery", { repos: [] });
    registry([{ repo: "owner/repo" }]);
    expect(await owed()).toBe(false); // no repo URL: the orchestrator's findCdEntry says HANDOFF too
    runOf("software-delivery");
    fake.objects.set("config/cd-registry.json", "{ truncated");
    expect(await owed()).toBe("unknown");
    fake.objects.set("config/cd-registry.json", JSON.stringify({ version: 1, repos: "owner/repo" }));
    expect(await owed()).toBe("unknown");
    registry([{ repo: "owner/repo" }]);
    s3Refuses("config/cd-registry.json", "SlowDown", 503);
    expect(await owed()).toBe("unknown");
    s3Refuses("config/workflows.json", "AccessDenied", 403);
    expect(await owed()).toBe("unknown");
    fake.getError = null;
    fake.objects.set("config/workflows.json", "not json");
    expect(await owed()).toBe("unknown");
    fake.objects.delete("config/workflows.json");
    expect(await owed()).toBe("unknown");
    fake.objects.set("config/workflows.json", JSON.stringify(workflowsConfig));
    h.workflowRowError = Object.assign(new Error("boom"), { name: "InternalServerError" });
    expect(await owed()).toBe("unknown");
  });

  // ─── TEAM-6097: the release on #927's step 6 / drop() / retry — same clear on every path ───
  // A release from a STANDING hold (the drain's off-gate stamp: briefPending:true, a
  // `part:"brief"` undelivered entry and a briefFallbackReason) must leave the record
  // exactly as a gate delivery would (TEAM-6024/6042/6052): hold false, entry pruned,
  // reason gone — the reason a release was made lives in briefDisposition.why.
  const expectReleased = (kind) => {
    const r = record();
    expect(r.briefPending).toBe(false);
    expect(r.briefDisposition).toMatchObject({ release: true, kind });
    expect((r.undelivered || []).some((u) => u?.part === "brief")).toBe(false);
    expect(r.briefFallbackReason).toBeUndefined();
  };
  const expectHeld = () => {
    expect(record().briefPending).toBe(true);
    expect(record().briefDisposition).toBeUndefined();
  };
  const RESIDUAL_6097 = { part: "residual_findings", ticketId: "TEAM-5603", reason: "Jira API 400: ticket is archived" };
  /** The drain's off-gate hold, from two unnamed open gates; returns the message body to redeliver. */
  const holdUnnamed = async ({ withResidual = false } = {}) => {
    const body = fake.queue[0].Body;
    gateUnidentifiable();
    await tick();
    expectHeld();
    expect(record()).toMatchObject({ briefFallbackReason: expect.any(String), undelivered: [expect.objectContaining({ part: "brief" })] });
    if (withResidual) {
      fake.objects.set(KEY, JSON.stringify({ ...record(), undelivered: [...record().undelivered, RESIDUAL_6097] }));
      fake.etags.set(KEY, `"e${++fake.etagSeq}"`);
    }
    return body;
  };
  const redeliver = async (body) => {
    fake.queue.push({ MessageId: "redelivered-6097", Body: body, group: "wf_db9sx9", inFlight: null, receives: 0 });
    return (await tick()).out.drained;
  };
  /** Both gates gone, and the run's def (legal) never gets one: absent_never_gated. */
  const neverGated = () => { fake.tickets.delete(GATE); fake.tickets.delete("TEAM-5604"); runOf("legal"); };
  const RELEASES = [["gate_settled", () => allGatesDone()], ["absent_never_gated", neverGated]];

  it.each(RELEASES)("TEAM-6097 drain step 6: a standing hold released (%s) ⇒ briefPending:false, no part:brief entry, no briefFallbackReason, Done", async (kind, arrange) => {
    const body = await holdUnnamed();
    arrange();
    expect(await redeliver(body)).toMatchObject({ applied: 1, dropped: 0 });
    expectReleased(kind);
    expect(record()).toMatchObject({ briefDelivered: "off_gate", ticketWrites: "applied", briefDisposition: { by: "drain" } });
    expect(record().undelivered).toBeUndefined();
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    await twinsAdmit();
  });

  it.each(RELEASES)("TEAM-6097 retry path: a standing hold released (%s) ⇒ briefPending:false, no part:brief entry, no briefFallbackReason, Done", async (kind, arrange) => {
    await holdUnnamed();
    arrange();
    const res = await rerun();
    expect(res.status).toBe("complete");
    expectReleased(kind);
    expect(record()).toMatchObject({ briefDelivered: "off_gate", briefDisposition: { by: "report_completion" } });
    expect(record().undelivered).toBeUndefined();
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    await twinsAdmit();
  });

  it("TEAM-6097 a release prunes ONLY the brief entry: other undelivered parts stay (drain and retry)", async () => {
    const body = await holdUnnamed({ withResidual: true });
    allGatesDone();
    expect(await redeliver(body)).toMatchObject({ applied: 1 });
    expectReleased("gate_settled");
    expect(record().undelivered).toEqual([RESIDUAL_6097]);
  });

  it("TEAM-6097 retry path release keeps other undelivered parts", async () => {
    await holdUnnamed({ withResidual: true });
    allGatesDone();
    expect((await rerun()).status).toBe("complete");
    expectReleased("gate_settled");
    expect(record().undelivered).toEqual([RESIDUAL_6097]);
  });

  it.each(RELEASES)("TEAM-6097 drop(): a follow-ups-only hold whose brief is released (%s) clears the brief hold like a gate delivery", async (kind, arrange) => {
    fake.failTool = { Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };
    const body = await holdUnnamed();
    expect(record()).toMatchObject({ followUpsPending: true, replayDropped: { step: "follow_ups+brief" } });
    arrange();
    expect(await redeliver(body)).toMatchObject({ applied: 0, dropped: 1 });
    expect(record()).toMatchObject({ followUpsPending: true, briefDelivered: "off_gate", ticketWrites: "dropped", replayDropped: { step: "follow_ups" } });
    expectReleased(kind);
    for (const twin of TWIN_GUARDS) {
      const v = (await twin()).judgeCompletionRecord(KEY, fake.objects.get(KEY));
      expect(v).toMatchObject({ proven: false });
      expect(v.why).not.toMatch(/has briefPending:true/);
    }
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
  });

  // Every hold disposition keeps the hold — on BOTH the drain and the retry path.
  const HOLDS = [
    ["gate_open", () => { fake.tickets.get(GATE).status = "Done"; fake.tickets.get("TEAM-5604").blockedBy = ["TEAM-5699"]; }, /1 open Merge Approval gates \(TEAM-5604\) and none is blocked by/],
    ["roster_incomplete", () => allGatesDone(), /roster is incomplete/, { truncate: true }],
    ["no_epic", () => { allGatesDone(); fake.tickets.get(BUILD).parentKey = null; }, /epic is unknown/, { dropEpic: true }],
    ["no_gate", () => { fake.tickets.delete(GATE); fake.tickets.delete("TEAM-5604"); runOf("operator"); }, /this run owes one \(def operator/],
    ["gate_owed_unknown (no run row)", () => { fake.tickets.delete(GATE); fake.tickets.delete("TEAM-5604"); }, /whether this run owes one could not be determined/],
    ["gate_owed_unknown (config/workflows.json refused)", () => { fake.tickets.delete(GATE); fake.tickets.delete("TEAM-5604"); runOf("software-delivery"); s3Refuses("config/workflows.json", "AccessDenied", 403); }, /whether this run owes one could not be determined/],
    ["gate_owed_unknown (cd-registry unreadable)", () => { fake.tickets.delete(GATE); fake.tickets.delete("TEAM-5604"); runOf("software-delivery"); s3Refuses("config/cd-registry.json", "ServiceUnavailable", 503); }, /whether this run owes one could not be determined/],
  ];

  it.each(HOLDS)("TEAM-6097 drain: %s keeps the hold", async (_kind, arrange, why, opts = {}) => {
    let body = await holdUnnamed();
    arrange();
    if (opts.dropEpic) body = JSON.stringify({ ...JSON.parse(body), epicKey: null });
    const spy = opts.truncate ? await truncateRoster() : null;
    try {
      expect(await redeliver(body)).toMatchObject({ applied: 0, dropped: 1 });
    } finally {
      spy?.mockRestore();
    }
    expectHeld();
    expect(record().replayDropped.error).toMatch(why);
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
    await twinsRefuse();
  });

  it.each(HOLDS)("TEAM-6097 retry path: %s keeps the hold (complete_pending_brief, no Done)", async (_kind, arrange, why, opts = {}) => {
    await holdUnnamed();
    arrange();
    const spy = opts.truncate ? await truncateRoster() : null;
    let res;
    try {
      fake.calls.length = 0;
      res = await rerun();
    } finally {
      spy?.mockRestore();
    }
    expect(res.status).not.toBe("complete");
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expectHeld();
    expect(record().briefHoldReason).toMatch(why);
    await twinsRefuse();
  });

  // A release is superseded by any later brief outcome: the record never claims a
  // release (briefDisposition) next to a gate delivery or an undelivered brief.
  it("TEAM-6097 a released record whose brief later lands on a gate ⇒ gate fields, briefDisposition gone", async () => {
    const body = await holdUnnamed();
    allGatesDone();
    await rerun();
    expectReleased("gate_settled");
    // A gate is reopened for the run and names the ticket: the next drain delivers to it.
    fake.tickets.get(GATE).status = "To Do";
    fake.tickets.get(GATE).blockedBy = [BUILD];
    expect(await redeliver(body)).toMatchObject({ applied: 1 });
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE] });
    expect(record().briefDisposition).toBeUndefined();
  });

  it("TEAM-6097 a released record whose brief object is later gone ⇒ undelivered, briefDisposition gone", async () => {
    const body = await holdUnnamed();
    allGatesDone();
    await rerun();
    expectReleased("gate_settled");
    fake.objects.delete(fixture.mergeBrief.s3Key);
    await redeliver(body);
    expect(record()).toMatchObject({ briefDelivered: "undelivered" });
    expect(record().briefDisposition).toBeUndefined();
  });

  // ─── TEAM-6124: review-fix of the release path ───
  const setRecord = (patch) => {
    fake.objects.set(KEY, JSON.stringify({ ...record(), ...patch }));
    fake.etags.set(KEY, `"e${++fake.etagSeq}"`);
  };
  /** list_tickets (eventually consistent: Jira search / DynamoDB GSI) still shows `ids` Done; get_issue reads the board. */
  const staleListDone = async (ids) => {
    const { LambdaClient } = await import("@aws-sdk/client-lambda");
    const real = LambdaClient.prototype.send;
    return vi.spyOn(LambdaClient.prototype, "send").mockImplementation(async function (c) {
      const out = await real.call(this, c);
      const raw = c?.input?.Payload;
      const call = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      if (call.tool_name !== "Tickets___list_tickets" || !out?.Payload) return out;
      const payload = JSON.parse(new TextDecoder().decode(out.Payload));
      const tickets = payload.tickets.map((t) => (ids.includes(t.ticketId) ? { ...t, status: "Done" } : t));
      return { ...out, Payload: new TextEncoder().encode(JSON.stringify({ ...payload, tickets })) };
    });
  };
  const withStaleList = async (ids, fn) => {
    const spy = await staleListDone(ids);
    try { return await fn(); } finally { spy.mockRestore(); }
  };
  const noRelease = () => {
    expect(record().briefDisposition).toBeUndefined();
    for (const id of [BUILD, "TEAM-5600", GATE]) expect(resolvedNotices(id)).toHaveLength(0);
  };

  it("TEAM-6124 F1 drain: list_tickets shows the gate Done but get_issue reads it open ⇒ the brief goes on the gate, no release", async () => {
    // Fixture: GATE is To Do and blocked by BUILD on the board.
    const t = await withStaleList([GATE], () => tick());
    expect(t.out.drained).toMatchObject({ applied: 1, dropped: 0 });
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE] });
    noRelease();
    expect(briefComments(GATE)).toHaveLength(1);
  });

  it("TEAM-6124 F1 retry: a stale all-Done roster ⇒ report_completion delivers to the gate get_issue reads open, no release", async () => {
    await holdUnnamed();
    fake.tickets.get(GATE).status = "Done"; // TEAM-5604 stays To Do (unlinked, the one open gate)
    const res = await withStaleList([GATE, "TEAM-5604"], () => rerun());
    expect(res.status).toBe("complete");
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate", briefTargets: ["TEAM-5604"] });
    noRelease();
  });

  it("TEAM-6124 F1 drain: a stale all-Done roster over two open unnamed gates ⇒ the hold stays (gate choice re-run on the fresh reads)", async () => {
    gateUnidentifiable();
    const t = await withStaleList([GATE, "TEAM-5604"], () => tick());
    expect(t.out.drained).toMatchObject({ dropped: 1 });
    expectHeld();
    expect(record().replayDropped.error).toMatch(/2 open Merge Approval gates/);
    noRelease();
    await twinsRefuse();
  });

  it("TEAM-6124 F1 a gate get_issue refuses permanently ⇒ not confirmed Done, the hold stays (gate_unconfirmed)", async () => {
    fake.tickets.get(GATE).status = "Done";
    fake.failTool = { Tickets___get_issue: (p) => (p.ticket_id === GATE ? "Jira API 404: Issue TEAM-5602 does not exist" : null) };
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1 });
    expectHeld();
    expect(record().replayDropped.error).toMatch(/TEAM-5602 could not be read to confirm it is Done/);
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
  });

  it("TEAM-6124 F1 a gate get_issue 503 while confirming ⇒ the drain retries, record untouched", async () => {
    fake.tickets.get(GATE).status = "Done";
    fake.failTool = { Tickets___get_issue: (p) => (p.ticket_id === GATE ? PROVIDER_503 : null) };
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 });
    expect(record().ticketWrites).toBe("queued");
    expect(record().briefDisposition).toBeUndefined();
  });

  /** Every place the release audit says the brief is, holds the brief. */
  const auditLocationsHoldTheBrief = () => {
    const audit = resolvedNotices(BUILD)[0];
    expect(audit).toBeDefined();
    expect(audit).not.toMatch(/re-run WorkflowOutput___report_completion so the brief goes on it/);
    expect(audit).toMatch(/does NOT re-deliver a released brief/);
    const m = /a human must post the brief on it - it is at s3:\/\/[^/\s]+\/(\S+?)(?:, and a copy is in a comment on (.+?))?\.$/.exec(audit);
    expect(m).not.toBeNull();
    const [, s3Key, on] = m;
    expect(s3Key).toBe(fixture.mergeBrief.s3Key);
    expect(fake.objects.get(s3Key)).toBe(fixture.mergeBrief.body);
    const named = on.split(" and ");
    expect(named).toEqual([BUILD, "TEAM-5600"]);
    const body = fixture.mergeBrief.body.trim();
    for (const id of named) {
      expect(briefComments(id)).toHaveLength(1);
      expect(briefComments(id)[0]).toContain(body);
    }
  };

  it("TEAM-6124 F2 retry (report_completion): the release audit names only places that hold the brief, and promises no re-delivery", async () => {
    await holdUnnamed();
    allGatesDone();
    expect((await rerun()).status).toBe("complete");
    expect(record().briefDisposition).toMatchObject({ release: true, by: "report_completion" });
    auditLocationsHoldTheBrief();
  });

  it("TEAM-6124 F2 drain: the same audit text on a drain release", async () => {
    fake.tickets.get(GATE).status = "Done";
    expect((await tick()).out.drained).toMatchObject({ applied: 1 });
    auditLocationsHoldTheBrief();
  });

  it("TEAM-6124 F2b a re-report after a release does not re-deliver to a reopened gate (as the audit says)", async () => {
    await holdUnnamed();
    allGatesDone();
    await rerun();
    const disposition = record().briefDisposition;
    fake.tickets.get(GATE).status = "To Do";
    fake.tickets.get(GATE).blockedBy = [BUILD];
    const descBefore = fake.tickets.get(GATE).description;
    expect((await rerun()).status).toBe("complete");
    expect(briefComments(GATE)).toHaveLength(0);
    expect(fake.tickets.get(GATE).description).toBe(descBefore);
    expect(record().briefDisposition).toEqual(disposition);
  });

  it("TEAM-6124 F3 a FIRST release (no hold ever stamped) is carried by the next report", async () => {
    fake.tickets.get(GATE).status = "Done";
    expect((await tick()).out.drained).toMatchObject({ applied: 1 });
    const disposition = record().briefDisposition;
    expect(disposition).toMatchObject({ release: true, kind: "gate_settled", by: "drain" });
    await rerun({ summary: `${call0.arguments.summary} (re-run)` });
    // The carry first: on the base the disposition is lost here (adoptHold skipped an unstated hold).
    expect(record().briefDisposition).toEqual(disposition);
    expect(record()).toMatchObject({ briefDelivered: "off_gate", briefPending: false });
  });

  it("TEAM-6124 B a FIRST gate delivery (no hold ever stamped) is carried by the next report", async () => {
    expect((await tick()).out.drained).toMatchObject({ applied: 1 });
    expect(record()).toMatchObject({ briefDelivered: "gate", briefTargets: [GATE] });
    await rerun({ summary: `${call0.arguments.summary} (re-run)` });
    // The carry first: on the base briefDelivered/briefTargets are lost here.
    expect(record()).toMatchObject({ briefDelivered: "gate", briefTargets: [GATE] });
    expect(record().briefPending).toBe(false);
  });

  const briefGone = () => fake.objects.delete(fixture.mergeBrief.s3Key);
  const briefEntry = expect.objectContaining({ part: "brief", s3Key: fixture.mergeBrief.s3Key, reason: expect.stringMatching(/does not exist/) });

  it("TEAM-6124 F4 step 6: a fresh undelivered entry is merged onto the record's, not over it", async () => {
    setRecord({ undelivered: [RESIDUAL_6097] });
    fake.tickets.get(BUILD).status = "Done"; // no hold: step 6 writes
    briefGone();
    expect((await tick()).out.drained).toMatchObject({ applied: 1 });
    expect(record().undelivered).toEqual([RESIDUAL_6097, briefEntry]);
  });

  it("TEAM-6124 F4 drop(): a fresh undelivered entry is merged onto the record's, not over it", async () => {
    setRecord({ undelivered: [RESIDUAL_6097] });
    briefGone(); // BUILD open: the undelivered brief is a hold, so drop() stamps
    expect((await tick()).out.drained).toMatchObject({ dropped: 1 });
    expectHeld();
    expect(record().undelivered).toEqual([RESIDUAL_6097, briefEntry]);
  });

  // Residual findings are re-posted by a redelivered message (msg.residual, marker-deduped):
  // the entry for a part this drain DID deliver comes off; one that failed again is replaced.
  const DEV = "TEAM-5599";
  const PRIOR_5599 = { part: "residual_findings", ticketId: DEV, reason: "Jira API 403: You do not have permission" };
  const withResidual = () => {
    seedTicket({ ticketId: DEV, title: "Dev: db9sx9 backend", status: "To Do", assignee: "agentcore_hub_backend_dev", parentKey: "TEAM-5600", blockedBy: [BUILD] });
    // TEAM-6142: a residual message names its done design amendment (the drain re-confirms it).
    seedTicket({ ticketId: "TEAM-5698", title: "Amend design: db9sx9", status: "Done", assignee: "agentcore_hub_backend_designer", parentKey: "TEAM-5600" });
    fake.queue[0].Body = JSON.stringify({ ...JSON.parse(fake.queue[0].Body), residual: { verdict: "APPROVED_WITH_FINDINGS", summary: "R1: rotate the probe role key", artifacts: "", amendmentTicketId: "TEAM-5698" } });
    setRecord({ undelivered: [RESIDUAL_6097, PRIOR_5599] });
  };

  it("TEAM-6124 F4 a residual entry the drain now delivers comes off the record", async () => {
    withResidual();
    expect((await tick()).out.drained).toMatchObject({ applied: 1 });
    expect(fake.tickets.get(DEV).comments.some((c) => c.includes("R1: rotate the probe role key"))).toBe(true);
    expect(record().undelivered).toEqual([RESIDUAL_6097]);
  });

  it("TEAM-6124 F4 a residual entry that 403s again is replaced, not duplicated", async () => {
    withResidual();
    fake.failTool = { Tickets___add_comment: (p) => (p.ticket_id === DEV ? "Jira API 403: still forbidden" : null) };
    expect((await tick()).out.drained).toMatchObject({ applied: 1 });
    expect(record().undelivered).toEqual([RESIDUAL_6097, { part: "residual_findings", ticketId: DEV, reason: "Jira API 403: still forbidden" }]);
  });

  // TEAM-6142: the drain re-confirms the security review's design amendment before its Done
  // (it had no amendment read at all). Reopened ⇒ no Done, and the record's finalized stamp is
  // marked provisional again (the DL-039 shape both twins refuse) with the drop.
  const AMEND = "TEAM-5698";
  it("TEAM-6142 (drain) the amendment is reopened while the residual findings are posted ⇒ no Done, a surfaced drop, the stamp PROVISIONAL again and refused by both twins", async () => {
    withResidual();
    setRecord({ securityReview: { verdict: "FAIL", amendmentTicketId: AMEND } });
    fake.beforeTool = (tool, params) => { if (tool === "Tickets___add_comment" && params.ticket_id === DEV) fake.tickets.get(AMEND).status = "To Do"; };
    expect((await tick()).out.drained).toMatchObject({ applied: 0, dropped: 1 });
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
    expect(fake.calls.some((c) => c.tool === "Tickets___transition_ticket" && c.params?.ticket_id === BUILD)).toBe(false);
    expect(record()).toMatchObject({ ticketWrites: "dropped", replayDropped: { step: "amendment" } });
    expect(record().replayDropped.error).toMatch(/design amendment TEAM-5698 reads To Do/);
    expect(record().securityReview).toEqual({ verdict: "FAIL", amendmentTicketId: AMEND, provisional: true });
    for (const twin of TWIN_GUARDS) {
      expect((await twin()).securityReviewRecordRefusal(KEY, record())).toMatch(/PROVISIONAL securityReview admission on amendment TEAM-5698/);
    }
  });

  it("TEAM-6142 (drain) the amendment is reopened and the provisional re-stamp loses its CAS ⇒ retried, no Done, no notice", async () => {
    withResidual();
    setRecord({ securityReview: { verdict: "FAIL", amendmentTicketId: AMEND } });
    fake.beforeTool = (tool, params) => { if (tool === "Tickets___add_comment" && params.ticket_id === DEV) fake.tickets.get(AMEND).status = "To Do"; };
    let n = 0;
    fake.putError = (input) => (input.Key === KEY && ++n > 1 ? awsError("PreconditionFailed", 412, "At least one of the pre-conditions you specified did not hold") : null);
    expect((await tick()).out.drained).toMatchObject({ applied: 0, dropped: 0 });
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
    expect(fake.calls.some((c) => c.tool === "Tickets___transition_ticket" && c.params?.ticket_id === BUILD)).toBe(false);
    expect(record().replayDropped).toBeUndefined();
    // TEAM-6151: the lost compensation changes nothing a reader trusts - the admission was
    // re-marked provisional BEFORE the amendment was re-confirmed, so both twins refuse.
    expect(record().securityReview.provisional).toBe(true);
  });

  it("TEAM-6142 (drain) a message queued before TEAM-6142 (no amendmentTicketId) re-confirms the record's stamped amendment", async () => {
    withResidual();
    const body = JSON.parse(fake.queue[0].Body);
    delete body.residual.amendmentTicketId;
    fake.queue[0].Body = JSON.stringify(body);
    setRecord({ securityReview: { verdict: "FAIL", amendmentTicketId: AMEND } });
    fake.tickets.get(AMEND).status = "In Progress";
    expect((await tick()).out.drained).toMatchObject({ applied: 0, dropped: 1 });
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
    expect(record().replayDropped.error).toMatch(/design amendment TEAM-5698 reads In Progress/);
  });

  it("TEAM-6142 (drain) no amendment id on the message or the record ⇒ fail closed: a surfaced drop, no Done", async () => {
    withResidual();
    const body = JSON.parse(fake.queue[0].Body);
    delete body.residual.amendmentTicketId;
    fake.queue[0].Body = JSON.stringify(body);
    expect((await tick()).out.drained).toMatchObject({ applied: 0, dropped: 1 });
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
    expect(record().replayDropped).toMatchObject({ step: "amendment", error: expect.stringMatching(/name no design amendment/) });
  });

  it("TEAM-6124 mergeUndelivered: same key replaces, other keys stay, delivered keys come off, empty ⇒ undefined", () => {
    const a = { part: "residual_findings", ticketId: "T-1", reason: "old" };
    const b = { part: "brief", s3Key: "k", reason: "gone" };
    const a2 = { ...a, reason: "new" };
    expect(output.mergeUndelivered([a, b], [a2])).toEqual([a2, b]);
    expect(output.mergeUndelivered([a], [b])).toEqual([a, b]);
    expect(output.mergeUndelivered([a, b], [], ["residual_findings|T-1"])).toEqual([b]);
    expect(output.mergeUndelivered([a], [], ["residual_findings|T-1"])).toBeUndefined();
    expect(output.mergeUndelivered(undefined, undefined)).toBeUndefined();
  });

  // ─── TEAM-6130: confirm-at-commit. TEAM-6124 confirmed the gates Done once (readTicketDone),
  // then posted the brief and the [brief-resolved] audits and committed the release later
  // without re-asking. A gate reopened in between ended released: briefPending:false,
  // gate_settled on the record, the gate To Do with no brief, the task Done. The release is
  // now re-confirmed immediately before the record write and again after it, before the Done.
  const flipGateOnFirstAudit = () => {
    let flipped = 0;
    fake.beforeTool = (tool, p) => {
      if (tool === "Tickets___add_comment" && p.comment.startsWith(`[brief-resolved:${BUILD}]`) && flipped === 0) { flipped = 1; fake.tickets.get(GATE).status = "To Do"; }
    };
    return () => flipped;
  };
  const flipGateOnRecordPut = () => {
    let flipped = 0;
    fake.putError = (input) => {
      if (input.Key === KEY && flipped === 0) { flipped = 1; fake.tickets.get(GATE).status = "To Do"; }
      return null;
    };
    return () => flipped;
  };

  it("TEAM-6130 drain (pre-write): the gate is reopened after the release was confirmed, before step 6 ⇒ no release recorded, retried; the next tick puts the brief on the gate", async () => {
    fake.tickets.get(GATE).status = "Done";
    const flipped = flipGateOnFirstAudit();
    const t1 = await tick();
    expect(flipped()).toBe(1);
    expect(t1.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 });
    expect(record().ticketWrites).toBe("queued");
    expect(record().briefDisposition).toBeUndefined();
    expect(record().briefPending).not.toBe(false);
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
    expect(briefComments(GATE)).toHaveLength(0);
    fake.beforeTool = null;
    expireVisibility();
    expect((await tick()).out.drained).toMatchObject({ applied: 1 });
    expect(record()).toMatchObject({ briefDelivered: "gate", briefTargets: [GATE], briefPending: false, ticketWrites: "applied" });
    expect(record().briefDisposition).toBeUndefined();
    expect(briefComments(GATE)).toHaveLength(1);
    expect(fake.tickets.get(BUILD).status).toBe("Done");
  });

  it("TEAM-6130 drain: the audit-time get_issue of the gate reads it open ⇒ no [brief-resolved] anywhere, the brief goes on the gate in the same tick", async () => {
    fake.tickets.get(GATE).status = "Done";
    let reads = 0;
    // Read 1 is the TEAM-6124 confirm; read 2 is postMarkedComment's own get_issue before the audit.
    fake.beforeTool = (tool, p) => { if (tool === "Tickets___get_issue" && p.ticket_id === GATE && ++reads === 2) fake.tickets.get(GATE).status = "To Do"; };
    const t = await tick();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(t.out.drained).toMatchObject({ applied: 1, dropped: 0, retried: 0 });
    for (const id of [BUILD, "TEAM-5600", GATE]) expect(resolvedNotices(id)).toHaveLength(0);
    expect(briefComments(GATE)).toHaveLength(1);
    expect(record()).toMatchObject({ briefDelivered: "gate", briefTargets: [GATE], briefPending: false });
    expect(record().briefDisposition).toBeUndefined();
    expect(fake.tickets.get(BUILD).status).toBe("Done");
  });

  it("TEAM-6130 retry (pre-write): the gate is reopened after the release was confirmed, before the record write ⇒ complete_pending_brief, hold kept, no Done; the next re-run puts the brief on it", async () => {
    await holdUnnamed();
    allGatesDone();
    const flipped = flipGateOnFirstAudit();
    fake.calls.length = 0;
    const res = await rerun();
    expect(flipped()).toBe(1);
    expect(res).toMatchObject({ status: "complete_pending_brief", next_action: "retry_report_completion" });
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expectHeld();
    expect(record().status).toBe("complete_pending_brief");
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    await twinsRefuse();
    fake.beforeTool = null;
    expect((await rerun()).status).toBe("complete");
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE] });
    expect(fake.tickets.get(BUILD).status).toBe("Done");
  });

  it("TEAM-6130 drain drop(): a follow-ups-only hold whose release is unconfirmed at commit does not stamp the release ⇒ retried, record untouched", async () => {
    fake.failTool = { Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };
    fake.tickets.get(GATE).status = "Done";
    const flipped = flipGateOnFirstAudit();
    const t = await tick();
    expect(flipped()).toBe(1);
    expect(t.out.drained).toMatchObject({ dropped: 0, retried: 1 });
    expect(record().ticketWrites).toBe("queued");
    expect(record().briefDisposition).toBeUndefined();
    expect(record().replayDropped).toBeUndefined();
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
  });

  it("TEAM-6130 drain (post-write): the gate is reopened after step 6 wrote the release, before the Done ⇒ re-held on the record, no Done, retried; the next tick puts the brief on the gate", async () => {
    fake.tickets.get(GATE).status = "Done";
    const flipped = flipGateOnRecordPut();
    const t1 = await tick();
    expect(flipped()).toBe(1);
    expect(t1.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 });
    expectHeld();
    expect(record().undelivered).toEqual([expect.objectContaining({ part: "brief", s3Key: fixture.mergeBrief.s3Key })]);
    expect(record().ticketWrites).toBe("queued");
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
    await twinsRefuse();
    fake.putError = null;
    expireVisibility();
    expect((await tick()).out.drained).toMatchObject({ applied: 1 });
    expect(record()).toMatchObject({ briefDelivered: "gate", briefTargets: [GATE], briefPending: false, ticketWrites: "applied" });
    expect(record().undelivered).toBeUndefined();
    expect(fake.tickets.get(BUILD).status).toBe("Done");
  });

  it("TEAM-6130 retry (post-write): the gate is reopened after the record wrote the release, before the Done ⇒ re-held, complete_pending_brief, no Done", async () => {
    await holdUnnamed();
    allGatesDone();
    const flipped = flipGateOnRecordPut();
    fake.calls.length = 0;
    const res = await rerun();
    expect(flipped()).toBe(1);
    expect(res).toMatchObject({ status: "complete_pending_brief", next_action: "retry_report_completion" });
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(record()).toMatchObject({ status: "complete_pending_brief", briefPending: true });
    expect(record().briefDisposition).toBeUndefined();
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    await twinsRefuse();
  });

  // ─── TEAM-6140 (DL-039): compensation must fail safe. TEAM-6130's post-write confirm took a
  // reopened gate's release back by REWRITING the record; a rewrite that lost every CAS attempt
  // (412) left briefPending:false + gate_settled on the record with the gate open, and the next
  // reader trusted it (the retry skipped the held block; the twins admitted a Done). The release
  // is now written PROVISIONALLY (briefPending:true, briefDisposition.provisional) and finalized
  // by a second write only after the confirm, so a lost compensation changes nothing a reader trusts.
  /** The first PUT of KEY lands (reopening the gate as it does, when asked); every later PUT of KEY is refused 412. */
  const loseCasAfterFirst = ({ flipGate = false } = {}) => {
    let n = 0;
    fake.putError = (input) => {
      if (input.Key !== KEY) return null;
      if (++n === 1) { if (flipGate) fake.tickets.get(GATE).status = "To Do"; return null; }
      return awsError("PreconditionFailed", 412, "At least one of the pre-conditions you specified did not hold");
    };
    return () => n;
  };
  const expectProvisional = () => {
    expect(record().briefPending).toBe(true);
    expect(record().briefDisposition).toMatchObject({ release: true, kind: "gate_settled", provisional: true });
  };
  const bodyOf = (p) => JSON.parse(typeof p.Body === "string" ? p.Body : Buffer.from(p.Body).toString("utf8"));
  const keyPuts = () => fake.puts.filter((p) => p.Key === KEY);

  it("TEAM-6140 R1 retry: the gate reopens at the release write and the hold cannot be put back (412 x3) ⇒ the record holds the release provisionally, both twins refuse; the identical retry re-reads the gate and puts the brief on it", async () => {
    await holdUnnamed();
    allGatesDone();
    const puts = loseCasAfterFirst({ flipGate: true });
    fake.calls.length = 0;
    const res = await rerun();
    expect(puts()).toBeGreaterThan(1);
    expect(res).toMatchObject({ status: "complete_pending_brief", next_action: "retry_report_completion" });
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expectProvisional();
    await twinsRefuse();
    fake.putError = null;
    fake.calls.length = 0;
    expect((await rerun()).status).toBe("complete");
    expect(tools("Tickets___get_issue").some((c) => c.params.ticket_id === GATE), "the retry re-read the gate").toBe(true);
    expect(briefComments(GATE)).toHaveLength(1);
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE] });
    expect(record().briefDisposition).toBeUndefined();
    expect(fake.tickets.get(BUILD).status).toBe("Done");
  });

  it("TEAM-6140 R2 retry: the finalize write loses every CAS attempt after the confirm ⇒ no Done, the record stays provisional and refused; the re-run finalizes", async () => {
    await holdUnnamed();
    allGatesDone();
    loseCasAfterFirst();
    fake.calls.length = 0;
    const res = await rerun();
    expect(res).toMatchObject({ status: "complete_pending_brief", next_action: "retry_report_completion" });
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expectProvisional();
    await twinsRefuse();
    fake.putError = null;
    expect((await rerun()).status).toBe("complete");
    expectReleased("gate_settled");
    expect(record().briefDisposition).toMatchObject({ by: "report_completion" });
    expect(record().briefDisposition.provisional).toBeUndefined();
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    await twinsAdmit();
  });

  it("TEAM-6140 R3 retry: the release is written provisional, confirmed, finalized, then Doned - never a Done on a provisional record", async () => {
    await holdUnnamed();
    allGatesDone();
    const before = keyPuts().length;
    let seenAtDone = null;
    fake.onTransition = () => { seenAtDone = record(); };
    expect((await rerun()).status).toBe("complete");
    const bodies = keyPuts().slice(before).map(bodyOf);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ briefPending: true, briefDisposition: { kind: "gate_settled", provisional: true }, status: "complete_pending_brief" });
    expect(bodies[1]).toMatchObject({ briefPending: false, briefDisposition: { kind: "gate_settled", by: "report_completion" }, status: "complete" });
    expect(bodies[1].briefDisposition.provisional).toBeUndefined();
    expect(seenAtDone).toMatchObject({ briefPending: false });
    expect(seenAtDone.briefDisposition.provisional).toBeUndefined();
    expectReleased("gate_settled");
    await twinsAdmit();
  });

  it("TEAM-6140 D1 drain: the gate reopens at step 6's release write and the hold cannot be re-stamped (412) ⇒ the record holds the release provisionally, both twins refuse, no Done; the next tick puts the brief on the gate", async () => {
    fake.tickets.get(GATE).status = "Done";
    const puts = loseCasAfterFirst({ flipGate: true });
    const t1 = await tick();
    expect(puts()).toBeGreaterThan(1);
    expect(t1.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 });
    expectProvisional();
    expect(record().ticketWrites).toBe("queued");
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
    await twinsRefuse();
    fake.putError = null;
    expireVisibility();
    expect((await tick()).out.drained).toMatchObject({ applied: 1 });
    expect(briefComments(GATE)).toHaveLength(1);
    expect(record()).toMatchObject({ briefDelivered: "gate", briefTargets: [GATE], briefPending: false, ticketWrites: "applied" });
    expect(record().briefDisposition).toBeUndefined();
    expect(fake.tickets.get(BUILD).status).toBe("Done");
  });

  it("TEAM-6140 D2 drain: the finalize write loses its CAS after the confirm ⇒ retried, no Done, the record stays provisional and refused; the next tick finalizes", async () => {
    fake.tickets.get(GATE).status = "Done";
    loseCasAfterFirst();
    const t1 = await tick();
    expect(t1.out.drained).toMatchObject({ applied: 0, dropped: 0, retried: 1 });
    expectProvisional();
    expect(fake.tickets.get(BUILD).status).not.toBe("Done");
    await twinsRefuse();
    fake.putError = null;
    expireVisibility();
    expect((await tick()).out.drained).toMatchObject({ applied: 1 });
    expectReleased("gate_settled");
    expect(record()).toMatchObject({ ticketWrites: "applied", briefDisposition: { by: "drain" } });
    expect(record().briefDisposition.provisional).toBeUndefined();
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    await twinsAdmit();
  });

  it("TEAM-6140 D3 drain: step 6 writes the release provisional, confirms, finalizes, then Dones - never a Done on a provisional record", async () => {
    fake.tickets.get(GATE).status = "Done";
    const before = keyPuts().length;
    let seenAtDone = null;
    fake.onTransition = () => { seenAtDone = record(); };
    expect((await tick()).out.drained).toMatchObject({ applied: 1 });
    const bodies = keyPuts().slice(before).map(bodyOf);
    expect(bodies).toHaveLength(3); // provisional, final, applied
    expect(bodies[0]).toMatchObject({ briefPending: true, briefDisposition: { kind: "gate_settled", provisional: true }, ticketWrites: "queued" });
    expect(bodies[1]).toMatchObject({ briefPending: false, briefDisposition: { kind: "gate_settled", by: "drain" }, ticketWrites: "queued" });
    expect(bodies[1].briefDisposition.provisional).toBeUndefined();
    expect(bodies[2]).toMatchObject({ ticketWrites: "applied" });
    expect(seenAtDone).toMatchObject({ briefPending: false });
    expect(seenAtDone.briefDisposition.provisional).toBeUndefined();
    await twinsAdmit();
  });
});
