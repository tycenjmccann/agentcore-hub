import { describe, it, expect, vi } from "vitest";
import {
  createShipFixPark,
  resolveReviewerTicket,
  openFixSiblings,
  normalizeShipFixParkMode,
} from "./ship-fix-park.mjs";

/**
 * Ship-review parking: a dispatched `ship_fix` parks the Ship ticket it answers
 * to Blocked on every open ship_fix in the run, releases the release manager's
 * stale claim, and leaves everything else alone. Shapes mirror the real
 * TEAM-4243 round-2 board (Jira mode: no origin: label, phase:ship on fixes).
 */

const PHASES = {
  agentcore_hub_release_manager: "ship",
  agentcore_hub_backend_dev: "development",
  agentcore_hub_ci_agent: "development",
  agentcore_hub_qa_verifier: "qa",
};
const getAgentPhase = (a) => PHASES[a];

const t = (ticketId, assignee, status, extra = {}) => ({ ticketId, assignee, status, blockedBy: [], type: "task", parentId: "TEAM-4243", ...extra });

// Real TEAM-4243 shape, mid round 2: RM parked in_progress, CD behind Merge Approval.
function board() {
  return [
    t("TEAM-4252", "agentcore_hub_ci_agent", "done"),
    t("TEAM-4253", "agentcore_hub_release_manager", "in_progress", { blockedBy: ["TEAM-4252"] }),
    t("TEAM-4254", "human:engineer", "blocked", { blockedBy: ["TEAM-4253"] }),
    t("TEAM-4255", "agentcore_hub_release_manager", "blocked", { blockedBy: ["TEAM-4254"] }),
    t("TEAM-4279", "agentcore_hub_backend_dev", "done", { spawnedBy: { kind: "ship_fix" }, phase: "ship" }),
    t("TEAM-4285", "agentcore_hub_backend_dev", "ready", { spawnedBy: { kind: "ship_fix" }, phase: "ship" }),
    t("TEAM-4292", "agentcore_hub_ci_agent", "blocked", { spawnedBy: { kind: "ship_fix" }, phase: "ship", blockedBy: ["TEAM-4285"] }),
    t("TEAM-4264", "agentcore_hub_backend_dev", "done", { spawnedBy: { kind: "codex_fix" }, phase: "development" }),
  ];
}
const fix = () => board().find((x) => x.ticketId === "TEAM-4285");

describe("normalizeShipFixParkMode", () => {
  it("defaults to enforce; only 'off' disarms", () => {
    expect(normalizeShipFixParkMode(undefined)).toBe("enforce");
    expect(normalizeShipFixParkMode("")).toBe("enforce");
    expect(normalizeShipFixParkMode("garbage")).toBe("enforce");
    expect(normalizeShipFixParkMode(" OFF ")).toBe("off");
  });
});

describe("resolveReviewerTicket", () => {
  it("prefers the explicit origin when the fix carries one", () => {
    const f = { ...fix(), spawnedBy: { kind: "ship_fix", shipTicketId: "TEAM-4253" } };
    expect(resolveReviewerTicket({ fixTicket: f, siblings: board(), getAgentPhase })).toMatchObject({ via: "origin", ticket: { ticketId: "TEAM-4253" } });
  });
  it("falls back to the one open non-fix agent ticket in the fix's phase, excluding tickets behind a human gate", () => {
    const r = resolveReviewerTicket({ fixTicket: fix(), siblings: board(), getAgentPhase });
    expect(r).toMatchObject({ via: "phase", ticket: { ticketId: "TEAM-4253" } });
  });
  it("still resolves after the sweep flipped the Ship ticket to todo", () => {
    const s = board().map((x) => (x.ticketId === "TEAM-4253" ? { ...x, status: "todo" } : x));
    expect(resolveReviewerTicket({ fixTicket: fix(), siblings: s, getAgentPhase })?.ticket.ticketId).toBe("TEAM-4253");
  });
  it("returns null when the fix has no phase and no origin", () => {
    expect(resolveReviewerTicket({ fixTicket: { ...fix(), phase: undefined }, siblings: board(), getAgentPhase })).toBeNull();
  });
  it("returns null when two candidates tie (ambiguous)", () => {
    const s = [...board(), t("TEAM-9999", "agentcore_hub_release_manager", "in_progress")];
    expect(resolveReviewerTicket({ fixTicket: fix(), siblings: s, getAgentPhase })).toBeNull();
  });
  it("returns null when the reviewer is already done", () => {
    const s = board().map((x) => (x.ticketId === "TEAM-4253" ? { ...x, status: "done" } : x));
    expect(resolveReviewerTicket({ fixTicket: fix(), siblings: s, getAgentPhase })).toBeNull();
  });
});

describe("openFixSiblings", () => {
  it("lists every other open ship_fix in the phase — including the Blocked CI re-cert — and nothing else", () => {
    expect(openFixSiblings({ reviewerId: "TEAM-4253", fixTicket: fix(), siblings: board() })).toEqual(["TEAM-4292"]);
  });
  it("skips a ship_fix that names a different origin", () => {
    const s = [...board(), t("TEAM-8888", "agentcore_hub_backend_dev", "ready", { spawnedBy: { kind: "ship_fix", shipTicketId: "TEAM-0001" }, phase: "ship" })];
    expect(openFixSiblings({ reviewerId: "TEAM-4253", fixTicket: fix(), siblings: s })).toEqual(["TEAM-4292"]);
  });
});

function harness(overrides = {}) {
  const calls = { addBlockers: [], releaseClaim: [], events: [] };
  const park = createShipFixPark({
    getChildTickets: vi.fn(async () => board()),
    addBlockers: vi.fn(async (id, ids) => { calls.addBlockers.push([id, ids]); return ids; }),
    releaseClaim: vi.fn(async (wf, id) => { calls.releaseClaim.push([wf, id]); }),
    publishEvent: vi.fn(async (id, type, detail) => { calls.events.push([id, type, detail]); }),
    getAgentPhase,
    log: { log() {}, warn() {} },
    ...overrides,
  });
  return { park, calls };
}

describe("createShipFixPark.onFixReady", () => {
  it("parks the Ship ticket on the fix + the open CI re-cert, releases the claim, publishes once", async () => {
    const { park, calls } = harness();
    const r = await park.onFixReady({ workflow: { id: "wf_1", epicId: "TEAM-4243" }, fixTicket: fix() });
    expect(r).toMatchObject({ action: "parked", reviewerId: "TEAM-4253", via: "phase", blockers: ["TEAM-4285", "TEAM-4292"], claimReleased: true });
    expect(calls.addBlockers).toEqual([["TEAM-4253", ["TEAM-4285", "TEAM-4292"]]]);
    expect(calls.releaseClaim).toEqual([["wf_1", "TEAM-4253"]]);
    expect(calls.events).toHaveLength(1);
    expect(calls.events[0][1]).toBe("orchestrator.ship_review_parked");
  });
  it("re-parks (idempotently) when the edge already exists but the reviewer sits in_progress", async () => {
    const s = board().map((x) => (x.ticketId === "TEAM-4253" ? { ...x, blockedBy: ["TEAM-4252", "TEAM-4285", "TEAM-4292"] } : x));
    const { park, calls } = harness({ getChildTickets: vi.fn(async () => s) });
    const r = await park.onFixReady({ workflow: { id: "wf_1" }, fixTicket: fix() });
    expect(r.action).toBe("parked");
    expect(calls.addBlockers).toEqual([["TEAM-4253", ["TEAM-4285", "TEAM-4292"]]]);
  });
  it("ignores non-ship fixes and a Done reviewer", async () => {
    const { park, calls } = harness();
    expect((await park.onFixReady({ workflow: { id: "wf_1" }, fixTicket: board().find((x) => x.ticketId === "TEAM-4264") })).action).toBe("skip");
    const done = board().map((x) => (x.ticketId === "TEAM-4253" ? { ...x, status: "done" } : x));
    const h2 = harness({ getChildTickets: vi.fn(async () => done) });
    expect((await h2.park.onFixReady({ workflow: { id: "wf_1" }, fixTicket: fix() })).reason).toBe("no-reviewer");
    expect(calls.addBlockers).toEqual([]);
  });
  it("mode off is a no-op; a throwing dependency never escapes", async () => {
    const off = harness({ mode: "off" });
    expect((await off.park.onFixReady({ workflow: { id: "wf_1" }, fixTicket: fix() })).reason).toBe("mode-off");
    const boom = harness({ addBlockers: vi.fn(async () => { throw new Error("jira 500"); }) });
    const r = await boom.park.onFixReady({ workflow: { id: "wf_1" }, fixTicket: fix() });
    expect(r).toMatchObject({ action: "error", error: "jira 500" });
  });
  it("a failed claim release is reported, not fatal", async () => {
    const { park } = harness({ releaseClaim: vi.fn(async () => { throw new Error("no task entry"); }) });
    const r = await park.onFixReady({ workflow: { id: "wf_1" }, fixTicket: fix() });
    expect(r).toMatchObject({ action: "parked", claimReleased: false });
  });
});
