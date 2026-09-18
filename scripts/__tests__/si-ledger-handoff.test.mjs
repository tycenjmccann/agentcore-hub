// TEAM-4770 / TEAM-4772 — the SI ledger handoff, pinned.
//
// PR #637 shipped the SI ledger as code and it sat INERT: the CD Deploy stage is
// code-only (deploy/pipeline/surfaces.json), CD runs setup-workflow-manager.mjs
// only with PIPELINE_MODE=1 — which skips its whole IAM block — and nobody re-ran
// the hand-run scripts. si_ledger.py's Scan got AccessDeniedException for days.
// scripts/si-ledger-handoff.sh is the one command that applies those surfaces;
// these tests pin the four properties that make it trustworthy:
//
//   1. the harness-role document actually grants what si_verify.py needs;
//   2. the coding-runtime document is READ-ONLY (patternKey
//      tooling.coding-role.no-live-verify-access — a verifier that can write the
//      evidence it verifies is worse than no verifier);
//   3. every env push MERGES (the Lambda/harness/ECS env APIs are replace-all, so
//      a bare push silently deletes WORKFLOW_MANAGER_ARN & co.);
//   4. the IAM_ONLY=1 guard in the two live deploy scripts stays additive — after
//      put-role-policy, before any code/env deploy.
//
// HERMETIC. Technique from deploy/pipeline/test_preapproved_check.py and
// lambda/cost-report/deploy.test.mjs: a stub `aws` is prepended to PATH, logs every
// invocation, answers ONLY the reads the script really makes, and `exit 64`s on
// anything else — so a rewrite that reaches for a different AWS call fails loudly
// instead of quietly passing. Belt and braces on top of that: a fake account id,
// dummy credentials and AWS_EC2_METADATA_DISABLED=true, because the two .mjs
// subprocesses use the SDK and are NOT intercepted by the stub. Nothing here may
// touch a real account.
//
// Run: `node --test scripts/__tests__/si-ledger-handoff.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const ACCOUNT = "111122223333";
const REGION = "us-east-1";
const BUCKET = `agentcore-hub-artifacts-${ACCOUNT}-${REGION}`;
const TABLE = "agentcore-hub-si-ledger";
const LEDGER_ARN = `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${TABLE}`;

const HANDOFF = join(REPO, "scripts/si-ledger-handoff.sh");
const WM_DEPLOY = join(REPO, "deploy/workflow-manager/deploy.sh");
const CI_DEPLOY = join(REPO, "deploy/continuous-improvement/deploy.sh");

// deploy/config.sh sources <repo>/.env.local with `set -a`, which would override
// the fake account/bucket below. There is no such file in CI or in a clean clone;
// if a developer has one, say so instead of asserting against their account.
const HAS_ENV_LOCAL = existsSync(join(REPO, ".env.local"));
const envLocalSkip = HAS_ENV_LOCAL
  ? "skipped: a repo-root .env.local would override the test's fake account/bucket"
  : false;

// ── the stub `aws` ──────────────────────────────────────────────────────────
// One canned answer per read the handoff script performs. Every write, and every
// call not listed, is an error: `exit 64`.
const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
ARGS="$*"
case "$ARGS" in
  "sts get-caller-identity"*)
    echo "${ACCOUNT}" ;;
  "dynamodb describe-table"*"Table.TableStatus"*)
    echo "ACTIVE" ;;
  "dynamodb describe-table"*)
    echo '{"Table":{"TableName":"${TABLE}","TableStatus":"ACTIVE"}}' ;;
  "lambda get-function-configuration"*"Environment.Variables.SI_LEDGER_TABLE"*)
    # Honest: before --apply the env var is NOT there yet.
    echo "None" ;;
  "lambda get-function-configuration"*"Environment.Variables"*)
    echo '{"EXISTING_KEY":"keep"}' ;;
  "iam simulate-principal-policy"*)
    # Echo back one "<action>\\t<decision>" row per requested action, so the
    # script's own parsing is exercised. Writes are denied for the coding role.
    SRC=""; MODE=""
    for a in "$@"; do
      case "$MODE" in
        src) SRC="$a"; MODE="" ; continue ;;
      esac
      case "$a" in
        --policy-source-arn) MODE=src ;;
        --action-names) MODE=actions ;;
        --*) [ "$MODE" = actions ] && MODE="" ;;
        *)
          if [ "$MODE" = actions ]; then
            case "$SRC:$a" in
              *coding-runtime-role:dynamodb:PutItem) printf '%s\\timplicitDeny\\n' "$a" ;;
              *) printf '%s\\tallowed\\n' "$a" ;;
            esac
          fi ;;
      esac
    done ;;
  *)
    echo "STUB: unsupported aws call: $ARGS" >&2
    exit 64 ;;
esac
`;

function makeStub() {
  const dir = mkdtempSync(join(tmpdir(), "si-handoff-stub-"));
  const bin = join(dir, "aws");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  return { dir, log: join(dir, "_calls.log") };
}

function stubEnv(stub, extra = {}) {
  return {
    ...process.env,
    PATH: `${stub.dir}:${process.env.PATH}`,
    STUB_LOG: stub.log,
    AWS_ACCOUNT_ID: ACCOUNT,
    AWS_REGION: REGION,
    ARTIFACT_BUCKET: BUCKET,
    SI_LEDGER_TABLE: TABLE,
    GITHUB_OWNER: "example",
    // Belt and braces: the .mjs children use the SDK, not the stubbed CLI.
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "dummy",
    AWS_SESSION_TOKEN: "dummy",
    AWS_PROFILE: "",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_SDK_LOAD_CONFIG: "0",
    EXPECTED_ACCOUNT_ID: "",
    ...extra,
  };
}

function runHandoff(args, extra = {}) {
  const stub = makeStub();
  const r = spawnSync("bash", [HANDOFF, ...args], {
    cwd: REPO,
    env: stubEnv(stub, extra),
    encoding: "utf8",
    timeout: 120_000,
  });
  const calls = existsSync(stub.log) ? readFileSync(stub.log, "utf8") : "";
  return { ...r, calls };
}

// ── 1. the harness-role document (what si_verify.py was denied) ──────────────

test("--print-policies emits ONE parseable JSON object with both documents", { skip: envLocalSkip }, () => {
  const r = runHandoff(["--print-policies"]);
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  const doc = JSON.parse(r.stdout); // the whole of stdout, or this throws
  assert.deepEqual(Object.keys(doc).sort(), ["codingRuntimeRole", "harnessRole", "meta"]);
  assert.equal(doc.harnessRole.roleName, "agentcore-hub-harness-role");
  assert.equal(doc.harnessRole.policyName, "WorkflowManagerData");
  assert.equal(doc.codingRuntimeRole.roleName, "agentcore-hub-coding-runtime-role");
  assert.equal(doc.codingRuntimeRole.policyName, "HubLiveVerifyRead");
  // Print mode must not write IAM.
  assert.doesNotMatch(r.calls, /put-role-policy/);
});

test("harnessRole grants the six actions si_verify.py needs, on exactly the ledger ARN", { skip: envLocalSkip }, () => {
  const doc = JSON.parse(runHandoff(["--print-policies"]).stdout).harnessRole.document;
  const st = doc.Statement.find((s) => s.Sid === "SiLedgerReadWrite");
  assert.ok(st, `no SiLedgerReadWrite statement in ${doc.Statement.map((s) => s.Sid).join(",")}`);
  assert.equal(st.Effect, "Allow");

  // DescribeTable is the TEAM-4770 addition: without it "table missing" and
  // "grant missing" both surface as AccessDeniedException on Scan, which is what
  // made #637 look inert. Scan is the one si_ledger.py:604-610 actually calls.
  for (const action of [
    "dynamodb:DescribeTable",
    "dynamodb:GetItem",
    "dynamodb:Query",
    "dynamodb:Scan",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
  ]) {
    assert.ok(st.Action.includes(action), `SiLedgerReadWrite is missing ${action}`);
  }
  // DeleteItem may also be present; nothing beyond dynamodb: may be.
  for (const action of st.Action) {
    assert.match(action, /^dynamodb:(DescribeTable|GetItem|Query|Scan|PutItem|UpdateItem|DeleteItem)$/);
  }

  // A single exact ARN — the table has no GSI, so no /index/* and no wildcard.
  assert.equal(st.Resource, LEDGER_ARN);
});

test("harnessRole HubTablesRead still covers the ledger table and its index", { skip: envLocalSkip }, () => {
  const doc = JSON.parse(runHandoff(["--print-policies"]).stdout).harnessRole.document;
  const st = doc.Statement.find((s) => s.Sid === "HubTablesRead");
  assert.ok(st);
  assert.ok(st.Resource.includes(LEDGER_ARN));
  assert.ok(st.Resource.includes(`${LEDGER_ARN}/index/*`));
});

// ── 2. the coding-runtime document is READ-ONLY ──────────────────────────────

test("codingRuntimeRole HubLiveVerifyRead is read-only and scoped", { skip: envLocalSkip }, () => {
  const doc = JSON.parse(runHandoff(["--print-policies"]).stdout).codingRuntimeRole.document;
  const actions = doc.Statement.flatMap((s) => [].concat(s.Action));
  const resources = doc.Statement.flatMap((s) => [].concat(s.Resource));
  assert.ok(actions.length > 0);

  const ALLOWED = /^(dynamodb:(DescribeTable|Scan|Query|GetItem)|s3:(GetObject|ListBucket))$/;
  for (const a of actions) {
    assert.match(a, ALLOWED, `HubLiveVerifyRead must not grant ${a}`);
    // The claim restated as a prohibition, so a widening trips two assertions.
    assert.doesNotMatch(a, /Put|Update|Delete|Write|Create|secretsmanager/i, `write/secret action ${a}`);
  }
  for (const s of doc.Statement) {
    assert.equal(s.Effect, "Allow");
  }

  const TABLE_ARN = new RegExp(`^arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/agentcore-hub-\\*(/index/\\*)?$`);
  const S3_ARN = new RegExp(`^arn:aws:s3:::${BUCKET}(/\\*)?$`);
  for (const r of resources) {
    assert.ok(TABLE_ARN.test(r) || S3_ARN.test(r), `out-of-scope resource ${r}`);
  }
});

test("the coding-runtime role's Secrets Manager prohibition is untouched", () => {
  const src = readFileSync(join(REPO, "deploy/coding-agent-runtime/setup-coding-runtime-role.sh"), "utf8");
  assert.match(src, /DELIBERATELY NOT GRANTED/);
  // The sentence wraps across a comment line, hence [\s#]+.
  assert.match(src, /given NO[\s#]+secretsmanager:GetSecretValue/);
  // No grant anywhere in the file — only the prose that forbids it.
  assert.doesNotMatch(src, /"secretsmanager:/);
  assert.doesNotMatch(src, /\\"secretsmanager:/);
});

// ── 3. env is MERGED, never replaced ────────────────────────────────────────

test("dry run reads the live Lambda env and shows a MERGED payload", { skip: envLocalSkip }, () => {
  const r = runHandoff(["--dry-run"]);
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);

  // The read side runs even in dry run — that is what makes the plan real.
  assert.match(r.calls, /lambda get-function-configuration .*agentcore-hub-workflow-analyzer/);
  assert.match(r.calls, /lambda get-function-configuration .*agentcore-hub-prd-submitter/);

  for (const fn of ["agentcore-hub-workflow-analyzer", "agentcore-hub-prd-submitter"]) {
    const line = r.stdout.split("\n").find((l) => l.includes(fn) && l.includes("merged payload keys"));
    assert.ok(line, `no merged-payload line for ${fn}:\n${r.stdout}`);
    // BOTH: the pre-existing key survives, the new key is added. A bare
    // --environment push (what both deploy.sh files do) would drop EXISTING_KEY.
    assert.match(line, /EXISTING_KEY/, `${fn} payload dropped the pre-existing key`);
    assert.match(line, /SI_LEDGER_TABLE/, `${fn} payload is missing SI_LEDGER_TABLE`);
  }
});

test("dry run is the DEFAULT and mutates nothing", { skip: envLocalSkip }, () => {
  for (const args of [[], ["--dry-run"]]) {
    const r = runHandoff(args);
    assert.equal(r.status, 0, `exit ${r.status} for [${args}]\n${r.stderr}`);
    assert.doesNotMatch(
      r.calls,
      /(put-role-policy|create-table|update-function-configuration|update-express-gateway-service|update-harness)/,
      `dry run performed a mutation:\n${r.calls}`,
    );
    // …but it does print the two commands it would run.
    assert.match(r.stdout, /IAM_ONLY=1 bash .*deploy\/workflow-manager\/deploy\.sh/);
    assert.match(r.stdout, /IAM_ONLY=1 bash .*deploy\/continuous-improvement\/deploy\.sh/);
    assert.match(r.stdout, /ONLY_POLICY=HubLiveVerifyRead bash .*setup-coding-runtime-role\.sh/);
  }
});

test("set-harness-env.mjs merges, and sends nothing but harnessId + environmentVariables", async () => {
  const mod = await import("../../deploy/workflow-manager/set-harness-env.mjs");
  const live = { WORKFLOW_MANAGER_ARN: "arn:pre-existing", HAND_SET_ONLY: "keep-me" };
  const { env, changed } = mod.mergeEnv(live, { SI_LEDGER_TABLE: TABLE });
  assert.deepEqual(env, { ...live, SI_LEDGER_TABLE: TABLE });
  assert.deepEqual(changed, ["SI_LEDGER_TABLE"]);
  // Idempotent: a second pass reports no change, so the wrapper can be re-run.
  assert.deepEqual(mod.mergeEnv(env, { SI_LEDGER_TABLE: TABLE }).changed, []);

  // Re-sending model/systemPrompt/skills would overwrite whatever CD last
  // deployed; executionRoleArn/environmentArtifact are retained when omitted.
  const input = mod.updateInput("h-123", env);
  assert.deepEqual(Object.keys(input).sort(), ["environmentVariables", "harnessId"]);
  assert.equal(input.harnessId, "h-123");
  assert.equal(input.environmentVariables.HAND_SET_ONLY, "keep-me");
});

// ── 4. manifest registration + the additive IAM_ONLY guard ──────────────────

test("surfaces.json lists both new handoff files", () => {
  const surfaces = JSON.parse(readFileSync(join(REPO, "deploy/pipeline/surfaces.json"), "utf8"));
  assert.ok(
    surfaces.handoff.includes("scripts/si-ledger-handoff.sh"),
    "scripts/si-ledger-handoff.sh is not in surfaces.json handoff",
  );
  assert.ok(
    surfaces.handoff.includes("deploy/workflow-manager/set-harness-env.mjs"),
    "deploy/workflow-manager/set-harness-env.mjs is not in surfaces.json handoff",
  );
});

test("IAM_ONLY=1 exits after put-role-policy and before any code/env deploy", () => {
  for (const file of [WM_DEPLOY, CI_DEPLOY]) {
    const src = readFileSync(file, "utf8");
    const iamOnly = src.indexOf('if [ "${IAM_ONLY:-}" = "1" ]');
    assert.ok(iamOnly > 0, `${file}: no IAM_ONLY guard`);

    // Real invocations only — both files discuss these calls in comments first.
    const firstCall = (marker) => {
      const m = new RegExp(String.raw`^\s*aws ${marker}`, "m").exec(src);
      return m ? m.index : -1;
    };

    const putPolicy = firstCall("iam put-role-policy");
    assert.ok(putPolicy > 0, `${file}: no put-role-policy call`);
    assert.ok(putPolicy < iamOnly, `${file}: IAM_ONLY guard precedes put-role-policy`);

    // The whole point: the guard must land before anything that deploys code or
    // replaces env (both of which CD owns).
    for (const marker of ["lambda update-function-code", "lambda update-function-configuration"]) {
      const at = firstCall(marker);
      assert.ok(at > 0, `${file}: expected an "aws ${marker}" call`);
      assert.ok(at > iamOnly, `${file}: ${marker} at ${at} precedes the IAM_ONLY guard at ${iamOnly}`);
    }
    // And it must be a real exit, not a warning.
    const block = src.slice(iamOnly, iamOnly + 260);
    assert.match(block, /exit 0/, `${file}: IAM_ONLY guard does not exit`);
  }
});

test("--iam-only on setup-workflow-manager.mjs cannot reach the harness", () => {
  const src = readFileSync(join(REPO, "deploy/workflow-manager/setup-workflow-manager.mjs"), "utf8");
  const exitAt = src.indexOf("if (IAM_ONLY)");
  assert.ok(exitAt > 0, "no --iam-only exit");
  // The AgentCore control-plane SDK is imported AFTER the IAM block; exiting
  // above that import is what makes --iam-only unable to touch the harness.
  const importAt = src.indexOf("@aws-sdk/client-bedrock-agentcore-control");
  assert.ok(importAt > exitAt, "the --iam-only exit is below the AgentCore SDK import");
  for (const cmd of ["CreateHarnessCommand", "UpdateHarnessCommand"]) {
    assert.ok(src.indexOf(cmd) > exitAt, `${cmd} is referenced above the --iam-only exit`);
  }
  // PIPELINE_MODE must not be able to skip an explicitly requested IAM run —
  // that skip is exactly why #637's grant never landed.
  assert.match(src, /if \(PIPELINE_MODE && !IAM_ONLY\)/);
});

test("the handoff script never redefines a policy document of its own", () => {
  const src = readFileSync(HANDOFF, "utf8");
  // Every grant comes from the script that owns it, so there is no second copy to
  // drift. If this script ever grows its own put-role-policy, that stops being true.
  assert.doesNotMatch(src, /aws iam put-role-policy/);
  assert.doesNotMatch(src, /"Version": "2012-10-17"/);
  assert.match(src, /set -euo pipefail/);
  assert.match(src, /TEAM-4770/);
  assert.match(src, /TEAM-4772/);
});

// ── the stub's own guard: prove `exit 64` really is wired up ─────────────────

test("the stub aws rejects any call the script is not supposed to make", () => {
  const stub = makeStub();
  const r = execFileSync("bash", ["-c", `aws ec2 describe-instances; echo "rc=$?"`], {
    env: stubEnv(stub),
    encoding: "utf8",
  });
  assert.match(r, /rc=64/);
});
