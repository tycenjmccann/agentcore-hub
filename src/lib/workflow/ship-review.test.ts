import { describe, it, expect } from "vitest";
import {
  effectiveRoundCount,
  effectiveRoundCountDiffScoped,
  enforceDiffScope,
  diffScopeRounds,
  mergeRound,
} from "./ship-review";
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

// The `opts` param mirrors the reviewGate config field of the same name
// (workflow-defs.ts resolveReviewGateCap). Omitting it must be byte-identical
// to the pre-opts behavior: regressions always double.
describe("effectiveRoundCount — regressionCountsDouble opt", () => {
  it("omitted opts / empty opts / explicit true all double a regression round identically", () => {
    const rounds = [cn(1, 1), cn(2)]; // regression round + plain round
    expect(effectiveRoundCount(rounds)).toBe(3);
    expect(effectiveRoundCount(rounds, [])).toBe(3);
    expect(effectiveRoundCount(rounds, [], {})).toBe(3);
    expect(effectiveRoundCount(rounds, [], { regressionCountsDouble: undefined })).toBe(3);
    expect(effectiveRoundCount(rounds, [], { regressionCountsDouble: true })).toBe(3);
  });

  it("regressionCountsDouble: false → a regression round weighs 1, not 2", () => {
    expect(effectiveRoundCount([cn(1, 1)], [], { regressionCountsDouble: false })).toBe(1);
    // 2 regression rounds: 4 when doubling, 2 when not.
    expect(effectiveRoundCount([cn(1, 1), cn(2, 1)])).toBe(4);
    expect(effectiveRoundCount([cn(1, 1), cn(2, 1)], [], { regressionCountsDouble: false })).toBe(2);
  });

  it("regressionCountsDouble: false leaves non-regression accounting untouched", () => {
    const off = { regressionCountsDouble: false };
    // plain CN rounds are unaffected either way
    expect(effectiveRoundCount([cn(1), cn(2), cn(3)], [], off)).toBe(3);
    // PASS rounds still contribute 0
    expect(effectiveRoundCount([cn(1), pass(2, "PASS"), cn(3)], [], off)).toBe(2);
    // the reset boundary still applies
    expect(effectiveRoundCount([cn(1, 1), cn(2, 1), cn(3), cn(4)], [cont(3)], off)).toBe(1);
    // dedupe still applies (last entry per round wins)
    expect(effectiveRoundCount([cn(1), cn(1, 1)], [], off)).toBe(1);
  });

  it("the opt changes WHEN the cap trips: 2 regression rounds reach 4 with doubling but only 2 without", () => {
    const twoRegressions = [cn(1, 1), cn(2, 1)];
    const cap = 3;
    expect(effectiveRoundCount(twoRegressions) >= cap).toBe(true);
    expect(effectiveRoundCount(twoRegressions, [], { regressionCountsDouble: false }) >= cap).toBe(
      false
    );
  });
});

// ── Diff-scoped gate (TEAM-3689 / AC-D2.1) ───────────────────────────────────
// The deterministic enforcement of release-manager.md Step 4's DIFF-SCOPED GATE:
// a finding gates only if EVERY file it cites is inside the PR change set;
// everything else is downgraded to ADVISORY and can never flip the verdict.
describe("enforceDiffScope — diff-scoped gate (AC-D2.1)", () => {
  it("AC1: keeps CHANGES-NEEDED on an in-diff finding, downgrades an out-of-diff one to ADVISORY and strips its regressionOf", () => {
    const round: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      changeSet: ["src/a.ts", "src/b.ts"],
      findings: [
        // in-diff blocking finding, itself a regression
        { citedFiles: ["src/a.ts"], regressionOf: { round: 0, seam: "parser" } },
        // out-of-diff hygiene finding (pre-existing file), also labelled a regression
        { citedFiles: ["vendor/legacy.ts"], regressionOf: { round: 0, seam: "legacy" } },
      ],
    };
    const out = enforceDiffScope(round, round.changeSet);

    // The in-diff finding still gates.
    expect(out.verdict).toBe("CHANGES-NEEDED");
    expect(out.findings![0]).toMatchObject({
      classification: "IN-DIFF",
      citedFiles: ["src/a.ts"],
      regressionOf: { round: 0, seam: "parser" }, // kept: IN-DIFF findings may regress
    });
    // The out-of-diff finding is forced ADVISORY and can never gate or weigh double.
    expect(out.findings![1]).toMatchObject({
      classification: "ADVISORY",
      citedFiles: ["vendor/legacy.ts"],
    });
    expect(out.findings![1]).not.toHaveProperty("regressionOf");
    // The round still gates and (having an IN-DIFF regression) still weighs double.
    expect(effectiveRoundCountDiffScoped([round])).toBe(2);
  });

  it("defaults changeSet to the round's own changeSet field when the arg is omitted", () => {
    const round: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      changeSet: ["src/a.ts"],
      findings: [{ citedFiles: ["src/a.ts"] }, { citedFiles: ["out/x.ts"] }],
    };
    const out = enforceDiffScope(round);
    expect(out.findings!.map(f => f!.classification)).toEqual(["IN-DIFF", "ADVISORY"]);
    expect(out.verdict).toBe("CHANGES-NEEDED");
  });

  it("AC2: a CHANGES-NEEDED round whose ONLY findings are out-of-diff downgrades and counts as 0", () => {
    const round: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      changeSet: ["src/a.ts"],
      findings: [{ citedFiles: ["other/x.ts"] }, { citedFiles: ["other/y.ts"] }],
    };
    const out = enforceDiffScope(round);
    // Advisory findings remain → non-blocking form, not PASS.
    expect(out.verdict).toBe("PASS-with-known-findings");
    expect(out.findings!.every(f => f!.classification === "ADVISORY")).toBe(true);
    expect(effectiveRoundCountDiffScoped([round])).toBe(0);
  });

  it("AC2 (no findings): CHANGES-NEEDED with an empty findings array + a change set downgrades to PASS", () => {
    const round: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      changeSet: ["src/a.ts"],
      findings: [],
    };
    expect(enforceDiffScope(round).verdict).toBe("PASS");
    expect(effectiveRoundCountDiffScoped([round])).toBe(0);
  });

  it("a finding is IN-DIFF only if EVERY cited file is in the change set (one stray file → advisory)", () => {
    const round: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      changeSet: ["src/a.ts", "src/b.ts"],
      findings: [
        { citedFiles: ["src/a.ts", "src/b.ts"] }, // all in → IN-DIFF
        { citedFiles: ["src/a.ts", "out/c.ts"] }, // one out → ADVISORY
      ],
    };
    const out = enforceDiffScope(round);
    expect(out.findings!.map(f => f!.classification)).toEqual(["IN-DIFF", "ADVISORY"]);
    expect(out.verdict).toBe("CHANGES-NEEDED");
  });

  it("AC-c: rename/copy entries count as BOTH paths (raw --name-status R100/C075 tab form and `old -> new` arrow form)", () => {
    const changeSet = [
      "R100\told/path.ts\tnew/path.ts", // renamed: both paths in-diff
      "C075\tsrc/base.ts\tsrc/copy.ts", // copied: both paths in-diff
      "moved-old.ts -> moved-new.ts", // arrow form: both paths in-diff
      "M\tsrc/plain.ts", // status-prefixed plain path
      "./src/dotslash.ts", // normalized (leading ./ dropped)
    ];
    const inDiffCitations = [
      ["old/path.ts"],
      ["new/path.ts"],
      ["src/base.ts"],
      ["src/copy.ts"],
      ["moved-old.ts"],
      ["moved-new.ts"],
      ["src/plain.ts"],
      ["src/dotslash.ts"],
    ];
    for (const citedFiles of inDiffCitations) {
      const round: ShipRoundLike = {
        round: 1,
        verdict: "CHANGES-NEEDED",
        changeSet,
        findings: [{ citedFiles }],
      };
      const out = enforceDiffScope(round);
      expect(out.findings![0]!.classification, `expected IN-DIFF for ${citedFiles[0]}`).toBe(
        "IN-DIFF"
      );
      expect(out.verdict).toBe("CHANGES-NEEDED");
    }
    // A path that is on neither side of any rename stays advisory.
    const outside: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      changeSet,
      findings: [{ citedFiles: ["unrelated.ts"] }],
    };
    expect(enforceDiffScope(outside).findings![0]!.classification).toBe("ADVISORY");
    expect(enforceDiffScope(outside).verdict).toBe("PASS-with-known-findings");
  });

  it("AC-d: tolerant of malformed input — never throws, and contentless entries cannot block", () => {
    // TEAM-3756 F3a: a finding with substance but NO resolvable files is
    // UNATTRIBUTED and GATES — "we couldn't parse the citation" is not evidence
    // the finding is out-of-diff. (Before, prose-only citations classified
    // ADVISORY, so a genuine CHANGES-NEEDED with inDiffCount 0 silently
    // downgraded to PASS and the reopen was suppressed.)
    const noFiles: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      changeSet: ["src/a.ts"],
      findings: [{ severity: "P1" } as unknown as NonNullable<ShipRoundLike["findings"]>[number]],
    };
    expect(() => enforceDiffScope(noFiles)).not.toThrow();
    expect(enforceDiffScope(noFiles).findings![0]!.classification).toBe("UNATTRIBUTED");
    expect(enforceDiffScope(noFiles).verdict).toBe("CHANGES-NEEDED");
    expect(effectiveRoundCountDiffScoped([noFiles])).toBe(1); // still a rework round

    // Non-object finding entries + a genuinely CONTENTLESS finding ({} — no
    // substantive keys) → all advisory: ledger corruption, not a reviewer's
    // finding. This is where "malformed cannot block" still holds.
    const junk: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      changeSet: ["src/a.ts"],
      findings: [
        null,
        42 as unknown as NonNullable<ShipRoundLike["findings"]>[number],
        {},
      ],
    };
    expect(() => enforceDiffScope(junk)).not.toThrow();
    expect(effectiveRoundCountDiffScoped([junk])).toBe(0); // nothing can block

    // Missing findings array entirely.
    const missing = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      changeSet: ["src/a.ts"],
    } as unknown as ShipRoundLike;
    expect(() => enforceDiffScope(missing)).not.toThrow();
    expect(enforceDiffScope(missing).verdict).toBe("PASS"); // no in-diff findings, none at all

    // Non-array changeSet → treated as empty set (every finding out-of-diff),
    // still never throws.
    const badChangeSet: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      findings: [{ citedFiles: ["src/a.ts"] }],
    };
    expect(() => enforceDiffScope(badChangeSet, "not-an-array")).not.toThrow();
    expect(enforceDiffScope(badChangeSet, "not-an-array").findings![0]!.classification).toBe(
      "ADVISORY"
    );

    // A non-object round is returned untouched rather than throwing.
    expect(() => enforceDiffScope(null as unknown as ShipRoundLike, [])).not.toThrow();
    expect(enforceDiffScope(null as unknown as ShipRoundLike, [])).toBeNull();
  });

  it("AC-e: pure — the input round and its findings are not mutated", () => {
    const round: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      changeSet: ["src/a.ts"],
      findings: [
        { citedFiles: ["out/x.ts"], regressionOf: { round: 0 } },
        { citedFiles: ["src/a.ts"] },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(round));
    const out = enforceDiffScope(round);
    expect(round).toEqual(snapshot); // input unchanged
    expect(out).not.toBe(round); // fresh object returned
    expect(out.findings![0]).not.toBe(round.findings![0]);
  });

  it("AC-g: an out-of-diff regression can NOT weigh double; only an in-diff regression does", () => {
    const cs = ["src/a.ts"];
    // Only finding is an out-of-diff regression → downgraded, counts 0.
    const outOnly: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      changeSet: cs,
      findings: [{ citedFiles: ["other.ts"], regressionOf: { round: 0 } }],
    };
    expect(effectiveRoundCountDiffScoped([outOnly])).toBe(0);

    // In-diff plain finding + out-of-diff regression → gates but does NOT double
    // (the regression is stripped when the finding is downgraded to advisory).
    const mixed: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      changeSet: cs,
      findings: [
        { citedFiles: ["src/a.ts"] },
        { citedFiles: ["other.ts"], regressionOf: { round: 0 } },
      ],
    };
    expect(effectiveRoundCountDiffScoped([mixed])).toBe(1);

    // In-diff regression → doubles (contrast).
    const inDiffRegression: ShipRoundLike = {
      round: 1,
      verdict: "CHANGES-NEEDED",
      changeSet: cs,
      findings: [{ citedFiles: ["src/a.ts"], regressionOf: { round: 0 } }],
    };
    expect(effectiveRoundCountDiffScoped([inDiffRegression])).toBe(2);
  });

  // AC-D3.2 — the load-bearing invariant, stated once directly rather than
  // inferred from the cases above: for ANY change set, enforceDiffScope's output
  // obeys "CHANGES-NEEDED ⟺ at least one surviving IN-DIFF finding". A round can
  // never remain blocking on out-of-diff nits alone, and a downgraded round can
  // never count toward the cap. Every row is a CHANGES-NEEDED input; the column
  // records whether ANY cited finding is genuinely in-diff.
  it("AC-D3.2 invariant: post-enforce, CHANGES-NEEDED ⟺ ≥1 gating (IN-DIFF or UNATTRIBUTED) finding, and a downgrade always counts 0", () => {
    const cs = ["src/a.ts", "src/b.ts"];
    const rows: Array<{ name: string; findings: ShipRoundLike["findings"]; gates: boolean }> = [
      { name: "only out-of-diff", findings: [{ citedFiles: ["x/y.ts"] }], gates: false },
      // TEAM-3756 F3a: no resolvable files ≠ out-of-diff — an unattributable
      // finding GATES rather than silently downgrading a genuine rejection.
      { name: "no files cited (UNATTRIBUTED)", findings: [{ severity: "P1" } as unknown as NonNullable<ShipRoundLike["findings"]>[number]], gates: true },
      { name: "empty findings", findings: [], gates: false },
      // A single finding straddling the diff boundary affirmatively cites an
      // out-of-diff file → advisory → the whole round downgrades.
      { name: "one stray file in an otherwise in-diff finding", findings: [{ citedFiles: ["src/a.ts", "x/y.ts"] }], gates: false },
      { name: "one in-diff finding", findings: [{ citedFiles: ["src/a.ts"] }], gates: true },
      { name: "in-diff + out-of-diff mixed", findings: [{ citedFiles: ["src/b.ts"] }, { citedFiles: ["x/y.ts"] }], gates: true },
    ];

    for (const { name, findings, gates } of rows) {
      const round: ShipRoundLike = { round: 1, verdict: "CHANGES-NEEDED", changeSet: cs, findings };
      const out = enforceDiffScope(round, cs);
      const survivingGating = (out.findings ?? []).some(
        (f) => f && ["IN-DIFF", "UNATTRIBUTED"].includes((f as { classification?: string }).classification ?? "")
      );

      // The invariant, both directions.
      expect(survivingGating, `${name}: surviving gating finding should be ${gates}`).toBe(gates);
      if (gates) {
        expect(out.verdict, `${name}: keeps blocking`).toBe("CHANGES-NEEDED");
        expect(effectiveRoundCountDiffScoped([round]), `${name}: gating round counts`).toBeGreaterThan(0);
      } else {
        // No gating finding survives → the verdict is a non-blocking form and the
        // round is inert against the cap (this is why out-of-diff rounds are free).
        expect(out.verdict, `${name}: downgraded, never CHANGES-NEEDED`).not.toBe("CHANGES-NEEDED");
        expect(["PASS", "PASS-with-known-findings"], `${name}: non-blocking verdict`).toContain(out.verdict);
        expect(effectiveRoundCountDiffScoped([round]), `${name}: downgraded round counts 0`).toBe(0);
      }
    }
  });

  it("TEAM-3756 F3a: an unattributed finding keeps its regressionOf (weighs double) and re-enforcing is idempotent", () => {
    const round: ShipRoundLike = {
      round: 2,
      verdict: "CHANGES-NEEDED",
      changeSet: ["src/a.ts"],
      findings: [
        { severity: "P1", regressionOf: { round: 1 } } as unknown as NonNullable<ShipRoundLike["findings"]>[number],
        null, // corruption sentinel-to-be
      ],
    };
    const once = enforceDiffScope(round);
    expect(once.findings![0]!.classification).toBe("UNATTRIBUTED");
    expect((once.findings![0] as { regressionOf?: unknown }).regressionOf).toEqual({ round: 1 });
    expect(effectiveRoundCountDiffScoped([round])).toBe(2); // gates AND weighs double

    // Idempotent: a second pass must not promote the first pass's advisory
    // sentinel ({classification} only) to UNATTRIBUTED.
    const twice = enforceDiffScope(once);
    expect(twice.findings!.map((f) => f!.classification)).toEqual(
      once.findings!.map((f) => f!.classification)
    );
    expect(twice.verdict).toBe(once.verdict);
  });
});

describe("diffScopeRounds / effectiveRoundCountDiffScoped — inertness (backward compat)", () => {
  it("AC-f: a round WITHOUT a changeSet passes through byte-identical (same reference)", () => {
    const rounds: ShipRoundLike[] = [
      { round: 1, verdict: "CHANGES-NEEDED", findings: [{ regressionOf: { of: "x" } }] },
      { round: 2, verdict: "PASS", findings: [] },
    ];
    const scoped = diffScopeRounds(rounds);
    expect(scoped).toEqual(rounds);
    // Pass-through must not clone: the guard is truly inert for these rounds.
    expect(scoped[0]).toBe(rounds[0]);
    expect(scoped[1]).toBe(rounds[1]);
  });

  it("AC-f: a round with a NON-ARRAY changeSet is also treated as unscoped (inert)", () => {
    const rounds: ShipRoundLike[] = [
      { round: 1, verdict: "CHANGES-NEEDED", findings: [{}], changeSet: "M src/a.ts" },
    ];
    const scoped = diffScopeRounds(rounds);
    expect(scoped[0]).toBe(rounds[0]); // untouched
  });

  it("AC-f: effectiveRoundCountDiffScoped === effectiveRoundCount for a changeSet-free ledger", () => {
    const ledgers: Array<{
      rounds: ShipRoundLike[];
      auths?: AuthorizationLike[];
      opts?: { regressionCountsDouble?: boolean };
    }> = [
      { rounds: [] },
      { rounds: [cn(1), cn(2), cn(3)] },
      { rounds: [cn(1, 1), cn(2)] },
      { rounds: [cn(1), pass(2, "PASS"), cn(3)] },
      { rounds: [cn(1), cn(2), cn(3), cn(4)], auths: [cont(3)] },
      { rounds: [cn(1, 1), cn(2, 1)], opts: { regressionCountsDouble: false } },
    ];
    for (const { rounds, auths = [], opts = {} } of ledgers) {
      expect(effectiveRoundCountDiffScoped(rounds, auths, opts)).toBe(
        effectiveRoundCount(rounds, auths, opts)
      );
    }
  });

  it("mixes scoped and unscoped rounds in one ledger: only the changeSet-carrying round is diff-scoped", () => {
    const rounds: ShipRoundLike[] = [
      // legacy fingerprint-style round, no changeSet → counts as a plain CN round
      { round: 1, verdict: "CHANGES-NEEDED", findings: [{}] },
      // release-manager round whose only finding is out-of-diff → downgraded to 0
      {
        round: 2,
        verdict: "CHANGES-NEEDED",
        changeSet: ["src/a.ts"],
        findings: [{ citedFiles: ["out/x.ts"] }],
      },
    ];
    // 1 (round 1 counts) + 0 (round 2 downgraded) = 1
    expect(effectiveRoundCountDiffScoped(rounds)).toBe(1);
    // Without diff-scoping both would have counted.
    expect(effectiveRoundCount(rounds)).toBe(2);
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
