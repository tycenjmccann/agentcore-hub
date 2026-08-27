import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import {
  chmodSync,
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
 * Unit tests for deploy/lib/check-eval-gate.sh (TEAM-3337 A1–A4).
 *
 * Hermetic like the rest of this suite: no network, no real GitHub. Each test
 * runs `require_eval_gate` in a bash subprocess against a throwaway git
 * fixture repo, with a PATH-shimmed fake `gh` whose responses are selected by
 * env vars keyed on the first 7 chars of the queried sha:
 *
 *   CHECK_<sha7>=green|red|running|absent|error   → commits/<sha>/check-runs
 *   PULLS_<sha7>=merged|merged2|none|error        → commits/<sha>/pulls
 *
 * Global/system git config is neutralized (GIT_CONFIG_GLOBAL=/dev/null) so
 * environment-level url.insteadOf rewrites can't mangle the fixture's
 * `origin` remote, which the guard parses for owner/repo.
 */

const SCRIPT = resolve(__dirname, "../check-eval-gate.sh");

// 40-hex fake PR head sha the gh shim hands back for merged-PR resolutions.
const PR_HEAD = "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee";
const PR_HEAD7 = PR_HEAD.slice(0, 7);

const GH_SHIM = `#!/bin/bash
# Fake gh for check-eval-gate tests — see the header of the .test.ts file.
# Appends every invocation to $GH_CALL_LOG when set.
if [ -n "\${GH_CALL_LOG:-}" ]; then echo "$*" >> "$GH_CALL_LOG"; fi
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
          green)   echo '{"total_count":1,"check_runs":[{"status":"completed","conclusion":"success","html_url":"http://check/x"}]}' ;;
          red)     echo '{"total_count":1,"check_runs":[{"status":"completed","conclusion":"failure","html_url":"http://check/x","output":{"summary":"- CRED-2 failed"}}]}' ;;
          running) echo '{"total_count":1,"check_runs":[{"status":"in_progress","conclusion":null,"html_url":"http://check/x"}]}' ;;
          absent)  echo '{"total_count":0,"check_runs":[]}' ;;
          error)   echo "gh: HTTP 403 rate limit" >&2; exit 1 ;;
        esac ;;
      */pulls)
        var="PULLS_$key"; mode="\${!var:-none}"
        pr="{\\"number\\":42,\\"merged_at\\":\\"2026-01-01T00:00:00Z\\",\\"merge_commit_sha\\":\\"\${FULLSHA_FOR_PULLS:-}\\",\\"head\\":{\\"sha\\":\\"\${PR_HEAD_SHA:-}\\"}}"
        case "$mode" in
          merged)  echo "[$pr]" ;;
          merged2) echo "[$pr,$pr]" ;;
          none)    echo '[]' ;;
          error)   echo "gh: HTTP 500" >&2; exit 1 ;;
        esac ;;
      *) echo '{}' ;;
    esac ;;
  *) exit 0 ;;
esac
`;

let tmp: string;
let binDir: string;
let fakeHome: string;
let callCounter = 0;

// Env for building fixtures and running the guard: identity pinned, global +
// system git config neutralized so host-level insteadOf rewrites can't touch
// the fixture origin URL.
const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

/** Create a fixture repo and run `script` (bash) inside it. */
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

/**
 * Run require_eval_gate in `repo` with a minimal environment (fake gh first
 * on PATH). Returns exit status, combined output, the exported latch value
 * observed after the call (or "unset"), and the fake-gh call log.
 */
function runGate(
  repo: string,
  extraEnv: Record<string, string> = {},
  globs: string[] = ["conf/**"],
) {
  const callLog = join(tmp, `gh-calls-${callCounter++}.log`);
  const quoted = globs.map((g) => `'${g}'`).join(" ");
  const res = spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
       source '${SCRIPT}'
       require_eval_gate ${quoted}
       echo "LATCH=\${EVAL_GATE_CHECKED:-unset}"`,
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`,
        HOME: fakeHome,
        GH_CALL_LOG: callLog,
        ...gitEnv,
        ...extraEnv,
      },
    },
  );
  const out = (res.stdout ?? "") + (res.stderr ?? "");
  const latch = /LATCH=(\S+)/.exec(res.stdout ?? "")?.[1] ?? "unset";
  const ghCalls = existsSync(callLog)
    ? readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return { status: res.status, out, latch, ghCalls };
}

// Shared fixtures (built once — each test only varies env).
let repoBasic: string; // c1 touches conf/ (gated), c2 = HEAD ungated
let basicC1: string;
let basicHead: string;
let repoGatedHead: string; // HEAD itself touches conf/
let gatedHead: string;
let repoClean: string; // short, fully ungated history
let repoAnchor: string; // gated-no-evidence below a green gated anchor
let anchorSha: string;
let anchorDeepGated: string;
let repoMid: string; // gated touch at depth 25 (old belt window was 20)
let midGated: string;
let repoDeep: string; // 106 ungated commits — belt cap territory

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "eval-gate-test-"));
  binDir = join(tmp, "bin");
  fakeHome = join(tmp, "home");
  mkdirSync(binDir);
  mkdirSync(fakeHome);
  writeFileSync(join(binDir, "gh"), GH_SHIM);
  chmodSync(join(binDir, "gh"), 0o755);

  repoBasic = makeRepo(
    "basic",
    `mkdir conf && echo a > conf/gated.txt && git add . && git commit -qm c1
     echo b > ungated.txt && git add . && git commit -qm c2`,
  );
  basicC1 = sha(repoBasic, "HEAD^");
  basicHead = sha(repoBasic);

  repoGatedHead = makeRepo(
    "gated-head",
    `echo b > ungated.txt && git add . && git commit -qm c1
     mkdir conf && echo a > conf/gated.txt && git add . && git commit -qm c2`,
  );
  gatedHead = sha(repoGatedHead);

  repoClean = makeRepo(
    "clean",
    `echo a > f.txt && git add . && git commit -qm c1
     echo b > f.txt && git commit -qam c2`,
  );

  repoAnchor = makeRepo(
    "anchor",
    `mkdir conf
     echo deep > conf/gated.txt && git add . && git commit -qm gated-deep
     echo x > f.txt && git add . && git commit -qm filler
     echo anchor > conf/gated.txt && git commit -qam gated-anchor
     echo y > f.txt && git commit -qam top`,
  );
  anchorSha = sha(repoAnchor, "HEAD^");
  anchorDeepGated = sha(repoAnchor, "HEAD~3");

  repoMid = makeRepo(
    "mid",
    `echo 0 > f.txt && git add . && git commit -qm base
     mkdir conf && echo a > conf/gated.txt && git add conf && git commit -qm gated
     for i in $(seq 1 25); do echo $i > f.txt && git commit -qam "c$i" >/dev/null; done`,
  );
  midGated = sha(repoMid, "HEAD~25");

  repoDeep = makeRepo(
    "deep",
    `echo 0 > f.txt && git add . && git commit -qm c0
     for i in $(seq 1 105); do echo $i > f.txt && git commit -qam "c$i" >/dev/null; done`,
  );
}, 120_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("latch (A2/A4)", () => {
  it("short-circuits loudly with ZERO gh calls when EVAL_GATE_CHECKED == HEAD sha", () => {
    const r = runGate(repoBasic, {
      EVAL_GATE_CHECKED: basicHead,
      [`CHECK_${basicHead.slice(0, 7)}`]: "red", // would refuse if it ran
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain(`already verified in this process tree`);
    expect(r.out).toContain(basicHead);
    expect(r.ghCalls).toHaveLength(0);
  });

  it("loudly ignores the legacy latch value '1' and runs the full check", () => {
    const r = runGate(repoBasic, {
      EVAL_GATE_CHECKED: "1",
      [`CHECK_${basicHead.slice(0, 7)}`]: "green",
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain("IGNORING the stale/foreign latch");
    expect(r.out).toContain("is green on HEAD");
    expect(r.ghCalls.length).toBeGreaterThan(0);
  });

  it("loudly ignores a stale/foreign sha latch and runs the full check (refusing on red)", () => {
    const r = runGate(repoBasic, {
      EVAL_GATE_CHECKED: basicC1, // real sha, but not HEAD
      [`CHECK_${basicHead.slice(0, 7)}`]: "red",
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("IGNORING the stale/foreign latch");
    expect(r.out).toContain("concluded 'failure'");
  });

  it("does NOT export the latch on the informational proceed", () => {
    const r = runGate(repoClean);
    expect(r.status).toBe(0);
    expect(r.out).toContain("proceeding (informational, not latched)");
    expect(r.latch).toBe("unset");
  });

  it("exports latch=HEAD sha on verified green", () => {
    const r = runGate(repoBasic, {
      [`CHECK_${basicHead.slice(0, 7)}`]: "green",
    });
    expect(r.status).toBe(0);
    expect(r.latch).toBe(basicHead);
  });
});

describe("merge-commit resolution (A1)", () => {
  it("proceeds (and latches HEAD) when HEAD resolves to exactly one merged PR with a green head check", () => {
    const r = runGate(repoBasic, {
      [`PULLS_${basicHead.slice(0, 7)}`]: "merged",
      FULLSHA_FOR_PULLS: basicHead,
      PR_HEAD_SHA: PR_HEAD,
      [`CHECK_${PR_HEAD7}`]: "green",
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain(`green on PR #42 head ${PR_HEAD}, merged as HEAD ${basicHead}`);
    expect(r.latch).toBe(basicHead);
  });

  it("refuses when the resolved PR head check is red", () => {
    const r = runGate(repoBasic, {
      [`PULLS_${basicHead.slice(0, 7)}`]: "merged",
      FULLSHA_FOR_PULLS: basicHead,
      PR_HEAD_SHA: PR_HEAD,
      [`CHECK_${PR_HEAD7}`]: "red",
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain(`PR #42 head ${PR_HEAD}`);
    expect(r.out).toContain("concluded 'failure'");
  });

  it("refuses when the resolved PR head check is still running", () => {
    const r = runGate(repoBasic, {
      [`PULLS_${basicHead.slice(0, 7)}`]: "merged",
      FULLSHA_FOR_PULLS: basicHead,
      PR_HEAD_SHA: PR_HEAD,
      [`CHECK_${PR_HEAD7}`]: "running",
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("still running (in_progress)");
  });

  it("refuses a gated-path HEAD with zero matching PRs (direct push)", () => {
    const r = runGate(repoGatedHead);
    expect(r.status).toBe(1);
    expect(r.out).toContain("The gate was bypassed (direct push?)");
  });

  it("refuses a gated-path HEAD when TWO PRs match (ambiguous resolution)", () => {
    const r = runGate(repoGatedHead, {
      [`PULLS_${gatedHead.slice(0, 7)}`]: "merged2",
      FULLSHA_FOR_PULLS: gatedHead,
      PR_HEAD_SHA: PR_HEAD,
      [`CHECK_${PR_HEAD7}`]: "green", // must never be consulted
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("The gate was bypassed (direct push?)");
  });

  it("refuses a gated-path HEAD when the pulls API errors (fail closed)", () => {
    const r = runGate(repoGatedHead, {
      [`PULLS_${gatedHead.slice(0, 7)}`]: "error",
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("The gate was bypassed (direct push?)");
  });

  it("refuses when the check-runs API errors on HEAD (fail closed)", () => {
    const r = runGate(repoBasic, {
      [`CHECK_${basicHead.slice(0, 7)}`]: "error",
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("GitHub API error while querying check runs");
  });
});

describe("belt loop (A3)", () => {
  it("refuses a gated direct-push ancestor at depth 25 with no evidence (old max-count=20 was fail-open)", () => {
    const r = runGate(repoMid);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`ancestor commit ${midGated} touched gated path`);
    expect(r.out).toContain("without a green config-evals-gate check");
  });

  it("stops the scan at a green anchor — deeper gated commits are never examined", () => {
    const r = runGate(repoAnchor, {
      [`CHECK_${anchorSha.slice(0, 7)}`]: "green",
      // deeper gated commit has NO evidence — must not matter (and must not be queried)
    });
    expect(r.status).toBe(0);
    expect(r.out).toContain(`green anchor at ancestor ${anchorSha}`);
    expect(r.latch).toBe("unset"); // A4: glob-specific verdict, not latched
    expect(r.ghCalls.join("\n")).not.toContain(anchorDeepGated);
  });

  it("proceeds with an explicit residual warning when the 100-commit cap is hit on clean history", () => {
    const r = runGate(repoDeep);
    expect(r.status).toBe(0);
    expect(r.out).toContain("hard cap reached");
    expect(r.out).toContain("Residual risk");
    expect(r.latch).toBe("unset");
  });
});
