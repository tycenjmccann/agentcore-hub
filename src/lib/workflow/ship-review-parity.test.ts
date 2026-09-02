import { describe, it, expect } from "vitest";
import {
  effectiveRoundCount as effectiveRoundCountTs,
  effectiveRoundCountDiffScoped as effectiveRoundCountDiffScopedTs,
  enforceDiffScope as enforceDiffScopeTs,
  diffScopeRounds as diffScopeRoundsTs,
  mergeRound as mergeRoundTs,
} from "./ship-review";
// The orchestrator (Lambda) port. Both copies MUST agree bit-for-bit — a drift
// means the orchestrator's cap enforcement and the release manager's own round
// accounting disagree about when the rework loop is over, which is the runaway-
// rework bug TEAM-3619 D2c closes.
import {
  effectiveRoundCount as effectiveRoundCountMjs,
  effectiveRoundCountDiffScoped as effectiveRoundCountDiffScopedMjs,
  enforceDiffScope as enforceDiffScopeMjs,
  diffScopeRounds as diffScopeRoundsMjs,
  mergeRound as mergeRoundMjs,
} from "../../../lambda/orchestrator/ship-review.mjs";
import type { ShipRoundLike, AuthorizationLike } from "./ship-review";

/**
 * TEAM-3619 parity contract: feed the SAME (rounds × authorizations × opts)
 * matrix through both effectiveRoundCount implementations and assert identical
 * numbers, then the same for mergeRound. This is the guard that keeps the
 * hand-port honest — same role as lease-parity.test.ts for TEAM-3618.
 */

type Verdict = ShipRoundLike["verdict"];
const VERDICTS: Verdict[] = ["CHANGES-NEEDED", "PASS", "PASS-with-known-findings"];

// Finding-array shapes spanning every branch of the regression predicate:
// absent key, explicit null, a real regressionOf object, junk entries, and the
// malformed cases the ledger can legitimately contain.
const FINDING_SHAPES: Array<ShipRoundLike["findings"]> = [
  undefined, // key absent entirely
  [], // empty
  [{}], // finding with no regressionOf key
  [{ regressionOf: null }], // explicit null → not a regression
  [{ regressionOf: { of: "x" } }], // a real regression
  [{}, { regressionOf: { of: "y" } }], // mixed — one regression is enough
  [null], // null entry
  [42 as unknown as { regressionOf?: Record<string, unknown> | null }], // non-object entry
  "not-an-array" as unknown as ShipRoundLike["findings"], // non-array findings
];

const AUTHORIZATION_SETS: AuthorizationLike[][] = [
  [],
  [{ decision: "continue", resetAtRound: 0 }],
  [{ decision: "continue", resetAtRound: 1 }],
  [{ decision: "continue", resetAtRound: 2 }],
  [{ decision: "continue", resetAtRound: 99 }],
  [{ decision: "cancel", resetAtRound: 2 }], // non-continue must not reset
  [{ decision: "merge-with-known-findings", resetAtRound: 2 }],
  [
    { decision: "continue", resetAtRound: 1 },
    { decision: "continue", resetAtRound: 3 },
  ], // max wins
  [
    { decision: "continue", resetAtRound: 3 },
    { decision: "cancel", resetAtRound: 9 },
  ],
];

const OPT_SETS: Array<undefined | { regressionCountsDouble?: boolean }> = [
  undefined,
  {},
  { regressionCountsDouble: true },
  { regressionCountsDouble: false },
  { regressionCountsDouble: undefined },
];

describe("effectiveRoundCount parity: ship-review.ts ≡ ship-review.mjs", () => {
  it("agrees on every verdict × findings-shape × authorizations × opts combination", () => {
    let compared = 0;
    for (const verdict of VERDICTS) {
      for (const findings of FINDING_SHAPES) {
        for (const auths of AUTHORIZATION_SETS) {
          for (const opts of OPT_SETS) {
            // Two rounds so the reset boundary and the per-round (not
            // per-finding) weighting both stay observable.
            const rounds: ShipRoundLike[] = [
              { round: 1, verdict, findings },
              { round: 2, verdict: "CHANGES-NEEDED", findings },
            ];
            const label =
              `verdict=${verdict} findings=${JSON.stringify(findings)} ` +
              `auths=${JSON.stringify(auths)} opts=${JSON.stringify(opts)}`;
            const ts =
              opts === undefined
                ? effectiveRoundCountTs(rounds, auths)
                : effectiveRoundCountTs(rounds, auths, opts);
            const mjs =
              opts === undefined
                ? effectiveRoundCountMjs(rounds, auths)
                : effectiveRoundCountMjs(rounds, auths, opts);
            expect(mjs, `mismatch for ${label}`).toBe(ts);
            compared++;
          }
        }
      }
    }
    expect(compared).toBe(
      VERDICTS.length * FINDING_SHAPES.length * AUTHORIZATION_SETS.length * OPT_SETS.length
    );
  });

  it("agrees with both optional arguments omitted", () => {
    const rounds: ShipRoundLike[] = [
      { round: 1, verdict: "CHANGES-NEEDED", findings: [{ regressionOf: { of: "x" } }] },
    ];
    expect(effectiveRoundCountMjs(rounds)).toBe(effectiveRoundCountTs(rounds));
  });

  it("agrees on empty input and on duplicate round numbers", () => {
    expect(effectiveRoundCountMjs([])).toBe(effectiveRoundCountTs([]));
    const dupes: ShipRoundLike[] = [
      { round: 1, verdict: "CHANGES-NEEDED", findings: [] },
      { round: 1, verdict: "CHANGES-NEEDED", findings: [{ regressionOf: { of: "x" } }] },
      { round: 2, verdict: "PASS", findings: [] },
      { round: 2, verdict: "CHANGES-NEEDED", findings: [] },
    ];
    expect(effectiveRoundCountMjs(dupes)).toBe(effectiveRoundCountTs(dupes));
    expect(effectiveRoundCountMjs(dupes, [], { regressionCountsDouble: false })).toBe(
      effectiveRoundCountTs(dupes, [], { regressionCountsDouble: false })
    );
  });

  it("agrees on a realistic escalating ledger, round by round", () => {
    const rounds: ShipRoundLike[] = [];
    for (let i = 1; i <= 6; i++) {
      rounds.push({
        round: i,
        verdict: i % 3 === 0 ? "PASS" : "CHANGES-NEEDED",
        findings: i % 2 === 0 ? [{ regressionOf: { round: i - 1 } }] : [{}],
      });
      // Assert at every prefix length, not just the final ledger.
      expect(effectiveRoundCountMjs(rounds)).toBe(effectiveRoundCountTs(rounds));
      expect(effectiveRoundCountMjs(rounds, [{ decision: "continue", resetAtRound: 2 }])).toBe(
        effectiveRoundCountTs(rounds, [{ decision: "continue", resetAtRound: 2 }])
      );
    }
  });
});

// Diff-scoped gate (TEAM-3689). enforceDiffScope / diffScopeRounds /
// effectiveRoundCountDiffScoped are a hand-ported pair just like the arithmetic
// above; the deterministic gate is worthless if the orchestrator's copy and the
// canonical TS copy classify a finding differently, so pin them on the AC
// fixtures plus the malformed shapes the ledger can legitimately contain.
type DiffScopeFixture = { round: ShipRoundLike; changeSet?: unknown };
const DIFF_SCOPE_FIXTURES: DiffScopeFixture[] = [
  // AC1: mixed in-diff + out-of-diff (with regressions), verdict stays CN.
  {
    round: {
      round: 1,
      verdict: "CHANGES-NEEDED",
      changeSet: ["src/a.ts", "src/b.ts"],
      findings: [
        { citedFiles: ["src/a.ts"], regressionOf: { round: 0, seam: "parser" } },
        { citedFiles: ["vendor/legacy.ts"], regressionOf: { round: 0 } },
      ],
    },
  },
  // AC2: only out-of-diff → downgraded to the non-blocking form.
  {
    round: {
      round: 2,
      verdict: "CHANGES-NEEDED",
      changeSet: ["src/a.ts"],
      findings: [{ citedFiles: ["out/x.ts"] }, { citedFiles: ["out/y.ts"] }],
    },
  },
  // AC2: CN + empty findings → PASS.
  { round: { round: 3, verdict: "CHANGES-NEEDED", changeSet: ["src/a.ts"], findings: [] } },
  // AC-c: rename/copy forms — tab R100/C075 and arrow, both paths in-diff.
  {
    round: {
      round: 4,
      verdict: "CHANGES-NEEDED",
      changeSet: ["R100\told/p.ts\tnew/p.ts", "C075\tsrc/base.ts\tsrc/copy.ts", "a.ts -> b.ts", "M\tsrc/plain.ts"],
      findings: [
        { citedFiles: ["old/p.ts"] },
        { citedFiles: ["b.ts"] },
        { citedFiles: ["src/copy.ts", "src/plain.ts"] },
        { citedFiles: ["nope.ts"] },
      ],
    },
  },
  // AC-d: malformed — null / non-object / no-files / empty finding, present changeSet.
  {
    round: {
      round: 5,
      verdict: "CHANGES-NEEDED",
      changeSet: ["src/a.ts"],
      findings: [
        null,
        42 as unknown as NonNullable<ShipRoundLike["findings"]>[number],
        { severity: "P1" } as unknown as NonNullable<ShipRoundLike["findings"]>[number],
        {},
      ],
    },
  },
  // AC-d: missing findings array entirely.
  { round: { round: 6, verdict: "CHANGES-NEEDED", changeSet: ["src/a.ts"] } as ShipRoundLike },
  // AC-d: non-array changeSet passed explicitly → treated as empty set.
  {
    round: { round: 7, verdict: "CHANGES-NEEDED", findings: [{ citedFiles: ["src/a.ts"] }] },
    changeSet: "M src/a.ts",
  },
  // `files` alias instead of citedFiles; dot-slash + leading-slash normalization.
  {
    round: {
      round: 8,
      verdict: "CHANGES-NEEDED",
      changeSet: ["src/a.ts", "src/b.ts"],
      findings: [{ files: ["./src/a.ts"] }, { files: ["/src/b.ts"] }, { files: ["out/z.ts"] }],
    },
  },
  // PASS round with a change set → verdict untouched, findings still classified.
  {
    round: {
      round: 9,
      verdict: "PASS",
      changeSet: ["src/a.ts"],
      findings: [{ citedFiles: ["out/x.ts"] }],
    },
  },
  // No changeSet at all → inert pass-through (both the round and the value).
  { round: { round: 10, verdict: "CHANGES-NEEDED", findings: [{ regressionOf: { of: "x" } }] } },
];

describe("enforceDiffScope parity: ship-review.ts ≡ ship-review.mjs", () => {
  it("classifies findings and sets the verdict identically across the AC + malformed fixtures", () => {
    for (const { round, changeSet } of DIFF_SCOPE_FIXTURES) {
      const label = `round=${JSON.stringify(round)} changeSet=${JSON.stringify(changeSet)}`;
      const ts =
        changeSet === undefined ? enforceDiffScopeTs(round) : enforceDiffScopeTs(round, changeSet);
      const mjs =
        changeSet === undefined
          ? enforceDiffScopeMjs(round)
          : enforceDiffScopeMjs(round, changeSet);
      expect(mjs, `enforceDiffScope mismatch for ${label}`).toEqual(ts);
    }
  });

  it("agrees on a non-object round (returned untouched, not thrown)", () => {
    expect(enforceDiffScopeMjs(null as unknown as ShipRoundLike, [])).toBe(
      enforceDiffScopeTs(null as unknown as ShipRoundLike, [])
    );
  });
});

describe("diffScopeRounds / effectiveRoundCountDiffScoped parity: ship-review.ts ≡ ship-review.mjs", () => {
  const allRounds = DIFF_SCOPE_FIXTURES.map(f => f.round);

  it("diffScopeRounds returns deep-equal ledgers", () => {
    expect(diffScopeRoundsMjs(allRounds)).toEqual(diffScopeRoundsTs(allRounds));
  });

  it("effectiveRoundCountDiffScoped agrees on every fixture individually and on the whole ledger", () => {
    for (const { round } of DIFF_SCOPE_FIXTURES) {
      expect(
        effectiveRoundCountDiffScopedMjs([round]),
        `count mismatch for round ${round.round}`
      ).toBe(effectiveRoundCountDiffScopedTs([round]));
    }
    expect(effectiveRoundCountDiffScopedMjs(allRounds)).toBe(
      effectiveRoundCountDiffScopedTs(allRounds)
    );
    // With a reset authorization and regressionCountsDouble off, too.
    const auths: AuthorizationLike[] = [{ decision: "continue", resetAtRound: 3 }];
    expect(effectiveRoundCountDiffScopedMjs(allRounds, auths, { regressionCountsDouble: false })).toBe(
      effectiveRoundCountDiffScopedTs(allRounds, auths, { regressionCountsDouble: false })
    );
  });
});

describe("mergeRound parity: ship-review.ts ≡ ship-review.mjs", () => {
  type Entry = { round: number; reviewedHeadSha: string };
  const base: Entry[] = [
    { round: 1, reviewedHeadSha: "aaa" },
    { round: 2, reviewedHeadSha: "bbb" },
  ];

  it("agrees on append, same-round overwrite, and empty-list cases", () => {
    const entries: Entry[] = [
      { round: 1, reviewedHeadSha: "aaa" }, // same round, same SHA
      { round: 1, reviewedHeadSha: "ccc" }, // same round, new SHA
      { round: 2, reviewedHeadSha: "zzz" },
      { round: 3, reviewedHeadSha: "ddd" }, // new round → append
      { round: 0, reviewedHeadSha: "eee" }, // lower round → append
    ];
    for (const entry of entries) {
      expect(mergeRoundMjs(base, entry)).toEqual(mergeRoundTs(base, entry));
      expect(mergeRoundMjs([], entry)).toEqual(mergeRoundTs([], entry));
    }
  });

  it("neither implementation mutates its input", () => {
    const tsInput = base.map((r) => ({ ...r }));
    const mjsInput = base.map((r) => ({ ...r }));
    mergeRoundTs(tsInput, { round: 1, reviewedHeadSha: "ccc" });
    mergeRoundMjs(mjsInput, { round: 1, reviewedHeadSha: "ccc" });
    expect(tsInput).toEqual(base);
    expect(mjsInput).toEqual(base);
  });
});
