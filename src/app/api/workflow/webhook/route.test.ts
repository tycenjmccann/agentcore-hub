import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-6010 — this route accepted every request when WEBHOOK_SECRET was unset
 * (defaulted to the literal "dev-secret", which the auth check then special-cased
 * to always pass), and its agent_completion / jira_transition "done" branches
 * wrote `status: "done"` straight into the tickets table with a raw UpdateCommand
 * — bypassing the tickets Lambda's completion-record / brief-hold guard and the
 * doneIntent fence entirely. Fixed two ways: (1) the route now refuses every
 * request with 503 until a real WEBHOOK_SECRET is configured, 401 on a header
 * mismatch; (2) a `→ done` is sent through Tickets___transition_ticket on the
 * tickets Lambda — same invoke as
 * src/app/api/workflow/[id]/tickets/transition/route.ts — never a direct write.
 *
 * TEAM-5781 — the webhook's `request_fix` branch minted a ticket id with its own
 * `__COUNTER__` UpdateCommand and upserted the fix ticket straight into DynamoDB,
 * bypassing the tickets Lambda's create_ticket (validation, gate guards,
 * idempotency). Nothing in the repo ever posts `event_type: "request_fix"` to this
 * route (docs/architecture.md already called it dead code), so the branch — and
 * the webhook's private `nextTicketId` it alone called — is deleted outright
 * rather than rerouted through create_ticket.
 *
 * Seam-mocked exactly like src/app/api/bugs/route.test.ts: the real POST handler
 * runs; only the DynamoDB doc client and the Lambda client are stubbed, with
 * every send() recorded.
 */
const h = vi.hoisted(() => ({
  sends: [] as Array<{ name: string; input: Record<string, unknown> }>,
  lambdaCalls: [] as Array<{ input: Record<string, unknown> }>,
  lambdaPayload: { key: "completions/TEAM-7.json", status: "transitioned", from: "in_review", to: "done" } as unknown,
  lambdaFunctionError: undefined as string | undefined,
  lambdaThrows: undefined as Error | undefined,
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class UpdateCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    UpdateCommand,
    GetCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
          const name = cmd.constructor.name;
          h.sends.push({ name, input: cmd.input });
          if (name === "GetCommand") {
            // agentTasks keyed by ticket id, matching findTicketForAgent's shape —
            // TEAM-9 is dev-1's active ticket for the agent_completion tests below.
            return {
              Item: {
                workflowId: "wf_1",
                epicId: "TEAM-1",
                agentTasks: { "TEAM-9": { agentId: "dev-1", ticketId: "TEAM-9", status: "running" } },
              },
            };
          }
          return { Attributes: { nextNum: 1 } };
        },
      }),
    },
  };
});

vi.mock("@aws-sdk/client-lambda", () => {
  class InvokeCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class LambdaClient {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      h.lambdaCalls.push({ input: cmd.input });
      if (h.lambdaThrows) throw h.lambdaThrows;
      return {
        FunctionError: h.lambdaFunctionError,
        Payload: Buffer.from(JSON.stringify(h.lambdaPayload)),
      };
    }
  }
  return { LambdaClient, InvokeCommand };
});

let POST: typeof import("./route").POST;

const REAL_SECRET = "a-real-webhook-secret";

/**
 * Sets WEBHOOK_SECRET (or deletes it when `secret` is omitted) BEFORE the module
 * loads — the route reads it once at module scope, so a test that wants a
 * different value must reset modules and re-import, same as the sibling
 * transition route.test.ts idiom.
 */
async function load(secret?: string) {
  if (secret === undefined) delete process.env.WEBHOOK_SECRET;
  else process.env.WEBHOOK_SECRET = secret;
  h.sends.length = 0;
  h.lambdaCalls.length = 0;
  h.lambdaFunctionError = undefined;
  h.lambdaThrows = undefined;
  h.lambdaPayload = { key: "completions/TEAM-7.json", status: "transitioned", from: "in_review", to: "done" };
  vi.resetModules();
  ({ POST } = await import("./route"));
}

function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://localhost/api/workflow/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

function doneUpdates() {
  return h.sends.filter(
    (s) => s.name === "UpdateCommand" && (s.input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":s"] === "done"
  );
}

afterEach(() => {
  delete process.env.WEBHOOK_SECRET;
});

describe("POST /api/workflow/webhook — auth fails closed (TEAM-6010)", () => {
  it("WEBHOOK_SECRET unset → 503, zero DynamoDB sends, zero Lambda calls", async () => {
    await load(undefined);
    const res = await post(
      { event_type: "jira_transition", issue_key: "TEAM-7", changelog: { items: [{ field: "status", toString: "Done" }] } },
      { "x-webhook-secret": "anything" }
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toMatch(/webhook disabled/);
    expect(h.sends.length).toBe(0);
    expect(h.lambdaCalls.length).toBe(0);
  });

  it('WEBHOOK_SECRET="dev-secret" (the old default) → refused, zero sends', async () => {
    await load("dev-secret");
    const res = await post(
      { event_type: "jira_transition", issue_key: "TEAM-7", changelog: { items: [{ field: "status", toString: "Done" }] } },
      { "x-webhook-secret": "dev-secret" }
    );
    expect(res.status).toBe(503);
    expect(h.sends.length).toBe(0);
    expect(h.lambdaCalls.length).toBe(0);
  });

  it("wrong header with a real secret configured → 401, zero sends", async () => {
    await load(REAL_SECRET);
    const res = await post(
      { event_type: "jira_transition", issue_key: "TEAM-7", changelog: { items: [{ field: "status", toString: "In Progress" }] } },
      { "x-webhook-secret": "wrong" }
    );
    expect(res.status).toBe(401);
    expect(h.sends.length).toBe(0);
  });

  it("missing header with a real secret configured → 401, zero sends", async () => {
    await load(REAL_SECRET);
    const res = await post({
      event_type: "jira_transition",
      issue_key: "TEAM-7",
      changelog: { items: [{ field: "status", toString: "In Progress" }] },
    });
    expect(res.status).toBe(401);
    expect(h.sends.length).toBe(0);
  });
});

describe("POST /api/workflow/webhook — done routes through the tickets Lambda guard (TEAM-6010)", () => {
  it('jira_transition toString "Done" → no direct done UpdateCommand; invokes Tickets___transition_ticket', async () => {
    await load(REAL_SECRET);
    const res = await post(
      { event_type: "jira_transition", issue_key: "TEAM-7", changelog: { items: [{ field: "status", toString: "Done" }] } },
      { "x-webhook-secret": REAL_SECRET }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ received: true, processed: true, mode: "lambda", via: "tickets-lambda" });
    expect(doneUpdates().length).toBe(0);
    expect(h.lambdaCalls.length).toBe(1);
    const payload = JSON.parse(Buffer.from(h.lambdaCalls[0].input.Payload as Buffer).toString());
    expect(payload).toEqual({
      tool_name: "Tickets___transition_ticket",
      parameters: { ticket_id: "TEAM-7", transition_id: "done", reason: "Jira webhook transition to Done" },
    });
  });

  it("tickets Lambda refuses the Done (e.g. a brief hold) → 409, no direct write", async () => {
    await load(REAL_SECRET);
    h.lambdaPayload = { content: [{ text: "TEAM-7 has briefPending:true" }], status: "refused" };
    const res = await post(
      { event_type: "jira_transition", issue_key: "TEAM-7", changelog: { items: [{ field: "status", toString: "Done" }] } },
      { "x-webhook-secret": REAL_SECRET }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe("Ticket transition rejected");
    expect(json.details).toMatch(/briefPending/);
    expect(doneUpdates().length).toBe(0);
  });

  it("agent_completion → no direct done write, exactly one invoke", async () => {
    await load(REAL_SECRET);
    const res = await post(
      { event_type: "agent_completion", workflow_id: "wf_1", agent_id: "dev-1", ticket_id: "TEAM-9" },
      { "x-webhook-secret": REAL_SECRET }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ received: true, ticketId: "TEAM-9", mode: "lambda", via: "tickets-lambda" });
    expect(doneUpdates().length).toBe(0);
    expect(h.lambdaCalls.length).toBe(1);
    const payload = JSON.parse(Buffer.from(h.lambdaCalls[0].input.Payload as Buffer).toString());
    expect(payload.parameters).toEqual({
      ticket_id: "TEAM-9",
      transition_id: "done",
      reason: "agent_completion from dev-1",
    });
  });

  it("jira_transition toString In Progress → still one direct Update, no Lambda invoke (sanity: the mock really observes writes)", async () => {
    await load(REAL_SECRET);
    const res = await post(
      { event_type: "jira_transition", issue_key: "TEAM-7", changelog: { items: [{ field: "status", toString: "In Progress" }] } },
      { "x-webhook-secret": REAL_SECRET }
    );
    const json = await res.json();
    expect(json).toEqual({ received: true, processed: true, mode: "lambda" });
    expect(h.sends.filter((s) => s.name === "UpdateCommand").length).toBe(1);
    expect(h.lambdaCalls.length).toBe(0);
  });
});

describe("POST /api/workflow/webhook — request_fix is not a live action (TEAM-5781)", () => {
  it("request_fix is ignored and writes NOTHING to DynamoDB (no orphan ticket-id mint, no bare upsert)", async () => {
    await load(REAL_SECRET);
    const res = await post(
      {
        event_type: "request_fix",
        workflow_id: "wf_1",
        target_agent: "dev-1",
        findings: "QA found a bug",
        qa_ticket_id: "TEAM-42",
      },
      { "x-webhook-secret": REAL_SECRET }
    );
    const json = await res.json();
    expect(json).toEqual({ received: true, ignored: true });
    expect(h.sends.length).toBe(0);
  });
});
