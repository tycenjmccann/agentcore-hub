import { describe, it, expect, beforeEach, vi } from "vitest";
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
          if (name === "GetCommand") return { Item: { workflowId: "wf_1", epicId: "TEAM-1" } };
          return { Attributes: { nextNum: 1 } };
        },
      }),
    },
  };
});

let POST: typeof import("./route").POST;

beforeEach(async () => {
  h.sends.length = 0;
  vi.resetModules();
  ({ POST } = await import("./route"));
});

function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/workflow/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

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

  it("sanity: jira_transition still writes exactly one status Update (the mock really observes writes)", async () => {
    const res = await post({
      event_type: "jira_transition",
      issue_key: "TEAM-7",
      changelog: { items: [{ field: "status", toString: "Done" }] },
    });
    const json = await res.json();
    expect(json).toEqual({ received: true, processed: true, mode: "lambda" });
    expect(h.sends.filter((s) => s.name === "UpdateCommand").length).toBe(1);
  });
});
