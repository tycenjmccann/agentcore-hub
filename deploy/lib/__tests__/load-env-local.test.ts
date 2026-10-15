/**
 * TEAM-6202 — a .env.local line that expands an unset shell variable (e.g.
 * an optional token: GITHUB_TOKEN="$OPTIONAL_REVIEW_TOKEN", or
 * X=${UNSET_VAR_XYZ}/x) aborts any script that sources .env.local under
 * `set -u` with "unbound variable" before it does any real work.
 * scripts/trace-workflow.sh hit this and TEAM-6200 F4 fixed it there with an
 * inline set +u / source / set -u. This generalizes that fix into
 * deploy/lib/load-env-local.sh (load_env_local <file>) and makes every
 * .env.local source site in the repo call it, instead of hand-rolling
 * `if [ -f F ]; then set -a; source F; set +a; fi`.
 *
 * Three things are pinned here:
 *  1. load_env_local itself: proceeds past an unset-variable expansion under
 *     set -u, restores -u to whatever it was before the call (not
 *     unconditionally on), always leaves -a off, and no-ops on a missing
 *     file.
 *  2. deploy/config.sh, run under set -euo pipefail (the real failure mode:
 *     ~13 scripts source config.sh from under their own set -u), actually
 *     gets past the .env.local source and derives downstream values.
 *  3. A static sweep: every file:line in the repo that sources .env.local
 *     goes through load_env_local, so a new site can't reintroduce the bug.
 *
 * Same hermetic end-to-end pattern as trace-workflow-ticket-lambda.test.ts:
 * scratch copies under a tmpdir, a child env built from an ALLOW-LIST (never
 * a copy of process.env), scratch dirs removed in afterEach.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve(__dirname, "../../..");
const HELPER = join(REPO_ROOT, "deploy", "lib", "load-env-local.sh");

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Child env built from an allow-list, never a copy of process.env. */
const hermeticEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const base: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
  for (const k of ["HOME", "TMPDIR", "LANG", "LC_ALL"] as const) {
    if (process.env[k] !== undefined) base[k] = process.env[k] as string;
  }
  return { ...base, ...extra } as NodeJS.ProcessEnv;
};

const runBash = (script: string, env: Record<string, string> = {}) =>
  spawnSync("bash", ["-c", script], { encoding: "utf8", env: hermeticEnv(env) });

describe("load_env_local (deploy/lib/load-env-local.sh)", () => {
  const UNSET_ENV_LOCAL = 'X=${UNSET_VAR_XYZ}/x\nY=$ALSO_UNSET\nOK=1\n';

  it("proceeds past an unset-variable expansion under set -u, and the value is visible after sourcing", () => {
    const dir = mkdtempSync(join(tmpdir(), "load-env-local-"));
    scratchDirs.push(dir);
    writeFileSync(join(dir, ".env.local"), UNSET_ENV_LOCAL);

    const { stdout, stderr, status } = runBash(`
      set -euo pipefail
      source "${HELPER}"
      load_env_local "${dir}/.env.local"
      echo "OK=$OK X=$X"
    `);

    expect(stderr).not.toMatch(/unbound variable/);
    expect(status).toBe(0);
    expect(stdout).toContain("OK=1 X=/x");
  });

  it("restores set -u afterwards when the caller had it on, so a later unset var still aborts", () => {
    const dir = mkdtempSync(join(tmpdir(), "load-env-local-"));
    scratchDirs.push(dir);
    writeFileSync(join(dir, ".env.local"), "OK=1\n");

    const { stderr, status } = runBash(`
      set -euo pipefail
      source "${HELPER}"
      load_env_local "${dir}/.env.local"
      echo "$STILL_UNSET_AFTER"
    `);

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unbound variable/);
  });

  it("leaves set -u OFF afterwards when the caller never had it on", () => {
    const dir = mkdtempSync(join(tmpdir(), "load-env-local-"));
    scratchDirs.push(dir);
    writeFileSync(join(dir, ".env.local"), UNSET_ENV_LOCAL);

    const { stdout, stderr, status } = runBash(`
      set -e
      source "${HELPER}"
      load_env_local "${dir}/.env.local"
      echo "nounset-after=$(case $- in *u*) echo on;; *) echo off;; esac)"
      echo "survives=$STILL_UNSET_AFTER_NO_U"
    `);

    expect(stderr).not.toMatch(/unbound variable/);
    expect(status).toBe(0);
    expect(stdout).toContain("nounset-after=off");
  });

  it("always leaves set -a OFF afterwards, even when the caller had it on", () => {
    const dir = mkdtempSync(join(tmpdir(), "load-env-local-"));
    scratchDirs.push(dir);
    writeFileSync(join(dir, ".env.local"), "OK=1\n");

    const { stdout, status } = runBash(`
      set -e -a
      source "${HELPER}"
      load_env_local "${dir}/.env.local"
      echo "allexport-after=$(case $- in *a*) echo on;; *) echo off;; esac)"
    `);

    expect(status).toBe(0);
    expect(stdout).toContain("allexport-after=off");
  });

  it("exports values from .env.local so a child process (not just the current shell) sees them", () => {
    const dir = mkdtempSync(join(tmpdir(), "load-env-local-"));
    scratchDirs.push(dir);
    writeFileSync(join(dir, ".env.local"), "EXPORTED_VAL=hello\n");

    const { stdout, status } = runBash(`
      set -euo pipefail
      source "${HELPER}"
      load_env_local "${dir}/.env.local"
      bash -c 'echo "child=$EXPORTED_VAL"'
    `);

    expect(status).toBe(0);
    expect(stdout).toContain("child=hello");
  });

  it("no-ops (returns 0) when the file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "load-env-local-"));
    scratchDirs.push(dir);

    const { stdout, status } = runBash(`
      set -euo pipefail
      source "${HELPER}"
      load_env_local "${dir}/.env.local"
      echo "survived-missing-file"
    `);

    expect(status).toBe(0);
    expect(stdout).toContain("survived-missing-file");
  });
});

describe("deploy/config.sh sources .env.local without aborting under set -u", () => {
  /**
   * Scratch copy of config.sh + deploy/lib/ (so its
   * `. "$_CONFIG_DIR/deploy/lib/load-env-local.sh"` resolves) with a
   * scratch .env.local, run under the exact `set -euo pipefail` ~13 real
   * deploy scripts source config.sh from. AWS_ACCOUNT_ID/AWS_REGION are
   * pinned so config.sh never calls `aws sts get-caller-identity`.
   *
   * load-env-local.sh is copied only if present (same idiom as TEAM-6069's
   * runtime-env-forwarding.test.ts for runtime-env-defaults.sh): this test
   * must also run — and FAIL with the real "unbound variable" symptom, not
   * an unrelated ENOENT — against the pre-fix tree, where config.sh has no
   * reference to the helper at all and sources .env.local inline.
   */
  const runConfigSh = (envLocal: string) => {
    const dir = mkdtempSync(join(tmpdir(), "config-sh-"));
    scratchDirs.push(dir);
    mkdirSync(join(dir, "deploy", "lib"), { recursive: true });
    cpSync(join(REPO_ROOT, "deploy", "config.sh"), join(dir, "deploy", "config.sh"));
    if (existsSync(HELPER)) {
      cpSync(HELPER, join(dir, "deploy", "lib", "load-env-local.sh"));
    }
    cpSync(
      join(REPO_ROOT, "deploy", "lib", "runtime-env-defaults.sh"),
      join(dir, "deploy", "lib", "runtime-env-defaults.sh")
    );
    writeFileSync(join(dir, ".env.local"), envLocal);

    // ARTIFACT_BUCKET is deliberately not asserted on: some sandboxes inject
    // a baseline env (incl. ARTIFACT_BUCKET) into every child process
    // regardless of what's passed here, which would make a `${VAR:-default}"
    // assertion on it flaky. AGENTCORE_ROLE_ARN is derived from ACCOUNT_ID
    // the same way and isn't part of that baseline.
    const result = runBash(
      `
      set -euo pipefail
      source "${dir}/deploy/config.sh"
      echo "ACCOUNT_ID=$ACCOUNT_ID"
      echo "AGENTCORE_ROLE_ARN=$AGENTCORE_ROLE_ARN"
      echo "OK=$OK"
      echo "X=$X"
      echo "nounset-after=$(case $- in *u*) echo on;; *) echo off;; esac)"
      `,
      { AWS_ACCOUNT_ID: "111111111111", AWS_REGION: "us-east-1" }
    );
    return result;
  };

  it("survives a .env.local that references an unset variable (the repro bug on main)", () => {
    const { stdout, stderr, status } = runConfigSh('X=${UNSET_VAR_XYZ}/x\nY=$ALSO_UNSET\nOK=1\n');

    expect(stderr).not.toMatch(/unbound variable/);
    expect(status).toBe(0);
    expect(stdout).toContain("OK=1");
    expect(stdout).toContain("X=/x");
    expect(stdout).toContain("ACCOUNT_ID=111111111111");
    expect(stdout).toContain("AGENTCORE_ROLE_ARN=arn:aws:iam::111111111111:role/agentcore-hub-agentcore-role");
  });

  it("still has set -u active in the caller after config.sh returns", () => {
    // X is defined here (unlike the previous test's point) only so the
    // shared script's `echo "X=$X"` doesn't itself trip -u — the thing
    // under test is nounset-after, not X.
    const { stdout, status } = runConfigSh("OK=1\nX=1\n");

    expect(status).toBe(0);
    expect(stdout).toContain("nounset-after=on");
  });
});

/**
 * Static sweep: every file:line in the repo that sources .env.local must go
 * through load_env_local, not a hand-rolled `source .env.local`. Catches a
 * new site reintroducing the bug this file is about. Known sites, kept here
 * so an added/removed site is a deliberate edit to this list.
 */
describe("every .env.local source site in the repo uses the shared loader", () => {
  const KNOWN_SITES = [
    "deploy/config.sh",
    "scripts/trace-workflow.sh",
    "scripts/verify-infra.sh",
    "deploy/runtime-agent/deploy-fleet.sh",
    "deploy/apprunner/deploy.sh",
    "deploy/apprunner/setup-jira-webhook.sh",
    "deploy/ecs-express/deploy.sh",
    "deploy/continuous-improvement/deploy-token-aggregator.sh",
    ".claude-plugin/bin/run-module.sh",
    ".claude-plugin/bin/verify-module.sh",
  ];

  const trackedShFiles = (): string[] =>
    execSync('git ls-files -- "*.sh"', { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((f) => f !== "deploy/lib/load-env-local.sh");

  // Matches `source .env.local`, `. .env.local`, and the same with a path
  // prefix (./, $DIR/, ${X}/, etc.) — anything ending in .env.local — but not
  // a comment line or a `source .../load-env-local.sh` line.
  const DIRECT_SOURCE_RE = /^\s*(?:source|\.)\s+["']?[^"'\s]*\.env\.local["']?/;

  it("has no hand-rolled `source .../.env.local` left outside the helper", () => {
    const offenders: string[] = [];
    for (const file of trackedShFiles()) {
      const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("#")) return;
        if (DIRECT_SOURCE_RE.test(trimmed)) {
          offenders.push(`${file}:${idx + 1}: ${trimmed}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it.each(KNOWN_SITES)("%s calls load_env_local", (file) => {
    const content = readFileSync(join(REPO_ROOT, file), "utf8");
    expect(content).toMatch(/load_env_local\s+\S/);
    expect(content).toMatch(/load-env-local\.sh/);
  });
});
