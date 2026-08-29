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
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const workflow = parse(
  readFileSync(join(REPO_ROOT, ".github/workflows/config-evals-gate.yml"), "utf8")
);
const jobs: Record<string, any> = workflow.jobs;

// The exact candidate allowlist the gate exists to score (FR-2.2): candidate
// config plus, since TEAM-3438 Finding 2, the battery corpus DATA (cases,
// fixtures, manifest) — read by the base harness, never imported or executed.
// Keep in sync with the overlay step AND the gated-path list in changed-paths.
const OVERLAY_DIRS = [
  "deploy/runtime-agent/prompts",
  "deploy/workflow-manager",
  "blueprints",
  "evals/battery/cases",
  "evals/battery/fixtures",
];
const OVERLAY_FILES = ["src/config/workflows.json", "src/config/agents.json", "evals/battery/manifest.json"];

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
    // The two bash arrays ARE the allowlist — assert them exactly.
    const bashArray = (name: string): string[] => {
      const m = run.match(new RegExp(`${name}=\\(([^)]*)\\)`));
      expect(m, `overlay must declare the ${name} allowlist array`).toBeTruthy();
      return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    };
    expect(bashArray("OVERLAY_DIRS")).toEqual(OVERLAY_DIRS);
    expect(bashArray("OVERLAY_FILES")).toEqual(OVERLAY_FILES);
    // Every pr-head/… reference must be a loop variable — no path can cross
    // the boundary outside the allowlist above.
    const sources = run.match(/pr-head\/[^\s"']*/g) ?? [];
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) expect(["pr-head/$dir", "pr-head/$f"]).toContain(src);
    // Executable/harness paths and the gate's own rules must never appear as
    // overlay sources. (Corpus DATA under evals/battery — cases, fixtures,
    // manifest.json — is legitimately overlaid since TEAM-3438 Finding 2, so
    // the forbidden list names the battery's code and rule files precisely.)
    for (const forbidden of [
      "evals/battery/lib",
      "run-battery",
      "evals/battery/schema",
      "thresholds.json",
      "baseline.json",
      ".github",
      "package.json",
      "package-lock.json",
    ])
      expect(run, `overlay must not reference ${forbidden}`).not.toContain(forbidden);
  });

  it("sparse-checks-out exactly what the overlay allowlist needs — never battery code (TEAM-3438)", () => {
    const side = checkouts.filter((s) => s.with?.path);
    // Non-cone mode: cone patterns are directory-only and pull in parent-dir
    // files, which would put the runner and lib/ inside pr-head.
    expect(side[0].with?.["sparse-checkout-cone-mode"]).toBe(false);
    const patterns = String(side[0].with?.["sparse-checkout"] ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const covers = (pattern: string, path: string) => {
      const p = pattern.replace(/^\//, "").replace(/\/$/, "");
      return p === path || path.startsWith(`${p}/`);
    };
    // Every overlay source must actually exist in pr-head…
    for (const entry of [...OVERLAY_DIRS, ...OVERLAY_FILES])
      expect(patterns.some((p) => covers(p, entry)), `sparse-checkout must cover ${entry}`).toBe(true);
    // …and nothing executable or rule-bearing may be materialized there.
    for (const path of [
      "evals/battery/lib",
      "evals/battery/run-battery.mjs",
      "evals/battery/schema",
      "evals/battery/thresholds.json",
      "evals/battery/baseline.json",
      ".github",
      "package.json",
      "package-lock.json",
    ])
      expect(patterns.some((p) => covers(p, path)), `sparse-checkout must not cover ${path}`).toBe(false);
  });

  it("rejects symlinks and non-regular PR-head files BEFORE any copy (TEAM-3438)", () => {
    const run: string = overlay.run;
    // The guard must sit before the first copy so nothing PR-controlled
    // crosses the boundary once a symlink/special file is present anywhere.
    const guardIdx = run.indexOf("-type l");
    // The literal copy command, not just "cp -R" — the guard's own trust
    // comment legitimately mentions cp -R.
    const firstCopyIdx = run.indexOf('cp -R "pr-head/$dir"');
    expect(guardIdx, "overlay must contain a -type l find rejection").toBeGreaterThan(-1);
    expect(firstCopyIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(firstCopyIdx);
    // Deep scan iterates the SAME OVERLAY_DIRS array the copy loop uses, so
    // future allowlist additions are covered automatically; the predicate
    // rejects symlinks and anything neither regular file nor directory.
    expect(run).toMatch(/find "pr-head\/\$dir" \\\( -type l -o ! -type d ! -type f \\\) -print/);
    // Single-file entries: -f follows symlinks, so an explicit -L test is
    // required to reject a symlink that points at a regular file.
    expect(run).toMatch(/\[ -L "pr-head\/\$f" \]/);
    // Detection is fatal — the job fails visibly instead of dereferencing.
    const guardBlock = run.slice(guardIdx, firstCopyIdx);
    expect(guardBlock).toContain("::error::");
    expect(guardBlock).toMatch(/^\s*exit 1\s*$/m);
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

describe("overlay symlink rejection — the real inline script, executed (TEAM-3438)", () => {
  // Same subprocess pattern as lint-fixtures.test.ts: run the EXACT bash the
  // workflow runs (the overlay step's `run` block, straight from the parsed
  // YAML) against a throwaway workspace, so the guard is tested as code, not
  // just pinned as text. No AWS, no network.
  const overlayRun: string = steps(jobs.battery).find((s) => /overlay/i.test(String(s.name ?? "")))!.run;
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), "gate-overlay-"));
    roots.push(root);
    return root;
  }

  function write(root: string, rel: string, content: string): void {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }

  function runOverlay(root: string): { code: number; output: string } {
    try {
      const output = execFileSync("bash", ["-c", overlayRun], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HEAD_SHA: "headsha", BASE_SHA: "basesha" },
      });
      return { code: 0, output };
    } catch (err: any) {
      return { code: err.status ?? 1, output: `${err.stdout || ""}${err.stderr || ""}` };
    }
  }

  it("fails the job on a symlink inside an overlaid directory, copying nothing", () => {
    const root = workspace();
    write(root, "deploy/runtime-agent/prompts/base.txt", "base prompt");
    mkdirSync(join(root, "pr-head/deploy/runtime-agent/prompts"), { recursive: true });
    symlinkSync("/proc/self/environ", join(root, "pr-head/deploy/runtime-agent/prompts/evil.txt"));
    const { code, output } = runOverlay(root);
    expect(code).toBe(1);
    expect(output).toContain("::error::");
    expect(output).toContain("pr-head/deploy/runtime-agent/prompts/evil.txt");
    // Guard fired before the copy loops: the base file was never clobbered.
    expect(readFileSync(join(root, "deploy/runtime-agent/prompts/base.txt"), "utf8")).toBe("base prompt");
  });

  it("fails on a symlink at a single-file overlay entry, even one pointing at a regular file", () => {
    const root = workspace();
    write(root, "pr-head/decoy.json", "{}"); // regular target — plain -f would pass
    mkdirSync(join(root, "pr-head/src/config"), { recursive: true });
    symlinkSync(join(root, "pr-head/decoy.json"), join(root, "pr-head/src/config/workflows.json"));
    const { code, output } = runOverlay(root);
    expect(code).toBe(1);
    expect(output).toContain("pr-head/src/config/workflows.json");
  });

  it("fails on a symlink planted under the battery corpus overlay (Finding 2 dirs are guarded too)", () => {
    // The guard iterates OVERLAY_DIRS, so the corpus paths added by TEAM-3438
    // Finding 2 must be covered without any guard change.
    const root = workspace();
    mkdirSync(join(root, "pr-head/evals/battery/cases"), { recursive: true });
    symlinkSync("/proc/self/environ", join(root, "pr-head/evals/battery/cases/evil.json"));
    const { code, output } = runOverlay(root);
    expect(code).toBe(1);
    expect(output).toContain("::error::");
    expect(output).toContain("pr-head/evals/battery/cases/evil.json");
  });

  it("fails when an allowlisted directory itself is a symlink", () => {
    const root = workspace();
    mkdirSync(join(root, "pr-head/deploy/runtime-agent"), { recursive: true });
    symlinkSync("/etc", join(root, "pr-head/deploy/runtime-agent/prompts"));
    const { code } = runOverlay(root);
    expect(code).toBe(1);
  });

  it("passes a clean head: regular files overlay and pr-head is removed", () => {
    const root = workspace();
    write(root, "deploy/runtime-agent/prompts/stale.txt", "deleted at head");
    write(root, "pr-head/deploy/runtime-agent/prompts/new.txt", "candidate prompt");
    write(root, "pr-head/src/config/workflows.json", "{}");
    // Battery corpus data (TEAM-3438 Finding 2) overlays the same way.
    write(root, "evals/battery/cases/stale-case.json", "deleted at head");
    write(root, "pr-head/evals/battery/cases/new-case.json", '{"id":"new-case"}');
    write(root, "pr-head/evals/battery/manifest.json", '{"activeCases":["new-case"]}');
    const { code, output } = runOverlay(root);
    expect(code, output).toBe(0);
    expect(readFileSync(join(root, "deploy/runtime-agent/prompts/new.txt"), "utf8")).toBe("candidate prompt");
    expect(existsSync(join(root, "deploy/runtime-agent/prompts/stale.txt"))).toBe(false);
    expect(readFileSync(join(root, "src/config/workflows.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(root, "evals/battery/cases/new-case.json"), "utf8")).toBe('{"id":"new-case"}');
    expect(existsSync(join(root, "evals/battery/cases/stale-case.json"))).toBe(false);
    expect(readFileSync(join(root, "evals/battery/manifest.json"), "utf8")).toBe('{"activeCases":["new-case"]}');
    expect(existsSync(join(root, "pr-head"))).toBe(false);
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

describe("gated-path list — keep-in-sync contract with config-evals-baseline.yml", () => {
  // changed-paths' comment promises its list stays in sync with the baseline
  // workflow's push paths; a baseline-regenerating path the gate ignores
  // would let ungated PRs drift the config the baseline is generated from.
  it("the gate's gated-path list covers every baseline-workflow push path", () => {
    const script: string = jobs["changed-paths"].steps[0].with.script;
    const grab = (name: string): string[] => {
      const m = script.match(new RegExp(`${name} = \\[([\\s\\S]*?)\\];`));
      expect(m, `${name} array not found in changed-paths script`).toBeTruthy();
      return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    };
    const prefixes = grab("gatedPrefixes");
    const files = grab("gatedFiles");
    const baselineWf = parse(
      readFileSync(join(REPO_ROOT, ".github/workflows/config-evals-baseline.yml"), "utf8")
    );
    const pushPaths: string[] = baselineWf.on.push.paths;
    expect(pushPaths.length).toBeGreaterThan(0);
    for (const p of pushPaths) {
      const covered = p.endsWith("/**")
        ? prefixes.includes(p.slice(0, -2)) // "x/**" ⇒ prefix "x/"
        : files.includes(p);
      expect(covered, `baseline push path '${p}' not covered by the gated list`).toBe(true);
    }
  });
});
