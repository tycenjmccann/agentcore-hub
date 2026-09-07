import { describe, it, expect, vi } from "vitest";
import { LEGACY_EVENT_WINDOW } from "./liveness.mjs";

/**
 * TEAM-4186 F7 — the AWS-facing half of the bounded event-window read
 * (index.mjs recentEventsPaged). liveness.test.mjs / replay-liveness.test.mjs
 * already pin the pure decision (activeTicketIds, livenessWindowSatisfied,
 * the windowFloorAt anchor); this file drives the REAL exported
 * recentEventsPaged against a mocked ddb.send to pin the read itself: the
 * paging loop's three stop conditions (every active ticket sampled / hard cap
 * / no more data), the windowFloorMs it hands the decision, the legacyWindow
 * leak guard (TEAM-4186 F6 — the deeper read must not reach the legacy path),
 * and that every Query keeps the exact shape the pre-epic Query had (same
 * table, no FilterExpression/IndexName — IAM unchanged).
 *
 * `h.send` is a forwarding indirection set up via vi.hoisted so each test can
 * swap ddb's behavior without re-importing index.mjs — except where the env
 * itself must differ (WM_LIVENESS_MODE=off), which re-imports via
 * vi.resetModules() (the same pattern used by lambda/orchestrator's
 * *-mode-defaults tests for the identical reason: LIVENESS_MODE is read once,
 * at module load, from process.env).
 */

const h = vi.hoisted(() => ({ send: null }));

vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...args) => h.send(...args) }) },
  QueryCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
  ScanCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
  UpdateCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
  GetCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
}));

async function loadIndex(env = {}) {
  vi.resetModules();
  delete process.env.WM_LIVENESS_MODE;
  delete process.env.WM_LIVENESS_DEV_MINUTES;
  delete process.env.WM_LIVENESS_VERIFY_MINUTES;
  delete process.env.WM_LIVENESS_SHIP_MINUTES;
  delete process.env.WM_LIVENESS_DEFAULT_MINUTES;
  Object.assign(process.env, {
    WORKFLOW_MANAGER_ARN: "arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/wm-test",
    EVENTS_TABLE: "test-events",
    WORKFLOWS_TABLE: "test-workflows",
    ...env,
  });
  return import("./index.mjs");
}

const iso = (ms) => new Date(ms).toISOString();
const ev = (ticketId, tsMs, type = "agent.streaming") => ({ type, timestamp: iso(tsMs), detail: { ticketId } });

/** A fake DynamoDB Query page: real Limit + ExclusiveStartKey pagination over `items`. */
function pagedSend(items) {
  return vi.fn(async (cmd) => {
    const { Limit, ExclusiveStartKey } = cmd.input;
    const start = ExclusiveStartKey?.idx ?? 0;
    const page = items.slice(start, start + Limit);
    const nextIdx = start + Limit;
    return { Items: page, LastEvaluatedKey: nextIdx < items.length ? { idx: nextIdx } : undefined };
  });
}

describe("recentEventsPaged — stop conditions", () => {
  it("stops at page 1 when every active ticket already has a sample", async () => {
    const mod = await loadIndex();
    const now = Date.parse("2026-09-06T12:00:00Z");
    const items = [ev("T-1", now - 1_000), ev("T-2", now - 2_000), ev("T-1", now - 3_000)];
    h.send = pagedSend(items);

    const win = await mod.recentEventsPaged({
      workflowId: "wf1", activeTicketIds: ["T-1", "T-2"], nowMs: now, maxThresholdMs: 45 * 60_000,
    });

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(win.pages).toBe(1);
    expect(win.truncated).toBe(false);
    expect(win.missing).toEqual([]);
    expect(win.events).toEqual(items);
  });

  it("pages again when a sibling lacks a sample and stops as soon as it has one", async () => {
    const mod = await loadIndex();
    const now = Date.parse("2026-09-06T12:00:00Z");
    const page1 = Array.from({ length: 50 }, (_, i) => ev("T-loud", now - i * 1_000)); // no T-quiet row
    const page2 = [ev("T-quiet", now - 51_000), ev("T-quiet", now - 52_000)];
    const items = [...page1, ...page2];
    h.send = pagedSend(items);

    const win = await mod.recentEventsPaged({
      workflowId: "wf1", activeTicketIds: ["T-loud", "T-quiet"], nowMs: now, maxThresholdMs: 45 * 60_000,
    });

    expect(h.send).toHaveBeenCalledTimes(2); // stopped the moment T-quiet's row was read
    expect(h.send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ idx: 50 });
    expect(win.pages).toBe(2);
    expect(win.truncated).toBe(false);
    expect(win.missing).toEqual([]);
    expect(win.events).toHaveLength(52);
  });

  it("stops at MAX_EVENT_PAGES with truncated:true and windowFloorMs = the oldest row actually read", async () => {
    const mod = await loadIndex();
    const now = Date.parse("2026-09-06T12:00:00Z");
    // 600 rows all T-loud, 1s apart — T-quiet NEVER appears, and even the 500th
    // (oldest read under the cap, ~8.3min back) stays inside the 45-min horizon,
    // so satisfied-by-floor cannot fire either: the ONLY way out is the hard cap.
    const items = Array.from({ length: 600 }, (_, i) => ev("T-loud", now - i * 1_000));
    h.send = pagedSend(items);

    const win = await mod.recentEventsPaged({
      workflowId: "wf1", activeTicketIds: ["T-loud", "T-quiet"], nowMs: now, maxThresholdMs: 45 * 60_000,
    });

    expect(h.send).toHaveBeenCalledTimes(mod.MAX_EVENT_PAGES);
    expect(win.pages).toBe(mod.MAX_EVENT_PAGES);
    expect(win.truncated).toBe(true);
    expect(win.missing).toEqual(["T-quiet"]);
    const rowsRead = mod.MAX_EVENT_PAGES * mod.LIVENESS_EVENT_PAGE;
    expect(win.events).toHaveLength(rowsRead);
    expect(win.windowFloorMs).toBe(now - (rowsRead - 1) * 1_000); // the oldest row READ, not the oldest in the table
  });

  it("stops early when the oldest row already predates now - maxThresholdMs (a starved sibling is already decided)", async () => {
    const mod = await loadIndex();
    const now = Date.parse("2026-09-06T12:00:00Z");
    const maxThresholdMs = 45 * 60_000;
    // page1's oldest row (index 49) sits 49*56s = 45.73min back — already past the
    // horizon — even though MUCH more data sits behind it (a real LastEvaluatedKey),
    // so a stop here can only be the floor check, never mere exhaustion.
    const page1 = Array.from({ length: 50 }, (_, i) => ev("T-loud", now - i * 56_000));
    const rest = Array.from({ length: 50 }, (_, i) => ev("T-loud", now - (50 + i) * 56_000));
    const items = [...page1, ...rest];
    h.send = pagedSend(items);

    const win = await mod.recentEventsPaged({
      workflowId: "wf1", activeTicketIds: ["T-loud", "T-quiet"], nowMs: now, maxThresholdMs,
    });

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(win.pages).toBe(1);
    expect(win.truncated).toBe(false); // decided, not capped
    expect(win.missing).toEqual(["T-quiet"]);
    expect(win.windowFloorMs).toBe(now - 49 * 56_000);
  });
});

describe("recentEventsPaged — the F6 leak guard and the off-mode pre-epic read", () => {
  it("legacyWindow is EXACTLY page1.slice(0, LEGACY_EVENT_WINDOW) even after the read pages deeper", async () => {
    const mod = await loadIndex();
    const now = Date.parse("2026-09-06T12:00:00Z");
    const page1 = Array.from({ length: 50 }, (_, i) => ev("T-loud", now - i * 1_000));
    const page2 = [ev("T-quiet", now - 51_000)];
    const items = [...page1, ...page2];
    h.send = pagedSend(items);

    const win = await mod.recentEventsPaged({
      workflowId: "wf1", activeTicketIds: ["T-loud", "T-quiet"], nowMs: now, maxThresholdMs: 45 * 60_000,
    });

    expect(win.pages).toBe(2); // the deeper read DID happen
    expect(win.legacyWindow).toEqual(page1.slice(0, LEGACY_EVENT_WINDOW));
    expect(win.legacyWindow).toHaveLength(LEGACY_EVENT_WINDOW);
  });

  it("off mode issues ONE Query with Limit 25 and does not page even when more data is available", async () => {
    const mod = await loadIndex({ WM_LIVENESS_MODE: "off" });
    const now = Date.parse("2026-09-06T12:00:00Z");
    const items = Array.from({ length: 40 }, (_, i) => ev("T-1", now - i * 1_000)); // more than 25 available
    h.send = pagedSend(items);

    const win = await mod.recentEventsPaged({
      workflowId: "wf1", activeTicketIds: [], nowMs: now, maxThresholdMs: 45 * 60_000,
    });

    expect(h.send).toHaveBeenCalledTimes(1);
    const input = h.send.mock.calls[0][0].input;
    expect(input.Limit).toBe(LEGACY_EVENT_WINDOW);
    expect(input.ExclusiveStartKey).toBeUndefined();
    expect(win.pages).toBe(1);
    expect(win.truncated).toBe(false);
    expect(win.events).toHaveLength(LEGACY_EVENT_WINDOW);
    expect(win.legacyWindow).toEqual(items.slice(0, LEGACY_EVENT_WINDOW));
  });

  it("every Query — across a multi-page read — keeps the exact pre-epic shape (IAM unchanged)", async () => {
    const mod = await loadIndex();
    const now = Date.parse("2026-09-06T12:00:00Z");
    const items = Array.from({ length: 120 }, (_, i) => ev("T-loud", now - i * 1_000)); // 3 pages, all T-loud
    h.send = pagedSend(items);

    await mod.recentEventsPaged({
      workflowId: "wf1", activeTicketIds: ["T-loud", "T-quiet"], nowMs: now, maxThresholdMs: 45 * 60_000,
    });

    expect(h.send.mock.calls.length).toBeGreaterThan(1); // exercises more than one Query
    for (const [cmd] of h.send.mock.calls) {
      expect(cmd.input.TableName).toBe(process.env.EVENTS_TABLE);
      expect(cmd.input.KeyConditionExpression).toBe("workflowId = :w");
      expect(cmd.input.ScanIndexForward).toBe(false);
      expect(cmd.input.FilterExpression).toBeUndefined();
      expect(cmd.input.IndexName).toBeUndefined();
      expect(cmd.input.ProjectionExpression).toBeUndefined();
    }
  });
});
