#!/usr/bin/env node
/**
 * Deploy the Workflow Manager — an AgentCore Harness agent with persistent
 * memory that analyzes workflow runs (ANALYZE), unsticks live runs (WATCH),
 * and chats about org workflow performance (CHAT).
 *
 * Mirrors deploy/setup-builder-agent.mjs (same execution role, same create/
 * verify flow) and adds:
 *   - AgentCore Memory with semantic + summary long-term strategies
 *   - data-plane inline policy (DDB read + analyses RW + S3 artifact bucket)
 *   - session-storage workspace mounted at /workspace/
 *
 * Usage:
 *   node deploy/workflow-manager/setup-workflow-manager.mjs \
 *     [--model-id us.anthropic.claude-opus-4-8] [--workflow-api-url https://...]
 *
 * Requires: npm install at repo root (uses the repo's AWS SDK packages).
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REGION = getArg("region") || process.env.AWS_REGION || "us-east-1";
// NOTE: claude-fable-5 buffers all post-tool-call text and flushes it in a
// single burst at message end (verified: 0.1s span vs 8–9s for opus/sonnet on
// identical converse_stream). In the CHAT drawer that reads as a frozen,
// unstreamed blob after a long tool loop. Opus streams post-tool text live.
const MODEL_ID = getArg("model-id") || "us.anthropic.claude-opus-4-8";
const HARNESS_NAME = "agentcore_hub_workflow_manager";
const MEMORY_NAME = "agentcore_hub_workflow_manager_memory";
const ROLE_NAME = "agentcore-hub-harness-role";

// Load .env.local (gitignored) so a standalone run picks up the same
// DEPLOYMENT_URL / TICKET_PROVIDER the app + config.sh use. Existing env wins.
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

const WORKFLOW_API_URL = getArg("workflow-api-url") || process.env.DEPLOYMENT_URL || "";
const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";

const TABLES = {
  WORKFLOWS_TABLE: process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows",
  TICKETS_TABLE: process.env.TICKETS_TABLE || "agentcore-hub-tickets",
  EVENTS_TABLE: process.env.EVENTS_TABLE || "agentcore-hub-events",
  EVAL_CONFIG_TABLE: process.env.EVAL_CONFIG_TABLE || "agentcore-hub-eval-config",
  ANALYSES_TABLE: process.env.ANALYSES_TABLE || "agentcore-hub-workflow-analyses",
};

const sts = new STSClient({ region: REGION });
const { Account: accountId } = await sts.send(new GetCallerIdentityCommand({}));
const ARTIFACT_BUCKET =
  process.env.ARTIFACT_BUCKET || `agentcore-hub-artifacts-${accountId}-${REGION}`;
const ROLE_ARN = `arn:aws:iam::${accountId}:role/${ROLE_NAME}`;

// ─── 1/4 Execution role (shared harness role + WM data-plane policy) ───────────
console.log("\n1/4 Execution role");
const iam = new IAMClient({ region: REGION });
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

// Re-applied on every run — idempotent, heals stripped policies.
const tableArns = Object.values(TABLES).flatMap((t) => [
  `arn:aws:dynamodb:${REGION}:${accountId}:table/${t}`,
  `arn:aws:dynamodb:${REGION}:${accountId}:table/${t}/index/*`,
]);
await iam.send(new PutRolePolicyCommand({
  RoleName: ROLE_NAME,
  PolicyName: "WorkflowManagerData",
  PolicyDocument: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "HubTablesRead",
        Effect: "Allow",
        Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchGetItem"],
        Resource: tableArns,
      },
      {
        Sid: "AnalysesWrite",
        Effect: "Allow",
        Action: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
        Resource: [
          `arn:aws:dynamodb:${REGION}:${accountId}:table/${TABLES.ANALYSES_TABLE}`,
          // intervene.py: manager.intervention/escalation events + ticket
          // comments + workflow humanNotifications (transitions go via the app API)
          `arn:aws:dynamodb:${REGION}:${accountId}:table/${TABLES.EVENTS_TABLE}`,
          `arn:aws:dynamodb:${REGION}:${accountId}:table/${TABLES.TICKETS_TABLE}`,
          `arn:aws:dynamodb:${REGION}:${accountId}:table/${TABLES.WORKFLOWS_TABLE}`,
        ],
      },
      {
        Sid: "ArtifactBucket",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
        Resource: [
          `arn:aws:s3:::${ARTIFACT_BUCKET}`,
          `arn:aws:s3:::${ARTIFACT_BUCKET}/*`,
        ],
      },
      {
        // crash-rca skill: pull_session_logs.py reads runtime log groups +
        // span destinations to diagnose dead agent sessions. Read-only.
        Sid: "SessionLogsRead",
        Effect: "Allow",
        Action: [
          "logs:DescribeLogGroups",
          "logs:StartQuery",
          "logs:GetQueryResults",
          "logs:StopQuery",
        ],
        Resource: "*",
      },
    ],
  }),
}));
console.log("   ✓ WorkflowManagerData inline policy applied");
await sleep(8000); // IAM propagation

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
    description: "Workflow Manager long-term memory (cross-run workflow knowledge)",
    eventExpiryDuration: 90,
    memoryStrategies: [
      { semanticMemoryStrategy: { name: "wmSemantic", description: "Facts about workflows, runs, bottlenecks, recommendations" } },
      { summaryMemoryStrategy: { name: "wmSummary", description: "Session summaries of analyses, watches, and chats" } },
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
const memoryArn = `arn:aws:bedrock-agentcore:${REGION}:${accountId}:memory/${memoryId}`;

// ─── 3/4 Harness ───────────────────────────────────────────────────────────────
console.log("\n3/4 Harness");
const SYSTEM_PROMPT = readFileSync(join(__dirname, "system-prompt.md"), "utf8");

// Skills: on-demand playbooks (SKILL.md bundles) the WM pulls into context
// when a situation matches — behavior lives in skill files, not prompt bloat.
// Synced to S3 by deploy.sh; the harness resolves them from there.
const SKILLS = [
  { s3: { uri: `s3://${ARTIFACT_BUCKET}/workflow-manager/skills/crash-rca/` } },
];

const harnessConfig = {
  harnessName: HARNESS_NAME,
  executionRoleArn: ROLE_ARN,
  model: { bedrockModelConfig: { modelId: MODEL_ID } },
  systemPrompt: [{ text: SYSTEM_PROMPT }],
  tools: [{ type: "agentcore_code_interpreter", name: "code_interpreter" }],
  skills: SKILLS,
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
    ...TABLES,
    WORKFLOW_API_URL,
    TICKET_PROVIDER,
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
  console.log(`   ✓ Harness exists: ${harnessId} (READY) — updating in place`);
  // Update prompt + skills in place. env/memory/tools are left as-is (env is a
  // replace-all on Update and the live harness may carry values this script
  // doesn't know; memory needs the optionalValue wrapper — neither is worth
  // touching for a prompt/skills rollout).
  await agentcore.send(new UpdateHarnessCommand({
    harnessId,
    systemPrompt: [{ text: SYSTEM_PROMPT }],
    skills: SKILLS,
  }));
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const status = await agentcore.send(new GetHarnessCommand({ harnessId }));
    const s = status.harness?.status;
    if (s === "READY") break;
    if (s === "UPDATE_FAILED") {
      throw new Error(`Update failed: ${status.harness?.failureReason || "unknown"}`);
    }
    if (i === 23) throw new Error("Timed out waiting for harness READY after update");
  }
  console.log("   ✓ Harness updated (system prompt + skills) — READY");
} else if (existing) {
  throw new Error(`Harness ${HARNESS_NAME} exists in status ${existing.status} — resolve manually (delete or wait), then re-run.`);
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
    if (s === "CREATE_FAILED") {
      throw new Error(`Create failed: ${status.harness?.failureReason || "unknown"}`);
    }
    if (i === 35) throw new Error("Timed out waiting for harness READY");
  }
  console.log("   ✓ Harness READY");
}

// ─── 4/4 Verify invoke ─────────────────────────────────────────────────────────
console.log("\n4/4 Verify");
const { BedrockAgentCoreClient, InvokeHarnessCommand } = await import("@aws-sdk/client-bedrock-agentcore");
const dataplane = new BedrockAgentCoreClient({ region: REGION });
const sessionId = `wmverify-${Date.now()}-${"x".repeat(16)}`;
const response = await dataplane.send(new InvokeHarnessCommand({
  harnessArn,
  runtimeSessionId: sessionId,
  actorId: "workflow-manager",
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
  Next:     export WORKFLOW_MANAGER_ARN=${harnessArn}
            ./deploy/workflow-manager/deploy.sh\n`);
