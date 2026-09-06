import { describe, it, expect, beforeEach } from "vitest";
import {
  createReworkLoopCap,
  normalizeReworkLoopMode,
  isReworkFix,
  effectiveReworkRounds,
  lineageKey,
  emitReworkLoopMetrics,
  REWORK_LOOP_CAP_DEFAULT_MAX,
} from "./rework-loop-cap.mjs";

/**
 * TEAM-4113 — rework-loop cap. The lineage-keyed backstop the per-gate
 * review-cap can't provide: it counts fix tickets PER (workflow, phase), so a
 * loop that hops to fresh ticket ids still accumulates. Fail-safe direction is
 * the inverse of the ship gates — an unknown mode falls to SHADOW (observe),
 * never off, because a silent unbounded loop is the dangerous failure.
 */

// ── In-memory fake store keyed by lineage ────────────────────────────────────
function makeStore(seed = {}) {
  const ledgers = JSON.parse(JSON.stringify(seed));
  const seedLedger = (k) => (ledgers[k] ||= { rounds: [], authorizations: [], escalations: [] });
  return {
    ledgers,
    calls: { round: 0, esc: 0, auth: 0 },
    _fail: false,
    async appendReworkRound(_wf, k, r) {
      this.calls.round++;
      if (this._fail) throw new Error("ledger unwritable");
      seedLedger(k).rounds.push(r);
      return JSON.parse(JSON.stringify(ledgers[k]));
    },
    async appendReworkEscalation(_wf, k, e) { this.calls.esc++; seedLedger(k).escalations.push(e); },
    async appendReworkAuthorization(_wf, k, a) { this.calls.auth++; seedLedger(k).authorizations.push(a); },
  };
}

const fixTicket = (id, phase = "development", kind = "qa_fix") => ({
  ticketId: id, assignee: "agentcore_hub_backend_dev", phase, spawnedBy: { kind },
});
const wf = (id = "wf_1", reworkLineage = {}) => ({ id, epicId: "TEAM-1", reworkLineage });

function makeCap(mode, storeOverride, extra = {}) {
  const events = [];
  const metrics = [];
  const parks = [];
  const store = storeOverride || makeStore();
  const cap = createReworkLoopCap({
    store,
    publishEvent: async (tid, name, detail) => { events.push({ tid, name, detail }); },
    parkRunEscalationGate: async (workflow, phase) => { parks.push({ workflow, phase }); return true; },
    emitMetrics: (c) => metrics.push(c),
    mode,
    now: () => new Date("2026-09-05T00:00:00Z"),
    maxRounds: 3,
    ...extra,
  });
  return { cap, store, events, metrics, parks };
}

describe("normalizeReworkLoopMode — fail-safe to SHADOW (opposite of ship gates)", () => {
  it("passes off|shadow|enforce", () => {
    expect(normalizeReworkLoopMode("off")).toBe("off");
    expect(normalizeReworkLoopMode("shadow")).toBe("shadow");
    expect(normalizeReworkLoopMode(" ENFORCE ")).toBe("enforce");
  });
  it("legacy truthy → enforce", () => {
    for (const v of ["on", "true", "1", "yes", "enabled"]) expect(normalizeReworkLoopMode(v)).toBe("enforce");
  });
  it("garbage / empty / null / undefined → shadow (never silently off)", () => {
    for (const v of ["", "  ", "xyzzy", null, undefined, "0", "false"]) expect(normalizeReworkLoopMode(v)).toBe("shadow");
  });
});

describe("isReworkFix", () => {
  it("true only for a fix kind", () => {
    expect(isReworkFix({ spawnedBy: { kind: "qa_fix" } })).toBe(true);
    expect(isReworkFix({ spawnedBy: { kind: "review_fix" } })).toBe(true);
    expect(isReworkFix({ spawnedBy: { kind: "codex_fix" } })).toBe(true);
  });
  it("false for a normal ticket / gate spawn / missing", () => {
    expect(isReworkFix({})).toBe(false);
    expect(isReworkFix({ spawnedBy: { kind: "ship_ticket" } })).toBe(false);
    expect(isReworkFix({ spawnedBy: {} })).toBe(false);
    expect(isReworkFix(null)).toBe(false);
  });
  it("honors a custom fixKinds set", () => {
    expect(isReworkFix({ spawnedBy: { kind: "qa_fix" } }, new Set(["review_fix"]))).toBe(false);
  });

  // TEAM-4121 FR-8 — the six-kind roster reaches this default set as FOUR: the
  // two environmental kinds are excluded on purpose (below).
  it("false for a re-verification or a re-arm (the same finding, not a new round)", () => {
    expect(isReworkFix({ spawnedBy: { kind: "qa_fix", reverify: true } })).toBe(false);
    expect(isReworkFix({ spawnedBy: { kind: "qa_fix", rearmOf: "TEAM-9" } })).toBe(false);
  });

  it("false for the environmental kinds ci_fix / sync_fix", () => {
    // These are filed by the CI agent off a red build or an unmergeable branch,
    // not off a human's rejection of the work. They still gate completion (see
    // completion.mjs FIX_KINDS), but counting them here would escalate a run to a
    // human for what is a flaky pipeline or a moved base branch.
    expect(isReworkFix({ spawnedBy: { kind: "ci_fix", ciTicketId: "TEAM-70" } })).toBe(false);
    expect(isReworkFix({ spawnedBy: { kind: "sync_fix", ciTicketId: "TEAM-70" } })).toBe(false);
  });

  it("true for ship_fix (a human reviewer's rejection of the final diff)", () => {
    expect(isReworkFix({ spawnedBy: { kind: "ship_fix", shipTicketId: "TEAM-50" } })).toBe(true);
  });
});

describe("effectiveReworkRounds", () => {
  it("counts DISTINCT ticket ids (a re-Done isn't a new round)", () => {
    expect(effectiveReworkRounds({ rounds: [{ ticketId: "A" }, { ticketId: "A" }, { ticketId: "B" }] })).toBe(2);
  });
  it("subtracts the last authorization's reset baseline", () => {
    const ledger = {
      rounds: [{ ticketId: "A" }, { ticketId: "B" }, { ticketId: "C" }, { ticketId: "D" }],
      authorizations: [{ resetAtRound: 3 }],
    };
    expect(effectiveReworkRounds(ledger)).toBe(1); // 4 distinct - 3
  });
  it("empty / undefined ledger → 0", () => {
    expect(effectiveReworkRounds(null)).toBe(0);
    expect(effectiveReworkRounds({})).toBe(0);
  });
});

describe("observe — applicability (cheap short-circuits, no store writes)", () => {
  it("off → disabled, zero store calls", async () => {
    const { cap, store } = makeCap("off");
    expect(await cap.observe({ workflow: wf(), ticket: fixTicket("F1"), phase: "development" })).toEqual({ action: "disabled" });
    expect(store.calls.round).toBe(0);
  });
  it("non-fix ticket → not-a-fix, zero store calls", async () => {
    const { cap, store } = makeCap("enforce");
    const r = await cap.observe({ workflow: wf(), ticket: { ticketId: "T", spawnedBy: { kind: "ship_ticket" } }, phase: "ship" });
    expect(r.action).toBe("not-a-fix");
    expect(store.calls.round).toBe(0);
  });
  it("no resolvable phase → no-phase (fail-safe, uncounted)", async () => {
    const { cap, store } = makeCap("enforce");
    const r = await cap.observe({ workflow: wf(), ticket: fixTicket("F1", undefined), phase: undefined });
    expect(r.action).toBe("no-phase");
    expect(store.calls.round).toBe(0);
  });
});

describe("observe — shadow (measure only)", () => {
  it("records rounds and, at the cap, WOULD-caps without any event", async () => {
    const { cap, events, metrics } = makeCap("shadow");
    const w = wf();
    expect((await cap.observe({ workflow: w, ticket: fixTicket("F1"), phase: "development" })).action).toBe("recorded");
    expect((await cap.observe({ workflow: w, ticket: fixTicket("F2"), phase: "development" })).action).toBe("recorded");
    const third = await cap.observe({ workflow: w, ticket: fixTicket("F3"), phase: "development" });
    expect(third.action).toBe("would-cap");
    expect(third.rounds).toBe(3);
    expect(events).toEqual([]); // shadow never signals
    expect(metrics).toContain("wouldCap");
    expect(metrics).not.toContain("capReached");
  });
});

describe("observe — enforce (signal + best-effort park, never blocks)", () => {
  it("trips at the cap: publishes rework.cap_reached, persists escalation, parks", async () => {
    const { cap, store, events, metrics, parks } = makeCap("enforce");
    const w = wf();
    await cap.observe({ workflow: w, ticket: fixTicket("F1"), phase: "development" });
    await cap.observe({ workflow: w, ticket: fixTicket("F2"), phase: "development" });
    const third = await cap.observe({ workflow: w, ticket: fixTicket("F3"), phase: "development" });
    expect(third.action).toBe("capped");
    expect(third.rounds).toBe(3);
    expect(third.parked).toBe(true);
    expect(store.calls.esc).toBe(1);
    const capEvt = events.find((e) => e.name === "rework.cap_reached");
    expect(capEvt).toBeTruthy();
    expect(capEvt.detail).toMatchObject({ workflowId: "wf_1", lineageKey: "wf_1:development", phase: "development", rounds: 3, max: 3 });
    expect(metrics).toContain("capReached");
    expect(parks).toHaveLength(1);
  });

  it("is idempotent — a 4th fix-done re-reads the open escalation, no second signal", async () => {
    const store = makeStore();
    const { cap, events } = makeCap("enforce", store);
    const w = wf();
    for (const id of ["F1", "F2", "F3"]) await cap.observe({ workflow: w, ticket: fixTicket(id), phase: "development" });
    const fourth = await cap.observe({ workflow: w, ticket: fixTicket("F4"), phase: "development" });
    expect(fourth.action).toBe("still-escalated");
    expect(events.filter((e) => e.name === "rework.cap_reached")).toHaveLength(1);
    expect(store.calls.esc).toBe(1);
  });

  it("distinct phases in one run are counted independently (lineage keying)", async () => {
    const { cap } = makeCap("enforce");
    const w = wf();
    // dev loop reaches the cap; a lone QA fix must NOT be dragged over the cap.
    for (const id of ["D1", "D2", "D3"]) await cap.observe({ workflow: w, ticket: fixTicket(id, "development"), phase: "development" });
    const qa = await cap.observe({ workflow: w, ticket: fixTicket("Q1", "verification"), phase: "verification" });
    expect(qa.action).toBe("recorded");
    expect(qa.rounds).toBe(1);
  });
});

describe("observe — human DECISION: continue override (parity with review-cap)", () => {
  it("resets the count when an escalation is open and feedback authorizes continue", async () => {
    const key = lineageKey("wf_1", "development");
    // Pre-seed an OPEN escalation at round 3.
    const seed = { [key]: { rounds: [{ ticketId: "F1" }, { ticketId: "F2" }, { ticketId: "F3" }], authorizations: [], escalations: [{ escalatedAtRound: 3, decision: null }] } };
    const store = makeStore(seed);
    const { cap, events, metrics } = makeCap("enforce", store);
    const w = wf("wf_1", store.ledgers);
    const r = await cap.observe({ workflow: w, ticket: fixTicket("F4"), phase: "development", feedback: "looks good now\nDECISION: continue" });
    expect(r.action).toBe("authorized");
    expect(r.resetAtRound).toBe(3);
    expect(store.calls.auth).toBe(1);
    expect(events.find((e) => e.name === "rework.cap_authorized")).toBeTruthy();
    expect(metrics).toContain("authorized");
  });

  it("a bare 'looks fine' is NOT an override — stays escalated", async () => {
    const key = lineageKey("wf_1", "development");
    const seed = { [key]: { rounds: [{ ticketId: "F1" }, { ticketId: "F2" }, { ticketId: "F3" }], authorizations: [], escalations: [{ escalatedAtRound: 3, decision: null }] } };
    const store = makeStore(seed);
    const { cap } = makeCap("enforce", store);
    const w = wf("wf_1", store.ledgers);
    const r = await cap.observe({ workflow: w, ticket: fixTicket("F4"), phase: "development", feedback: "looks fine keep going" });
    expect(r.action).toBe("still-escalated");
    expect(store.calls.auth).toBe(0);
  });
});

describe("observe — fail-open on ledger failure (never blocks the cascade)", () => {
  it("ledger write throws → ledger-failed + failOpen metric, no throw", async () => {
    const store = makeStore(); store._fail = true;
    const { cap, metrics } = makeCap("enforce", store);
    const r = await cap.observe({ workflow: wf(), ticket: fixTicket("F1"), phase: "development" });
    expect(r.action).toBe("ledger-failed");
    expect(metrics).toContain("failOpen");
  });
  it("row gone (store returns null) → ledger-missing, count not invented", async () => {
    const store = { async appendReworkRound() { return null; } };
    const { cap } = makeCap("enforce", store);
    const r = await cap.observe({ workflow: wf(), ticket: fixTicket("F1"), phase: "development" });
    expect(r.action).toBe("ledger-missing");
  });
});

describe("emitReworkLoopMetrics — EMF shape", () => {
  it("emits one record with the requested counter set to 1", () => {
    const calls = [];
    const spy = console.log; console.log = (s) => calls.push(s);
    try { emitReworkLoopMetrics("capReached", () => 999); } finally { console.log = spy; }
    const rec = JSON.parse(calls[0]);
    expect(rec._aws.Timestamp).toBe(999);
    expect(rec.ReworkLoopCapReached).toBe(1);
    expect(rec.ReworkLoopRound).toBe(0);
    expect(rec._aws.CloudWatchMetrics[0].Namespace).toBe("AgentCoreHub/Orchestrator");
  });
});

describe("defaults", () => {
  it("lineage cap default is 4 (one above the per-gate review-cap default)", () => {
    expect(REWORK_LOOP_CAP_DEFAULT_MAX).toBe(4);
  });
});
