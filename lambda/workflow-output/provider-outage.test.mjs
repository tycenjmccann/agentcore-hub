import { describe, it, expect, beforeEach, vi } from "vitest";
import fixture from "./__fixtures__/db9sx9-provider-503.json";
import { fake, resetFake, seedTicket, PROVIDER_503 } from "./__fixtures__/ticket-fakes.mjs";

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
  it("only a Jira 5xx is the provider being down", () => {
    expect(mod.isProviderUnavailable(PROVIDER_503)).toBe(true);
    expect(mod.isProviderUnavailable("Jira API 500: boom")).toBe(true);
    expect(mod.isProviderUnavailable("Jira API 429: slow down")).toBe(false);
    expect(mod.isProviderUnavailable("Jira API 404: gone")).toBe(false);
    expect(mod.isProviderUnavailable("Unhandled: Jira API 503: wrapped")).toBe(false);
    expect(mod.isProviderUnavailable(null)).toBe(false);
  });

  it("finds the run's merge brief as a bare key or an s3:// URI", () => {
    expect(mod.mergeBriefKey("a.md, workflows/w1/shared/merge-brief.md")).toBe("workflows/w1/shared/merge-brief.md");
    expect(mod.mergeBriefKey("s3://bucket/workflows/w1/shared/merge-brief.md")).toBe("workflows/w1/shared/merge-brief.md");
    expect(mod.mergeBriefKey("workflows/w1/shared/merge-brief-recovery-1.md")).toBeNull();
    expect(mod.mergeBriefKey("")).toBeNull();
  });
});
