/**
 * TEAM-6161 — verify-infra.sh must check the ticket-tools Lambda that is
 * actually deployed for the active TICKET_PROVIDER, not a hard-coded name.
 *
 * `deploy/setup-tickets-lambda.mjs` deploys the Lambda name
 * `ticketToolsLambdaName(provider)` resolves to (deploy/lib/ticket-provider.mjs):
 * "agentcore-hub-jira" for jira, "agentcore-hub-tickets" for dynamodb. jira is
 * the deploy layer's default (unset TICKET_PROVIDER). Before this fix,
 * scripts/verify-infra.sh's "Lambda: agentcore-hub-tickets" check always probed
 * agentcore-hub-tickets regardless of provider, so a correct jira install
 * failed verify-infra with ResourceNotFoundException. The fix sources
 * deploy/lib/runtime-env-defaults.sh's resolve_runtime_lambda_names — the shell
 * mirror of ticketToolsLambdaName, parity-pinned against it by
 * ticket-provider.test.ts — and checks $TICKET_TOOLS_LAMBDA.
 *
 * This drives the REAL script end to end (not an extracted function, unlike
 * the role_policy_* harness in setup-pipeline-tools-lambda.test.mjs) with a
 * stubbed `aws` on PATH, from a scratch copy so the script's hard-coded
 * `$SCRIPT_DIR/../.env.local` can never pick up a developer's real file.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { resolveTicketProvider, ticketToolsLambdaName } from "../ticket-provider.mjs";

const REPO_ROOT = resolve(__dirname, "../../..");
// Same idiom as ticket-provider.test.ts's envOf: resolveTicketProvider only
// reads TICKET_PROVIDER, so a plain Record is fine — cast past ProcessEnv's
// unrelated required keys (NODE_ENV).
const envOf = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

// The fake `aws` CLI: logs every invocation (one line of JSON argv) to
// $AWS_CALL_LOG, and answers `lambda get-function --function-name X` with
// success iff X is in the space-separated $EXISTING_LAMBDAS, else a
// ResourceNotFoundException (exit 255, like the real CLI). Everything else
// (dynamodb describe-table, sts, etc.) also fails closed — check_schema's
// `|| { … }` branch (verify-infra.sh) handles that without tripping `set -e`.
const AWS_STUB = String.raw`#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["AWS_CALL_LOG"], "a") as f:
    f.write(json.dumps(args) + "\n")
if args[:1] == ["lambda"] and args[1:2] == ["get-function"]:
    name = args[args.index("--function-name") + 1]
    existing = os.environ.get("EXISTING_LAMBDAS", "").split()
    if name in existing:
        print(json.dumps({"Configuration": {"FunctionName": name}}))
        sys.exit(0)
    sys.stderr.write("\nAn error occurred (ResourceNotFoundException) when calling the GetFunction operation\n")
    sys.exit(255)
sys.stderr.write("\nAn error occurred (AccessDenied) when calling the %s operation\n" % (args[1] if len(args) > 1 else args[0]))
sys.exit(255)
`;

/**
 * Run the real verify-infra.sh from a scratch copy of the repo's scripts/ and
 * deploy/lib/ dirs (so the fix's `source "$SCRIPT_DIR/../deploy/lib/
 * runtime-env-defaults.sh"` resolves), with no .env.local, against the aws
 * stub. Returns stdout and the decoded call log.
 */
const runVerifyInfra = (env: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "verify-infra-ticket-lambda-"));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "deploy", "lib"), { recursive: true });
  cpSync(join(REPO_ROOT, "scripts", "verify-infra.sh"), join(dir, "scripts", "verify-infra.sh"));
  cpSync(
    join(REPO_ROOT, "deploy", "lib", "runtime-env-defaults.sh"),
    join(dir, "deploy", "lib", "runtime-env-defaults.sh")
  );
  // No .env.local in this scratch dir — the script must not fail trying to
  // source a file that doesn't exist (it guards with `[ -f "$ENV_FILE" ]`).
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "aws"), AWS_STUB);
  chmodSync(join(binDir, "aws"), 0o755);
  const callLog = join(dir, "aws-calls.jsonl");
  writeFileSync(callLog, "");

  const res = spawnSync("bash", [join(dir, "scripts", "verify-infra.sh")], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      AWS_CALL_LOG: callLog,
      AWS_ACCOUNT_ID: "123456789012",
      ARTIFACT_BUCKET: "", // skip the IAM-grant sections entirely
      ...env,
    },
  });
  const calls: string[][] = readFileSync(callLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { stdout: res.stdout.toString(), calls };
};

const lambdaGetFunctionNames = (calls: string[][]) =>
  calls
    .filter((args) => args[0] === "lambda" && args[1] === "get-function")
    .map((args) => args[args.indexOf("--function-name") + 1]);

describe("verify-infra.sh — Lambda: <ticket-tools> check (TEAM-6161)", () => {
  it("probes the jira Lambda when TICKET_PROVIDER is unset (deploy-layer default)", () => {
    const expected = ticketToolsLambdaName(resolveTicketProvider(envOf({})));
    expect(expected).toBe("agentcore-hub-jira");

    const { stdout, calls } = runVerifyInfra({ EXISTING_LAMBDAS: "agentcore-hub-jira" });
    expect(lambdaGetFunctionNames(calls)).toContain(expected);
    expect(lambdaGetFunctionNames(calls)).not.toContain("agentcore-hub-tickets");
    expect(stdout).toMatch(new RegExp(`✓ Lambda: ${expected}\\b`));
  });

  it("probes the jira Lambda when TICKET_PROVIDER=jira explicitly", () => {
    const { stdout, calls } = runVerifyInfra({
      TICKET_PROVIDER: "jira",
      EXISTING_LAMBDAS: "agentcore-hub-jira",
    });
    expect(lambdaGetFunctionNames(calls)).toContain("agentcore-hub-jira");
    expect(stdout).toMatch(/✓ Lambda: agentcore-hub-jira\b/);
  });

  it("probes the tickets Lambda when TICKET_PROVIDER=dynamodb", () => {
    const expected = ticketToolsLambdaName(resolveTicketProvider(envOf({ TICKET_PROVIDER: "dynamodb" })));
    expect(expected).toBe("agentcore-hub-tickets");

    const { stdout, calls } = runVerifyInfra({
      TICKET_PROVIDER: "dynamodb",
      EXISTING_LAMBDAS: "agentcore-hub-tickets",
    });
    expect(lambdaGetFunctionNames(calls)).toContain("agentcore-hub-tickets");
    expect(stdout).toMatch(/✓ Lambda: agentcore-hub-tickets\b/);
  });

  it("an explicit TICKET_TOOLS_LAMBDA override wins over the provider default", () => {
    const { stdout, calls } = runVerifyInfra({
      TICKET_PROVIDER: "jira",
      TICKET_TOOLS_LAMBDA: "custom-ticket-fn",
      EXISTING_LAMBDAS: "custom-ticket-fn",
    });
    expect(lambdaGetFunctionNames(calls)).toEqual(["custom-ticket-fn"]);
    expect(stdout).toMatch(/✓ Lambda: custom-ticket-fn\b/);
  });

  it("fails the check (not silently passes) when the resolved Lambda is missing", () => {
    const { stdout, calls } = runVerifyInfra({ EXISTING_LAMBDAS: "" });
    expect(lambdaGetFunctionNames(calls)).toContain("agentcore-hub-jira");
    expect(stdout).toMatch(/✗ Lambda: agentcore-hub-jira\b/);
  });
});
