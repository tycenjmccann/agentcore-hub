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
 * TEAM-3426 FINDING 4 — the `--force` break-glass CLI path.
 *
 * The feature contract promised a `--force` flag, but break-glass was
 * env-var-only: `deploy-one.sh --force <agent>` assigned "--force" to
 * AGENT_NAME and ran the NORMAL gate (silent misparse), and `deploy.sh --force`
 * died with "Unknown agent '--force'".
 *
 * Parsing now lives in one sourceable helper, deploy/lib/parse-force-args.sh,
 * used by both scripts. It is sugar over the audited env-var override: it
 * exports EVAL_GATE_OVERRIDE=1 + EVAL_GATE_OVERRIDE_REASON before
 * require_eval_gate runs, so both routes hit the same _eval_gate_break_glass
 * audit trail. Covered here:
 *   * unit: every accepted/rejected flag shape, and what gets exported
 *   * end-to-end: deploy-one.sh refuses --force with no reason before ANY gate
 *     or deploy work; rejects unknown flags; and with a reason actually takes
 *     the audited break-glass path through a real gate refusal
 *   * end-to-end: deploy.sh no longer reports --force as an "Unknown agent",
 *     and documents the flags in --help
 */

const PARSER = resolve(__dirname, "../parse-force-args.sh");
const GATE = resolve(__dirname, "../check-eval-gate.sh");
const DEPLOY_ONE = resolve(__dirname, "../../runtime-agent/deploy-one.sh");
const DEPLOY_ALL = resolve(__dirname, "../../runtime-agent/deploy.sh");

// Same env-keyed gh shim protocol as the sibling suites: CHECK_<sha7> selects
// the payload; every sha defaults to `absent` (no check run at all), which is
// what a break-glass scenario looks like.
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
          green)  echo '{"total_count":1,"check_runs":[{"status":"completed","conclusion":"success","html_url":"http://check/x","output":{"title":"PASS — config evals battery held the baseline","summary":"config-evals-gate-verdict: PASS\\n\\n- all cases held the baseline"}}]}' ;;
          absent) echo '{"total_count":0,"check_runs":[]}' ;;
        esac ;;
      */pulls) echo '[]' ;;
      *) echo '{}' ;;
    esac ;;
  *) exit 0 ;;
esac
`;

// aws shim: STS identity resolves and s3 writes SUCCEED, so break-glass gets a
// durable audit record and is allowed to proceed (the audit-failure paths are
// covered by gate-hardening.test.ts F4b).
const AWS_SHIM = `#!/bin/bash
case "$*" in
  *get-caller-identity*) echo "arn:aws:iam::123456789012:role/test"; exit 0 ;;
  *"s3 cp"*) exit "\${AWS_S3_EXIT:-0}" ;;
  *) exit 1 ;;
esac
`;

// Stands in for every deploy tool deploy-one.sh would reach AFTER the gate.
// Its sentinel proves whether execution got past the gate at all.
const SENTINEL_SHIM = `#!/bin/bash
touch "\${SENTINEL:?}"
exit 0
`;

let tmp: string;
let binDir: string;
let toolDir: string;
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
        EVAL_GATE: "enforce",
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
  return { status: res.status, out, ghCalls };
}

/**
 * Source the parser, run parse_force_args with the given argv, and print what
 * it produced. `set -u` is on: an unset export must not be papered over.
 */
function parse(argv: string[], extraEnv: Record<string, string> = {}) {
  const quoted = argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const r = runBash(
    `set -uo pipefail
     source '${PARSER}'
     if parse_force_args ${quoted}; then
       echo "RC=0"
     else
       echo "RC=1"
     fi
     echo "POS_COUNT=\${#FORCE_ARGS_POSITIONAL[@]}"
     if [ "\${#FORCE_ARGS_POSITIONAL[@]}" -gt 0 ]; then
       printf 'POS=%s\\n' "\${FORCE_ARGS_POSITIONAL[*]}"
     fi
     echo "OVERRIDE=\${EVAL_GATE_OVERRIDE:-unset}"
     echo "REASON=\${EVAL_GATE_OVERRIDE_REASON:-unset}"`,
    tmp,
    extraEnv,
  );
  return r;
}

/** A fixture repo laid out like the real one, so deploy scripts resolve libs. */
function makeRepoWithScripts(name: string, script: string): string {
  const dir = join(tmp, name);
  mkdirSync(join(dir, "deploy", "lib"), { recursive: true });
  mkdirSync(join(dir, "deploy", "runtime-agent"), { recursive: true });
  copyFileSync(GATE, join(dir, "deploy", "lib", "check-eval-gate.sh"));
  copyFileSync(PARSER, join(dir, "deploy", "lib", "parse-force-args.sh"));
  copyFileSync(DEPLOY_ONE, join(dir, "deploy", "runtime-agent", "deploy-one.sh"));
  chmodSync(join(dir, "deploy", "runtime-agent", "deploy-one.sh"), 0o755);
  execSync(
    `set -euo pipefail
     git init -q -b main
     git remote add origin https://github.com/acme/widgets.git
     ${script}`,
    { cwd: dir, shell: "/bin/bash", env: { ...process.env, ...gitEnv } },
  );
  return dir;
}

// deploy-one.sh needs these to get anywhere at all; the gate runs before them.
const DEPLOY_ENV = {
  AGENTCORE_ROLE_ARN: "arn:aws:iam::123456789012:role/fake",
  GITHUB_PAT: "ghp_fake",
  ARTIFACT_BUCKET: "fake-bucket",
};

let repoGated: string; // HEAD touches deploy/runtime-agent/prompts/** → gate refuses

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "force-flag-test-"));
  binDir = join(tmp, "bin");
  toolDir = join(tmp, "deploy-tools");
  fakeHome = join(tmp, "home");
  mkdirSync(binDir);
  mkdirSync(toolDir);
  mkdirSync(fakeHome);
  writeFileSync(join(binDir, "gh"), GH_SHIM, { mode: 0o755 });
  writeFileSync(join(binDir, "aws"), AWS_SHIM, { mode: 0o755 });
  // The first deploy tool deploy-one.sh reaches after the gate; if it runs, a
  // sentinel proves execution got past the gate.
  writeFileSync(join(toolDir, "agentcore"), SENTINEL_SHIM, { mode: 0o755 });

  repoGated = makeRepoWithScripts(
    "gated",
    `git add . && git commit -qm scripts
     mkdir -p deploy/runtime-agent/prompts
     echo hello > deploy/runtime-agent/prompts/backend_dev.md
     git add . && git commit -qm "touch a gated prompt"`,
  );
}, 120_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("parse_force_args: accepted shapes", () => {
  it("passes a bare agent name through and exports nothing", () => {
    const r = parse(["backend_dev"]);
    expect(r.out).toContain("RC=0");
    expect(r.out).toContain("POS=backend_dev");
    expect(r.out).toContain("OVERRIDE=unset");
    expect(r.out).toContain("REASON=unset");
    expect(r.out).not.toContain("break-glass requested");
  });

  it("--force --force-reason '<why>' exports the audited override and says so loudly", () => {
    const r = parse(["--force", "--force-reason", "INC-1: why", "backend_dev"]);
    expect(r.out).toContain("RC=0");
    expect(r.out).toContain("POS=backend_dev");
    expect(r.out).toContain("OVERRIDE=1");
    expect(r.out).toContain("REASON=INC-1: why");
    expect(r.out).toContain(
      "--force break-glass requested — routing through the audited eval-gate override",
    );
  });

  it("--force-reason=<why> (inline form) parses", () => {
    const r = parse(["--force", "--force-reason=inline", "backend_dev"]);
    expect(r.out).toContain("RC=0");
    expect(r.out).toContain("OVERRIDE=1");
    expect(r.out).toContain("REASON=inline");
    expect(r.out).toContain("POS=backend_dev");
  });

  it("accepts an inherited EVAL_GATE_OVERRIDE_REASON as the reason for --force", () => {
    const r = parse(["--force", "backend_dev"], {
      EVAL_GATE_OVERRIDE_REASON: "INC-2: from the env",
    });
    expect(r.out).toContain("RC=0");
    expect(r.out).toContain("OVERRIDE=1");
    expect(r.out).toContain("REASON=INC-2: from the env");
    expect(r.out).toContain("reason from EVAL_GATE_OVERRIDE_REASON env var");
  });

  it("never silently drops a CLI reason: --force-reason wins over an env reason", () => {
    const r = parse(["--force", "--force-reason", "cli: wins", "backend_dev"], {
      EVAL_GATE_OVERRIDE: "1",
      EVAL_GATE_OVERRIDE_REASON: "env: loses",
    });
    expect(r.out).toContain("RC=0");
    expect(r.out).toContain("REASON=cli: wins");
    expect(r.out).not.toContain("REASON=env: loses");
  });

  it("keeps multiple positionals in order (deploy.sh's numeric/name args)", () => {
    const r = parse(["--force", "--force-reason", "r", "10", "11", "12"]);
    expect(r.out).toContain("RC=0");
    expect(r.out).toContain("POS=10 11 12");
  });

  it("treats everything after `--` as positional, even a leading-dash name", () => {
    const r = parse(["--force", "--force-reason", "r", "--", "--weird-name"]);
    expect(r.out).toContain("RC=0");
    expect(r.out).toContain("POS=--weird-name");
  });

  it("leaves FORCE_ARGS_POSITIONAL as a declared empty array for no args", () => {
    const r = parse([]);
    expect(r.out).toContain("RC=0");
    expect(r.out).toContain("POS_COUNT=0");
    expect(r.out).toContain("OVERRIDE=unset");
  });
});

describe("parse_force_args: refusals (fail closed, never a silent misparse)", () => {
  it("--force with no reason is REFUSED (BG-2) and exports nothing", () => {
    const r = parse(["--force", "backend_dev"]);
    expect(r.out).toContain("RC=1");
    expect(r.out).toContain(
      "--force requires --force-reason '<incident/why>' — an unexplained break-glass override is refused (BG-2)",
    );
    expect(r.out).toContain("OVERRIDE=unset");
    expect(r.out).toContain("REASON=unset");
  });

  it("--force --force-reason '' (empty reason) is REFUSED", () => {
    const r = parse(["--force", "--force-reason", "", "backend_dev"]);
    expect(r.out).toContain("RC=1");
    expect(r.out).toContain("requires a non-empty --force-reason");
    expect(r.out).toContain("OVERRIDE=unset");
  });

  it("--force-reason with no value at all is REFUSED", () => {
    const r = parse(["--force", "--force-reason"]);
    expect(r.out).toContain("RC=1");
    expect(r.out).toContain("--force-reason requires a value");
  });

  it("--force-reason without --force is REFUSED rather than ignored", () => {
    const r = parse(["--force-reason", "why", "backend_dev"]);
    expect(r.out).toContain("RC=1");
    expect(r.out).toContain("--force-reason was given without --force");
    expect(r.out).toContain("OVERRIDE=unset");
  });

  it("an unknown flag is REFUSED by name and never becomes a positional", () => {
    const r = parse(["--frce", "backend_dev"]);
    expect(r.out).toContain("RC=1");
    expect(r.out).toContain("unknown option '--frce'");
    expect(r.out).not.toContain("POS=--frce");
  });
});

describe("deploy-one.sh --force end-to-end", () => {
  const sentinel = () => join(tmp, `deploy-ran-${callCounter}.sentinel`);

  it("REFUSES --force with no reason before any gate or deploy work", () => {
    const s = sentinel();
    const r = runBash(
      `bash deploy/runtime-agent/deploy-one.sh --force backend_dev`,
      repoGated,
      { ...DEPLOY_ENV, SENTINEL: s },
      toolDir,
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(
      "--force requires --force-reason '<incident/why>' — an unexplained break-glass override is refused (BG-2)",
    );
    // Usage is printed, and it documents both flags.
    expect(r.out).toContain("Usage: deploy-one.sh");
    expect(r.out).toContain("--force-reason <why>");
    // Nothing gate- or deploy-related ran.
    expect(r.ghCalls).toHaveLength(0);
    expect(r.out).not.toContain("EVAL GATE REFUSED");
    expect(existsSync(s)).toBe(false);
  });

  it("REJECTS an unknown flag with usage instead of misparsing it as the agent name", () => {
    const s = sentinel();
    const r = runBash(
      `bash deploy/runtime-agent/deploy-one.sh --frce backend_dev`,
      repoGated,
      { ...DEPLOY_ENV, SENTINEL: s },
      toolDir,
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("unknown option '--frce'");
    expect(r.out).toContain("Usage: deploy-one.sh");
    expect(r.ghCalls).toHaveLength(0);
    expect(existsSync(s)).toBe(false);
  });

  it("no longer treats --force as the agent name (the FINDING 4 misparse)", () => {
    // DEPLOY_MODE=robust hands AGENT_NAME straight to deploy-one-robust.py, so a
    // python3 shim echoing its argv shows exactly what got parsed as the agent.
    // The old code arrived here with AGENT_NAME="--force".
    const pyDir = join(tmp, "py-shim");
    mkdirSync(pyDir, { recursive: true });
    writeFileSync(
      join(pyDir, "python3"),
      `#!/bin/bash\necho "ROBUST_ARGV: $*"\nexit 0\n`,
      { mode: 0o755 },
    );
    const head = execSync("git rev-parse HEAD", {
      cwd: repoGated,
      env: { ...process.env, ...gitEnv },
      encoding: "utf8",
    }).trim();
    const r = runBash(
      `bash deploy/runtime-agent/deploy-one.sh --force --force-reason 'INC-4: name' backend_dev`,
      repoGated,
      {
        ...DEPLOY_ENV,
        DEPLOY_MODE: "robust",
        [`CHECK_${head.slice(0, 7)}`]: "green",
      },
      pyDir,
    );
    const argv = /ROBUST_ARGV: (.*)$/m.exec(r.out)?.[1];
    expect(argv).toBeTruthy();
    expect(argv).toMatch(/deploy-one-robust\.py backend_dev$/);
    expect(argv).not.toContain("--force");
  });

  it("REJECTS a second positional (exactly one agent name is expected)", () => {
    const r = runBash(
      `bash deploy/runtime-agent/deploy-one.sh backend_dev api_dev`,
      repoGated,
      { ...DEPLOY_ENV },
      toolDir,
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("expected exactly one agent name, got 2");
    expect(r.ghCalls).toHaveLength(0);
  });

  it("REFUSES with the normal gate when --force is absent (gated HEAD, no check run)", () => {
    const r = runBash(
      `bash deploy/runtime-agent/deploy-one.sh backend_dev`,
      repoGated,
      { ...DEPLOY_ENV },
      toolDir,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("EVAL GATE REFUSED");
    expect(r.out).not.toContain("BREAK-GLASS OVERRIDE");
    // The refusal now advertises the CLI form as well as the env-var form.
    expect(r.out).toContain("--force --force-reason");
  });

  it("--force --force-reason routes the SAME gate refusal through the audited break-glass", () => {
    const r = runBash(
      `bash deploy/runtime-agent/deploy-one.sh --force --force-reason 'INC-1: hotfix' backend_dev`,
      repoGated,
      { ...DEPLOY_ENV },
      toolDir,
    );
    expect(r.out).toContain(
      "--force break-glass requested — routing through the audited eval-gate override",
    );
    expect(r.out).toContain("EVAL GATE BREAK-GLASS OVERRIDE — DEPLOYING UNGATED");
    expect(r.out).toContain("INC-1: hotfix");
    expect(r.out).toContain("override audited to s3://fake-bucket/eval-gate/overrides/");
    expect(r.out).toContain("proceeding under break-glass override");
    expect(r.out).not.toContain("EVAL GATE REFUSED");
    // Same audit trail as the env-var form: a local record exists too.
    expect(existsSync(join(repoGated, ".eval-gate-overrides.log"))).toBe(true);
    expect(readFileSync(join(repoGated, ".eval-gate-overrides.log"), "utf8")).toContain(
      "INC-1: hotfix",
    );
    rmSync(join(repoGated, ".eval-gate-overrides.log"), { force: true });
  });

  it("--force-reason=<why> also reaches the audited break-glass", () => {
    const r = runBash(
      `bash deploy/runtime-agent/deploy-one.sh --force --force-reason='INC-2: inline' backend_dev`,
      repoGated,
      { ...DEPLOY_ENV },
      toolDir,
    );
    expect(r.out).toContain("EVAL GATE BREAK-GLASS OVERRIDE — DEPLOYING UNGATED");
    expect(r.out).toContain("INC-2: inline");
    expect(r.out).not.toContain("EVAL GATE REFUSED");
    rmSync(join(repoGated, ".eval-gate-overrides.log"), { force: true });
  });

  it("--force is inert when the gate is already green (no override, no audit record)", () => {
    const head = execSync("git rev-parse HEAD", {
      cwd: repoGated,
      env: { ...process.env, ...gitEnv },
      encoding: "utf8",
    }).trim();
    const r = runBash(
      `bash deploy/runtime-agent/deploy-one.sh --force --force-reason 'INC-3: belt' backend_dev`,
      repoGated,
      { ...DEPLOY_ENV, [`CHECK_${head.slice(0, 7)}`]: "green" },
      toolDir,
    );
    expect(r.out).toContain("is green on HEAD");
    expect(r.out).not.toContain("EVAL GATE BREAK-GLASS OVERRIDE");
    expect(r.out).not.toContain("EVAL GATE REFUSED");
    expect(existsSync(join(repoGated, ".eval-gate-overrides.log"))).toBe(false);
  });
});

describe("deploy.sh --force wiring", () => {
  it("documents --force/--force-reason in --help (single source of truth with deploy-one.sh)", () => {
    const r = runBash(`bash '${DEPLOY_ALL}' --help`, tmp);
    expect(r.status).toBe(0);
    expect(r.out).toContain("--force");
    expect(r.out).toContain("--force-reason <why>");
    expect(r.out).toContain("EVAL_GATE_OVERRIDE_REASON");
    expect(r.out).toContain("--force --force-reason 'INC-1: hotfix' backend_dev");
  });

  it("no longer reports --force as an 'Unknown agent'", () => {
    // deploy.sh needs AWS creds to get past config.sh, so assert on the parse
    // stage only: --force is consumed (with a reason) and never reaches the
    // agent-name validation loop.
    const r = runBash(
      `bash '${DEPLOY_ALL}' --force --force-reason 'INC-1: hotfix' backend_dev`,
      tmp,
    );
    expect(r.out).toContain(
      "--force break-glass requested — routing through the audited eval-gate override",
    );
    expect(r.out).not.toContain("Unknown agent '--force'");
  });

  it("REFUSES --force with no reason before sourcing config.sh (no AWS creds needed)", () => {
    const r = runBash(`bash '${DEPLOY_ALL}' --force backend_dev`, tmp);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("an unexplained break-glass override is refused (BG-2)");
    expect(r.out).toContain("Run ./deploy.sh --help for usage.");
    expect(r.out).not.toContain("Unknown agent");
  });

  it("REJECTS an unknown flag before sourcing config.sh", () => {
    const r = runBash(`bash '${DEPLOY_ALL}' --frce backend_dev`, tmp);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("unknown option '--frce'");
    expect(r.out).toContain("Run ./deploy.sh --help for usage.");
  });

  it("still handles --list without touching the parser", () => {
    const r = runBash(`bash '${DEPLOY_ALL}' --list`, tmp);
    expect(r.status).toBe(0);
    expect(r.out).toContain("agentcore_hub_backend_dev");
    expect(r.out).not.toContain("unknown option");
  });

  it("both scripts route --force through the shared parser (static guard)", () => {
    for (const script of [DEPLOY_ONE, DEPLOY_ALL]) {
      const src = readFileSync(script, "utf8");
      expect(src).toContain("parse-force-args.sh");
      const sourceLine = src.indexOf("parse-force-args.sh");
      const parseCall = src.indexOf('parse_force_args "$@"');
      const gateCall = src.indexOf('require_eval_gate "deploy/runtime-agent/prompts/**"');
      expect(parseCall).toBeGreaterThan(sourceLine);
      // The override must be exported BEFORE the gate decides anything.
      expect(gateCall).toBeGreaterThan(parseCall);
      // No duplicated audit logic in the deploy scripts.
      expect(src).not.toContain("eval-gate/overrides/");
    }
  });
});
