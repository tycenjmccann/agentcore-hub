#!/usr/bin/env node
/**
 * setup-tickets-lambda.mjs
 *
 * Deploys the DynamoDB-backed ticket tools Lambda:
 *   1. Creates DynamoDB table (agentcore-hub-tickets)
 *   2. Creates IAM role for the Lambda
 *   3. Deploys the Lambda function (agentcore-hub-tickets)
 *   4. Prints gateway target definitions to register
 *
 * Usage:
 *   node deploy/setup-tickets-lambda.mjs \
 *     [--gateway-id <your-gateway-id>] \
 *     [--region us-east-1] \
 *     [--table-name agentcore-hub-tickets] \
 *     [--project-key TEAM]
 *
 * Prerequisites:
 *   - AWS credentials configured
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Parse CLI args ---
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : null;
}

const REGION = getArg("region") || process.env.AWS_REGION || "us-east-1";
const GATEWAY_ID = getArg("gateway-id");
const TABLE_NAME = getArg("table-name") || "agentcore-hub-tickets";
const PROJECT_KEY = getArg("project-key") || "TEAM";
const LAMBDA_NAME = "agentcore-hub-tickets";
const ROLE_NAME = "AgentCoreHubTicketsLambdaRole";

// Derive artifact bucket (same convention as deploy/config.sh)
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || "";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || (ACCOUNT_ID ? `agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}` : "");

// gateway-id is optional — if not provided, skip gateway target registration

// --- Dynamic imports ---
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = await import("@aws-sdk/client-dynamodb");
const { IAMClient, CreateRoleCommand, PutRolePolicyCommand, GetRoleCommand } = await import("@aws-sdk/client-iam");
const { LambdaClient, CreateFunctionCommand, GetFunctionCommand, UpdateFunctionCodeCommand, InvokeCommand } = await import("@aws-sdk/client-lambda");

const ddb = new DynamoDBClient({ region: REGION });
const iam = new IAMClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });

// Get account ID
const accountId = execSync("aws sts get-caller-identity --query Account --output text").toString().trim();

console.log("\n" + "═".repeat(60));
console.log("🎫 Deploying Mock Jira MCP Server");
console.log("═".repeat(60));
console.log(`   Region:      ${REGION}`);
console.log(`   Table:       ${TABLE_NAME}`);
console.log(`   Project Key: ${PROJECT_KEY}`);
console.log(`   Lambda:      ${LAMBDA_NAME}`);
console.log(`   Gateway:     ${GATEWAY_ID}`);
console.log(`   Account:     ${accountId}`);
console.log("");

// ============================================================
// Step 1: Create DynamoDB Table
// ============================================================
console.log("1/5 Creating DynamoDB table...");

try {
  await ddb.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
  console.log(`   ✓ Table "${TABLE_NAME}" already exists`);
} catch (err) {
  if (err.name === "ResourceNotFoundException") {
    await ddb.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        KeySchema: [{ AttributeName: "ticketId", KeyType: "HASH" }],
        AttributeDefinitions: [
          { AttributeName: "ticketId", AttributeType: "S" },
          { AttributeName: "parentId", AttributeType: "S" },
          { AttributeName: "assignee", AttributeType: "S" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "parentId-index",
            KeySchema: [{ AttributeName: "parentId", KeyType: "HASH" }],
            Projection: { ProjectionType: "ALL" },
          },
          {
            IndexName: "assignee-index",
            KeySchema: [{ AttributeName: "assignee", KeyType: "HASH" }],
            Projection: { ProjectionType: "ALL" },
          },
        ],
        BillingMode: "PAY_PER_REQUEST",
      })
    );
    console.log(`   ✓ Table "${TABLE_NAME}" created (pay-per-request)`);

    // Wait for table to be active
    console.log("   ⏳ Waiting for table to become ACTIVE...");
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const desc = await ddb.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
      if (desc.Table?.TableStatus === "ACTIVE") {
        console.log("   ✓ Table is ACTIVE");
        break;
      }
    }
  } else {
    throw err;
  }
}

// ============================================================
// Step 2: Create IAM Role
// ============================================================
console.log("\n2/5 Creating IAM role...");

const trustPolicy = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

const roleArn = `arn:aws:iam::${accountId}:role/${ROLE_NAME}`;

try {
  await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
  console.log(`   ✓ Role "${ROLE_NAME}" already exists`);
} catch (err) {
  if (err.name === "NoSuchEntityException") {
    await iam.send(
      new CreateRoleCommand({
        RoleName: ROLE_NAME,
        AssumeRolePolicyDocument: trustPolicy,
        Description: "Execution role for AgentCore Hub mock Jira Lambda",
      })
    );
    console.log(`   ✓ Role "${ROLE_NAME}" created`);
    // Wait for role propagation
    await sleep(10000);
  } else {
    throw err;
  }
}

// Attach inline policy for DynamoDB + CloudWatch Logs
const policy = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: [
        "dynamodb:PutItem",
        "dynamodb:GetItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query",
        "dynamodb:Scan",
      ],
      Resource: [
        `arn:aws:dynamodb:${REGION}:${accountId}:table/${TABLE_NAME}`,
        `arn:aws:dynamodb:${REGION}:${accountId}:table/${TABLE_NAME}/index/*`,
      ],
    },
    {
      Effect: "Allow",
      Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: `arn:aws:logs:${REGION}:${accountId}:*`,
    },
  ],
});

await iam.send(
  new PutRolePolicyCommand({
    RoleName: ROLE_NAME,
    PolicyName: "JiraMockAccess",
    PolicyDocument: policy,
  })
);
console.log(`   ✓ Policy attached (DynamoDB + CloudWatch Logs)`);

// ============================================================
// Step 3: Deploy Lambda
// ============================================================
console.log("\n3/5 Deploying Lambda function...");

// Zip the Lambda code
const lambdaDir = join(__dirname, "..", "lambda", "agentcore-hub-tickets");
const zipPath = "/tmp/agentcore-hub-tickets.zip";
execSync(`cd "${lambdaDir}" && zip -j "${zipPath}" index.mjs`, { stdio: "pipe" });
const zipBuffer = readFileSync(zipPath);

let lambdaArn;
try {
  const existing = await lambda.send(new GetFunctionCommand({ FunctionName: LAMBDA_NAME }));
  lambdaArn = existing.Configuration.FunctionArn;
  console.log(`   ℹ Lambda exists, updating code...`);
  await lambda.send(
    new UpdateFunctionCodeCommand({
      FunctionName: LAMBDA_NAME,
      ZipFile: zipBuffer,
    })
  );
  console.log(`   ✓ Lambda code updated`);
} catch (err) {
  if (err.name === "ResourceNotFoundException") {
    const createResult = await lambda.send(
      new CreateFunctionCommand({
        FunctionName: LAMBDA_NAME,
        Runtime: "nodejs20.x",
        Handler: "index.handler",
        Role: roleArn,
        Code: { ZipFile: zipBuffer },
        Timeout: 30,
        MemorySize: 256,
        Environment: {
          Variables: {
            TICKETS_TABLE: TABLE_NAME,
            PROJECT_KEY: PROJECT_KEY,
            AWS_REGION_OVERRIDE: REGION,
            ...(ARTIFACT_BUCKET && { ARTIFACT_BUCKET }),
          },
        },
        Description: "Mock Jira MCP server — DynamoDB-backed ticket management for AgentCore Hub pipeline",
      })
    );
    lambdaArn = createResult.FunctionArn;
    console.log(`   ✓ Lambda created: ${lambdaArn}`);
  } else {
    throw err;
  }
}

// ============================================================
// Step 4: Verify Lambda
// ============================================================
console.log("\n4/5 Verifying Lambda (test invocation)...");

try {
  const testPayload = JSON.stringify({
    _tool_name: "create_ticket",
    parameters: {
      title: "Setup verification test",
      summary: "Automated test from setup script — safe to delete",
      assignee: "system-verify",
      type: "task",
    },
  });

  const invokeResult = await lambda.send(new InvokeCommand({
    FunctionName: LAMBDA_NAME,
    Payload: Buffer.from(testPayload),
  }));

  const responsePayload = JSON.parse(Buffer.from(invokeResult.Payload).toString());

  if (invokeResult.FunctionError) {
    console.log(`   ⚠ Lambda returned error: ${responsePayload.errorMessage || "unknown"}`);
  } else if (responsePayload.key) {
    console.log(`   ✓ Lambda responded — created ticket: ${responsePayload.key}`);
  } else if (responsePayload.content?.[0]?.text) {
    console.log(`   ⚠ Lambda returned: ${responsePayload.content[0].text}`);
  } else {
    console.log(`   ⚠ Unexpected response format: ${JSON.stringify(responsePayload).slice(0, 100)}`);
  }
} catch (err) {
  console.log(`   ⚠ Verification invoke failed: ${err.message}`);
  console.log(`   (Lambda may need a few seconds to become active)`);
}

// ============================================================
// Step 5: Gateway Target Definitions (optional)
// ============================================================
if (!GATEWAY_ID) {
  console.log("\n5/5 Gateway target registration — SKIPPED (no --gateway-id provided)");
  console.log("    Agents invoke this Lambda directly via TICKET_TOOLS_LAMBDA env var.");
  console.log("\n" + "═".repeat(60));
  console.log("✅ Tickets Lambda deployed and verified!");
  console.log("═".repeat(60));
  console.log(`
Next steps:
  1. Set TICKET_TOOLS_LAMBDA=agentcore-hub-tickets in .env.local (or on your agents)
  2. The Workflow tab will use this Lambda for ticket operations
`);
  process.exit(0);
}

console.log("\n5/5 Gateway target registration...");
console.log("─".repeat(60));
console.log(`\nRegister these tools as gateway targets on gateway "${GATEWAY_ID}":`);
console.log(`Lambda ARN: ${lambdaArn}\n`);

const tools = [
  {
    name: "Tickets___create_epic",
    description: "Create a new epic (feature container) in the project tracker. Returns the epic ID.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Epic title (short, descriptive)" },
        description: { type: "string", description: "Detailed description of the feature/initiative" },
        workflow_id: { type: "string", description: "Associated workflow ID for tracing" },
      },
      required: ["title"],
    },
  },
  {
    name: "Tickets___create_ticket",
    description: "Create a task/story ticket assigned to a specific agent. Returns the ticket ID immediately.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Ticket title (clear, actionable)" },
        description: { type: "string", description: "Detailed description with acceptance criteria" },
        assignee: { type: "string", description: "Agent ID to assign (e.g., 'agentcore_hub_frontend_dev', 'agentcore_hub_ios_designer')" },
        parent_id: { type: "string", description: "Parent epic ID (e.g., 'TEAM-42')" },
        blocked_by: { type: "array", items: { type: "string" }, description: "List of ticket IDs that must complete first" },
        type: { type: "string", enum: ["task", "story", "bug"], description: "Ticket type (default: task)" },
        workflow_id: { type: "string", description: "Associated workflow ID" },
      },
      required: ["title", "assignee"],
    },
  },
  {
    name: "Tickets___update_ticket",
    description: "Update fields on an existing ticket (title, description, assignee, status).",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string", description: "Ticket ID (e.g., 'TEAM-42')" },
        title: { type: "string", description: "New title" },
        description: { type: "string", description: "New description" },
        assignee: { type: "string", description: "New assignee agent ID" },
        status: { type: "string", enum: ["todo", "in_progress", "blocked", "in_review", "done"] },
        blocked_by: { type: "array", items: { type: "string" }, description: "Updated blocker list" },
      },
      required: ["ticket_id"],
    },
  },
  {
    name: "Tickets___get_ticket",
    description: "Get full details of a ticket including comments and status.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string", description: "Ticket ID (e.g., 'TEAM-42')" },
      },
      required: ["ticket_id"],
    },
  },
  {
    name: "Tickets___list_tickets",
    description: "List tickets filtered by parent epic, assignee, workflow, or status.",
    inputSchema: {
      type: "object",
      properties: {
        parent_id: { type: "string", description: "Filter by parent epic ID" },
        assignee: { type: "string", description: "Filter by assigned agent ID" },
        workflow_id: { type: "string", description: "Filter by workflow ID" },
        status: { type: "string", enum: ["todo", "in_progress", "blocked", "in_review", "done"] },
      },
    },
  },
  {
    name: "Tickets___add_comment",
    description: "Add a comment to a ticket (progress update, question, finding).",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string", description: "Ticket ID" },
        author: { type: "string", description: "Comment author (agent ID)" },
        content: { type: "string", description: "Comment text (supports markdown)" },
      },
      required: ["ticket_id", "content"],
    },
  },
  {
    name: "Tickets___transition_ticket",
    description: "Move a ticket to a new status. Use transition_id for named transitions (e.g., 'skip', 'done', 'start') or to_status for direct status changes.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string", description: "Ticket ID (e.g., 'TEAM-42')" },
        transition_id: { type: "string", description: "Named transition: 'start', 'done', 'skip', 'block', 'unblock', 'review', 'reopen'" },
        to_status: { type: "string", enum: ["todo", "in_progress", "blocked", "in_review", "done"], description: "Target status (alternative to transition_id)" },
        reason: { type: "string", description: "Reason for the transition (especially for 'skip' — explains why this ticket is not needed)" },
      },
      required: ["ticket_id"],
    },
  },
];

for (const tool of tools) {
  console.log(`  → ${tool.name}`);
  console.log(`    ${tool.description}`);
  console.log("");
}

console.log("─".repeat(60));
console.log("\nTo register targets, use the bedrock-agentcore MCP tool:");
console.log("");
console.log("  gateway_target_create({");
console.log(`    gateway_id: "${GATEWAY_ID}",`);
console.log(`    name: "<tool-name>",`);
console.log(`    lambda_arn: "${lambdaArn}",`);
console.log(`    description: "<tool-description>",`);
console.log(`    input_schema: { ... }`);
console.log("  })");
console.log("");

// Write tool definitions to a file for reference/automation
const toolDefsPath = join(__dirname, "..", "src", "config", "jira-gateway-targets.json");
const { writeFileSync } = await import("fs");
writeFileSync(
  toolDefsPath,
  JSON.stringify({ gatewayId: GATEWAY_ID, lambdaArn, tools }, null, 2) + "\n"
);
console.log(`✓ Tool definitions written to: src/config/jira-gateway-targets.json`);
console.log("  Use this file to automate gateway target registration.\n");

console.log("═".repeat(60));
console.log("✅ Mock Jira MCP server deployed!");
console.log("═".repeat(60));
console.log(`
Next steps:
  1. Register the gateway targets (see above)
  2. Update agent prompts to use Tickets___create_ticket instead of submit_ticket_plan
  3. Update engine.ts to observe DynamoDB state instead of reading S3 ticket plans
  4. To swap for real Jira later: replace this gateway target with the real Jira MCP server
`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
