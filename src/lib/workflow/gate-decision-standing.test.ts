import { describe, it, expect, vi } from "vitest";
import { humanGateDecidedDone, nudgeBlockerResolved, type GateStandingDeps } from "./gate-decision-standing";
import { liveGateOf } from "./gate-decision-record";
import { buildGateDecisionRecord } from "../../../lambda/agentcore-hub-tickets/gate-contract.mjs";

/**
 * TEAM-5395 F6 — a done human gate resolves its dependents (here: for the nudge
 * route) only when its signed v3 gate decision stands with status "done". Every
 * failure fails closed: no key, no record, unreadable record, get_issue refused.
 */
const KEY = "gate-standing-test-key";
const WF = "wf_1";
const G = "G-1";
const RECORD_KEY = `pipeline-artifacts/gate-decisions/${WF}/gates/${G}.json`;
const record = (option = "approve", p: Record<string, unknown> = {}) =>
  buildGateDecisionRecord({ ticketId: G, workflowId: WF, decision: { option, channel: "console", by: "human:ops" }, labels: [], cycle: null, ...p }, KEY);

function deps(objects: Record<string, unknown>, gateCycle: string | null = null, over: Partial<GateStandingDeps> = {}) {
  const readJson = vi.fn(async (k: string) => objects[k] ?? null);
  const live = vi.fn(async (id: string) => liveGateOf({ key: id, fields: { description: "" }, gateCycle }));
  const keys = vi.fn(async () => ({ ok: true as const, keys: [KEY] }));
  return { readJson, live, keys, ...over };
}

describe("humanGateDecidedDone", () => {
  it("a signed approve in the current cycle → true", async () => {
    expect(await humanGateDecidedDone(G, WF, deps({ [RECORD_KEY]: record() }))).toBe(true);
  });

  it("no record (the webhook's reopen-failed Done) → false, and the live gate is never read", async () => {
    const d = deps({});
    expect(await humanGateDecidedDone(G, WF, d)).toBe(false);
    expect(d.live).not.toHaveBeenCalled();
  });

  it.each([
    ["a stale cycle", deps({ [RECORD_KEY]: record() }, "2026-10-06T00:00:00.000Z")],
    ["a signed stop (status cancelled)", deps({ [RECORD_KEY]: record("stopped") })],
    ["a forged sig", deps({ [RECORD_KEY]: { ...record(), sig: "AAAA" } })],
    ["another run's record", deps({ [RECORD_KEY]: record("approve", { workflowId: "wf_other" }) })],
    ["key unavailable", deps({ [RECORD_KEY]: record() }, null, { keys: async () => ({ ok: false as const, detail: "no secret" }) })],
    ["key loader throws", deps({ [RECORD_KEY]: record() }, null, { keys: async () => { throw new Error("SM down"); } })],
    ["S3 read throws", deps({}, null, { readJson: async () => { throw new Error("AccessDenied"); } })],
    ["get_issue refused", deps({ [RECORD_KEY]: record() }, null, { live: async () => null })],
    ["get_issue throws", deps({ [RECORD_KEY]: record() }, null, { live: async () => { throw new Error("boom"); } })],
  ])("%s → false", async (_n, d) => {
    expect(await humanGateDecidedDone(G, WF, d)).toBe(false);
  });

  it("no workflowId → false without reading anything", async () => {
    const d = deps({ [RECORD_KEY]: record() });
    expect(await humanGateDecidedDone(G, "", d)).toBe(false);
    expect(d.readJson).not.toHaveBeenCalled();
  });
});

describe("nudgeBlockerResolved", () => {
  it("a done agent ticket resolves with no record read", async () => {
    const d = deps({});
    expect(await nudgeBlockerResolved({ ticketId: "T-1", status: "done", assignee: "dev" }, WF, d)).toBe(true);
    expect(d.readJson).not.toHaveBeenCalled();
  });

  it("a done human gate (assignee or reviewer: label) resolves only on a standing decision", async () => {
    for (const gate of [{ ticketId: G, status: "done", assignee: "human:ops" }, { ticketId: G, status: "done", labels: ["reviewer:ops"] }]) {
      expect(await nudgeBlockerResolved(gate, WF, deps({}))).toBe(false);
      expect(await nudgeBlockerResolved(gate, WF, deps({ [RECORD_KEY]: record() }))).toBe(true);
    }
  });

  it("missing, open, or cancelled blockers never resolve", async () => {
    const d = deps({ [RECORD_KEY]: record() });
    expect(await nudgeBlockerResolved(undefined, WF, d)).toBe(false);
    expect(await nudgeBlockerResolved({ ticketId: "T-1", status: "in_progress", assignee: "dev" }, WF, d)).toBe(false);
    expect(await nudgeBlockerResolved({ ticketId: G, status: "cancelled", assignee: "human:ops" }, WF, d)).toBe(false);
    expect(await nudgeBlockerResolved({ ticketId: G, status: "in_review", assignee: "human:ops" }, WF, d)).toBe(false);
  });
});
