/**
 * TEAM-4120 FR-2 — events-writer.mjs, the EventBridge-fan-out half of the
 * events-table double-write.
 *
 * The whole point of FR-2 is that this Lambda and the publisher agree on the
 * (workflowId, eventId) key, so the fan-out Put OVERWRITES the publisher's
 * direct row instead of adding a second one. That agreement is what this file
 * pins: the row's key under enforce must equal deterministicEventId(detail-type,
 * detail) — the exact expression publishEvent/publishAgentEvent now use.
 *
 * events-writer.mjs constructs its DynamoDBDocumentClient at MODULE LOAD and
 * reads EVENT_DEDUPE_MODE there too, so each mode needs a fresh module graph:
 * loadHandler() sets the env then vi.resetModules() + dynamic import. The AWS
 * seams are mocked the same way agent-invoker-retry.test.mjs mocks them, with a
 * hoisted state object that survives vi.resetModules().
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { deterministicEventId } from "./event-id.mjs";

const h = vi.hoisted(() => ({ puts: [] }));

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
}));

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: () => ({
      send: async (cmd) => {
        if (cmd?.constructor?.name === "PutCommand") h.puts.push(cmd.input);
        return {};
      },
    }),
  },
  PutCommand: class { constructor(i) { this.input = i; } },
}));

// The pre-4120 (and still-default-off) shape: <ms base36 padStart 9>-<counter base36 padStart 4>.
const BASE36_RE = /^[0-9a-z]{9}-[0-9a-z]{4}$/;
const DETERMINISTIC_RE = /^\d{13}-[0-9a-f]{8}$/;

const TS = "2026-09-05T12:00:00.000Z";

/** What EventBridge hands the target: detail-type + source + the published detail. */
const EB_EVENT = {
  "detail-type": "agent.complete",
  source: "agentcore-hub.orchestrator",
  time: "2026-09-05T12:00:00Z",
  detail: {
    ticketId: "TEAM-4120",
    assignee: "agentcore_hub_api_dev",
    agentId: "agentcore_hub_api_dev",
    workflowId: "wf_1788637257831_f50ucz",
    timestamp: TS,
  },
};

async function loadHandler(mode) {
  if (mode === undefined) delete process.env.EVENT_DEDUPE_MODE;
  else process.env.EVENT_DEDUPE_MODE = mode;
  vi.resetModules();
  const mod = await import("./events-writer.mjs");
  return mod.handler;
}

beforeEach(() => {
  h.puts = [];
  delete process.env.EVENT_DEDUPE_MODE;
});

describe("EVENT_DEDUPE_MODE unset/off — byte-identical to pre-4120", () => {
  it.each([undefined, "off", "shadow", "on", "garbage"])("mode %j → the base36 monotonic id", async (mode) => {
    const handler = await loadHandler(mode);
    await handler(EB_EVENT);

    expect(h.puts).toHaveLength(1);
    expect(h.puts[0].Item.eventId).toMatch(BASE36_RE);
    expect(h.puts[0].Item.eventId).not.toMatch(DETERMINISTIC_RE);
  });

  it("keeps the base36 ids monotonic within a warm container (the counter still advances)", async () => {
    const handler = await loadHandler("off");
    await handler(EB_EVENT);
    await handler(EB_EVENT);
    await handler(EB_EVENT);

    const ids = h.puts.map((p) => p.Item.eventId);
    expect(ids).toHaveLength(3);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
  });

  it("writes the rest of the row unchanged: workflowId, type, source, detail, publisher timestamp", async () => {
    const handler = await loadHandler("off");
    await handler(EB_EVENT);

    const { Item, TableName } = h.puts[0];
    expect(TableName).toBe("agentcore-hub-events");
    expect(Item.workflowId).toBe("wf_1788637257831_f50ucz");
    expect(Item.type).toBe("agent.complete");
    // `source` is the ONLY attribute that distinguishes this row from the
    // publisher's direct copy — which is why the enforce-mode overwrite is benign.
    expect(Item.source).toBe("agentcore-hub.orchestrator");
    expect(Item.detail).toEqual(EB_EVENT.detail);
    expect(Item.timestamp).toBe(TS);
    // No ttl is stamped by either writer, so the overwrite can't shorten a life.
    expect(Item.ttl).toBeUndefined();
  });
});

describe("EVENT_DEDUPE_MODE=enforce — the fan-out row collapses onto the publisher's", () => {
  it("uses exactly deterministicEventId(detail-type, detail) — the publisher's expression", async () => {
    const handler = await loadHandler("enforce");
    await handler(EB_EVENT);

    expect(h.puts).toHaveLength(1);
    const { eventId } = h.puts[0].Item;
    expect(eventId).toBe(deterministicEventId("agent.complete", EB_EVENT.detail));
    expect(eventId).toMatch(DETERMINISTIC_RE);
    // Same (workflowId, eventId) as the publisher's direct write → the Put
    // overwrites it rather than adding a second row.
    expect(h.puts[0].Item.workflowId).toBe("wf_1788637257831_f50ucz");
  });

  it("is idempotent across redeliveries: EventBridge at-least-once gives ONE key", async () => {
    const handler = await loadHandler("enforce");
    await handler(EB_EVENT);
    // A JSON round-trip (what a redelivery actually looks like) reshuffles keys.
    await handler(JSON.parse(JSON.stringify(EB_EVENT)));

    const ids = h.puts.map((p) => p.Item.eventId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it("case/whitespace-insensitive: \"  Enforce \" still enforces", async () => {
    const handler = await loadHandler("  Enforce ");
    await handler(EB_EVENT);
    expect(h.puts[0].Item.eventId).toBe(deterministicEventId("agent.complete", EB_EVENT.detail));
  });

  it("agent.streaming keeps the base36 id even under enforce", async () => {
    const handler = await loadHandler("enforce");
    await handler({
      ...EB_EVENT,
      "detail-type": "agent.streaming",
      source: "agentcore-hub.agent-invoker",
      detail: { ...EB_EVENT.detail, chunk: "partial output" },
    });

    expect(h.puts[0].Item.eventId).toMatch(BASE36_RE);
    expect(h.puts[0].Item.type).toBe("agent.streaming");
  });

  it("an event with no parseable detail.timestamp falls back to a random id rather than colliding", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = await loadHandler("enforce");
    await handler({ ...EB_EVENT, detail: { ticketId: "TEAM-4120", workflowId: "wf_1" } });

    expect(h.puts[0].Item.eventId).toMatch(/^\d{13}-[0-9a-z]{1,6}$/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves every other attribute of the row exactly as off mode writes it", async () => {
    const offHandler = await loadHandler("off");
    await offHandler(EB_EVENT);
    const enforceHandler = await loadHandler("enforce");
    await enforceHandler(EB_EVENT);

    const [{ Item: off }, { Item: on }] = h.puts;
    // eventId is the ONLY intended difference.
    const { eventId: _a, ...offRest } = off;
    const { eventId: _b, ...onRest } = on;
    expect(onRest).toEqual(offRest);
  });
});
