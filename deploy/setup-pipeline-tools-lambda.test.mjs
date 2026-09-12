/**
 * TEAM-4122 FR-4 — the pipeline-tools Lambda's IAM policy, as data.
 *
 * PIPELINE_CI_START_BUILD is the only thing in this repo that gives an AGENT a
 * write action on CodeBuild, so the blast radius has to be assertable rather than
 * reviewable-by-reading: this drives the pure `buildInlinePolicy(env)` and pins
 *   - the CiStartBuild statement appears ONLY with the flag on,
 *   - its Resource is exactly the ONE PR-check project ARN (never the build,
 *     deploy or runtime-image project, never a wildcard),
 *   - codepipeline:PutApprovalResult is absent either way — the deploy gate stays
 *     human (the whole reason this Lambda exists in its current shape), and
 *   - a CI_PROJECT that names a deploy project (or a wildcard) THROWS instead of
 *     widening the grant.
 *
 * It also pins the byte-duplicated validateCiProjectName against the Lambda's
 * exported copy on a shared matrix. The duplication is deliberate (the Lambda zip
 * is index.mjs only, and importing the Lambda here would construct AWS clients),
 * so the only defence against drift is this test.
 *
 * Importing the deploy script must NOT deploy: main() is behind an
 * import.meta.url/process.argv[1] check, which the last test asserts by importing
 * it with no AWS credentials and observing that no client was ever used.
 *
 * TEAM-4337 widens the grant ONCE by naming convention (hub-<slug>-{ci,build,
 * deploy}) so registering a repo in the CD registry needs no IAM edit. That makes
 * the wildcard SHAPE the thing to pin: every action class gets the narrowest
 * suffix it needs, and codebuild:StartBuild gets project/hub-*-ci and nothing
 * else. The suite therefore asserts what the wildcards ARE, per PIPELINE_REGIONS
 * region, and — more importantly — what they can never be.
 *
 * TEAM-4525 adds the FIRST S3 write this role has ever had: ShipApprovalRecordWrite,
 * s3:PutObject on pipeline-artifacts/ship-approvals/* so start_deploy can record the
 * head SHA a human already approved and let the pipeline skip asking that same human
 * twice. A write grant on the artifact bucket is exactly the kind of statement that
 * quietly becomes a prefix wider than intended, so it is pinned as data too: one
 * action, one prefix, additive to everything else, and still no approval action
 * anywhere in the document.
 */
import { describe, it, expect, vi } from "vitest";

import { readFileSync } from "node:fs";

import {
  buildInlinePolicy,
  parsePipelineRegions,
  resolveEnv,
  validateCiProjectName as validateInDeployScript,
} from "./setup-pipeline-tools-lambda.mjs";

// The Lambda constructs three AWS SDK clients at module load; mock the seams so
// importing it here stays offline (same shape as the Lambda's own test file).
vi.mock("@aws-sdk/client-codepipeline", () => ({
  CodePipelineClient: class { async send() { return {}; } },
  GetPipelineStateCommand: class {},
  StartPipelineExecutionCommand: class {},
  ListActionExecutionsCommand: class {},
}));
vi.mock("@aws-sdk/client-codebuild", () => ({
  CodeBuildClient: class { async send() { return {}; } },
  BatchGetBuildsCommand: class {},
  ListBuildsForProjectCommand: class {},
  StartBuildCommand: class {},
}));
vi.mock("@aws-sdk/client-cloudwatch-logs", () => ({
  CloudWatchLogsClient: class { async send() { return {}; } },
  GetLogEventsCommand: class {},
}));

const { validateCiProjectName: validateInLambda } = await import(
  "../lambda/agentcore-hub-pipeline-tools/index.mjs"
);

const REGION = "us-east-1";
const ACCOUNT = "111122223333";
const BASE = {
  REGION,
  ACCOUNT,
  PIPELINE_NAME: "agentcore-hub-deploy",
  BUILD_PROJECT: "agentcore-hub-build",
  CI_PROJECT: "agentcore-hub-ci",
  DEPLOY_PROJECT: "agentcore-hub-deploy",
  PIPELINE_CI_START_BUILD: "0",
};

const arn = (project, region = REGION) =>
  `arn:aws:codebuild:${region}:${ACCOUNT}:project/${project}`;
const sid = (policy, name) => policy.Statement.find((s) => s.Sid === name);
const allActions = (policy) => policy.Statement.flatMap((s) => [].concat(s.Action));
const allResources = (policy) => policy.Statement.flatMap((s) => [].concat(s.Resource));
/** Every statement granting `action`, whatever its Sid. */
const statementsWith = (policy, action) =>
  policy.Statement.filter((s) => [].concat(s.Action).includes(action));
const SOURCE = readFileSync(
  new URL("./setup-pipeline-tools-lambda.mjs", import.meta.url),
  "utf8"
);

describe("buildInlinePolicy — the CiStartBuild grant", () => {
  it("is ABSENT with the flag off (today's policy, unchanged)", () => {
    const policy = buildInlinePolicy(BASE);

    expect(sid(policy, "CiStartBuild")).toBeUndefined();
    expect(allActions(policy)).not.toContain("codebuild:StartBuild");
    // The statements that were there before FR-4, in order, plus the two
    // read-only S3 grants (handoff markers, CD registry).
    expect(policy.Statement.map((s) => s.Sid)).toEqual([
      "Logs",
      "PipelineReadAndTrigger",
      "BuildRead",
      "HandoffMarkerRead",
      "CdRegistryRead",
      "ShipApprovalRecordWrite",
      "BuildLogRead",
      "CrossAccountAssumeTrigger",
    ]);
  });

  it("is PRESENT with the flag on, immediately after BuildRead", () => {
    const policy = buildInlinePolicy({ ...BASE, PIPELINE_CI_START_BUILD: "1" });

    expect(policy.Statement.map((s) => s.Sid)).toEqual([
      "Logs",
      "PipelineReadAndTrigger",
      "BuildRead",
      "CiStartBuild",
      "HandoffMarkerRead",
      "CdRegistryRead",
      "ShipApprovalRecordWrite",
      "BuildLogRead",
      "CrossAccountAssumeTrigger",
    ]);
    expect(sid(policy, "CiStartBuild")).toEqual({
      Sid: "CiStartBuild",
      Effect: "Allow",
      Action: ["codebuild:StartBuild"],
      // The hub's exact PR-check project + the ONE wildcard a StartBuild grant
      // may ever carry (TEAM-4337).
      Resource: [arn("agentcore-hub-ci"), arn("hub-*-ci")],
    });
  });

  it("grants StartBuild on CI project ARNs and NOTHING else", () => {
    const policy = buildInlinePolicy({ ...BASE, PIPELINE_CI_START_BUILD: "1" });
    const statement = sid(policy, "CiStartBuild");

    expect(statement.Resource).toEqual([arn("agentcore-hub-ci"), arn("hub-*-ci")]);
    expect(statement.Resource).not.toContain(arn("agentcore-hub-deploy"));
    expect(statement.Resource).not.toContain(arn("agentcore-hub-build"));
    expect(statement.Resource).not.toContain(arn("agentcore-hub-runtime-image-deploy"));
    // Every wildcard in this statement is suffix-scoped to a CI project. A bare
    // project/hub-* here would grant StartBuild on hub-<slug>-deploy.
    for (const resource of statement.Resource.filter((r) => r.includes("*"))) {
      expect(resource).toMatch(/project\/hub-\*-ci$/);
    }
    // The ONLY StartBuild in the whole document.
    expect(allActions(policy).filter((a) => a === "codebuild:StartBuild")).toHaveLength(1);
  });

  it("honours a non-default CI_PROJECT in the grant ARN", () => {
    const policy = buildInlinePolicy({
      ...BASE,
      CI_PROJECT: "other-repo-ci",
      PIPELINE_CI_START_BUILD: "1",
    });

    expect(sid(policy, "CiStartBuild").Resource).toEqual([
      arn("other-repo-ci"),
      arn("hub-*-ci"),
    ]);
  });

  it("treats anything but the exact string \"1\" as off", () => {
    for (const value of [undefined, "", "0", "true", "yes", "TRUE", 1]) {
      const policy = buildInlinePolicy({ ...BASE, PIPELINE_CI_START_BUILD: value });
      expect(sid(policy, "CiStartBuild"), String(value)).toBeUndefined();
    }
  });

  it("never contains codepipeline:PutApprovalResult — flag on or off", () => {
    for (const flag of ["0", "1"]) {
      const actions = allActions(buildInlinePolicy({ ...BASE, PIPELINE_CI_START_BUILD: flag }));
      expect(actions, flag).not.toContain("codepipeline:PutApprovalResult");
      // Nor any other approval/write verb sneaking in via a prefix.
      expect(actions.filter((a) => /Approval/i.test(a)), flag).toEqual([]);
      expect(actions.filter((a) => a.startsWith("codepipeline:")).sort(), flag).toEqual([
        "codepipeline:GetPipelineExecution",
        "codepipeline:GetPipelineState",
        "codepipeline:ListActionExecutions",
        "codepipeline:StartPipelineExecution",
      ]);
    }
  });

  it("derives every ARN from REGION/ACCOUNT — no hardcoded account id", () => {
    const policy = buildInlinePolicy({ ...BASE, REGION: "eu-west-2", ACCOUNT: "999988887777", PIPELINE_CI_START_BUILD: "1" });
    for (const resource of allResources(policy)) {
      if (resource === "*") continue;
      // The cross-account trigger-role ARN is a DELIBERATE wildcard on both
      // account and region: the tools Lambda assumes hub-cd-trigger-* in
      // whatever account a registry entry names, so it can carry neither this
      // account nor this region (parseCdRegistry is the real allow-list).
      if (/^arn:aws:iam::\*:role\/hub-cd-trigger-\*$/.test(resource)) continue;
      // S3 ARNs carry neither region nor account as ARN fields — the bucket NAME
      // carries both under the deploy/config.sh convention.
      if (resource.startsWith("arn:aws:s3:::")) {
        expect(resource).toContain("-999988887777-eu-west-2/");
        expect(resource).not.toContain(ACCOUNT);
        continue;
      }
      expect(resource).toContain(":eu-west-2:");
      expect(resource).toContain(":999988887777:");
      expect(resource).not.toContain(ACCOUNT);
    }
  });

  it("THROWS (before any AWS call) when the flag is on and CI_PROJECT names a deploy", () => {
    for (const bad of [
      "agentcore-hub-deploy",
      "agentcore-hub-build",
      "agentcore-hub-runtime-image-deploy",
      "*",
      "agentcore-hub-*",
      "",
    ]) {
      expect(
        () => buildInlinePolicy({ ...BASE, CI_PROJECT: bad, PIPELINE_CI_START_BUILD: "1" }),
        bad
      ).toThrow(/PIPELINE_CI_START_BUILD=1 refused/);
    }
  });

  it("does NOT throw for the same bad CI_PROJECT when the flag is off", () => {
    // Nothing is granted, so a wrong CI_PROJECT only affects the read-only
    // BuildRead/BuildLogRead scoping it already affected before FR-4.
    expect(() =>
      buildInlinePolicy({ ...BASE, CI_PROJECT: "agentcore-hub-deploy", PIPELINE_CI_START_BUILD: "0" })
    ).not.toThrow();
  });
});

describe("resolveEnv", () => {
  it("defaults to the prod convention and normalizes the flag to 1|0", () => {
    expect(resolveEnv({})).toEqual({
      REGION: "us-east-1",
      PIPELINE_NAME: "agentcore-hub-deploy",
      BUILD_PROJECT: "agentcore-hub-build",
      CI_PROJECT: "agentcore-hub-ci",
      DEPLOY_PROJECT: "agentcore-hub-deploy",
      PIPELINE_CI_START_BUILD: "0",
      // Just the Lambda's own region until an operator registers a repo elsewhere.
      PIPELINE_REGIONS: "us-east-1",
      // Derived from ACCOUNT at deploy time when unset (deploy/config.sh convention).
      ARTIFACT_BUCKET: "",
      // TEAM-4525: optional. Empty means no ship-approval record can ever be
      // written, so every deploy keeps its human gate.
      GITHUB_TOKEN: "",
    });
    expect(resolveEnv({ PIPELINE_CI_START_BUILD: "1" }).PIPELINE_CI_START_BUILD).toBe("1");
    expect(resolveEnv({ PIPELINE_CI_START_BUILD: "true" }).PIPELINE_CI_START_BUILD).toBe("0");
  });

  it("passes a GITHUB_TOKEN through when the operator set one", () => {
    // It is the ONLY way the merge binding can be machine-verified; without it
    // recordShipApproval refuses with merge_binding_unverified (TEAM-4525 review P1).
    expect(resolveEnv({ GITHUB_TOKEN: "ghp-abc" }).GITHUB_TOKEN).toBe("ghp-abc");
  });
});

describe("validateCiProjectName — the two copies agree", () => {
  // One matrix, both implementations. A divergence here means the Lambda would
  // refuse a project the deploy granted (or, worse, the reverse).
  const OPTS = {
    buildProject: "agentcore-hub-build",
    deployProject: "agentcore-hub-deploy",
    pipelineName: "agentcore-hub-deploy",
  };
  const MATRIX = [
    ["agentcore-hub-ci", true],
    ["other-repo-ci", true],
    ["ci_2", true],
    ["A".repeat(255), true],
    ["A".repeat(256), false],   // > 255 chars
    ["a", false],               // < 2 chars
    ["", false],
    ["*", false],
    ["agentcore-hub-*", false],
    ["agentcore-hub-c?", false],
    ["-agentcore-hub-ci", false], // must start alphanumeric
    ["_ci", false],
    ["agentcore hub ci", false],  // space
    ["agentcore.hub.ci", false],  // dot is not a CodeBuild project char
    ["agentcore/hub/ci", false],
    ["agentcore-hub-build", false],
    ["agentcore-hub-deploy", false],
    ["agentcore-hub-runtime-image-deploy", false],
    [null, false],
    [undefined, false],
    [7, false],
    [{}, false],
  ];

  it.each(MATRIX)("%s → ok:%s in BOTH copies", (name, ok) => {
    const inLambda = validateInLambda(name, OPTS);
    const inScript = validateInDeployScript(name, OPTS);

    expect(inLambda.ok, `lambda: ${String(name)}`).toBe(ok);
    expect(inScript.ok, `script: ${String(name)}`).toBe(ok);
    // Same verdict AND same explanation — the reason is what the operator and the
    // agent both read.
    expect(inScript).toEqual(inLambda);
  });

  it("agrees when the collision names come from a different deployment", () => {
    const opts = {
      buildProject: "other-build",
      deployProject: "other-deploy",
      pipelineName: "other-pipeline",
    };
    for (const name of ["other-deploy", "other-build", "other-pipeline", "agentcore-hub-deploy", "fine-ci"]) {
      expect(validateInDeployScript(name, opts)).toEqual(validateInLambda(name, opts));
    }
  });

  it("refuses the reserved runtime-image deploy project even when it is nobody's configured project", () => {
    // It is a real deploying project that neither DEPLOY_PROJECT nor
    // PIPELINE_NAME would ever name, so the allow-list has to know it by name.
    for (const check of [validateInLambda, validateInDeployScript]) {
      expect(check("agentcore-hub-runtime-image-deploy", {}).ok).toBe(false);
    }
  });
});

describe("importing the deploy script is inert", () => {
  it("did not deploy anything (main() is behind the argv guard)", async () => {
    // This module was imported at the top of this file with no AWS_PROFILE and no
    // credentials; if main() had run, the STS GetCallerIdentity would have thrown
    // and this file would never have loaded. Re-import to make that explicit.
    const mod = await import("./setup-pipeline-tools-lambda.mjs");
    expect(typeof mod.buildInlinePolicy).toBe("function");
    expect(mod.main).toBeUndefined(); // not exported — nothing can call it by hand
  });
});

describe("buildInlinePolicy — the handoff-marker read", () => {
  it("is scoped to ONE prefix of the artifact bucket", () => {
    const statement = sid(buildInlinePolicy(BASE), "HandoffMarkerRead");
    expect(statement.Action).toEqual(["s3:GetObject"]);
    expect(statement.Resource).toEqual([
      `arn:aws:s3:::agentcore-hub-artifacts-${ACCOUNT}-us-east-1/pipeline-artifacts/handoff/*`,
    ]);
    // Never the roster, blueprints, rollback snapshots or deploy baselines.
    for (const forbidden of ["config/", "blueprints/", "orchestrator-current", "last-deployed"]) {
      expect(statement.Resource[0]).not.toContain(forbidden);
    }
  });

  it("grants exactly two S3 reads and ONE S3 write, in that order", () => {
    const policy = buildInlinePolicy({ ...BASE, PIPELINE_CI_START_BUILD: "1" });
    // Two reads since TEAM-4337 (handoff markers, CD registry) and, since
    // TEAM-4525, exactly ONE write (the ship-approval record). Listed rather than
    // deduped so a fourth S3 grant cannot appear unnoticed.
    expect(allActions(policy).filter((a) => a.startsWith("s3:"))).toEqual([
      "s3:GetObject",
      "s3:GetObject",
      "s3:PutObject",
    ]);
    // The write is on ONE prefix, and it is not the prefix either read covers.
    const writes = statementsWith(policy, "s3:PutObject");
    expect(writes).toHaveLength(1);
    expect(writes[0].Sid).toBe("ShipApprovalRecordWrite");
    // Nothing that could delete, list or read the bucket rides along.
    for (const forbidden of [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:PutObjectAcl",
      "s3:*",
    ]) {
      expect(writes[0].Action).not.toContain(forbidden);
    }
  });

  it("honours an explicit ARTIFACT_BUCKET and is omitted when there is none", () => {
    expect(
      sid(buildInlinePolicy({ ...BASE, ARTIFACT_BUCKET: "explicit-bucket" }), "HandoffMarkerRead")
        .Resource
    ).toEqual(["arn:aws:s3:::explicit-bucket/pipeline-artifacts/handoff/*"]);
    expect(
      sid(buildInlinePolicy({ ...BASE, ACCOUNT: undefined }), "HandoffMarkerRead")
    ).toBeUndefined();
  });
});

// ─── TEAM-4525: the ship-approval record write ────────────────────────────────
//
// start_deploy writes the head SHA a human already approved at Merge Approval,
// keyed on the merge commit, so the pipeline can skip re-asking that same human
// for byte-identical code. This is the FIRST write on S3 this role has ever had,
// so its blast radius is the thing to pin: one action, one prefix, and no
// approval action anywhere near it.

describe("buildInlinePolicy — the ship-approval record write", () => {
  it("is exactly s3:PutObject on exactly the ship-approvals prefix", () => {
    const statement = sid(buildInlinePolicy(BASE), "ShipApprovalRecordWrite");
    expect(statement).toEqual({
      Sid: "ShipApprovalRecordWrite",
      Effect: "Allow",
      Action: ["s3:PutObject"],
      Resource: [
        `arn:aws:s3:::agentcore-hub-artifacts-${ACCOUNT}-us-east-1/pipeline-artifacts/ship-approvals/*`,
      ],
    });
  });

  it("cannot reach the handoff markers, the registry, the roster or the bucket root", () => {
    const resource = sid(buildInlinePolicy(BASE), "ShipApprovalRecordWrite").Resource[0];
    for (const forbidden of [
      "pipeline-artifacts/handoff/",
      "config/",
      "cd-registry.json",
      "agents.json",
      "blueprints/",
      "last-deployed",
    ]) {
      expect(resource).not.toContain(forbidden);
    }
    // Exactly one wildcard, at the END of the one prefix — never the bucket.
    expect(resource).toMatch(
      /^arn:aws:s3:::[a-z0-9.-]+\/pipeline-artifacts\/ship-approvals\/\*$/
    );
  });

  it("honours an explicit ARTIFACT_BUCKET and vanishes without one", () => {
    expect(
      sid(
        buildInlinePolicy({ ...BASE, ARTIFACT_BUCKET: "explicit-bucket" }),
        "ShipApprovalRecordWrite"
      ).Resource
    ).toEqual(["arn:aws:s3:::explicit-bucket/pipeline-artifacts/ship-approvals/*"]);
    // No bucket → no grant at all, same as the two read statements. The Lambda
    // then reports preapproval.recorded:false and the human gate fires.
    expect(
      sid(buildInlinePolicy({ ...BASE, ACCOUNT: undefined }), "ShipApprovalRecordWrite")
    ).toBeUndefined();
  });

  it("widens nothing else: every other statement is byte-identical with it present", () => {
    // The record write is additive. Written as a diff of the whole document so a
    // future edit that also loosens BuildRead or PipelineReadAndTrigger cannot
    // hide behind "the new statement is fine".
    for (const flag of ["0", "1"]) {
      const policy = buildInlinePolicy({ ...BASE, PIPELINE_CI_START_BUILD: flag });
      const others = policy.Statement.filter((s) => s.Sid !== "ShipApprovalRecordWrite");
      // No statement other than the record write grants ANY s3 write action.
      for (const s of others) {
        for (const action of [].concat(s.Action)) {
          expect(action, `${flag}/${s.Sid}`).not.toMatch(/^s3:Put/);
          expect(action, `${flag}/${s.Sid}`).not.toMatch(/^s3:Delete/);
        }
      }
      // And the record write grants no CodePipeline/CodeBuild action at all.
      const statement = sid(policy, "ShipApprovalRecordWrite");
      for (const action of statement.Action) {
        expect(action, flag).toMatch(/^s3:/);
      }
    }
  });

  it("is not an approval grant — PutApprovalResult stays absent with it present", () => {
    for (const bucket of ["", "explicit-bucket"]) {
      const policy = buildInlinePolicy({ ...BASE, ARTIFACT_BUCKET: bucket });
      const actions = allActions(policy);
      expect(actions, bucket).not.toContain("codepipeline:PutApprovalResult");
      expect(actions.filter((a) => /Approval/i.test(a)), bucket).toEqual([]);
      // The Sid says "ship approval" but the Sid is a label, not a permission:
      // the statement's actions are S3 and nothing else.
      const statement = sid(policy, "ShipApprovalRecordWrite");
      if (statement) expect(statement.Action).toEqual(["s3:PutObject"]);
    }
  });
});

// ─── TEAM-4337: the hub-* convention grants ──────────────────────────────────

describe("buildInlinePolicy — the hub-* convention wildcards", () => {
  const ON = { ...BASE, PIPELINE_CI_START_BUILD: "1" };
  const cpArn = (name, region = REGION) =>
    `arn:aws:codepipeline:${region}:${ACCOUNT}:${name}`;
  const logArn = (group, region = REGION) =>
    `arn:aws:logs:${region}:${ACCOUNT}:log-group:/aws/codebuild/${group}`;

  it("keeps a deterministic Sid order with the flag on and off", () => {
    // A reviewer diffing two deploys must see statements move only when they
    // actually change - order is part of the contract.
    expect(buildInlinePolicy(BASE).Statement.map((s) => s.Sid)).toEqual([
      "Logs",
      "PipelineReadAndTrigger",
      "BuildRead",
      "HandoffMarkerRead",
      "CdRegistryRead",
      "ShipApprovalRecordWrite",
      "BuildLogRead",
      "CrossAccountAssumeTrigger",
    ]);
    expect(buildInlinePolicy(ON).Statement.map((s) => s.Sid)).toEqual([
      "Logs",
      "PipelineReadAndTrigger",
      "BuildRead",
      "CiStartBuild",
      "HandoffMarkerRead",
      "CdRegistryRead",
      "ShipApprovalRecordWrite",
      "BuildLogRead",
      "CrossAccountAssumeTrigger",
    ]);
  });

  it("grants sts:AssumeRole ONLY on the reserved hub-cd-trigger-* role, any account", () => {
    // Cross-account CD: the tools Lambda reaches a pipeline in another account by
    // assuming that account's trigger role. The grant is a name-scoped wildcard
    // (hub-cd-trigger-*) across all accounts, and NOTHING but AssumeRole — a
    // registry entry pointing at any other role is dropped by parseCdRegistry,
    // never assumed.
    const statement = sid(buildInlinePolicy(BASE), "CrossAccountAssumeTrigger");
    expect(statement).toEqual({
      Sid: "CrossAccountAssumeTrigger",
      Effect: "Allow",
      Action: ["sts:AssumeRole"],
      Resource: ["arn:aws:iam::*:role/hub-cd-trigger-*"],
    });
  });

  it("adds hub-*-deploy to read+trigger, keeping the hub's exact pipeline ARN", () => {
    const statement = sid(buildInlinePolicy(BASE), "PipelineReadAndTrigger");
    expect(statement.Resource).toEqual([
      cpArn("agentcore-hub-deploy"),
      cpArn("hub-*-deploy"),
    ]);
  });

  it("adds project/hub-* to BuildRead, keeping the three exact project ARNs", () => {
    const statement = sid(buildInlinePolicy(BASE), "BuildRead");
    expect(statement.Resource).toEqual([
      arn("agentcore-hub-build"),
      arn("agentcore-hub-ci"),
      arn("agentcore-hub-deploy"),
      arn("hub-*"),
    ]);
    // Read-only: a broad project wildcard is only safe because these two actions
    // are the only ones it carries.
    expect(statement.Action).toEqual([
      "codebuild:BatchGetBuilds",
      "codebuild:ListBuildsForProject",
    ]);
  });

  it("adds both hub-* log-group forms to BuildLogRead", () => {
    const statement = sid(buildInlinePolicy(BASE), "BuildLogRead");
    expect(statement.Action).toEqual(["logs:GetLogEvents"]);
    expect(statement.Resource).toEqual([
      logArn("agentcore-hub-build:*"),
      logArn("agentcore-hub-ci:*"),
      logArn("agentcore-hub-deploy:*"),
      logArn("hub-*"),
      logArn("hub-*:*"),
    ]);
  });

  // ─── the StartBuild blast radius, the one that matters ────────────────────

  it("hub-*-ci is the ONLY wildcard in any statement granting StartBuild", () => {
    for (const env of [ON, { ...ON, PIPELINE_REGIONS: "us-east-1,eu-west-1" }]) {
      const statements = statementsWith(buildInlinePolicy(env), "codebuild:StartBuild");
      expect(statements).toHaveLength(1);
      for (const resource of [].concat(statements[0].Resource)) {
        if (!resource.includes("*")) continue;
        expect(resource).toMatch(/^arn:aws:codebuild:[a-z0-9-]+:\d+:project\/hub-\*-ci$/);
      }
    }
  });

  it("no form of hub-*-deploy ever appears in a StartBuild statement", () => {
    for (const regions of ["us-east-1", "us-east-1,eu-west-1,ap-southeast-2"]) {
      const statements = statementsWith(
        buildInlinePolicy({ ...ON, PIPELINE_REGIONS: regions }),
        "codebuild:StartBuild"
      );
      const resources = statements.flatMap((s) => [].concat(s.Resource));
      for (const resource of resources) {
        // Neither the pipeline form nor the CodeBuild project form, and not the
        // bare project wildcard that would subsume them.
        expect(resource, regions).not.toMatch(/hub-\*-deploy/);
        expect(resource, regions).not.toMatch(/project\/hub-\*$/);
        expect(resource, regions).not.toBe("*");
      }
      // The hub's own exact PR-check ARN is still there.
      expect(resources).toContain(arn("agentcore-hub-ci"));
    }
  });

  // ─── PIPELINE_REGIONS fan-out ─────────────────────────────────────────────

  it("fans every wildcard out per PIPELINE_REGIONS region", () => {
    const policy = buildInlinePolicy({ ...ON, PIPELINE_REGIONS: "us-east-1,eu-west-1" });

    expect(sid(policy, "PipelineReadAndTrigger").Resource).toEqual([
      cpArn("agentcore-hub-deploy"),
      cpArn("hub-*-deploy", "us-east-1"),
      cpArn("hub-*-deploy", "eu-west-1"),
    ]);
    expect(sid(policy, "BuildRead").Resource.slice(-2)).toEqual([
      arn("hub-*", "us-east-1"),
      arn("hub-*", "eu-west-1"),
    ]);
    expect(sid(policy, "CiStartBuild").Resource).toEqual([
      arn("agentcore-hub-ci"),
      arn("hub-*-ci", "us-east-1"),
      arn("hub-*-ci", "eu-west-1"),
    ]);
    expect(sid(policy, "BuildLogRead").Resource.slice(-4)).toEqual([
      logArn("hub-*", "us-east-1"),
      logArn("hub-*:*", "us-east-1"),
      logArn("hub-*", "eu-west-1"),
      logArn("hub-*:*", "eu-west-1"),
    ]);
    // A region nobody asked for gets nothing.
    for (const resource of allResources(policy)) {
      expect(resource).not.toContain(":ap-southeast-2:");
    }
  });

  it("defaults to the Lambda region alone", () => {
    const policy = buildInlinePolicy({ ...ON, REGION: "eu-west-2" });
    expect(sid(policy, "CiStartBuild").Resource).toEqual([
      arn("agentcore-hub-ci", "eu-west-2"),
      arn("hub-*-ci", "eu-west-2"),
    ]);
  });

  it("dedupes, trims and drops empties in PIPELINE_REGIONS", () => {
    expect(parsePipelineRegions("us-east-1, eu-west-1 ,us-east-1,,", "zz")).toEqual([
      "us-east-1",
      "eu-west-1",
    ]);
    expect(parsePipelineRegions("", "us-east-1")).toEqual(["us-east-1"]);
    expect(parsePipelineRegions(undefined, "us-east-1")).toEqual(["us-east-1"]);
    expect(parsePipelineRegions("  ,  ", "us-east-1")).toEqual(["us-east-1"]);

    // A duplicated region must not duplicate the grant.
    const policy = buildInlinePolicy({ ...ON, PIPELINE_REGIONS: "us-east-1,us-east-1" });
    expect(sid(policy, "CiStartBuild").Resource).toEqual([
      arn("agentcore-hub-ci"),
      arn("hub-*-ci"),
    ]);
    expect(resolveEnv({ PIPELINE_REGIONS: "eu-west-1, eu-west-1 " }).PIPELINE_REGIONS).toBe(
      "eu-west-1"
    );
  });

  // ─── CdRegistryRead ───────────────────────────────────────────────────────

  it("reads the CD registry as ONE exact key, never a prefix", () => {
    const statement = sid(buildInlinePolicy(BASE), "CdRegistryRead");
    expect(statement.Action).toEqual(["s3:GetObject"]);
    expect(statement.Resource).toEqual([
      `arn:aws:s3:::agentcore-hub-artifacts-${ACCOUNT}-us-east-1/config/cd-registry.json`,
    ]);
    // config/ also holds agents.json and the workflow definitions - this role has
    // no business reading either.
    expect(statement.Resource[0]).not.toContain("*");
    for (const forbidden of ["agents.json", "workflows", "config/*"]) {
      expect(statement.Resource[0]).not.toContain(forbidden);
    }
  });

  it("honours an explicit ARTIFACT_BUCKET, and every S3 grant vanishes without one", () => {
    expect(
      sid(buildInlinePolicy({ ...BASE, ARTIFACT_BUCKET: "explicit-bucket" }), "CdRegistryRead")
        .Resource
    ).toEqual(["arn:aws:s3:::explicit-bucket/config/cd-registry.json"]);

    const noBucket = buildInlinePolicy({ ...BASE, ACCOUNT: undefined });
    expect(sid(noBucket, "CdRegistryRead")).toBeUndefined();
    expect(sid(noBucket, "HandoffMarkerRead")).toBeUndefined();
    expect(sid(noBucket, "ShipApprovalRecordWrite")).toBeUndefined();
    // Not one s3: action survives — there is no bucket to name in a Resource.
    expect(allActions(noBucket).filter((a) => a.startsWith("s3:"))).toEqual([]);
    // The handoff marker keeps its own prefix - the two grants are separate on
    // purpose, so neither can widen the other.
    expect(sid(buildInlinePolicy(BASE), "HandoffMarkerRead").Resource).toEqual([
      `arn:aws:s3:::agentcore-hub-artifacts-${ACCOUNT}-us-east-1/pipeline-artifacts/handoff/*`,
    ]);
  });

  // ─── the invariant that survives every widening ───────────────────────────

  it("PutApprovalResult is absent from every statement in every combination", () => {
    for (const flag of ["0", "1"]) {
      for (const regions of [undefined, "us-east-1", "us-east-1,eu-west-1"]) {
        for (const bucket of ["", "explicit-bucket"]) {
          const policy = buildInlinePolicy({
            ...BASE,
            PIPELINE_CI_START_BUILD: flag,
            PIPELINE_REGIONS: regions,
            ARTIFACT_BUCKET: bucket,
          });
          const label = `${flag}/${regions}/${bucket}`;
          const actions = allActions(policy);
          expect(actions, label).not.toContain("codepipeline:PutApprovalResult");
          expect(actions.filter((a) => /Approval/i.test(a)), label).toEqual([]);
          expect(actions.filter((a) => a.startsWith("codepipeline:")).sort(), label).toEqual([
            "codepipeline:GetPipelineExecution",
            "codepipeline:GetPipelineState",
            "codepipeline:ListActionExecutions",
            "codepipeline:StartPipelineExecution",
          ]);
        }
      }
    }
  });
});

describe("the deploy package and the function env", () => {
  it("zips cd-registry.mjs alongside index.mjs", () => {
    // index.mjs imports ./cd-registry.mjs, so a zip of index.mjs alone deploys a
    // Lambda that cannot load. The zip is built inline in main(), so this reads
    // the source - it is the only guard on that line
    // (scripts/check-lambda-zip-manifest.sh is orchestrator-only).
    const zipLine = SOURCE.split("\n").find((l) => l.includes("zip -qr function.zip"));
    expect(zipLine).toBeDefined();
    expect(zipLine).toContain("index.mjs");
    expect(zipLine).toContain("cd-registry.mjs");
  });

  it("sets PIPELINE_REGIONS and ARTIFACT_BUCKET on the function, and merges env", () => {
    const cfg = resolveEnv({ PIPELINE_REGIONS: "us-east-1, eu-west-1" });
    expect(cfg.PIPELINE_REGIONS).toBe("us-east-1,eu-west-1");

    // The env block main() builds, asserted from the source: the same keys the
    // Lambda reads, and a MERGE over the live function's variables so an
    // operator-set var this script does not know about survives a redeploy.
    const envBlock = SOURCE.slice(SOURCE.indexOf("const envVars = {"));
    for (const key of [
      "PIPELINE_NAME",
      "BUILD_PROJECT",
      "CI_PROJECT",
      "DEPLOY_PROJECT",
      "PIPELINE_CI_START_BUILD",
      "PIPELINE_REGIONS",
      "ARTIFACT_BUCKET",
    ]) {
      expect(envBlock.slice(0, envBlock.indexOf("};"))).toContain(key);
    }
    expect(SOURCE).toContain("Variables: { ...existingEnv, ...envVars }");
  });
});
