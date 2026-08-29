import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * TEAM-3425 trust-boundary contract for .github/workflows/config-evals-gate.yml.
 *
 * This is the documented verification artifact for the trusted-base-harness
 * design (TRUST-1): a PR that mutates run-battery.mjs — or anything else the
 * battery job executes (evals/battery/lib/**, the npm dependency manifest) —
 * CANNOT influence the verdict artifact the publish job trusts, because the
 * runner that writes battery-results.json is checked out from the BASE
 * revision; the PR head contributes data only, through a fixed overlay
 * allow-list. These assertions pin that boundary (plus the CRED-2 same-repo
 * publication restrictions) so a future PR that weakens the workflow fails
 * the unit suite instead of silently reopening the hole.
 *
 * The repo carries no YAML dependency, so the workflow is checked
 * structurally: job blocks are sliced by their two-space-indented keys under
 * `jobs:` and asserted with string/regex matches against the literal
 * expressions GitHub evaluates.
 */

const workflowPath = resolve(
  __dirname,
  "..",
  "..",
  "..",
  ".github",
  "workflows",
  "config-evals-gate.yml",
);
const text = readFileSync(workflowPath, "utf8");

/**
 * The workflow text of one job, from its key to the next job's key, with
 * full-line comments stripped: the contract is about what the workflow DOES,
 * and the explanatory comments legitimately name the very strings (e.g.
 * `checks.create`) whose absence from the code these tests assert.
 */
function job(name: string): string {
  const jobsIdx = text.indexOf("\njobs:");
  expect(jobsIdx, "workflow has a jobs: block").toBeGreaterThan(-1);
  const body = text.slice(jobsIdx);
  // Job keys are the only bare `  key:` lines after `jobs:` — step/with keys
  // sit at ≥4 spaces and run/script payloads deeper still.
  const headers = [...body.matchAll(/^  ([a-z][a-z-]*):[ \t]*$/gm)];
  const i = headers.findIndex((m) => m[1] === name);
  expect(i, `job '${name}' exists`).toBeGreaterThan(-1);
  const start = headers[i].index!;
  const end = i + 1 < headers.length ? headers[i + 1].index! : body.length;
  return body
    .slice(start, end)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** Entries of a `NAME=( "…" "…" )` bash array inside a job's run block. */
function bashArray(jobText: string, arrayName: string): string[] {
  const m = jobText.match(new RegExp(`${arrayName}=\\(([^)]*)\\)`));
  expect(m, `bash array ${arrayName} present in the overlay step`).toBeTruthy();
  return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const battery = job("battery");
// with-blocks of the battery job's checkout steps, in order (payload sliced
// at the next `- ` step so assertions can't match neighboring steps).
const checkouts = battery
  .split(/uses: actions\/checkout@/)
  .slice(1)
  .map((chunk) => chunk.split(/\n {6}- /)[0]);

describe("battery job — trusted-base harness (TRUST-1)", () => {
  it("has exactly two checkouts: trusted base root + pr-head candidate data", () => {
    expect(checkouts).toHaveLength(2);
  });

  it("root checkout is the BASE revision, credential-free, at the workspace root", () => {
    const root = checkouts[0];
    expect(root).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(root).toContain("persist-credentials: false");
    // No path: → the harness that runs IS the base revision.
    expect(root).not.toContain("path:");
  });

  it("PR head checkout goes ONLY to pr-head/, credential-free", () => {
    const head = checkouts[1];
    expect(head).toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(head).toContain("path: pr-head");
    expect(head).toContain("persist-credentials: false");
  });

  it("npm ci runs BEFORE the head checkout and the overlay (deps come from base's manifest)", () => {
    const npmCi = battery.indexOf("npm ci");
    const headCheckout = battery.indexOf("path: pr-head");
    const overlay = battery.indexOf("OVERLAY_DIRS");
    expect(npmCi).toBeGreaterThan(-1);
    expect(headCheckout).toBeGreaterThan(-1);
    expect(overlay).toBeGreaterThan(-1);
    expect(npmCi).toBeLessThan(headCheckout);
    expect(npmCi).toBeLessThan(overlay);
  });

  it("the overlay allow-list carries candidate DATA only — never the harness or its rules", () => {
    const dirs = bashArray(battery, "OVERLAY_DIRS");
    const files = bashArray(battery, "OVERLAY_FILES");
    const allowList = [...dirs, ...files];
    expect(allowList.length).toBeGreaterThan(0);
    for (const entry of allowList) {
      // The referee: the runner and every lib it imports stay base.
      expect(entry, `allow-list entry '${entry}'`).not.toMatch(/evals\/battery\/lib/);
      expect(entry, `allow-list entry '${entry}'`).not.toMatch(/run-battery\.mjs|\.mjs$/);
      // The dependency manifest: npm ci already ran, and against base's copy.
      expect(entry, `allow-list entry '${entry}'`).not.toMatch(/package(-lock)?\.json/);
      // The gate workflows themselves.
      expect(entry, `allow-list entry '${entry}'`).not.toMatch(/\.github/);
      // The rules gate mode reads via `git show origin/$BASE_REF:` (B2) — the
      // working-tree copies stay base too, closing preflight/fallback paths.
      expect(entry, `allow-list entry '${entry}'`).not.toMatch(
        /thresholds\.json|baseline\.json|evals\/battery\/schema/,
      );
    }
    // Positive shape: the candidate config paths the gate exists to test.
    expect(dirs).toContain("deploy/runtime-agent/prompts");
    expect(dirs).toContain("deploy/workflow-manager");
    expect(dirs).toContain("blueprints");
    expect(files).toContain("src/config/workflows.json");
    expect(files).toContain("src/config/agents.json");
  });

  it("pr-head/ is deleted after the overlay so nothing later can reach head code", () => {
    expect(battery).toContain("rm -rf pr-head");
  });

  it("battery job cannot publish checks (HERM-1) and stays same-repo-only", () => {
    expect(battery).not.toMatch(/^\s*checks:\s*write/m);
    expect(battery).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
  });
});

describe("check publication restrictions (CRED-2 — same-repo-only gate)", () => {
  it("fork-guard publishes nothing: no checks:write, no checks.create — it fails the job instead", () => {
    const fg = job("fork-guard");
    // A fork run's read-only GITHUB_TOKEN cannot create check runs, so any
    // reappearing checks.create here would be a silent 403, not a guard.
    expect(fg).not.toMatch(/^\s*checks:\s*write/m);
    expect(fg).not.toContain("checks.create");
    expect(fg).toContain("permissions: {}");
    expect(fg).toContain(
      "github.event.pull_request.head.repo.full_name != github.repository",
    );
    expect(fg).toContain("exit 1");
  });

  it("skip-publish is same-repo-only (fork ungated PRs stay blocked by check absence)", () => {
    const sp = job("skip-publish");
    expect(sp).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
  });

  it("publish retains the same-repo guard", () => {
    const pub = job("publish");
    expect(pub).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
  });
});

describe("manifest overlay residual — HEAD manifest cannot drop a base-active case", () => {
  // The overlay step copies HEAD's evals/battery/manifest.json into the tree,
  // but the run set is fail-closed against it. resolveGateConfig reads the
  // BASE manifest via `git show` (lib/cases.mjs) and, for every base-active
  // id: errors when the case file is gone at HEAD ("a PR cannot remove a
  // gating case" — preflight FAIL), and returns retired-at-HEAD cases as
  // resurrectedCases (still gating); a HEAD manifest that drops an id while
  // the case file stays active fails preflight's exact-set cross-check.
  // Those mechanisms are behaviorally covered by gate-config.test.ts and
  // cases.test.ts. This static guard (same pattern as gate-hardening.test.ts)
  // pins the composition point that ties them into the actual run: the
  // runnable set must include gate.resurrectedCases, so no HEAD manifest or
  // status edit can silently drop a failing base case and PASS.
  it("run-battery.mjs composes the run set from pf.activeCases + gate.resurrectedCases", () => {
    const runner = readFileSync(resolve(__dirname, "..", "run-battery.mjs"), "utf8");
    expect(runner).toMatch(
      /const runnable = \[\.\.\.pf\.activeCases, \.\.\.\(gate\?\.resurrectedCases \|\| \[\]\)/,
    );
  });
});
