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
    expect(
      h.sends.some(
        (s) => s.name === "UpdateCommand" && (s.input.ExpressionAttributeValues as Record<string, unknown>)?.[":s"] === "done"
      )
    ).toBe(false);
  });
});
