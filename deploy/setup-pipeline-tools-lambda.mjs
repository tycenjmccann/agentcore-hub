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
 * Idempotent / re-runnable. Account-guarded via deploy/config.sh conventions.
 *
 * Usage:
 *   AWS_PROFILE=tycenj-prod node deploy/setup-pipeline-tools-lambda.mjs
 *
 * Env (all optional — sane prod defaults):
 *   PIPELINE_NAME   default agentcore-hub-deploy   (the CodePipeline)
 *   BUILD_PROJECT   default agentcore-hub-build
 *   CI_PROJECT      default agentcore-hub-ci
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGION = process.env.AWS_REGION || "us-east-1";
const FUNCTION_NAME = "agentcore-hub-pipeline-tools";
const ROLE_NAME = "agentcore-hub-pipeline-tools-role";
const PIPELINE_NAME = process.env.PIPELINE_NAME || "agentcore-hub-deploy";
const BUILD_PROJECT = process.env.BUILD_PROJECT || "agentcore-hub-build";
const CI_PROJECT = process.env.CI_PROJECT || "agentcore-hub-ci";
// The Deploy stage's CodeBuild project. Shares its NAME with PIPELINE_NAME (the
// CodePipeline) but is a DIFFERENT AWS resource kind — keep the two constants
// distinct; do not collapse them.
const DEPLOY_PROJECT = process.env.DEPLOY_PROJECT || "agentcore-hub-deploy";

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

// ─── 1. IAM role (scoped to exactly this pipeline + its three CodeBuild projects) ─
const pipelineArn = `arn:aws:codepipeline:${REGION}:${ACCOUNT}:${PIPELINE_NAME}`;
const buildArn = `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${BUILD_PROJECT}`;
const ciArn = `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${CI_PROJECT}`;
const deployArn = `arn:aws:codebuild:${REGION}:${ACCOUNT}:project/${DEPLOY_PROJECT}`;

const inlinePolicy = {
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

// ─── 2. Package ────────────────────────────────────────────────────────────────
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
};

// ─── 3. Create/update the function ──────────────────────────────────────────────
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

// ─── 4. Smoke test: get_state must report the pipeline as configured ─────────────
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
