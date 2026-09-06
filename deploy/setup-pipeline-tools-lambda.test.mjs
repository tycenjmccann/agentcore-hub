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
 */
import { describe, it, expect, vi } from "vitest";

import {
  buildInlinePolicy,
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

const arn = (project) => `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${project}`;
const sid = (policy, name) => policy.Statement.find((s) => s.Sid === name);
const allActions = (policy) => policy.Statement.flatMap((s) => [].concat(s.Action));
const allResources = (policy) => policy.Statement.flatMap((s) => [].concat(s.Resource));

describe("buildInlinePolicy — the CiStartBuild grant", () => {
  it("is ABSENT with the flag off (today's policy, unchanged)", () => {
    const policy = buildInlinePolicy(BASE);

    expect(sid(policy, "CiStartBuild")).toBeUndefined();
    expect(allActions(policy)).not.toContain("codebuild:StartBuild");
    // The four statements that were there before FR-4, in order.
    expect(policy.Statement.map((s) => s.Sid)).toEqual([
      "Logs",
      "PipelineReadAndTrigger",
      "BuildRead",
      "BuildLogRead",
    ]);
  });

  it("is PRESENT with the flag on, immediately after BuildRead", () => {
    const policy = buildInlinePolicy({ ...BASE, PIPELINE_CI_START_BUILD: "1" });

    expect(policy.Statement.map((s) => s.Sid)).toEqual([
      "Logs",
      "PipelineReadAndTrigger",
      "BuildRead",
      "CiStartBuild",
      "BuildLogRead",
    ]);
    expect(sid(policy, "CiStartBuild")).toEqual({
      Sid: "CiStartBuild",
      Effect: "Allow",
      Action: ["codebuild:StartBuild"],
      Resource: [arn("agentcore-hub-ci")],
    });
  });

  it("grants StartBuild on the CI project ARN and NOTHING else", () => {
    const policy = buildInlinePolicy({ ...BASE, PIPELINE_CI_START_BUILD: "1" });
    const statement = sid(policy, "CiStartBuild");

    expect(statement.Resource).toEqual([arn("agentcore-hub-ci")]);
    expect(statement.Resource).not.toContain(arn("agentcore-hub-deploy"));
    expect(statement.Resource).not.toContain(arn("agentcore-hub-build"));
    expect(statement.Resource).not.toContain(arn("agentcore-hub-runtime-image-deploy"));
    for (const resource of statement.Resource) {
      expect(resource).not.toContain("*");
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

    expect(sid(policy, "CiStartBuild").Resource).toEqual([arn("other-repo-ci")]);
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
    });
    expect(resolveEnv({ PIPELINE_CI_START_BUILD: "1" }).PIPELINE_CI_START_BUILD).toBe("1");
    expect(resolveEnv({ PIPELINE_CI_START_BUILD: "true" }).PIPELINE_CI_START_BUILD).toBe("0");
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
