import { describe, it, expect, beforeEach, vi } from "vitest";
import fixture from "./__fixtures__/db9sx9-provider-503.json";
import { fake, resetFake, seedTicket, awsError, PROVIDER_503 } from "./__fixtures__/ticket-fakes.mjs";

/**
 * TEAM-5592 AC1 — report_completion through a ticket-provider outage.
 *
 * db9sx9 (2026-10-08): the completion record landed, then every Jira call 503'd
 * (SUSPENDED_INACTIVITY), and the operator retried the same report for hours. Now the
 * writes the provider could not take are queued for the probe and the agent is told
 * it is done. The REAL handler, with the jira twin, S3 and SQS faked at the module
 * seam (__fixtures__/ticket-fakes.mjs). The answer this replay produces is pinned in
 * the fixture's `expectedResponse`, which the harness-side test
 * (deploy/runtime-agent/tests/test_completion_gate.py) feeds to the completion gate.
 */

const FAKES = "./__fixtures__/ticket-fakes.mjs";
vi.mock("@aws-sdk/client-s3", async () => (await import(FAKES)).s3Module());
vi.mock("@aws-sdk/client-lambda", async () => (await import(FAKES)).lambdaModule());
vi.mock("@aws-sdk/client-sqs", async () => (await import(FAKES)).sqsModule());
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: async () => "https://signed" }));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", async () => {
  const { fake: f } = await import(FAKES);
  return {
    DynamoDBDocumentClient: { from: () => ({ send: async (c) => { if (c?.input?.Item) f.events.push(c.input.Item); return {}; } }) },
    PutCommand: class { constructor(input) { this.input = input; } },
    GetCommand: class { constructor(input) { this.input = input; } },
  };
});

process.env.ARTIFACT_BUCKET = "test-bucket";
process.env.TICKET_PROVIDER = "jira";
process.env.FOLLOW_UP_CLAIM_WAIT_MS = "1";
process.env.CLAIM_RETRY_WAIT_MS = "1";
const QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/agentcore-hub-ticket-replay.fifo";
process.env.TICKET_REPLAY_QUEUE_URL = QUEUE_URL;

let mod = await import("./index.mjs");

const BUILD = "TEAM-5601";
const call0 = fixture.calls[0];
/** Every recorded call, the retries expanded to the arguments they repeated. */
const recordedCalls = fixture.calls.map((c) => ("retryOf" in c ? { ...fixture.calls[c.retryOf], at: c.at } : c));
const result = (res) => JSON.parse(res.content[0].text);
const report = (args = call0.arguments) => mod.handler({ tool_name: call0.tool_name, arguments: args });
const record = () => JSON.parse(fake.objects.get(`completions/${BUILD}.json`));

function seedBoard() {
  resetFake();
  for (const t of fixture.tickets) seedTicket(t);
  fake.objects.set(fixture.mergeBrief.s3Key, fixture.mergeBrief.body);
}

beforeEach(seedBoard);

describe("TEAM-5592 AC1 — the db9sx9 replay: Jira 503 on every call", () => {
  beforeEach(() => { fake.down = true; });

  it("every recorded call answers complete/queued, the record stands, and ONE message is queued", async () => {
    for (const c of recordedCalls) {
      const res = result(await mod.handler({ tool_name: c.tool_name, arguments: c.arguments }));
      expect(res).toMatchObject(fixture.expectedResponse);
      expect(res.next_action).toBeUndefined();
      expect(res.message).toMatch(/do NOT retry/);
    }
    // The record is the truth: still pending, and it says the writes are queued.
    expect(record()).toMatchObject({ status: "complete_pending_follow_ups", followUpsPending: true, ticketWrites: "queued" });
    // One send per call; the FIFO dedup id collapses the retries into one message.
    expect(fake.sends).toHaveLength(recordedCalls.length);
    expect(new Set(fake.sends.map((s) => s.MessageDeduplicationId)).size).toBe(1);
    expect(fake.queue).toHaveLength(1);
    expect(fake.sends[0]).toMatchObject({ QueueUrl: QUEUE_URL, MessageGroupId: fixture.workflowId });
    // Nothing reached Jira: no Done, so no webhook, so no cascade.
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
    expect(fake.webhooks).toHaveLength(0);
    // ...and no journey event claiming the ticket's work ended.
    expect(fake.events.filter((e) => e.type === "workflow.report_completion")).toHaveLength(0);
  });

  it("the message carries every write the drain needs, the gate brief included", async () => {
    await report();
    const msg = JSON.parse(fake.queue[0].Body);
    expect(msg).toMatchObject({
      v: 1, workflowId: fixture.workflowId, ticketId: BUILD, agentId: "agentcore_hub_operator", transition: "done",
      brief: { s3Key: fixture.mergeBrief.s3Key }, residual: null, reportKey: `completions/${BUILD}.json`,
      journey: { branch: "feature/db9sx9", pr_url: call0.arguments.pr_url },
    });
    expect(msg.followUps).toHaveLength(1);
    expect(msg.followUps[0]).toMatchObject({ kind: "iam_handoff", assignee: "human:engineer" });
    expect(msg.followUps[0].hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("no merge-brief.md in evidence_keys ⇒ no brief in the message", async () => {
    await report({ ...call0.arguments, evidence_keys: "workflows/db9sx9/shared/plan.md" });
    expect(JSON.parse(fake.queue[0].Body).brief).toBeNull();
  });

  it("a SendMessage that fails answers today's retry, never a false done", async () => {
    fake.sendError = Object.assign(new Error("Access denied"), { name: "AccessDenied" });
    const res = result(await report());
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(res.next_action).toBe("retry_report_completion");
    expect(res.ticketWrites).toBeUndefined();
    expect(record().ticketWrites).toBeUndefined();
  });

  it("queued but the record cannot be stamped ⇒ today's retry, not queued; the retry makes the claim true", async () => {
    const recordKey = `completions/${BUILD}.json`;
    let recordPuts = 0;
    // The first record write lands; the ticketWrites:"queued" stamp after the send fails.
    fake.putError = (input) => (input.Key === recordKey && ++recordPuts === 2 ? awsError("InternalError", 500, "We encountered an internal error") : null);
    const res = result(await report());
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(res.next_action).toBe("retry_report_completion");
    expect(res.ticketWrites).toBeUndefined();
    expect(record().ticketWrites).toBeUndefined();
    expect(fake.queue).toHaveLength(1);

    // The agent retries, as told: the re-send collapses into the same message, and now
    // the record and the answer both say queued.
    fake.putError = null;
    const again = result(await report());
    expect(again).toMatchObject(fixture.expectedResponse);
    expect(record().ticketWrites).toBe("queued");
    expect(fake.queue).toHaveLength(1);
  });
});

describe("TEAM-5592 — which failures queue", () => {
  const noFollowUps = { ...call0.arguments, follow_ups: undefined };

  it("Done attempted and 503'd (the ticket WAS readable) ⇒ queued; the record says transition_failed", async () => {
    fake.failTool = { Tickets___transition_ticket: PROVIDER_503 };
    const res = result(await report(noFollowUps));
    expect(res).toMatchObject({ status: "complete", ticketWrites: "queued" });
    expect(record()).toMatchObject({ status: "complete_transition_failed", followUpsPending: false, ticketWrites: "queued" });
    expect(fake.queue).toHaveLength(1);
  });

  it("a 4xx is an answer, not an outage ⇒ today's retry, nothing queued", async () => {
    fake.failTool = { Tickets___transition_ticket: "Jira API 400: Transition is not valid" };
    const res = result(await report(noFollowUps));
    expect(res.status).toBe("complete_transition_failed");
    expect(res.next_action).toBe("retry_report_completion");
    expect(fake.sends).toHaveLength(0);
  });

  it("a held follow-up that is NOT the outage (a 503 elsewhere does not excuse it) ⇒ nothing queued", async () => {
    // get_issue answers, the scan answers, the create gets a wrapped error the twin
    // did not produce — retryable, and not provably the provider.
    fake.failTool = { Tickets___create_ticket: "Unhandled: socket hang up" };
    const res = result(await report());
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(fake.sends).toHaveLength(0);
  });

  it("the follow-up create 503s on a readable ticket ⇒ queued", async () => {
    fake.failTool = { Tickets___create_ticket: PROVIDER_503 };
    const res = result(await report());
    expect(res).toMatchObject({ status: "complete", ticketWrites: "queued" });
    expect(fake.tickets.get(BUILD).status).toBe("In Progress");
  });

  // Round 2 #2: the jira twin's two wrappers that carry jiraFetch's error inside them
  // (lambda/agentcore-hub-jira/index.mjs createTicket :1781, siblingScanRefusal :1113
  // for the gate-loop, design-amendment and autowire scans).
  const WRAPPED_503 = {
    parent_type_unreadable: `parent_type_unreadable: could not read parent TEAM-5600's issue type (${PROVIDER_503}); nothing was created. Retry the call.`,
    sibling_scan_refusal: `create_ticket refused: the sibling scan under TEAM-5600 failed (${PROVIDER_503}), so the open-gate freeze state is unknown and the ticket cannot be created safely. Nothing was created. Retry the call.`,
  };
  // Round 3 (a): the FIRST status decides, so a wrapped 4xx quoting a 503 is not the outage.
  it("a wrapped 4xx that quotes a 503 later in its text is NOT the outage", () => {
    expect(mod.isProviderUnavailable(`parent_type_unreadable: could not read parent TEAM-5600's issue type (Jira API 404: Issue does not exist; earlier Jira API 503: upstream); nothing was created. Retry the call.`)).toBe(false);
    expect(mod.isProviderUnavailable(`create_ticket refused: the sibling scan under TEAM-5600 failed (Jira API 403: forbidden, after Jira API 503: retry), so ...`)).toBe(false);
  });
  // Round 4 F1: the refusal classifiers read the SAME first status, but only off the
  // anchored prefix or one of the twin's two refusal wrappers (a crash's wrap stays unknown).
  it.each(Object.entries(WRAPPED_503))("%s wrapping a 4xx is a permanent, definite refusal; around a 503 it is not permanent", (_shape, error) => {
    const wrapped400 = error.replace(PROVIDER_503, "Jira API 400: invalid JQL");
    expect(mod.refusalJiraStatus(wrapped400)).toBe(400);
    expect(mod.isPermanentTicketRefusal(wrapped400)).toBe(true);
    expect(mod.followUpRetryable(wrapped400)).toBe(false);
    expect(mod.isDefiniteCreateRefusal({ ok: false, error: wrapped400 })).toBe(true);
    expect(mod.refusalJiraStatus(error)).toBe(503);
    expect(mod.isPermanentTicketRefusal(error)).toBe(false);
    expect(mod.followUpRetryable(error)).toBe(true);
  });
  it("refusalJiraStatus does not read a status out of a crash's wrap", () => {
    expect(mod.refusalJiraStatus("Jira API 404: gone")).toBe(404);
    expect(mod.refusalJiraStatus("Unhandled: Jira API 400: x")).toBeNull();
    expect(mod.refusalJiraStatus("Error: Jira API 400: x")).toBeNull();
    expect(mod.refusalJiraStatus("sibling_scan_failed")).toBeNull();
    expect(mod.refusalJiraStatus(undefined)).toBeNull();
    expect(mod.isPermanentTicketRefusal("Unhandled: Jira API 400: x")).toBe(false);
  });
  it.each(Object.entries(WRAPPED_503))("the create's %s wraps a 503 ⇒ the outage", (_shape, error) => {
    expect(mod.isProviderUnavailable(error)).toBe(true);
    expect(mod.isProviderUnavailable(error.replace(PROVIDER_503, "Jira API 400: bad"))).toBe(false);
  });
  it.each(Object.entries(WRAPPED_503))("the follow-up create fails with %s around a 503 ⇒ queued", async (_shape, error) => {
    fake.failTool = { Tickets___create_ticket: error };
    const res = result(await report());
    expect(res).toMatchObject({ status: "complete", ticketWrites: "queued" });
    expect(fake.sends).toHaveLength(1);
  });

  // F1: every failed write in the call has to be the outage, not just the retryable ones.
  const twoFollowUps = {
    ...call0.arguments,
    follow_ups: JSON.stringify([
      { kind: "iam_handoff", owner: "human", title: "Grant the probe role sqs:ReceiveMessage", detail: "console step" },
      { kind: "iam_handoff", owner: "human", title: "Grant the probe role cloudwatch:PutMetricData", detail: "console step" },
    ]),
  };

  it("one follow-up 400s and another 503s ⇒ not queued: today's answer", async () => {
    fake.failTool = { Tickets___create_ticket: (p) => (/sqs:/.test(p.summary) ? "Jira API 400: Field 'labels' is invalid" : PROVIDER_503) };
    const res = result(await report(twoFollowUps));
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(res.next_action).toBe("retry_report_completion");
    expect(res.ticketWrites).toBeUndefined();
    expect(fake.sends).toHaveLength(0);
    expect(res.followUpsMaterialized.failed.map((f) => f.retryable).sort()).toEqual([false, true]);
  });

  // TEAM-5593: a follow-up no retry can file withholds Done, so the Done (503 or not)
  // is never attempted; the 400 row alone decides, and it is not the outage.
  it("a follow-up 400s and the Done would 503 ⇒ Done withheld, not queued: today's answer", async () => {
    fake.failTool = { Tickets___create_ticket: "Jira API 400: Field 'labels' is invalid", Tickets___transition_ticket: PROVIDER_503 };
    const res = result(await report());
    expect(res.status).toBe("complete_pending_follow_ups");
    expect(fake.calls.filter((c) => c.tool === "Tickets___transition_ticket")).toHaveLength(0);
    expect(res.next_action).toBe("retry_report_completion");
    expect(fake.sends).toHaveLength(0);
  });

  // F3(a): the Lambda path to Jira failing transiently is the outage too.
  it.each([
    ["the Lambda service throttling", () => awsError("TooManyRequestsException", 429, "Rate exceeded")],
    ["the Lambda service answering 5xx", () => awsError("ServiceException", 500, "An internal error occurred")],
    ["an unnamed Lambda 5xx", () => awsError("UnknownError", 502, "Bad Gateway")],
    ["the SDK's client timeout", () => Object.assign(new Error("Connection timed out after 120000 ms"), { name: "TimeoutError" })],
    ["the jira twin timing out (Jira hung)", () => ({ FunctionError: "Unhandled", Payload: { errorType: "Sandbox.Timedout", errorMessage: "Task timed out after 60.00 seconds" } })],
  ])("the Done fails on %s ⇒ queued", async (_name, failure) => {
    fake.lambdaFail = { Tickets___transition_ticket: failure() };
    const res = result(await report(noFollowUps));
    expect(res).toMatchObject({ status: "complete", ticketWrites: "queued" });
    expect(record()).toMatchObject({ status: "complete_transition_failed", ticketWrites: "queued" });
    expect(fake.queue).toHaveLength(1);
  });

  it.each([
    ["the jira twin crashing (no timeout)", { FunctionError: "Unhandled", Payload: { errorType: "Runtime.ExitError" } }],
    ["a Lambda 4xx", awsError("ResourceNotFoundException", 404, "Function not found")],
  ])("the Done fails on %s ⇒ not queued", async (_name, failure) => {
    fake.lambdaFail = { Tickets___transition_ticket: failure };
    const res = result(await report(noFollowUps));
    expect(res.status).toBe("complete_transition_failed");
    expect(fake.sends).toHaveLength(0);
  });

  it("a synthetic ticket id is never queued", async () => {
    fake.down = true;
    await report({ ...call0.arguments, ticket_id: "HEALTHCHECK-1" });
    expect(fake.sends).toHaveLength(0);
  });

  it("a healthy provider is byte-unchanged: complete, Done, no ticketWrites", async () => {
    const res = result(await report(noFollowUps));
    expect(res).toEqual({ status: "complete", message: `Completion saved for ${BUILD}. Ticket transitioned to Done.` });
    expect(record().ticketWrites).toBeUndefined();
    expect(fake.sends).toHaveLength(0);
  });

  it("no TICKET_REPLAY_QUEUE_URL ⇒ a 503 answers today's retry", async () => {
    delete process.env.TICKET_REPLAY_QUEUE_URL;
    vi.resetModules();
    mod = await import("./index.mjs");
    try {
      seedBoard();
      fake.down = true;
      const res = result(await report());
      expect(res.status).toBe("complete_pending_follow_ups");
      expect(res.next_action).toBe("retry_report_completion");
      expect(fake.sends).toHaveLength(0);
    } finally {
      process.env.TICKET_REPLAY_QUEUE_URL = QUEUE_URL;
      vi.resetModules();
      mod = await import("./index.mjs");
    }
  });
});

describe("isProviderUnavailable / mergeBriefKey", () => {
  it("the fixture's 503 is the captured SUSPENDED_INACTIVITY text in jiraFetch's shape", () => {
    expect(fixture.providerError).toBe(PROVIDER_503);
    expect(PROVIDER_503).toBe('Jira API 503: {"message":"Your Jira Cloud subscription has been deactivated due to inactivity","errorCode":"SUSPENDED_INACTIVITY"}');
  });

  it("a Jira 5xx, or the Lambda path to it failing transiently, is the provider being down", () => {
    expect(mod.isProviderUnavailable(PROVIDER_503)).toBe(true);
    expect(mod.isProviderUnavailable("TooManyRequestsException: Rate exceeded")).toBe(true);
    expect(mod.isProviderUnavailable("ServiceException (HTTP 500): internal")).toBe(true);
    expect(mod.isProviderUnavailable("Unhandled: Task timed out after 60.00 seconds")).toBe(true);
    expect(mod.isProviderUnavailable("Unhandled: unhandled error")).toBe(false);
    expect(mod.isProviderUnavailable("ResourceNotFoundException: Function not found")).toBe(false);
    expect(mod.isProviderUnavailable("Error: TooManyRequestsException: Rate exceeded")).toBe(false);
    expect(mod.isProviderUnavailable("Jira API 500: boom")).toBe(true);
    expect(mod.isProviderUnavailable("Jira API 429: slow down")).toBe(false);
    expect(mod.isProviderUnavailable("Jira API 404: gone")).toBe(false);
    // A 5xx wrapped anywhere inside is the outage; a message that LEADS with a 4xx is an answer.
    expect(mod.isProviderUnavailable("Unhandled: Jira API 503: wrapped")).toBe(true);
    expect(mod.isProviderUnavailable("Jira API 400: bad field (was Jira API 503: earlier)")).toBe(false);
    expect(mod.isProviderUnavailable("XJira API 503: not the prefix")).toBe(false);
    expect(mod.isProviderUnavailable(null)).toBe(false);
  });

  it("finds the run's merge brief as a bare key or an s3:// URI", () => {
    expect(mod.mergeBriefKey("a.md, workflows/w1/shared/merge-brief.md")).toBe("workflows/w1/shared/merge-brief.md");
    expect(mod.mergeBriefKey("s3://bucket/workflows/w1/shared/merge-brief.md")).toBe("workflows/w1/shared/merge-brief.md");
    expect(mod.mergeBriefKey("workflows/w1/shared/merge-brief-recovery-1.md")).toBeNull();
    expect(mod.mergeBriefKey("")).toBeNull();
  });
});
