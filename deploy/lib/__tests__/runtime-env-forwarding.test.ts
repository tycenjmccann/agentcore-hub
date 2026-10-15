import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * TEAM-6069 regression: a runtime table rename made only in config.sh's
 * resolution (not in .env.local / the shell) must reach EVERY fleet runtime,
 * on every deploy path, with the same table + tool-Lambda name set.
 *
 * Root cause: the defaults lived only in deploy/config.sh, which can't be
 * sourced safely (STS call, EXPECTED_ACCOUNT_ID exit, AGENTCORE_ROLE_ARN
 * default). deploy-fleet.sh / deploy-topology.sh never source it, so their
 * deploy-one.sh children fell back to literals — and the lightweight and
 * robust twins forwarded different names.
 *
 * Same hermetic pattern as force-flag.test.ts: a fixture repo laid out like
 * the real one, PATH-shimmed `agentcore` / `aws`, and an env that does NOT
 * inherit process.env. EVAL_GATE stays unset, so the gate is a no-op.
 */

const REPO = resolve(__dirname, "../../..");
const RT = join(REPO, "deploy", "runtime-agent");

const FLEET_SIZE = 15; // AGENTS=(...) in deploy-fleet.sh

// `agentcore deploy` logs its argv, \x1f-separated, to its OWN file per call —
// deploy-fleet.sh runs deploy-one.sh with xargs -P 3, so a shared log interleaves.
const AGENTCORE_SHIM = `#!/bin/bash
case "$1" in
  configure) exit 0 ;;
  deploy) printf '%s\\x1f' "$@" > "$(mktemp "\${AC_LOG:?}/call.XXXXXX")"; echo "deployed"; exit 0 ;;
  status) echo "READY arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/fake-abc"; exit 0 ;;
  *) exit 0 ;;
esac
`;

// aws: every call logged; sts answers (so a config.sh sanity source works),
// s3 cp/sync succeed. The fleet path must never reach sts at all.
const AWS_SHIM = `#!/bin/bash
echo "$*" >> "\${AWS_LOG:?}"
case "$*" in
  *get-caller-identity*) echo "123456789012" ;;
esac
exit 0
`;

// Stands in for deploy-one-robust.py: records the env the robust twin
// INHERITS from deploy-one.sh (it builds its runtime env from os.environ).
const ROBUST_STUB = `#!/usr/bin/env python3
import os, sys
names = ["EVENTS_TABLE", "WORKFLOWS_TABLE", "CLOUD_CODE_TABLE",
         "TICKET_TOOLS_LAMBDA", "PIPELINE_TOOLS_LAMBDA", "WORKFLOW_OUTPUT_LAMBDA"]
with open(os.environ["ROBUST_LOG"], "a") as f:
    f.write("\\x1f".join(f"{n}={os.environ.get(n, '<unset>')}" for n in names) + "\\n")
print(f"OK {sys.argv[1]} arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/fake-abc")
`;

let tmp: string;
let fixture: string;
let binDir: string;
let acLog: string;
let awsLog: string;
let robustLog: string;

function makeFixture(): string {
  const dir = join(tmp, "repo");
  const rt = join(dir, "deploy", "runtime-agent");
  mkdirSync(join(dir, "deploy", "lib"), { recursive: true });
  mkdirSync(rt, { recursive: true });
  mkdirSync(join(dir, "src", "config"), { recursive: true });

  copyFileSync(join(REPO, "deploy", "config.sh"), join(dir, "deploy", "config.sh"));
  for (const lib of ["check-eval-gate.sh", "parse-force-args.sh", "runtime-env-defaults.sh", "load-env-local.sh"]) {
    const src = join(REPO, "deploy", "lib", lib);
    // runtime-env-defaults.sh is new in TEAM-6069; copying it only when present
    // lets this same test run (and fail) against the pre-fix tree.
    if (existsSync(src)) copyFileSync(src, join(dir, "deploy", "lib", lib));
  }
  for (const f of ["deploy-one.sh", "deploy-fleet.sh", "deploy-topology.sh", "main.py", "requirements.txt"]) {
    copyFileSync(join(RT, f), join(rt, f));
  }
  for (const f of ["deploy-one.sh", "deploy-fleet.sh", "deploy-topology.sh"]) {
    chmodSync(join(rt, f), 0o755);
  }
  cpSync(join(RT, "prompts"), join(rt, "prompts"), { recursive: true });
  // Post-deploy steps deploy-fleet.sh runs; out of scope here.
  for (const f of ["refresh-agents-json.sh", "verify-fleet.sh"]) {
    writeFileSync(join(rt, f), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  }
  writeFileSync(join(rt, "deploy-one-robust.py"), ROBUST_STUB, { mode: 0o755 });
  for (const f of ["agents.json", "workflows.json"]) {
    copyFileSync(join(REPO, "src", "config", f), join(dir, "src", "config", f));
  }

  // "Rename made only in config.sh": rewrite the table defaults wherever
  // config.sh resolves them — config.sh itself pre-fix, the helper it sources
  // post-fix. Exactly one file must own each default.
  const owners = [join(dir, "deploy", "config.sh"), join(dir, "deploy", "lib", "runtime-env-defaults.sh")]
    .filter(existsSync);
  for (const [name, from, to] of [
    ["EVENTS_TABLE", "agentcore-hub-events", "renamed-events"],
    ["WORKFLOWS_TABLE", "agentcore-hub-workflows", "renamed-workflows"],
  ]) {
    const line = `export ${name}="\${${name}:-${from}}"`;
    const hits = owners.filter((p) => readFileSync(p, "utf8").includes(line));
    expect(hits, `exactly one owner of ${line}`).toHaveLength(1);
    writeFileSync(hits[0], readFileSync(hits[0], "utf8").replace(line, `export ${name}="\${${name}:-${to}}"`));
  }
  return dir;
}

function run(script: string, extraEnv: Record<string, string> = {}) {
  const res = spawnSync("bash", ["-c", script], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      NODE_ENV: "test",
      PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`,
      HOME: join(tmp, "home"),
      AC_LOG: acLog,
      AWS_LOG: awsLog,
      ROBUST_LOG: robustLog,
      // What an operator's shell carries — and nothing table/Lambda-related.
      AWS_REGION: "us-east-1",
      AGENTCORE_ROLE_ARN: "arn:aws:iam::123456789012:role/fake",
      ARTIFACT_BUCKET: "fake-bucket",
      GITHUB_PAT: "ghp_fake",
      ...extraEnv,
    },
  });
  return { status: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

/** Each logged `agentcore deploy` call → its --env NAME=value map. */
function deployCalls(): Record<string, string>[] {
  if (!existsSync(acLog)) return [];
  return readdirSync(acLog)
    .map((f) => readFileSync(join(acLog, f), "utf8"))
    .map((line) => {
      const argv = line.split("\x1f").filter(Boolean);
      const env: Record<string, string> = {};
      argv.forEach((a, i) => {
        if (argv[i - 1] === "--env") {
          const eq = a.indexOf("=");
          env[a.slice(0, eq)] = a.slice(eq + 1);
        }
      });
      return env;
    });
}

function robustCalls(): Record<string, string>[] {
  if (!existsSync(robustLog)) return [];
  return readFileSync(robustLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) =>
      Object.fromEntries(
        line.split("\x1f").map((kv) => {
          const eq = kv.indexOf("=");
          return [kv.slice(0, eq), kv.slice(eq + 1)];
        }),
      ),
    );
}

const RENAMED_SET = {
  EVENTS_TABLE: "renamed-events",
  WORKFLOWS_TABLE: "renamed-workflows",
  CLOUD_CODE_TABLE: "agentcore-hub-cloud-code-sessions",
  TICKET_TOOLS_LAMBDA: "agentcore-hub-jira",
  PIPELINE_TOOLS_LAMBDA: "agentcore-hub-pipeline-tools",
  WORKFLOW_OUTPUT_LAMBDA: "agentcore-hub-workflow-output",
};

function expectEveryCall(calls: Record<string, string>[], count: number, want: Record<string, string>) {
  expect(calls).toHaveLength(count);
  for (const env of calls) expect(env).toMatchObject(want);
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "runtime-env-fwd-"));
  binDir = join(tmp, "bin");
  mkdirSync(binDir);
  mkdirSync(join(tmp, "home"));
  writeFileSync(join(binDir, "agentcore"), AGENTCORE_SHIM, { mode: 0o755 });
  writeFileSync(join(binDir, "aws"), AWS_SHIM, { mode: 0o755 });
  acLog = join(tmp, "agentcore-calls");
  awsLog = join(tmp, "aws.log");
  robustLog = join(tmp, "robust.log");
  fixture = makeFixture();
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of [acLog, awsLog, robustLog, join(fixture, ".env.local")]) rmSync(f, { recursive: true, force: true });
  mkdirSync(acLog);
});

describe("TEAM-6069: config-resolved runtime env reaches every fleet deploy path", () => {
  it("sanity: the rename IS what config.sh resolves", () => {
    const r = run(`source deploy/config.sh >/dev/null 2>&1; echo "E=$EVENTS_TABLE W=$WORKFLOWS_TABLE"`);
    expect(r.out).toContain("E=renamed-events W=renamed-workflows");
  });

  it("deploy-fleet.sh forwards the renamed tables + every tool-Lambda name to all 15 runtimes", () => {
    const r = run(`deploy/runtime-agent/deploy-fleet.sh`);
    expect(r.status, r.out).toBe(0);
    expectEveryCall(deployCalls(), FLEET_SIZE, RENAMED_SET);
  });

  it.each(["1", "4"])("deploy-topology.sh WORKFLOW_RUNTIME_COUNT=%s forwards the same set to every anchor", (count) => {
    const r = run(`deploy/runtime-agent/deploy-topology.sh`, { WORKFLOW_RUNTIME_COUNT: count });
    expect(r.status, r.out).toBe(0);
    expectEveryCall(deployCalls(), Number(count), RENAMED_SET);
  });

  it("the robust twin inherits the identical set from deploy-one.sh", () => {
    const r = run(`deploy/runtime-agent/deploy-one.sh agentcore_hub_backend_dev`, { DEPLOY_MODE: "robust" });
    expect(r.status, r.out).toBe(0);
    expectEveryCall(robustCalls(), 1, RENAMED_SET);
  });

  it("TICKET_TOOLS_LAMBDA follows TICKET_PROVIDER; an explicit value always wins", () => {
    for (const [env, want] of [
      [{ TICKET_PROVIDER: "dynamodb" }, "agentcore-hub-tickets"],
      [{ TICKET_PROVIDER: "dynamodb", TICKET_TOOLS_LAMBDA: "custom-tickets" }, "custom-tickets"],
    ] as const) {
      rmSync(acLog, { recursive: true, force: true });
      mkdirSync(acLog);
      const r = run(`deploy/runtime-agent/deploy-one.sh agentcore_hub_backend_dev`, env);
      expect(r.status, r.out).toBe(0);
      expectEveryCall(deployCalls(), 1, { TICKET_TOOLS_LAMBDA: want });
    }
  });

  it(".env.local and shell overrides beat the defaults", () => {
    writeFileSync(join(fixture, ".env.local"), "EVENTS_TABLE=from-env-local\n");
    const r = run(`deploy/runtime-agent/deploy-fleet.sh`, { PIPELINE_TOOLS_LAMBDA: "from-shell" });
    expect(r.status, r.out).toBe(0);
    expectEveryCall(deployCalls(), FLEET_SIZE, {
      ...RENAMED_SET,
      EVENTS_TABLE: "from-env-local",
      PIPELINE_TOOLS_LAMBDA: "from-shell",
    });
  });

  it("pulls in none of config.sh's side effects (no STS call, no account guard)", () => {
    const r = run(`deploy/runtime-agent/deploy-fleet.sh`, { EXPECTED_ACCOUNT_ID: "999999999999" });
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain("AWS account mismatch");
    expect(existsSync(awsLog) ? readFileSync(awsLog, "utf8") : "").not.toContain("get-caller-identity");
    expect(deployCalls()).toHaveLength(FLEET_SIZE);
  });

  it("fixture sanity: deploy-fleet.sh's AGENTS list is the 15 this test counts", () => {
    const src = readFileSync(join(RT, "deploy-fleet.sh"), "utf8");
    const block = src.slice(src.indexOf("AGENTS=("), src.indexOf(")", src.indexOf("AGENTS=(")));
    expect(block.match(/"agentcore_hub_[a-z_]+"/g)).toHaveLength(FLEET_SIZE);
    expect(readdirSync(join(RT, "prompts")).length).toBeGreaterThan(0);
  });
});
