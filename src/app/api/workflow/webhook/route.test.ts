import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-5781 — the webhook's `request_fix` branch minted a ticket id with its own
 * `__COUNTER__` UpdateCommand and upserted the fix ticket straight into DynamoDB,
 * bypassing the tickets Lambda's create_ticket (validation, gate guards,
 * idempotency). Nothing in the repo ever posts `event_type: "request_fix"` to this
 * route (docs/architecture.md already called it dead code), so the branch — and
 * the webhook's private `nextTicketId` it alone called — is deleted outright
 * rather than rerouted through create_ticket.
 *
 * Seam-mocked exactly like src/app/api/bugs/route.test.ts: the real POST handler
 * runs; only the DynamoDB doc client is stubbed, with every send() recorded.
 */
const h = vi.hoisted(() => ({
  sends: [] as Array<{ name: string; input: Record<string, unknown> }>,
  // TEAM-6094: every tickets-Lambda invoke, and what the next one answers / throws.
  invokes: [] as Array<{ FunctionName?: string; InvocationType?: string; payload: Record<string, unknown> }>,
  lambdaResp: {} as { Payload?: Uint8Array; FunctionError?: string },
  lambdaThrows: null as Error | null,
}));

vi.mock("@aws-sdk/client-lambda", () => {
  class InvokeCommand {
    constructor(public input: { FunctionName?: string; InvocationType?: string; Payload?: Uint8Array }) {}
  }
  class LambdaClient {
    async send(cmd: InvokeCommand) {
      h.invokes.push({
        FunctionName: cmd.input.FunctionName,
        InvocationType: cmd.input.InvocationType,
        payload: JSON.parse(Buffer.from(cmd.input.Payload as Uint8Array).toString()),
      });
      if (h.lambdaThrows) throw h.lambdaThrows;
      return h.lambdaResp;
    }
  }
  return { LambdaClient, InvokeCommand };
});

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

let POST: typeof import("./route").POST;

const SECRET = "s3cr3t-webhook-value";
const SAVED = { WEBHOOK_SECRET: process.env.WEBHOOK_SECRET, TICKET_TOOLS_LAMBDA: process.env.TICKET_TOOLS_LAMBDA };

const lambdaAnswers = (body: unknown, FunctionError?: string) => {
  h.lambdaResp = { Payload: new TextEncoder().encode(JSON.stringify(body)), ...(FunctionError ? { FunctionError } : {}) };
};

// TEAM-6123 — unlike lambdaAnswers, does not JSON.stringify: lets a test hand the
// route the EXACT raw bytes a Lambda payload could be, including text that is not
// valid JSON at all (lambdaAnswers can only ever produce valid JSON text).
const lambdaAnswersRaw = (text: string) => {
  h.lambdaResp = { Payload: new TextEncoder().encode(text) };
};

beforeEach(async () => {
  h.sends.length = 0;
  h.invokes.length = 0;
  h.lambdaThrows = null;
  lambdaAnswers({ key: "TEAM-7", status: "transitioned", from: "in_review", to: "done" });
  process.env.WEBHOOK_SECRET = SECRET;
  delete process.env.TICKET_TOOLS_LAMBDA;
  vi.resetModules();
  ({ POST } = await import("./route"));
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function post(body: Record<string, unknown>, secret: string | null = SECRET) {
  return POST(
    new NextRequest("http://localhost/api/workflow/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret === null ? {} : { "x-webhook-secret": secret }) },
      body: JSON.stringify(body),
    })
  );
}

const JIRA_DONE = { event_type: "jira_transition", issue_key: "TEAM-7", changelog: { items: [{ field: "status", toString: "Done" }] } };
const directDoneWrites = () =>
  h.sends.filter(
    (s) => s.name === "UpdateCommand" && (s.input.ExpressionAttributeValues as Record<string, unknown>)?.[":s"] === "done"
  );

describe("POST /api/workflow/webhook — request_fix is not a live action (TEAM-5781)", () => {
  it("request_fix is ignored and writes NOTHING to DynamoDB (no orphan ticket-id mint, no bare upsert)", async () => {
    const res = await post({
      event_type: "request_fix",
      workflow_id: "wf_1",
      target_agent: "dev-1",
      findings: "QA found a bug",
      qa_ticket_id: "TEAM-42",
    });
    const json = await res.json();
    expect(json).toEqual({ received: true, ignored: true });
    expect(h.sends.length).toBe(0);
  });

  it("sanity: a non-done jira_transition still writes exactly one status Update (the mock really observes writes)", async () => {
    const res = await post({
      event_type: "jira_transition",
      issue_key: "TEAM-7",
      changelog: { items: [{ field: "status", toString: "In Progress" }] },
    });
    const json = await res.json();
    expect(json).toEqual({ received: true, processed: true, mode: "lambda" });
    expect(h.sends.filter((s) => s.name === "UpdateCommand").length).toBe(1);
    expect(h.invokes.length).toBe(0);
  });
});

/**
 * TEAM-5953 — the webhook's `agent_completion` branch wrote ticket status "done"
 * straight into DynamoDB (findTicketForAgent / explicit ticket_id → UpdateCommand),
 * bypassing the tickets Lambda's transition_ticket — which runs judgeCompletionRecord
 * and the TEAM-5941 doneIntent fence before a ticket is allowed to land Done. Nothing
 * in the repo posts `event_type: "agent_completion"` to this route (orchestrator
 * comment at lambda/orchestrator/index.mjs:1261 already called it dead), so — same
 * precedent as TEAM-5781's request_fix removal above — the branch is deleted outright
 * rather than rerouted through transition_ticket.
 */
describe("POST /api/workflow/webhook — agent_completion is not a live action (TEAM-5953)", () => {
  it("agent_completion with an explicit ticket_id is ignored and writes NOTHING to DynamoDB (no fence-bypassing Done)", async () => {
    const res = await post({
      event_type: "agent_completion",
      workflow_id: "wf_1",
      agent_id: "dev-1",
      ticket_id: "TEAM-9",
      branch: "feature/x",
      commit_sha: "abc123",
    });
    const json = await res.json();
    expect(json).toEqual({ received: true, ignored: true });
    expect(h.sends.length).toBe(0);
    expect(h.invokes.length).toBe(0);
    expect(
      h.sends.some(
        (s) => s.name === "UpdateCommand" && (s.input.ExpressionAttributeValues as Record<string, unknown>)?.[":s"] === "done"
      )
    ).toBe(false);
  });

  it("agent_completion without a ticket_id (resolved via findTicketForAgent) is ignored and writes NOTHING to DynamoDB", async () => {
    const res = await post({
      event_type: "agent_completion",
      workflow_id: "wf_1",
      agent_id: "dev-1",
    });
    const json = await res.json();
    expect(json).toEqual({ received: true, ignored: true });
    expect(h.sends.length).toBe(0);
    expect(h.invokes.length).toBe(0);
    expect(
      h.sends.some(
        (s) => s.name === "UpdateCommand" && (s.input.ExpressionAttributeValues as Record<string, unknown>)?.[":s"] === "done"
      )
    ).toBe(false);
  });
});

/**
 * TEAM-6094 (TEAM-6097) — the route failed OPEN: `WEBHOOK_SECRET || "dev-secret"`
 * plus `if (WEBHOOK_SECRET !== "dev-secret" && …)` meant an unset secret (or the
 * placeholder itself) skipped the check, so any caller could post a Jira-shaped
 * `→ Done`, which was then written straight to DynamoDB past the tickets Lambda's
 * completion-record / brief-hold guard and doneIntent fence.
 */
describe("POST /api/workflow/webhook — auth fails closed (TEAM-6094)", () => {
  it("WEBHOOK_SECRET unset → 503, zero DynamoDB sends, zero Lambda invokes", async () => {
    delete process.env.WEBHOOK_SECRET;
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(503);
    expect(h.sends.length).toBe(0);
    expect(h.invokes.length).toBe(0);
  });

  it("WEBHOOK_SECRET blank → 503, zero sends", async () => {
    process.env.WEBHOOK_SECRET = "   ";
    const res = await post(JIRA_DONE, "   ");
    expect(res.status).toBe(503);
    expect(h.sends.length).toBe(0);
    expect(h.invokes.length).toBe(0);
  });

  it('WEBHOOK_SECRET="dev-secret" (the old default) → 503 even with a matching header, zero sends', async () => {
    process.env.WEBHOOK_SECRET = "dev-secret";
    const res = await post(JIRA_DONE, "dev-secret");
    expect(res.status).toBe(503);
    expect(h.sends.length).toBe(0);
    expect(h.invokes.length).toBe(0);
  });

  it("wrong header with a real secret configured → 401, zero sends", async () => {
    const res = await post(JIRA_DONE, "not-the-secret");
    expect(res.status).toBe(401);
    expect(h.sends.length).toBe(0);
    expect(h.invokes.length).toBe(0);
  });

  it("same-length wrong header → 401 (constant-time compare, not a prefix check)", async () => {
    const res = await post(JIRA_DONE, SECRET.slice(0, -1) + "X");
    expect(res.status).toBe(401);
    expect(h.sends.length + h.invokes.length).toBe(0);
  });

  it("missing header with a real secret configured → 401, zero sends", async () => {
    const res = await post(JIRA_DONE, null);
    expect(res.status).toBe(401);
    expect(h.sends.length).toBe(0);
    expect(h.invokes.length).toBe(0);
  });
});

describe("POST /api/workflow/webhook — done routes through the tickets Lambda guard (TEAM-6094)", () => {
  it("jira_transition Done → no direct done UpdateCommand; one Tickets___transition_ticket invoke with the console's payload shape", async () => {
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, processed: true, mode: "lambda", via: "tickets-lambda" });
    expect(directDoneWrites()).toHaveLength(0);
    expect(h.sends.length).toBe(0);
    expect(h.invokes).toHaveLength(1);
    expect(h.invokes[0]).toMatchObject({
      FunctionName: "agentcore-hub-tickets",
      InvocationType: "RequestResponse",
      payload: {
        tool_name: "Tickets___transition_ticket",
        parameters: { ticket_id: "TEAM-7", transition_id: "done", reason: expect.any(String) },
      },
    });
  });

  it("TICKET_TOOLS_LAMBDA names the function (jira mode)", async () => {
    process.env.TICKET_TOOLS_LAMBDA = "agentcore-hub-jira";
    vi.resetModules();
    ({ POST } = await import("./route"));
    lambdaAnswers({ ticketId: "TEAM-7", status: "done", message: "ok" });
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(200);
    expect(h.invokes[0].FunctionName).toBe("agentcore-hub-jira");
  });

  it("a Jira-shaped body with no event_type (the real webhook) → Done also goes through the Lambda", async () => {
    const res = await post({ issue: { key: "TEAM-7" }, changelog: { items: [{ field: "status", toString: "Done" }] } });
    expect(res.status).toBe(200);
    expect(directDoneWrites()).toHaveLength(0);
    expect(h.invokes).toHaveLength(1);
    expect(h.invokes[0].payload).toMatchObject({ parameters: { ticket_id: "TEAM-7", transition_id: "done" } });
  });

  it("tickets Lambda refuses the Done (tickets twin: content text, e.g. a brief hold) → 409, no direct write", async () => {
    lambdaAnswers({ content: [{ text: "TEAM-7 has briefPending:true (brief not on the Merge Approval gate)" }] });
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json).toMatchObject({ error: "Ticket transition rejected", ticketId: "TEAM-7" });
    expect(json.details).toMatch(/briefPending:true/);
    expect(h.sends.length).toBe(0);
    expect(h.invokes).toHaveLength(1);
  });

  it("jira twin's refusal shape ({ error }) → 409, no direct write", async () => {
    lambdaAnswers({ error: "completion record completions/TEAM-7.json not proven" });
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(409);
    expect((await res.json()).details).toMatch(/not proven/);
    expect(h.sends.length).toBe(0);
  });

  it("FunctionError → 502, no direct write", async () => {
    lambdaAnswers({ errorMessage: "Task timed out" }, "Unhandled");
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(502);
    expect(h.sends.length).toBe(0);
  });

  it("the invoke itself throws → 502, no direct write", async () => {
    h.lambdaThrows = Object.assign(new Error("AccessDeniedException"), { name: "AccessDeniedException" });
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(502);
    expect((await res.json()).details).toMatch(/AccessDenied/);
    expect(h.sends.length).toBe(0);
  });
});

/**
 * TEAM-6123 (P2) — rejectedDetails is a DENY-list: it answers null for any
 * payload it doesn't recognize as a refusal, and a 200 with no FunctionError and
 * no recognized refusal was treated as "the ticket moved". None of these five
 * shapes prove a transition happened, so each must now 502 instead of the old
 * 200 processed:true — and, since the invoke genuinely returned with no
 * FunctionError, there is still no direct DynamoDB write either way.
 */
describe("POST /api/workflow/webhook — an unproven Done is not a success (TEAM-6123)", () => {
  it("unparseable payload text → 502, no direct write", async () => {
    lambdaAnswersRaw("not json");
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(502);
    expect(h.sends.length).toBe(0);
  });

  it("empty payload → 502, no direct write", async () => {
    lambdaAnswersRaw("");
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(502);
    expect(h.sends.length).toBe(0);
  });

  it('literal JSON "null" payload → 502, no direct write', async () => {
    lambdaAnswersRaw("null");
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(502);
    expect(h.sends.length).toBe(0);
  });

  it('"{}" payload → 502, no direct write', async () => {
    lambdaAnswersRaw("{}");
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(502);
    expect(h.sends.length).toBe(0);
  });

  it('a refusal-shaped-but-unrecognized object ({ok:true,status:"blocked"}) → 502, no direct write', async () => {
    lambdaAnswers({ ok: true, status: "blocked" });
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(502);
    expect(h.sends.length).toBe(0);
  });

  it("the real tickets-Lambda success shape still 200s (regression guard)", async () => {
    lambdaAnswers({ key: "TEAM-7", status: "transitioned", from: "in_review", to: "done" });
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, processed: true, mode: "lambda", via: "tickets-lambda" });
  });

  it("the real jira-Lambda success shape still 200s (regression guard)", async () => {
    lambdaAnswers({ ticketId: "TEAM-7", status: "done", message: "Transitioned to done" });
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, processed: true, mode: "lambda", via: "tickets-lambda" });
  });

  it("a real refusal is still 409, not 502 (the two codes stay distinct)", async () => {
    lambdaAnswers({ content: [{ text: "TEAM-7 has briefPending:true" }] });
    const res = await post(JIRA_DONE);
    expect(res.status).toBe(409);
  });
});
