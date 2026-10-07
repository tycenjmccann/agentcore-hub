/**
 * TEAM-5375: the Lambda-mode workflow webhook writes a Jira status change straight
 * to the tickets table. Every Won't Do / Cancelled spelling must land as
 * `cancelled` — never as a raw "wont do" the orchestrator reads as open work.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ updates: [] as Array<Record<string, unknown>> }));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  class UpdateCommand extends Cmd {}
  class GetCommand extends Cmd {}
  return {
    UpdateCommand,
    GetCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: Cmd) => {
          if (cmd instanceof UpdateCommand) h.updates.push(cmd.input);
          return {};
        },
      }),
    },
  };
});

const { POST } = await import("./route");

function transition(toString: string) {
  return new NextRequest("http://localhost/api/workflow/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event_type: "jira_transition",
      issue_key: "TEAM-9",
      changelog: { items: [{ field: "status", toString }] },
    }),
  });
}

describe("workflow webhook: Jira status -> ticket status (TEAM-5375)", () => {
  beforeEach(() => {
    h.updates = [];
  });

  it.each([
    ["Wont Do", "cancelled"],
    ["WON'T DO", "cancelled"],
    ["Won't Do", "cancelled"],
    ["Won’t Do", "cancelled"],
    ["Canceled", "cancelled"],
    ["Done", "done"],
    ["In Review", "in_review"],
  ])("%s is written as %s", async (name, want) => {
    const res = await POST(transition(name));
    expect(res.status).toBe(200);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].Key).toEqual({ ticketId: "TEAM-9" });
    expect((h.updates[0].ExpressionAttributeValues as Record<string, unknown>)[":s"]).toBe(want);
  });
});
