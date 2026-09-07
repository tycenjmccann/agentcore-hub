import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TERMINAL_PHASES,
  SHIP_BLOCKED_OUTCOMES,
  NO_OP_OUTCOMES,
  isTerminalPhase,
} from "./types";
// The orchestrator's mirror. It ships as a self-contained zip and cannot import
// a TS module, so the list is duplicated — this file is what keeps it honest.
import {
  TERMINAL_WORKFLOW_PHASES,
  SHIP_BLOCKED_OUTCOMES as SHIP_BLOCKED_MJS,
  NO_OP_OUTCOMES as NO_OP_MJS,
  notTerminalPhaseGuard,
  notTerminalPhaseFilter,
} from "../../../lambda/orchestrator/completion.mjs";

/**
 * TEAM-4247 D2 — the terminal-outcome parity web, in one place.
 *
 * "Which phases mean a run is FINISHED" is asserted in TypeScript, re-asserted in
 * four hand-written .mjs literals, once more in Python, and again in four API
 * routes. Nothing but review has ever bound them together, and they have drifted
 * before: TEAM-3755 F2 found completeWorkflow and claimTerminalOutcome refusing
 * DIFFERENT terminal sets, which let a completion race in behind an honest
 * deploy-blocked close and overwrite it with "complete".
 *
 * D2 adds a sixth value ("nothing-to-remove"), so the drift risk arrives again in
 * exactly the same shape. The consequences per site are asymmetric, which is why
 * each is pinned separately below:
 *   - completion.mjs      : a missed value = a terminal-claim CAS that lets a late
 *                           writer overwrite an honest outcome.
 *   - workflow-analyzer   : a missed value = the run is labelled "complete" in its
 *                           own dossier (and terminal-outcome-surfaces.test.ts
 *                           independently asserts this one against TERMINAL_PHASES).
 *   - anomaly-watcher     : a missed value = a closed run is nudged/escalated, so a
 *                           human is paged about a run with no work in it.
 *   - cost-report         : a missed value = the run is never scanned or carded.
 *   - run_outcomes.py     : the ONE Python copy (save_analysis.py imports it) — a
 *                           missed value means `else "complete"` rewrites the
 *                           outcome and a no-op sweep enters the baselines.
 *
 * Source-text assertions for the Python and the routes (no importable module /
 * mixed-shape literals); real imports wherever an import is possible.
 */

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf-8");

/** The values inside a `new Set([...])` literal named `name` in `source`. */
function setLiteral(source: string, name: string, file: string): string[] {
  const declared = source.match(
    new RegExp(`(?:const|export const) ${name} = new Set\\(\\[([^\\]]*)\\]\\)`)
  )?.[1];
  // Thrown, not soft-failed: a renamed constant makes every assertion below
  // vacuous, and a silently-passing parity test is worse than none.
  if (declared === undefined) throw new Error(`${name} = new Set([…]) not found in ${file}`);
  return declared
    .split(",")
    .map((v) => v.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

describe("the TS lists themselves", () => {
  it("SHIP_BLOCKED_OUTCOMES and NO_OP_OUTCOMES are disjoint, and neither is widened by the other", () => {
    // The constraint D2 was built under: a no-op sweep was NOT blocked. Folding
    // "nothing-to-remove" into SHIP_BLOCKED_OUTCOMES would put a healthy run
    // through the ship-verdict gates, the blocked-run EventBridge rule and the
    // blocked-run alerting.
    expect([...SHIP_BLOCKED_OUTCOMES]).toEqual(["deploy-blocked", "static-ci-only"]);
    expect([...NO_OP_OUTCOMES]).toEqual(["nothing-to-remove"]);
    const overlap = [...NO_OP_OUTCOMES].filter((o) =>
      (SHIP_BLOCKED_OUTCOMES as readonly string[]).includes(o)
    );
    expect(overlap).toEqual([]);
  });

  it("TERMINAL_PHASES is the union of the legacy three and both outcome lists", () => {
    expect([...TERMINAL_PHASES]).toEqual([
      "complete",
      "error",
      "cancelled",
      ...SHIP_BLOCKED_OUTCOMES,
      ...NO_OP_OUTCOMES,
    ]);
    for (const outcome of [...SHIP_BLOCKED_OUTCOMES, ...NO_OP_OUTCOMES]) {
      expect(isTerminalPhase(outcome), outcome).toBe(true);
    }
    // …and the predicate has not become "everything is terminal".
    for (const live of ["intake", "development", "review", "ship", "detection"]) {
      expect(isTerminalPhase(live), live).toBe(false);
    }
  });
});

describe("completion.mjs ≡ types.ts", () => {
  it("both outcome lists match member for member", () => {
    expect([...SHIP_BLOCKED_MJS]).toEqual([...SHIP_BLOCKED_OUTCOMES]);
    expect([...NO_OP_MJS]).toEqual([...NO_OP_OUTCOMES]);
  });

  it("TERMINAL_WORKFLOW_PHASES holds the same SET as TERMINAL_PHASES", () => {
    // Order differs by design (the .mjs list is complete/cancelled/error), so the
    // contract is set equality, not sequence equality.
    expect([...TERMINAL_WORKFLOW_PHASES].sort()).toEqual([...TERMINAL_PHASES].sort());
  });

  it("both DDB expression builders derive from that list, so no write can refuse a smaller set", () => {
    // This is the TEAM-3755 F2 bug expressed as an assertion: the guard (used by
    // every terminal-claim CAS) and the filter (used by the background sweeps) must
    // cover the whole list, including D2's new outcome.
    const guard = notTerminalPhaseGuard("#phase");
    expect(Object.values(guard.values).sort()).toEqual([...TERMINAL_PHASES].sort());
    for (const phase of TERMINAL_PHASES) {
      const key = Object.entries(guard.values).find(([, v]) => v === phase)?.[0];
      expect(guard.condition, phase).toContain(`#phase <> ${key}`);
    }
    const filter = notTerminalPhaseFilter("#p");
    expect(Object.values(filter.values).sort()).toEqual([...TERMINAL_PHASES].sort());
    for (const key of Object.keys(filter.values)) {
      expect(filter.filter, key).toContain(key);
    }
  });
});

describe("the .mjs literal mirrors ≡ types.ts", () => {
  // workflow-analyzer is ALSO asserted by
  // src/components/workflow/__tests__/terminal-outcome-surfaces.test.ts; it is
  // repeated here so this file fails as one for the whole web rather than sending
  // the reader to a components test to learn a Lambda drifted.
  const MIRRORS: Array<[string, string]> = [
    ["lambda/workflow-analyzer/index.mjs", "TERMINAL_PHASES"],
    ["lambda/anomaly-watcher/index.mjs", "TERMINAL_PHASES"],
    ["lambda/cost-report/index.mjs", "TERMINAL_PHASES"],
  ];

  for (const [file, name] of MIRRORS) {
    it(`${file} declares exactly the shared terminal set`, () => {
      const values = setLiteral(read(file), name, file);
      expect(values.sort()).toEqual([...TERMINAL_PHASES].sort());
    });
  }
});

describe("the Python toolkit ≡ types.ts", () => {
  const TOOLKIT = "deploy/workflow-manager/toolkit";
  const outcomes = read(`${TOOLKIT}/run_outcomes.py`);
  const saveAnalysis = read(`${TOOLKIT}/save_analysis.py`);

  /** The values inside a `NAME = {…}` set or `NAME = (…)` tuple literal. */
  function pyLiteral(source: string, name: string): string[] {
    const declared = source.match(new RegExp(`^${name} = [{(]([^})]*)[})]`, "m"))?.[1];
    if (declared === undefined) throw new Error(`${name} = … not found in run_outcomes.py`);
    return declared
      .split(",")
      .map((v) => v.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  it("run_outcomes.py holds every terminal outcome and the same no-op list", () => {
    expect(pyLiteral(outcomes, "RUN_OUTCOMES").sort()).toEqual([...TERMINAL_PHASES].sort());
    expect(pyLiteral(outcomes, "NO_OP_OUTCOMES")).toEqual([...NO_OP_OUTCOMES]);
  });

  it("run_outcomes.py imports nothing, so the pure toolkit can read it", () => {
    // compute_metrics.py and its unit tests must stay importable with no boto3 and
    // no AWS environment — which is why the shared list cannot live in
    // save_analysis.py (it reads os.environ["ARTIFACT_BUCKET"] at module load).
    expect(outcomes).not.toMatch(/^\s*(import|from)\s+\S/m);
  });

  it("save_analysis.py imports that list instead of re-declaring one", () => {
    // The pre-D2 shape: this file owned the literal and compute_metrics.py had no
    // notion of terminality at all. A second copy here is the drift this whole
    // file exists to prevent.
    expect(saveAnalysis).toMatch(/^from run_outcomes import .*\bRUN_OUTCOMES\b/m);
    expect(saveAnalysis).not.toMatch(/^RUN_OUTCOMES = /m);
  });

  it("the phase→outcome mapping still falls back to complete only for UNKNOWN phases", () => {
    // The fallback is what a missing value costs: `phase if phase in RUN_OUTCOMES
    // else "complete"` turns an unlisted honest outcome into a fake delivery.
    expect(saveAnalysis).toContain('run_outcome = phase if phase in RUN_OUTCOMES else "complete"');
  });
});

describe("the API routes that keep their own literal terminal sets", () => {
  // These four are NOT the full shared set — each is scoped to one decision, and
  // three of them deliberately still omit the ship-blocked outcomes (a pre-D2
  // question about whether work that DID happen may be coalesced onto / deleted /
  // archived). What D2 requires of all four is that a no-op sweep — a run that has
  // been over since the day it started — reads as finished.
  const ROUTES = [
    "src/app/api/workflow/start/route.ts",
    "src/app/api/workflow/[id]/route.ts",
    "src/app/api/workflow/[id]/analyze/route.ts",
    "src/app/api/workflow/[id]/archive/route.ts",
  ];

  for (const file of ROUTES) {
    it(`${file} treats every no-op outcome as terminal`, () => {
      const source = read(file);
      for (const outcome of NO_OP_OUTCOMES) {
        expect(source, `${file} is missing ${outcome}`).toContain(`"${outcome}"`);
      }
    });
  }

  it("cancel + complete SPREAD both shared lists rather than hardcoding either", () => {
    // These two write a terminal claim, so their guard must refuse the whole set —
    // a missing value here is the TEAM-3755 F2 bug: a cancel or a manual complete
    // racing in behind an honest close overwrites it. They spread the constants
    // instead of listing values, so the next outcome is picked up for free; pin
    // that, since importing SHIP_BLOCKED_OUTCOMES alone silently left D2 out.
    for (const file of [
      "src/app/api/workflow/[id]/cancel/route.ts",
      "src/app/api/workflow/[id]/complete/route.ts",
    ]) {
      const source = read(file);
      expect(source, file).toMatch(
        /import\s*\{[^}]*SHIP_BLOCKED_OUTCOMES[^}]*\}\s*from\s*["']@\/lib\/workflow\/types["']/
      );
      expect(source, file).toMatch(
        /import\s*\{[^}]*NO_OP_OUTCOMES[^}]*\}\s*from\s*["']@\/lib\/workflow\/types["']/
      );
      expect(source, file).toContain("...SHIP_BLOCKED_OUTCOMES");
      expect(source, file).toContain("...NO_OP_OUTCOMES");
    }
  });
});

describe("what D2 deliberately does NOT widen", () => {
  it("the analyzer EventBridge rule still fires only on complete + the ship-blocked closes", () => {
    // deploy/workflow-manager/deploy.sh's detail-type list is derived from
    // SHIP_BLOCKED_OUTCOMES by terminal-outcome-surfaces.test.ts. A no-op sweep
    // does not publish workflow.nothing_to_remove into that rule — auto-analysis of
    // no-op sweeps is not part of D2, and adding it here would break that test.
    const deploySh = read("deploy/workflow-manager/deploy.sh");
    for (const outcome of NO_OP_OUTCOMES) {
      expect(deploySh).not.toContain(`workflow.${outcome.replace(/-/g, "_")}`);
    }
  });
});
