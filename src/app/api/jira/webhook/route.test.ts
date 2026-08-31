import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * R1 (docs/race-condition-study.md): the Jira webhook route must enqueue
 * commands on the FIFO queue when WORKFLOW_COMMAND_QUEUE_URL is set — with
 * MessageGroupId = workflow root and a redelivery-stable dedup id — and fall
 * back to the direct orchestrator invoke when it is not. Mock only the seams
 * (SQS + Lambda clients); the real POST handler runs.
 */
const h = vi.hoisted(() => {
  const sqsSends: Array<Record<string, unknown>> = [];
  const lambdaInvokes: Array<Record<string, unknown>> = [];
  return { sqsSends, lambdaInvokes };
});

vi.mock("@aws-sdk/client-sqs", () => {
  class SendMessageCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class SQSClient {
    async send(cmd: InstanceType<typeof SendMessageCommand>) {
      h.sqsSends.push(cmd.input);
      return {};
    }
  }
  return { SQSClient, SendMessageCommand };
});

vi.mock("@aws-sdk/client-lambda", () => {
  class InvokeCommand {
    constructor(public input: { Payload: string }) {}
  }
  class LambdaClient {
    async send(cmd: InstanceType<typeof InvokeCommand>) {
      h.lambdaInvokes.push(JSON.parse(cmd.input.Payload));
      return {};
    }
  }
  return { LambdaClient, InvokeCommand };
});

function webhookPayload(overrides: Record<string, unknown> = {}) {
  return {
    webhookEvent: "jira:issue_updated",
    timestamp: 1725000000000,
    issue: {
      key: "TEAM-102",
      fields: {
        summary: "dev ticket",
        status: { name: "Ready" },
        parent: { key: "TEAM-100" },
        labels: [],
      },
    },
    changelog: {
      items: [{ field: "status", fromString: "To Do", toString: "Ready" }],
    },
    ...overrides,
  };
}

async function post(body: unknown) {
  vi.resetModules();
  const { POST } = await import("./route");
  return POST(
    new NextRequest("http://localhost/api/jira/webhook", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
}

describe("POST /api/jira/webhook (queue mode)", () => {
  beforeEach(() => {
    h.sqsSends.length = 0;
    h.lambdaInvokes.length = 0;
    process.env.WORKFLOW_COMMAND_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/123/agentcore-hub-workflow-commands.fifo";
  });

  it("enqueues a status-change command grouped by the workflow root", async () => {
    const res = await post(webhookPayload());
    expect(res.status).toBe(200);
    expect(h.lambdaInvokes).toHaveLength(0);
    expect(h.sqsSends).toHaveLength(1);
    const msg = h.sqsSends[0];
    expect(msg.MessageGroupId).toBe("TEAM-100");
    expect(JSON.parse(msg.MessageBody as string)).toEqual({
      source: "jira-webhook",
      ticketId: "TEAM-102",
      newStatus: "ready",
      oldStatus: "todo",
    });
  });

  it("groups a parentless root issue under its own key", async () => {
    const payload = webhookPayload();
    delete (payload.issue.fields as Record<string, unknown>).parent;
    await post(payload);
    expect(h.sqsSends[0].MessageGroupId).toBe("TEAM-102");
  });

  it("produces the same dedup id for a redelivered webhook", async () => {
    await post(webhookPayload());
    await post(webhookPayload());
    expect(h.sqsSends[0].MessageDeduplicationId).toBe(h.sqsSends[1].MessageDeduplicationId);
  });

  it("enqueues issue_created as a todo command", async () => {
    await post(webhookPayload({ webhookEvent: "jira:issue_created", changelog: undefined }));
    expect(h.sqsSends).toHaveLength(1);
    const body = JSON.parse(h.sqsSends[0].MessageBody as string);
    expect(body.oldStatus).toBe("new");
  });

  it("ignores updates with no status change", async () => {
    await post(
      webhookPayload({
        changelog: { items: [{ field: "labels", fromString: "", toString: "x" }] },
      })
    );
    expect(h.sqsSends).toHaveLength(0);
  });
});

describe("POST /api/jira/webhook (legacy direct-invoke fallback)", () => {
  beforeEach(() => {
    h.sqsSends.length = 0;
    h.lambdaInvokes.length = 0;
    delete process.env.WORKFLOW_COMMAND_QUEUE_URL;
  });

  it("invokes the orchestrator Lambda directly when no queue is configured", async () => {
    const res = await post(webhookPayload());
    expect(res.status).toBe(200);
    expect(h.sqsSends).toHaveLength(0);
    expect(h.lambdaInvokes).toHaveLength(1);
    expect(h.lambdaInvokes[0]).toEqual({
      source: "jira-webhook",
      ticketId: "TEAM-102",
      newStatus: "ready",
      oldStatus: "todo",
    });
  });
});
