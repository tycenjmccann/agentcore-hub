// TEAM-5599 — tools/live-verify-preflight.sh, pinned.
//
// HERMETIC: a fake boto3 (fixtures/fake-boto3) is prepended to PYTHONPATH, so the
// script's SDK calls are scripted per test and logged; nothing reaches AWS. Each
// test states one acceptance criterion:
//   - all grants ok + negatives denied → exit 0, a lint-clean record table;
//   - a negative that is wrongly ALLOWED → exit 1, MISMATCH, and no write can land;
//   - strict verdicts: ok only on success, denied only on AccessDenied* (or the
//     PutEvents per-entry authorization codes), anything else error:<Code> + MISMATCH;
//   - today's baseline (Lane not applied) → exit 1, rows read `denied`, not errors;
//   - --cleanup deletes only wf_scratch_* rows / zz-* records PROVEN older than 24h;
//   - --jira-env prints the four exports; no other path prints the token.
// SCOPE: this pins the script's classification and call shapes, not IAM. Whether the
// live policy's conditions actually allow/deny is proven only by the post-deploy
// capture (README "Live-verify lane", PR #836 post-merge step).
//
// Run: `node --test scripts/__tests__/live-verify-preflight.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lintMarkdown } from "../../lambda/workflow-output/deliverables-lint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SCRIPT = join(ROOT, "tools", "live-verify-preflight.sh");
const FAKE = join(HERE, "fixtures", "fake-boto3");
const RECORD_SECTIONS = ["Status", "Timeline", "Open items"];

// The negatives a correct policy denies. Every "all ok" scenario starts from these.
const NEGATIVES_DENIED = [
  { op: "dynamodb.PutItem", match: "zz_not_scratch_", error: "AccessDeniedException" },
  { op: "dynamodb.UpdateItem", match: "zz_not_scratch_", error: "AccessDeniedException" },
  { op: "dynamodb.DeleteItem", match: "zz_not_scratch_", error: "AccessDeniedException" },
  { op: "events.PutEvents", match: "workflow\\.preflight",
    response: { FailedEntryCount: 1, Entries: [{ ErrorCode: "NotAuthorizedForDetailTypeException" }] } },
  { op: "bedrock-agentcore-control.CreateRegistryRecord", match: "zzpreflightnoexist", error: "AccessDeniedException" },
  { op: "secretsmanager.GetSecretValue", match: "cloud-code/github-app", error: "AccessDeniedException" },
  { op: "dynamodb.DescribeTable", match: "cloud-code-sessions", error: "AccessDeniedException" },
  { op: "s3.GetObject", match: "config/cd-registry\\.json", error: "AccessDenied" },
  { op: "lambda.Invoke", error: "AccessDeniedException" },
];

function run(args, rules, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  const scenario = join(dir, "scenario.json");
  const log = join(dir, "calls.jsonl");
  writeFileSync(scenario, JSON.stringify({ rules }));
  const r = spawnSync("bash", [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      PYTHONPATH: FAKE,
      FAKE_BOTO3_SCENARIO: scenario,
      FAKE_BOTO3_LOG: log,
      AWS_REGION: "us-east-1",
      ...extraEnv,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { ...r, calls, dir };
}

function rows(stdout) {
  return stdout.split("\n").filter((l) => /^\| \d+ \|/.test(l)).map((l) => {
    const [, n, grant, call, expected, actual, verdict] = l.split("|").map((c) => c.trim());
    return { n: Number(n), grant, call, expected, actual, verdict };
  });
}

test("all grants ok and negatives denied → exit 0 and a lint-clean record", () => {
  const r = run(["--out", "preflight.md"], NEGATIVES_DENIED);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const table = rows(r.stdout);
  assert.ok(table.length >= 30, `only ${table.length} rows`);
  assert.deepEqual(table.filter((t) => t.verdict !== "match"), []);
  assert.match(r.stdout, /\| # \| grant \| call \| expected \| actual \| verdict \|/);
  for (const verb of ["PutItem", "UpdateItem", "DeleteItem"]) {
    for (const tbl of ["agentcore-hub-workflows", "agentcore-hub-events", "agentcore-hub-tickets"]) {
      const row = table.find((t) => t.call.startsWith(`ddb ${verb} ${tbl} zz_not_scratch_`));
      assert.ok(row, `no ${verb} negative on ${tbl}`);
      assert.deepEqual([row.expected, row.actual, row.verdict], ["denied", "denied", "match"]);
    }
  }
  for (const neg of ["zz_not_scratch_", "workflow.preflight", "outside the scratch registry", "cloud-code/github-app",
    "cloud-code-sessions", "config/cd-registry.json", "lambda Invoke DryRun"]) {
    const row = table.find((t) => t.call.includes(neg));
    assert.ok(row, `no negative row for ${neg}`);
    assert.equal(row.expected, "denied");
    assert.equal(row.actual, "denied");
  }
  // --out writes the same record, and it passes the workflow-output writing-standard lint.
  const written = readFileSync(join(r.dir, "preflight.md"), "utf8");
  assert.equal(written.trim(), r.stdout.trim());
  assert.deepEqual(lintMarkdown(written, RECORD_SECTIONS), []);
  // Scratch rows are put, updated and deleted under wf_scratch_ keys only.
  const writes = r.calls.filter((c) => /dynamodb\.(PutItem|UpdateItem|DeleteItem)$/.test(c.op));
  for (const w of writes) {
    const key = JSON.stringify(w.kw.Item || w.kw.Key);
    assert.match(key, /wf_scratch_preflight_|zz_not_scratch_/, key);
  }
  assert.ok(r.calls.some((c) => c.op === "bedrock-agentcore-control.DeleteRegistryRecord" && c.kw.recordId === "rec000000001"),
    "the scratch registry record was not deleted");
});

test("the secret value is never printed by the preflight", () => {
  const r = run([], NEGATIVES_DENIED);
  assert.doesNotMatch(r.stdout + r.stderr, /FAKE-TOKEN-123/);
});

test("a wrongly ALLOWED negative is a MISMATCH and exits 1, and no write can land", () => {
  // Wrongly allowed: IAM lets the call reach DynamoDB / the Registry, which then refuse it on
  // the condition (the key never exists) or on existence (the registry id never exists).
  const rules = NEGATIVES_DENIED.filter((x) => !/zz_not_scratch_|zzpreflightnoexist/.test(x.match || ""));
  for (const op of ["PutItem", "UpdateItem", "DeleteItem"]) {
    rules.unshift({ op: `dynamodb.${op}`, match: "zz_not_scratch_", error: "ConditionalCheckFailedException" });
  }
  rules.unshift({ op: "bedrock-agentcore-control.CreateRegistryRecord", match: "zzpreflightnoexist", error: "ResourceNotFoundException" });
  const r = run([], rules);
  assert.equal(r.status, 1, r.stdout);
  const bad = rows(r.stdout).filter((t) => t.verdict === "MISMATCH");
  assert.equal(bad.length, 10, r.stdout);
  for (const t of bad.filter((t) => t.call.includes("zz_not_scratch_"))) {
    assert.equal(t.actual, "error:ConditionalCheckFailedException");
  }
  assert.equal(bad.find((t) => t.call.includes("outside the scratch registry")).actual, "error:ResourceNotFoundException");
  // Every non-scratch write requires its never-existing key to exist, so none can write.
  const negWrites = r.calls.filter((c) => /^dynamodb\./.test(c.op) && JSON.stringify(c.kw).includes("zz_not_scratch_"));
  assert.equal(negWrites.length, 9);
  for (const c of negWrites) {
    assert.match(c.op, /\.(PutItem|UpdateItem|DeleteItem)$/);
    assert.match(c.kw.ConditionExpression, /^attribute_exists\((workflowId|ticketId)\)$/, JSON.stringify(c));
  }
  // The out-of-scratch create targeted a registry id that does not exist.
  const create = r.calls.filter((c) => c.op === "bedrock-agentcore-control.CreateRegistryRecord").map((c) => c.kw.registryId);
  assert.ok(create.includes("zzpreflightnoexist"));
  assert.match(r.stdout, /## Open items[\s\S]*expected denied, got error:ConditionalCheckFailedException/);
});

test("strict positives: a non-success, non-denied error is error:<Code> and a MISMATCH", () => {
  const rules = [
    { op: "dynamodb.UpdateItem", match: "wf_scratch_preflight_.*agentcore-hub-workflows|agentcore-hub-workflows.*wf_scratch_preflight_",
      error: "ConditionalCheckFailedException" },
    { op: "bedrock-agentcore-control.ListHarnesses", error: "ValidationException" },
    { op: "s3.GetObject", match: "performance/index\\.json", error: "NoSuchKey" }, // absent is NOT n/a here
    ...NEGATIVES_DENIED,
  ];
  const r = run([], rules);
  assert.equal(r.status, 1, r.stdout);
  const bad = rows(r.stdout).filter((t) => t.verdict === "MISMATCH");
  assert.deepEqual(bad.map((t) => [t.call.replace(/_\d+$/, "_N"), t.actual]), [
    ["s3 GetObject performance/index.json (1 byte)", "error:NoSuchKey"],
    ["ddb UpdateItem agentcore-hub-workflows wf_scratch_preflight_N", "error:ConditionalCheckFailedException"],
    ["agentcore ListHarnesses", "error:ValidationException"],
  ]);
});

test("strict negatives: only an authorization refusal counts as denied", () => {
  const rules = NEGATIVES_DENIED.filter((x) => x.op !== "secretsmanager.GetSecretValue" && x.op !== "dynamodb.DescribeTable");
  rules.unshift({ op: "secretsmanager.GetSecretValue", match: "cloud-code/github-app", error: "ResourceNotFoundException" },
    { op: "dynamodb.DescribeTable", match: "cloud-code-sessions", error: "ThrottlingException" });
  const r = run([], rules);
  assert.equal(r.status, 1, r.stdout);
  const bad = rows(r.stdout).filter((t) => t.verdict === "MISMATCH");
  assert.deepEqual(bad.map((t) => t.actual), ["error:ResourceNotFoundException", "error:ThrottlingException"]);
});

test("optional tickets table absent → n/a; the same absence on a required table is a MISMATCH", () => {
  const absent = (table) => ["GetItem", "PutItem", "UpdateItem", "DeleteItem"].map((op) => (
    { op: `dynamodb.${op}`, match: `${table}.*wf_scratch_preflight_|wf_scratch_preflight_.*${table}`, error: "ResourceNotFoundException" }));
  let r = run([], [...absent("agentcore-hub-tickets"), ...NEGATIVES_DENIED]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(rows(r.stdout).filter((t) => t.call.includes("agentcore-hub-tickets wf_scratch") || t.call === "ddb GetItem agentcore-hub-tickets")
    .filter((t) => t.actual === "n/a").length, 4);
  r = run([], [...absent("agentcore-hub-events"), ...NEGATIVES_DENIED]);
  assert.equal(r.status, 1, r.stdout);
  for (const t of rows(r.stdout).filter((t) => /^ddb (Put|Update|Delete)Item agentcore-hub-events wf_scratch/.test(t.call))) {
    assert.deepEqual([t.actual, t.verdict], ["error:ResourceNotFoundException", "MISMATCH"]);
  }
});

test("a nonexistent LIVE_VERIFY_REGISTRY_ID is a MISMATCH on every registry row, with no fake Delete", () => {
  const rules = ["GetRegistry", "ListRegistryRecords", "CreateRegistryRecord"].map((op) => (
    { op: `bedrock-agentcore-control.${op}`, match: "zzreg000000099", error: "ResourceNotFoundException" }));
  const r = run([], [...rules, ...NEGATIVES_DENIED], { LIVE_VERIFY_REGISTRY_ID: "zzreg000000099" });
  assert.equal(r.status, 1, r.stdout);
  const reg = rows(r.stdout).filter((t) => t.grant.startsWith("LaneRegistry") && !t.grant.includes("negative") && t.grant !== "LaneRegistryList");
  assert.deepEqual(reg.map((t) => [t.actual, t.verdict]), [
    ["error:ResourceNotFoundException", "MISMATCH"],
    ["error:ResourceNotFoundException", "MISMATCH"],
    ["error:ResourceNotFoundException", "MISMATCH"],
    ["skipped (no record created)", "MISMATCH"],
  ]);
  assert.ok(!r.calls.some((c) => c.op === "bedrock-agentcore-control.DeleteRegistryRecord"), "probed a Delete with no record");
});

test("baseline before deploy: Lane calls denied → rows read `denied`, exit 1, no crash", () => {
  const laneDenied = [
    "s3.ListObjectsV2:performance/", "s3.GetObject:performance/", "dynamodb.PutItem:", "dynamodb.UpdateItem:",
    "dynamodb.DeleteItem:", "events.PutEvents:", "bedrock-agentcore-control.ListRegistries:",
    "bedrock-agentcore-control.ListHarnesses:", "bedrock-agentcore-control.ListAgentRuntimes:",
    "bedrock-agentcore-control.CreateRegistryRecord:", "secretsmanager.GetSecretValue:",
  ].map((s) => { const [op, match] = s.split(":"); return { op, ...(match ? { match } : {}), error: "AccessDeniedException" }; });
  const r = run([], [...NEGATIVES_DENIED.filter((x) => x.op === "lambda.Invoke" || x.op === "dynamodb.DescribeTable" || x.op === "s3.GetObject"), ...laneDenied]);
  assert.equal(r.status, 1);
  const table = rows(r.stdout);
  assert.ok(table.length >= 25);
  assert.ok(!table.some((t) => t.actual.startsWith("error")), r.stdout);
  for (const t of table.filter((t) => /^Lane(ArtifactRead|ArtifactList|ScratchRows|ScratchEvents|RegistryList|JiraSandboxSecret)$/.test(t.grant))) {
    assert.equal(t.actual, "denied", JSON.stringify(t));
  }
  // ListRegistries is denied → the scratch registry is unresolved, reported, not crashed on.
  assert.ok(table.some((t) => t.actual.startsWith("unresolved")));
  assert.equal(table.find((t) => t.call.includes("GetItem agentcore-hub-workflows")).actual, "ok");
});

test("--cleanup deletes only wf_scratch_* rows and zz-* records proven older than 24h", () => {
  const rules = [
    { op: "dynamodb.Scan", match: "agentcore-hub-workflows", response: { Items: [
      { workflowId: { S: "wf_scratch_fresh" }, scratchAgeHours: 23 },
      { workflowId: { S: "wf_scratch_old" }, scratchAgeHours: 25 },
      { workflowId: { S: "wf_scratch_undated" } },
      { workflowId: { S: "wf-real-run" }, scratchAgeHours: 99 }, // a broken filter must still never widen a delete
    ] } },
    { op: "dynamodb.Scan", match: "agentcore-hub-events", response: { Items: [
      { workflowId: { S: "wf_scratch_old" }, eventId: { S: "preflight" }, scratchAgeHours: 30 },
    ] } },
    { op: "dynamodb.Scan", match: "agentcore-hub-tickets", error: "ResourceNotFoundException" },
    { op: "bedrock-agentcore-control.ListRegistryRecords", response: { registryRecords: [
      { recordId: "recold000001", name: "zz-preflight-1", createdAtAgeHours: 25 },
      { recordId: "recnew000001", name: "zz-preflight-2", createdAtAgeHours: 1 },
      { recordId: "recundated01", name: "zz-preflight-3" },
      { recordId: "recprod00001", name: "billing-agent", createdAtAgeHours: 48 },
    ] } },
  ];
  const r = run(["--cleanup"], rules);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const deleted = r.calls.filter((c) => c.op === "dynamodb.DeleteItem").map((c) => Object.values(c.kw.Key).map((v) => v.S).join("/"));
  assert.deepEqual(deleted.sort(), ["wf_scratch_old", "wf_scratch_old/preflight"].sort());
  const records = r.calls.filter((c) => c.op === "bedrock-agentcore-control.DeleteRegistryRecord").map((c) => c.kw.recordId);
  assert.deepEqual(records, ["recold000001"]);
  for (const c of r.calls.filter((c) => c.op === "bedrock-agentcore-control.DeleteRegistryRecord")) {
    assert.equal(c.kw.registryId, "zzreg000000001");
  }
  assert.match(r.stdout, /wf_scratch_fresh \| 23\.0h \| kept/);
  assert.match(r.stdout, /zz-preflight-2 \| 1\.0h \| kept/);
  // No timestamp → age unknown → kept: only a proven age may delete.
  assert.match(r.stdout, /wf_scratch_undated \| unknown \| kept/);
  assert.match(r.stdout, /zz-preflight-3 \| unknown \| kept/);
  assert.match(r.stdout, /agentcore-hub-tickets \| - \| - \| skipped: table absent/);
  assert.doesNotMatch(r.stdout, /billing-agent|wf-real-run/);
});

test("--cleanup: an absent workflows/events table is a failure, not a silent skip", () => {
  const r = run(["--cleanup"], [{ op: "dynamodb.Scan", match: "agentcore-hub-events", error: "ResourceNotFoundException" }]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /agentcore-hub-events \| - \| - \| scan failed: ResourceNotFoundException/);
});

test("--jira-env prints exactly the four JIRA_SANDBOX_* exports", () => {
  const r = run(["--jira-env"], []);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n"), [
    "export JIRA_SANDBOX_SITE_URL=https://sandbox.example.atlassian.net",
    "export JIRA_SANDBOX_EMAIL=qa@example.com",
    "export JIRA_SANDBOX_API_TOKEN=FAKE-TOKEN-123",
    "export JIRA_SANDBOX_PROJECT_KEY=SBX",
  ]);
  assert.ok(r.calls.every((c) => c.op === "secretsmanager.GetSecretValue"), "jira-env must make no other call");
  assert.equal(r.calls[0].kw.SecretId, "agentcore-hub/live-verify/jira-sandbox-readonly");
});

test("--jira-env on a denied secret fails without a traceback or partial exports", () => {
  const r = run(["--jira-env"], [{ op: "secretsmanager.GetSecretValue", error: "AccessDeniedException" }]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /cannot read agentcore-hub\/live-verify\/jira-sandbox-readonly: AccessDeniedException/);
});
