import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createReviewCap,
  resolveReviewGateCap,
  buildRoundRecord,
  fingerprintFinding,
  roundContentFingerprint,
  parseDecision,
  openEscalation,
  REVIEW_GATE_CAP_DEFAULTS,
  REVIEW_GATE_MAX_ROUNDS_CEILING,
  REVIEW_CAP_FAIL_OPEN_LIMIT,
} from "./review-cap.mjs";

/**
 * TEAM-3619 D2c — the review→rework loop is bounded.
 *
 * These tests pin the contract handleReviewRejection depends on: below the cap
 * the caller re-opens as before; at the cap it must NOT (the `escalated` flag is
 * the caller's instruction to skip its re-open loop), the gate goes to a human,
 * and review.cap_reached fires exactly once per escalation. AC-D2.2a is the
 * config test: moving maxRounds moves the trip point.
 */

const NOW = Date.parse("2026-09-01T12:00:00Z");
const NOW_ISO = new Date(NOW).toISOString();
const GATE = "TEAM-900"; // the Merge Approval gate ticket
const SHIP_GATE = {
  afterPhase: "ship",
  name: "Merge Approval",
  reviewerRole: "Code Owner",
  assignee: "human:engineer",
  onReject: "rework",
  maxRounds: 3,
  regressionCountsDouble: true,
  onCapReached: "escalate",
};

/** A ledger as the store would return it after the round append. */
function ledger({ rounds = [], authorizations = [], escalations = [] } = {}) {
  return { rounds, authorizations, escalations };
}

/**
 * The store stub behaves like the real appendReviewRound: it appends and returns
 * the POST-write ledger, which is what the module must compute from.
 */
function makeDeps(overrides = {}) {
  const state = overrides.ledger || ledger();
  const store = overrides.store || {
    appendReviewRound: vi.fn(async (_wfId, _gateId, round) => {
      state.rounds = [...state.rounds, round];
      return { ...state, rounds: state.rounds };
    }),
    appendReviewCapEscalation: vi.fn(async (_wfId, _gateId, e) => {
      state.escalations = [...state.escalations, e];
    }),
    appendReviewAuthorization: vi.fn(async (_wfId, _gateId, a) => {
      state.authorizations = [...state.authorizations, a];
    }),
  };
  const publishEvent = overrides.publishEvent || vi.fn(async () => {});
  const listReviewers = overrides.listReviewers || vi.fn(async () => []);
  const parkGateForHuman = overrides.parkGateForHuman || vi.fn(async () => {});
  const commentOnGate = overrides.commentOnGate || vi.fn(async () => true);
  const emitMetrics = overrides.emitMetrics || vi.fn(() => {});
  // The fail-open/fail-closed branch has its own emitter (TEAM-3685 Finding 2a);
  // stubbed here so a ledger failure never writes EMF to the test output.
  const emitFailOpenMetrics = overrides.emitFailOpenMetrics || vi.fn(() => {});
  const deps = {
    store,
    publishEvent,
    listReviewers,
    parkGateForHuman,
    commentOnGate,
    emitMetrics,
    emitFailOpenMetrics,
    ...(overrides.failOpenLimit !== undefined ? { failOpenLimit: overrides.failOpenLimit } : {}),
    now: () => new Date(NOW),
    log: () => {},
  };
  return {
    deps,
    state,
    store,
    publishEvent,
    listReviewers,
    parkGateForHuman,
    commentOnGate,
    emitMetrics,
    emitFailOpenMetrics,
  };
}

/**
 * A store stub whose appendReviewRound throws on demand — the ledger-failure
 * shape the fail-open/fail-closed backstop is built around. `failing()` is
 * consulted per call so a test can heal the ledger mid-sequence.
 */
function failingStore(failing) {
  const state = ledger();
  return {
    appendReviewRound: vi.fn(async (_wfId, _gateId, round) => {
      if (failing()) throw new Error("AccessDeniedException");
      state.rounds = [...state.rounds, round];
      return { ...state, rounds: state.rounds };
    }),
    appendReviewCapEscalation: vi.fn(async () => {}),
    appendReviewAuthorization: vi.fn(async () => {}),
  };
}

/** A workflow row whose gate ledger already holds `rounds`. */
function workflowWith(gateLedger) {
  return { id: "wf_1", reviewGateHistory: gateLedger ? { [GATE]: gateLedger } : {} };
}

/** A prior CHANGES-NEEDED round, optionally carrying a regression finding. */
function priorRound(round, { regression = false, fingerprint = `TEAM-1:${round}` } = {}) {
  return {
    round,
    reviewedHeadSha: null,
    verdict: "CHANGES-NEEDED",
    findings: [regression ? { fingerprint, regressionOf: { round: round - 1 } } : { fingerprint }],
  };
}

const call = (fn, type) => fn.mock.calls.filter((c) => c[1] === type);

beforeEach(() => vi.clearAllMocks());

describe("resolveReviewGateCap (.mjs twin)", () => {
  it("applies the 3 / true / escalate defaults to a bare gate", () => {
    expect(resolveReviewGateCap({ afterPhase: "ship" })).toEqual(REVIEW_GATE_CAP_DEFAULTS);
    // A missing gate config must not throw — an unconfigured gate still gets a
    // cap, which is the safe direction.
    expect(resolveReviewGateCap(null)).toEqual(REVIEW_GATE_CAP_DEFAULTS);
  });

  it("honors configured values, including regressionCountsDouble: false", () => {
    expect(resolveReviewGateCap({ maxRounds: 5, regressionCountsDouble: false })).toEqual({
      maxRounds: 5,
      regressionCountsDouble: false,
      onCapReached: "escalate",
    });
  });

  it("falls back to the default for a maxRounds that could disable the cap", () => {
    for (const bad of [0, -1, NaN, Infinity, "4", null, {}]) {
      expect(resolveReviewGateCap({ maxRounds: bad }).maxRounds).toBe(3);
    }
    expect(resolveReviewGateCap({ maxRounds: 4.7 }).maxRounds).toBe(4);
  });

  it("clamps a huge finite maxRounds to the ceiling instead of disabling the cap (TEAM-3685 Finding 3)", () => {
    // The lower guard caught 0/-1/NaN but honored 1e9 — a cap that never fires,
    // wearing a config that reads as deliberate.
    expect(REVIEW_GATE_MAX_ROUNDS_CEILING).toBe(20);
    expect(resolveReviewGateCap({ maxRounds: 1e9 }).maxRounds).toBe(20);
    expect(resolveReviewGateCap({ maxRounds: Number.MAX_SAFE_INTEGER }).maxRounds).toBe(20);
    expect(resolveReviewGateCap({ maxRounds: 21 }).maxRounds).toBe(20);
    expect(resolveReviewGateCap({ maxRounds: 20.9 }).maxRounds).toBe(20);
    // At and below the ceiling nothing changes.
    expect(resolveReviewGateCap({ maxRounds: 20 }).maxRounds).toBe(20);
    expect(resolveReviewGateCap({ maxRounds: 19 }).maxRounds).toBe(19);
    expect(resolveReviewGateCap({ maxRounds: 5 }).maxRounds).toBe(5);
    expect(resolveReviewGateCap({ maxRounds: 1 }).maxRounds).toBe(1);
    // Over-ceiling clamps DOWN — it does NOT fall back to the default 3.
    expect(resolveReviewGateCap({ maxRounds: 100 }).maxRounds).not.toBe(
      REVIEW_GATE_CAP_DEFAULTS.maxRounds
    );
  });

  it("a clamped cap actually trips at the ceiling end-to-end", async () => {
    // maxRounds: 1e9 must behave exactly like maxRounds: 20 — 19 prior rounds
    // proceed, the 20th escalates.
    const runAt = async (priorCount) => {
      const state = ledger({ rounds: Array.from({ length: priorCount }, (_, i) => priorRound(i + 1)) });
      const { deps } = makeDeps({ ledger: state });
      return createReviewCap(deps).enforce({
        workflow: workflowWith(state),
        gateTicket: { ticketId: GATE },
        gateCfg: { ...SHIP_GATE, maxRounds: 1e9 },
        upstreamIds: ["TEAM-1"],
        feedback: "changes needed",
      });
    };
    const under = await runAt(18);
    expect([under.effectiveRounds, under.maxRounds, under.escalated]).toEqual([19, 20, false]);
    const at = await runAt(19);
    expect([at.effectiveRounds, at.maxRounds, at.escalated]).toEqual([20, 20, true]);
  });
});

describe("enforce — below the cap", () => {
  it("records the round and lets the caller re-open (first rejection)", async () => {
    const { deps, publishEvent, parkGateForHuman, store } = makeDeps();
    const cap = createReviewCap(deps);

    const res = await cap.enforce({
      workflow: workflowWith(null),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "Missing null check in the parser.",
      reviewedHeadSha: null,
    });

    expect(res.escalated).toBe(false);
    expect(res.effectiveRounds).toBe(1);
    expect(res.round.round).toBe(1);
    expect(res.round.verdict).toBe("CHANGES-NEEDED");
    expect(store.appendReviewRound).toHaveBeenCalledWith("wf_1", GATE, res.round);
    expect(call(publishEvent, "review.cap_reached")).toHaveLength(0);
    expect(parkGateForHuman).not.toHaveBeenCalled();
  });

  it("is still below the cap on the round immediately before it", async () => {
    const state = ledger({ rounds: [priorRound(1)] });
    const { deps } = makeDeps({ ledger: state });
    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(state),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "Still wrong.",
    });
    expect(res.round.round).toBe(2);
    expect(res.effectiveRounds).toBe(2);
    expect(res.escalated).toBe(false);
  });

  it("emits an explicit zero escalation metric so silence ≠ health", async () => {
    const { deps, emitMetrics } = makeDeps();
    await createReviewCap(deps).enforce({
      workflow: workflowWith(null),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "nope",
    });
    expect(emitMetrics).toHaveBeenCalledTimes(1);
    expect(emitMetrics.mock.calls[0][0]).toMatchObject({
      gateTicketId: GATE,
      afterPhase: "ship",
      escalated: false,
      effectiveRounds: 1,
      maxRounds: 3,
    });
  });
});

describe("enforce — diff-scoped gate (TEAM-3689, release-manager.md Step 4)", () => {
  // The reviewer's classified findings, each carrying its cited files. When both
  // these and the PR change set reach enforce, an out-of-diff-only rejection is
  // non-gating: it records no round and does not re-open upstream work.
  const CHANGE_SET = ["src/a.ts", "src/b.ts"];

  it("AC3a: change set + mixed findings → gated, only the in-diff finding gates and the round is recorded", async () => {
    const { deps, store, parkGateForHuman, publishEvent } = makeDeps();
    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(null),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "Null deref in the new parser + a nit in a pre-existing helper.",
      changeSet: CHANGE_SET,
      findings: [
        { citedFiles: ["src/a.ts"] }, // IN-DIFF → this is what gates
        { citedFiles: ["vendor/legacy.ts"] }, // out-of-diff → advisory
      ],
    });

    expect(res.gated).toBe(true);
    expect(res.escalated).toBe(false);
    expect(res.effectiveRounds).toBe(1); // the round counts
    expect(store.appendReviewRound).toHaveBeenCalledTimes(1);
    expect(parkGateForHuman).not.toHaveBeenCalled();
    expect(call(publishEvent, "review.cap_reached")).toHaveLength(0);
  });

  it("AC3b: change set + ONLY out-of-diff findings → NOT gated, no round recorded, count unchanged", async () => {
    const { deps, store, parkGateForHuman, emitMetrics } = makeDeps();
    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(null),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "Style nits in files this PR never touched.",
      changeSet: CHANGE_SET,
      findings: [{ citedFiles: ["other/x.ts"] }, { citedFiles: ["other/y.ts"] }],
    });

    expect(res.gated).toBe(false);
    expect(res.escalated).toBe(false);
    expect(res.effectiveRounds).toBe(0);
    // The whole point: an out-of-diff complaint is not a rework round.
    expect(store.appendReviewRound).not.toHaveBeenCalled();
    expect(parkGateForHuman).not.toHaveBeenCalled();
    // Still emits a metric (an explicit zero) so the non-gating cycle is visible.
    expect(emitMetrics).toHaveBeenCalledTimes(1);
    expect(emitMetrics.mock.calls[0][0]).toMatchObject({ escalated: false, effectiveRounds: 0 });
  });

  it("AC3b: a non-gating rejection does not inflate an existing count and cannot trip the cap", async () => {
    // Two prior rounds under a cap of 3: a genuine third rejection would escalate,
    // but an out-of-diff-only one must leave the count at 2 and NOT escalate.
    const state = ledger({ rounds: [priorRound(1), priorRound(2)] });
    const { deps, store, parkGateForHuman } = makeDeps({ ledger: state });
    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(state),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "Complaint about an untouched file.",
      changeSet: CHANGE_SET,
      findings: [{ citedFiles: ["untouched/legacy.ts"] }],
    });

    expect(res.gated).toBe(false);
    expect(res.escalated).toBe(false);
    expect(res.effectiveRounds).toBe(2); // the prior count, unchanged
    expect(store.appendReviewRound).not.toHaveBeenCalled();
    expect(parkGateForHuman).not.toHaveBeenCalled();
  });

  it("AC3a at the cap: change set + an in-diff finding still escalates when the count is reached", async () => {
    const state = ledger({ rounds: [priorRound(1), priorRound(2)] });
    const { deps, store, parkGateForHuman } = makeDeps({ ledger: state });
    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(state),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "Third round, still broken in the diff.",
      changeSet: CHANGE_SET,
      findings: [{ citedFiles: ["src/a.ts"] }],
    });

    expect(res.gated).toBe(true);
    expect(res.escalated).toBe(true);
    expect(res.effectiveRounds).toBe(3);
    expect(store.appendReviewRound).toHaveBeenCalledTimes(1);
    expect(parkGateForHuman).toHaveBeenCalledTimes(1);
  });

  it("AC3c: no change set → gated (backward-compat pin), round recorded exactly as before", async () => {
    const { deps, store } = makeDeps();
    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(null),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "Missing null check.",
    });
    expect(res.gated).toBe(true);
    expect(res.escalated).toBe(false);
    expect(res.effectiveRounds).toBe(1);
    expect(store.appendReviewRound).toHaveBeenCalledTimes(1);
  });

  it("is inert unless BOTH change set and findings are present (either alone → gated)", async () => {
    // change set but no findings
    const a = makeDeps();
    const resA = await createReviewCap(a.deps).enforce({
      workflow: workflowWith(null),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "x",
      changeSet: CHANGE_SET,
    });
    expect(resA.gated).toBe(true);
    expect(a.store.appendReviewRound).toHaveBeenCalledTimes(1);

    // findings but no change set (nothing to scope against)
    const b = makeDeps();
    const resB = await createReviewCap(b.deps).enforce({
      workflow: workflowWith(null),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "x",
      findings: [{ citedFiles: ["other/x.ts"] }],
    });
    expect(resB.gated).toBe(true);
    expect(b.store.appendReviewRound).toHaveBeenCalledTimes(1);
  });

  it("malformed findings cannot fabricate a gate: null/non-object/no-files entries → non-gating", async () => {
    const { deps, store } = makeDeps();
    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(null),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "junk findings",
      changeSet: CHANGE_SET,
      findings: [null, 42, { severity: "P1" }, {}],
    });
    expect(res.gated).toBe(false);
    expect(store.appendReviewRound).not.toHaveBeenCalled();
  });
});

/**
 * TEAM-3748 D3 — the diff-scoped gate driven END-TO-END through enforce.
 *
 * The AC3a/AC3b tests above pin single-cycle behavior with a preset ledger; these
 * replay a SEQUENCE of enforce calls sharing one accumulating ledger, so the cap
 * arithmetic (AC-D3.3) and the "out-of-diff cycle doesn't count" rule (AC-D3.2)
 * are exercised the way handleReviewRejection actually calls them.
 */
describe("AC-D3.2 / AC-D3.3 — diff-scoped rounds through the cap end-to-end", () => {
  const CHANGE_SET = ["src/parser.ts"];
  const inDiff = { changeSet: CHANGE_SET, findings: [{ citedFiles: ["src/parser.ts"] }] };
  const outOfDiff = { changeSet: CHANGE_SET, findings: [{ citedFiles: ["vendor/legacy.ts"] }] };
  const baseFor = (state) => ({
    workflow: workflowWith(state),
    gateTicket: { ticketId: GATE },
    gateCfg: SHIP_GATE,
    upstreamIds: ["TEAM-1"],
  });

  it("AC-D3.3: three IN-DIFF CHANGES-NEEDED rounds trip the cap (1 → 2 → 3 → escalate)", async () => {
    const state = ledger();
    const { deps, parkGateForHuman, publishEvent, store } = makeDeps({ ledger: state });
    const cap = createReviewCap(deps);
    const base = baseFor(state);

    // Feedback differs per round so each is a genuine round (identical feedback
    // under a null SHA would be treated as one redelivered rejection).
    const r1 = await cap.enforce({ ...base, feedback: "in-diff seam A", ...inDiff });
    const r2 = await cap.enforce({ ...base, feedback: "in-diff seam B", ...inDiff });
    const r3 = await cap.enforce({ ...base, feedback: "in-diff seam C", ...inDiff });

    expect([r1.gated, r2.gated, r3.gated]).toEqual([true, true, true]);
    expect([r1.effectiveRounds, r2.effectiveRounds, r3.effectiveRounds]).toEqual([1, 2, 3]);
    expect([r1.escalated, r2.escalated]).toEqual([false, false]);
    expect(r3.escalated).toBe(true);
    expect(store.appendReviewRound).toHaveBeenCalledTimes(3); // every in-diff round recorded
    expect(parkGateForHuman).toHaveBeenCalledTimes(1);
    expect(call(publishEvent, "review.cap_reached")).toHaveLength(1);
  });

  it("AC-D3.2: an out-of-diff-only cycle between in-diff rounds records nothing and does not advance the count", async () => {
    const state = ledger();
    const { deps, store, parkGateForHuman } = makeDeps({ ledger: state });
    const cap = createReviewCap(deps);
    const base = baseFor(state);

    const a = await cap.enforce({ ...base, feedback: "in-diff 1", ...inDiff }); // counts → 1
    const b = await cap.enforce({ ...base, feedback: "nit in an untouched file", ...outOfDiff }); // downgraded
    const c = await cap.enforce({ ...base, feedback: "in-diff 2", ...inDiff }); // counts → 2

    expect([a.gated, b.gated, c.gated]).toEqual([true, false, true]);
    expect([a.effectiveRounds, b.effectiveRounds, c.effectiveRounds]).toEqual([1, 1, 2]);
    expect(b.escalated).toBe(false);
    expect(c.escalated).toBe(false); // still under the cap: the out-of-diff cycle never counted
    // Only the two in-diff cycles wrote a round — the out-of-diff one did not.
    expect(store.appendReviewRound).toHaveBeenCalledTimes(2);
    expect(parkGateForHuman).not.toHaveBeenCalled();
  });

  it("AC-D3.3: DECISION: continue after a diff-scoped escalation authorizes ANOTHER full maxRounds of in-diff rework", async () => {
    const state = ledger();
    const { deps } = makeDeps({ ledger: state });
    const cap = createReviewCap(deps);
    const base = baseFor(state);

    await cap.enforce({ ...base, feedback: "A", ...inDiff });
    await cap.enforce({ ...base, feedback: "B", ...inDiff });
    const tripped = await cap.enforce({ ...base, feedback: "C", ...inDiff });
    expect(tripped.escalated).toBe(true);

    // The human re-rejects WITH the override → count resets; round D is the first
    // of the new allowance.
    const resumed = await cap.enforce({
      ...base,
      feedback: "D: fix the seam properly this time.\nDECISION: continue",
      ...inDiff,
    });
    expect(resumed.escalated).toBe(false);
    expect(resumed.effectiveRounds).toBe(1);

    // The new allowance is a FULL maxRounds: two more in-diff rounds proceed, the
    // third re-trips the cap.
    const e = await cap.enforce({ ...base, feedback: "E", ...inDiff });
    const f = await cap.enforce({ ...base, feedback: "F", ...inDiff });
    expect([e.effectiveRounds, f.effectiveRounds]).toEqual([2, 3]);
    expect(e.escalated).toBe(false);
    expect(f.escalated).toBe(true);
  });

  it("(D3d) a stored ledger round carries no change set, so diff-scoping is inert on history (counts as legacy)", async () => {
    // buildRoundRecord never stamps a changeSet on the rounds it records, so
    // effectiveRoundCountDiffScoped counts stored history exactly as
    // effectiveRoundCount does. Proven by running the SAME two-prior-round ledger
    // once with diff-scope inputs on the current cycle and once without: the
    // stored rounds count identically, because the diff-scope only ever acts on
    // the CURRENT rejection, not on recorded history. (The pure-function inertness
    // is pinned by src/lib/workflow/ship-review.test.ts AC-f.)
    const priors = () => [priorRound(1), priorRound(2)];

    const s1 = ledger({ rounds: priors() });
    const scoped = await createReviewCap(makeDeps({ ledger: s1 }).deps).enforce({
      workflow: workflowWith(s1),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "third, in-diff",
      changeSet: ["src/a.ts"],
      findings: [{ citedFiles: ["src/a.ts"] }],
    });

    const s2 = ledger({ rounds: priors() });
    const legacy = await createReviewCap(makeDeps({ ledger: s2 }).deps).enforce({
      workflow: workflowWith(s2),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "third, in-diff",
    });

    expect(scoped.effectiveRounds).toBe(legacy.effectiveRounds);
    expect(scoped.effectiveRounds).toBe(3); // 2 legacy stored rounds + this gating round
    expect([scoped.escalated, legacy.escalated]).toEqual([true, true]);
  });
});

describe("enforce — at the cap", () => {
  const atCapState = () => ledger({ rounds: [priorRound(1), priorRound(2)] });

  it("publishes review.cap_reached, parks the gate, and stops the loop", async () => {
    const state = atCapState();
    const { deps, publishEvent, parkGateForHuman, store, commentOnGate } = makeDeps({ ledger: state });

    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(state),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1", "TEAM-2"],
      feedback: "Third time: same seam is still broken.",
    });

    // The flag the caller keys its re-open loop off.
    expect(res.escalated).toBe(true);
    expect(res.effectiveRounds).toBe(3);
    expect(res.maxRounds).toBe(3);

    const events = call(publishEvent, "review.cap_reached");
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(GATE);
    expect(events[0][2]).toMatchObject({
      workflowId: "wf_1",
      gateTicketId: GATE,
      afterPhase: "ship",
      effectiveRounds: 3,
      maxRounds: 3,
    });
    expect(events[0][2].lastFindings).toHaveLength(2); // one per upstream ticket

    expect(parkGateForHuman).toHaveBeenCalledTimes(1);
    expect(parkGateForHuman.mock.calls[0].slice(0, 2)).toEqual([GATE, "human:engineer"]);
    expect(store.appendReviewCapEscalation).toHaveBeenCalledTimes(1);
    expect(store.appendReviewCapEscalation.mock.calls[0][2]).toMatchObject({
      escalatedAtRound: 3,
      effectiveRounds: 3,
      maxRounds: 3,
      assignee: "human:engineer",
      decision: null,
    });
    // The human is told what the exit is — the gate stopped responding to
    // "request changes" and nothing else says so.
    expect(commentOnGate).toHaveBeenCalledTimes(1);
    expect(commentOnGate.mock.calls[0][1]).toContain("DECISION: continue");
  });

  it("prefers the reviewerRole roster over the gate's configured assignee", async () => {
    const state = atCapState();
    const { deps, parkGateForHuman } = makeDeps({
      ledger: state,
      listReviewers: vi.fn(async () => [{ email: "owner@example.com" }, { email: "other@example.com" }]),
    });
    await createReviewCap(deps).enforce({
      workflow: workflowWith(state),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "again",
    });
    expect(parkGateForHuman.mock.calls[0][1]).toBe("human:owner@example.com");
  });

  it("falls back to human:reviewer with no roster and no configured assignee", async () => {
    const state = atCapState();
    const { deps, parkGateForHuman } = makeDeps({
      ledger: state,
      listReviewers: vi.fn(async () => {
        throw new Error("ticket-tools unavailable");
      }),
    });
    await createReviewCap(deps).enforce({
      workflow: workflowWith(state),
      gateTicket: { ticketId: GATE },
      gateCfg: { ...SHIP_GATE, assignee: undefined },
      upstreamIds: ["TEAM-1"],
      feedback: "again",
    });
    expect(parkGateForHuman.mock.calls[0][1]).toBe("human:reviewer");
  });

  it("re-parks without re-publishing when the escalation is already open", async () => {
    const state = ledger({
      rounds: [priorRound(1), priorRound(2), priorRound(3)],
      escalations: [{ escalatedAtRound: 3, decision: null }],
    });
    const { deps, publishEvent, parkGateForHuman, store } = makeDeps({ ledger: state });

    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(state),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "please just fix it",
    });

    expect(res.escalated).toBe(true);
    expect(res.alreadyOpen).toBe(true);
    expect(call(publishEvent, "review.cap_reached")).toHaveLength(0);
    expect(store.appendReviewCapEscalation).not.toHaveBeenCalled();
    expect(parkGateForHuman).toHaveBeenCalledTimes(1); // still re-parked
  });

  it("escalates rather than proceeding on an unrecognized onCapReached", async () => {
    const state = atCapState();
    const { deps, parkGateForHuman } = makeDeps({ ledger: state });
    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(state),
      gateTicket: { ticketId: GATE },
      gateCfg: { ...SHIP_GATE, onCapReached: "ignore" },
      upstreamIds: ["TEAM-1"],
      feedback: "again",
    });
    expect(res.escalated).toBe(true);
    expect(parkGateForHuman).toHaveBeenCalledTimes(1);
  });
});

describe("AC-D2.2a — maxRounds config moves the trip point", () => {
  const runWith = async (maxRounds, priorRounds) => {
    const state = ledger({ rounds: priorRounds });
    const { deps } = makeDeps({ ledger: state });
    return createReviewCap(deps).enforce({
      workflow: workflowWith(state),
      gateTicket: { ticketId: GATE },
      gateCfg: { ...SHIP_GATE, maxRounds },
      upstreamIds: ["TEAM-1"],
      feedback: "changes needed",
    });
  };

  it("maxRounds: 2 trips one round earlier than the default", async () => {
    expect((await runWith(2, [priorRound(1)])).escalated).toBe(true);
    expect((await runWith(3, [priorRound(1)])).escalated).toBe(false);
  });

  it("maxRounds: 5 keeps reworking where the default would have escalated", async () => {
    const three = [priorRound(1), priorRound(2)];
    expect((await runWith(3, three)).escalated).toBe(true);
    expect((await runWith(5, three)).escalated).toBe(false);
  });
});

describe("AC-D2.2b — a regression round counts double toward the cap", () => {
  it("trips at two rounds when the second regresses an earlier fix", async () => {
    // Round 1 flagged X; round 2 (this rejection) flags X again after it was
    // absent in between — 1 + 2 = 3 = the cap.
    const state = ledger({
      rounds: [
        priorRound(1, { fingerprint: fingerprintFinding("TEAM-1", "flaky retry") }),
        { round: 2, verdict: "CHANGES-NEEDED", reviewedHeadSha: null, findings: [{ fingerprint: "other" }] },
      ],
    });
    const { deps } = makeDeps({ ledger: state });
    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(state),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "flaky retry",
    });
    expect(res.round.round).toBe(3);
    expect(res.round.findings[0].regressionOf).toMatchObject({ round: 1 });
    expect(res.effectiveRounds).toBe(4); // 1 + 1 + 2
    expect(res.escalated).toBe(true);
  });

  it("regressionCountsDouble: false weighs that same round once, delaying the cap", async () => {
    const state = ledger({
      rounds: [
        priorRound(1, { fingerprint: fingerprintFinding("TEAM-1", "flaky retry") }),
        { round: 2, verdict: "CHANGES-NEEDED", reviewedHeadSha: null, findings: [{ fingerprint: "other" }] },
      ],
    });
    const { deps } = makeDeps({ ledger: state });
    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(state),
      gateTicket: { ticketId: GATE },
      gateCfg: { ...SHIP_GATE, regressionCountsDouble: false },
      upstreamIds: ["TEAM-1"],
      feedback: "flaky retry",
    });
    expect(res.round.findings[0].regressionOf).toBeDefined(); // still LABELLED
    expect(res.effectiveRounds).toBe(3); // but weighed 1, not 2
    expect(res.escalated).toBe(true);
    // ...and with room under a higher cap the difference is visible:
    expect(res.effectiveRounds).toBeLessThan(4);
  });
});

describe("the escalation's exit", () => {
  const escalatedState = () =>
    ledger({
      rounds: [priorRound(1), priorRound(2), priorRound(3)],
      escalations: [{ escalatedAtRound: 3, decision: null }],
    });

  it("an explicit DECISION: continue resets the count and rework resumes", async () => {
    const state = escalatedState();
    const { deps, store, publishEvent } = makeDeps({ ledger: state });

    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(state),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "Fix the seam properly this time.\nDECISION: continue",
    });

    expect(store.appendReviewAuthorization).toHaveBeenCalledTimes(1);
    expect(store.appendReviewAuthorization.mock.calls[0][2]).toMatchObject({
      decision: "continue",
      resetAtRound: 3,
      forEscalationAtRound: 3,
    });
    expect(call(publishEvent, "review.cap_authorized")).toHaveLength(1);
    // Round 4 is the first of the new allowance.
    expect(res.round.round).toBe(4);
    expect(res.effectiveRounds).toBe(1);
    expect(res.escalated).toBe(false);
  });

  it("stays escalated on a rejection with no DECISION line (fail closed)", async () => {
    const state = escalatedState();
    const { deps, store } = makeDeps({ ledger: state });
    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(state),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "Approved in spirit, just keep going.",
    });
    expect(store.appendReviewAuthorization).not.toHaveBeenCalled();
    expect(res.escalated).toBe(true);
  });

  it("does not treat merge-with-known-findings or cancel as an override", async () => {
    for (const decision of ["merge-with-known-findings", "cancel"]) {
      const state = escalatedState();
      const { deps, store } = makeDeps({ ledger: state });
      const res = await createReviewCap(deps).enforce({
        workflow: workflowWith(state),
        gateTicket: { ticketId: GATE },
        gateCfg: SHIP_GATE,
        upstreamIds: ["TEAM-1"],
        feedback: `DECISION: ${decision}`,
      });
      expect(store.appendReviewAuthorization).not.toHaveBeenCalled();
      expect(res.escalated).toBe(true);
    }
  });

  it("ignores a DECISION line when no escalation is open", async () => {
    const { deps, store } = makeDeps();
    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(null),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "DECISION: continue",
    });
    expect(store.appendReviewAuthorization).not.toHaveBeenCalled();
    expect(res.escalated).toBe(false);
  });
});

describe("parseDecision — fail closed", () => {
  it("accepts a clean line in any case, with markdown noise, last one winning", () => {
    expect(parseDecision("DECISION: continue")).toBe("continue");
    expect(parseDecision("decision:continue")).toBe("continue");
    expect(parseDecision("blah\n- **DECISION: cancel**\nthanks")).toBe("cancel");
    expect(parseDecision("> DECISION: continue.")).toBe("continue");
    expect(parseDecision("DECISION: cancel\nDECISION: continue")).toBe("continue");
    expect(parseDecision("DECISION: merge-with-known-findings")).toBe("merge-with-known-findings");
  });

  it("returns null for everything else — it must never default to continue", () => {
    for (const text of [
      "",
      null,
      undefined,
      "looks good, continue",
      "DECISION: yes",
      "DECISION:",
      "I think the DECISION: continue is right", // buried in a sentence
      "DECISION: continue or cancel, your call",
      "continue",
    ]) {
      expect(parseDecision(text)).toBeNull();
    }
  });
});

describe("openEscalation", () => {
  it("is open until an authorization names its round", () => {
    const e = { escalatedAtRound: 3, decision: null };
    expect(openEscalation(ledger({ escalations: [e] }))).toBe(e);
    expect(
      openEscalation(
        ledger({ escalations: [e], authorizations: [{ decision: "continue", forEscalationAtRound: 3 }] })
      )
    ).toBeNull();
    // An authorization for a DIFFERENT escalation doesn't resolve this one.
    expect(
      openEscalation(
        ledger({ escalations: [e], authorizations: [{ decision: "continue", forEscalationAtRound: 1 }] })
      )
    ).toBe(e);
  });

  it("treats an in-place recorded decision as resolved, and handles junk", () => {
    expect(openEscalation(ledger({ escalations: [{ escalatedAtRound: 3, decision: "cancel" }] }))).toBeNull();
    expect(openEscalation(null)).toBeNull();
    expect(openEscalation({ escalations: "nope", authorizations: 7 })).toBeNull();
  });
});

describe("buildRoundRecord", () => {
  it("numbers the first round 1 and increments from the latest", () => {
    expect(buildRoundRecord({ priorRounds: [], upstreamIds: ["TEAM-1"], feedback: "a", nowIso: NOW_ISO }).round).toBe(1);
    expect(
      buildRoundRecord({ priorRounds: [priorRound(1), priorRound(2)], upstreamIds: ["TEAM-1"], feedback: "a", nowIso: NOW_ISO }).round
    ).toBe(3);
  });

  it("reuses the round number only when the SAME non-empty head SHA is re-reviewed", () => {
    const prior = [{ round: 1, reviewedHeadSha: "abc123", verdict: "CHANGES-NEEDED", findings: [] }];
    expect(
      buildRoundRecord({ priorRounds: prior, upstreamIds: ["TEAM-1"], feedback: "a", reviewedHeadSha: "abc123", nowIso: NOW_ISO }).round
    ).toBe(1);
    expect(
      buildRoundRecord({ priorRounds: prior, upstreamIds: ["TEAM-1"], feedback: "a", reviewedHeadSha: "def456", nowIso: NOW_ISO }).round
    ).toBe(2);
  });

  it("does NOT collapse rounds when the SHA is unavailable — the cap must still trip", () => {
    // null === null would otherwise pin every rejection to round 1 forever.
    const prior = [{ round: 1, reviewedHeadSha: null, verdict: "CHANGES-NEEDED", findings: [] }];
    expect(
      buildRoundRecord({ priorRounds: prior, upstreamIds: ["TEAM-1"], feedback: "a", reviewedHeadSha: null, nowIso: NOW_ISO }).round
    ).toBe(2);
  });

  it("marks a regression only when the finding skipped the previous round", () => {
    const fp = fingerprintFinding("TEAM-1", "same complaint");
    // Present in round 1, absent in round 2, back now → regression.
    const gap = buildRoundRecord({
      priorRounds: [
        { round: 1, verdict: "CHANGES-NEEDED", findings: [{ fingerprint: fp }] },
        { round: 2, verdict: "CHANGES-NEEDED", findings: [{ fingerprint: "unrelated" }] },
      ],
      upstreamIds: ["TEAM-1"],
      feedback: "same complaint",
      nowIso: NOW_ISO,
    });
    expect(gap.findings[0].regressionOf).toMatchObject({ round: 1 });

    // Never fixed (present in the immediately preceding round) → not a
    // regression, just an unresolved finding.
    const persistent = buildRoundRecord({
      priorRounds: [{ round: 1, verdict: "CHANGES-NEEDED", findings: [{ fingerprint: fp }] }],
      upstreamIds: ["TEAM-1"],
      feedback: "same complaint",
      nowIso: NOW_ISO,
    });
    expect(persistent.findings[0].regressionOf).toBeUndefined();
  });

  it("fingerprints one finding per upstream ticket, ignoring whitespace and case churn", () => {
    const r = buildRoundRecord({
      priorRounds: [],
      upstreamIds: ["TEAM-1", "TEAM-2"],
      feedback: "Fix   THE parser\n",
      nowIso: NOW_ISO,
    });
    expect(r.findings.map((f) => f.ticketId)).toEqual(["TEAM-1", "TEAM-2"]);
    expect(r.findings[0].fingerprint).toBe(fingerprintFinding("TEAM-1", "fix the parser"));
    expect(r.findings[0].fingerprint).not.toBe(r.findings[1].fingerprint);
  });

  it("still records a round when there are no upstream agent tickets", () => {
    const r = buildRoundRecord({ priorRounds: [], upstreamIds: [], feedback: "a", nowIso: NOW_ISO });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].ticketId).toBeUndefined();
  });
});

describe("enforce — fails open", () => {
  it("allows rework when the ledger write fails, rather than wedging the gate", async () => {
    const { deps, publishEvent, parkGateForHuman } = makeDeps({
      store: {
        appendReviewRound: vi.fn(async () => {
          throw new Error("ProvisionedThroughputExceeded");
        }),
        appendReviewCapEscalation: vi.fn(async () => {}),
        appendReviewAuthorization: vi.fn(async () => {}),
      },
    });
    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(null),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "changes",
    });
    expect(res).toMatchObject({ escalated: false, error: "ProvisionedThroughputExceeded" });
    expect(call(publishEvent, "review.cap_reached")).toHaveLength(0);
    expect(parkGateForHuman).not.toHaveBeenCalled();
  });

  it("completes the escalation even if the audit append fails", async () => {
    const state = ledger({ rounds: [priorRound(1), priorRound(2)] });
    const { deps, publishEvent, parkGateForHuman } = makeDeps({
      store: {
        appendReviewRound: vi.fn(async (_w, _g, round) => ({ ...state, rounds: [...state.rounds, round] })),
        appendReviewCapEscalation: vi.fn(async () => {
          throw new Error("write failed");
        }),
        appendReviewAuthorization: vi.fn(async () => {}),
      },
    });
    const res = await createReviewCap(deps).enforce({
      workflow: workflowWith(state),
      gateTicket: { ticketId: GATE },
      gateCfg: SHIP_GATE,
      upstreamIds: ["TEAM-1"],
      feedback: "changes",
    });
    expect(res.escalated).toBe(true);
    expect(call(publishEvent, "review.cap_reached")).toHaveLength(1);
    expect(parkGateForHuman).toHaveBeenCalledTimes(1);
  });
});

/**
 * TEAM-3685 Finding 1 — a redelivered rejection must not spend a review round.
 *
 * Round reuse used to be keyed on the reviewed head SHA alone, and the guard
 * that both SHAs be non-empty (correctly) stopped `null === null` from pinning
 * every rejection to round 1. But that left the no-SHA case (DynamoDB mode, a
 * gate with no PR) with NO idempotency key at all, and the store's append is an
 * unconditional list_append: every redelivery of the SAME rejection became a new
 * round. Dedupe upstream is only partial — SQS FIFO covers a 5-minute window and
 * the legacy direct-invoke webhook path covers nothing — so the ledger has to
 * recognize the duplicate itself, via the round's content fingerprint.
 */
describe("buildRoundRecord — null-SHA idempotency (TEAM-3685 Finding 1)", () => {
  const CYCLE = { upstreamIds: ["TEAM-1", "TEAM-2"], feedback: "Parser still drops the trailing token." };
  const build = (priorRounds, overrides = {}) =>
    buildRoundRecord({ priorRounds, ...CYCLE, reviewedHeadSha: null, nowIso: NOW_ISO, ...overrides });

  it("stores a content fingerprint on the round record so it survives in the ledger", () => {
    const r = build([]);
    expect(r.round).toBe(1);
    expect(r.contentFingerprint).toBe(roundContentFingerprint(CYCLE));
    // Present on SHA-carrying rounds too — the ledger shape stays uniform.
    expect(build([], { reviewedHeadSha: "abc123" }).contentFingerprint).toBe(
      roundContentFingerprint(CYCLE)
    );
  });

  it("REUSES the round number when the identical rejection is redelivered", () => {
    const first = build([]);
    const redelivered = build([first]);
    expect(redelivered.round).toBe(first.round);
    expect(redelivered.round).toBe(1);
  });

  it("still reuses it when the provider returns the upstream ids in a different order", () => {
    const first = build([]);
    const reordered = build([first], { upstreamIds: ["TEAM-2", "TEAM-1"] });
    expect(reordered.round).toBe(1);
  });

  it("treats DIFFERENT feedback under null SHAs as a NEW round — the cap must still trip", () => {
    const first = build([]);
    expect(build([first], { feedback: "Now the retry test fails too." }).round).toBe(2);
    // A different upstream set is a different cycle as well.
    expect(build([first], { upstreamIds: ["TEAM-1"] }).round).toBe(2);
  });

  it("counts a legacy prior round (null SHA, no contentFingerprint) as a NEW round", () => {
    // Over-counting fails safe — the cap trips early and a human can authorize
    // more rounds; under-counting is the unbounded loop.
    const legacy = { round: 1, reviewedHeadSha: null, verdict: "CHANGES-NEEDED", findings: [] };
    expect(build([legacy]).round).toBe(2);
    // Explicit null/empty-string fingerprints are treated the same way.
    expect(build([{ ...legacy, contentFingerprint: null }]).round).toBe(2);
    expect(build([{ ...legacy, contentFingerprint: "" }]).round).toBe(2);
  });

  it("never lets a null SHA and a non-empty SHA collapse into one round, either direction", () => {
    const withSha = build([], { reviewedHeadSha: "abc123" });
    const withoutSha = build([]);
    // prior had a SHA, this cycle has none → new round
    expect(build([withSha]).round).toBe(withSha.round + 1);
    // prior had none, this cycle has one → new round
    expect(build([withoutSha], { reviewedHeadSha: "abc123" }).round).toBe(withoutSha.round + 1);
  });

  it("does not change SHA-based behavior: the same SHA reuses the round even with new feedback", () => {
    const prior = [
      { round: 1, reviewedHeadSha: "abc123", contentFingerprint: "whatever", verdict: "CHANGES-NEEDED", findings: [] },
    ];
    expect(build(prior, { reviewedHeadSha: "abc123", feedback: "a completely different complaint" }).round).toBe(1);
    expect(build(prior, { reviewedHeadSha: "def456" }).round).toBe(2);
    // ...and a prior round predating the fingerprint field behaves identically.
    const legacySha = [{ round: 1, reviewedHeadSha: "abc123", verdict: "CHANGES-NEEDED", findings: [] }];
    expect(build(legacySha, { reviewedHeadSha: "abc123", feedback: "different again" }).round).toBe(1);
  });

  it("tolerates a junk ledger without throwing", () => {
    expect(
      buildRoundRecord({ priorRounds: [null, 7, { round: "x" }, undefined], ...CYCLE, nowIso: NOW_ISO }).round
    ).toBe(1);
    expect(buildRoundRecord({ priorRounds: null, ...CYCLE, nowIso: NOW_ISO }).round).toBe(1);
  });

  it("selects the same `previous` round as the same-SHA path (regression parity)", () => {
    // Same ledger shape twice: once arbitrated by SHA, once by fingerprint. The
    // round being re-verdicted (3) does not itself carry the finding, so the
    // comparison point is round 2 for both paths and the findings must match.
    const fp = fingerprintFinding("TEAM-1", "flaky retry");
    const cfp = roundContentFingerprint({ upstreamIds: ["TEAM-1"], feedback: "flaky retry" });
    const args = { upstreamIds: ["TEAM-1"], feedback: "flaky retry", nowIso: NOW_ISO };

    const viaFingerprint = buildRoundRecord({
      priorRounds: [
        { round: 1, reviewedHeadSha: null, contentFingerprint: "aa", verdict: "CHANGES-NEEDED", findings: [{ fingerprint: fp }] },
        { round: 2, reviewedHeadSha: null, contentFingerprint: "bb", verdict: "CHANGES-NEEDED", findings: [{ fingerprint: "other" }] },
        { round: 3, reviewedHeadSha: null, contentFingerprint: cfp, verdict: "CHANGES-NEEDED", findings: [{ fingerprint: "other2" }] },
      ],
      reviewedHeadSha: null,
      ...args,
    });
    const viaSha = buildRoundRecord({
      priorRounds: [
        { round: 1, reviewedHeadSha: "s1", verdict: "CHANGES-NEEDED", findings: [{ fingerprint: fp }] },
        { round: 2, reviewedHeadSha: "s2", verdict: "CHANGES-NEEDED", findings: [{ fingerprint: "other" }] },
        { round: 3, reviewedHeadSha: "s3", verdict: "CHANGES-NEEDED", findings: [{ fingerprint: "other2" }] },
      ],
      reviewedHeadSha: "s3",
      ...args,
    });

    expect(viaFingerprint.round).toBe(3);
    expect(viaSha.round).toBe(3);
    expect(viaFingerprint.findings).toEqual(viaSha.findings);
    // Round 2 is the comparison point and lacks the finding, so its reappearance
    // from round 1 IS a regression on both paths.
    expect(viaFingerprint.findings[0].regressionOf).toMatchObject({ round: 1 });
  });

  it("never labels a redelivered finding a REGRESSION of its own round", () => {
    // The one intended asymmetry with the same-SHA path. A redelivery carries, by
    // construction, the same findings as the round it reuses; if that round were
    // scanned as an "earlier round" every redelivered finding would be a
    // regression, and a regression weighs DOUBLE — so the redelivery would keep
    // inflating the count even with the round number reused. Nothing can have
    // regressed between two deliveries of one rejection.
    const first = build([]);
    expect(first.findings.some((f) => f.regressionOf)).toBe(false);
    const redelivered = build([first]);
    expect(redelivered.round).toBe(first.round);
    expect(redelivered.findings.some((f) => f.regressionOf)).toBe(false);
    // The duplicate entry that lands in the ledger is weight-identical to the
    // entry it replaces — which is what makes the duplicate append harmless.
    expect(redelivered.findings).toEqual(first.findings);

    // The same-SHA path is deliberately untouched here: a re-review of one SHA is
    // a genuinely new verdict, and it keeps its pre-existing labeling.
    const sha = { round: 1, reviewedHeadSha: "abc123", verdict: "CHANGES-NEEDED", findings: [] };
    const reReviewed = build([{ ...sha, findings: [{ fingerprint: fingerprintFinding("TEAM-1", CYCLE.feedback) }] }], {
      reviewedHeadSha: "abc123",
    });
    expect(reReviewed.round).toBe(1);
    expect(reReviewed.findings[0].regressionOf).toMatchObject({ round: 1 });
  });
});

describe("roundContentFingerprint", () => {
  it("is deterministic and blind to case/whitespace churn in the feedback", () => {
    const a = roundContentFingerprint({ upstreamIds: ["TEAM-1"], feedback: "Fix   THE parser\n" });
    expect(roundContentFingerprint({ upstreamIds: ["TEAM-1"], feedback: "fix the parser" })).toBe(a);
    expect(roundContentFingerprint({ upstreamIds: ["TEAM-1"], feedback: " FIX\tthe\nparser " })).toBe(a);
    // Same normalization fingerprintFinding uses — one notion of "the same
    // complaint" across both.
    expect(fingerprintFinding("TEAM-1", "Fix   THE parser\n")).toBe(
      fingerprintFinding("TEAM-1", "fix the parser")
    );
  });

  it("is blind to upstream id ORDER but not to the id set", () => {
    expect(roundContentFingerprint({ upstreamIds: ["b", "a"], feedback: "x" })).toBe(
      roundContentFingerprint({ upstreamIds: ["a", "b"], feedback: "x" })
    );
    expect(roundContentFingerprint({ upstreamIds: ["a"], feedback: "x" })).not.toBe(
      roundContentFingerprint({ upstreamIds: ["a", "b"], feedback: "x" })
    );
    // Real feedback differences must fork it, or redeliveries would swallow a
    // genuine new round.
    expect(roundContentFingerprint({ upstreamIds: ["a"], feedback: "x" })).not.toBe(
      roundContentFingerprint({ upstreamIds: ["a"], feedback: "y" })
    );
  });

  it("handles missing/odd inputs without throwing", () => {
    for (const ids of [undefined, null, [], [null, undefined, ""], "TEAM-1"]) {
      expect(typeof roundContentFingerprint({ upstreamIds: ids, feedback: undefined })).toBe("string");
    }
    // Falsy ids are dropped, so a gate with no upstream tickets fingerprints on
    // the feedback alone.
    expect(roundContentFingerprint({ upstreamIds: [null, undefined], feedback: "x" })).toBe(
      roundContentFingerprint({ upstreamIds: [], feedback: "x" })
    );
  });
});

describe("enforce — redelivered null-SHA rejections do not spend rounds (TEAM-3685 Finding 1)", () => {
  const rejection = {
    gateTicket: { ticketId: GATE },
    gateCfg: SHIP_GATE,
    upstreamIds: ["TEAM-1"],
    feedback: "The parser still drops the trailing token.",
    reviewedHeadSha: null,
  };

  it("five redeliveries of the identical rejection stay at one effective round", async () => {
    const state = ledger();
    const { deps, store } = makeDeps({ ledger: state });
    const cap = createReviewCap(deps);

    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await cap.enforce({ workflow: workflowWith(state), ...rejection }));
    }

    // Every cycle wrote (the store append is unconditional — that is the store's
    // contract, R2), but they all landed on round 1...
    expect(store.appendReviewRound).toHaveBeenCalledTimes(5);
    expect(state.rounds.map((r) => r.round)).toEqual([1, 1, 1, 1, 1]);
    // ...so the count effectiveRoundCount derives never moves, and the cap never
    // trips: the rework loop is still allowed, which is correct — the human has
    // only rejected once.
    expect(results.map((r) => r.effectiveRounds)).toEqual([1, 1, 1, 1, 1]);
    expect(results.map((r) => r.escalated)).toEqual([false, false, false, false, false]);
  });

  it("but three GENUINE rejections still trip the cap", async () => {
    const state = ledger();
    const { deps } = makeDeps({ ledger: state });
    const cap = createReviewCap(deps);

    const first = await cap.enforce({ workflow: workflowWith(state), ...rejection });
    // A redelivery in between must be invisible to the count.
    await cap.enforce({ workflow: workflowWith(state), ...rejection });
    const second = await cap.enforce({
      workflow: workflowWith(state),
      ...rejection,
      feedback: "Now the retry test fails.",
    });
    const third = await cap.enforce({
      workflow: workflowWith(state),
      ...rejection,
      feedback: "The error message is still wrong.",
    });

    expect([first.effectiveRounds, second.effectiveRounds, third.effectiveRounds]).toEqual([1, 2, 3]);
    expect([first.escalated, second.escalated]).toEqual([false, false]);
    expect(third.escalated).toBe(true);
  });
});

/**
 * TEAM-3685 Finding 2 — the fail-open branch is observable and bounded.
 *
 * A persistently unwritable ledger (revoked IAM, deleted table, sustained
 * throttling) used to restore the exact unbounded rework loop the cap exists to
 * stop, behind a single console line. Now every fail-open cycle emits a metric,
 * and after REVIEW_CAP_FAIL_OPEN_LIMIT consecutive failures for the SAME gate
 * enforcement fails CLOSED and hands the gate to a human.
 */
describe("enforce — fail-open is metered (TEAM-3685 Finding 2a)", () => {
  const rejection = {
    gateTicket: { ticketId: GATE },
    gateCfg: SHIP_GATE,
    upstreamIds: ["TEAM-1"],
    feedback: "changes",
  };

  it("emits ReviewCapFailOpen with the gate/phase/error and still allows rework", async () => {
    const { deps, emitFailOpenMetrics, emitMetrics } = makeDeps({ store: failingStore(() => true) });
    const res = await createReviewCap(deps).enforce({ workflow: workflowWith(null), ...rejection });

    expect(res).toMatchObject({ escalated: false, error: "AccessDeniedException", consecutiveFailures: 1 });
    expect(res.failClosed).toBeUndefined();
    expect(emitFailOpenMetrics).toHaveBeenCalledTimes(1);
    expect(emitFailOpenMetrics.mock.calls[0][0]).toMatchObject({
      gateTicketId: GATE,
      afterPhase: "ship",
      failClosed: false,
      consecutiveFailures: 1,
      error: "AccessDeniedException",
    });
    // The normal cap record describes a decision that was never made — it must
    // NOT be emitted on this branch.
    expect(emitMetrics).not.toHaveBeenCalled();
  });

  it("the healthy path emits only the normal record", async () => {
    const { deps, emitMetrics, emitFailOpenMetrics } = makeDeps();
    await createReviewCap(deps).enforce({ workflow: workflowWith(null), ...rejection });
    expect(emitMetrics).toHaveBeenCalledTimes(1);
    expect(emitFailOpenMetrics).not.toHaveBeenCalled();
  });
});

describe("enforce — fails CLOSED after N consecutive ledger failures (TEAM-3685 Finding 2b)", () => {
  const rejection = {
    gateTicket: { ticketId: GATE },
    gateCfg: SHIP_GATE,
    upstreamIds: ["TEAM-1"],
    feedback: "changes",
  };
  const enforceN = async (cap, n, args = rejection) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await cap.enforce({ workflow: workflowWith(null), ...args }));
    return out;
  };

  it("defaults to a limit of 3", () => {
    expect(REVIEW_CAP_FAIL_OPEN_LIMIT).toBe(3);
  });

  it("fails open twice, then closed on the third failure for the same gate", async () => {
    const { deps, publishEvent, parkGateForHuman, commentOnGate, store, emitFailOpenMetrics } = makeDeps({
      store: failingStore(() => true),
    });
    const [first, second, third] = await enforceN(createReviewCap(deps), 3);

    expect([first.escalated, second.escalated]).toEqual([false, false]);
    expect(third).toMatchObject({ escalated: true, failClosed: true, error: "AccessDeniedException", consecutiveFailures: 3 });

    // The gate is handed to a human, with a comment that says why.
    expect(parkGateForHuman).toHaveBeenCalledTimes(1);
    expect(parkGateForHuman.mock.calls[0].slice(0, 2)).toEqual([GATE, "human:engineer"]);
    expect(commentOnGate).toHaveBeenCalledTimes(1);
    expect(commentOnGate.mock.calls[0][1]).toMatch(/persistently unable to record review rounds/);
    expect(commentOnGate.mock.calls[0][1]).toMatch(/human must resolve this gate/);

    // No cap_reached event and no escalation record: both describe a round count
    // this invocation could not establish, and the record needs the same table.
    expect(call(publishEvent, "review.cap_reached")).toHaveLength(0);
    expect(store.appendReviewCapEscalation).not.toHaveBeenCalled();

    // Every cycle is metered; only the last is flagged as the fail-closed one.
    expect(emitFailOpenMetrics.mock.calls.map(([m]) => [m.consecutiveFailures, m.failClosed])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
  });

  it("honors a failOpenLimit override", async () => {
    const { deps } = makeDeps({ store: failingStore(() => true), failOpenLimit: 1 });
    const [only] = await enforceN(createReviewCap(deps), 1);
    expect(only).toMatchObject({ escalated: true, failClosed: true, consecutiveFailures: 1 });
  });

  it("keeps failing closed while the ledger stays broken", async () => {
    const { deps, parkGateForHuman } = makeDeps({ store: failingStore(() => true), failOpenLimit: 1 });
    const results = await enforceN(createReviewCap(deps), 3);
    expect(results.map((r) => r.escalated)).toEqual([true, true, true]);
    expect(parkGateForHuman).toHaveBeenCalledTimes(3); // re-parked every cycle
  });

  it("a success between failures resets the streak", async () => {
    let broken = true;
    const { deps } = makeDeps({ store: failingStore(() => broken) });
    const cap = createReviewCap(deps);

    const [a, b] = await enforceN(cap, 2);
    expect([a.escalated, b.escalated]).toEqual([false, false]);

    broken = false;
    const healthy = await cap.enforce({ workflow: workflowWith(null), ...rejection });
    expect(healthy.escalated).toBe(false);
    expect(healthy.error).toBeUndefined();

    // Streak forgotten: the next failure is #1 again, not #3.
    broken = true;
    const after = await cap.enforce({ workflow: workflowWith(null), ...rejection });
    expect(after).toMatchObject({ escalated: false, consecutiveFailures: 1 });
    expect(after.failClosed).toBeUndefined();
  });

  it("counts per gate — failures on one gate do not park another", async () => {
    const { deps, parkGateForHuman } = makeDeps({ store: failingStore(() => true) });
    const cap = createReviewCap(deps);
    const other = { ...rejection, gateTicket: { ticketId: "TEAM-901" } };

    // Two failures on each gate: neither reaches the limit of 3 on its own,
    // even though four failures happened in this container.
    for (const args of [rejection, other, rejection, other]) {
      const res = await cap.enforce({ workflow: workflowWith(null), ...args });
      expect(res.escalated).toBe(false);
    }
    expect(parkGateForHuman).not.toHaveBeenCalled();

    // The third failure on GATE parks GATE, and only GATE.
    const third = await cap.enforce({ workflow: workflowWith(null), ...rejection });
    expect(third).toMatchObject({ escalated: true, failClosed: true, consecutiveFailures: 3 });
    expect(parkGateForHuman.mock.calls.map((c) => c[0])).toEqual([GATE]);
  });

  it("a park or comment failure does not throw out of enforce — still escalated", async () => {
    const { deps: parkDeps } = makeDeps({
      store: failingStore(() => true),
      failOpenLimit: 1,
      parkGateForHuman: vi.fn(async () => {
        throw new Error("jira 503");
      }),
    });
    await expect(createReviewCap(parkDeps).enforce({ workflow: workflowWith(null), ...rejection }))
      .resolves.toMatchObject({ escalated: true, failClosed: true });

    const { deps: commentDeps, parkGateForHuman } = makeDeps({
      store: failingStore(() => true),
      failOpenLimit: 1,
      commentOnGate: vi.fn(async () => {
        throw new Error("comment 500");
      }),
    });
    const res = await createReviewCap(commentDeps).enforce({ workflow: workflowWith(null), ...rejection });
    expect(res).toMatchObject({ escalated: true, failClosed: true });
    expect(parkGateForHuman).toHaveBeenCalledTimes(1); // the park still happened
  });

  it("a roster lookup failure still parks, using the configured assignee", async () => {
    const { deps, parkGateForHuman } = makeDeps({
      store: failingStore(() => true),
      failOpenLimit: 1,
      listReviewers: vi.fn(async () => {
        throw new Error("ticket-tools unavailable");
      }),
    });
    const res = await createReviewCap(deps).enforce({ workflow: workflowWith(null), ...rejection });
    expect(res.escalated).toBe(true);
    expect(parkGateForHuman.mock.calls[0][1]).toBe("human:engineer");
  });

  it("each createReviewCap instance counts independently (per-container state)", async () => {
    // Documents the backstop's known limit: a cold start (a fresh instance)
    // forgets the streak, so the bound is per container, not global.
    const failing = failingStore(() => true);
    const { deps: depsA } = makeDeps({ store: failing });
    const { deps: depsB } = makeDeps({ store: failing });
    const capA = createReviewCap(depsA);
    const capB = createReviewCap(depsB);

    for (const cap of [capA, capB, capA, capB]) {
      const res = await cap.enforce({ workflow: workflowWith(null), ...rejection });
      expect(res.escalated).toBe(false);
    }
    // Third failure on A trips A only.
    expect((await capA.enforce({ workflow: workflowWith(null), ...rejection })).failClosed).toBe(true);
    expect((await capB.enforce({ workflow: workflowWith(null), ...rejection })).failClosed).toBe(true);
  });
});
