import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * TEAM-3388 acceptance tests for the eval-gate deploy guard hardening.
 * Same hermetic pattern as check-eval-gate.test.ts: bash subprocesses,
 * throwaway git fixture repos, PATH-shimmed fake `gh`/`aws`/`agentcore`.
 *
 * Findings under test:
 *   F1  — deploy-one.sh fails CLOSED when the gate helper cannot be sourced
 *         (set -euo pipefail + explicit-fail source), and never reaches the
 *         deploy stages.
 *   F2  — the latch is an unforgeable token (sha + nonce + 600-mode file);
 *         a bare EVAL_GATE_CHECKED=$(git rev-parse HEAD) no longer skips the
 *         gate, while the real exported token short-circuits in children.
 *   F3  — hitting EVAL_GATE_BELT_MAX with history beyond the cap REFUSES;
 *         a fully-scanned short history still proceeds informationally.
 *   F4a — unreadable commit history (git diff AND git show both failing)
 *         refuses instead of looking like "touched nothing".
 *   F4b — break-glass refuses outright when BOTH audit sinks (local log
 *         append + S3 write) fail: zero durable record is never allowed.
 */

const SCRIPT = resolve(__dirname, "../check-eval-gate.sh");
const DEPLOY_ONE = resolve(__dirname, "../../runtime-agent/deploy-one.sh");

// Same env-keyed gh shim protocol as check-eval-gate.test.ts:
//   CHECK_<sha7>=green|red|absent → commits/<sha>/check-runs; pulls always [].
const GH_SHIM = `#!/bin/bash
if [ -n "\${GH_CALL_LOG:-}" ]; then echo "$*" >> "\$GH_CALL_LOG"; fi
case "$1" in
  auth) exit 0 ;;
  api)
    ep="$2"
    sha="\${ep#repos/acme/widgets/commits/}"; sha="\${sha%%/*}"
    key="$(printf '%s' "$sha" | cut -c1-7)"
    case "$ep" in
      */check-runs*)
        var="CHECK_$key"; mode="\${!var:-absent}"
        case "$mode" in
          green)  echo '{"total_count":1,"check_runs":[{"status":"completed","conclusion":"success","html_url":"http://check/x"}]}' ;;
          red)    echo '{"total_count":1,"check_runs":[{"status":"completed","conclusion":"failure","html_url":"http://check/x","output":{"summary":"- CRED-2 failed"}}]}' ;;
          absent) echo '{"total_count":0,"check_runs":[]}' ;;
        esac ;;
      */pulls) echo '[]' ;;
      *) echo '{}' ;;
    esac ;;
  *) exit 0 ;;
esac
`;

// aws shim: STS identity succeeds so break-glass records a "cloud" identity;
// every s3 write fails (AWS_S3_EXIT default 1) — the audit-failure fixture.
const AWS_SHIM = `#!/bin/bash
case "$*" in
  *get-caller-identity*) echo "arn:aws:iam::123456789012:role/test"; exit 0 ;;
  *"s3 cp"*) exit "\${AWS_S3_EXIT:-1}" ;;
  *) exit 1 ;;
esac
`;

// Deploy-tool shims for the F1 test: if deploy-one.sh ever got past the gate
// they would leave a sentinel file behind.
const SENTINEL_SHIM = `#!/bin/bash
touch "\${SENTINEL:?}"
exit 0
`;

let tmp: string;
let binDir: string;
let gitShimDir: string;
let fakeHome: string;
let callCounter = 0;

const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function makeRepo(name: string, script: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execSync(
    `set -euo pipefail
     git init -q -b main
     git remote add origin https://github.com/acme/widgets.git
     ${script}`,
    { cwd: dir, shell: "/bin/bash", env: { ...process.env, ...gitEnv } },
  );
  return dir;
}

function sha(repo: string, ref = "HEAD"): string {
  return execSync(`git rev-parse ${ref}`, {
    cwd: repo,
    env: { ...process.env, ...gitEnv },
    encoding: "utf8",
  }).trim();
}

/** Run a bash script with the shim dirs first on PATH; returns status + output. */
function runBash(
  script: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
  extraPath = "",
) {
  const callLog = join(tmp, `gh-calls-${callCounter++}.log`);
  const res = spawnSync("bash", ["-c", script], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: `${extraPath ? extraPath + ":" : ""}${binDir}:/usr/local/bin:/usr/bin:/bin`,
      HOME: fakeHome,
      GH_CALL_LOG: callLog,
      ...gitEnv,
      ...extraEnv,
    },
  });
  const out = (res.stdout ?? "") + (res.stderr ?? "");
  const ghCalls = existsSync(callLog)
    ? readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return { status: res.status, out, ghCalls, callLog };
}

function runGate(
  repo: string,
  extraEnv: Record<string, string> = {},
  globs: string[] = ["conf/**"],
  extraPath = "",
) {
  const quoted = globs.map((g) => `'${g}'`).join(" ");
  return runBash(
    `set -euo pipefail
     source '${SCRIPT}'
     require_eval_gate ${quoted}
     echo "LATCH=\${EVAL_GATE_CHECKED:-unset}"`,
    repo,
    extraEnv,
    extraPath,
  );
}

// Fixtures (built once).
let repoSmall: string; // 2 commits, HEAD ungated — green/latch fixtures
let smallHead: string;
let repoGatedHead: string; // HEAD touches conf/ — break-glass fixture
let repoDeep106: string; // 105 ancestors > cap → must refuse
let repoAtCap: string; // exactly 100 ancestors == cap, fully scanned → proceed

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "gate-hardening-test-"));
  binDir = join(tmp, "bin");
  gitShimDir = join(tmp, "git-shim");
  fakeHome = join(tmp, "home");
  mkdirSync(binDir);
  mkdirSync(gitShimDir);
  mkdirSync(fakeHome);
  writeFileSync(join(binDir, "gh"), GH_SHIM, { mode: 0o755 });
  writeFileSync(join(binDir, "aws"), AWS_SHIM, { mode: 0o755 });

  // git wrapper that makes `git ... diff ...` and `git ... show ...` fail
  // while passing everything else through — simulates unreadable history.
  const realGit = execSync("command -v git", {
    shell: "/bin/bash",
    encoding: "utf8",
  }).trim();
  writeFileSync(
    join(gitShimDir, "git"),
    `#!/bin/bash
for a in "$@"; do
  case "$a" in
    diff|show) exit 1 ;;
  esac
done
exec '${realGit}' "$@"
`,
    { mode: 0o755 },
  );

  repoSmall = makeRepo(
    "small",
    `mkdir conf && echo a > conf/gated.txt && git add . && git commit -qm c1
     echo b > ungated.txt && git add . && git commit -qm c2`,
  );
  smallHead = sha(repoSmall);

  repoGatedHead = makeRepo(
    "gated-head",
    `echo b > ungated.txt && git add . && git commit -qm c1
     mkdir conf && echo a > conf/gated.txt && git add . && git commit -qm c2`,
  );

  // Empty commits keep fixture creation fast; an empty first-parent diff also
  // means "nothing gated touched", which is what the belt verdict needs.
  repoDeep106 = makeRepo(
    "deep106",
    `echo 0 > f.txt && git add . && git commit -qm c0
     for i in $(seq 1 105); do git commit -q --allow-empty -m "c$i"; done`,
  );
  repoAtCap = makeRepo(
    "at-cap",
    `echo 0 > f.txt && git add . && git commit -qm c0
     for i in $(seq 1 100); do git commit -q --allow-empty -m "c$i"; done`,
  );
}, 180_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("F1: deploy-one.sh fails closed when the gate helper cannot be sourced", () => {
  it("exits non-zero on a missing check-eval-gate.sh and never reaches the deploy stages", () => {
    // Copy deploy-one.sh into a layout where deploy/lib/ does NOT exist.
    const root = join(tmp, "deploy-one-nolib");
    const agentDir = join(root, "deploy", "runtime-agent");
    mkdirSync(agentDir, { recursive: true });
    copyFileSync(DEPLOY_ONE, join(agentDir, "deploy-one.sh"));
    chmodSync(join(agentDir, "deploy-one.sh"), 0o755);

    // If the script got past the (unloadable) gate, these shims would run
    // and drop a sentinel.
    const toolDir = join(tmp, "deploy-tools");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(join(toolDir, "agentcore"), SENTINEL_SHIM, { mode: 0o755 });
    const sentinel = join(tmp, "deploy-ran.sentinel");

    const r = runBash(
      `'${join(agentDir, "deploy-one.sh")}' some_agent`,
      root,
      {
        AGENTCORE_ROLE_ARN: "arn:aws:iam::123456789012:role/fake",
        GITHUB_PAT: "ghp_fake",
        ARTIFACT_BUCKET: "fake-bucket",
        SENTINEL: sentinel,
      },
      toolDir,
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("FATAL: cannot load eval gate helper");
    expect(r.out).not.toContain("OK some_agent");
    expect(r.out).not.toContain("FAIL some_agent");
    expect(existsSync(sentinel)).toBe(false);
  });

  it("keeps set -euo pipefail ahead of the gate source line (static regression guard)", () => {
    const src = readFileSync(DEPLOY_ONE, "utf8");
    const strict = src.indexOf("set -euo pipefail");
    const sourceLine = src.indexOf('source "$SCRIPT_DIR/../lib/check-eval-gate.sh"');
    const gateCall = src.indexOf('require_eval_gate "deploy/runtime-agent/prompts/**"');
    expect(strict).toBeGreaterThan(-1);
    expect(sourceLine).toBeGreaterThan(strict);
    expect(gateCall).toBeGreaterThan(sourceLine);
    // The source must be explicit-fail even if set -e is ever removed.
    expect(src).toMatch(/check-eval-gate\.sh" \\\n\s*\|\| \{ echo "FATAL: cannot load eval gate helper/);
  });
});

describe("F3: belt cap fails closed", () => {
  it("REFUSES at the cap when first-parent history extends beyond it (no anchor, no gated touch)", () => {
    const r = runGate(repoDeep106);
    expect(r.status).toBe(1);
    expect(r.out).toContain("EVAL GATE REFUSED");
    expect(r.out).toContain(
      "hit the 100-commit cap without finding a green anchor or a gated-path touch",
    );
    expect(r.out).toContain("unexamined");
  });

  it("still proceeds informationally when the scan covered the FULL history (depth exactly at the cap)", () => {
    const r = runGate(repoAtCap);
    expect(r.status).toBe(0);
    expect(r.out).toContain("full history scanned: 100 commits");
    expect(r.out).toContain("proceeding (informational, not latched)");
    expect(r.out).not.toContain("EVAL GATE REFUSED");
  });
});

describe("F4b: break-glass refuses when no durable audit record can be written", () => {
  it("refuses (exit 1) when BOTH the local log append and the S3 audit write fail", () => {
    // The local log lives at $repo_root/.eval-gate-overrides.log — a 555
    // repo root makes the append fail; the aws shim fails every s3 cp.
    chmodSync(repoGatedHead, 0o555);
    try {
      const r = runGate(repoGatedHead, {
        EVAL_GATE_OVERRIDE: "1",
        EVAL_GATE_OVERRIDE_REASON: "INC-999: test override",
        ARTIFACT_BUCKET: "fake-bucket",
        AWS_S3_EXIT: "1",
      });
      expect(r.status).toBe(1);
      expect(r.out).toContain("could not append to");
      expect(r.out).toContain("S3 audit write FAILED");
      expect(r.out).toContain("no durable audit record of this override can be written");
      expect(r.out).toContain("FR-3.3");
      expect(r.out).not.toContain("proceeding under break-glass override");
    } finally {
      chmodSync(repoGatedHead, 0o755);
    }
  });

  it("still refuses non-interactively when only the S3 write fails (BG-3 path unchanged)", () => {
    const r = runGate(repoGatedHead, {
      EVAL_GATE_OVERRIDE: "1",
      EVAL_GATE_OVERRIDE_REASON: "INC-999: test override",
      ARTIFACT_BUCKET: "fake-bucket",
      AWS_S3_EXIT: "1",
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("non-interactive and the S3 audit failed");
    expect(r.out).not.toContain("no durable audit record");
  });
});

describe("F2: latch hardening — end-to-end token round-trip", () => {
  it("a bare EVAL_GATE_CHECKED=$(git rev-parse HEAD) does not skip the gate: gh IS queried", () => {
    const r = runGate(repoSmall, {
      EVAL_GATE_CHECKED: smallHead,
      [`CHECK_${smallHead.slice(0, 7)}`]: "green",
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain("no valid latch token");
    expect(r.out).toContain("FORGED");
    expect(r.out).toContain("is green on HEAD"); // the full check actually ran
    expect(r.ghCalls.length).toBeGreaterThan(0);
  });

  it("a green run latches; a child bash inheriting the exports short-circuits with ZERO extra gh calls", () => {
    const childLog = join(tmp, `gh-calls-child-${callCounter++}.log`);
    const r = runBash(
      `set -euo pipefail
       source '${SCRIPT}'
       require_eval_gate 'conf/**'
       # Child process tree — like deploy-fleet.sh spawning deploy-one.sh.
       export GH_CALL_LOG='${childLog}'
       bash -c "set -euo pipefail; source '${SCRIPT}'; require_eval_gate 'conf/**'"`,
      repoSmall,
      { [`CHECK_${smallHead.slice(0, 7)}`]: "green" },
    );
    expect(r.status).toBe(0);
    expect(r.out).toContain("is green on HEAD");
    expect(r.out).toContain("✓ latched");
    expect(r.out).toContain("already verified in this process tree");
    const childCalls = existsSync(childLog)
      ? readFileSync(childLog, "utf8").trim().split("\n").filter(Boolean)
      : [];
    expect(childCalls).toHaveLength(0);
  });

  it("a tampered nonce invalidates the latch and the full check re-runs", () => {
    const r = runBash(
      `set -euo pipefail
       source '${SCRIPT}'
       require_eval_gate 'conf/**'
       export EVAL_GATE_LATCH_NONCE='attacker-guess'
       bash -c "set -euo pipefail; source '${SCRIPT}'; require_eval_gate 'conf/**'"`,
      repoSmall,
      { [`CHECK_${smallHead.slice(0, 7)}`]: "green" },
    );
    expect(r.status).toBe(0);
    expect(r.out).toContain("no valid latch token");
    // Both the parent and the (re-run) child verified against gh.
    expect(r.ghCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("the latch token file is 600-mode and holds '<head_sha> <nonce>'", () => {
    const r = runBash(
      `set -euo pipefail
       source '${SCRIPT}'
       require_eval_gate 'conf/**'
       stat -c '%a' "\${EVAL_GATE_LATCH_FILE}"
       cat "\${EVAL_GATE_LATCH_FILE}"
       echo "NONCE=\${EVAL_GATE_LATCH_NONCE}"`,
      repoSmall,
      { [`CHECK_${smallHead.slice(0, 7)}`]: "green" },
    );
    expect(r.status).toBe(0);
    expect(r.out).toContain("600");
    const nonce = /NONCE=(\S+)/.exec(r.out)?.[1];
    expect(nonce).toBeTruthy();
    expect(r.out).toContain(`${smallHead} ${nonce}`);
  });
});

describe("F4a: unreadable history refuses", () => {
  it("refuses when git diff AND git show both fail for HEAD (shimmed git)", () => {
    const r = runGate(repoSmall, {}, ["conf/**"], gitShimDir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("cannot read the file list for HEAD");
    expect(r.out).toContain("git diff and git show both failed");
  });

  it("_eval_gate_commit_files returns non-zero for an unreadable sha (direct call)", () => {
    const r = runBash(
      `source '${SCRIPT}'
       if _eval_gate_commit_files "$PWD" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef; then
         echo "RC=0"
       else
         echo "RC=nonzero"
       fi`,
      repoSmall,
    );
    expect(r.out).toContain("RC=nonzero");
  });
});
