import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-5423 — POST /api/workflow/[id]/events is the Telegram bridge's write path
 * for `escalation.reminded`, and ONLY that. Anything else (an `agent.*` or a
 * `manager.intervention` especially) would skew the run's metrics, so it is a
 * 400 before any write. Auth is the middleware's, identical for GET and POST,
 * and the write is bound to a real workflow row carrying that review gate.
 */

const h = vi.hoisted(() => ({
  sends: [] as Array<{ name: string; input: Record<string, unknown> }>,
  fail: false,
  getFail: false,
  row: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => {
  class Cmd {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) { this.input = input; }
  }
  class PutCommand extends Cmd {}
  class QueryCommand extends Cmd {}
  class GetCommand extends Cmd {}
  return {
    GetCommand,
    PutCommand,
    QueryCommand,
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (cmd: Cmd) => {
          h.sends.push({ name: cmd.constructor.name, input: cmd.input });
          if (cmd instanceof GetCommand) {
            if (h.getFail) throw new Error("ddb read down");
            return { Item: h.row };
          }
          if (h.fail) throw new Error("ddb down");
          return { Items: [] };
        },
      }),
    },
  };
});

const WF = "wf_1791496209224_ybbz7h";
const ctx = { params: { id: WF } };
const post = (body: unknown, id = WF) =>
  new NextRequest(`http://hub.local/api/workflow/${id}/events`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
const valid = {
  type: "escalation.reminded",
  gateTicketId: "TEAM-5389",
  notifId: "notif_TEAM-5389_2026-10-06T12:00:00.000Z",
  tier: 0,
  dueAt: "2026-10-06T16:00:00.000Z",
  elapsedMs: 14_400_000,
};
const gateRow = () => ({
  workflowId: WF,
  humanNotifications: [
    { id: valid.notifId, type: "review_needed", acknowledged: false, ticketId: "TEAM-5389" },
    { id: "notif_other", type: "approval_needed", acknowledged: false, ticketId: "TEAM-5390" },
  ],
});
const puts = () => h.sends.filter((s) => s.name === "PutCommand");

describe("POST /api/workflow/[id]/events", () => {
  beforeEach(() => { h.sends.length = 0; h.fail = false; h.getFail = false; h.row = gateRow(); });

  it("writes exactly one escalation.reminded row with a <ms>- eventId", async () => {
    const { POST } = await import("./route");
    const res = await POST(post(valid), ctx);
    expect(res.status).toBe(200);
    expect(puts()).toHaveLength(1);
    const item = puts()[0].input.Item as Record<string, unknown>;
    expect(item.workflowId).toBe(WF);
    expect(item.type).toBe("escalation.reminded");
    expect(String(item.eventId)).toMatch(/^\d{13}-escrem-/);
    expect(item.detail).toMatchObject({ gateTicketId: "TEAM-5389", tier: 0, elapsedMs: 14_400_000, producer: "telegram-bug-intake" });
  });

  it.each([
    ["agent.started"], ["agent.streaming"], ["manager.intervention"], ["workflow.nudge"], [undefined],
  ])("rejects type %s with 400 and writes nothing", async (type) => {
    const { POST } = await import("./route");
    const res = await POST(post({ ...valid, type }), ctx);
    expect(res.status).toBe(400);
    expect(h.sends).toHaveLength(0);
  });

  it.each([
    ["tier negative", { tier: -1 }],
    ["tier fractional", { tier: 1.5 }],
    ["tier too large", { tier: 501 }],
    ["gateTicketId not a key", { gateTicketId: "../etc" }],
    ["elapsedMs negative", { elapsedMs: -5 }],
    ["dueAt garbage", { dueAt: "tomorrow-ish" }],
    ["tier missing", { tier: undefined }],
    ["dueAt missing", { dueAt: undefined }],
    ["elapsedMs missing", { elapsedMs: undefined }],
    ["notifId missing", { notifId: undefined }],
  ])("rejects %s with 400", async (_label, patch) => {
    const { POST } = await import("./route");
    const res = await POST(post({ ...valid, ...patch }), ctx);
    expect(res.status).toBe(400);
    expect(h.sends).toHaveLength(0);
  });

  it("413s an oversized body and 400s non-JSON", async () => {
    const { POST } = await import("./route");
    expect((await POST(post({ ...valid, pad: "x".repeat(3000) }), ctx)).status).toBe(413);
    expect((await POST(post("not json"), ctx)).status).toBe(400);
    expect(h.sends).toHaveLength(0);
  });

  it("has no liveCheck mode: the old liveCheck-only shape is a 400, and an extra liveCheck is not stored", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ type: "escalation.reminded", gateTicketId: "TEAM-5389", liveCheck: true }), ctx);
    expect(res.status).toBe(400);
    expect(h.sends).toHaveLength(0);
    expect((await POST(post({ ...valid, liveCheck: true }), ctx)).status).toBe(200);
    expect((puts()[0].input.Item as { detail: Record<string, unknown> }).detail).not.toHaveProperty("liveCheck");
  });

  it("404s an unknown workflow and writes nothing", async () => {
    h.row = undefined;
    const { POST } = await import("./route");
    expect((await POST(post(valid), ctx)).status).toBe(404);
    expect(puts()).toHaveLength(0);
  });

  it.each([
    ["a gate ticket the run does not have", { gateTicketId: "TEAM-9999" }],
    ["a notifId that is not that gate's", { notifId: "notif_forged" }],
    ["a non-review notification's ticket", { gateTicketId: "TEAM-5390", notifId: "notif_other" }],
  ])("409s %s and writes nothing", async (_label, patch) => {
    const { POST } = await import("./route");
    expect((await POST(post({ ...valid, ...patch }), ctx)).status).toBe(409);
    expect(puts()).toHaveLength(0);
  });

  it("matches a notification with no id on its ticket (the bridge keys on id || ticketId)", async () => {
    h.row = { workflowId: WF, humanNotifications: [{ type: "review_needed", ticketId: "TEAM-5389" }] };
    const { POST } = await import("./route");
    expect((await POST(post({ ...valid, notifId: "TEAM-5389" }), ctx)).status).toBe(200);
    expect(puts()).toHaveLength(1);
  });

  it("500s when the workflow read fails, before any write", async () => {
    h.getFail = true;
    const { POST } = await import("./route");
    expect((await POST(post(valid), ctx)).status).toBe(500);
    expect(puts()).toHaveLength(0);
  });

  it("500s when the table write fails", async () => {
    h.fail = true;
    const { POST } = await import("./route");
    expect((await POST(post(valid), ctx)).status).toBe(500);
  });
});

describe("auth — POST is gated exactly like GET", () => {
  it("both methods get the middleware's 401 when the resolver rejects", async () => {
    vi.resetModules();
    vi.doMock("@/lib/auth/resolver", () => ({ activeResolver: () => ({ resolve: async () => null }) }));
    const { middleware } = await import("@/middleware");
    for (const method of ["GET", "POST"]) {
      const res = await middleware(new NextRequest(`http://hub.local/api/workflow/${WF}/events`, { method }));
      expect(res.status, method).toBe(401);
    }
    vi.doUnmock("@/lib/auth/resolver");
  });

  it("both methods pass through when the resolver accepts", async () => {
    vi.resetModules();
    vi.doMock("@/lib/auth/resolver", () => ({
      activeResolver: () => ({ resolve: async () => ({ userId: "u", tenantId: "t", email: "u@x", groups: [] }) }),
    }));
    const { middleware } = await import("@/middleware");
    for (const method of ["GET", "POST"]) {
      const res = await middleware(new NextRequest(`http://hub.local/api/workflow/${WF}/events`, { method }));
      expect(res.status, method).toBe(200);
    }
    vi.doUnmock("@/lib/auth/resolver");
  });
});
