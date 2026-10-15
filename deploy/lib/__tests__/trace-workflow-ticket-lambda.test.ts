/**
 * TEAM-6185 (ship-review follow-up on TEAM-6161, PR #972) — trace-workflow.sh
 * must probe the ticket-tools Lambda log group for the ACTUAL TICKET_PROVIDER
 * of the workflow being traced, not whatever TICKET_PROVIDER happens to be
 * (un)set in the operator's shell.
 *
 * Before this fix, trace-workflow.sh called
 * deploy/lib/runtime-env-defaults.sh's resolve_runtime_lambda_names() at
 * startup (scripts/trace-workflow.sh, Config section) — before .env.local was
 * ever loaded (it wasn't loaded at all) and before Step 1 read the workflow's
 * own ticketProvider out of DynamoDB. So a dynamodb-provider install
 * configured only via .env.local or via the traced workflow's own ticket
 * provider — with TICKET_PROVIDER/TICKET_TOOLS_LAMBDA unset in the shell —
 * always queried /aws/lambda/agentcore-hub-jira instead of
 * /aws/lambda/agentcore-hub-tickets (resolve_runtime_lambda_names defaults
 * provider to "jira" and freezes TICKET_TOOLS_LAMBDA before either source is
 * read). The fix: load .env.local the same way verify-infra.sh does, and
 * (re)resolve the ticket Lambda name once, after Step 1 has read the
 * workflow's ticketProvider — not before.
 *
 * Same hermetic end-to-end pattern as verify-infra-ticket-lambda.test.ts: a
 * scratch copy of scripts/trace-workflow.sh + deploy/lib/runtime-env-
 * defaults.sh, a stubbed `aws` on PATH, a child env built from an ALLOW-LIST
 * (hermeticEnv below — never a copy of process.env, so no inherited
 * TICKET_PROVIDER / TICKET_TOOLS_LAMBDA / MOCK_* / AWS_* can decide a case;
 * TEAM-6200 F5), and scratch dirs removed in afterEach.
 *
 * TEAM-6200 F4: the script runs under `set -euo pipefail` and sources
 * .env.local; a line like GITHUB_TOKEN="$OPTIONAL_REVIEW_TOKEN" with that var
 * unset must not kill it with "unbound variable" (verify-infra.sh, which has
 * no nounset, tolerates the same file). The last case below pins that.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { resolveTicketProvider, ticketToolsLambdaName } from "../ticket-provider.mjs";

const REPO_ROOT = resolve(__dirname, "../../..");
const envOf = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

// The fake `aws` CLI: logs every invocation (one line of JSON argv) to
// $AWS_CALL_LOG. Answers:
//  - `dynamodb get-item` on the workflows table: one Item, with ticketProvider
//    set from $MOCK_TICKET_PROVIDER iff that env var is non-empty (so the
//    "no metadata" case gets a bare Item with no ticketProvider attribute,
//    matching the real "N/A" fallback — not a missing Item, which would hit
//    the script's "Workflow not found" branch instead).
//  - `dynamodb query` on the events table: one event carrying ticketId T-1,
//    so Step 3b (ticket-tools log pull) actually runs with a non-empty
//    TICKET_IDS and issues a `logs filter-log-events` call we can inspect.
//  - `logs filter-log-events`: always succeeds with zero events.
// Everything else fails closed (exit 255), matching the sibling stub.
const AWS_STUB = String.raw`#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["AWS_CALL_LOG"], "a") as f:
    f.write(json.dumps(args) + "\n")

def is_cmd(a, b):
    return args[:1] == [a] and args[1:2] == [b]

if is_cmd("dynamodb", "get-item"):
    item = {"workflowId": {"S": "wf_test"}, "epicId": {"S": "EPIC-1"}}
    provider = os.environ.get("MOCK_TICKET_PROVIDER", "")
    if provider:
        item["ticketProvider"] = {"S": provider}
    print(json.dumps({"Item": item}))
    sys.exit(0)
if is_cmd("dynamodb", "query"):
    print(json.dumps({"Items": [{"ticketId": {"S": "T-1"}, "timestamp": {"N": "1700000000000"}, "type": {"S": "ticket_created"}}]}))
    sys.exit(0)
if is_cmd("dynamodb", "scan"):
    print(json.dumps({"Items": []}))
    sys.exit(0)
if is_cmd("logs", "filter-log-events"):
    print(json.dumps({"events": []}))
    sys.exit(0)
sys.stderr.write("\nAn error occurred (AccessDenied) when calling an unmocked operation\n")
sys.exit(255)
`;

/**
 * Child env for the spawned script, built from an allow-list rather than a copy
 * of process.env (TEAM-6200 F5). The previous inherit-then-delete idiom only
 * removed TICKET_PROVIDER/TICKET_TOOLS_LAMBDA, so an exported
 * MOCK_TICKET_PROVIDER (read by the aws stub) still leaked:
 * `MOCK_TICKET_PROVIDER=dynamodb npx vitest run …` failed the jira-default
 * case and `=jira` failed the .env.local-only dynamodb case. Only what bash,
 * python3 (the stub) and the script need to run is passed through; every
 * input that can change the outcome is set explicitly by the caller.
 */
const hermeticEnv = (binDir: string, pinned: Record<string, string>): NodeJS.ProcessEnv => {
  const base: Record<string, string> = { PATH: `${binDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}` };
  for (const k of ["HOME", "TMPDIR", "LANG", "LC_ALL"] as const) {
    if (process.env[k] !== undefined) base[k] = process.env[k] as string;
  }
  // Same cast as envOf: ProcessEnv's augmented required NODE_ENV is irrelevant to a bash child.
  return { ...base, ...pinned } as NodeJS.ProcessEnv;
};

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Run the real trace-workflow.sh from a scratch copy of scripts/ and
 * deploy/lib/ (so its `source "$SCRIPT_DIR/../deploy/lib/
 * runtime-env-defaults.sh"` and (TEAM-6202) `.../deploy/lib/load-env-local.sh`
 * resolve), optionally with a scratch .env.local, against the aws stub.
 * Returns stdout, exit code, and the decoded call log.
 */
const runTraceWorkflow = (env: Record<string, string> = {}, envLocal?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "trace-workflow-ticket-lambda-"));
  scratchDirs.push(dir);
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "deploy", "lib"), { recursive: true });
  cpSync(join(REPO_ROOT, "scripts", "trace-workflow.sh"), join(dir, "scripts", "trace-workflow.sh"));
  cpSync(
    join(REPO_ROOT, "deploy", "lib", "runtime-env-defaults.sh"),
    join(dir, "deploy", "lib", "runtime-env-defaults.sh")
  );
  cpSync(join(REPO_ROOT, "deploy", "lib", "load-env-local.sh"), join(dir, "deploy", "lib", "load-env-local.sh"));
  if (envLocal !== undefined) {
    writeFileSync(join(dir, ".env.local"), envLocal);
  }

  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "aws"), AWS_STUB);
  chmodSync(join(binDir, "aws"), 0o755);
  const callLog = join(dir, "aws-calls.jsonl");
  writeFileSync(callLog, "");
  const outDir = join(dir, "out");

  const res = spawnSync("bash", [join(dir, "scripts", "trace-workflow.sh"), "wf_test", "--output", outDir], {
    env: hermeticEnv(binDir, {
      AWS_PROFILE: "stub-profile",
      AWS_REGION: "us-east-1",
      AWS_CALL_LOG: callLog,
      ...env,
    }),
  });
  const calls: string[][] = readFileSync(callLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { stdout: res.stdout.toString(), stderr: res.stderr.toString(), status: res.status, calls };
};

const logGroupsQueried = (calls: string[][]) =>
  calls
    .filter((args) => args[0] === "logs" && args[1] === "filter-log-events")
    .map((args) => args[args.indexOf("--log-group-name") + 1]);

// Not asserting exit status 0 here: trace-workflow.sh's later "Key Lifecycle
// Events" section (several `grep ... | awk ...` pipelines, no matches in this
// stub's empty logs) exits non-zero under the script's `set -euo pipefail` —
// a pre-existing fragility unrelated to F1/the ticket-tools log group this
// test covers. The Step 3b ticket-tools `logs filter-log-events` call under
// test always runs and is logged well before that later section, so it's
// unaffected either way.
describe("trace-workflow.sh — ticket-tools log group follows TICKET_PROVIDER (TEAM-6185)", () => {
  it("queries the tickets log group when the traced workflow's own metadata says dynamodb", () => {
    const expected = ticketToolsLambdaName(resolveTicketProvider(envOf({ TICKET_PROVIDER: "dynamodb" })));
    expect(expected).toBe("agentcore-hub-tickets");

    const { calls } = runTraceWorkflow({ MOCK_TICKET_PROVIDER: "dynamodb" });
    const groups = logGroupsQueried(calls);
    expect(groups).toContain(`/aws/lambda/${expected}`);
    expect(groups).not.toContain("/aws/lambda/agentcore-hub-jira");
  });

  it("queries the tickets log group when only .env.local sets TICKET_PROVIDER=dynamodb", () => {
    const { calls } = runTraceWorkflow({}, "TICKET_PROVIDER=dynamodb\n");
    const groups = logGroupsQueried(calls);
    expect(groups).toContain("/aws/lambda/agentcore-hub-tickets");
    expect(groups).not.toContain("/aws/lambda/agentcore-hub-jira");
  });

  it("falls back to the jira default when neither the shell, .env.local, nor the workflow's own metadata set a provider", () => {
    const { calls } = runTraceWorkflow({});
    const groups = logGroupsQueried(calls);
    expect(groups).toContain("/aws/lambda/agentcore-hub-jira");
    expect(groups).not.toContain("/aws/lambda/agentcore-hub-tickets");
  });

  it("an explicit TICKET_TOOLS_LAMBDA exported in the shell wins over a dynamodb metadata provider", () => {
    const { calls } = runTraceWorkflow({
      TICKET_TOOLS_LAMBDA: "custom-ticket-fn",
      MOCK_TICKET_PROVIDER: "dynamodb",
    });
    const groups = logGroupsQueried(calls);
    expect(groups).toContain("/aws/lambda/custom-ticket-fn");
    expect(groups).not.toContain("/aws/lambda/agentcore-hub-tickets");
    expect(groups).not.toContain("/aws/lambda/agentcore-hub-jira");
  });

  it("an explicit TICKET_TOOLS_LAMBDA set in .env.local wins over a dynamodb metadata provider", () => {
    const { calls } = runTraceWorkflow(
      { MOCK_TICKET_PROVIDER: "dynamodb" },
      "TICKET_TOOLS_LAMBDA=custom-ticket-fn\n"
    );
    const groups = logGroupsQueried(calls);
    expect(groups).toContain("/aws/lambda/custom-ticket-fn");
    expect(groups).not.toContain("/aws/lambda/agentcore-hub-tickets");
    expect(groups).not.toContain("/aws/lambda/agentcore-hub-jira");
  });

  // TEAM-6200 F4: .env.local may reference a variable that is unset in the
  // shell (e.g. an optional token). Sourcing it under the script's `set -u`
  // used to abort before any aws call. Exit status is deliberately not
  // asserted (see the note above the describe); "proceeds" is proven by the
  // Step 3b ticket-tools log pull actually happening with the provider the
  // same .env.local set, and by stderr carrying no "unbound variable".
  it("survives a .env.local that references an unset variable and still honours its TICKET_PROVIDER", () => {
    const { stderr, calls } = runTraceWorkflow(
      {},
      'TICKET_PROVIDER=dynamodb\nGITHUB_TOKEN="$OPTIONAL_REVIEW_TOKEN"\n'
    );
    expect(stderr).not.toMatch(/unbound variable/);
    const groups = logGroupsQueried(calls);
    expect(groups).toContain("/aws/lambda/agentcore-hub-tickets");
    expect(groups).not.toContain("/aws/lambda/agentcore-hub-jira");
  });
});
