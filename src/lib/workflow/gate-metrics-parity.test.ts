import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { FLEET_KPIS, type CardSummary } from "./performance";
// The Lambda side of the boundary. Importing this module constructs AWS clients
// at module scope but performs no I/O — the same reason and the same precedent as
// lambda/orchestrator/replay-c2uqki-sweep-noop.test.mjs's import of it.
import { BAND_KPIS, computeGateRounds, summarize, summaryPathOf } from "../../../lambda/cost-report/index.mjs";
// The one prose→verdict ladder. Used here so the fixture's verdicts are DERIVED,
// never hand-typed: the pin below is worthless if the test states the verdicts it
// is about to count.
import { resolveVerdict } from "../../../lambda/orchestrator/verdict-contract.mjs";

/**
 * TEAM-4277 QA-1c — the gate-metric boundary between the cost-report Lambda and
 * `src/lib/workflow/performance.ts`.
 *
 * FR-D1.11 says performance.ts "mirrors the arithmetic" for `reworkRounds`,
 * `gateRounds` and `firstPassYield`. It does not, and deliberately so: those
 * three are computed in exactly ONE place, `computeGateRounds` in
 * lambda/cost-report/index.mjs, because no browser-side caller has the event
 * stream to compute them from (the fleet view reads `performance/index.json`,
 * which is what `summarize()` writes). A TS port would be dead code on day one.
 *
 * So the contract that actually exists is a boundary, not a twin: the Lambda
 * computes the numbers and owns the KPI vocabulary, performance.ts types them and
 * bands them, and until this file nothing compared the two. Unlike the other
 * `*-parity.test.ts` files here — which feed one matrix through two hand-ported
 * implementations — this one pins four claims about the seam:
 *
 *   (a) `summarize().quality` carries exactly the keys `CardSummary["quality"]`
 *       declares, so a key added Lambda-side without the type (or renamed under
 *       it) fails here rather than reading `undefined` in the UI;
 *   (b) the two `source` values `computeGateRounds` can really return are the two
 *       members of the `gateMetricSource` union;
 *   (c) `BAND_KPIS` (banded per-run) and `FLEET_KPIS` (banded fleet-wide) are the
 *       same KPIs with the same floors, units and directions — plus the explicit
 *       negative that `quality.gateRounds` is in neither;
 *   (d) the real ladder → the real `computeGateRounds` → the real card type, in
 *       one chain, over the dowtdh dossier.
 *
 * The Lambda-side arithmetic itself is pinned separately by
 * lambda/cost-report/index.test.mjs (run by `node --test lambda/cost-report`);
 * this file adds the TS-boundary claim, not a second copy of the arithmetic.
 */

// ─── (a) The card contract ────────────────────────────────────────────────────

/**
 * Every key `CardSummary["quality"]` declares, with `gateMetricSource` required.
 * `Required<…>` is what makes this a two-way check: tsc rejects this literal if a
 * declared key is missing or an undeclared one is present, and the test rejects
 * `summarize()` if its own key set differs from this one.
 */
const QUALITY_ON_THE_CARD: Required<CardSummary["quality"]> = {
  tasks: 12,
  reworkRounds: 2,
  changeRequests: 1,
  fixTickets: 3,
  loops: 4,
  nudges: 0,
  errors: 0,
  gateRounds: 3,
  firstPassYield: 0,
  humanGates: 2,
  gateMetricSource: "verdict-events",
};

/**
 * A card shaped like `buildCard`'s output (index.mjs:355-425) — only the fields
 * `summarize()` reads, with distinct values so a mis-wired key shows up as a
 * wrong value rather than a coincidence.
 */
const SYNTHETIC_CARD = {
  workflowId: "wf_test_gatemetrics",
  epicId: "TEAM-4000",
  workflowDefId: "feature-development",
  title: "synthetic",
  run: { phase: "complete", outcome: "complete", startedAt: "2026-09-08T00:00:00.000Z", completedAt: "2026-09-08T04:00:00.000Z", prUrl: "https://github.com/o/r/pull/1" },
  cost: {
    totalUsd: 40, personaUsd: 30, codingUsd: 10,
    tokens: { total: 900_000, input: 500_000, output: 100_000, cached: 300_000, cacheRead: 250_000, cacheWrite: 50_000 },
    cacheHitRate: 0.3, personaCacheHitRate: 0.4,
    byEngine: { strands: { usd: 30 }, claude_code: { usd: 10 } },
  },
  time: {
    wallMs: 14_400_000, activeMs: 10_800_000, agentWorkMs: 7_200_000, humanWaitMs: 3_600_000,
    busyMs: 6_000_000, idleMs: 4_800_000, agentUtilization: 0.55,
    humanGates: QUALITY_ON_THE_CARD.humanGates,
  },
  // The card's own quality block is a superset of the summary's (it also carries
  // outcome/tasksCompleted/gateReworks/interventions/retries/unblocks/prUrl) —
  // which is why (a) is a claim about `summarize()`, not about the card.
  quality: {
    outcome: "complete", tasksCompleted: 12, gateReworks: 0, interventions: 0, retries: 0, unblocks: 9,
    prUrl: "https://github.com/o/r/pull/1",
    ...QUALITY_ON_THE_CARD,
  },
  agents: { agentcore_hub_backend_dev: { usd: 12, workMs: 900_000, tasks: 2, reworkRounds: 1, engines: ["strands"] } },
  bands: { status: "ok", anomalies: [] },
  dataQuality: { gaps: [] },
};

describe("gate metrics — the card contract summarize() writes and CardSummary types", () => {
  it("summarize().quality is exactly the key set CardSummary['quality'] declares", () => {
    const quality = summarize(SYNTHETIC_CARD).quality;
    expect(Object.keys(quality).sort()).toEqual(Object.keys(QUALITY_ON_THE_CARD).sort());
  });

  it("carries the three FR-D1.11 metrics and their source through to the fleet index", () => {
    const quality = summarize(SYNTHETIC_CARD).quality;
    // The four fields the UI reads for gate accounting. `humanGates` is included
    // because it is the one summary field that moves GROUPS (card.time →
    // summary.quality) and is therefore the likeliest silent break.
    expect({
      reworkRounds: quality.reworkRounds,
      gateRounds: quality.gateRounds,
      firstPassYield: quality.firstPassYield,
      gateMetricSource: quality.gateMetricSource,
      humanGates: quality.humanGates,
    }).toEqual({ reworkRounds: 2, gateRounds: 3, firstPassYield: 0, gateMetricSource: "verdict-events", humanGates: 2 });
  });

  it("a card written before gateMetricSource existed summarizes as null, not undefined", () => {
    const legacyCard = {
      ...SYNTHETIC_CARD,
      quality: { ...SYNTHETIC_CARD.quality, gateMetricSource: undefined },
    };
    // `?? null` at index.mjs:632: the field must be PRESENT and null, because a
    // missing key reads as "no opinion" in JSON and `null` reads as "the legacy
    // definition" — the distinction performance.ts's optional type encodes.
    const quality = summarize(legacyCard).quality;
    expect("gateMetricSource" in quality).toBe(true);
    expect(quality.gateMetricSource).toBeNull();
  });
});

// ─── (b) The gateMetricSource union ──────────────────────────────────────────

type GateMetricSource = NonNullable<CardSummary["quality"]["gateMetricSource"]>;

/**
 * tsc-enforced exhaustiveness of the TS union: a member added to (or dropped
 * from) `gateMetricSource` in performance.ts fails THIS literal at compile time,
 * because `Record<GateMetricSource, true>` accepts neither a missing key nor an
 * extra one.
 */
const SOURCE_IS_DECLARED: Record<GateMetricSource, true> = {
  "verdict-events": true,
  reviewGateHistory: true,
};
const DECLARED_SOURCES = Object.keys(SOURCE_IS_DECLARED) as GateMetricSource[];

/**
 * The narrowing seam. `computeGateRounds` lives in a .mjs file, so tsc infers its
 * `source` as plain `string` (an object literal in JS widens) — it cannot check
 * membership for us, which is exactly why the Lambda could grow a third value
 * unnoticed. Everything downstream of this function IS typed as the union, so the
 * `CardSummary["quality"]` assignment in (d) is compile-checked, and a stranger
 * value fails loudly here instead of reaching a UI branch that ignores it.
 */
function asGateMetricSource(source: string): GateMetricSource {
  const declared = DECLARED_SOURCES.find((s) => s === source);
  if (!declared) throw new Error(`computeGateRounds returned an undeclared gateMetricSource: ${JSON.stringify(source)}`);
  return declared;
}

// ─── (c) KPI parity ──────────────────────────────────────────────────────────

const BAND_KEYS = BAND_KPIS.map((k) => summaryPathOf(k.path));
const FLEET_KEYS = FLEET_KPIS.map((k) => k.key);

describe("gate metrics — the banded-KPI vocabulary", () => {
  it("BAND_KPIS (per-run) and FLEET_KPIS (fleet) are the same KPIs once paths are summary paths", () => {
    expect(new Set(BAND_KEYS).size).toBe(BAND_KEYS.length);
    expect([...BAND_KEYS].sort()).toEqual([...FLEET_KEYS].sort());
  });

  it("and agree on floor, unit and direction for every one of them", () => {
    // Labels are deliberately NOT compared: the per-run card says "Total cost"
    // where the fleet view says "Cost per run" — same KPI, different sentence,
    // and forcing them equal would make the wording a parity concern.
    for (const band of BAND_KPIS) {
      const key = summaryPathOf(band.path);
      const fleet = FLEET_KPIS.find((k) => k.key === key);
      expect(fleet, `no FLEET_KPIS entry for ${key}`).toBeDefined();
      expect({ key, floor: band.floor, unit: band.unit, direction: band.direction ?? "upper" })
        .toEqual({ key, floor: fleet!.floor, unit: fleet!.unit, direction: fleet!.direction ?? "upper" });
    }
  });

  it("quality.gateRounds is banded on neither side, on purpose", () => {
    // Its two definitions are different UNITS: verdict-derived it counts gate
    // persona completions (dowtdh: 3), legacy it counts human review REQUESTS
    // (dowtdh: 0 — see the legacy control below). A band over a baseline mixing
    // both would compare completions against requests. `quality.reworkRounds` IS
    // banded because both of ITS definitions answer one question, "times the run
    // had to go back" (performance.ts:111-114).
    expect(BAND_KEYS).not.toContain("quality.gateRounds");
    expect(FLEET_KEYS).not.toContain("quality.gateRounds");
    // …and it is still ON the card. Unbanded is not unreported.
    expect(Object.keys(QUALITY_ON_THE_CARD)).toContain("gateRounds");
  });
});

// ─── (d) The dowtdh pin: ladder → Lambda metric → card type ──────────────────

type Dossier = {
  workflow: Record<string, unknown>;
  tickets: { ticketId: string; assignee: string; status: string }[];
  completions: Record<string, { ticket_id: string; summary: string; completed_at: string; verdict?: string }>;
};

const DOSSIER: Dossier = JSON.parse(
  readFileSync(new URL("../../../deploy/workflow-manager/toolkit/fixtures/dowtdh-dossier.json", import.meta.url), "utf8"),
);

/** wf_1788731227559_dowtdh's three gate tickets, in the order they completed. */
const GATE_TICKETS = ["TEAM-4180", "TEAM-4181", "TEAM-4182"];

/** The `agent.complete` stream the orchestrator would have published for them. */
function gateCompleteEvents() {
  return GATE_TICKETS.map((ticketId) => {
    const record = DOSSIER.completions[ticketId];
    const assignee = DOSSIER.tickets.find((t) => t.ticketId === ticketId)!.assignee;
    const { verdict, verdictSource } = resolveVerdict(record, assignee);
    return { type: "agent.complete", timestamp: record.completed_at, detail: { agentId: assignee, verdict }, verdictSource };
  });
}

describe("gate metrics — the dowtdh run, from the real ladder to the card type", () => {
  it("fixture integrity: the three verdicts are INFERRED from the fixture's prose, never declared", () => {
    for (const e of gateCompleteEvents()) {
      // If a fixture ever grows a structured `verdict`, the ladder would report
      // "declared" and this pin would stop proving that the prose ladder is what
      // produced the numbers below.
      expect(e.verdictSource).toBe("inferred");
    }
    expect(gateCompleteEvents().map((e) => [e.detail.agentId, e.detail.verdict])).toEqual([
      ["agentcore_hub_code_reviewer", "CHANGES_NEEDED"],
      ["agentcore_hub_qa_verifier", "FAIL"],
      ["agentcore_hub_ci_agent", "PASS"],
    ]);
  });

  it("computeGateRounds over those events: 3 gate rounds, 2 rework, zero first-pass yield", () => {
    const gates = computeGateRounds(DOSSIER.workflow, gateCompleteEvents());
    expect({
      gateRounds: gates.gateRounds,
      gateReworks: gates.gateReworks,
      reworkRounds: gates.reworkRounds,
      firstPassYield: gates.firstPassYield,
      source: gates.source,
    }).toEqual({
      // Three gate completions.
      gateRounds: 3,
      // `reviewGateHistory`-derived and therefore 0: this run's gates were
      // machine gates, not human review requests.
      gateReworks: 0,
      // The reviewer's CHANGES_NEEDED and QA's FAIL. CI's PASS is a gate round
      // but not rework (REWORK_PERSONAS excludes the CI agent).
      reworkRounds: 2,
      // Binary: not every gate passed on its first look.
      firstPassYield: 0,
      source: "verdict-events",
    });
  });

  it("the result assigns straight into CardSummary['quality'] — including the caller's ?? substitution", () => {
    const gates = computeGateRounds(DOSSIER.workflow, gateCompleteEvents());
    // The task-derived fallbacks the Lambda's caller holds (index.mjs:333-336).
    const taskReworkRounds = 5;
    const taskFirstPassYield = 0.75;
    const quality: CardSummary["quality"] = {
      tasks: 12,
      // `??`, not `||`: a real 0 verdict-derived rework must not be read as "no
      // signal". tsc is what proves this substitution is load-bearing —
      // `gates.reworkRounds` is `number | null` and the card's field is `number`.
      reworkRounds: gates.reworkRounds ?? taskReworkRounds,
      changeRequests: 0,
      fixTickets: 1,
      loops: 1,
      nudges: 0,
      errors: 0,
      gateRounds: gates.gateRounds,
      firstPassYield: gates.firstPassYield ?? taskFirstPassYield,
      humanGates: 4,
      gateMetricSource: asGateMetricSource(gates.source),
    };
    expect(quality.reworkRounds).toBe(2);
    expect(quality.firstPassYield).toBe(0);
    expect(quality.gateMetricSource).toBe("verdict-events");
  });

  it("legacy control: the same run with no verdict events falls back to reviewGateHistory", () => {
    const gates = computeGateRounds(DOSSIER.workflow, []);
    expect({
      gateRounds: gates.gateRounds,
      reworkRounds: gates.reworkRounds,
      firstPassYield: gates.firstPassYield,
      source: gates.source,
    }).toEqual({
      // The dossier carries no `reviewGateHistory` at all — so the legacy
      // definition scores a run with three machine gate rounds as zero. That gap
      // is the whole reason `gateMetricSource` is on the card and `gateRounds`
      // has no band.
      gateRounds: 0,
      // null = "no verdict signal, keep today's task-derived value"; the caller
      // substitutes at index.mjs:333-336.
      reworkRounds: null,
      firstPassYield: null,
      source: "reviewGateHistory",
    });
    const quality: CardSummary["quality"] = {
      tasks: 12, reworkRounds: gates.reworkRounds ?? 5, changeRequests: 0, fixTickets: 1, loops: 1,
      nudges: 0, errors: 0, gateRounds: gates.gateRounds, firstPassYield: gates.firstPassYield ?? 0.75,
      humanGates: 4, gateMetricSource: asGateMetricSource(gates.source),
    };
    expect(quality.reworkRounds).toBe(5);
    expect(quality.firstPassYield).toBe(0.75);
    expect(quality.gateMetricSource).toBe("reviewGateHistory");
  });

  it("those two are the only sources computeGateRounds can return, and both are declared", () => {
    const observed = [
      asGateMetricSource(computeGateRounds(DOSSIER.workflow, gateCompleteEvents()).source),
      asGateMetricSource(computeGateRounds(DOSSIER.workflow, []).source),
    ];
    // Set equality both ways: a union member no code path produces is as much a
    // drift as a produced value the union omits.
    expect(new Set(observed)).toEqual(new Set(DECLARED_SOURCES));
    // The event shapes the verdict path rejects — an unrecognized verdict string
    // and a non-gate persona — fall back rather than inventing a third source.
    for (const detail of [
      { agentId: "agentcore_hub_qa_verifier", verdict: "LOOKS_FINE_TO_ME" },
      { agentId: "agentcore_hub_backend_dev", verdict: "PASS" },
    ]) {
      const gates = computeGateRounds(DOSSIER.workflow, [{ type: "agent.complete", timestamp: "2026-09-06T23:19:17.074Z", detail }]);
      expect(asGateMetricSource(gates.source)).toBe("reviewGateHistory");
    }
  });
});
