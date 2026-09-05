import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-4099 F6 — PATCH /api/workflow/[id]/escalations must acknowledge ONE
 * notification without touching the rest of the list.
 *
 * The bug: the route read `humanNotifications`, flipped `acknowledged` in memory
 * and wrote `SET humanNotifications = :n`. An escalation appended by the
 * orchestrator (or a review_needed) between that read and that write was
 * silently deleted — and an open human gate that vanishes is a run nobody knows
 * is stuck, because the watch scheduler only skips runs with an OPEN escalation.
 *
 * The seam is the DDB doc client; every command input is captured.
 */

const h = vi.hoisted(() => ({
  state: {
    item: null as Record<string, unknown> | null,
    updates: [] as Array<Record<string, any>>,
  },
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class Cmd {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetCommand extends Cmd {}
  class UpdateCommand extends Cmd {}
  return {
    GetCommand,
    UpdateCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
          if (cmd.constructor.name === "GetCommand") return { Item: h.state.item };
          h.state.updates.push(cmd.input);
          return {};
        },
      }),
    },
  };
});

const { GET, PATCH } = await import("./route");

function patch(body?: Record<string, unknown>) {
  return PATCH(
    new NextRequest("http://localhost/api/workflow/wf_1/escalations", {
      method: "PATCH",
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    { params: { id: "wf_1" } }
  );
}

const NOTIFS = [
  { id: "esc-1", type: "manager_escalation", message: "stuck on TEAM-1" },
  { id: "rev-1", type: "review_needed", message: "gate TEAM-2" },
  { id: "esc-2", type: "manager_escalation", message: "stuck on TEAM-3" },
];

beforeEach(() => {
  h.state.item = { workflowId: "wf_1", humanNotifications: NOTIFS.map((n) => ({ ...n })) };
  h.state.updates.length = 0;
});

describe("escalations — the ack is per index, never a full-list write", () => {
  it("acknowledging one escalation writes ONLY that index", async () => {
    const res = await patch({ notificationId: "esc-2" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workflowId: "wf_1", resolved: ["esc-2"] });

    expect(h.state.updates).toHaveLength(1);
    const [u] = h.state.updates;
    expect(u.UpdateExpression).toContain("humanNotifications[2].acknowledged = :true");
    expect(u.UpdateExpression).toContain("humanNotifications[2].acknowledgedAt = :ts");
    expect(u.ConditionExpression).toBe("humanNotifications[2].id = :id");
    expect(u.ExpressionAttributeValues[":id"]).toBe("esc-2");
    // The regression itself: no whole-list assignment anywhere.
    expect(JSON.stringify(h.state.updates)).not.toContain("SET humanNotifications = ");
  });

  it("the ack bumps notifVersion, so a concurrent orchestrator rewrite re-reads instead of resurrecting it", async () => {
    await patch({ notificationId: "esc-1" });
    expect(h.state.updates[0].UpdateExpression).toContain("notifVersion = if_not_exists(notifVersion, :zero) + :one");
  });

  it("no body → every OPEN escalation is acked, one write each, and non-escalations are untouched", async () => {
    const res = await patch();
    expect(await res.json()).toEqual({ workflowId: "wf_1", resolved: ["esc-1", "esc-2"] });
    expect(h.state.updates).toHaveLength(2);
    expect(h.state.updates.map((u) => u.ConditionExpression)).toEqual([
      "humanNotifications[0].id = :id",
      "humanNotifications[2].id = :id",
    ]);
    // rev-1 (index 1) is never written.
    expect(JSON.stringify(h.state.updates)).not.toContain("humanNotifications[1]");
  });

  it("an already-acknowledged escalation is not re-written", async () => {
    h.state.item = {
      workflowId: "wf_1",
      humanNotifications: [{ id: "esc-1", type: "manager_escalation", acknowledged: true }],
    };
    const res = await patch();
    expect(await res.json()).toEqual({ workflowId: "wf_1", resolved: [] });
    expect(h.state.updates).toEqual([]);
  });

  it("an unknown notificationId acks nothing (and writes nothing)", async () => {
    const res = await patch({ notificationId: "nope" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workflowId: "wf_1", resolved: [] });
    expect(h.state.updates).toEqual([]);
  });

  it("404s an unknown workflow before any write", async () => {
    h.state.item = null;
    const res = await patch({ notificationId: "esc-1" });
    expect(res.status).toBe(404);
    expect(h.state.updates).toEqual([]);
  });

  it("GET still lists escalations open-first", async () => {
    h.state.item = {
      humanNotifications: [
        { id: "esc-1", type: "manager_escalation", acknowledged: true },
        { id: "rev-1", type: "review_needed" },
        { id: "esc-2", type: "manager_escalation" },
      ],
    };
    const res = await GET(new NextRequest("http://localhost/api/workflow/wf_1/escalations"), {
      params: { id: "wf_1" },
    });
    const { escalations } = await res.json();
    expect(escalations.map((e: { id: string }) => e.id)).toEqual(["esc-2", "esc-1"]);
  });
});
