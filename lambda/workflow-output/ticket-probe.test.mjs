import { describe, it, expect, beforeEach, vi } from "vitest";
import fixture from "./__fixtures__/db9sx9-provider-503.json";
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
// Both ticket twins' DL-030 Done guard, judged on the record the drain left.
const TWIN_GUARDS = [() => import("../agentcore-hub-jira/gate-contract.mjs"), () => import("../agentcore-hub-tickets/gate-contract.mjs")];
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
    ["no open gate", () => { fake.tickets.get(GATE).status = "Done"; }, "off_gate", /no open Merge Approval gate/],
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
    fake.tickets.get(GATE).status = "Done";
    fake.failTool = { Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };
    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1 });
    expect(record()).toMatchObject({ followUpsPending: true, status: "complete_pending_follow_ups", briefPending: true, replayDropped: { step: "follow_ups+brief" } });
    for (const twin of TWIN_GUARDS) {
      expect((await twin()).judgeCompletionRecord(`completions/${BUILD}.json`, fake.objects.get(`completions/${BUILD}.json`))).toMatchObject({ proven: false });
    }
  });

  it("a re-run report_completion after a brief hold keeps briefPending on the record", async () => {
    fake.tickets.get(GATE).status = "Done";
    await tick();
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate" });
    await output.handler({ tool_name: call0.tool_name, arguments: call0.arguments });
    expect(record()).toMatchObject({ briefPending: true, briefDelivered: "off_gate", replayDropped: { step: "brief" } });
  });

  // TEAM-5805: the re-run is the clearing path. It re-delivers the brief through the
  // drain's own postQueuedBrief; only a brief on the gate lets the Done through.
  it("re-run with the gate still not identifiable ⇒ complete_pending_brief, no Done attempted, no throw", async () => {
    fake.tickets.get(GATE).status = "Done";
    await tick();
    fake.calls.length = 0;
    const res = result(await output.handler({ tool_name: call0.tool_name, arguments: call0.arguments }));
    expect(res).toMatchObject({ status: "complete_pending_brief", next_action: "retry_report_completion" });
    expect(res.message).toContain("merge brief is not on the Merge Approval gate");
    expect(res.message).toContain("no open Merge Approval gate");
    expect(tools("Tickets___transition_ticket")).toHaveLength(0);
    expect(fake.queue).toHaveLength(0);
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(record()).toMatchObject({ status: "complete_pending_brief", followUpsPending: false, briefPending: true, briefHoldReason: expect.stringMatching(/^off_gate: no open Merge Approval gate/) });
    // The off-gate fallback comments are marker-deduped: the re-run posted none again.
    for (const id of [BUILD, "TEAM-5600"]) expect(briefComments(id)).toHaveLength(1);
  });

  it("re-run once the gate is open again ⇒ brief on the gate, briefPending:false, ticket Done", async () => {
    fake.tickets.get(GATE).status = "Done";
    await tick();
    fake.tickets.get(GATE).status = "To Do";
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
    fake.tickets.get(GATE).status = "Done";
    await tick();
    fake.tickets.get(GATE).status = "To Do";
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
    fake.tickets.get(GATE).status = "Done";
    await tick();
    expect(record()).toMatchObject({ briefPending: true });
    fake.tickets.get(GATE).status = "To Do";
    fake.queue.push({ MessageId: "redelivered", Body: body, group: "wf_db9sx9", inFlight: null, receives: 0 });
    const t = await tick();
    expect(t.out.drained).toMatchObject({ applied: 1, dropped: 0 });
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE], ticketWrites: "applied" });
    expect(fake.tickets.get(BUILD).status).toBe("Done");
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
    expect(record().briefPending).toBeUndefined();
    expect(droppedMetrics()).toHaveLength(0);
  });

  it("a fallback brief is not posted twice when the message comes back (marker dedup)", async () => {
    fake.tickets.get(GATE).status = "Done";
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
  const HOLD = { briefPending: true, briefDelivered: "off_gate", briefHoldReason: "off_gate: no open Merge Approval gate under TEAM-5600" };
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
    fake.tickets.get(GATE).status = "Done";
    await tick();
    expect(record()).toMatchObject({ briefPending: true });
    // The re-run still sees no open gate (hold stands for it) — but before its write
    // lands, a drain put the brief on the reopened gate and cleared the hold.
    onFirstRecordPut(() => stamp({ briefPending: false, briefDelivered: "gate", briefTargets: [GATE] }));
    const res = await rerun();
    expect(res.status).toBe("complete");
    expect(record()).toMatchObject({ status: "complete", briefPending: false, briefDelivered: "gate", briefTargets: [GATE] });
    expect(fake.tickets.get(BUILD).status).toBe("Done");
  });

  it("4. the drain's step-6 write is conditional: a record that moved since step 0 is a retry, not an overwrite", async () => {
    const body = fake.queue[0].Body;
    fake.tickets.get(GATE).status = "Done";
    await tick();
    expect(record()).toMatchObject({ briefPending: true });
    fake.tickets.get(GATE).status = "To Do";
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
    fake.tickets.get(GATE).status = "Done";
    await tick();
    expect(record()).toMatchObject({ briefPending: true });
    fake.tickets.get(GATE).status = "To Do";
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

  it("TEAM-5866 (2): a hold stamp the record write cannot take (409s exhausted) keeps the message - retried, stamped next tick, never a deleted message with no hold", async () => {
    const droppedMetrics = () => fake.metrics.flatMap((m) => m.MetricData || []).filter((d) => d.MetricName === "TicketReplayDropped");
    const dropNotices = () => fake.tickets.get(BUILD).comments.filter((c) => c.startsWith(`[replay-dropped:${BUILD}:brief]`));
    // No open gate ⇒ the brief is off_gate and the drain holds the Done (as :290) — but
    // every PUT of the record 409s until conditionalPut gives up (CLAIM_CONFLICT_ATTEMPTS).
    fake.tickets.get(GATE).status = "Done";
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
    fake.tickets.get(GATE).status = "Done"; // no open gate ⇒ the brief goes off_gate ⇒ a hold
  });

  it("(d1) the ticket reaches Done right after the hold stamp ⇒ retry, then the next tick converges the record and says so", async () => {
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
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "off_gate", ticketWrites: "applied", status: "complete" });
    expect(record().undelivered[0]).toMatchObject({ part: "brief", reason: expect.stringMatching(/^not on the gate: /) });
    for (const twin of TWIN_GUARDS) expect((await twin()).judgeBriefHold(KEY, fake.objects.get(KEY))).toBeNull();
    for (const id of [BUILD, EPIC]) {
      expect(released(id)).toHaveLength(1);
      expect(released(id)[0]).toMatch(/earlier "LEFT OPEN" replay notice is superseded/);
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
    expect(record()).toMatchObject({ briefPending: false, ticketWrites: "applied" });

    const comments = [BUILD, EPIC].map((id) => fake.tickets.get(id).comments.length);
    fake.queue.push({ MessageId: "dup", Body: body, group: fake.queue[0]?.group || "g", inFlight: null, receives: 0 });
    await tick();
    expect([BUILD, EPIC].map((id) => fake.tickets.get(id).comments.length)).toEqual(comments);
    for (const id of [BUILD, EPIC]) expect(released(id)).toHaveLength(1);
    expect(record()).toMatchObject({ briefPending: false, ticketWrites: "applied" });
  });

  it("(d4) a follow-ups-only hold over a stale briefPending on a Done ticket ⇒ the stamp releases the brief hold", async () => {
    // The (d1) state one step on: a hold stamped, the ticket Done, and now a follow-up
    // no retry can file. `{...record, ...extra}` used to carry briefPending:true forward.
    fake.objects.set(KEY, JSON.stringify({ ...record(), briefPending: true, briefDelivered: "off_gate" }));
    fake.etags.set(KEY, `"e${++fake.etagSeq}"`);
    fake.tickets.get(BUILD).status = "Done";
    fake.failTool = { Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid" };

    const t = await tick();
    expect(t.out.drained).toMatchObject({ dropped: 1 });
    expect(record()).toMatchObject({ followUpsPending: true, briefPending: false, briefDelivered: "off_gate", replayDropped: { step: "follow_ups" } });
    for (const id of [BUILD, EPIC]) expect(released(id)).toHaveLength(1);
  });

  it("(d5) neither twin's post-commit warning reads as a brief-hold refusal", async () => {
    for (const twin of TWIN_GUARDS) {
      const g = await twin();
      expect(output.isBriefHoldRefusal(g.DONE_OVER_BRIEF_HOLD_WARNING)).toBe(false);
      expect(output.isBriefHoldRefusal(g.postCommitUncheckedWarning("could not read completions/X.json (InternalError 500)"))).toBe(false);
    }
  });
});
