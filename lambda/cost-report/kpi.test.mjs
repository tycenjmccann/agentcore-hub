// TEAM-4484 — the deterministic quality score, card.kpi v1, $0 band semantics and
// the CI verdict.
//
// The score exists to be reproducible: same card in, same integer out, forever.
// So the contract is a FIXTURE (fixtures/kpi-cases.json) whose `expected` blocks
// were derived by hand from src/config/kpi.json, and every case is asserted
// exactly rather than "roughly". If the scorer and the fixture disagree, the
// fixture wins — it is the design, the code is the implementation.
// src/lib/workflow/performance.test.ts reads the same file so the TS mirror and
// this Lambda can never drift apart silently.
//
// R-3 is a testable property, not a style rule: every weight, tolerance, cap and
// grade threshold lives ONLY in src/config/kpi.json. The config invariants below
// are what make that checkable — Σ weights === 100, the six known kinds, and
// KPI_CONFIG byte-equal to the file the app reads through the symlink.
//
// Importing index.mjs evaluates its top-level `@aws-sdk/*` imports; see
// pricing.test.mjs's header for why that is safe offline and never ships. Nothing
// here touches AWS: computeKpi/buildKpiBlock/stampKpiBands/computeBands are pure,
// and deriveCiVerdict takes an injected getCompletion.
//
// Run: `node --test lambda/cost-report` from the repo root.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BAND_KPIS,
  KPI_CONFIG,
  REPORT_VERSION,
  buildKpiBlock,
  computeBands,
  computeKpi,
  deriveCiVerdict,
  guardWorkflow,
  readKpi,
  stampKpiBands,
  summarize,
} from "./index.mjs";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/kpi-cases.json", import.meta.url), "utf8"));
const CASES = FIXTURE.cases;
const caseNamed = (name) => {
  const c = CASES.find((x) => x.name === name);
  assert.ok(c, `fixture case "${name}" is missing`);
  return c;
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const score = (card) => computeKpi(card, KPI_CONFIG).score;

// ─── Config invariants (R-3) ──────────────────────────────────────────────────

describe("kpi.json is the only home for the numbers", () => {
  test("KPI_CONFIG is exactly src/config/kpi.json (the symlink resolves to one file)", () => {
    const fromSource = JSON.parse(readFileSync(new URL("../../src/config/kpi.json", import.meta.url), "utf8"));
    assert.deepStrictEqual(KPI_CONFIG, fromSource);
  });

  test("component weights sum to 100 — a full-evidence run is scored out of the whole", () => {
    const sum = KPI_CONFIG.quality.components.reduce((s, c) => s + c.weight, 0);
    assert.equal(sum, 100);
  });

  test("only the six v1 component kinds are in play", () => {
    // A seventh kind in the config with no branch in normalizeComponent would
    // silently exclude its component and renormalize the rest — a quiet score
    // change, not a crash. Pin the set.
    const kinds = new Set(KPI_CONFIG.quality.components.map((c) => c.kind));
    assert.deepStrictEqual([...kinds].sort(), ["count", "excess", "rate", "ratio", "sum", "verdict"]);
  });

  test("the fixture, the config and REPORT_VERSION agree on their versions", () => {
    assert.equal(REPORT_VERSION, 5);
    assert.equal(FIXTURE.reportVersion, REPORT_VERSION);
    assert.equal(FIXTURE.kpiVersion, KPI_CONFIG.kpiVersion);
  });

  test("grade thresholds are ordered high→low so the first match is the right one", () => {
    const mins = KPI_CONFIG.grades.map((g) => g.min);
    assert.deepStrictEqual(mins, [...mins].sort((a, b) => b - a));
    assert.equal(mins[mins.length - 1], 0, "the last grade must catch every score");
  });
});

describe("quality.score is a banded KPI like any other", () => {
  test("BAND_KPIS has 16 entries and quality.score is the 16th", () => {
    assert.equal(BAND_KPIS.length, 16);
    const k = BAND_KPIS.find((x) => x.path === "quality.score");
    assert.ok(k, "quality.score must be banded — a fixed threshold is not an anomaly");
    assert.equal(k.unit, "count");
    assert.equal(k.floor, 5);
    // Lower is worse for a score, unlike cost/time where higher is worse.
    assert.equal(k.direction, "lower");
  });

  test("the band reads summaries' quality.score directly (summaryPathOf adds no mapping)", () => {
    // summaryPathOf is module-private, so the identity is asserted where it
    // matters: if `quality.score` were rewritten to some compact path, the
    // baseline values would all be undefined and the band would be insufficient.
    const bands = computeBands(bandCard(), baselineSummaries());
    const band = bands.kpis["quality.score"];
    assert.equal(band.n, 6);
    assert.equal(band.median, 72.5); // median of 70..75
  });
});

// ─── The fixture is the contract ──────────────────────────────────────────────

describe("fixture: every compute case scores exactly what the design says", () => {
  for (const c of CASES.filter((x) => x.kind === "compute")) {
    test(`${c.name} → ${c.expected.score}/${c.expected.grade ?? "—"}`, () => {
      const kpi = computeKpi(c.card, KPI_CONFIG);
      assert.deepStrictEqual(
        {
          score: kpi.score, grade: kpi.grade, confidence: kpi.confidence,
          evidenceWeight: kpi.evidenceWeight, outcome: kpi.outcome,
          excluded: kpi.excluded, capsApplied: kpi.capsApplied,
        },
        {
          score: c.expected.score, grade: c.expected.grade, confidence: c.expected.confidence,
          evidenceWeight: c.expected.evidenceWeight, outcome: c.expected.outcome,
          excluded: c.expected.excluded ?? [], capsApplied: c.expected.capsApplied ?? [],
        },
        c.derivation,
      );

      // Per-component points at 4dp, in config order, plus `normalized` wherever
      // the fixture pins it (that is where the clamp and the tolerances live).
      assert.deepStrictEqual(
        kpi.components.map((x) => x.key),
        KPI_CONFIG.quality.components.map((x) => x.key),
      );
      for (const want of c.expected.components) {
        const got = kpi.components.find((x) => x.key === want.key);
        assert.equal(got.points, want.points, `${want.key}.points`);
        assert.equal(got.included, want.points !== null, `${want.key}.included`);
        if ("normalized" in want) assert.equal(got.normalized, want.normalized, `${want.key}.normalized`);
      }
    });
  }
});

describe("fixture: a v4 card is read, not scored", () => {
  for (const c of CASES.filter((x) => x.kind === "tolerate")) {
    test(`${c.name} survives every v5 reader`, () => {
      assert.equal(readKpi(c.card), null);
      const s = summarize(c.card); // must not throw on a card with no kpi/score
      assert.equal(s.kpi, null);
      assert.equal(s.quality.score, null);
      assert.equal(s.costMissing, false);
    });
  }
});

// ─── Scorer behaviour ─────────────────────────────────────────────────────────

describe("clamping", () => {
  test("a component past its tolerance scores 0, it does not go negative", () => {
    const kpi = computeKpi(caseNamed("clamp-loops-12").card, KPI_CONFIG);
    const loops = kpi.components.find((c) => c.key === "loops");
    assert.equal(loops.normalized, -0.5, "the card still SHOWS how far past the limit the run went");
    assert.equal(loops.points, 0, "…but one blown component may not eat another's contribution");
  });

  test("a component above 1 earns its full weight, never more", () => {
    const card = cleanCard({ quality: { firstPassYield: 1.5 } });
    const firstPass = computeKpi(card, KPI_CONFIG).components.find((c) => c.key === "firstPass");
    assert.equal(firstPass.normalized, 1.5);
    assert.equal(firstPass.points, 30);
    assert.equal(computeKpi(card, KPI_CONFIG).score, 100);
  });

  test("no component anywhere in the fixture earns outside [0, weight]", () => {
    for (const c of CASES.filter((x) => x.kind === "compute")) {
      for (const comp of computeKpi(c.card, KPI_CONFIG).components) {
        if (comp.points === null) continue;
        assert.ok(comp.points >= 0 && comp.points <= comp.weight, `${c.name}/${comp.key} = ${comp.points}`);
      }
    }
  });
});

describe("renormalisation and insufficient evidence", () => {
  test("an unknown CI verdict is excluded, not scored 0 — 95 of weight, confidence partial", () => {
    const kpi = computeKpi(caseNamed("worked-example-ci-unknown").card, KPI_CONFIG);
    assert.equal(kpi.evidenceWeight, 95);
    assert.equal(kpi.confidence, "partial");
    assert.deepStrictEqual(kpi.excluded, ["ci"]);
    // Scored 0 instead of excluded it would have been 69; renormalized it is 73.
    assert.equal(kpi.score, 73);
    assert.ok(kpi.score > computeKpi(caseNamed("worked-example-ci-fail").card, KPI_CONFIG).score);
  });

  test("below minEvidenceWeight there is no number — and no cap either", () => {
    // A run with nothing to go on must not be reported as capped: "capped at 69"
    // would imply a 69 was earned and then held back.
    const card = clone(caseNamed("tasks-zero").card);
    card.run.outcome = "deploy-blocked";
    const kpi = computeKpi(card, KPI_CONFIG);
    assert.equal(kpi.evidenceWeight, 45);
    assert.ok(kpi.evidenceWeight < KPI_CONFIG.quality.minEvidenceWeight);
    assert.equal(kpi.score, null);
    assert.equal(kpi.grade, null);
    assert.equal(kpi.confidence, "insufficient");
    assert.deepStrictEqual(kpi.capsApplied, []);
    assert.equal(kpi.outcome, "deploy-blocked", "the outcome is still reported, just not applied");
  });
});

describe("outcome caps", () => {
  const CAP_KEYS = Object.keys(KPI_CONFIG.outcomeCaps);

  test("every cap key is a terminal phase the fleet actually produces", () => {
    assert.deepStrictEqual(CAP_KEYS.sort(), ["cancelled", "deploy-blocked", "error", "static-ci-only"]);
  });

  for (const outcome of CAP_KEYS) {
    test(`a flawless run that ended "${outcome}" is capped, and the grade follows the cap`, () => {
      const cap = KPI_CONFIG.outcomeCaps[outcome];
      const card = cleanCard({ run: { outcome } });
      const kpi = computeKpi(card, KPI_CONFIG);
      assert.equal(computeKpi(cleanCard(), KPI_CONFIG).score, 100, "same inputs, complete → 100");
      assert.equal(kpi.score, cap);
      assert.deepStrictEqual(kpi.capsApplied, [{ kind: "outcome", outcome, cap }]);
      // The grade is taken AFTER the cap, so a capped flawless run reads as the cap's band.
      const capGrade = KPI_CONFIG.grades.find((g) => cap >= g.min).grade;
      assert.equal(kpi.grade, capGrade, `grade ${kpi.grade} != cap band ${capGrade}`);
    });
  }

  test("the cap is recorded only when it actually bit", () => {
    // This card earns exactly 69 on its own (Σ 69.4434 → 69), below the
    // deploy-blocked cap (89), so nothing is taken away and nothing is claimed.
    const card = clone(caseNamed("worked-example-ci-fail").card);
    card.run.outcome = "deploy-blocked";
    const kpi = computeKpi(card, KPI_CONFIG);
    assert.equal(kpi.score, 69);
    assert.ok(kpi.score < KPI_CONFIG.outcomeCaps["deploy-blocked"]);
    assert.deepStrictEqual(kpi.capsApplied, []);
  });

  test("an outcome with no cap is left alone", () => {
    const kpi = computeKpi(cleanCard({ run: { outcome: "complete" } }), KPI_CONFIG);
    assert.equal(kpi.score, 100);
    assert.deepStrictEqual(kpi.capsApplied, []);
  });
});

describe("purity", () => {
  test("the same card scores identically twice, down to every field", () => {
    for (const c of CASES.filter((x) => x.kind === "compute")) {
      assert.deepStrictEqual(computeKpi(c.card, KPI_CONFIG), computeKpi(c.card, KPI_CONFIG), c.name);
    }
  });

  test("scoring mutates neither the card nor the config", () => {
    const card = caseNamed("worked-example").card;
    const cardBefore = JSON.stringify(card);
    const configBefore = JSON.stringify(KPI_CONFIG);
    computeKpi(card, KPI_CONFIG);
    buildKpiBlock(card, KPI_CONFIG);
    assert.equal(JSON.stringify(card), cardBefore);
    assert.equal(JSON.stringify(KPI_CONFIG), configBefore);
  });
});

// ─── Monotonicity (§3.2) ──────────────────────────────────────────────────────
//
// The property that makes the score usable as a signal: nothing a run does worse
// can raise it. Asserted over a grid rather than one card, because the tolerances
// mean a perturbation can be a no-op at one point (already clamped to 0) and a
// real drop at another.
//
// changeRequests and fixTickets are NOT scorer inputs — `loops` is. They appear
// here because they are what actually opens a loop, and naming the cause is how
// the perturbation stays recognisable to a reader of the pipeline.

const PERTURBATIONS = [
  ["a change request opened another loop", (q) => { q.changeRequests += 1; q.loops += 1; }],
  ["a fix ticket opened another loop", (q) => { q.fixTickets += 1; q.loops += 1; }],
  ["reworkRounds +1", (q) => { q.reworkRounds += 1; }],
  ["errors +1", (q) => { q.errors += 1; }],
  ["nudges +1", (q) => { q.nudges += 1; }],
  ["interventions +1", (q) => { q.interventions += 1; }],
  ["gateRounds +1", (q) => { q.gateRounds += 1; }],
  ["ci pass→fail", (q) => { q.ci = { verdict: "fail", source: "fix-ticket:ci-open", ticketId: "TEAM-9" }; }],
  ["firstPassYield 0.8→0.7", (q) => { q.firstPassYield = 0.7; }],
];

describe("monotonicity: no perturbation can raise the score", () => {
  for (const tasks of [1, 5, 18]) {
    for (const loops of [0, 3, 8, 12]) {
      for (const errors of [0, 2, 6]) {
        test(`tasks=${tasks} loops=${loops} errors=${errors}`, () => {
          const base = gridCard({ tasks, loops, errors });
          const kpi = computeKpi(base, KPI_CONFIG);
          assert.equal(kpi.confidence, "full", "the grid must hold the inclusion set fixed");

          for (const [label, mutate] of PERTURBATIONS) {
            const worse = clone(base);
            mutate(worse.quality);
            const after = computeKpi(worse, KPI_CONFIG);
            assert.deepStrictEqual(after.excluded, kpi.excluded, `${label}: inclusion set changed`);
            assert.ok(after.score <= kpi.score, `${label}: ${after.score} > ${kpi.score}`);
          }

          // The eighth kind of "worse": the run did not finish cleanly.
          for (const outcome of Object.keys(KPI_CONFIG.outcomeCaps)) {
            const worse = clone(base);
            worse.run.outcome = outcome;
            assert.ok(score(worse) <= kpi.score, `outcome→${outcome}`);
          }
        });
      }
    }
  }
});

// ─── Grade boundaries ─────────────────────────────────────────────────────────
//
// `score >= min`, so each threshold belongs to the HIGHER grade. Every card below
// is the clean run with two dials turned: firstPassYield (0..30 points) and loops
// (0..20 points), which is enough to land on any integer in 50..100.

describe("grade boundaries", () => {
  const BOUNDARIES = [
    [1, 4, 90, "A"], [0.9667, 4, 89, "B"],
    [1, 8, 80, "B"], [0.9667, 8, 79, "C"],
    [0.6667, 8, 70, "C"], [0.6333, 8, 69, "D"],
    [0.3333, 8, 60, "D"], [0.3, 8, 59, "F"],
  ];
  for (const [firstPassYield, loops, expectedScore, expectedGrade] of BOUNDARIES) {
    test(`${expectedScore} is a ${expectedGrade}`, () => {
      const kpi = computeKpi(cleanCard({ quality: { firstPassYield, loops } }), KPI_CONFIG);
      assert.equal(kpi.score, expectedScore);
      assert.equal(kpi.grade, expectedGrade);
    });
  }

  test("a tie rounds UP — 92.5 is 93, not 92", () => {
    const kpi = computeKpi(caseNamed("round-half-up").card, KPI_CONFIG);
    const exact = kpi.components.reduce((s, c) => s + (c.points ?? 0), 0);
    assert.equal(exact, 92.5);
    assert.equal(kpi.score, 93);
  });
});

// ─── card.kpi v1 contract ─────────────────────────────────────────────────────

describe("buildKpiBlock", () => {
  for (const c of CASES.filter((x) => x.kind === "compute")) {
    test(`${c.name}: the block mirrors the card`, () => {
      const kpi = buildKpiBlock(c.card, KPI_CONFIG);
      assert.equal(kpi.version, KPI_CONFIG.kpiVersion);
      assert.equal(kpi.computedAt, c.card.generatedAt);

      const costMissing = !!c.card.dataQuality?.costMissing;
      assert.equal(kpi.cost.usd, costMissing ? null : c.card.cost.totalUsd);
      assert.equal(kpi.time.wallMs, c.card.time.wallMs);
      assert.equal(kpi.time.activeMs, c.card.time.activeMs);
      assert.equal(kpi.time.humanWaitMs, c.card.time.humanWaitMs);

      // Bands are stamped later, by the handler, once there is an index.
      for (const slot of ["cost", "time", "quality"]) {
        assert.equal(kpi[slot].band, "unknown");
        assert.equal(kpi[slot].z, null);
      }

      assert.deepStrictEqual(kpi.quality, computeKpi(c.card, KPI_CONFIG));
      // Where the fixture card carries quality.score (the copy buildCard stamps),
      // it must be the same integer — one source of truth, two places to read it.
      if (c.card.quality.score !== undefined) {
        assert.equal(c.card.quality.score, kpi.quality.score, "card.quality.score drifted from card.kpi.quality.score");
      }
    });
  }

  test("an unpriced run reports no cost, not a $0 cost", () => {
    const c = caseNamed("zero-cost-card");
    assert.equal(c.card.cost.totalUsd, 0);
    assert.equal(buildKpiBlock(c.card, KPI_CONFIG).cost.usd, null);
    // …and the quality score is untouched by the missing cost telemetry.
    assert.equal(buildKpiBlock(c.card, KPI_CONFIG).quality.score, 100);
  });
});

describe("summarize", () => {
  test("a v5 card carries the score, the grade and the confidence into the index", () => {
    const card = clone(caseNamed("real-full-card").card);
    card.kpi = buildKpiBlock(card, KPI_CONFIG); // exactly what buildCard does
    card.quality.score = card.kpi.quality.score;

    const s = summarize(card);
    assert.equal(s.quality.score, 77);
    assert.deepStrictEqual(s.kpi, {
      version: KPI_CONFIG.kpiVersion,
      quality: { score: 77, grade: "C", confidence: "full" },
    });
    assert.equal(s.costMissing, false);
    assert.equal(typeof s.costMissing, "boolean");
    // The components stay on the card — the index summary is deliberately small.
    assert.equal(s.kpi.quality.components, undefined);
  });

  test("an unpriced run is summarized as costMissing, and still summarized", () => {
    const card = fullCardFrom("real-full-card", (c) => {
      c.cost.totalUsd = 0;
      c.dataQuality.costMissing = true;
    });
    const s = summarize(card);
    assert.equal(s.costMissing, true);
    assert.equal(s.quality.score, 77, "the quality history of a $0 run is not lost");
  });
});

// ─── Bands ($0 semantics, §6) ─────────────────────────────────────────────────

describe("computeBands", () => {
  test("a $0 member counts toward time and quality, and only drops out of cost", () => {
    const bands = computeBands(bandCard(), baselineSummaries());
    assert.equal(bands.baseline.n, 6);
    assert.equal(bands.baseline.nCost, 5, "the one unpriced run is out of the cost pool");
    assert.ok(bands.baseline.nCost < bands.baseline.n);

    for (const k of BAND_KPIS) {
      const expected = k.path.startsWith("cost.") ? 5 : 6;
      assert.equal(bands.kpis[k.path].n, expected, k.path);
    }
  });

  test("a card we could not price abstains from its own cost bands", () => {
    const bands = computeBands(bandCard({ dataQuality: { costMissing: true } }), baselineSummaries());
    for (const k of BAND_KPIS) {
      const band = bands.kpis[k.path];
      if (k.path.startsWith("cost.")) {
        assert.equal(band.status, "unknown", k.path);
        assert.equal(band.z, null, k.path);
        assert.equal(band.value, null, k.path);
      } else {
        assert.ok(["ok", "warn", "alert"].includes(band.status), `${k.path} → ${band.status}`);
      }
    }
  });

  test("bands are a pure function of the index — the order of the summaries cannot matter", () => {
    const card = bandCard();
    const base = baselineSummaries();
    const expected = computeBands(card, base);
    // Fixed permutations rather than a random shuffle: a failure has to be
    // reproducible from the test name alone.
    for (const order of [
      [5, 4, 3, 2, 1, 0],
      [3, 0, 5, 1, 4, 2],
      [1, 2, 0, 5, 3, 4],
      [2, 5, 4, 0, 1, 3],
    ]) {
      assert.deepStrictEqual(computeBands(card, order.map((i) => base[i])), expected, order.join(","));
    }
  });

  test("a thin baseline is insufficient, not ok", () => {
    const bands = computeBands(bandCard(), baselineSummaries().slice(0, 3));
    assert.equal(bands.status, "insufficient");
    assert.equal(bands.baseline.n, 3);
    for (const k of BAND_KPIS) assert.equal(bands.kpis[k.path].status, "insufficient", k.path);
  });
});

// ─── stampKpiBands ────────────────────────────────────────────────────────────

describe("stampKpiBands", () => {
  test("a thin baseline yields insufficient/null — the band object has no z key at all", () => {
    const card = bandCard();
    card.kpi = buildKpiBlock(card, KPI_CONFIG);
    card.bands = computeBands(card, baselineSummaries().slice(0, 3));
    assert.equal("z" in card.bands.kpis["cost.totalUsd"], false, "the shape this defends against");

    stampKpiBands(card);
    for (const slot of ["cost", "time", "quality"]) {
      assert.equal(card.kpi[slot].band, "insufficient", slot);
      assert.equal(card.kpi[slot].z, null, slot);
    }
  });

  test("a real baseline copies the status and z of the three hero bands", () => {
    const card = bandCard();
    card.kpi = buildKpiBlock(card, KPI_CONFIG);
    card.bands = computeBands(card, baselineSummaries());
    stampKpiBands(card);
    for (const [slot, path] of [["cost", "cost.totalUsd"], ["time", "time.wallMs"], ["quality", "quality.score"]]) {
      assert.equal(card.kpi[slot].band, card.bands.kpis[path].status, slot);
      assert.equal(card.kpi[slot].z, card.bands.kpis[path].z, slot);
      assert.equal(typeof card.kpi[slot].z, "number");
    }
  });

  test("a missing band entry reads unknown, never undefined", () => {
    const card = bandCard();
    card.kpi = buildKpiBlock(card, KPI_CONFIG);
    card.bands = { kpis: {} };
    stampKpiBands(card);
    for (const slot of ["cost", "time", "quality"]) {
      assert.equal(card.kpi[slot].band, "unknown", slot);
      assert.equal(card.kpi[slot].z, null, slot);
    }
  });

  test("a run with no score gets a band verdict, and never a NaN", () => {
    // quality.score is null (insufficient evidence) while the baseline is thick:
    // bandFor has a median but no current value, so the verdict is "unknown".
    const card = bandCard({ quality: { score: null } });
    card.kpi = buildKpiBlock(card, KPI_CONFIG);
    card.bands = computeBands(card, baselineSummaries());
    stampKpiBands(card);
    assert.equal(card.bands.kpis["quality.score"].status, "unknown");
    assert.equal(card.kpi.quality.band, "unknown");
    assert.equal(card.kpi.quality.z, null);
    assert.equal(Number.isNaN(card.kpi.quality.z), false);
  });

  test("a v4 card has nothing to stamp and is left alone", () => {
    const card = clone(caseNamed("v4-card-no-kpi").card);
    const before = JSON.stringify(card);
    assert.equal(stampKpiBands(card), card);
    assert.equal(JSON.stringify(card), before);
    assert.doesNotThrow(() => stampKpiBands(undefined));
    assert.doesNotThrow(() => stampKpiBands({ kpi: null }));
  });
});

// ─── guardWorkflow (A1) ───────────────────────────────────────────────────────
//
// Pure by design — no DDB, no S3 — precisely so it can be unit-tested without
// mocking index.mjs's module-private clients (the handler itself, and the
// rebuildIndex D-17 re-stamp compare, still need a live-AWS or refactored
// integration test and are not covered here).

describe("guardWorkflow", () => {
  test("no workflow row at all → not-found, regardless of trigger", () => {
    assert.deepStrictEqual(guardWorkflow(undefined, { isEventBridge: false }), { skipped: "not-found" });
    assert.deepStrictEqual(guardWorkflow(null, { isEventBridge: true }), { skipped: "not-found" });
  });

  test("a direct invoke on a deleted workflow is refused", () => {
    const workflow = { phase: "complete", deleted: true };
    assert.deepStrictEqual(guardWorkflow(workflow, { isEventBridge: false }), { skipped: "deleted" });
  });

  test("a direct invoke on a still-running workflow is refused", () => {
    const workflow = { phase: "development" };
    assert.deepStrictEqual(guardWorkflow(workflow, { isEventBridge: false }), { skipped: "not-terminal" });
  });

  test("every terminal phase clears a direct invoke", () => {
    for (const phase of ["complete", "cancelled", "error", "deploy-blocked", "static-ci-only"]) {
      assert.equal(guardWorkflow({ phase }, { isEventBridge: false }), null, phase);
    }
  });

  test("the EventBridge path is untouched by deleted/not-terminal — it only ever fires on workflow.complete", () => {
    assert.equal(guardWorkflow({ phase: "development" }, { isEventBridge: true }), null);
    assert.equal(guardWorkflow({ phase: "complete", deleted: true }, { isEventBridge: true }), null);
  });
});

// ─── CI verdict (§4) ──────────────────────────────────────────────────────────
//
// getCompletion is a plain map lookup here — the whole reason it is injected.

const CI = "agentcore_hub_ci_agent";
const completions = (map) => async (ticketId) => map[ticketId] ?? null;
const ciTask = (ticketId, completedAt) => ({ ticketId, agentId: CI, status: "complete", completedAt });

describe("deriveCiVerdict", () => {
  test("rule 1: a CI fix ticket still open at the terminal state is a red build", async () => {
    const workflow = { agentTasks: { "TEAM-2": { title: "Fix (CI): npm test is red", status: "in-progress" } } };
    assert.deepStrictEqual(await deriveCiVerdict(workflow, [], completions({})), {
      verdict: "fail", source: "fix-ticket:ci-open", ticketId: "TEAM-2",
    });
  });

  test("rule 1: provenance counts even when the title was renamed", async () => {
    const workflow = { agentTasks: { "TEAM-3": { title: "Chase the flaky spec", status: "open", spawnedBy: { kind: "ci_fix" } } } };
    const got = await deriveCiVerdict(workflow, [], completions({}));
    assert.equal(got.verdict, "fail");
    assert.equal(got.ticketId, "TEAM-3");
  });

  test("rule 1: a CI fix that got done is not evidence of a red build", async () => {
    const workflow = { agentTasks: { "TEAM-2": { title: "Fix (CI): npm test is red", status: "complete" } } };
    const tasks = [ciTask("TEAM-9", "2026-09-05T10:00:00.000Z")];
    const got = await deriveCiVerdict(workflow, tasks, completions({ "TEAM-9": { ci_status: "certified" } }));
    assert.equal(got.verdict, "pass");
  });

  test("rule 1 outranks a certified record — the fix is what the certification is being redone for", async () => {
    const workflow = { agentTasks: { "TEAM-8": { title: "Fix (CI): head is red again", status: "in-progress" } } };
    const tasks = [ciTask("TEAM-9", "2026-09-05T10:00:00.000Z")];
    const got = await deriveCiVerdict(workflow, tasks, completions({ "TEAM-9": { ci_status: "certified" } }));
    assert.deepStrictEqual(got, { verdict: "fail", source: "fix-ticket:ci-open", ticketId: "TEAM-8" });
  });

  test("rule 1: several open CI fixes → the lowest ticket id, deterministically", async () => {
    const workflow = {
      agentTasks: {
        "TEAM-31": { title: "Fix (CI): lint", status: "open" },
        "TEAM-12": { title: "Fix (CI): unit", status: "open" },
        "TEAM-20": { title: "Fix (CI): build", status: "in-progress" },
      },
    };
    assert.equal((await deriveCiVerdict(workflow, [], completions({}))).ticketId, "TEAM-12");
  });

  test("rule 2: ci_status certified", async () => {
    const tasks = [ciTask("TEAM-9", "2026-09-05T10:00:00.000Z")];
    assert.deepStrictEqual(await deriveCiVerdict({}, tasks, completions({ "TEAM-9": { ci_status: "Certified" } })), {
      verdict: "pass", source: "completion:certified", ticketId: "TEAM-9",
    });
  });

  test("rule 3: ci_status github-actions-proxy", async () => {
    const tasks = [ciTask("TEAM-9", "2026-09-05T10:00:00.000Z")];
    assert.deepStrictEqual(await deriveCiVerdict({}, tasks, completions({ "TEAM-9": { ci_status: " github-actions-proxy " } })), {
      verdict: "pass", source: "completion:github-actions-proxy", ticketId: "TEAM-9",
    });
  });

  test("rule 4: something merged — the branch protection that let it through is the evidence", async () => {
    const merged = { agentTasks: { "TEAM-40": { mergeCommit: "deadbee" } } };
    assert.deepStrictEqual(await deriveCiVerdict(merged, [], completions({})), {
      verdict: "pass", source: "merge-commit", ticketId: null,
    });
    const shipped = { agentTasks: { "TEAM-41": { outcome: "shipped" } } };
    assert.equal((await deriveCiVerdict(shipped, [], completions({}))).source, "merge-commit");
    // An empty string is not a merge commit.
    const blank = { agentTasks: { "TEAM-42": { mergeCommit: "   " } } };
    assert.equal((await deriveCiVerdict(blank, [], completions({}))).verdict, "unknown");
  });

  test("rule 5: explicitly unverified names the ticket that said so", async () => {
    const tasks = [ciTask("TEAM-9", "2026-09-05T10:00:00.000Z")];
    assert.deepStrictEqual(await deriveCiVerdict({}, tasks, completions({ "TEAM-9": { ci_status: "unverified" } })), {
      verdict: "unknown", source: "completion:unverified", ticketId: "TEAM-9",
    });
  });

  test("rule 5: no CI ticket and nothing merged → unknown, with no ticket to blame", async () => {
    assert.deepStrictEqual(await deriveCiVerdict({ agentTasks: {} }, [], completions({})), {
      verdict: "unknown", source: "none", ticketId: null,
    });
    // A CI ticket that never wrote a record is the same answer.
    const tasks = [ciTask("TEAM-9", "2026-09-05T10:00:00.000Z")];
    assert.deepStrictEqual(await deriveCiVerdict({}, tasks, completions({})), {
      verdict: "unknown", source: "none", ticketId: null,
    });
  });

  test("several CI tickets → the latest completion wins", async () => {
    const tasks = [
      ciTask("TEAM-9", "2026-09-05T10:00:00.000Z"),
      ciTask("TEAM-21", "2026-09-05T18:00:00.000Z"), // the re-run after a fix
      ciTask("TEAM-15", "2026-09-05T12:00:00.000Z"),
    ];
    const got = await deriveCiVerdict({}, tasks, completions({
      "TEAM-9": { ci_status: "unverified" },
      "TEAM-15": { ci_status: "unverified" },
      "TEAM-21": { ci_status: "certified" },
    }));
    assert.deepStrictEqual(got, { verdict: "pass", source: "completion:certified", ticketId: "TEAM-21" });
  });

  test("a tie on completedAt breaks on ascending ticket id", async () => {
    const at = "2026-09-05T18:00:00.000Z";
    const tasks = [ciTask("TEAM-30", at), ciTask("TEAM-14", at), ciTask("TEAM-22", at)];
    const got = await deriveCiVerdict({}, tasks, completions({
      "TEAM-14": { ci_status: "certified" },
      "TEAM-22": { ci_status: "unverified" },
      "TEAM-30": { ci_status: "unverified" },
    }));
    assert.equal(got.ticketId, "TEAM-14");
    assert.equal(got.verdict, "pass");
  });

  test("a read failure is recorded as a gap, not reported as silence", async () => {
    const gaps = [];
    const boom = async () => { throw new Error("AccessDenied"); };
    const tasks = [ciTask("TEAM-9", "2026-09-05T10:00:00.000Z")];
    const got = await deriveCiVerdict({ agentTasks: {} }, tasks, boom, gaps);
    assert.deepStrictEqual(got, { verdict: "unknown", source: "none", ticketId: null });
    assert.deepStrictEqual(gaps, ["ci verdict unavailable: could not read completions/TEAM-9.json"]);
  });

  test("a read failure never throws out of the card build", async () => {
    const boom = async () => { throw new Error("Throttled"); };
    const tasks = [ciTask("TEAM-9", "2026-09-05T10:00:00.000Z")];
    await assert.doesNotReject(() => deriveCiVerdict({}, tasks, boom));
  });

  test("static-ci-only is not a CI failure — it is a run that never claimed a build", async () => {
    const workflow = { phase: "static-ci-only", agentTasks: {} };
    const tasks = [ciTask("TEAM-9", "2026-09-05T10:00:00.000Z")];
    const got = await deriveCiVerdict(workflow, tasks, completions({ "TEAM-9": { ci_status: "github-actions-proxy" } }));
    assert.equal(got.verdict, "pass");
    const kpi = computeKpi(caseNamed("static-ci-only").card, KPI_CONFIG);
    assert.equal(kpi.components.find((c) => c.key === "ci").points, 5);
    // Bounded by its outcome ceiling, never zeroed by CI.
    assert.ok(kpi.score <= KPI_CONFIG.outcomeCaps["static-ci-only"]);
  });

  test("a workflow row with no agentTasks map at all is survivable", async () => {
    assert.deepStrictEqual(await deriveCiVerdict(undefined, undefined, completions({})), {
      verdict: "unknown", source: "none", ticketId: null,
    });
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** The clean run, with any section shallow-overridden. */
function cleanCard(over = {}) {
  const base = clone(caseNamed("clean-run").card);
  for (const [section, patch] of Object.entries(over)) {
    base[section] = { ...base[section], ...patch };
  }
  return base;
}

/** A monotonicity-grid card: everything scored, nothing excluded. */
function gridCard({ tasks, loops, errors }) {
  return {
    generatedAt: "2026-09-10T00:00:00.000Z",
    run: { outcome: "complete" },
    cost: { totalUsd: 12.5 },
    time: { wallMs: 3_600_000, activeMs: 3_000_000, humanWaitMs: 600_000, humanGates: 2 },
    quality: {
      tasks, loops, errors,
      reworkRounds: 1, firstPassYield: 0.8,
      changeRequests: 1, fixTickets: 1,
      nudges: 0, interventions: 0, gateRounds: 2,
      ci: { verdict: "pass", source: "completion:certified", ticketId: "TEAM-9" },
    },
    dataQuality: { costMissing: false },
  };
}

/** A card shaped for the band tests: every banded path present. */
function bandCard(over = {}) {
  const card = {
    reportVersion: REPORT_VERSION,
    generatedAt: "2026-09-10T00:00:00.000Z",
    workflowId: "wf_under_test",
    workflowDefId: "feature-delivery",
    run: { outcome: "complete", completedAt: "2026-09-10T00:00:00.000Z" },
    cost: {
      totalUsd: 12, personaUsd: 7, codingUsd: 5, personaCacheHitRate: 0.8,
      tokens: { input: 100_000, output: 20_000, cacheRead: 800_000, cacheWrite: 40_000, cached: 800_000, total: 960_000 },
    },
    time: { wallMs: 1_003_000, activeMs: 900_000, agentWorkMs: 800_000, humanWaitMs: 100_000, humanGates: 2 },
    quality: {
      tasks: 12, reworkRounds: 2, loops: 2, nudges: 0, errors: 0,
      firstPassYield: 0.9, gateRounds: 2, changeRequests: 1, fixTickets: 1,
      interventions: 0, ci: { verdict: "pass" }, score: 72,
    },
    dataQuality: { costMissing: false },
  };
  for (const [section, patch] of Object.entries(over)) {
    card[section] = { ...card[section], ...patch };
  }
  return card;
}

/**
 * Six index summaries for the same def inside the window — one of them unpriced.
 * BASELINE_MIN is 5, so the cost pool (5) is still thick enough to band: the
 * point of the test is that dropping the $0 run costs cost-banding nothing and
 * would have cost the time/quality history a whole sample.
 */
function baselineSummaries() {
  const dayMs = 86_400_000;
  const end = Date.parse("2026-09-10T00:00:00.000Z");
  return [0, 1, 2, 3, 4, 5].map((i) => ({
    workflowId: `wf_baseline_${i}`,
    workflowDefId: "feature-delivery",
    completedAt: new Date(end - (i + 1) * dayMs).toISOString(),
    cost: {
      total: i === 3 ? 0 : 10 + i, // wf_baseline_3 is the run we could not price
      persona: 6 + i, coding: 4, tokens: 900_000 + i * 1000, personaCacheHitRate: 0.8,
    },
    time: { wall: 1_000_000 + i * 1000, active: 900_000, agentWork: 800_000, humanWait: 100_000 },
    quality: {
      tasks: 10 + i, reworkRounds: i, loops: i, nudges: 0, errors: 0,
      firstPassYield: 0.9, score: 70 + i,
    },
  }));
}

/** The full v5 card with kpi + quality.score assembled the way buildCard does. */
function fullCardFrom(name, mutate = () => {}) {
  const card = clone(caseNamed(name).card);
  mutate(card);
  card.kpi = buildKpiBlock(card, KPI_CONFIG);
  card.quality.score = card.kpi.quality.score;
  return card;
}
