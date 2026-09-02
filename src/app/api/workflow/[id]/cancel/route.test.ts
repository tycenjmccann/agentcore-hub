import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-3755 — POST /api/workflow/[id]/cancel must refuse a run that already
 * closed deploy-blocked / static-ci-only, exactly like complete/route.ts and
 * the F6 UI fix (which only hides the button — this route is the actual
 * enforcement). Before this fix, TERMINAL_PHASES and the CAS
 * ConditionExpression were both hand-rolled to ["complete","error","cancelled"],
 * so cancelling a blocked run overwrote its honest verdict.
 *
 * We mock only the seams: the DDB doc client (GetCommand returns the
 * workflow; UpdateCommand's input is captured so the CAS condition itself can
 * be inspected) and the ticket-cancel/event-publish side effects.
 */

const h = vi.hoisted(() => {
  const state: {
    workflow: Record<string, unknown>;
    updates: Array<Record<string, unknown>>;
  } = { workflow: {}, updates: [] };
  return { state };
});

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class UpdateCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class QueryCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class PutCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    GetCommand,
    UpdateCommand,
    QueryCommand,
    PutCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          const name = cmd.constructor.name;
          if (name === "GetCommand") return { Item: h.state.workflow };
          if (name === "UpdateCommand") {
            h.state.updates.push(cmd.input);
            return {};
          }
          if (name === "QueryCommand") return { Items: [] }; // no child tickets
          return {}; // PutCommand (events table) — non-fatal
        },
      }),
    },
  };
});

const { POST } = await import("./route");

function makeRequest() {
  return new NextRequest("http://localhost/api/workflow/wf-1/cancel", {
    method: "POST",
  });
}

beforeEach(() => {
  h.state.workflow = {};
  h.state.updates = [];
});

/** Only the workflows-table CAS — the epic-close ticket update shares the same
 *  captured array but keys on ticketId, not workflowId. */
function workflowUpdates() {
  return h.state.updates.filter((u) => (u.Key as Record<string, unknown> | undefined)?.workflowId);
}

describe("TEAM-3755 — cancel refuses every terminal phase, not just complete/error/cancelled", () => {
  it.each(["deploy-blocked", "static-ci-only", "complete", "error", "cancelled"])(
    "409s a %s workflow and never issues the CAS write",
    async (phase) => {
      h.state.workflow = { workflowId: "wf-1", epicId: "epic-1", phase };
      const res = await POST(makeRequest(), { params: { id: "wf-1" } });
      expect(res.status).toBe(409);
      expect(h.state.updates).toHaveLength(0);
    }
  );

  it("still cancels a genuinely non-terminal run", async () => {
    h.state.workflow = { workflowId: "wf-1", epicId: "epic-1", phase: "development" };
    const res = await POST(makeRequest(), { params: { id: "wf-1" } });
    expect(res.status).toBe(200);
    expect(workflowUpdates()).toHaveLength(1);
  });

  it("the CAS ConditionExpression excludes all five terminal phases, not the old three-literal chain", async () => {
    h.state.workflow = { workflowId: "wf-1", epicId: "epic-1", phase: "development" };
    await POST(makeRequest(), { params: { id: "wf-1" } });
    expect(workflowUpdates()).toHaveLength(1);
    const [update] = workflowUpdates();
    const condition = String(update.ConditionExpression);
    const values = update.ExpressionAttributeValues as Record<string, string>;
    const excludedPhases = Object.entries(values)
      .filter(([key]) => condition.includes(`#phase <> ${key}`))
      .map(([, v]) => v)
      .sort();
    expect(excludedPhases).toEqual(
      ["complete", "error", "cancelled", "deploy-blocked", "static-ci-only"].sort()
    );
  });
});
