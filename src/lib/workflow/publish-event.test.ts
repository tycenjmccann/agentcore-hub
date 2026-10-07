import { describe, it, expect, vi } from "vitest";
import type { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { publishWorkflowEvent, putBusEvent } from "./publish-event";

/**
 * TEAM-5399 (F3 of the #807 ship review): a PutEvents 200 can still drop the
 * entry. putBusEvent reports every way an event is lost; it never throws.
 */

const bus = (send: () => unknown) => ({ send: vi.fn(async () => send()) }) as unknown as EventBridgeClient;
const entry = { Source: "agentcore-hub.orchestrator", DetailType: "workflow.cancelled", Detail: "{}", EventBusName: "default" };

describe("putBusEvent", () => {
  it("ok when nothing threw, FailedEntryCount is 0 and the entry carries no ErrorCode", async () => {
    expect(await putBusEvent(bus(() => ({ FailedEntryCount: 0, Entries: [{ EventId: "e-1" }] })), entry)).toEqual({ ok: true });
  });

  it("FailedEntryCount 1 with an ErrorCode -> not ok, the code in the error", async () => {
    const res = await putBusEvent(bus(() => ({ FailedEntryCount: 1, Entries: [{ ErrorCode: "InternalFailure", ErrorMessage: "try again" }] })), entry);
    expect(res).toEqual({ ok: false, error: "InternalFailure: try again" });
  });

  it("an entry ErrorCode without a FailedEntryCount -> not ok", async () => {
    const res = await putBusEvent(bus(() => ({ Entries: [{ ErrorCode: "ThrottlingException" }] })), entry);
    expect(res.ok).toBe(false);
  });

  it("FailedEntryCount without entry detail -> not ok", async () => {
    expect(await putBusEvent(bus(() => ({ FailedEntryCount: 1 })), entry)).toEqual({ ok: false, error: "FailedEntryCount 1" });
  });

  it("a throw -> not ok, never rethrown", async () => {
    const res = await putBusEvent(bus(() => { throw new Error("EventBridge unavailable"); }), entry);
    expect(res).toEqual({ ok: false, error: "EventBridge unavailable" });
  });
});

describe("publishWorkflowEvent", () => {
  const base = {
    eventsTable: "events",
    eventBus: "default",
    workflowId: "wf-1",
    detailType: "workflow.cancelled",
    detail: { workflowId: "wf-1", cancelledAt: "2026-10-01T00:00:00.000Z" },
    timestamp: "2026-10-01T00:00:00.000Z",
  };

  it("sends the detail + timestamp to the bus and the same detail to the table; returns the bus result", async () => {
    const eb = bus(() => ({ FailedEntryCount: 0 }));
    const puts: Array<Record<string, unknown>> = [];
    const ddb = { send: async (c: { input: Record<string, unknown> }) => void puts.push(c.input) } as unknown as DynamoDBDocumentClient;
    expect(await publishWorkflowEvent({ ...base, eventBridge: eb, ddb })).toEqual({ ok: true });
    const sent = (eb.send as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0].input.Entries[0];
    expect(JSON.parse(sent.Detail)).toEqual({ ...base.detail, timestamp: base.timestamp });
    expect(puts[0]).toMatchObject({ TableName: "events", Item: { workflowId: "wf-1", type: "workflow.cancelled", detail: base.detail } });
    expect(puts[0].ConditionExpression).toBeUndefined();
  });

  it("idempotent: the row is written once per eventId, and an existing row is not an error", async () => {
    const puts: Array<Record<string, unknown>> = [];
    const ddb = {
      send: async (c: { input: Record<string, unknown> }) => {
        puts.push(c.input);
        throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
      },
    } as unknown as DynamoDBDocumentClient;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await publishWorkflowEvent({ ...base, eventBridge: bus(() => ({ FailedEntryCount: 0 })), ddb, eventId: "123-cancelled", idempotent: true });
    expect(res).toEqual({ ok: true });
    expect(puts[0]).toMatchObject({ ConditionExpression: "attribute_not_exists(eventId)", Item: { eventId: "123-cancelled" } });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a bus failure is returned even when the table row lands", async () => {
    const ddb = { send: async () => ({}) } as unknown as DynamoDBDocumentClient;
    const res = await publishWorkflowEvent({ ...base, eventBridge: bus(() => ({ FailedEntryCount: 1, Entries: [{ ErrorCode: "InternalFailure" }] })), ddb });
    expect(res.ok).toBe(false);
  });
});
