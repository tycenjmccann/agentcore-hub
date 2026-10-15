import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";

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

async function post(body: unknown, headers?: Record<string, string>) {
  vi.resetModules();
  const { POST } = await import("./route");
  return POST(
    new NextRequest("http://localhost/api/jira/webhook", {
      method: "POST",
      body: JSON.stringify(body),
      headers,
    })
  );
}

/** Signs the exact JSON.stringify(body) string, same as a real Jira delivery would. */
function sign(body: unknown, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(JSON.stringify(body), "utf8").digest("hex");
}

describe("POST /api/jira/webhook (queue mode)", () => {
  beforeEach(() => {
    h.sqsSends.length = 0;
    h.lambdaInvokes.length = 0;
    process.env.WORKFLOW_COMMAND_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/123/agentcore-hub-workflow-commands.fifo";
    delete process.env.JIRA_WEBHOOK_SECRET;
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

  // TEAM-5731 (R4-1): the orchestrator binds a Jira self-park's claim release to the
  // changelog entry this webhook announces, so the command carries Jira's changelog id
  // when the payload has one — and nothing extra when it does not (every existing
  // command shape above is unchanged).
  it("forwards the webhook's changelog id on the command when Jira sent one", async () => {
    await post(webhookPayload({ changelog: { id: "9001", items: [{ field: "status", fromString: "In Progress", toString: "Blocked" }] } }));
    expect(h.sqsSends).toHaveLength(1);
    expect(JSON.parse(h.sqsSends[0].MessageBody as string)).toEqual({
      source: "jira-webhook",
      ticketId: "TEAM-102",
      newStatus: "blocked",
      oldStatus: "in_progress",
      changelogId: "9001",
    });
  });
});

describe("POST /api/jira/webhook (legacy direct-invoke fallback)", () => {
  beforeEach(() => {
    h.sqsSends.length = 0;
    h.lambdaInvokes.length = 0;
    delete process.env.WORKFLOW_COMMAND_QUEUE_URL;
    delete process.env.JIRA_WEBHOOK_SECRET;
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

/**
 * TEAM-6324: the route accepted ANY caller (no signature check at all) — this
 * section pins the fix. Jira signs with `X-Hub-Signature: sha256=<hex
 * HMAC-SHA256(secret, raw body)>` (Atlassian docs); verifyHubSignature runs
 * BEFORE JSON.parse and before any dispatch.
 */
describe("POST /api/jira/webhook (signature)", () => {
  beforeEach(() => {
    h.sqsSends.length = 0;
    h.lambdaInvokes.length = 0;
    process.env.WORKFLOW_COMMAND_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/123/agentcore-hub-workflow-commands.fifo";
    process.env.JIRA_WEBHOOK_SECRET = "test-secret";
  });

  afterEach(() => {
    delete process.env.JIRA_WEBHOOK_SECRET;
  });

  it("accepts a validly signed request and dispatches exactly once", async () => {
    const body = webhookPayload();
    const res = await post(body, { "x-hub-signature": sign(body, "test-secret") });
    expect(res.status).toBe(200);
    expect(h.sqsSends).toHaveLength(1);
    expect(h.lambdaInvokes).toHaveLength(0);
  });

  it("rejects a wrong signature with 401 and dispatches nothing", async () => {
    const body = webhookPayload();
    const res = await post(body, { "x-hub-signature": sign(body, "wrong-secret") });
    expect(res.status).toBe(401);
    expect(h.sqsSends).toHaveLength(0);
    expect(h.lambdaInvokes).toHaveLength(0);
  });

  it("rejects a missing signature header with 401 and dispatches nothing", async () => {
    const res = await post(webhookPayload());
    expect(res.status).toBe(401);
    expect(h.sqsSends).toHaveLength(0);
    expect(h.lambdaInvokes).toHaveLength(0);
  });

  it("rejects a non-sha256 algorithm with 401 and dispatches nothing", async () => {
    const body = webhookPayload();
    const sha1 = "sha1=" + createHmac("sha1", "test-secret").update(JSON.stringify(body), "utf8").digest("hex");
    const res = await post(body, { "x-hub-signature": sha1 });
    expect(res.status).toBe(401);
    expect(h.sqsSends).toHaveLength(0);
  });

  it("rejects a tampered body even with a signature for the original body", async () => {
    const body = webhookPayload();
    const sig = sign(body, "test-secret");
    const tampered = webhookPayload({ issue: { ...body.issue, key: "TEAM-999" } });
    const res = await post(tampered, { "x-hub-signature": sig });
    expect(res.status).toBe(401);
    expect(h.sqsSends).toHaveLength(0);
  });

  it("still returns 400 on invalid JSON when the signature is valid", async () => {
    vi.resetModules();
    const { POST } = await import("./route");
    const raw = "{not json";
    const res = await POST(
      new NextRequest("http://localhost/api/jira/webhook", {
        method: "POST",
        body: raw,
        headers: { "x-hub-signature": "sha256=" + createHmac("sha256", "test-secret").update(raw, "utf8").digest("hex") },
      })
    );
    expect(res.status).toBe(400);
    expect(h.sqsSends).toHaveLength(0);
  });

  // TEAM-6333: route.ts used to .trim() the configured secret before using it
  // as the HMAC key, but setup-jira-webhook.sh sends Jira the untrimmed value
  // — a padded secret could never verify. The key must be the exact
  // configured value; only the opt-in check (secret vs. no secret) trims.
  it("uses the exact configured secret (untrimmed) as the HMAC key", async () => {
    process.env.JIRA_WEBHOOK_SECRET = " s3cret ";
    const body = webhookPayload();

    const ok = await post(body, { "x-hub-signature": sign(body, " s3cret ") });
    expect(ok.status).toBe(200);
    expect(h.sqsSends).toHaveLength(1);

    const bad = await post(body, { "x-hub-signature": sign(body, "s3cret") });
    expect(bad.status).toBe(401);
    expect(h.sqsSends).toHaveLength(1);
  });
});

describe("POST /api/jira/webhook (secret unset — passthrough + one-time warning)", () => {
  beforeEach(() => {
    h.sqsSends.length = 0;
    h.lambdaInvokes.length = 0;
    process.env.WORKFLOW_COMMAND_QUEUE_URL =
      "https://sqs.us-east-1.amazonaws.com/123/agentcore-hub-workflow-commands.fifo";
    delete process.env.JIRA_WEBHOOK_SECRET;
  });

  it("passes through unsigned requests and warns exactly once across requests on the same module instance", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    const { POST } = await import("./route");
    const send = (body: unknown) =>
      POST(
        new NextRequest("http://localhost/api/jira/webhook", {
          method: "POST",
          body: JSON.stringify(body),
        })
      );

    const res1 = await send(webhookPayload());
    const res2 = await send(webhookPayload());

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(h.sqsSends).toHaveLength(2);
    const warnCalls = warnSpy.mock.calls.filter((c) => String(c[0]).includes("JIRA_WEBHOOK_SECRET"));
    expect(warnCalls).toHaveLength(1);
    warnSpy.mockRestore();
  });

  // TEAM-6333: a whitespace-only secret must still count as unset (passthrough),
  // not as a configured-but-empty HMAC key.
  it("treats a whitespace-only secret as unset and passes the request through", async () => {
    process.env.JIRA_WEBHOOK_SECRET = "   ";
    const res = await post(webhookPayload());
    expect(res.status).toBe(200);
    expect(h.sqsSends).toHaveLength(1);
  });
});
