#!/usr/bin/env node
/**
 * AgentCore Hub — CI/CD Pipeline module (bolt-on) CDK app.
 *
 * Self-contained: this CDK app imports NOTHING from the hub's `src/`. Deploying
 * it is entirely optional — a forker who never runs `cdk deploy` here gets the
 * hub with zero pipeline, and the app still passes `tsc --noEmit` + `npm run
 * build`. See docs/cicd-pipeline-module-design.md.
 *
 * All account-specific values come from env (mirrors deploy/config.sh):
 *   CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION  — from the active credentials
 *   PIPELINE_GITHUB_OWNER / PIPELINE_GITHUB_REPO — the repo to build (pilot: the hub)
 *   PIPELINE_BRANCH        — trigger branch (default "main")
 *   PIPELINE_CONNECTION_ARN — an EXISTING CodeConnections arn, if reusing one
 *   PIPELINE_APPROVAL_EMAILS / PIPELINE_APPROVAL_SNS_ARN — approval notify targets
 *   ARTIFACT_BUCKET        — the hub artifact bucket (config merge + zip storage)
 *   ECS_SERVICE_ARN        — the ECS Express service the deploy stage rolls
 * Nothing is hardcoded; the stack refuses to synth if the required ones are unset.
 */
import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { PipelineStack } from "../lib/pipeline-stack.js";

const app = new App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION || process.env.AWS_REGION || "us-east-1";

const githubOwner = process.env.PIPELINE_GITHUB_OWNER;
const githubRepo = process.env.PIPELINE_GITHUB_REPO || "agentcore-hub";
const branch = process.env.PIPELINE_BRANCH || "main";

if (!account) {
  throw new Error(
    "CDK_DEFAULT_ACCOUNT is unset — run under real credentials (aws sts get-caller-identity). " +
      "This module deploys to whatever account your profile resolves to."
  );
}
if (!githubOwner) {
  throw new Error(
    "PIPELINE_GITHUB_OWNER is unset. Set it (and optionally PIPELINE_GITHUB_REPO, default 'agentcore-hub') " +
      "so the pipeline knows which GitHub repo to build. See docs/cicd-pipeline-module-design.md."
  );
}

new PipelineStack(app, "AgentcoreHubPipeline", {
  env: { account, region },
  description:
    "AgentCore Hub CI/CD module (bolt-on): CodeConnections + CodeBuild PR check + CodePipeline deploy.",
  terminationProtection: false,
  githubOwner,
  githubRepo,
  branch,
  // Optional reuse of an existing org-level CodeConnections link.
  existingConnectionArn: process.env.PIPELINE_CONNECTION_ARN,
  artifactBucketName:
    process.env.ARTIFACT_BUCKET || `agentcore-hub-artifacts-${account}-${region}`,
  ecsServiceArn: process.env.ECS_SERVICE_ARN,
  eventsTableName: process.env.PIPELINE_EVENTS_TABLE, // default agentcore-hub-events
  approvalSnsTopicArn: process.env.PIPELINE_APPROVAL_SNS_ARN,
  approvalEmails: (process.env.PIPELINE_APPROVAL_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
});

// cdk-nag on every synth — the design spec requires it (§8).
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
