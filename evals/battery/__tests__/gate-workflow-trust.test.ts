// Trust contract of the CI gate workflows (TEAM-3425, ship-review of PR #199).
//
// The publish job trusts the battery job's artifact, so the acceptance
// invariant is: a PR that mutates run-battery.mjs (or anything else that
// executes) must NOT be able to influence the verdict artifact — the harness
// runs from the PR's BASE revision and only the candidate config is overlaid
// from the PR head. And for fork PRs, the check must come from the workflow_run
// publisher (a fork run's GITHUB_TOKEN is read-only, so nothing inside the
// gate workflow itself can ever checks.create for them), which never executes
// fork code and never trusts the fork run's artifacts.
//
// These are structural properties of the real workflow files, so the tests
// parse the YAML and assert on the parsed jobs/steps — a later edit that
// silently regresses the boundary fails here first.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const load = (rel: string): any =>
  parse(readFileSync(join(REPO_ROOT, ".github", "workflows", rel), "utf8"));

const gate = load("config-evals-gate.yml");
const forkPublish = load("config-evals-gate-fork-publish.yml");
const baselineWf = load("config-evals-baseline.yml");

const gateJobs: Record<string, any> = gate.jobs;
const battery = gateJobs.battery;

const steps = (job: any): any[] => job?.steps ?? [];
/** Whitespace-collapsed job-level if: (handles folded >- scalars). */
const jobIf = (job: any): string => String(job?.if ?? "").replace(/\s+/g, " ").trim();
/** Everything a job could execute or hand to github-script. */
const jobCode = (job: any): string =>
  steps(job)
    .map((s) => `${s.run ?? ""}\n${s.with?.script ?? ""}`)
    .join("\n");

/** gatedPrefixes/gatedFiles string arrays out of a github-script body. */
function gatedLists(script: string): { prefixes: string[]; files: string[] } {
  const grab = (name: string) => {
    const m = script.match(new RegExp(`${name} = \\[([\\s\\S]*?)\\];`));
    expect(m, `${name} array not found in script`).toBeTruthy();
    return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };
  return { prefixes: grab("gatedPrefixes"), files: grab("gatedFiles") };
}

// The exact candidate-config allowlist: what the battery scores, and the ONLY
// thing the PR head may contribute to the battery job's working tree.
const CANDIDATE_PATHS = [
  "deploy/runtime-agent/prompts",
  "deploy/workflow-manager",
  "blueprints",
  "src/config/workflows.json",
  "src/config/agents.json",
];

const SAME_REPO = "github.event.pull_request.head.repo.full_name == github.repository";

describe("FINDING 1 — a PR mutating run-battery.mjs cannot influence the verdict artifact", () => {
  const checkouts = steps(battery).filter((s) => String(s.uses ?? "").startsWith("actions/checkout"));

  it("the battery job's WORKING TREE is the trusted base sha, credential-free", () => {
    // Exactly one checkout targets the workspace (no `path:`) — that is what
    // `node evals/battery/run-battery.mjs` executes from.
    const workspace = checkouts.filter((s) => !s.with?.path);
    expect(workspace).toHaveLength(1);
    expect(workspace[0].with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(workspace[0].with?.["persist-credentials"]).toBe(false);
  });

  it("the PR head lands only in a side directory as data, credential-free", () => {
    const side = checkouts.filter((s) => s.with?.path);
    expect(side).toHaveLength(1);
    expect(side[0].with?.path).toBe("pr-head");
    expect(side[0].with?.ref).toBe("${{ github.event.pull_request.head.sha }}");
    expect(side[0].with?.["persist-credentials"]).toBe(false);
  });

  it("the overlay allowlist is exactly the candidate paths — never the harness, workflows, or lockfile", () => {
    const overlay = steps(battery).find((s) => String(s.run ?? "").includes("candidates=("));
    expect(overlay).toBeTruthy();
    const entries = [...overlay.run.match(/candidates=\(([\s\S]*?)\)/)![1].matchAll(/"([^"]+)"/g)].map(
      (m: RegExpMatchArray) => m[1]
    );
    expect(entries).toEqual(CANDIDATE_PATHS);
    for (const forbidden of ["evals/battery", ".github", "package.json", "package-lock.json"])
      expect(entries.some((e: string) => e.includes(forbidden))).toBe(false);
  });

  it("the overlay script never copies anything from pr-head outside the allowlist loop", () => {
    const overlay = steps(battery).find((s) => String(s.run ?? "").includes("candidates=("));
    // Every non-comment line that touches the PR-head tree must be one of: the
    // existence probe, the single loop-body copy, or the final deletion. Any
    // new $HEAD_DIR/pr-head reference is a trust-boundary change and must be
    // reviewed here.
    const headDirLines = String(overlay.run)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => (l.includes("HEAD_DIR") || l.includes("pr-head")) && !l.startsWith("#"));
    const allowed = [
      /^if \[ -e "\$HEAD_DIR\/\$p" \]; then$/,
      /^cp -R -- "\$HEAD_DIR\/\$p" "\$p"$/,
      /^rm -rf -- "\$HEAD_DIR"$/,
    ];
    for (const line of headDirLines)
      expect(
        allowed.some((re) => re.test(line)),
        `unexpected pr-head reference in overlay step: '${line}'`
      ).toBe(true);
    expect(overlay.env?.HEAD_DIR).toBe("pr-head");
    // And the harness/config paths never appear as copy sources or targets.
    expect(overlay.run.match(/cp .*evals\/battery/)).toBeNull();
    expect(overlay.run.match(/cp .*\.github/)).toBeNull();
    expect(overlay.run.match(/cp .*package(-lock)?\.json/)).toBeNull();
  });

  it("the run step executes the base checkout's runner against the base sha, reporting the head sha as config", () => {
    const stepList = steps(battery);
    const runIdx = stepList.findIndex((s) => String(s.run ?? "").includes("run-battery.mjs"));
    const run = stepList[runIdx];
    expect(run).toBeTruthy();
    expect(run.run).toMatch(/node evals\/battery\/run-battery\.mjs/);
    expect(run.run).toMatch(/--base-ref "\$BASE_SHA"/);
    expect(run.run).toMatch(/--config-sha "\$HEAD_SHA"/);
    expect(run.env?.BASE_SHA).toBe("${{ github.event.pull_request.base.sha }}");
    expect(run.env?.HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    // Overlay (and pr-head deletion) happens strictly before any node process,
    // and a dedicated provenance step re-asserts worktree == base.sha with
    // pr-head/ gone before the runner starts.
    const overlayIdx = stepList.findIndex((s) => String(s.run ?? "").includes("candidates=("));
    const assertIdx = stepList.findIndex((s) => s.name === "Assert the working tree is the base revision");
    expect(overlayIdx).toBeGreaterThanOrEqual(0);
    expect(assertIdx).toBeGreaterThan(overlayIdx);
    expect(runIdx).toBeGreaterThan(assertIdx);
    expect(stepList[assertIdx].run).toContain('"$checked_out" != "$BASE_SHA"');
    expect(stepList[assertIdx].run).toContain("-e pr-head");
  });

  it("HERM-1 split holds: battery cannot publish; only the no-checkout publisher jobs hold checks:write", () => {
    expect(battery.permissions).toEqual({ contents: "read", "id-token": "write" });
    const withChecksWrite = Object.entries(gateJobs)
      .filter(([, job]: [string, any]) => job.permissions?.checks === "write")
      .map(([name]) => name);
    expect(withChecksWrite.sort()).toEqual(["publish", "skip-publish"]);
    // Neither publisher checks out (= executes) any code.
    for (const name of withChecksWrite)
      expect(steps(gateJobs[name]).some((s) => String(s.uses ?? "").includes("checkout"))).toBe(false);
  });
});

describe("FINDING 2 — fork PRs: no in-workflow checks.create; the workflow_run publisher owns the check", () => {
  it("battery, publish, and skip-publish all require a same-repo head in their if:", () => {
    for (const name of ["battery", "publish", "skip-publish"])
      expect(jobIf(gateJobs[name]), `${name} must be same-repo only`).toContain(SAME_REPO);
  });

  it("no job reachable by a fork PR calls checks.create (fork-notice is permissionless)", () => {
    const forkNotice = gateJobs["fork-notice"];
    expect(forkNotice).toBeTruthy();
    expect(forkNotice.permissions).toEqual({});
    expect(jobCode(forkNotice)).not.toContain("checks.create");
    expect(steps(forkNotice).some((s) => String(s.uses ?? "").includes("checkout"))).toBe(false);
    // There is no fork-guard job left to attempt a doomed checks.create.
    expect(gateJobs["fork-guard"]).toBeUndefined();
  });

  it("the fork publisher is workflow_run-triggered, fork-only, and holds exactly checks:write + pull-requests:read", () => {
    expect(forkPublish.on.workflow_run.workflows).toEqual(["Config Evals Gate"]);
    expect(forkPublish.on.workflow_run.types).toEqual(["completed"]);
    expect(forkPublish.permissions).toEqual({});
    expect(Object.keys(forkPublish.jobs)).toEqual(["publish-fork-check"]);
    const job = forkPublish.jobs["publish-fork-check"];
    expect(jobIf(job)).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(jobIf(job)).toContain(
      "github.event.workflow_run.head_repository.full_name != github.repository"
    );
    expect(job.permissions).toEqual({ checks: "write", "pull-requests": "read" });
  });

  it("the fork publisher never checks out code and never downloads the fork run's artifacts", () => {
    const job = forkPublish.jobs["publish-fork-check"];
    const uses = steps(job).map((s) => String(s.uses ?? ""));
    expect(uses.some((u) => u.includes("checkout"))).toBe(false);
    expect(uses.some((u) => u.includes("download-artifact"))).toBe(false);
    expect(uses.filter((u) => u.startsWith("actions/github-script"))).toHaveLength(1);
    // It recomputes gatedness from the API instead of trusting the fork run.
    expect(jobCode(job)).toContain("pulls.listFiles");
    expect(jobCode(job)).not.toContain("downloadArtifact");
  });

  it("keeps the gated-path list byte-identical to changed-paths (the keep-in-sync contract)", () => {
    const gateList = gatedLists(jobCode(gateJobs["changed-paths"]));
    const forkList = gatedLists(jobCode(forkPublish.jobs["publish-fork-check"]));
    expect(forkList).toEqual(gateList);
  });

  it("the gated-path list still covers every config-evals-baseline.yml push path", () => {
    const gateList = gatedLists(jobCode(gateJobs["changed-paths"]));
    const pushPaths: string[] = baselineWf.on.push.paths;
    expect(pushPaths.length).toBeGreaterThan(0);
    for (const p of pushPaths) {
      const covered = p.endsWith("/**")
        ? gateList.prefixes.includes(p.slice(0, -2)) // "x/**" ⇒ prefix "x/"
        : gateList.files.includes(p);
      expect(covered, `baseline push path '${p}' not covered by the gated list`).toBe(true);
    }
  });
});

// ─── --config-sha flag (real CLI runs, zero Bedrock calls) ───────────────────

const RUNNER = join(REPO_ROOT, "evals", "battery", "run-battery.mjs");
const runCli = (args: string[]) => {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [RUNNER, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (err: any) {
    return { status: err.status as number, output: `${err.stdout || ""}${err.stderr || ""}` };
  }
};

describe("--config-sha (the reported config revision when the worktree is the base harness)", () => {
  it("rejects a non-hex value before any run (it lands verbatim in the public check summary)", () => {
    const r = runCli(["--dry-run", "--config-sha", "not-a-sha"]);
    expect(r.status).toBe(2);
    expect(r.output).toContain("--config-sha must be a hex git sha");
  });

  it("is rejected with --baseline-mode — source_commit must be the checkout's own sha", () => {
    const r = runCli(["--baseline-mode", "--out", "/tmp/never-written-baseline.json", "--config-sha", "abcdef1"]);
    expect(r.status).toBe(2);
    expect(r.output).toContain("--config-sha is not allowed with --baseline-mode");
  });

  it("dry-run reports the overridden config sha, distinct from the harness revision", () => {
    const r = runCli(["--dry-run", "--config-sha", "deadbeefcafe"]);
    expect(r.status).toBe(0);
    expect(r.output).toContain("Config under test: deadbeefcafe");
    expect(r.output).toMatch(/Plan \(runId \w+, config deadbeefcafe\)/);
  });
});
