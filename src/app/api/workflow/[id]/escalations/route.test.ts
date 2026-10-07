import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-5376 — PATCH /api/workflow/[id]/escalations is the acknowledgement path for
 * the close-out notifications (notif_completion_*, notif_followup_security_*) in
 * docs/workflow/closeout-lifecycle.md. Acknowledging marks an entry in place; it
 * never removes it, so the FR-2 refusal (prefix match, acknowledged or not) stands.
 *
 * Only the DDB doc client is mocked: GetCommand serves the row, writes are captured.
 */

const h = vi.hoisted(() => ({
  state: {
    item: undefined as Record<string, unknown> | undefined,
    updates: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class UpdateCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    GetCommand,
    UpdateCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
          if (cmd.constructor.name === "GetCommand") return { Item: h.state.item };
          h.state.updates.push(cmd.input);
          return {};
        },
      }),
    },
  };
});

let PATCH: typeof import("./route").PATCH;

const MARKER = { id: "notif_completion_evidence_wf_1", type: "manager_escalation", acknowledged: false };
const SECURITY = { id: "notif_followup_security_T-9", type: "manager_escalation", acknowledged: false };
const REVIEW = { id: "notif_review_1", type: "review_needed", acknowledged: false };

function patch(body: Record<string, unknown>) {
  return PATCH(
    new NextRequest("http://localhost/api/workflow/wf_1/escalations", { method: "PATCH", body: JSON.stringify(body) }),
    { params: { id: "wf_1" } },
  );
}

beforeEach(async () => {
  h.state.updates.length = 0;
  h.state.item = { humanNotifications: [{ ...MARKER }, { ...SECURITY }, { ...REVIEW }] };
  vi.resetModules();
  ({ PATCH } = await import("./route"));
});

describe("PATCH escalations — close-out notification acknowledgement (TEAM-5376)", () => {
  it("PATCH acknowledges a notif_completion_* marker in place (acknowledged, acknowledgedAt); the entry stays", async () => {
    const res = await patch({ notificationId: MARKER.id });
    expect(res.status).toBe(200);
    expect((await res.json()).resolved).toEqual([MARKER.id]);

    expect(h.state.updates.length).toBe(1);
    const written = (h.state.updates[0].ExpressionAttributeValues as Record<string, unknown>)[":n"] as Array<Record<string, unknown>>;
    expect(written.map((n) => n.id)).toEqual([MARKER.id, SECURITY.id, REVIEW.id]);
    expect(written[0]).toMatchObject({ acknowledged: true });
    expect(typeof written[0].acknowledgedAt).toBe("string");
    expect(written[1].acknowledged).toBe(false);
    expect(written[2].acknowledged).toBe(false);
  });

  it("no notificationId acknowledges every open manager_escalation (the Telegram Resolved button), never review_needed", async () => {
    const res = await patch({});
    expect((await res.json()).resolved).toEqual([MARKER.id, SECURITY.id]);
    const written = (h.state.updates[0].ExpressionAttributeValues as Record<string, unknown>)[":n"] as Array<Record<string, unknown>>;
    expect(written.map((n) => n.acknowledged)).toEqual([true, true, false]);
  });
});
