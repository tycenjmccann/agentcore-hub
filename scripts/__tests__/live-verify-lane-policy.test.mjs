// TEAM-5599 — the HubLiveVerifyLane document on agentcore-hub-coding-runtime-role, pinned.
//
// The role is assumed by the UNTRUSTED coding runtime, so this document is
// asserted statement by statement: exactly these Sids, actions, resources and
// conditions. A widening (a Get* wildcard, BatchWriteItem, a Lambda invoke, the
// cloud-code-sessions table, a second secret) fails here, not in review.
// HERMETIC: PRINT_POLICY builds the JSON offline (AWS_ACCOUNT_ID + an explicit
// LIVE_VERIFY_REGISTRY_ID); a stub `aws` that exits 1 proves the fail-closed path.
//
// Run: `node --test scripts/__tests__/live-verify-lane-policy.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SETUP = join(ROOT, "deploy", "coding-agent-runtime", "setup-coding-runtime-role.sh");
const A = "111111111111";
const R = "us-east-1";
const BUCKET = `agentcore-hub-artifacts-${A}-${R}`;
const REG = "zzreg000000001";
const AC = `arn:aws:bedrock-agentcore:${R}:${A}`;
const DDB = `arn:aws:dynamodb:${R}:${A}:table`;

function print(policy, extra = {}) {
  const bin = mkdtempSync(join(tmpdir(), "lane-bin-"));
  writeFileSync(join(bin, "aws"), "#!/bin/sh\necho \"stub aws must not be needed: $*\" >&2\nexit 1\n");
  chmodSync(join(bin, "aws"), 0o755);
  return spawnSync("bash", [SETUP], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: bin, AWS_ACCOUNT_ID: A, AWS_REGION: R, PRINT_POLICY: policy, ...extra },
  });
}

const EXPECTED = [
  { Sid: "LaneArtifactRead", Effect: "Allow", Action: ["s3:GetObject"], Resource: [`arn:aws:s3:::${BUCKET}/performance/*`] },
  { Sid: "LaneArtifactList", Effect: "Allow", Action: ["s3:ListBucket"], Resource: [`arn:aws:s3:::${BUCKET}`],
    Condition: { StringLike: { "s3:prefix": ["performance/*"] } } },
  { Sid: "LaneScratchRows", Effect: "Allow", Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
    Resource: [`${DDB}/agentcore-hub-workflows`, `${DDB}/agentcore-hub-events`, `${DDB}/agentcore-hub-tickets`],
    Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["wf_scratch_*"] }, Null: { "dynamodb:LeadingKeys": "false" } } },
  { Sid: "LaneScratchEvents", Effect: "Allow", Action: ["events:PutEvents"], Resource: [`arn:aws:events:${R}:${A}:event-bus/default`],
    Condition: { StringLike: { "events:detail-type": "scratch.*" }, StringEquals: { "events:source": "agentcore-hub.live-verify" } } },
  { Sid: "LaneRegistryList", Effect: "Allow",
    Action: ["bedrock-agentcore:ListRegistries", "bedrock-agentcore:ListHarnesses", "bedrock-agentcore:ListAgentRuntimes"], Resource: ["*"] },
  { Sid: "LaneRegistryRead", Effect: "Allow",
    Action: ["bedrock-agentcore:GetRegistry", "bedrock-agentcore:ListRegistryRecords", "bedrock-agentcore:GetRegistryRecord",
      "bedrock-agentcore:GetHarness", "bedrock-agentcore:GetAgentRuntime"],
    Resource: [`${AC}:registry/*`, `${AC}:registry/*/record/*`, `${AC}:harness/*`, `${AC}:runtime/*`] },
  { Sid: "LaneRegistryScratchWrite", Effect: "Allow",
    Action: ["bedrock-agentcore:CreateRegistryRecord", "bedrock-agentcore:DeleteRegistryRecord"],
    Resource: [`${AC}:registry/${REG}`, `${AC}:registry/${REG}/record/*`] },
  { Sid: "LaneJiraSandboxSecret", Effect: "Allow", Action: ["secretsmanager:GetSecretValue"],
    Resource: [`arn:aws:secretsmanager:${R}:${A}:secret:agentcore-hub/live-verify/jira-sandbox-readonly-??????`] },
];

function lane(extra) {
  const r = print("HubLiveVerifyLane", { LIVE_VERIFY_REGISTRY_ID: REG, ...extra });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("HubLiveVerifyLane is exactly the eight reviewed statements", () => {
  const doc = lane();
  assert.equal(doc.Version, "2012-10-17");
  assert.deepEqual(doc.Statement, EXPECTED);
});

test("no wildcard reads, no batch writes, no Lambda invoke, no tenant sessions table", () => {
  const doc = lane();
  const actions = doc.Statement.flatMap((s) => s.Action);
  for (const a of actions) {
    assert.doesNotMatch(a, /\*/, `wildcard action ${a}`);
    assert.doesNotMatch(a, /^lambda:|BatchWriteItem|PutObject|DeleteObject/, `forbidden action ${a}`);
  }
  assert.doesNotMatch(JSON.stringify(doc), /cloud-code-sessions/);
  for (const st of doc.Statement.filter((s) => s.Action.some((a) => /Put|Update|Delete|Create/.test(a)))) {
    for (const res of st.Resource) assert.notEqual(res, "*", `${st.Sid} writes to *`);
  }
});

test("registry writes are scoped to the one scratch registry", () => {
  const st = lane().Statement.find((s) => s.Sid === "LaneRegistryScratchWrite");
  assert.deepEqual(st.Resource, [`${AC}:registry/${REG}`, `${AC}:registry/${REG}/record/*`]);
});

test("the only secret is the sandbox Jira token, never the GitHub App key", () => {
  const doc = lane();
  const secretRes = doc.Statement.filter((s) => s.Action.some((a) => a.startsWith("secretsmanager:"))).flatMap((s) => s.Resource);
  assert.deepEqual(secretRes, [`arn:aws:secretsmanager:${R}:${A}:secret:agentcore-hub/live-verify/jira-sandbox-readonly-??????`]);
  assert.doesNotMatch(JSON.stringify(doc), /github-app/);
});

test("EVENT_BUS is honoured for the scratch events statement", () => {
  const st = lane({ EVENT_BUS: "agentcore-hub" }).Statement.find((s) => s.Sid === "LaneScratchEvents");
  assert.deepEqual(st.Resource, [`arn:aws:events:${R}:${A}:event-bus/agentcore-hub`]);
});

test("fails closed when the scratch registry cannot be resolved", () => {
  const r = print("HubLiveVerifyLane");
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /no LIVE_VERIFY_REGISTRY_ID and no registry named zz-live-verify/);
});

test("HubLiveVerifyRead stays separate and carries no Lane statement", () => {
  const r = print("HubLiveVerifyRead");
  assert.equal(r.status, 0, r.stderr);
  const sids = JSON.parse(r.stdout).Statement.map((s) => s.Sid);
  assert.deepEqual(sids, ["HubTablesReadOnly", "ArtifactBucketReadOnly", "ArtifactBucketList"]);
});
