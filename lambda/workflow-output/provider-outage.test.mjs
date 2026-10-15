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
// Both ticket twins' Done guard (DL-030), judged on the record report_completion left.
const TWIN_GUARDS = [await import("../agentcore-hub-jira/gate-contract.mjs"), await import("../agentcore-hub-tickets/gate-contract.mjs")];

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
    // Every record write lands but the ticketWrites:"queued" stamp after the send (TEAM-6224:
    // picked by its shape, not its ordinal - the brief key is now written before the send).
    fake.putError = (input) => (input.Key === recordKey && JSON.parse(input.Body).ticketWrites === "queued" ? awsError("InternalError", 500, "We encountered an internal error") : null);
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

/**
 * TEAM-6224 (R4-01, R4-02, R4-05): a record that owes the merge brief must keep owing it
 * through every partial write - a stamp that fails, a write that loses its CAS to a newer
 * record, a hold written when the brief cannot be read. The key is written down
 * (`undelivered[] {part:"brief", s3Key}`) and every reader asks one predicate,
 * briefObligation, which the twins' Done guard mirrors.
 */
describe("TEAM-6224 — the merge-brief obligation survives a partial write", () => {
  const KEY = `completions/${BUILD}.json`;
  const GATE = "TEAM-5602";
  const BRIEF = fixture.mergeBrief.s3Key;
  const noFollowUps = { ...call0.arguments, follow_ups: undefined };
  const briefPosts = (id) => fake.tickets.get(id).comments.filter((c) => /^\[brief:[0-9a-f]{12}\]/.test(c));
  const bodyOf = (input) => JSON.parse(input.Body);
  const briefEntry = (rec) => (Array.isArray(rec?.undelivered) ? rec.undelivered.find((u) => u?.part === "brief") : undefined);
  const s3Fail = () => awsError("InternalError", 500, "We encountered an internal error");
  /** Index of the first fake.calls entry matching, or -1. */
  const callAt = (tool, ticketId) => fake.calls.findIndex((c) => c.tool === tool && c.params.ticket_id === ticketId);
  /** Both twins refuse a Done on the stored record, as a PROVEN brief hold (isBriefHoldRefusal). */
  const twinsRefuse = (rec = record()) => {
    for (const twin of TWIN_GUARDS) {
      const v = twin.judgeBriefHold(KEY, JSON.stringify(rec));
      expect(v, "twin admitted a Done on a record that owes the merge brief").not.toBeNull();
      expect(mod.isBriefHoldRefusal(v.why)).toBe(true);
    }
  };
  const twinsAdmit = (rec = record()) => {
    for (const twin of TWIN_GUARDS) expect(twin.judgeBriefHold(KEY, JSON.stringify(rec))).toBeNull();
  };
  /** The provider back: the brief is on the gate BEFORE the build's Done, once. */
  const expectDeliveredThenDone = (res) => {
    expect(res.status).toBe("complete");
    expect(fake.tickets.get(BUILD).status).toBe("Done");
    expect(briefPosts(GATE), "the build went Done with the merge brief not on its gate").toHaveLength(1);
    expect(callAt("Tickets___add_comment", GATE)).toBeGreaterThanOrEqual(0);
    expect(callAt("Tickets___add_comment", GATE)).toBeLessThan(callAt("Tickets___transition_ticket", BUILD));
    expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate" });
    expect(briefEntry(record()), "a delivered brief keeps no undelivered entry").toBeUndefined();
  };

  describe("regressions", () => {
    it("R4-01: the post-send ticketWrites:'queued' stamp fails ⇒ the brief key is already on the record; the retry delivers it before the Done", async () => {
      fake.down = true;
      fake.putError = (input) => (input.Key === KEY && bodyOf(input).ticketWrites === "queued" ? s3Fail() : null);
      const first = result(await report());
      expect(first.next_action).toBe("retry_report_completion");
      expect(fake.queue).toHaveLength(1);
      expect(JSON.parse(fake.queue[0].Body).brief).toEqual({ s3Key: BRIEF });
      expect(record().ticketWrites, "the stamp did not land").toBeUndefined();
      expect(briefEntry(record()), "the obligation does not rest on the stamp").toMatchObject({ part: "brief", s3Key: BRIEF });
      twinsRefuse();

      fake.putError = null;
      fake.down = false;
      expectDeliveredThenDone(result(await report()));
    });

    it("R4-02: the write loses its CAS to a NEWER queued record that owes the brief ⇒ the hold is adopted (key + ticketWrites carried), no Done; the retry delivers", async () => {
      // An earlier benign record, so the report's write is IfMatch on the ETag it read.
      fake.objects.set(KEY, JSON.stringify({ ticket_id: BUILD, workflowId: "db9sx9", summary: "earlier", status: "complete_transition_failed", followUpsPending: false }));
      fake.etags.set(KEY, '"older"');
      let raced = 0;
      fake.beforePut = (input) => {
        if (input.Key !== KEY || raced++ > 0) return;
        // A newer report queued its writes, the brief among them: ticketWrites:"queued", no stamp.
        fake.objects.set(KEY, JSON.stringify({ ticket_id: BUILD, workflowId: "db9sx9", summary: "newer report", status: "complete_pending_follow_ups", followUpsPending: true, ticketWrites: "queued", evidence_keys: call0.arguments.evidence_keys }));
        fake.etags.set(KEY, '"newer"');
      };
      const older = { ...call0.arguments, evidence_keys: "workflows/db9sx9/shared/plan.md" };
      const res = result(await report(older));
      expect(raced).toBeGreaterThan(1);
      expect(fake.tickets.get(BUILD).status, "the older report Doned over the newer record's owed brief").toBe("In Progress");
      expect(res.status).toBe("complete_pending_brief");
      expect(res.next_action).toBe("retry_report_completion");
      expect(record()).toMatchObject({ briefPending: true, ticketWrites: "queued" });
      expect(briefEntry(record())).toMatchObject({ s3Key: BRIEF });
      twinsRefuse();

      fake.beforePut = null;
      expectDeliveredThenDone(result(await report(older)));
    });

    it("R4-05: a retry with no evidence_keys whose brief read fails ⇒ the hold persists the key (and ticketWrites); the next retry delivers", async () => {
      fake.down = true;
      expect(result(await report()).ticketWrites).toBe("queued");
      // The record as the pre-TEAM-6224 writer left it: queued, the brief named only by evidence_keys.
      const legacy = record();
      delete legacy.undelivered;
      fake.objects.set(KEY, JSON.stringify(legacy));
      fake.etags.set(KEY, '"legacy"');
      expect(mod.queuedBriefOwed(legacy)).toBe(BRIEF);
      fake.down = false;

      const noKeys = { ...call0.arguments };
      delete noKeys.evidence_keys;
      fake.getError = (input) => (input.Key === BRIEF ? awsError("SlowDown", 503, "Please reduce your request rate.") : null);
      const r1 = result(await report(noKeys));
      expect(r1.status).toBe("complete_pending_brief");
      expect(fake.tickets.get(BUILD).status).toBe("In Progress");
      expect(record()).toMatchObject({ briefPending: true, ticketWrites: "queued" });
      expect(briefEntry(record()), "the hold names the brief it is holding").toMatchObject({ part: "brief", s3Key: BRIEF });
      twinsRefuse();

      fake.getError = null;
      const r2 = result(await report(noKeys));
      expect(record().briefHoldReason).toBeUndefined();
      expectDeliveredThenDone(r2);
    });
  });

  describe("lifecycle of the undelivered part:'brief' entry", () => {
    it("WRITER: an outage report writes the brief key to the record BEFORE the send", async () => {
      fake.down = true;
      const sendsAtEntryPut = [];
      fake.beforePut = (input) => { if (input.Key === KEY && briefEntry(bodyOf(input))) sendsAtEntryPut.push(fake.sends.length); };
      expect(result(await report())).toMatchObject(fixture.expectedResponse);
      expect(sendsAtEntryPut[0]).toBe(0);
      expect(fake.sends).toHaveLength(1);
      expect(record()).toMatchObject({ ticketWrites: "queued" });
      expect(briefEntry(record())).toMatchObject({ part: "brief", s3Key: BRIEF });
      expect(mod.briefObligation(record())).toEqual({ key: BRIEF });
      twinsRefuse();
    });

    it("FIRST WRITE: the provider already refused this call ⇒ the brief key rides the call's FIRST record write; every later write failing cannot lose it", async () => {
      fake.down = true;
      let recordPuts = 0;
      const firstBodies = [];
      // S3 takes the call's first record write, then refuses every one after it.
      fake.putError = (input) => {
        if (input.Key !== KEY) return null;
        if (++recordPuts === 1) { firstBodies.push(bodyOf(input)); return null; }
        return s3Fail();
      };
      const res = result(await report());
      expect(res.next_action).toBe("retry_report_completion");
      expect(briefEntry(firstBodies[0]), "the obligation is in the FIRST write").toMatchObject({ part: "brief", s3Key: BRIEF });
      expect(briefEntry(record())).toMatchObject({ part: "brief", s3Key: BRIEF });
      expect(fake.tickets.get(BUILD).status).toBe("In Progress");
      twinsRefuse();

      // The healthy retry finds the obligation (briefObligation) and puts the brief on the gate, then Dones.
      fake.putError = null;
      fake.down = false;
      expectDeliveredThenDone(result(await report()));
    });

    it("FIRST WRITE: with the outage already seen, no separate pre-send write is made (one record PUT before the send)", async () => {
      fake.down = true;
      // Each record PUT, as the number of sends made before it.
      const sendsAtPut = [];
      fake.putError = (input) => { if (input.Key === KEY) sendsAtPut.push(fake.sends.length); return null; };
      expect(result(await report())).toMatchObject(fixture.expectedResponse);
      expect(fake.sends).toHaveLength(1);
      expect(sendsAtPut, "the first write, then the post-send ticketWrites:'queued' stamp - nothing else").toEqual([0, 1]);
      expect(briefEntry(record())).toMatchObject({ s3Key: BRIEF });
    });

    it("FIRST WRITE: the provider answers again by the Done ⇒ the twin refuses it on the recorded brief; the retry delivers, then Dones", async () => {
      // get_issue / list_tickets 503 (outage seen before the first write); the Done reaches a
      // healthy twin, which judges the record through its real Done guard (the fake does not).
      fake.failTool = {
        Tickets___get_issue: PROVIDER_503,
        Tickets___list_tickets: PROVIDER_503,
        Tickets___transition_ticket: () => TWIN_GUARDS[0].judgeBriefHold(KEY, fake.objects.get(KEY))?.why || null,
      };
      const res = result(await report(noFollowUps));
      expect(res.status).toBe("complete_pending_brief");
      expect(res.next_action).toBe("retry_report_completion");
      expect(fake.tickets.get(BUILD).status).toBe("In Progress");
      expect(record()).toMatchObject({ briefPending: true });
      expect(briefEntry(record())).toMatchObject({ s3Key: BRIEF });

      fake.failTool = null;
      fake.calls.length = 0; // the order check below is about the retry's own Done, not the refused one
      expectDeliveredThenDone(result(await report(noFollowUps)));
    });

    it("HEALTHY: a report naming the brief with the provider up posts NO brief and writes NO undelivered brief entry", async () => {
      const res = result(await report(noFollowUps));
      expect(res.status).toBe("complete");
      expect(fake.tickets.get(BUILD).status).toBe("Done");
      expect(briefPosts(GATE), "report_completion posts the brief only when the record owes it").toHaveLength(0);
      expect(fake.calls.filter((c) => c.tool === "Tickets___add_comment" && c.params.ticket_id === GATE)).toHaveLength(0);
      expect(fake.calls.filter((c) => c.tool === "Tickets___update_ticket" && c.params.ticket_id === GATE)).toHaveLength(0);
      expect(briefEntry(record())).toBeUndefined();
      expect(mod.briefObligation(record())).toBeNull();
      expect(fake.sends).toHaveLength(0);
    });

    it("ORDER: the outage starts at the Done and the pre-send write fails ⇒ nothing is sent, the answer is retry", async () => {
      // get_issue answered, so the first write could not know; the pre-send write is the first
      // write that carries the key, and when it fails nothing is queued the record does not state.
      fake.failTool = { Tickets___transition_ticket: PROVIDER_503 };
      fake.putError = (input) => (input.Key === KEY && briefEntry(bodyOf(input)) && bodyOf(input).ticketWrites === undefined ? s3Fail() : null);
      const res = result(await report(noFollowUps));
      expect(res.next_action).toBe("retry_report_completion");
      expect(res.ticketWrites).toBeUndefined();
      expect(fake.sends, "a message the record does not state").toHaveLength(0);
      expect(briefEntry(record())).toBeUndefined();
    });

    it("ORDER: the pre-send write lands, the send fails ⇒ the record owes the brief; the retry delivers", async () => {
      fake.down = true;
      fake.sendError = Object.assign(new Error("Access denied"), { name: "AccessDenied" });
      const res = result(await report());
      expect(res.next_action).toBe("retry_report_completion");
      expect(record().ticketWrites).toBeUndefined();
      expect(briefEntry(record())).toMatchObject({ s3Key: BRIEF });
      twinsRefuse();

      fake.sendError = null;
      fake.down = false;
      expectDeliveredThenDone(result(await report()));
    });

    it("ORDER: a drain delivers the brief while a report retries ⇒ the delivery is adopted, the entry is not resurrected", async () => {
      fake.down = true;
      await report();
      expect(briefEntry(record())).toBeDefined();
      // The drain's step-6 write lands under the retry's record write: brief on the gate.
      let raced = 0;
      fake.beforePut = (input) => {
        if (input.Key !== KEY || raced++ > 0) return;
        const delivered = mod.clearBriefHoldOnGate({ ...record(), briefDelivered: "gate", briefTargets: [GATE] });
        fake.objects.set(KEY, JSON.stringify(delivered));
        fake.etags.set(KEY, '"drained"');
      };
      await report();
      expect(raced).toBeGreaterThan(1);
      expect(record()).toMatchObject({ briefPending: false, briefDelivered: "gate" });
      expect(briefEntry(record())).toBeUndefined();
      expect(mod.briefObligation(record())).toBeNull();
      twinsAdmit();
    });

    it("ORDER: a twin's Done-intent is in flight ⇒ the pre-send write is deferred like any hold; nothing is sent", async () => {
      fake.objects.set(KEY, JSON.stringify({ ticket_id: BUILD, workflowId: "db9sx9", summary: "earlier", status: "complete_transition_failed", followUpsPending: false, doneIntent: { at: new Date().toISOString(), by: "test" } }));
      fake.etags.set(KEY, '"fenced"');
      fake.failTool = { Tickets___transition_ticket: PROVIDER_503 };
      const res = result(await report(noFollowUps));
      expect(res.next_action).toBe("retry_report_completion");
      expect(fake.sends).toHaveLength(0);
      expect(briefEntry(record())).toBeUndefined();
    });

    it("DELETE: a gate delivery and a release both take the entry off; the twins then admit", () => {
      const owed = { ticketWrites: "queued", evidence_keys: BRIEF, undelivered: [{ part: "brief", s3Key: BRIEF }, { part: "residual", ticketId: "TEAM-1" }] };
      const gate = mod.clearBriefHoldOnGate({ ...owed, briefDelivered: "gate", briefTargets: [GATE] });
      expect(gate.undelivered).toEqual([{ part: "residual", ticketId: "TEAM-1" }]);
      expect(mod.briefObligation(gate)).toBeNull();
      twinsAdmit(gate);
      const released = mod.clearBriefHoldOnRelease({ ...owed, briefDelivered: "off_gate" }, { release: true, kind: "gate_settled", why: "every gate Done" });
      expect(briefEntry(released)).toBeUndefined();
      expect(mod.briefObligation(released)).toBeNull();
      twinsAdmit(released);
    });
  });

  // READER parity: the twins' Done guard and briefObligation answer the same on every shape.
  const SHAPES = [
    ["stamped hold", { briefPending: true }, true],
    ["owed part:'brief' entry, no stamp", { undelivered: [{ part: "brief", s3Key: BRIEF }] }, true],
    ["queued, brief in evidence_keys (pre-TEAM-6224 record)", { ticketWrites: "queued", evidence_keys: `workflows/db9sx9/shared/plan.md, ${BRIEF}` }, true],
    ["queued, brief as an s3:// URI", { ticketWrites: "queued", evidence_keys: `s3://test-bucket/${BRIEF}` }, true],
    ["delivered on the gate", { briefPending: false, briefDelivered: "gate", ticketWrites: "queued", evidence_keys: BRIEF }, false],
    ["released", { briefPending: false, briefDisposition: { release: true }, ticketWrites: "queued", evidence_keys: BRIEF, undelivered: [{ part: "brief", s3Key: BRIEF }] }, false],
    ["drain recorded it undelivered (missing object)", { briefDelivered: "undelivered", ticketWrites: "queued", evidence_keys: BRIEF, undelivered: [{ part: "brief", s3Key: BRIEF }] }, false],
    ["healthy run that named the brief", { status: "complete", evidence_keys: BRIEF }, false],
    ["queued, no brief", { ticketWrites: "queued", evidence_keys: "workflows/db9sx9/shared/merge-brief-recovery-1.md" }, false],
  ];
  it.each(SHAPES)("READERS agree: %s", (_name, rec, owes) => {
    if (owes) twinsRefuse(rec);
    else twinsAdmit(rec);
    expect(!!mod.briefObligation(rec)).toBe(owes);
  });
});
