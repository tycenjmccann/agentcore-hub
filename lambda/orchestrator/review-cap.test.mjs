import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createReviewCap,
  resolveReviewGateCap,
  buildRoundRecord,
  fingerprintFinding,
  parseDecision,
  openEscalation,
  REVIEW_GATE_CAP_DEFAULTS,
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
  const deps = {
    store,
    publishEvent,
    listReviewers,
    parkGateForHuman,
    commentOnGate,
    emitMetrics,
    now: () => new Date(NOW),
    log: () => {},
  };
  return { deps, state, store, publishEvent, listReviewers, parkGateForHuman, commentOnGate, emitMetrics };
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
