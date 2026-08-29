// Trust-boundary invariants of .github/workflows/config-evals-gate.yml
// (TEAM-3425). The gate's security rests on structural properties of the
// workflow that a later edit could silently regress, so this test parses the
// real YAML and asserts them:
//
//   HERM-3  Everything EXECUTABLE in the battery job comes from the trusted
//           BASE revision (workspace checkout = pull_request.base.sha); the
//           PR head is checked out to a side directory as DATA only, and the
//           overlay step copies exactly the candidate-config allowlist —
//           never evals/battery/**, .github/**, or package*.json. A PR that
//           mutates the runner must not be able to fabricate the verdict
//           artifact the publish job trusts.
//
//   CRED-2  GITHUB_TOKEN is read-only on fork pull_request events, so
//           checks.create 403s for fork PRs. No job that can run for a fork
//           PR may hold checks:write or call checks.create; check publication
//           (publish / skip-publish) is same-repo only, and the fork jobs run
//           with permissions: {}.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const workflow = parse(
  readFileSync(join(REPO_ROOT, ".github/workflows/config-evals-gate.yml"), "utf8")
);
const jobs: Record<string, any> = workflow.jobs;

// The exact candidate-config allowlist the gate exists to score (FR-2.2).
// Keep in sync with the overlay step AND the gated-path list in changed-paths.
const OVERLAY_DIRS = ["deploy/runtime-agent/prompts", "deploy/workflow-manager", "blueprints"];
const OVERLAY_FILES = ["src/config/workflows.json", "src/config/agents.json"];

const SAME_REPO = "github.event.pull_request.head.repo.full_name == github.repository";
const FORK_ONLY = "github.event.pull_request.head.repo.full_name != github.repository";

const steps = (job: any): any[] => job?.steps ?? [];
// Everything a step could execute or hand to github-script.
const stepCode = (job: any): string =>
  steps(job)
    .map((s) => `${s.run ?? ""}\n${s.with?.script ?? ""}`)
    .join("\n");

describe("battery job — harness from trusted base (HERM-3)", () => {
  const battery = jobs.battery;
  const checkouts = steps(battery).filter((s) => String(s.uses ?? "").startsWith("actions/checkout"));

  it("checks out the WORKSPACE at the trusted base sha with no persisted credentials", () => {
    // Exactly one checkout targets the workspace (no `path:`) — that is what
    // `node evals/battery/run-battery.mjs` executes from.
    const workspace = checkouts.filter((s) => !s.with?.path);
    expect(workspace).toHaveLength(1);
    expect(workspace[0].with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(workspace[0].with?.["persist-credentials"]).toBe(false);
  });

  it("checks out the PR head only into a separate side directory, never the workspace", () => {
    const side = checkouts.filter((s) => s.with?.path);
    expect(side).toHaveLength(1);
    expect(checkouts).toHaveLength(2); // no third checkout that could clobber the workspace
    expect(side[0].with?.path).toBe("pr-head");
    expect(side[0].with?.ref).toBe("${{ github.event.pull_request.head.sha }}");
    expect(side[0].with?.["persist-credentials"]).toBe(false);
  });

  const overlay = steps(battery).find((s) => /overlay/i.test(String(s.name ?? "")));

  it("overlays exactly the candidate-config allowlist from the PR head", () => {
    expect(overlay, "battery job must have an overlay step").toBeTruthy();
    const run: string = overlay.run;
    // The two loops ARE the allowlist — assert them exactly.
    const dirLoop = run.match(/for dir in ([^\n;]+);/);
    expect(dirLoop, "overlay must loop over the candidate directories").toBeTruthy();
    expect(dirLoop![1].trim().split(/\s+/)).toEqual(OVERLAY_DIRS);
    const fileLoop = run.match(/for f in ([^\n;]+);/);
    expect(fileLoop, "overlay must loop over the candidate files").toBeTruthy();
    expect(fileLoop![1].trim().split(/\s+/)).toEqual(OVERLAY_FILES);
    // Every pr-head/… reference must be a loop variable — no path can cross
    // the boundary outside the allowlist above.
    const sources = run.match(/pr-head\/[^\s"']*/g) ?? [];
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) expect(["pr-head/$dir", "pr-head/$f"]).toContain(src);
    // Executable/harness paths must never appear as overlay sources.
    for (const forbidden of ["evals/battery", ".github", "package.json", "package-lock.json"])
      expect(run, `overlay must not reference ${forbidden}`).not.toContain(forbidden);
  });

  it("deletes pr-head in the overlay step, before the battery runs", () => {
    expect(overlay.run).toMatch(/^\s*rm -rf pr-head\s*$/m);
    const names = steps(battery).map((s) => String(s.name ?? ""));
    const overlayIdx = names.findIndex((n) => /overlay/i.test(n));
    const runIdx = names.indexOf("Run battery");
    expect(runIdx).toBeGreaterThan(-1);
    expect(overlayIdx).toBeGreaterThan(-1);
    expect(overlayIdx).toBeLessThan(runIdx);
  });

  it("runs only for gated same-repo PRs and can never publish checks (HERM-1)", () => {
    expect(String(battery.if)).toContain(SAME_REPO);
    expect(String(battery.if)).toContain("gated == 'true'");
    expect(battery.permissions ?? {}).not.toHaveProperty("checks");
  });
});

describe("fork safety — no fork-reachable job can touch checks.create (CRED-2)", () => {
  it("every job that can run for fork PRs has no checks:write and never calls checks.create", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const sameRepoOnly = String(job.if ?? "").includes(SAME_REPO);
      if (sameRepoOnly) continue; // fork PRs can never reach this job
      expect(job.permissions ?? {}, `fork-reachable job '${name}' must not hold checks:write`).not.toHaveProperty("checks");
      expect(stepCode(job), `fork-reachable job '${name}' must not call checks.create`).not.toContain("checks.create");
    }
  });

  it("check publication is same-repo only", () => {
    expect(String(jobs.publish.if)).toContain(SAME_REPO);
    expect(String(jobs["skip-publish"].if)).toContain(SAME_REPO);
    for (const job of [jobs.publish, jobs["skip-publish"]])
      expect(job.permissions?.checks).toBe("write");
  });

  it("fork-guard fails visibly for gated-or-undetermined fork PRs, with zero permissions", () => {
    const guard = jobs["fork-guard"];
    expect(String(guard.if)).toContain(FORK_ONLY);
    // `gated != 'false'` (not == 'true'): a failed path detection must still
    // fail visibly for a fork PR (fail closed).
    expect(String(guard.if)).toContain("gated != 'false'");
    expect(guard.permissions).toEqual({});
    expect(stepCode(guard)).toMatch(/^\s*exit 1\s*$/m);
  });

  it("fork-notice covers ungated fork PRs informationally, with zero permissions", () => {
    const notice = jobs["fork-notice"];
    expect(String(notice.if)).toContain(FORK_ONLY);
    expect(String(notice.if)).toContain("gated == 'false'");
    expect(notice.permissions).toEqual({});
    expect(stepCode(notice)).not.toMatch(/^\s*exit 1\s*$/m);
  });
});
