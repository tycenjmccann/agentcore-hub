#!/usr/bin/env node
/**
 * Deploy the Routine Builder — an AgentCore Harness agent with persistent memory
 * that sets up scheduled routines conversationally: it composes existing agents or
 * writes prompt-only persona blueprints, upserts a workflow def, and saves a
 * routine record + its EventBridge schedule.
 *
 * Mirrors deploy/workflow-manager/setup-workflow-manager.mjs (same shared harness
 * role + create/verify flow) with a routines-specific data-plane policy:
 *   - S3 rw on config/* and blueprints/* (compose workflow defs + personas)
 *   - DynamoDB rw on the routines table
 *   - EventBridge Scheduler create/update/delete + iam:PassRole on the scheduler role
 *
 * Prereq: run lambda/routines-runner/deploy.sh FIRST so the runner Lambda + the
 * scheduler role exist; pass their ARNs in (or via .env.local).
 *
 * Usage:
 *   node deploy/routine-builder/setup-routine-builder.mjs \
 *     [--model-id us.anthropic.claude-opus-5]
 *
 * Requires: npm install at repo root.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  IAMClient,
  GetRoleCommand,
  CreateRoleCommand,
  AttachRolePolicyCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { snapshotHarness } from "../pipeline/harness-snapshot.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REGION = getArg("region") || process.env.AWS_REGION || "us-east-1";
// Opus streams post-tool-call text live (fable buffers it) — matches the WM's
// pre-bump choice. NOTE: WM has since moved to fable-5-1 pending a live
// streaming smoke test (see setup-workflow-manager.mjs); revisit this default
// once that's confirmed one way or the other.
const MODEL_ID = getArg("model-id") || "us.anthropic.claude-opus-5";
const HARNESS_NAME = "agentcore_hub_routine_builder";
const MEMORY_NAME = "agentcore_hub_routine_builder_memory";
const ROLE_NAME = "agentcore-hub-harness-role";
// PIPELINE_MODE=1: the CI/CD Deploy stage runs this under its narrow role — no
// IAM writes, no memory provisioning, no verify invoke. Only the code-like
// surfaces of the EXISTING harness (model, system prompt) are updated, after
// snapshotting the live values for deploy/pipeline/rollback.sh.
const PIPELINE_MODE = process.env.PIPELINE_MODE === "1";

// Load .env.local (gitignored) so a standalone run picks up DEPLOYMENT_URL and the
// runner/scheduler ARNs the routines-runner deploy printed. Existing env wins.
const ENV_LOCAL = join(__dirname, "..", "..", ".env.local");
if (existsSync(ENV_LOCAL)) {
  for (const line of readFileSync(ENV_LOCAL, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    if (k in process.env) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[k] = v;
  }
}

const sts = new STSClient({ region: REGION });
const { Account: accountId } = await sts.send(new GetCallerIdentityCommand({}));
const ARTIFACT_BUCKET =
  process.env.ARTIFACT_BUCKET || `agentcore-hub-artifacts-${accountId}-${REGION}`;
const ROLE_ARN = `arn:aws:iam::${accountId}:role/${ROLE_NAME}`;

const ROUTINES_TABLE = process.env.ROUTINES_TABLE || "agentcore-hub-routines";
const SCHEDULE_GROUP = process.env.ROUTINES_SCHEDULE_GROUP || "agentcore-hub-routines";
const RUNNER_ARN =
  process.env.ROUTINES_RUNNER_ARN ||
  `arn:aws:lambda:${REGION}:${accountId}:function:agentcore-hub-routines-runner`;
const SCHEDULER_ROLE_ARN =
  process.env.ROUTINES_SCHEDULER_ROLE_ARN ||
  `arn:aws:iam::${accountId}:role/agentcore-hub-routines-scheduler-role`;
const DLQ_ARN =
  process.env.ROUTINES_DLQ_ARN ||
  `arn:aws:sqs:${REGION}:${accountId}:agentcore-hub-routines-dlq`;

// ─── 1/4 Execution role (shared harness role + routines data-plane policy) ─────
console.log("\n1/4 Execution role");
const iam = new IAMClient({ region: REGION });
if (PIPELINE_MODE) {
  console.log("   – skipped (PIPELINE_MODE: IAM is owned by the hand-run setup)");
} else {
try {
  await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
  console.log(`   ✓ ${ROLE_NAME} exists`);
} catch (err) {
  if (err.name !== "NoSuchEntityException") throw err;
  await iam.send(new CreateRoleCommand({
    RoleName: ROLE_NAME,
    AssumeRolePolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: "bedrock-agentcore.amazonaws.com" },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "aws:SourceAccount": accountId },
          ArnLike: { "aws:SourceArn": `arn:aws:bedrock-agentcore:${REGION}:${accountId}:*` },
        },
      }],
    }),
    Description: "Execution role for AgentCore Hub harness agents",
  }));
  await iam.send(new AttachRolePolicyCommand({
    RoleName: ROLE_NAME,
    PolicyArn: "arn:aws:iam::aws:policy/BedrockAgentCoreFullAccess",
  }));
  console.log(`   ✓ ${ROLE_NAME} created (run setup-builder-agent.mjs for the full baseline policies)`);
}

// Re-applied every run — idempotent, heals stripped policies.
await iam.send(new PutRolePolicyCommand({
  RoleName: ROLE_NAME,
  PolicyName: "RoutineBuilderData",
  PolicyDocument: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ConfigAndBlueprints",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
        Resource: [
          `arn:aws:s3:::${ARTIFACT_BUCKET}`,
          `arn:aws:s3:::${ARTIFACT_BUCKET}/*`,
        ],
      },
      {
        Sid: "RoutinesTable",
        Effect: "Allow",
        Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Scan", "dynamodb:Query"],
        Resource: [
          `arn:aws:dynamodb:${REGION}:${accountId}:table/${ROUTINES_TABLE}`,
          `arn:aws:dynamodb:${REGION}:${accountId}:table/${ROUTINES_TABLE}/index/*`,
        ],
      },
      {
        Sid: "ManageSchedules",
        Effect: "Allow",
        Action: ["scheduler:CreateSchedule", "scheduler:UpdateSchedule", "scheduler:DeleteSchedule", "scheduler:GetSchedule", "scheduler:CreateScheduleGroup", "scheduler:GetScheduleGroup"],
        Resource: [
          `arn:aws:scheduler:${REGION}:${accountId}:schedule/${SCHEDULE_GROUP}/*`,
          `arn:aws:scheduler:${REGION}:${accountId}:schedule-group/${SCHEDULE_GROUP}`,
        ],
      },
      {
        Sid: "PassSchedulerRole",
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: SCHEDULER_ROLE_ARN,
        Condition: { StringEquals: { "iam:PassedToService": "scheduler.amazonaws.com" } },
      },
    ],
  }),
}));
console.log("   ✓ RoutineBuilderData inline policy applied");
await sleep(8000); // IAM propagation
}

// ─── 2/4 Memory ────────────────────────────────────────────────────────────────
const {
  BedrockAgentCoreControlClient,
  CreateHarnessCommand,
  GetHarnessCommand,
  ListHarnessesCommand,
  UpdateHarnessCommand,
  CreateMemoryCommand,
  GetMemoryCommand,
  ListMemoriesCommand,
} = await import("@aws-sdk/client-bedrock-agentcore-control");
const agentcore = new BedrockAgentCoreControlClient({ region: REGION });

console.log("\n2/4 AgentCore Memory");
let memoryId = null;
let memoryArn = null;
if (PIPELINE_MODE) {
  console.log("   – skipped (PIPELINE_MODE: memory is only needed to CREATE the harness)");
} else {
let memories = [];
let nextToken;
do {
  const page = await agentcore.send(new ListMemoriesCommand({ nextToken }));
  memories = memories.concat(page.memories || []);
  nextToken = page.nextToken;
} while (nextToken);
const existingMemory = memories.find((m) => (m.id || m.memoryId || "").startsWith(MEMORY_NAME) || m.name === MEMORY_NAME);
if (existingMemory) {
  memoryId = existingMemory.id || existingMemory.memoryId;
  console.log(`   ✓ Memory exists: ${memoryId}`);
} else {
  const created = await agentcore.send(new CreateMemoryCommand({
    name: MEMORY_NAME,
    description: "Routine Builder long-term memory (routines built, agent roster knowledge)",
    eventExpiryDuration: 90,
    memoryStrategies: [
      { semanticMemoryStrategy: { name: "rbSemantic", description: "Facts about routines, agents, cadences, and pipeline shapes" } },
      { summaryMemoryStrategy: { name: "rbSummary", description: "Session summaries of routine builds" } },
    ],
  }));
  memoryId = created.memory?.id || created.memory?.memoryId;
  console.log(`   ✓ Memory created: ${memoryId} — waiting for ACTIVE`);
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const m = await agentcore.send(new GetMemoryCommand({ memoryId }));
    const status = m.memory?.status;
    if (status === "ACTIVE") break;
    if (status === "FAILED") throw new Error(`Memory creation failed: ${m.memory?.failureReason || "unknown"}`);
    if (i === 59) throw new Error("Timed out waiting for memory ACTIVE");
  }
  console.log("   ✓ Memory ACTIVE");
}
memoryArn = `arn:aws:bedrock-agentcore:${REGION}:${accountId}:memory/${memoryId}`;
}

// ─── 3/4 Harness ───────────────────────────────────────────────────────────────
console.log("\n3/4 Harness");
const SYSTEM_PROMPT = readFileSync(join(__dirname, "system-prompt.md"), "utf8");

const harnessConfig = {
  harnessName: HARNESS_NAME,
  executionRoleArn: ROLE_ARN,
  model: { bedrockModelConfig: { modelId: MODEL_ID } },
  systemPrompt: [{ text: SYSTEM_PROMPT }],
  tools: [{ type: "agentcore_code_interpreter", name: "code_interpreter" }],
  allowedTools: ["*"],
  truncation: { strategy: "sliding_window", config: { slidingWindow: { messagesCount: 150 } } },
  maxIterations: 75,
  timeoutSeconds: 3600,
  memory: { agentCoreMemoryConfiguration: { arn: memoryArn, messagesCount: 20 } },
  environment: {
    agentCoreRuntimeEnvironment: {
      filesystemConfigurations: [{ sessionStorage: { mountPath: "/mnt/workspace/" } }],
    },
  },
  environmentVariables: {
    ARTIFACT_BUCKET,
    ROUTINES_TABLE,
    ROUTINES_RUNNER_ARN: RUNNER_ARN,
    ROUTINES_SCHEDULER_ROLE_ARN: SCHEDULER_ROLE_ARN,
    ROUTINES_SCHEDULE_GROUP: SCHEDULE_GROUP,
    ROUTINES_DLQ_ARN: DLQ_ARN,
    MODEL_ID,
  },
};

const list = await agentcore.send(new ListHarnessesCommand({}));
const existing = (list.harnesses || []).find((h) => h.harnessName === HARNESS_NAME);
let harnessId;
let harnessArn;
if (existing && existing.status === "READY") {
  harnessId = existing.harnessId;
  harnessArn = existing.arn;
  console.log(`   ✓ Harness exists: ${harnessId} (READY) — updating model + system prompt in place`);
  await snapshotHarness(agentcore, GetHarnessCommand, harnessId, HARNESS_NAME);
  // Model bump: re-pin the live harness to MODEL_ID so a model-bump deploy
  // isn't a silent no-op on an existing routine builder. model is passed
  // plainly — no optionalValue wrapper (that's only for the memory attachment
  // on Update). The system prompt rides along so an edit to system-prompt.md
  // reaches the live harness (it used to need a delete + recreate). Env is
  // left as-is (replace-all on Update; the live harness may carry values this
  // script doesn't know).
  await agentcore.send(new UpdateHarnessCommand({
    harnessId,
    model: { bedrockModelConfig: { modelId: MODEL_ID } },
    systemPrompt: [{ text: SYSTEM_PROMPT }],
  }));
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const status = await agentcore.send(new GetHarnessCommand({ harnessId }));
    const s = status.harness?.status;
    if (s === "READY") break;
    if (s === "UPDATE_FAILED") throw new Error(`Model update failed: ${status.harness?.failureReason || "unknown"}`);
    if (i === 23) throw new Error("Timed out waiting for harness READY after model update");
  }
  console.log(`   ✓ Model + system prompt updated (model=${MODEL_ID}) — READY`);
  console.log("   ℹ Env changes still need a delete + re-run (UpdateHarness env is replace-all).");
} else if (existing) {
  throw new Error(`Harness ${HARNESS_NAME} exists in status ${existing.status} — resolve manually, then re-run.`);
} else if (PIPELINE_MODE) {
  throw new Error(`Harness ${HARNESS_NAME} does not exist — the pipeline only UPDATES harnesses. Create it once by hand: node deploy/routine-builder/setup-routine-builder.mjs`);
} else {
  const res = await agentcore.send(new CreateHarnessCommand(harnessConfig));
  harnessId = res.harness?.harnessId;
  harnessArn = res.harness?.arn;
  console.log(`   Creating ${HARNESS_NAME} (${harnessId})...`);
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    const status = await agentcore.send(new GetHarnessCommand({ harnessId }));
    const s = status.harness?.status;
    if (s === "READY") break;
    if (s === "CREATE_FAILED") throw new Error(`Create failed: ${status.harness?.failureReason || "unknown"}`);
    if (i === 35) throw new Error("Timed out waiting for harness READY");
  }
  console.log("   ✓ Harness READY");
}

// ─── 4/4 Verify invoke ─────────────────────────────────────────────────────────
console.log("\n4/4 Verify");
if (PIPELINE_MODE) {
  console.log("   – skipped (PIPELINE_MODE: READY status above is the gate; the deploy role cannot InvokeHarness)");
  console.log(`\nDone (pipeline update). Harness: ${harnessArn}\n`);
  process.exit(0);
}
const { BedrockAgentCoreClient, InvokeHarnessCommand } = await import("@aws-sdk/client-bedrock-agentcore");
const dataplane = new BedrockAgentCoreClient({ region: REGION });
const sessionId = `rbverify-${Date.now()}-${"x".repeat(16)}`;
const response = await dataplane.send(new InvokeHarnessCommand({
  harnessArn,
  runtimeSessionId: sessionId,
  actorId: "routine-builder",
  maxIterations: 3,
  timeoutSeconds: 120,
  messages: [{ role: "user", content: [{ text: "Health check: reply with the single word OK. Do not use tools." }] }],
}));
let text = "";
for await (const event of response.stream || []) {
  if (event.contentBlockDelta?.delta?.text) text += event.contentBlockDelta.delta.text;
  if (event.runtimeClientError) throw new Error(`Invoke error: ${event.runtimeClientError.message}`);
}
console.log(`   ✓ Invoke responded: ${text.trim().slice(0, 80)}`);

console.log(`\nDone.
  Harness:  ${harnessArn}
  Memory:   ${memoryArn}
  Next:     export ROUTINE_BUILDER_ARN=${harnessArn}
            ./deploy/routine-builder/deploy.sh   # syncs the toolkit to S3\n`);
