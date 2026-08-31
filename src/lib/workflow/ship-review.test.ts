import { describe, it, expect } from "vitest";
import { effectiveRoundCount, mergeRound } from "./ship-review";
import type { ShipRoundLike, AuthorizationLike } from "./ship-review";

function cn(round: number, regressions = 0): ShipRoundLike {
  return {
    round,
    verdict: "CHANGES-NEEDED",
    findings: Array.from({ length: regressions }, () => ({ regressionOf: { of: "x" } })),
  };
}
function pass(round: number, verdict: ShipRoundLike["verdict"] = "PASS"): ShipRoundLike {
  return { round, verdict, findings: [] };
}
function cont(resetAtRound: number): AuthorizationLike {
  return { decision: "continue", resetAtRound };
}

describe("effectiveRoundCount", () => {
  it("empty rounds → 0 (absent state artifact = round 0)", () => {
    expect(effectiveRoundCount([])).toBe(0);
  });

  it("example (a): three plain CHANGES-NEEDED rounds → 3 (the >=3 boundary)", () => {
    expect(effectiveRoundCount([cn(1), cn(2), cn(3)])).toBe(3);
  });

  it("example (b): one CN round with a regression + one plain CN round → 2+1 = 3", () => {
    expect(effectiveRoundCount([cn(1, 1), cn(2)])).toBe(3);
  });

  it("example (c): two CN rounds each with a regression → 2+2 = 4", () => {
    expect(effectiveRoundCount([cn(1, 1), cn(2, 1)])).toBe(4);
  });

  it("PASS and PASS-with-known-findings rounds contribute 0 (CN, PASS, CN → 2)", () => {
    expect(
      effectiveRoundCount([cn(1), pass(2, "PASS"), cn(3), pass(4, "PASS-with-known-findings")])
    ).toBe(2);
  });

  it("a round with 3 regression findings still contributes exactly 2 (per-round, not per-finding)", () => {
    expect(effectiveRoundCount([cn(1, 3)])).toBe(2);
  });

  it("reset: r1..r3 CN (count 3) + continue authorization resetAtRound 3, then r4 CN → 1", () => {
    expect(effectiveRoundCount([cn(1), cn(2), cn(3), cn(4)], [cont(3)])).toBe(1);
  });

  it("two continue authorizations → the max resetAtRound wins", () => {
    expect(effectiveRoundCount([cn(1), cn(2), cn(3), cn(4)], [cont(1), cont(3)])).toBe(1);
  });

  it("CN round whose findings entirely omit regressionOf (key absent, not null) → contributes 1, not 2", () => {
    const noKey: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      findings: [{}, {}],
    };
    expect(effectiveRoundCount([noKey])).toBe(1);
    const noKey2: ShipRoundLike = {
      round: 2,
      verdict: "CHANGES-NEEDED",
      findings: [{}],
    };
    expect(effectiveRoundCount([noKey, noKey2])).toBe(2);
  });

  it("CN round with findings: [] → contributes 1", () => {
    expect(effectiveRoundCount([cn(1)])).toBe(1);
  });

  it("CN round with regressionOf: null explicitly → contributes 1 (existing behavior preserved)", () => {
    const explicitNull: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      findings: [{ regressionOf: null }],
    };
    expect(effectiveRoundCount([explicitNull])).toBe(1);
  });

  it("CN round with regressionOf set to an object → still contributes 2 (regression detection preserved)", () => {
    expect(effectiveRoundCount([cn(1, 1)])).toBe(2);
  });

  it("malformed rounds do not throw: missing findings array, and null/non-object finding entries → counted as plain", () => {
    const missingFindings = { round: 1, verdict: "CHANGES-NEEDED" } as unknown as ShipRoundLike;
    expect(() => effectiveRoundCount([missingFindings])).not.toThrow();
    expect(effectiveRoundCount([missingFindings])).toBe(1);

    const junkFindings: ShipRoundLike = {
      round: 2,
      verdict: "CHANGES-NEEDED",
      findings: [null, 42 as unknown as { regressionOf?: Record<string, unknown> | null }],
    };
    expect(() => effectiveRoundCount([junkFindings])).not.toThrow();
    expect(effectiveRoundCount([junkFindings])).toBe(1);
  });

  it("duplicate round numbers in the ledger: the last entry per round wins and the round is counted once", () => {
    const round1First = cn(1); // plain
    const round1Second = cn(1, 1); // same round number, later entry has a regression
    expect(effectiveRoundCount([round1First, round1Second])).toBe(2);

    const round1Dup = cn(1);
    const round1DupAgain = cn(1);
    expect(effectiveRoundCount([round1Dup, round1DupAgain])).toBe(1);
  });
});

describe("mergeRound", () => {
  it("overwrites in place on same round (same or new SHA), appends new rounds, never mutates input", () => {
    const r1 = { round: 1, reviewedHeadSha: "aaa" };
    const r2 = { round: 2, reviewedHeadSha: "bbb" };
    const rounds = [r1, r2];

    // same round + same SHA → overwrite in place, length unchanged
    const sameSha = mergeRound(rounds, { round: 1, reviewedHeadSha: "aaa" });
    expect(sameSha).toHaveLength(2);
    expect(sameSha[0]).toEqual({ round: 1, reviewedHeadSha: "aaa" });

    // same round + new SHA → overwrite (supersede)
    const newSha = mergeRound(rounds, { round: 1, reviewedHeadSha: "ccc" });
    expect(newSha).toHaveLength(2);
    expect(newSha[0].reviewedHeadSha).toBe("ccc");

    // new round → append
    const appended = mergeRound(rounds, { round: 3, reviewedHeadSha: "ddd" });
    expect(appended).toHaveLength(3);
    expect(appended[2]).toEqual({ round: 3, reviewedHeadSha: "ddd" });

    // input array is never mutated
    expect(rounds).toEqual([r1, r2]);
    expect(rounds).toHaveLength(2);
  });
});
