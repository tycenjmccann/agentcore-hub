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
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const ACCOUNT = "111122223333";
const REGION = "us-east-1";
const BUCKET = `agentcore-hub-artifacts-${ACCOUNT}-${REGION}`;
const TABLE = "agentcore-hub-si-ledger";
const LEDGER_ARN = `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${TABLE}`;

// TEAM-4785 / F1 — HubLiveVerifyRead's allow-list, mirrored. The duplication is
// deliberate: widening the grant has to be done twice, visibly, because the role
// it widens is assumed by the UNTRUSTED coding runtime.
const LIVE_VERIFY_TABLES = [
  "agentcore-hub-si-ledger",
  "agentcore-hub-workflows",
  "agentcore-hub-tickets",
  "agentcore-hub-events",
  "agentcore-hub-workflow-analyses",
  "agentcore-hub-eval-results",
  "agentcore-hub-eval-daily",
  "agentcore-hub-eval-config",
];
// Excluded BY DESIGN: cross-tenant session transcripts, and state owned by a
// Lambda rather than by anything live verify reads.
const NEVER_READABLE = [
  "agentcore-hub-cloud-code-sessions",
  "agentcore-hub-routines",
  "agentcore-hub-anomaly-watcher-state",
  "agentcore-hub-eval-seen",
];
// config/cd-registry.json is NOT here: it carries the cross-account CD externalId
// and roleArn (src/lib/cd-registry.ts:41-43).
const S3_GETTABLE = [
  `arn:aws:s3:::${BUCKET}/workflows/*`,
  `arn:aws:s3:::${BUCKET}/completions/*`,
  `arn:aws:s3:::${BUCKET}/config/agents.json`,
  `arn:aws:s3:::${BUCKET}/config/workflows.json`,
  `arn:aws:s3:::${BUCKET}/config/connectors.json`,
];
const S3_PREFIXES = ["config/*", "workflows/*", "completions/*"];
const SESSIONS_ARN = `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/agentcore-hub-cloud-code-sessions`;
const actionsOf = (s) => [].concat(s.Action);
const resourcesOf = (s) => [].concat(s.Resource);

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
# ONE logged line per invocation: newlines inside an argument are collapsed to
# spaces, because --policy-document is a multi-line JSON heredoc and the
# IAM_ONLY allow-list below reasons per line ("each line is one AWS call").
printf '%s\\n' "$*" | tr '\\n' ' ' >> "$STUB_LOG"
printf '\\n' >> "$STUB_LOG"
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
    #
    # TEAM-4807: POST_APPLY=1 answers instead as the account looks AFTER a successful
    # --apply, on all four env surfaces. That is what lets a test isolate step 7's IAM
    # verdicts from its env checks — without it an --apply run exits 1 from the env
    # checks regardless, and an assertion on the exit code would prove nothing.
    if [ "\${POST_APPLY:-}" = 1 ]; then echo "${TABLE}"; else echo "None"; fi ;;
  "lambda get-function-configuration"*"Environment.Variables"*)
    if [ "\${POST_APPLY:-}" = 1 ]; then
      echo '{"EXISTING_KEY":"keep","SI_LEDGER_TABLE":"${TABLE}"}'
    else
      echo '{"EXISTING_KEY":"keep"}'
    fi ;;
  "iam simulate-principal-policy"*)
    # TEAM-4807: SIM_MODE drives the answers simulate() has to cope with. Unset —
    # i.e. every test written before TEAM-4807 — is the full, resource-aware answer
    # below, so those tests see exactly the behaviour they always saw.
    case "\${SIM_MODE:-full}" in
      empty)
        # rc 0 and not one row. THE F5 trigger: an empty OUT used to mean "pass".
        exit 0 ;;
      denied)
        # What a real denial looks like: a message on stderr and a non-zero exit.
        # The old redirect-plus-|| true ate both.
        echo "An error occurred (AccessDenied) when calling the SimulatePrincipalPolicy operation" >&2
        exit 255 ;;
    esac
    # Echo back one "<action>\\t<decision>" row per requested action, so the
    # script's own parsing is exercised. Writes are denied for the coding role,
    # and so is any table outside HubLiveVerifyRead's allow-list.
    #
    # TWO PASSES, deliberately (TEAM-4785): simulate() sends --action-names BEFORE
    # --resource-arns (si-ledger-handoff.sh:258-263), so a single-pass stub that
    # emits a row as it reads each action has not yet seen the resource and can
    # only ever answer "allowed" for it. Collect first, decide second.
    SRC=""; RES=""; ACTIONS=""; MODE=""
    for a in "$@"; do
      case "$MODE" in
        src) SRC="$a"; MODE="" ; continue ;;
        res) RES="$a"; MODE="" ; continue ;;
      esac
      case "$a" in
        --policy-source-arn) MODE=src ;;
        --resource-arns) MODE=res ;;
        --action-names) MODE=actions ;;
        --*) [ "$MODE" = actions ] && MODE="" ;;
        *)
          if [ "$MODE" = actions ]; then ACTIONS="$ACTIONS $a"; fi ;;
      esac
    done
    for a in $ACTIONS; do
      DECISION=allowed
      case "$SRC" in
        *coding-runtime-role)
          case "$a" in
            dynamodb:PutItem|dynamodb:UpdateItem|dynamodb:DeleteItem|s3:PutObject) DECISION=implicitDeny ;;
          esac
          case "$RES" in
            *table/agentcore-hub-cloud-code-sessions*|*table/agentcore-hub-routines*|*table/agentcore-hub-anomaly-watcher-state*|*table/agentcore-hub-eval-seen*) DECISION=implicitDeny ;;
          esac ;;
      esac
      # TEAM-4807: one role answers wrongly, so the ✗-on-mismatch path can be pinned
      # on its own without disturbing the other roles' verdicts.
      case "\${SIM_MODE:-full}" in
        mismatch-harness) case "$SRC" in *harness-role) DECISION=implicitDeny ;; esac ;;
      esac
      printf '%s\\t%s\\n' "$a" "$DECISION"
      # A truncated answer: fewer verdicts than actions requested. Written as an if,
      # NOT as a test-and-break one-liner — as the loop body's last statement that
      # leaves the stub's exit status at 1 whenever the condition is false, which
      # simulate() would then report as a failed CLI call. An untaken if returns 0.
      if [ "\${SIM_MODE:-full}" = partial ]; then break; fi
    done ;;
  "iam put-role-policy"*)
    # TEAM-4787 F2: the last call an IAM_ONLY=1 deploy is allowed to make. Answering
    # it (instead of exit 64) is what lets the IAM_ONLY tests below run the two real
    # deploy.sh files to completion; the calls log is the actual assertion.
    : ;;
  "bedrock-agentcore-control list-agent-runtimes"*)
    # continuous-improvement/deploy.sh:86 discovers the improver runtime. "None" is
    # the same answer a credential-less real CLI gives, and the script degrades to a
    # warning (:91-95) rather than failing.
    echo "None" ;;
  "bedrock-agentcore-control list-harnesses"*)
    echo "hid-test" ;;
  "bedrock-agentcore-control get-harness"*)
    # Honest: before --apply the harness env has no SI_LEDGER_TABLE yet (same shape
    # as the lambda get-function-configuration answer above).
    if [ "\${POST_APPLY:-}" = 1 ]; then echo "${TABLE}"; else echo "None"; fi ;;
  "ecs list-services"*)
    echo '{"serviceArns":["arn:aws:ecs:${REGION}:${ACCOUNT}:service/default/agentcore-hub"]}' ;;
  "ecs describe-express-gateway-service"*)
    # A LIVE-shaped container: a real image, an int containerPort and a non-empty
    # environment, because ecs-express/set-env.sh fails closed on any of those being
    # absent (set-env.sh:72-73). SI_LEDGER_TABLE is deliberately not in it yet.
    if [ "\${POST_APPLY:-}" = 1 ]; then
      echo '{"service":{"activeConfigurations":[{"primaryContainer":{"image":"stub:latest","containerPort":3000,"environment":[{"name":"EXISTING_KEY","value":"keep"},{"name":"SI_LEDGER_TABLE","value":"${TABLE}"}]}}]}}'
    else
      echo '{"service":{"activeConfigurations":[{"primaryContainer":{"image":"stub:latest","containerPort":3000,"environment":[{"name":"EXISTING_KEY","value":"keep"}]}}]}}'
    fi ;;
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
  // TEAM-4787 F2: a `gh` that always fails, so the eval gate's verdict is the same
  // here as in CI and on a dev box. `command -v gh` still succeeds (the file exists),
  // so EVAL_GATE=enforce reaches `gh auth status` and refuses there
  // (check-eval-gate.sh:553) instead of depending on whether the host's real gh
  // happens to be authenticated. Nothing else in this suite shells out to gh.
  const gh = join(dir, "gh");
  writeFileSync(gh, "#!/usr/bin/env bash\nexit 1\n");
  chmodSync(gh, 0o755);
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
    // TEAM-4787 F3: step 4 now INVOKES set-harness-env.mjs --dry-run, and that child
    // talks to the control plane through the SDK, which the stubbed `aws` cannot
    // intercept. Point it at the discard port (immediate ECONNREFUSED) and cap
    // retries, so the probe fails FAST and deterministically — AWS_MAX_ATTEMPTS alone
    // would still hang on connect in a sandbox with no network route. run_dry then
    // prints its ⚠ line, which is what the dry-run test asserts. The stubbed `aws`
    // ignores all of these, so the CLI-side answers are unaffected.
    AWS_ENDPOINT_URL: "http://127.0.0.1:9",
    AWS_MAX_ATTEMPTS: "1",
    AWS_RETRY_MODE: "standard",
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

// ── driving --apply as far as step 7 ────────────────────────────────────────
// TEAM-4807. --apply cannot be run against the real tree: step 2 runs the real
// setup-workflow-manager.mjs and step 4 runs set-harness-env.mjs WITHOUT --dry-run,
// and both reach AWS through the SDK — which the stubbed `aws` cannot intercept — so
// the script set -e-aborts long before step 7. But it derives every child from
// REPO_ROOT = dirname($0)/.. (si-ledger-handoff.sh:73), so a temp tree holding a COPY
// of the script plus one trivial stub per child runs the REAL step 7 verbatim. That
// keeps the production script free of any knob that exists only for tests.
//
// deploy/config.sh is the real one, so ACCOUNT_ID / LAMBDA_ROLE_ARN / ARTIFACT_BUCKET
// derive exactly as in production — and because it resolves .env.local relative to its
// own copy (config.sh:13), the copy in a temp tree can never find a developer's, so
// unlike the tests above these need no envLocalSkip.
const FAKE_CHILDREN = [
  "deploy/workflow-manager/setup-workflow-manager.mjs",
  "deploy/workflow-manager/set-harness-env.mjs",
  "deploy/workflow-manager/deploy.sh",
  "deploy/continuous-improvement/deploy.sh",
  "deploy/coding-agent-runtime/setup-coding-runtime-role.sh",
  "deploy/ecs-express/set-env.sh",
  "scripts/si-ledger-backfill.mjs",
];

function makeFakeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "si-handoff-apply-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "deploy"), { recursive: true });
  copyFileSync(HANDOFF, join(dir, "scripts/si-ledger-handoff.sh"));
  copyFileSync(join(REPO, "deploy/config.sh"), join(dir, "deploy/config.sh"));
  for (const rel of FAKE_CHILDREN) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    // .mjs children are invoked as `node <path>`, .sh as `bash <path>`. A bash-shebang
    // stub handed to node is a SyntaxError, which would abort step 2 under set -e.
    writeFileSync(
      dest,
      rel.endsWith(".mjs")
        ? `console.log("   [stub ${rel} " + process.argv.slice(2).join(" ") + "]");\n`
        : `#!/usr/bin/env bash\necho "   [stub ${rel} $*]"\nexit 0\n`,
    );
    chmodSync(dest, 0o755);
  }
  // Self-maintaining: every ${REPO_ROOT}/… path the script dereferences has to exist
  // here, so a child added to the script fails with THIS message rather than as a
  // confusing set -e abort halfway through an --apply.
  const referenced = new Set(
    [...readFileSync(HANDOFF, "utf8").matchAll(/\$\{REPO_ROOT\}\/([\w./-]+)/g)].map((m) => m[1]),
  );
  for (const rel of referenced) {
    assert.ok(existsSync(join(dir, rel)), `fake repo is missing ${rel} — add it to FAKE_CHILDREN`);
  }
  return join(dir, "scripts/si-ledger-handoff.sh");
}

function runApply(extra = {}) {
  const stub = makeStub();
  const r = spawnSync("bash", [makeFakeRepo(), "--apply"], {
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
  const actions = doc.Statement.flatMap(actionsOf);
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

  // ── scope: a fixed allow-list. No table wildcard, no bucket-root object read.
  // TEAM-4785 / F1: this role is UNTRUSTED, so "scoped" has to mean enumerated.
  const ddb = doc.Statement.filter((s) => actionsOf(s).some((a) => a.startsWith("dynamodb:")))
    .flatMap(resourcesOf);
  const leaf = LIVE_VERIFY_TABLES.map((t) => t.replace("agentcore-hub-", "")).join("|");
  const TABLE_ARN = new RegExp(
    `^arn:aws:dynamodb:[^:]+:\\d+:table/agentcore-hub-(${leaf})(/index/\\*)?$`,
  );
  for (const r of ddb) assert.match(r, TABLE_ARN, `out-of-scope table resource ${r}`);
  // …and EXACTLY the allow-list — the table ARN and its index ARN for each.
  assert.deepEqual(
    [...ddb].sort(),
    LIVE_VERIFY_TABLES.flatMap((t) => [
      `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${t}`,
      `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${t}/index/*`,
    ]).sort(),
  );

  const s3Get = doc.Statement.filter((s) => actionsOf(s).includes("s3:GetObject")).flatMap(resourcesOf);
  assert.deepEqual([...s3Get].sort(), [...S3_GETTABLE].sort());
  const S3_OK = new RegExp(
    `^arn:aws:s3:::${BUCKET}/(workflows/\\*|completions/\\*|config/(agents|workflows|connectors)\\.json)$`,
  );
  for (const r of s3Get) assert.match(r, S3_OK, `out-of-scope s3 object resource ${r}`);
});

test("HubLiveVerifyRead cannot reach session transcripts, and never lists the whole bucket", { skip: envLocalSkip }, () => {
  const doc = JSON.parse(runHandoff(["--print-policies"]).stdout).codingRuntimeRole.document;
  const raw = JSON.stringify(doc);

  // The untrusted runtime must not be able to read another tenant's session rows.
  for (const t of NEVER_READABLE) {
    assert.ok(!raw.includes(t), `${t} must stay unreadable from the coding runtime`);
  }
  assert.doesNotMatch(raw, /table\/agentcore-hub-\*/, "the table wildcard is back (TEAM-4785 F1)");
  assert.ok(!raw.includes("config/cd-registry.json"), "cd-registry carries the cross-account externalId");

  assert.ok(
    !doc.Statement.flatMap(resourcesOf).includes(`arn:aws:s3:::${BUCKET}/*`),
    "bucket-root s3:GetObject is back",
  );

  // s3:prefix is the ONLY way to scope a ListBucket, and an unconditioned one here
  // also superseded ConfigBundleRead's CloudCodeList (IAM unions Allows), voiding
  // its per-tenant cloud-code/t/* condition. Mirrors that statement's shape.
  const lists = doc.Statement.filter((s) => actionsOf(s).includes("s3:ListBucket"));
  assert.equal(lists.length, 1, "expected exactly one ListBucket statement");
  for (const s of lists) {
    assert.deepEqual(resourcesOf(s), [`arn:aws:s3:::${BUCKET}`]);
    const prefixes = s.Condition?.StringLike?.["s3:prefix"];
    assert.ok(
      Array.isArray(prefixes) && prefixes.length > 0,
      "ListBucket has no StringLike s3:prefix condition",
    );
    for (const p of prefixes) {
      assert.ok(typeof p === "string" && p.trim() !== "" && p !== "*", `unscoped s3:prefix ${JSON.stringify(p)}`);
      assert.ok(S3_PREFIXES.includes(p), `unexpected s3:prefix ${p}`);
    }
  }
});

test("step 7 simulates the cross-tenant negative, not just the write negative", { skip: envLocalSkip }, () => {
  const r = runHandoff(["--dry-run"]);
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);

  // The call is made against the excluded table…
  assert.match(
    r.calls,
    new RegExp(`simulate-principal-policy .*${SESSIONS_ARN.replace(/\*/g, "\\*")}`),
    `step 7 never simulated against ${SESSIONS_ARN}:\n${r.calls}`,
  );
  // …and step 7 reports the denial it expects. A single-pass stub would answer
  // "allowed" here, so this also pins the stub's resource-awareness.
  assert.match(
    r.stdout,
    /coding-runtime-role: dynamodb:Scan → implicitDeny/,
    `step 7 did not report the cloud-code-sessions denial:\n${r.stdout}`,
  );
  // The pre-existing write negative still holds.
  assert.match(r.stdout, /coding-runtime-role: dynamodb:PutItem → implicitDeny/);
  // And the ledger positives are unaffected by the resource-aware stub.
  assert.match(r.stdout, /coding-runtime-role: dynamodb:Scan → allowed/);
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

// TEAM-4787 F3 — a dry run that only *echoes* the two replace-all env pushes
// plans nothing: the whole risk in those two surfaces is what the MERGE would
// contain, and only the child's own read+merge can tell you that. So step 4 must
// invoke each child with its own --dry-run, and step 7 must verify all three
// surfaces the script touched (harness env, ECS env, lambda-role grant) — not
// just the table, the two Lambdas and the two IAM roles.
test("dry run really probes the replace-all env surfaces, and step 7 verifies all three", { skip: envLocalSkip }, () => {
  const r = runHandoff(["--dry-run"]);
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);

  // step 4: the children are INVOKED with --dry-run, not echoed.
  assert.match(
    r.stdout,
    /\+ node \S*set-harness-env\.mjs SI_LEDGER_TABLE=\S+ --dry-run/,
    `step 4 did not plan the harness push with --dry-run:\n${r.stdout}`,
  );
  assert.match(
    r.stdout,
    /\+ bash \S*ecs-express\/set-env\.sh SI_LEDGER_TABLE=\S+ --dry-run/,
    `step 4 did not plan the ECS push with --dry-run:\n${r.stdout}`,
  );
  // …and the ECS probe really read the live container (echoing cannot do this).
  assert.match(
    r.calls,
    /ecs describe-express-gateway-service/,
    `the ECS dry-run probe never read the live container:\n${r.calls}`,
  );
  assert.match(r.stdout, /🔧 agentcore-hub \(default, us-east-1\)/, "set-env.sh did not report its merge");

  // The harness probe uses the SDK, which the stubbed `aws` cannot answer, so it
  // fails here by design (stubEnv points it at the discard port). A failed probe
  // is information, not a reason to abort a dry run — but it must say plainly
  // that --apply would stop here.
  assert.match(
    r.stdout,
    /⚠ dry-run probe failed \(rc \d+\) — --apply would abort here/,
    `a failed dry-run probe was not reported as "--apply would abort here":\n${r.stdout}`,
  );

  // step 7: the three checks the script applied but never verified.
  assert.match(
    r.stdout,
    /agentcore_hub_workflow_manager: SI_LEDGER_TABLE=/,
    `step 7 never verified the harness env:\n${r.stdout}`,
  );
  assert.match(r.calls, /bedrock-agentcore-control get-harness/, "step 7 never called GetHarness");
  assert.match(
    r.stdout,
    /agentcore-hub \([^)]*\): SI_LEDGER_TABLE=/,
    `step 7 never verified the ECS container env:\n${r.stdout}`,
  );
  assert.match(
    r.stdout,
    /lambda-role: dynamodb:Scan → allowed/,
    `step 7 never simulated the agentcore-hub-lambda-role grant step 3 applies:\n${r.stdout}`,
  );
  for (const action of ["dynamodb:GetItem", "dynamodb:PutItem"]) {
    assert.match(r.stdout, new RegExp(`lambda-role: ${action} → allowed`), `lambda-role: no ${action} verdict`);
  }

  // Still a dry run: the probes are reads, and nothing was mutated.
  assert.doesNotMatch(
    r.calls,
    /(update-harness|update-express-gateway-service|update-function-configuration|put-role-policy|create-table)/,
    `the dry-run probes mutated something:\n${r.calls}`,
  );
});

// ── 3b. TEAM-4807 / F5 — a check that returned no verdict is not a check that passed
//
// simulate() swallowed stderr AND exit status (`2>/dev/null || true`) and then treated
// an empty answer as a pass: a ⚠ and `return 0`, never touching FAILURES. FAILURES was
// the only counter the summary consulted, so a run in which all 16 IAM action verdicts
// across 5 call sites went unevaluated printed "✓ all checks passed" and exited 0 — in
// --apply as much as in dry run. That is a green handoff over an unverified account,
// i.e. the TEAM-4770 failure (deployed but inert) with a tick next to it.
//
// The negative space matters as much as the assertions: these tests must NOT be
// satisfiable by a script that merely prints a scarier warning. They pin the verdict
// (✗ + exit 1 under --apply), the counting (a dry run can no longer claim success) and
// the completeness (each requested action needs its own verdict).

test("a simulate with NO verdict does not let a dry run claim success", { skip: envLocalSkip }, () => {
  const r = runHandoff(["--dry-run"], { SIM_MODE: "empty", POST_APPLY: "1" });
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);

  // The hint an operator actually acts on has to survive the fix.
  assert.match(
    r.stdout,
    /⚠ agentcore-hub-harness-role: simulate-principal-policy unavailable \(needs iam:SimulatePrincipalPolicy\)/,
    `the iam:SimulatePrincipalPolicy hint was lost:\n${r.stdout}`,
  );
  // Every env surface is satisfied here, so FAILURES=0 — and that is exactly when the
  // old summary claimed success over an account with zero verified grants.
  assert.doesNotMatch(
    r.stdout,
    /all checks passed/,
    `a run that evaluated 0 of 16 IAM verdicts still claimed success:\n${r.stdout}`,
  );
  assert.match(r.stdout, /check\(s\) skipped/, `the skipped checks were not counted:\n${r.stdout}`);
  assert.match(r.stdout, /NOT verified/, `the summary does not say the checks are unverified:\n${r.stdout}`);
  // Still a dry run.
  assert.doesNotMatch(r.calls, /(put-role-policy|create-table|update-function-configuration)/);
});

test("--apply FAILS when a grant cannot be verified", () => {
  const r = runApply({ SIM_MODE: "empty", POST_APPLY: "1" });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);

  // --apply has just applied the grant, so "cannot tell" is a failed handoff, not a
  // warning — and the hint is still there to say what to do about it.
  assert.match(
    r.stdout,
    /✗ agentcore-hub-harness-role: simulate-principal-policy unavailable \(needs iam:SimulatePrincipalPolicy\) — not verified after --apply/,
    `--apply did not fail the unverifiable harness-role grant:\n${r.stdout}`,
  );
  // One per simulate() call site: harness, coding-runtime ×3, lambda-role.
  assert.match(`${r.stdout}${r.stderr}`, /✗ 5 check\(s\) failed after --apply/);
  assert.doesNotMatch(r.stdout, /all checks passed/);

  // The fake children absorb the mutations, so --apply reaches step 7 without the stub
  // seeing a single write — its `exit 64` catch-all stays armed for the whole run.
  assert.doesNotMatch(
    r.calls,
    /(put-role-policy|create-table|update-function-configuration|update-harness|update-express-gateway-service)/,
    `--apply mutated something through the stub:\n${r.calls}`,
  );
});

test("--apply says WHY it could not verify, so AccessDenied and throttling differ", () => {
  const r = runApply({ SIM_MODE: "denied", POST_APPLY: "1" });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /✗ agentcore-hub-harness-role: simulate-principal-policy unavailable/);
  // `|| true` swallowed the status and `2>/dev/null` the message. Now that this exits
  // 1, "grant the permission" and "just retry" have to be tellable apart.
  assert.match(r.stdout, /\[rc 255\]/, `the CLI's exit status was swallowed:\n${r.stdout}`);
  assert.match(r.stdout, /AccessDenied/, `the CLI's stderr was swallowed:\n${r.stdout}`);
});

test("a PARTIAL simulate answer is not a pass, and names the actions with no verdict", { skip: envLocalSkip }, () => {
  // Quieter than F5 itself: OUT is non-empty, so there was no ⚠ AND no ✗ — 11 of 16
  // verdicts simply vanished under a clean "✓ all checks passed".
  const dry = runHandoff(["--dry-run"], { SIM_MODE: "partial", POST_APPLY: "1" });
  assert.equal(dry.status, 0, `exit ${dry.status}\n${dry.stdout}\n${dry.stderr}`);
  assert.doesNotMatch(
    dry.stdout,
    /all checks passed/,
    `a truncated simulate answer still claimed success:\n${dry.stdout}`,
  );
  assert.match(
    dry.stdout,
    /⚠ agentcore-hub-harness-role: simulate-principal-policy returned no verdict for dynamodb:GetItem,dynamodb:Query,dynamodb:Scan,dynamodb:PutItem,dynamodb:UpdateItem/,
    `the unanswered actions were not named:\n${dry.stdout}`,
  );
  // The one action that WAS answered still gets its own verdict — a partial answer
  // must not throw away the part that arrived.
  assert.match(dry.stdout, /✓ agentcore-hub-harness-role: dynamodb:DescribeTable → allowed/);
  // Three multi-action call sites were short-changed; the two single-action negatives
  // were answered in full.
  assert.match(dry.stdout, /⚠ 3 check\(s\) skipped/);

  const r = runApply({ SIM_MODE: "partial", POST_APPLY: "1" });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /✗ 3 check\(s\) failed after --apply/);
});

// The mismatch path was already correct at b399ae3 — no test covered it under --apply,
// which is how a fix to the empty path could have broken it unnoticed.
test("--apply FAILS on a mismatching decision", () => {
  const r = runApply({ SIM_MODE: "mismatch-harness", POST_APPLY: "1" });
  assert.match(
    r.stdout,
    /✗ agentcore-hub-harness-role: dynamodb:Scan → implicitDeny \(expected allowed\)/,
    `a wrong decision was not reported:\n${r.stdout}`,
  );
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  // Exactly the harness role's six actions — the other roles still verify normally, so
  // "unverifiable" and "wrong" stay separate verdicts rather than one blanket failure.
  assert.match(`${r.stdout}${r.stderr}`, /✗ 6 check\(s\) failed after --apply/);
  assert.match(r.stdout, /✓ agentcore-hub-lambda-role: dynamodb:Scan → allowed/);
  assert.doesNotMatch(r.stdout, /check\(s\) skipped/, "a wrong decision was miscounted as skipped");
});

// TEAM-4787 left the range comment at si-ledger-handoff.sh:63-65 because a stale
// `sed -n '2,Np'` truncates --help silently. TEAM-4807 grew the header again, so pin it.
test("--help still prints the whole header", () => {
  const r = runHandoff(["--help"]);
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  // First and last lines of the header block.
  assert.match(r.stdout, /SI ledger handoff — apply the non-code surfaces of PR #637/);
  assert.match(
    r.stdout,
    /tooling\.coding-role\.no-live-verify-access/,
    "--help is truncated: the sed range no longer reaches the last header line",
  );
  // …and it documents when --apply now fails.
  assert.match(r.stdout, /never counts a check it could not EVALUATE as passed/);
  assert.doesNotMatch(r.stdout, /set -euo pipefail/, "--help spilled past the end of the header");
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

// TEAM-4787 F4 — the main guard. `file://${process.argv[1]}` does not
// percent-encode, so from any path containing a space it never equals
// import.meta.url: main() never runs, the process exits 0 with no output, and the
// handoff reports a successful harness push having pushed nothing. --help is the
// cheapest observable because it returns BEFORE the @aws-sdk dynamic import, and a
// COPY is enough because the file's only static import is a node: builtin.
//
// Copy, not symlink: without --preserve-symlinks-main node resolves the main entry
// to its realpath, so a symlink would put the space in argv[1] but not in
// import.meta.url and this test would fail even with the fix.
test("set-harness-env.mjs still runs from a path containing a space", () => {
  const src = join(REPO, "deploy/workflow-manager/set-harness-env.mjs");
  const dir = mkdtempSync(join(tmpdir(), "si handoff space-")); // the space is the point
  const dest = join(dir, "set-harness-env.mjs");
  copyFileSync(src, dest);

  const r = spawnSync(process.execPath, [dest, "--help"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  assert.match(
    r.stdout,
    /Usage: node .*set-harness-env\.mjs/,
    "the main guard compared import.meta.url to an unencoded `file://${argv[1]}`, so from a " +
      "path with a space main() never runs: the process exits 0 with empty stdout and the " +
      "handoff reports a harness push it never made",
  );

  // Control: the in-repo path (no space) behaves identically, so the assertion
  // above is about encoding and not about --help itself.
  const ok = spawnSync(process.execPath, [src, "--help"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Usage: node .*set-harness-env\.mjs/);
});

// ── 3c. TEAM-4809 F2 — a flag whose operand never arrived is an error ────────
//
// `unsets.push(argv[++i])` pushed `undefined` for a trailing `--unset`; the
// "nothing to do" guard only counts unsets.length, and `undefined in env` is
// false, so the run reached ListHarnesses + GetHarness, removed nothing, printed
// "nothing changed" and exited 0. An operator who mistyped an unset got a green
// run with the variable still set — the TEAM-4770 shape (inert, with a tick).
// A flag-shaped operand is the same defect: `--unset --dry-run` would have
// removed a key named "--dry-run" AND consumed the --dry-run, so a run the
// operator planned as a dry run would have written.

test("set-harness-env.mjs rejects a --unset/--harness with no operand", async () => {
  const mod = await import("../../deploy/workflow-manager/set-harness-env.mjs");

  // Missing operand: `argv[++i]` walked off the end.
  assert.throws(() => mod.parseArgs(["--unset"]), /--unset expects a value, got nothing/);
  assert.throws(() => mod.parseArgs(["A=1", "--unset"]), /--unset expects a value/);
  assert.throws(() => mod.parseArgs(["--harness"]), /--harness expects a value, got nothing/);

  // Flag-shaped operand: the next token is the NEXT flag, never a key name.
  assert.throws(() => mod.parseArgs(["--unset", "--dry-run"]), /--unset expects a value, got "--dry-run"/);
  assert.throws(() => mod.parseArgs(["--harness", "--unset", "OLD"]), /--harness expects a value, got "--unset"/);

  // The pre-existing rejection is unchanged.
  assert.throws(() => mod.parseArgs(["--bogus"]), /unknown flag --bogus/);

  // …and every valid form still parses exactly as before.
  assert.deepEqual(mod.parseArgs(["A=1", "--unset", "OLD", "--harness", "h", "--dry-run"]), {
    harnessName: "h",
    unsets: ["OLD"],
    assignments: ["A=1"],
    dryRun: true,
  });
  assert.deepEqual(mod.parseArgs(["A=1"]), {
    harnessName: mod.DEFAULT_HARNESS_NAME,
    unsets: [],
    assignments: ["A=1"],
    dryRun: false,
  });
});

// The exit code alone proves nothing here: stubEnv points the SDK at the discard
// port, so the BUGGY version also exits 1 — just from ECONNREFUSED on
// ListHarnesses, after having decided that removing a key called "undefined" was
// the job. The MESSAGE is the assertion, and it can only come from the parse,
// which runs above the @aws-sdk dynamic import.
test('a dangling --unset fails at parse, not with "nothing changed"', () => {
  const stub = makeStub();
  const r = spawnSync(
    process.execPath,
    [join(REPO, "deploy/workflow-manager/set-harness-env.mjs"), "--unset"],
    { cwd: REPO, env: stubEnv(stub), encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(
    r.stderr,
    /✗ --unset expects a value/,
    `the dangling --unset was not rejected at parse:\n${r.stdout}\n${r.stderr}`,
  );
  assert.doesNotMatch(
    r.stdout,
    /nothing changed/,
    `a mistyped unset was reported as a successful no-op:\n${r.stdout}`,
  );
  // It never reached an AWS call, so it cannot have reported a harness.
  assert.doesNotMatch(r.stdout, /🔧/);
});

// TEAM-4809 sibling sweep — deploy/ecs-express/set-env.sh is the OTHER replace-all
// env push the handoff drives (step 4), and it had F2's flag-shaped-operand half:
// `--unset) UNSETS+=("$2"); shift 2` took "--dry-run" as the key name and consumed
// the --dry-run with it. set -euo pipefail already aborted on a TRAILING --unset.
//
// NOTE on "before any aws call": the guard is in the arg loop, which sits below
// `source ../config.sh` — and config.sh:23 resolves the account via
// `aws sts get-caller-identity`. So one read precedes the rejection no matter what
// the guard does; hoisting the loop above the source would reorder which error an
// uncredentialled box reports first, which is more than this fix should change.
// The assertion is therefore the one that matters: no ecs call, and no mutation.
test("set-env.sh rejects a flag-shaped --unset operand before any ecs call", () => {
  const stub = makeStub();
  const r = spawnSync("bash", [join(REPO, "deploy/ecs-express/set-env.sh"), "--unset", "--dry-run"], {
    cwd: REPO,
    env: stubEnv(stub),
    encoding: "utf8",
    timeout: 60_000,
  });
  const calls = existsSync(stub.log) ? readFileSync(stub.log, "utf8") : "";
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(
    r.stderr,
    /--unset expects a value/,
    `set-env.sh took a flag as the key to unset:\n${r.stdout}\n${r.stderr}`,
  );
  // It never got to the service, let alone the merge or the update.
  assert.doesNotMatch(calls, /\becs\b/, `set-env.sh reached an ecs call before rejecting:\n${calls}`);
  assert.doesNotMatch(r.stdout, /🔧/, `set-env.sh merged an env from a flag-shaped key:\n${r.stdout}`);
  // Only config.sh's account probe may have run (see the note above).
  for (const line of calls.split("\n").filter(Boolean)) {
    assert.match(line, /^sts get-caller-identity/, `unexpected AWS call before the guard: ${line}`);
  }
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

// TEAM-4787 F2 — the static test above proves the guard is in the right PLACE.
// It cannot prove the script makes no other write before reaching it, and both
// files did: continuous-improvement/deploy.sh created the artifact bucket and
// rewrote its notification configuration above the guard, and
// workflow-manager/deploy.sh consulted the eval gate above the guard — which
// needs gh + jq + a green check run and hard-exits without them, and whose
// break-glass path performs its own S3 write. So RUN each script and assert on
// the calls log. One test per script, so a regression in either names itself.
//
// EVAL_GATE=enforce on purpose: the gate must be SKIPPED under IAM_ONLY=1, not
// satisfied. WORKFLOW_MANAGER_ARN is passed so the harness-discovery exit at
// workflow-manager/deploy.sh:43-47 is not what this test measures.
const IAM_ONLY_ENV = {
  IAM_ONLY: "1",
  EVAL_GATE: "enforce",
  WORKFLOW_MANAGER_ARN: `arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:harness/wm-test`,
};
// Reads, the conditional create-table, and put-role-policy. Nothing else.
const IAM_ONLY_ALLOWED =
  /^(sts get-caller-identity|iam put-role-policy|dynamodb (describe-table|create-table|wait table-exists)|bedrock-agentcore-control list-(harnesses|agent-runtimes)|logs describe-log-groups)\b/;

for (const [label, script] of [
  ["deploy/workflow-manager/deploy.sh", WM_DEPLOY],
  ["deploy/continuous-improvement/deploy.sh", CI_DEPLOY],
]) {
  test(`IAM_ONLY=1 ${label} writes IAM + tables and nothing else`, { skip: envLocalSkip }, () => {
    const stub = makeStub();
    const r = spawnSync("bash", [script], {
      cwd: REPO,
      env: stubEnv(stub, IAM_ONLY_ENV),
      encoding: "utf8",
      timeout: 120_000,
    });
    const calls = existsSync(stub.log) ? readFileSync(stub.log, "utf8") : "";
    assert.equal(r.status, 0, `${label} exited ${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);

    // The point of IAM_ONLY: the grant lands…
    assert.match(calls, /iam put-role-policy/, `${label}: IAM_ONLY=1 applied no IAM`);
    // …and nothing else does.
    assert.doesNotMatch(
      calls,
      /s3api put-bucket-notification-configuration/,
      `${label}: IAM_ONLY=1 rewrote the artifact bucket's notification configuration:\n${calls}`,
    );
    assert.doesNotMatch(calls, /(^|\n)s3 mb\b/, `${label}: IAM_ONLY=1 created a bucket:\n${calls}`);
    assert.doesNotMatch(calls, /(^|\n)s3 (cp|sync)\b/, `${label}: IAM_ONLY=1 wrote to S3:\n${calls}`);
    assert.doesNotMatch(
      calls,
      /lambda (update-function-|create-function|add-permission)/,
      `${label}: IAM_ONLY=1 deployed Lambda code or env:\n${calls}`,
    );
    assert.doesNotMatch(
      calls,
      /(events put-rule|events put-targets|cloudwatch put-metric-alarm|sns create-topic|logs put-subscription-filter)/,
      `${label}: IAM_ONLY=1 wired infra:\n${calls}`,
    );
    for (const line of calls.split("\n").filter(Boolean)) {
      assert.match(line, IAM_ONLY_ALLOWED, `${label}: IAM_ONLY=1 made a non-IAM call: ${line}`);
    }

    // The eval gate was not consulted at all — not even to print "skipped".
    // An IAM_ONLY run ships no gated artifact (no prompt, skill or toolkit), so
    // there is nothing for the gate to gate, and making the IAM re-apply depend
    // on gh/jq/GitHub is the opposite of "IAM only".
    assert.doesNotMatch(
      `${r.stdout}${r.stderr}`,
      /eval[- ]gate/i,
      `${label}: IAM_ONLY=1 consulted the eval gate\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`,
    );
    assert.match(r.stdout, /IAM_ONLY=1 — stopping/, `${label}: did not report the IAM_ONLY stop`);
  });
}

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

// ── 4b. TEAM-4809 F1 — the account comes from STS on every mutating path ─────
//
// `let accountId = getArg("account-id")` was honoured in EVERY mode, including
// --iam-only, while the comment above it said "Every other mode still resolves the
// account from credentials". accountId builds tableArns, ROLE_ARN and the
// trust-policy conditions, so `--iam-only --account-id <other>` with real
// credentials put WorkflowManagerData — scoped to ANOTHER account's table ARNs —
// on the REAL agentcore-hub-harness-role, and printed ✓. The flag had no caller
// anywhere in the repo and was absent from the usage header.
//
// 210987654321 is this repo's second placeholder account
// (scripts/check-no-hardcoded-accounts.sh:12-13).
const WRONG_ACCOUNT = "210987654321";

test("setup-workflow-manager.mjs takes the account from STS, never from an argument", () => {
  const src = readFileSync(join(REPO, "deploy/workflow-manager/setup-workflow-manager.mjs"), "utf8");

  // No argument may name the account.
  assert.doesNotMatch(
    src,
    /getArg\((["'])account-id\1\)/,
    "the account is taken from an argument again — that aims PutRolePolicy at another account",
  );

  // Exactly ONE assignment of accountId that is not the STS answer (that line
  // reads `accountId } =`, so it does not match), and it is gated on PRINT_POLICY,
  // which exits before the first IAM client.
  const assigns = src.split("\n").filter((l) => /\baccountId\s*=/.test(l) && !l.includes("sts.send"));
  assert.equal(assigns.length, 1, `unexpected accountId assignment(s):\n${assigns.join("\n")}`);
  assert.match(assigns[0], /PRINT_POLICY/, `the account is overridable outside --print-policy: ${assigns[0]}`);
  assert.match(assigns[0], /process\.env\.AWS_ACCOUNT_ID/);
});

// The behavioural half. stubEnv gives fake credentials and points every SDK client
// at the discard port, so BOTH versions exit non-zero — what differs is WHERE.
// With the bug, --account-id short-circuits STS, WM_DATA_POLICY is built for the
// forged account, and the run reaches the "1/4 Execution role" banner before dying
// on GetRole (against a real account it would reach PutRolePolicy and print ✓).
// Fixed, it dies inside GetCallerIdentity, above that banner.
//
// stubEnv also sets AWS_ACCOUNT_ID, so the same banner assertion simultaneously
// pins that AWS_ACCOUNT_ID is ignored outside --print-policy — i.e. it pins the
// comment's claim, not just the flag's removal.
test("--iam-only ignores an account argument and stops at STS", () => {
  const r = spawnSync(
    process.execPath,
    [
      join(REPO, "deploy/workflow-manager/setup-workflow-manager.mjs"),
      "--iam-only",
      "--account-id",
      WRONG_ACCOUNT,
    ],
    { cwd: REPO, env: stubEnv(makeStub()), encoding: "utf8", timeout: 60_000 },
  );
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, `--iam-only succeeded with a forged account:\n${out}`);
  assert.ok(!out.includes(WRONG_ACCOUNT), `${WRONG_ACCOUNT} reached the run:\n${out}`);
  assert.doesNotMatch(
    r.stdout,
    /1\/4 Execution role/,
    `--iam-only got past account resolution with a forged account:\n${r.stdout}`,
  );
  assert.doesNotMatch(r.stdout, /WorkflowManagerData inline policy applied/);
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
