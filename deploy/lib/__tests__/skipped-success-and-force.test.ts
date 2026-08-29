import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import {
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
 * TEAM-3426 acceptance tests. Same hermetic pattern as gate-hardening.test.ts:
 * bash subprocesses, throwaway git fixture repos, PATH-shimmed fake `gh`/`aws`.
 *
 * Findings under test:
 *   Finding 3 (P1, gate bypass) — a `conclusion=success` check identified as
 *     SKIPPED (the workflow's skip-publish check for PRs touching no gated
 *     path) is NOT evaluation evidence: it must never latch, never anchor the
 *     belt scan, and never green-light HEAD. Only a success carrying the
 *     `config-evals-gate-verdict: PASS` marker (or, pre-marker, a title
 *     starting with PASS) is green; a success with no output payload at all
 *     fails CLOSED and reads as absent.
 *   Finding 4 (P3, contract gap) — --force / --force-reason CLI break-glass
 *     on the runtime-agent deploy scripts routes to the SAME audited
 *     EVAL_GATE_OVERRIDE path; --force without a reason and unknown flags
 *     error out before any deploy work; no-arg gated scripts reject --force
 *     explicitly instead of silently ignoring it.
 */

const SCRIPT = resolve(__dirname, "../check-eval-gate.sh");
const DEPLOY_ONE = resolve(__dirname, "../../runtime-agent/deploy-one.sh");
const DEPLOY_SH = resolve(__dirname, "../../runtime-agent/deploy.sh");
const WM_DEPLOY = resolve(__dirname, "../../workflow-manager/deploy.sh");

// Env-keyed gh shim, extended from the gate-hardening protocol:
//   CHECK_<sha7>=green|pass|bare|skipped|red|absent → commits/<sha>/check-runs.
//   green   — success with the `config-evals-gate-verdict: PASS` marker
//             (what the workflow publishes for a real battery pass).
//   pass    — success with the battery-pass TITLE but no marker (a pre-marker
//             historical check: green via the title fallback).
//   bare    — success with NO output field at all: unidentifiable, must fail
//             CLOSED and read as absent (TEAM-3426 FINDING 3).
//   skipped — success with the skip-publish check's output, matching
//             .github/workflows/config-evals-gate.yml's skip-publish job.
// pulls always resolves to [] (no merged-PR evidence anywhere).
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
          green)   echo '{"total_count":1,"check_runs":[{"status":"completed","conclusion":"success","html_url":"http://check/x","output":{"title":"PASS — config evals battery held the baseline","summary":"config-evals-gate-verdict: PASS\\n\\n- all cases held the baseline"}}]}' ;;
          bare)    echo '{"total_count":1,"check_runs":[{"status":"completed","conclusion":"success","html_url":"http://check/x"}]}' ;;
          pass)    echo '{"total_count":1,"check_runs":[{"status":"completed","conclusion":"success","html_url":"http://check/x","output":{"title":"PASS — config evals battery held the baseline","summary":"all cases held"}}]}' ;;
          skipped) echo '{"total_count":1,"check_runs":[{"status":"completed","conclusion":"success","html_url":"http://check/x","output":{"title":"SKIPPED — no gated paths changed","summary":"This PR touches no gated path; the battery did not run."}}]}' ;;
          red)     echo '{"total_count":1,"check_runs":[{"status":"completed","conclusion":"failure","html_url":"http://check/x","output":{"summary":"- CRED-2 failed"}}]}' ;;
          absent)  echo '{"total_count":0,"check_runs":[]}' ;;
        esac ;;
      */pulls) echo '[]' ;;
      *) echo '{}' ;;
    esac ;;
  *) exit 0 ;;
esac
`;

// aws shim: STS identity succeeds; s3 cp exit is AWS_S3_EXIT (default 1).
const AWS_SHIM = `#!/bin/bash
case "$*" in
  *get-caller-identity*) echo "arn:aws:iam::123456789012:role/test"; exit 0 ;;
  *"s3 cp"*) exit "\${AWS_S3_EXIT:-1}" ;;
  *) exit 1 ;;
esac
`;

// Deploy-tool shim: if a deploy script ever got past its arg validation and
// gate, this would leave a sentinel file behind.
const SENTINEL_SHIM = `#!/bin/bash
touch "\${SENTINEL:?}"
exit 0
`;

let tmp: string;
let binDir: string;
let sentinelToolDir: string;
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
      NODE_ENV: "test",
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
let repoBypass: string; // gated ancestor + ungated HEAD (the P1 repro shape)
let bypassAncestor: string; // the gated-touching ancestor sha
let repoGatedHead: string; // HEAD itself touches conf/
let gatedHead: string;
let repoUngated: string; // short fully-scanned history, nothing gated ever
let ungatedHead: string;
let repoGatedPrompts: string; // HEAD touches deploy-one.sh's gated glob
let dummyAgent: string; // valid-looking positional for deploy-one.sh

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "skipped-force-test-"));
  binDir = join(tmp, "bin");
  sentinelToolDir = join(tmp, "sentinel-tools");
  fakeHome = join(tmp, "home");
  mkdirSync(binDir);
  mkdirSync(sentinelToolDir);
  mkdirSync(fakeHome);
  writeFileSync(join(binDir, "gh"), GH_SHIM, { mode: 0o755 });
  writeFileSync(join(binDir, "aws"), AWS_SHIM, { mode: 0o755 });
  writeFileSync(join(sentinelToolDir, "agentcore"), SENTINEL_SHIM, { mode: 0o755 });
  writeFileSync(join(sentinelToolDir, "aws"), SENTINEL_SHIM, { mode: 0o755 });

  // The bypass shape: c1 ungated base, c2 touches conf/ (gated), c3 = HEAD
  // ungated with no check. The skipped-success sits on c2.
  repoBypass = makeRepo(
    "bypass",
    `echo base > readme.txt && git add . && git commit -qm c1
     mkdir conf && echo a > conf/gated.txt && git add . && git commit -qm c2
     echo b > ungated.txt && git add . && git commit -qm c3`,
  );
  bypassAncestor = sha(repoBypass, "HEAD^");

  repoGatedHead = makeRepo(
    "gated-head",
    `echo base > readme.txt && git add . && git commit -qm c1
     mkdir conf && echo a > conf/gated.txt && git add . && git commit -qm c2`,
  );
  gatedHead = sha(repoGatedHead);

  repoUngated = makeRepo(
    "ungated",
    `echo base > readme.txt && git add . && git commit -qm c1
     echo b > other.txt && git add . && git commit -qm c2`,
  );
  ungatedHead = sha(repoUngated);

  // For deploy-one.sh (gates deploy/runtime-agent/prompts/**): HEAD touches a
  // prompt with no check anywhere → the gate refuses unless break-glass runs.
  repoGatedPrompts = makeRepo(
    "gated-prompts",
    `echo base > readme.txt && git add . && git commit -qm c1
     mkdir -p deploy/runtime-agent/prompts
     echo 'be helpful' > deploy/runtime-agent/prompts/some_agent.txt
     git add . && git commit -qm c2`,
  );
  dummyAgent = "some_agent";
}, 180_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("Finding 3: a SKIPPED success is not evaluation evidence", () => {
  it("P1 BYPASS REPRO: a skipped-success on the gated ancestor must NOT anchor the belt scan — REFUSES", () => {
    const r = runGate(repoBypass, {
      [`CHECK_${bypassAncestor.slice(0, 7)}`]: "skipped",
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("EVAL GATE REFUSED");
    expect(r.out).toContain(`ancestor commit ${bypassAncestor}`);
    expect(r.out).toContain("touched gated path 'conf/gated.txt'");
    expect(r.out).toContain("without a green");
    // The operator NOTE explains WHY the success was not accepted.
    expect(r.out).toContain("is a SKIPPED success");
    expect(r.out).toContain("NOT evidence that the tree was evaluated");
    expect(r.out).not.toContain("green anchor");
    expect(r.out).not.toContain("proceeding (informational");
  });

  it("contrast: the same shape with a REAL marker-verified PASS on the ancestor anchors and proceeds", () => {
    const r = runGate(repoBypass, {
      [`CHECK_${bypassAncestor.slice(0, 7)}`]: "green",
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain(`green anchor at ancestor ${bypassAncestor}`);
    expect(r.out).toContain("proceeding (informational, not latched)");
    expect(r.out).not.toContain("EVAL GATE REFUSED");
  });

  it("a skipped-success on HEAD cannot green-light HEAD's own gated diff — REFUSES with the operator info line", () => {
    const r = runGate(repoGatedHead, {
      [`CHECK_${gatedHead.slice(0, 7)}`]: "skipped",
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("is a SKIPPED success");
    expect(r.out).toContain("Treating it as absent evidence");
    expect(r.out).toContain("EVAL GATE REFUSED");
    expect(r.out).toContain("touches gated path 'conf/gated.txt'");
    expect(r.out).not.toContain("is green on HEAD");
  });

  it("a skipped-success on HEAD with nothing gated in a fully-scanned history still proceeds informationally, unlatched", () => {
    const r = runGate(repoUngated, {
      [`CHECK_${ungatedHead.slice(0, 7)}`]: "skipped",
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain("is a SKIPPED success");
    expect(r.out).toContain("proceeding (informational, not latched)");
    expect(r.out).toContain("LATCH=unset");
    expect(r.out).not.toContain("EVAL GATE REFUSED");
  });

  it("a pre-marker check with a PASS title (no marker) is still green via the title fallback and latches", () => {
    const r = runGate(repoGatedHead, {
      [`CHECK_${gatedHead.slice(0, 7)}`]: "pass",
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain(`is green on HEAD (${gatedHead})`);
    expect(r.out).toContain(`LATCH=${gatedHead}`);
    expect(r.out).not.toContain("EVAL GATE REFUSED");
  });

  it("a success with NO output field on a gated HEAD fails CLOSED — unidentifiable is not green", () => {
    const r = runGate(repoGatedHead, {
      [`CHECK_${gatedHead.slice(0, 7)}`]: "bare",
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("NOT identifiable as a battery PASS");
    expect(r.out).toContain("EVAL GATE REFUSED");
    expect(r.out).not.toContain("is green on HEAD");
  });
});

describe("Finding 4: --force CLI break-glass on deploy-one.sh", () => {
  it("--force with no reason exits 1 before any deploy work (BG-2)", () => {
    const sentinel = join(tmp, "force-noreason.sentinel");
    const r = runBash(
      `'${DEPLOY_ONE}' --force ${dummyAgent}`,
      repoGatedPrompts,
      { SENTINEL: sentinel },
      sentinelToolDir,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("--force requires --force-reason");
    expect(r.out).toContain("(BG-2)");
    expect(r.ghCalls).toHaveLength(0); // died before the gate, let alone deploy
    expect(existsSync(sentinel)).toBe(false);
  });

  it("an unknown flag is rejected with usage, never silently misparsed as the agent name", () => {
    const sentinel = join(tmp, "unknown-flag.sentinel");
    const r = runBash(
      `'${DEPLOY_ONE}' --frce ${dummyAgent}`,
      repoGatedPrompts,
      { SENTINEL: sentinel },
      sentinelToolDir,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("unknown option '--frce'");
    expect(r.out).toContain("Usage: deploy-one.sh");
    expect(r.out).not.toContain("FAIL --frce"); // the old misparse symptom
    expect(existsSync(sentinel)).toBe(false);
  });

  it("--force --force-reason engages the SAME audited break-glass path and gets past the refusal", () => {
    // Gated HEAD with no check anywhere: the gate refuses, then the override
    // (exported by --force/--force-reason) audits (aws s3 shim succeeds,
    // local log append succeeds) and proceeds. The script then dies at the
    // real deploy tooling (`agentcore` is deliberately not shimmed) — the
    // assertions cover the gate stage only.
    const r = runBash(
      `'${DEPLOY_ONE}' --force --force-reason 'INC-1: test' ${dummyAgent}`,
      repoGatedPrompts,
      {
        AGENTCORE_ROLE_ARN: "arn:aws:iam::123456789012:role/fake",
        GITHUB_PAT: "ghp_fake",
        ARTIFACT_BUCKET: "fake-bucket",
        AWS_S3_EXIT: "0",
      },
    );
    expect(r.out).toContain(
      "--force break-glass requested — routing through the audited eval-gate override",
    );
    expect(r.out).toContain("EVAL GATE BREAK-GLASS OVERRIDE — DEPLOYING UNGATED");
    expect(r.out).toContain("reason      : INC-1: test");
    expect(r.out).toContain(
      "override audited to s3://fake-bucket/eval-gate/overrides/",
    );
    expect(r.out).toContain("proceeding under break-glass override");
    expect(r.out).not.toContain("EVAL GATE REFUSED");
    // The audit record landed in the fixture repo's local log too.
    const log = readFileSync(
      join(repoGatedPrompts, ".eval-gate-overrides.log"),
      "utf8",
    );
    expect(log).toContain("INC-1: test");
  });
});

describe("Finding 4: --force CLI break-glass on deploy.sh", () => {
  it("--force with no reason exits 1 during the early arg loop (no AWS creds needed)", () => {
    const sentinel = join(tmp, "deploy-sh-noreason.sentinel");
    const r = runBash(
      `'${DEPLOY_SH}' --force 10`,
      tmp,
      { SENTINEL: sentinel },
      sentinelToolDir,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("--force requires --force-reason");
    expect(r.out).toContain("(BG-2)");
    expect(r.out).not.toContain("Deploying"); // never reached target resolution
    expect(existsSync(sentinel)).toBe(false);
  });

  it("an unknown flag exits 1 pointing at --help", () => {
    const sentinel = join(tmp, "deploy-sh-unknown.sentinel");
    const r = runBash(
      `'${DEPLOY_SH}' --forc 10`,
      tmp,
      { SENTINEL: sentinel },
      sentinelToolDir,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("unknown option '--forc'");
    expect(r.out).toContain("--help");
    expect(existsSync(sentinel)).toBe(false);
  });
});

describe("Finding 4: no-args gated scripts reject --force explicitly", () => {
  it("workflow-manager/deploy.sh --force exits 1 pointing at the env-var break-glass", () => {
    const sentinel = join(tmp, "wm-force.sentinel");
    const r = runBash(
      `'${WM_DEPLOY}' --force`,
      tmp,
      { SENTINEL: sentinel },
      sentinelToolDir,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("takes no arguments");
    expect(r.out).toContain("--force");
    expect(r.out).toContain("EVAL_GATE_OVERRIDE=1 EVAL_GATE_OVERRIDE_REASON=");
    expect(existsSync(sentinel)).toBe(false);
  });
});
