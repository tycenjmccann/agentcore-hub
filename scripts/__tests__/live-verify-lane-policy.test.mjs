// TEAM-5599 — the HubLiveVerifyLane document, pinned, and pinned to ONE role.
//
// The Lane is attached only to agentcore-hub-coding-pipeline-role (ROLE_VARIANT=pipeline),
// the execution role of the pipeline-only coding runtime. The shared
// agentcore-hub-coding-runtime-role — every Cloud Code user session — must get no new
// statement and no new policy name: a stub `aws` records every call the script makes and
// the shared role's calls are compared, document by document, with main's (sha256).
//
// The document is still asserted statement by statement: exactly these Sids, actions, resources and
// conditions. A widening (a Get* wildcard, BatchWriteItem, a Lambda invoke, the
// cloud-code-sessions table, a second secret) fails here, not in review.
// HERMETIC: PRINT_POLICY builds the JSON offline (AWS_ACCOUNT_ID + an explicit
// LIVE_VERIFY_REGISTRY_ID); a stub `aws` that exits 1 proves the fail-closed path.
// SCOPE: pins the document, not IAM's evaluation of it; that is the post-deploy
// tools/live-verify-preflight.sh capture.
//
// Run: `node --test scripts/__tests__/live-verify-lane-policy.test.mjs`

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// Every aws call the script makes, recorded as argv; nothing reaches AWS. `iam get-role`
// succeeds unless roleExists is false; list-registries answers REG. `sleep` is stubbed.
function record(extra = {}, { roleExists = true } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "role-bin-"));
  const log = join(bin, "calls.jsonl");
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env python3
import json, sys
with open(${JSON.stringify(log)}, "a") as f: f.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1:3] == ["iam", "get-role"]: sys.exit(${roleExists ? 0 : 1})
if sys.argv[1:3] == ["bedrock-agentcore-control", "list-registries"]: print("${REG}")
`);
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "aws"), 0o755);
  chmodSync(join(bin, "sleep"), 0o755);
  const r = spawnSync("bash", [SETUP], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: bin, AWS_ACCOUNT_ID: A, AWS_REGION: R, ...extra },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { ...r, calls };
}
const arg = (call, flag) => (call.includes(flag) ? call[call.indexOf(flag) + 1] : undefined);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const docOf = (c) => arg(c, "--policy-document") ?? arg(c, "--assume-role-policy-document");

// The shared coding role exactly as origin/main leaves it (A/R above, default bucket):
// [subcommand, policy name, sha256(document)]. Regenerate ONLY with a reviewed change
// to that role — never to make a Lane change pass.
const SHARED = "agentcore-hub-coding-runtime-role";
const PIPELINE = "agentcore-hub-coding-pipeline-role";
const MAIN_SHARED_CALLS = [
  ["get-role", undefined, undefined],
  ["update-assume-role-policy", undefined, "bfc3e07081803d4c94bf69268228d279e5381587165c1a06d858b5b450e1b434"],
  ["put-role-policy", "Observability", "08121bea0ba1a441992614db07469b781c62202cc391e109f6e33aa96adb2d86"],
  ["put-role-policy", "BedrockInvoke", "9d5c5d44de298a780342b64c03f9d6d6f02fada2c427f30dead52f3f9e25b2a2"],
  ["put-role-policy", "ECRPullAccess", "de8ac9fecdc79e074488a7d3d422f2b7ef18870a6872a57cb61f3e4aca832269"],
  ["put-role-policy", "ConfigBundleRead", "fb8e65109db72f323def0c15068277c6dfb9b9cef4dcb114c26b57b9882fb49d"],
  ["put-role-policy", "HubLiveVerifyRead", "eebdd477a0f94b600ef3035c656583b81187c68e20336c6dbf9a68fc7eab0430"],
  ["put-role-policy", "EFSMount", "5c214aa68e7b4679634a4b63a26bcde9d8bf38aa41f7a1a96ff50cefc0d3417d"],
];
const LANE_SIDS = /LaneArtifactRead|LaneArtifactList|LaneScratchRows|LaneScratchEvents|LaneRegistryList|LaneRegistryRead|LaneRegistryScratchWrite|LaneJiraSandboxSecret/;

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
  const r = print("HubLiveVerifyLane", { LIVE_VERIFY_REGISTRY_ID: REG, ROLE_VARIANT: "pipeline", ...extra });
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
  const r = print("HubLiveVerifyLane", { ROLE_VARIANT: "pipeline" });
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

test("the shared coding role gets no new statement and no new policy name (calls == main)", () => {
  // LIVE_VERIFY_REGISTRY_ID set: even with the registry resolvable, the shared role gets no Lane.
  const r = record({ LIVE_VERIFY_REGISTRY_ID: REG });
  assert.equal(r.status, 0, r.stderr);
  for (const c of r.calls) assert.equal(arg(c, "--role-name"), SHARED, JSON.stringify(c).slice(0, 200));
  assert.deepEqual(r.calls.map((c) => [c[1], arg(c, "--policy-name"), docOf(c) && sha(docOf(c))]), MAIN_SHARED_CALLS);
  for (const c of r.calls) {
    assert.doesNotMatch(docOf(c) ?? "", LANE_SIDS);
    assert.doesNotMatch(docOf(c) ?? "", /secretsmanager|jira-sandbox/);
  }
  assert.ok(!r.calls.some((c) => /delete-role-policy|attach-role-policy|list-registries/.test(c[1] ?? c[0])));
});

test("first-time create of the shared role is unchanged too", () => {
  const r = record({}, { roleExists: false });
  assert.equal(r.status, 0, r.stderr);
  const create = r.calls.find((c) => c[1] === "create-role");
  assert.equal(arg(create, "--role-name"), SHARED);
  assert.equal(arg(create, "--description"), "Execution role for the AgentCore Hub multi-CLI coding runtime");
  assert.equal(sha(arg(create, "--assume-role-policy-document")), MAIN_SHARED_CALLS[1][2]);
  assert.deepEqual(r.calls.filter((c) => c[1] === "put-role-policy").map((c) => arg(c, "--policy-name")),
    MAIN_SHARED_CALLS.slice(2).map((x) => x[1]));
});

test("the Lane is refused without ROLE_VARIANT=pipeline, before any aws call", () => {
  for (const mode of [{ PRINT_POLICY: "HubLiveVerifyLane" }, { ONLY_POLICY: "HubLiveVerifyLane" }]) {
    const r = record({ ...mode, LIVE_VERIFY_REGISTRY_ID: REG });
    assert.equal(r.status, 2, JSON.stringify(mode));
    assert.deepEqual(r.calls, [], JSON.stringify(mode));
    assert.match(r.stderr, /attached only to agentcore-hub-coding-pipeline-role/);
  }
  // ONLY_POLICY=HubLiveVerifyRead (si-ledger-handoff) still targets the shared role, same document.
  const r = record({ ONLY_POLICY: "HubLiveVerifyRead" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => [arg(c, "--role-name"), arg(c, "--policy-name"), sha(docOf(c))]),
    [[SHARED, "HubLiveVerifyRead", MAIN_SHARED_CALLS[6][2]]]);
});

test("ROLE_VARIANT=pipeline: only the pipeline role is written, with Lane + Read, no cloud-code read, no EFS", () => {
  const r = record({ ROLE_VARIANT: "pipeline", LIVE_VERIFY_REGISTRY_ID: REG });
  assert.equal(r.status, 0, r.stderr);
  const iam = r.calls.filter((c) => c[0] === "iam");
  for (const c of iam) assert.equal(arg(c, "--role-name"), PIPELINE);
  const puts = Object.fromEntries(iam.filter((c) => c[1] === "put-role-policy").map((c) => [arg(c, "--policy-name"), JSON.parse(docOf(c))]));
  assert.deepEqual(Object.keys(puts), ["Observability", "BedrockInvoke", "ECRPullAccess", "ConfigBundleRead", "HubLiveVerifyRead", "HubLiveVerifyLane"]);
  assert.deepEqual(puts.HubLiveVerifyLane.Statement, EXPECTED);
  const read = iam.find((c) => arg(c, "--policy-name") === "HubLiveVerifyRead");
  assert.equal(sha(docOf(read)), MAIN_SHARED_CALLS[6][2], "HubLiveVerifyRead must be byte-identical");
  const all = JSON.stringify(puts);
  assert.doesNotMatch(all, /elasticfilesystem:/);
  const gets = Object.values(puts).flatMap((d) => d.Statement).filter((st) => [].concat(st.Action).includes("s3:GetObject")).flatMap((st) => st.Resource);
  for (const res of gets) assert.doesNotMatch(res, /\/cloud-code\//, res);
  const trust = JSON.parse(arg(iam.find((c) => c[1] === "update-assume-role-policy"), "--policy-document"));
  assert.deepEqual(trust.Statement[0].Principal, { Service: "bedrock-agentcore.amazonaws.com" });
  assert.deepEqual(trust.Statement[0].Condition, {
    StringEquals: { "aws:SourceAccount": A },
    ArnLike: { "aws:SourceArn": `${AC}:runtime/agentcore_hub_coding_runtime_pipeline-*` },
  });
  assert.match(r.stdout, /CODING_INSTANCES_ROLE_ARN=arn:aws:iam::111111111111:role\/agentcore-hub-coding-pipeline-role/);
});

test("ROLE_VARIANT=pipeline fails closed before any IAM call when the scratch registry is missing", () => {
  const bin = mkdtempSync(join(tmpdir(), "role-bin-"));
  writeFileSync(join(bin, "aws"), "#!/bin/sh\necho \"$*\" >> \"$0.log\"\n[ \"$1 $2\" = \"bedrock-agentcore-control list-registries\" ] && echo None\nexit 0\n");
  chmodSync(join(bin, "aws"), 0o755);
  const r = spawnSync("bash", [SETUP], { encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: bin, AWS_ACCOUNT_ID: A, AWS_REGION: R, ROLE_VARIANT: "pipeline" } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /create the zz-live-verify registry first/);
  assert.doesNotMatch(readFileSync(join(bin, "aws.log"), "utf8"), /^iam /m);
});

test("an unknown ROLE_VARIANT is refused", () => {
  const r = record({ ROLE_VARIANT: "admin" });
  assert.equal(r.status, 2);
  assert.deepEqual(r.calls, []);
});

// ── The reserved tenant: no outside identity resolves into `hub-pipeline` ───
// The fleet stamps the pipeline's coding-session rows CLOUD_CODE_TENANT_ID=hub-pipeline,
// and the hub's session routes check tenant equality only — so the identity resolver
// (src/lib/auth/resolver.ts, the one place middleware gets an adapter from) must refuse
// that tenant on every adapter path. Driven end to end: the REAL cloudflare-access
// adapter verifies a real RS256 JWT against a local JWKS server (jiti loads the TS).

import { createServer } from "node:http";
import { createRequire } from "node:module";

const requireRoot = createRequire(join(ROOT, "package.json"));

async function withAccess(fn) {
  const jose = requireRoot("jose");
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const team = `http://127.0.0.1:${server.address().port}`;
  const saved = { ...process.env };
  Object.assign(process.env, {
    AUTH_MODE: "cloudflare-access",
    CF_ACCESS_TEAM_DOMAIN: team,
    CF_ACCESS_AUD: "aud-test",
    CF_ACCESS_SERVICE_TENANTS: "ci-bot=acme.com,rogue-bot=hub-pipeline,shout-bot= HUB-PIPELINE ",
  });
  const jiti = requireRoot("jiti")(join(ROOT, "src", "lib", "auth", "resolver.ts"), { interopDefault: true });
  const { activeResolver, isReservedTenant } = jiti(join(ROOT, "src", "lib", "auth", "resolver.ts"));
  const sign = (claims) =>
    new jose.SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(team).setAudience("aud-test").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const resolveWith = async (claims) => {
    const token = await sign(claims);
    return activeResolver().resolve({ headers: new Headers({ "cf-access-jwt-assertion": token }) });
  };
  try {
    await fn({ resolveWith, isReservedTenant });
  } finally {
    server.close();
    process.env = saved;
  }
}

test("reserved tenant: every cloudflare-access tenant path refuses hub-pipeline, others resolve", async () => {
  await withAccess(async ({ resolveWith, isReservedTenant }) => {
    // Path 1 — explicit custom:tenantId claim.
    assert.equal(await resolveWith({ email: "a@acme.com", "custom:tenantId": "hub-pipeline" }), null);
    assert.equal(await resolveWith({ email: "a@acme.com", "custom:tenantId": " Hub-Pipeline" }), null);
    assert.equal((await resolveWith({ email: "a@acme.com", "custom:tenantId": "acme" })).tenantId, "acme");
    // Path 2 — email domain.
    assert.equal(await resolveWith({ email: "a@hub-pipeline" }), null);
    assert.equal((await resolveWith({ email: "a@acme.com" })).tenantId, "acme.com");
    // Path 3 — sub fallback (no email).
    assert.equal(await resolveWith({ sub: "hub-pipeline" }), null);
    assert.equal((await resolveWith({ sub: "u-123" })).tenantId, "u-123");
    // Path 4 — service token mapped by CF_ACCESS_SERVICE_TENANTS.
    assert.equal(await resolveWith({ common_name: "rogue-bot" }), null);
    assert.equal(await resolveWith({ common_name: "shout-bot" }), null);
    const svc = await resolveWith({ common_name: "ci-bot" });
    assert.deepEqual([svc.userId, svc.tenantId], ["svc:ci-bot", "acme.com"]);
    // The predicate itself.
    assert.equal(isReservedTenant("hub-pipeline"), true);
    assert.equal(isReservedTenant("default"), false);
  });
});

test("reserved tenant: AUTH_MODE=none stamps 'default' (never reserved); middleware has one resolver source", () => {
  const mw = readFileSync(join(ROOT, "src", "middleware.ts"), "utf8");
  assert.match(mw, /import \{ activeResolver \} from "@\/lib\/auth\/resolver"/);
  assert.match(mw, /headers\.set\(TENANT_HEADER, DEFAULT_TENANT_ID\)/);
  const id = readFileSync(join(ROOT, "src", "lib", "auth", "identity.ts"), "utf8");
  assert.match(id, /export const DEFAULT_TENANT_ID = "default";/);
  // Every adapter the registry returns is wrapped.
  const rs = readFileSync(join(ROOT, "src", "lib", "auth", "resolver.ts"), "utf8");
  const returns = [...rs.matchAll(/return (\w+(?:\(\w+\))?);/g)].map((m) => m[1]).filter((r) => r !== "null" && r !== "identity");
  assert.deepEqual(returns, ["withReservedTenantsRejected(cloudflareAccessResolver)"]);
});
