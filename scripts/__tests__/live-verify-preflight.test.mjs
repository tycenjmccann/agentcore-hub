// TEAM-5599 — tools/live-verify-preflight.sh, pinned.
//
// HERMETIC: a fake boto3 (fixtures/fake-boto3) is prepended to PYTHONPATH, so the
// script's SDK calls are scripted per test and logged; nothing reaches AWS. Each
// test states one acceptance criterion:
//   - all grants ok + negatives denied → exit 0, a lint-clean record table;
//   - a negative that is wrongly ALLOWED → exit 1, MISMATCH, nothing left behind;
//   - today's baseline (Lane not applied) → exit 1, rows read `denied`, not errors;
//   - --cleanup deletes only wf_scratch_* rows / zz-* records older than 24h;
//   - --jira-env prints the four exports; no other path prints the token.
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
  { op: "events.PutEvents", match: "workflow\\.preflight",
    response: { FailedEntryCount: 1, Entries: [{ ErrorCode: "NotAuthorizedForDetailTypeException" }] } },
  { op: "bedrock-agentcore-control.CreateRegistryRecord", match: "zzpreflightnoexist", error: "AccessDeniedException" },
  { op: "secretsmanager.GetSecretValue", match: "cloud-code/github-app", error: "AccessDeniedException" },
  { op: "dynamodb.DescribeTable", match: "cloud-code-sessions", error: "AccessDeniedException" },
  { op: "s3.GetObject", match: "config/cd-registry\\.json", error: "AccessDenied" },
  { op: "lambda.Invoke", error: "AccessDeniedException" },
];

function run(args, rules) {
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

test("a wrongly ALLOWED negative is a MISMATCH and exits 1, and mutates nothing it keeps", () => {
  const rules = NEGATIVES_DENIED.filter((x) => !/zz_not_scratch_|zzpreflightnoexist/.test(x.match || ""));
  // A correct IAM deny comes before the service's existence check; a missing-registry error means IAM allowed it.
  rules.unshift({ op: "bedrock-agentcore-control.CreateRegistryRecord", match: "zzpreflightnoexist", error: "ResourceNotFoundException" });
  const r = run([], rules);
  assert.equal(r.status, 1, r.stdout);
  const bad = rows(r.stdout).filter((t) => t.verdict === "MISMATCH");
  assert.deepEqual(bad.map((t) => t.call).sort(), [
    "agentcore CreateRegistryRecord outside the scratch registry",
    `ddb PutItem agentcore-hub-workflows ${bad.find((t) => t.call.includes("zz_not_scratch_")).call.split(" ").pop()}`,
  ].sort());
  // The non-scratch put was conditional (never overwrites) and is cleaned up.
  const put = r.calls.find((c) => c.op === "dynamodb.PutItem" && JSON.stringify(c.kw).includes("zz_not_scratch_"));
  assert.equal(put.kw.ConditionExpression, "attribute_not_exists(workflowId)");
  assert.ok(r.calls.some((c) => c.op === "dynamodb.DeleteItem" && JSON.stringify(c.kw).includes("zz_not_scratch_")));
  // The out-of-scratch create targeted a registry id that does not exist.
  const create = r.calls.filter((c) => c.op === "bedrock-agentcore-control.CreateRegistryRecord").map((c) => c.kw.registryId);
  assert.ok(create.includes("zzpreflightnoexist"));
  assert.match(r.stdout, /## Open items[\s\S]*expected denied, got ok/);
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
  assert.ok(!table.some((t) => t.actual === "error"), r.stdout);
  for (const t of table.filter((t) => /^Lane(ArtifactRead|ArtifactList|ScratchRows|ScratchEvents|RegistryList|JiraSandboxSecret)$/.test(t.grant))) {
    assert.equal(t.actual, "denied", JSON.stringify(t));
  }
  // ListRegistries is denied → the scratch registry is unresolved, reported, not crashed on.
  assert.ok(table.some((t) => t.actual.startsWith("unresolved")));
  assert.equal(table.find((t) => t.call.includes("GetItem agentcore-hub-workflows")).actual, "ok");
});

test("--cleanup deletes only wf_scratch_* rows and zz-* records older than 24h", () => {
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
      { recordId: "recprod00001", name: "billing-agent", createdAtAgeHours: 48 },
    ] } },
  ];
  const r = run(["--cleanup"], rules);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const deleted = r.calls.filter((c) => c.op === "dynamodb.DeleteItem").map((c) => Object.values(c.kw.Key).map((v) => v.S).join("/"));
  assert.deepEqual(deleted.sort(), ["wf_scratch_old", "wf_scratch_old/preflight", "wf_scratch_undated"].sort());
  const records = r.calls.filter((c) => c.op === "bedrock-agentcore-control.DeleteRegistryRecord").map((c) => c.kw.recordId);
  assert.deepEqual(records, ["recold000001"]);
  for (const c of r.calls.filter((c) => c.op === "bedrock-agentcore-control.DeleteRegistryRecord")) {
    assert.equal(c.kw.registryId, "zzreg000000001");
  }
  assert.match(r.stdout, /wf_scratch_fresh \| 23\.0h \| kept/);
  assert.match(r.stdout, /zz-preflight-2 \| 1\.0h \| kept/);
  assert.doesNotMatch(r.stdout, /billing-agent|wf-real-run/);
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
