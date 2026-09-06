#!/usr/bin/env node
/**
 * setup-pipeline-tools-lambda.mjs — deploy the agentcore-hub-pipeline-tools Lambda.
 *
 * The release_manager (PIPELINE mode) calls Pipeline___{get_state,start_deploy,
 * get_build_log} through this Lambda to trigger + watch the deploy pipeline.
 * The coding-runtime IAM role is AccessDenied on CodePipeline/CodeBuild, so the
 * pipeline drive MUST live in this narrowly-scoped Lambda, not in the agent's
 * shell.
 *
 * CI_PROJECT must name a PR-check project with no deploy permissions. Enabling
 * PIPELINE_CI_START_BUILD grants agent-triggerable CI execution: the role gets
 * codebuild:StartBuild on THAT ONE project ARN and nothing else, and the name is
 * validated (validateCiProjectName, below) before any AWS call — a wildcard, or a
 * name that collides with the build/deploy/runtime-image project or the pipeline,
 * aborts the deploy rather than handing an agent a way to start a deploy.
 *
 * Idempotent / re-runnable. Account-guarded via deploy/config.sh conventions.
 *
 * Usage:
 *   AWS_PROFILE=tycenj-prod node deploy/setup-pipeline-tools-lambda.mjs
 *
 * Env (all optional — sane prod defaults):
 *   PIPELINE_NAME   default agentcore-hub-deploy   (the CodePipeline)
 *   BUILD_PROJECT   default agentcore-hub-build
 *   CI_PROJECT      default agentcore-hub-ci       (the PR-check CodeBuild project;
 *                   the only project Pipeline___start_ci_build can ever start)
 *   PIPELINE_CI_START_BUILD  "1" to grant codebuild:StartBuild on CI_PROJECT
 *                   (adds the CiStartBuild statement + sets the same var on the
 *                   function, so Pipeline___capabilities advertises the tool).
 *                   Anything else — including unset — omits the grant entirely.
 *   DEPLOY_PROJECT  default agentcore-hub-deploy   (the Deploy stage's CodeBuild
 *                   project — same NAME as the pipeline, different resource kind)
 *   AWS_REGION      default us-east-1
 */

import {
  IAMClient,
  GetRoleCommand,
  CreateRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  LambdaClient,
  GetFunctionCommand,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  InvokeCommand,
} from "@aws-sdk/client-lambda";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FUNCTION_NAME = "agentcore-hub-pipeline-tools";
const ROLE_NAME = "agentcore-hub-pipeline-tools-role";

// ─── CI project validation (byte-duplicated from the Lambda) ───────────────────
// This is the same function as lambda/agentcore-hub-pipeline-tools/index.mjs's
// exported validateCiProjectName, deliberately COPIED rather than imported: the
// Lambda zip is index.mjs only (no shared module can ship with it), and importing
// index.mjs here would construct three AWS SDK clients inside a deploy script.
// The two copies are pinned against each other on a shared matrix by
// deploy/setup-pipeline-tools-lambda.test.mjs — change one, change both.
const RESERVED_CI_PROJECTS = ["agentcore-hub-runtime-image-deploy"];

export function validateCiProjectName(name, opts = {}) {
  const { buildProject, deployProject, pipelineName } = opts;
  const value = typeof name === "string" ? name : "";
  if (!value) return { ok: false, reason: "CI_PROJECT is empty" };
  if (value.includes("*") || value.includes("?")) {
    return { ok: false, reason: `CI_PROJECT "${value}" contains a wildcard` };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,254}$/.test(value)) {
    return {
      ok: false,
      reason: `CI_PROJECT "${value}" is not a valid CodeBuild project name (2-255 chars of [A-Za-z0-9_-], starting alphanumeric)`,
    };
  }
  for (const [label, other] of [
    ["BUILD_PROJECT", buildProject],
    ["DEPLOY_PROJECT", deployProject],
    ["PIPELINE_NAME", pipelineName],
    ...RESERVED_CI_PROJECTS.map((p) => ["a reserved deploy project", p]),
  ]) {
    if (other && value === other) {
      return {
        ok: false,
        reason: `CI_PROJECT "${value}" is ${label} — start_ci_build may only start the PR-check project`,
      };
    }
  }
  return { ok: true, reason: null };
}

/** Env → the values this script deploys with. Defaults live here so the policy
 * builder and main() can never disagree about them. */
export function resolveEnv(env = process.env) {
  return {
    REGION: env.AWS_REGION || "us-east-1",
    PIPELINE_NAME: env.PIPELINE_NAME || "agentcore-hub-deploy",
    BUILD_PROJECT: env.BUILD_PROJECT || "agentcore-hub-build",
    CI_PROJECT: env.CI_PROJECT || "agentcore-hub-ci",
    // The Deploy stage's CodeBuild project. Shares its NAME with PIPELINE_NAME
    // (the CodePipeline) but is a DIFFERENT AWS resource kind — keep the two
    // constants distinct; do not collapse them.
    DEPLOY_PROJECT: env.DEPLOY_PROJECT || "agentcore-hub-deploy",
    PIPELINE_CI_START_BUILD: env.PIPELINE_CI_START_BUILD === "1" ? "1" : "0",
  };
}

/**
 * The Lambda role's inline policy. Pure (env in, document out) so the blast
 * radius of the StartBuild grant is unit-assertable — see
 * deploy/setup-pipeline-tools-lambda.test.mjs.
 *
 * `env` also carries ACCOUNT (from STS at deploy time); every ARN is derived, so
 * no account id is ever hardcoded.
 *
 * Throws when PIPELINE_CI_START_BUILD is on and CI_PROJECT is not a safe
 * PR-check project name — a bad name must fail the deploy, not widen the grant.
 */
export function buildInlinePolicy(env) {
  const {
    REGION,
    ACCOUNT,
    PIPELINE_NAME,
    BUILD_PROJECT,
    CI_PROJECT,
    DEPLOY_PROJECT,
    PIPELINE_CI_START_BUILD,
  } = env;

  const pipelineArn = `arn:aws:codepipeline:${REGION}:${ACCOUNT}:${PIPELINE_NAME}`;
  const buildArn = `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${BUILD_PROJECT}`;
  const ciArn = `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${CI_PROJECT}`;
  const deployArn = `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${DEPLOY_PROJECT}`;

  const ciStartBuild = PIPELINE_CI_START_BUILD === "1";
  if (ciStartBuild) {
    const check = validateCiProjectName(CI_PROJECT, {
      buildProject: BUILD_PROJECT,
      deployProject: DEPLOY_PROJECT,
      pipelineName: PIPELINE_NAME,
    });
    if (!check.ok) {
      throw new Error(
        `PIPELINE_CI_START_BUILD=1 refused: ${check.reason}. Point CI_PROJECT at the PR-check project (default agentcore-hub-ci) or leave the flag unset.`
      );
    }
  }

  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "Logs",
        Effect: "Allow",
        Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: "*",
      },
      {
        // Read + trigger only. NO codepipeline:PutApprovalResult — the deploy gate
        // is a human decision (Telegram bridge). Do not add it here.
        Sid: "PipelineReadAndTrigger",
        Effect: "Allow",
        Action: [
          "codepipeline:GetPipelineState",
          "codepipeline:ListActionExecutions",
          "codepipeline:StartPipelineExecution",
        ],
        Resource: pipelineArn,
      },
      {
        // Read-only build visibility, incl. the Deploy stage's own CodeBuild
        // project (agentcore-hub-deploy) so get_build_log can read the intentional
        // exit-2 "HANDOFF" signal. Still NO approval/write action of any kind.
        Sid: "BuildRead",
        Effect: "Allow",
        Action: ["codebuild:BatchGetBuilds", "codebuild:ListBuildsForProject"],
        Resource: [buildArn, ciArn, deployArn],
      },
      // The ONLY write this role ever gets, and only when asked for: StartBuild on
      // the validated PR-check project ARN — never the build, deploy or
      // runtime-image project, never a wildcard.
      ...(ciStartBuild
        ? [
            {
              Sid: "CiStartBuild",
              Effect: "Allow",
              Action: ["codebuild:StartBuild"],
              Resource: [ciArn],
            },
          ]
        : []),
      {
        Sid: "BuildLogRead",
        Effect: "Allow",
        Action: ["logs:GetLogEvents"],
        Resource: [
          `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/codebuild/${BUILD_PROJECT}:*`,
          `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/codebuild/${CI_PROJECT}:*`,
          `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/codebuild/${DEPLOY_PROJECT}:*`,
        ],
      },
    ],
  };
}

async function main() {
  const cfg = resolveEnv();
  const {
    REGION,
    PIPELINE_NAME,
    BUILD_PROJECT,
    CI_PROJECT,
    DEPLOY_PROJECT,
    PIPELINE_CI_START_BUILD,
  } = cfg;

  // Fail on a bad CI_PROJECT before touching AWS at all (buildInlinePolicy
  // re-checks — this one exists so the operator sees it in one second, not after
  // an STS round trip).
  if (PIPELINE_CI_START_BUILD === "1") {
    const check = validateCiProjectName(CI_PROJECT, {
      buildProject: BUILD_PROJECT,
      deployProject: DEPLOY_PROJECT,
      pipelineName: PIPELINE_NAME,
    });
    if (!check.ok) {
      console.error(`PIPELINE_CI_START_BUILD=1 refused: ${check.reason}`);
      process.exit(1);
    }
  }

  const iam = new IAMClient({ region: REGION });
  const lambda = new LambdaClient({ region: REGION });
  const sts = new STSClient({ region: REGION });

  const { Account: ACCOUNT } = await sts.send(new GetCallerIdentityCommand({}));
  const EXPECTED = process.env.EXPECTED_ACCOUNT_ID;
  if (EXPECTED && ACCOUNT !== EXPECTED) {
    console.error(`Account guard: got ${ACCOUNT}, expected ${EXPECTED}. Aborting.`);
    process.exit(1);
  }
  console.log(`Account:  ${ACCOUNT}`);
  console.log(`Region:   ${REGION}`);
  console.log(`Pipeline: ${PIPELINE_NAME}`);
  console.log(
    `CI build: ${
      PIPELINE_CI_START_BUILD === "1"
        ? `StartBuild GRANTED on ${CI_PROJECT}`
        : "StartBuild not granted (PIPELINE_CI_START_BUILD unset)"
    }`
  );

  // ─── 1. IAM role (scoped to exactly this pipeline + its three CodeBuild projects) ─
  const inlinePolicy = buildInlinePolicy({ ...cfg, ACCOUNT });

  let roleArn;
  try {
    const r = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
    roleArn = r.Role.Arn;
    console.log(`IAM role exists: ${roleArn}`);
  } catch {
    console.log("Creating IAM role...");
    const created = await iam.send(
      new CreateRoleCommand({
        RoleName: ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
      })
    );
    roleArn = created.Role.Arn;
    await new Promise((s) => setTimeout(s, 10000)); // IAM propagation
  }
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: ROLE_NAME,
      PolicyName: "inline",
      PolicyDocument: JSON.stringify(inlinePolicy),
    })
  );
  console.log("IAM inline policy applied (read+trigger, NO approval).");

  // ─── 2. Package ──────────────────────────────────────────────────────────────
  const srcDir = join(__dirname, "..", "lambda", FUNCTION_NAME);
  const zipPath = join(srcDir, "function.zip");
  rmSync(zipPath, { force: true });
  execSync(`cd "${srcDir}" && zip -qr function.zip index.mjs`, { stdio: "inherit" });
  const zipBuffer = readFileSync(zipPath);

  const envVars = {
    PIPELINE_NAME,
    BUILD_PROJECT,
    CI_PROJECT,
    DEPLOY_PROJECT,
    PIPELINE_CI_START_BUILD,
  };

  // ─── 3. Create/update the function ───────────────────────────────────────────
  let exists = false;
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
    exists = true;
  } catch {
    /* not found */
  }

  if (exists) {
    console.log("Updating function code...");
    await lambda.send(
      new UpdateFunctionCodeCommand({ FunctionName: FUNCTION_NAME, ZipFile: zipBuffer })
    );
    await new Promise((s) => setTimeout(s, 4000));
    await lambda.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: FUNCTION_NAME,
        Environment: { Variables: envVars },
        Timeout: 60,
        MemorySize: 256,
      })
    );
  } else {
    console.log("Creating function...");
    await lambda.send(
      new CreateFunctionCommand({
        FunctionName: FUNCTION_NAME,
        Runtime: "nodejs20.x",
        Handler: "index.handler",
        Role: roleArn,
        Timeout: 60,
        MemorySize: 256,
        Code: { ZipFile: zipBuffer },
        Environment: { Variables: envVars },
      })
    );
  }
  rmSync(zipPath, { force: true });
  await new Promise((s) => setTimeout(s, 5000));

  // ─── 4. Smoke test: get_state must report the pipeline as configured ──────────
  console.log("\nVerification invoke (get_state)...");
  const inv = await lambda.send(
    new InvokeCommand({
      FunctionName: FUNCTION_NAME,
      Payload: Buffer.from(JSON.stringify({ name: "Pipeline___get_state", arguments: {} })),
    })
  );
  const payload = JSON.parse(Buffer.from(inv.Payload).toString());
  const text = payload?.content?.[0]?.text || JSON.stringify(payload);
  console.log(text.slice(0, 400));
  if (inv.FunctionError) {
    console.error("\n⚠ Verification invoke FunctionError:", inv.FunctionError);
    process.exit(1);
  }
  const parsed = (() => { try { return JSON.parse(text); } catch { return {}; } })();
  if (parsed.configured !== true) {
    console.error("\n⚠ Pipeline not reported as configured — check PIPELINE_NAME / perms.");
    process.exit(1);
  }

  console.log(`\n✅ ${FUNCTION_NAME} deployed. Function ARN:`);
  console.log(`   arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FUNCTION_NAME}`);
  console.log("\nNext: grant the runtime role lambda:InvokeFunction on this function,");
  console.log("set PIPELINE_TOOLS_LAMBDA on the shared runtime, add the 3 tools to");
  console.log("release_manager in agents.json, and redeploy the runtime.");
}

// Run only when executed directly — importing this module (the policy tests do)
// must never deploy anything.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await main();
}
