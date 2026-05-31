#!/usr/bin/env node
/**
 * Deploy Builder Agent — an AgentCore harness that creates other agents.
 *
 * The builder uses:
 *   - code_interpreter: to call boto3 CreateHarness/CreateAgentRuntime APIs
 *   - remote_mcp (optional): connects to customer's MCP servers for tool discovery
 *   - memory (optional): remembers past agent builds
 *
 * The builder sees all tools available via MCP, then creates child agents wired
 * to the appropriate subset. Works with any infrastructure (AWS, GCP, on-prem)
 * as long as it's exposed via MCP.
 *
 * Usage:
 *   # Minimal — creates IAM role automatically
 *   node deploy/setup-builder-agent.mjs
 *
 *   # With existing role (skips role creation)
 *   node deploy/setup-builder-agent.mjs \
 *     --harness-role-arn arn:aws:iam::ACCOUNT:role/YourRole
 *
 *   # With MCP servers for tool discovery
 *   node deploy/setup-builder-agent.mjs \
 *     --mcp-url https://api.githubcopilot.com/mcp/ \
 *     --mcp-url https://my-tools.example.com/mcp
 *
 *   # With memory for persistent context
 *   node deploy/setup-builder-agent.mjs \
 *     --mcp-url https://my-tools.example.com/mcp \
 *     --memory-id my-builder-memory
 *
 * Prerequisites:
 *   - AWS credentials configured (with IAM permissions to create roles if not using --harness-role-arn)
 */

import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  IAMClient,
  GetRoleCommand,
  CreateRoleCommand,
  AttachRolePolicyCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : null;
}
function getAllArgs(name) {
  const results = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) {
      results.push(args[i + 1]);
    }
  }
  return results;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const REGION = getArg("region") || process.env.AWS_REGION || "us-east-1";
let HARNESS_ROLE_ARN = getArg("harness-role-arn");
const MEMORY_ID = getArg("memory-id");
const MCP_URLS = getAllArgs("mcp-url");
const MODEL_ID = getArg("model-id") || "us.anthropic.claude-sonnet-4-6";
const ROLE_NAME = "agentcore-hub-harness-role";

// --- Resolve account ID ---
const sts = new STSClient({ region: REGION });
const identity = await sts.send(new GetCallerIdentityCommand({}));
const accountId = identity.Account;

// --- Create or verify IAM role ---
if (!HARNESS_ROLE_ARN) {
  console.log("\n1/3 Setting up IAM harness execution role...\n");

  const iam = new IAMClient({ region: REGION });

  const trustPolicy = JSON.stringify({
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
  });

  try {
    const existing = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
    HARNESS_ROLE_ARN = existing.Role.Arn;
    console.log(`   ✓ Role "${ROLE_NAME}" already exists`);
  } catch (err) {
    if (err.name === "NoSuchEntityException") {
      await iam.send(new CreateRoleCommand({
        RoleName: ROLE_NAME,
        AssumeRolePolicyDocument: trustPolicy,
        Description: "Execution role for AgentCore Hub harness agents (builder)",
      }));
      HARNESS_ROLE_ARN = `arn:aws:iam::${accountId}:role/${ROLE_NAME}`;
      console.log(`   ✓ Role "${ROLE_NAME}" created`);

      // Attach AWS managed policy for AgentCore access
      await iam.send(new AttachRolePolicyCommand({
        RoleName: ROLE_NAME,
        PolicyArn: "arn:aws:iam::aws:policy/BedrockAgentCoreFullAccess",
      }));
      console.log(`   ✓ Attached BedrockAgentCoreFullAccess managed policy`);

      // Inline policy: code interpreter + browser
      await iam.send(new PutRolePolicyCommand({
        RoleName: ROLE_NAME,
        PolicyName: "HarnessCodeInterpreterAndBrowser",
        PolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [{
            Sid: "CodeInterpreterAndBrowser",
            Effect: "Allow",
            Action: [
              "bedrock-agentcore:StartCodeInterpreterSession",
              "bedrock-agentcore:StopCodeInterpreterSession",
              "bedrock-agentcore:GetCodeInterpreterSession",
              "bedrock-agentcore:ListCodeInterpreterSessions",
              "bedrock-agentcore:ExecuteCode",
              "bedrock-agentcore:ExecuteCommand",
              "bedrock-agentcore:InstallPackages",
              "bedrock-agentcore:UploadFile",
              "bedrock-agentcore:DownloadFile",
              "bedrock-agentcore:StartBrowserSession",
              "bedrock-agentcore:StopBrowserSession",
              "bedrock-agentcore:GetBrowserSession",
              "bedrock-agentcore:ListBrowserSessions",
            ],
            Resource: "*",
          }],
        }),
      }));
      console.log(`   ✓ Attached CodeInterpreter + Browser inline policy`);

      // Inline policy: Bedrock model invoke
      await iam.send(new PutRolePolicyCommand({
        RoleName: ROLE_NAME,
        PolicyName: "BedrockModelInvoke",
        PolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [{
            Sid: "InvokeModels",
            Effect: "Allow",
            Action: [
              "bedrock:InvokeModel",
              "bedrock:InvokeModelWithResponseStream",
            ],
            Resource: "*",
          }],
        }),
      }));
      console.log(`   ✓ Attached Bedrock model invoke inline policy`);

      // Inline policy: Gateway invoke
      await iam.send(new PutRolePolicyCommand({
        RoleName: ROLE_NAME,
        PolicyName: "HarnessInvokeGateway",
        PolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [{
            Sid: "GatewayInvoke",
            Effect: "Allow",
            Action: "bedrock-agentcore:InvokeGateway",
            Resource: `arn:aws:bedrock-agentcore:${REGION}:${accountId}:gateway/*`,
          }],
        }),
      }));
      console.log(`   ✓ Attached Gateway invoke inline policy`);

      // Inline policy: IAM PassRole (so builder can create child harnesses)
      await iam.send(new PutRolePolicyCommand({
        RoleName: ROLE_NAME,
        PolicyName: "PassRoleForChildAgents",
        PolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [{
            Sid: "PassRole",
            Effect: "Allow",
            Action: "iam:PassRole",
            Resource: `arn:aws:iam::${accountId}:role/${ROLE_NAME}`,
            Condition: {
              StringEquals: { "iam:PassedToService": "bedrock-agentcore.amazonaws.com" },
            },
          }],
        }),
      }));
      console.log(`   ✓ Attached PassRole inline policy (for child agent creation)`);

      // Wait for IAM propagation
      console.log(`   ⏳ Waiting 10s for IAM role propagation...`);
      await sleep(10000);
    } else {
      throw err;
    }
  }
} else {
  console.log(`\n   Using provided role: ${HARNESS_ROLE_ARN}\n`);
}

// --- Dynamic imports ---
const {
  BedrockAgentCoreControlClient,
  CreateHarnessCommand,
  GetHarnessCommand,
  ListHarnessesCommand,
} = await import("@aws-sdk/client-bedrock-agentcore-control");

const agentcore = new BedrockAgentCoreControlClient({ region: REGION });

console.log(`\n2/3 Deploying Builder Agent Harness`);
console.log("  " + "=".repeat(50));
console.log(`  Region:       ${REGION}`);
console.log(`  Model:        ${MODEL_ID}`);
console.log(`  Role:         ${HARNESS_ROLE_ARN}`);
console.log(`  MCP Servers:  ${MCP_URLS.length > 0 ? MCP_URLS.join("\n                ") : "(none — builder can still create agents via code_interpreter)"}`);
console.log(`  Memory:       ${MEMORY_ID || "(none)"}`);
console.log("  " + "=".repeat(50) + "\n");

// --- Check if already exists ---
const list = await agentcore.send(new ListHarnessesCommand({}));
const existingReady = (list.harnesses || []).find(
  (h) => h.harnessName === "agentcore_hub_builder" && h.status === "READY"
);

if (existingReady) {
  console.log(`  Already exists: ${existingReady.harnessId} (READY)`);
  await verifyHarness(existingReady.harnessId);
  printDone(existingReady.harnessId);
  process.exit(0);
}

// Check if one exists but is still being created or deleted
const existingOther = (list.harnesses || []).find(
  (h) => h.harnessName === "agentcore_hub_builder" && h.status !== "READY"
);
if (existingOther) {
  console.log(`  Found existing agentcore_hub_builder in state: ${existingOther.status}`);
  if (existingOther.status === "CREATING") {
    console.log(`  Waiting for it to become READY...`);
    for (let i = 0; i < 30; i++) {
      await sleep(5000);
      const status = await agentcore.send(new GetHarnessCommand({ harnessId: existingOther.harnessId }));
      if (status.harness?.status === "READY") {
        printDone(existingOther.harnessId);
        process.exit(0);
      }
      if (status.harness?.status === "CREATE_FAILED") {
        console.error(`  Create failed: ${status.harness?.failureReason || "unknown"}`);
        process.exit(1);
      }
    }
  } else {
    // DELETING or other state — wait for it to clear, then create fresh
    console.log(`  Waiting for deletion to complete (up to 5 min)...`);
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const refreshed = await agentcore.send(new ListHarnessesCommand({}));
      const still = (refreshed.harnesses || []).find(
        (h) => h.harnessName === "agentcore_hub_builder"
      );
      if (!still) {
        console.log(`  Deletion complete. Proceeding with creation.`);
        break;
      }
      if (i === 59) {
        console.error(`  Timed out waiting for old harness to delete. Try again in a few minutes.`);
        process.exit(1);
      }
    }
  }
}

// --- Build tools array ---
const tools = [
  // code_interpreter lets the builder use boto3 to call CreateHarness, ListAgentRuntimes, etc.
  { type: "agentcore_code_interpreter", name: "code_interpreter" },
];

// Add customer's MCP servers for tool discovery
for (let i = 0; i < MCP_URLS.length; i++) {
  const url = MCP_URLS[i];
  // Derive a name from the URL hostname
  const hostname = new URL(url).hostname.replace(/\./g, "_").slice(0, 30);
  tools.push({
    type: "remote_mcp",
    name: `mcp_${hostname}`,
    config: { remoteMcp: { url } },
  });
}

// --- System prompt ---
const SYSTEM_PROMPT = `You are the Builder Agent — you create and configure AI agents on Amazon Bedrock AgentCore.

## Your Tools

1. **code_interpreter** — Run Python/boto3 to call AgentCore APIs:
   - \`CreateHarness\` / \`CreateAgentRuntime\` — deploy new agents
   - \`ListHarnesses\` / \`ListAgentRuntimes\` — see existing agents
   - \`GetHarness\` / \`GetAgentRuntime\` — inspect agent configs
   - \`ListGateways\` / \`ListGatewayTargets\` — see available gateway tools
   - \`ListMemories\` — see available memory resources
${MCP_URLS.length > 0 ? `
2. **MCP Tools** — You're connected to ${MCP_URLS.length} MCP server(s) for tool discovery.
   Call \`list_tools\` on each to see what's available, then wire the appropriate
   \`remote_mcp\` entries into agents you create.
   Connected servers: ${MCP_URLS.join(", ")}
` : ""}
## How to Build an Agent

1. **Understand the request** — What should the agent do? What tools does it need?
2. **Discover available tools** — ${MCP_URLS.length > 0 ? "Use your MCP connections to list available tools. Also" : "Use"} code_interpreter with boto3 to call ListGateways/ListGatewayTargets.
3. **Design the agent** — Choose model, write system prompt, select tools.
4. **Create it** — Use code_interpreter to call CreateHarness:

\`\`\`python
import boto3
client = boto3.client("bedrock-agentcore-control", region_name="${REGION}")

response = client.create_harness(
    harnessName="my_new_agent",
    executionRoleArn="${HARNESS_ROLE_ARN}",
    model={"bedrockModelConfig": {"modelId": "global.anthropic.claude-sonnet-4-5-20250929-v1:0"}},
    systemPrompt=[{"text": "Your system prompt here..."}],
    tools=[
        # Add remote_mcp for each MCP server the agent needs:
        {"type": "remote_mcp", "name": "tools", "config": {"remoteMcp": {"url": "https://..."}}},
        # Or code_interpreter if it needs to run code:
        {"type": "code_interpreter", "name": "code_interpreter"},
    ],
    allowedTools=["*"],
    maxIterations=50,
    timeoutSeconds=3600,
)
print(f"Created: {response['harness']['harnessId']}")
\`\`\`

## Agent Design Guidelines

- **Naming**: snake_case, descriptive: \`customer_support_agent\`, \`code_review_agent\`
- **Models**:
  - \`global.anthropic.claude-sonnet-4-5-20250929-v1:0\` — Fast, good for most tasks (default)
  - \`global.anthropic.claude-opus-4-6-v1\` — Most capable, complex reasoning
  - \`global.anthropic.claude-haiku-4-5-20251001-v1:0\` — Fastest, cheapest
- **System Prompts**: Clear role, specific capabilities, when/how to use tools
- **Tool Wiring**: Use \`remote_mcp\` to connect agents to MCP servers. The URL is all that's needed — the agent discovers available tools at runtime.

## Important

- The execution role \`${HARNESS_ROLE_ARN}\` is shared across agents you create.
- When creating agents, use this same role ARN for \`executionRoleArn\`.
- MCP servers are the universal adapter — any tool (AWS, GCP, on-prem, SaaS) can be exposed via MCP.
- Always verify an agent was created successfully (status=READY) before reporting back.`;

// --- Create harness ---
console.log("  Creating builder agent harness...");

const harnessConfig = {
  harnessName: "agentcore_hub_builder",
  executionRoleArn: HARNESS_ROLE_ARN,
  model: { bedrockModelConfig: { modelId: MODEL_ID } },
  systemPrompt: [{ text: SYSTEM_PROMPT }],
  tools,
  allowedTools: ["*"],
  truncation: { strategy: "sliding_window", config: { slidingWindow: { messagesCount: 150 } } },
  maxIterations: 75,
  timeoutSeconds: 3600,
};

// Add memory if provided
if (MEMORY_ID) {
  const memoryArn = `arn:aws:bedrock-agentcore:${REGION}:${accountId}:memory/${MEMORY_ID}`;
  harnessConfig.memory = {
    agentCoreMemoryConfiguration: {
      arn: memoryArn,
      messagesCount: 20,
    },
  };
}

console.log(`  Tools: ${tools.map(t => t.name).join(", ")}`);

const res = await agentcore.send(new CreateHarnessCommand(harnessConfig));
const harnessId = res.harness?.harnessId;
console.log(`  Creating agentcore_hub_builder (${harnessId})...`);

// Poll until ready
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const status = await agentcore.send(new GetHarnessCommand({ harnessId }));
  const s = status.harness?.status;
  if (s === "READY") {
    console.log(`  agentcore_hub_builder is READY`);
    await verifyHarness(harnessId);
    printDone(harnessId);
    process.exit(0);
  }
  if (s === "CREATE_FAILED") {
    const reason = status.harness?.failureReason || "unknown";
    console.error(`  Create failed: ${reason}`);
    process.exit(1);
  }
}
console.error("  Timed out waiting for READY");
process.exit(1);

// --- Verification: invoke the harness with a test prompt ---
async function verifyHarness(harnessId) {
  console.log(`\n3/3 Verifying builder agent (test invocation)...\n`);

  const { BedrockAgentCoreClient, InvokeHarnessCommand } = await import(
    "@aws-sdk/client-bedrock-agentcore"
  );
  const dataPlane = new BedrockAgentCoreClient({ region: REGION });
  const harnessArn = `arn:aws:bedrock-agentcore:${REGION}:${accountId}:harness/${harnessId}`;
  // runtimeSessionId must be at least 33 characters per API docs
  const sessionId = `verify-builder-setup-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await dataPlane.send(
        new InvokeHarnessCommand({
          harnessArn,
          runtimeSessionId: sessionId,
          messages: [
            { role: "user", content: [{ text: "Say hello and confirm you are the Builder Agent. One sentence only." }] },
          ],
        })
      );

      // Consume the stream and look for any text
      let responseText = "";
      if (response.stream) {
        for await (const event of response.stream) {
          if (event.contentBlockDelta?.delta?.text) {
            responseText += event.contentBlockDelta.delta.text;
          }
        }
      }

      if (responseText.length > 0) {
        console.log(`  ✓ Builder agent responded (${responseText.length} chars)`);
        console.log(`  Preview: "${responseText.slice(0, 100)}${responseText.length > 100 ? "..." : ""}"`);
        return;
      } else {
        console.log(`  ⚠ Empty response on attempt ${attempt}/3`);
      }
    } catch (err) {
      console.log(`  ⚠ Attempt ${attempt}/3 failed: ${err.name || err.message}`);
      if (attempt < 3) {
        console.log(`  Retrying in 10s (IAM propagation may need time)...`);
        await sleep(10000);
      }
    }
  }

  // Non-fatal — harness is deployed, invocation might just need more IAM propagation time
  console.log(`  ⚠ Could not verify invocation. The harness is deployed but may need a minute for IAM propagation.`);
  console.log(`  You can test manually: visit the Build page and send a message.`);
}

function printDone(id) {
  console.log("\n" + "=".repeat(56));
  console.log("  Builder Agent deployed!\n");
  console.log(`  BUILDER_AGENT_ID=${id}`);
  console.log(`\n  Add to .env.local:`);
  console.log(`    BUILDER_AGENT_ID=${id}`);
  console.log("\n  The Build page will now use this harness for agent creation.");
  console.log("=".repeat(56) + "\n");
}
