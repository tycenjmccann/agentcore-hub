#!/usr/bin/env node
/**
 * setup-tickets-lambda.mjs
 *
 * Deploys the ticket-tools Lambda. Branches on TICKET_PROVIDER:
 *   - "dynamodb" (default) — deploys lambda/agentcore-hub-tickets/ +
 *     creates the agentcore-hub-tickets DynamoDB table.
 *   - "jira" — deploys lambda/agentcore-hub-jira/ with JIRA_* env vars.
 *     No tickets table is created (Jira Cloud is the store).
 *
 * Both Lambdas expose the identical tool interface (Tickets___create_ticket,
 * etc.) so agents don't know or care which backend is in use.
 *
 * Usage:
 *   node deploy/setup-tickets-lambda.mjs \
 *     [--gateway-id <your-gateway-id>] \
 *     [--region us-east-1] \
 *     [--table-name agentcore-hub-tickets] \
 *     [--project-key TEAM]
 *
 * Reads from environment:
 *   TICKET_PROVIDER         — "dynamodb" or "jira"
 *   JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY
 *                           — required when TICKET_PROVIDER=jira
 *   ARTIFACT_BUCKET         — passed to the Lambda for the shared agent roster
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
const TICKET_PROVIDER = (process.env.TICKET_PROVIDER || "dynamodb").toLowerCase();
if (!["dynamodb", "jira"].includes(TICKET_PROVIDER)) {
  console.error(`✗ TICKET_PROVIDER must be "dynamodb" or "jira" (got "${TICKET_PROVIDER}")`);
  process.exit(1);
}

const TABLE_NAME = getArg("table-name") || "agentcore-hub-tickets";
const PROJECT_KEY =
  getArg("project-key") || process.env.JIRA_PROJECT_KEY || "TEAM";

// Per-provider Lambda config
const LAMBDA_NAME =
  TICKET_PROVIDER === "jira" ? "agentcore-hub-jira" : "agentcore-hub-tickets";
const LAMBDA_SOURCE_DIR = LAMBDA_NAME; // matches lambda/<dir>
const ROLE_NAME =
  TICKET_PROVIDER === "jira"
    ? "AgentCoreHubJiraLambdaRole"
    : "AgentCoreHubTicketsLambdaRole";

// Jira creds (only required when TICKET_PROVIDER=jira)
const JIRA_SITE_URL = process.env.JIRA_SITE_URL || "";
const JIRA_EMAIL = process.env.JIRA_EMAIL || "";
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || "";
if (TICKET_PROVIDER === "jira") {
  const missing = [];
  if (!JIRA_SITE_URL) missing.push("JIRA_SITE_URL");
  if (!JIRA_EMAIL) missing.push("JIRA_EMAIL");
  if (!JIRA_API_TOKEN) missing.push("JIRA_API_TOKEN");
  if (missing.length) {
    console.error(`✗ TICKET_PROVIDER=jira but missing env vars: ${missing.join(", ")}`);
    console.error("  Set them in .env.local (or your shell) and re-run.");
    process.exit(1);
  }
}

// Derive artifact bucket (same convention as deploy/config.sh)
const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || "";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || (ACCOUNT_ID ? `agentcore-hub-artifacts-${ACCOUNT_ID}-${REGION}` : "");

// gateway-id is optional — if not provided, skip gateway target registration

// --- Dynamic imports ---
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand } = await import("@aws-sdk/client-dynamodb");
const { IAMClient, CreateRoleCommand, PutRolePolicyCommand, GetRoleCommand } = await import("@aws-sdk/client-iam");
const {
  LambdaClient,
  CreateFunctionCommand,
  GetFunctionCommand,
  UpdateFunctionCodeCommand,
  InvokeCommand,
  waitUntilFunctionUpdatedV2,
  waitUntilFunctionActiveV2,
} = await import("@aws-sdk/client-lambda");

const ddb = new DynamoDBClient({ region: REGION });
const iam = new IAMClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });

// Get account ID
const accountId = execSync("aws sts get-caller-identity --query Account --output text").toString().trim();

console.log("\n" + "═".repeat(60));
console.log(
  TICKET_PROVIDER === "jira"
    ? "🎫 Deploying Jira Cloud Ticket Lambda"
    : "🎫 Deploying DynamoDB Ticket Lambda"
);
console.log("═".repeat(60));
console.log(`   Provider:    ${TICKET_PROVIDER}`);
console.log(`   Region:      ${REGION}`);
if (TICKET_PROVIDER === "dynamodb") {
  console.log(`   Table:       ${TABLE_NAME}`);
}
if (TICKET_PROVIDER === "jira") {
  console.log(`   Jira site:   ${JIRA_SITE_URL}`);
}
console.log(`   Project Key: ${PROJECT_KEY}`);
console.log(`   Lambda:      ${LAMBDA_NAME}`);
console.log(`   Gateway:     ${GATEWAY_ID}`);
console.log(`   Account:     ${accountId}`);
console.log("");

// ============================================================
// Step 1: Create DynamoDB Table  (DynamoDB provider only)
// ============================================================
if (TICKET_PROVIDER === "dynamodb") {
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
} else {
  console.log("1/5 DynamoDB table — SKIPPED (TICKET_PROVIDER=jira; tickets live in Jira Cloud)");
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

// Attach inline policy. DynamoDB statement is only needed for the dynamodb
// provider; both providers need CloudWatch Logs and S3 read for the agent
// roster artifact.
const policyStatements = [
  {
    Effect: "Allow",
    Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
    Resource: `arn:aws:logs:${REGION}:${accountId}:*`,
  },
];
if (TICKET_PROVIDER === "dynamodb") {
  policyStatements.push({
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
  });
}
if (ARTIFACT_BUCKET) {
  policyStatements.push({
    Effect: "Allow",
    Action: ["s3:GetObject"],
    Resource: `arn:aws:s3:::${ARTIFACT_BUCKET}/*`,
  });
}

await iam.send(
  new PutRolePolicyCommand({
    RoleName: ROLE_NAME,
    PolicyName: "TicketsLambdaAccess",
    PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: policyStatements }),
  })
);
console.log(
  `   ✓ Policy attached (${TICKET_PROVIDER === "dynamodb" ? "DynamoDB + " : ""}CloudWatch Logs${ARTIFACT_BUCKET ? " + S3 read" : ""})`
);

// ============================================================
// Step 3: Deploy Lambda
// ============================================================
console.log("\n3/5 Deploying Lambda function...");

// Zip the Lambda code (per-provider source dir). fix-contract.mjs (TEAM-4121
// FR-8) is a local import of index.mjs in BOTH providers — omitting it kills the
// function at cold start with ERR_MODULE_NOT_FOUND.
const lambdaDir = join(__dirname, "..", "lambda", LAMBDA_SOURCE_DIR);
const zipPath = `/tmp/${LAMBDA_NAME}.zip`;
execSync(`cd "${lambdaDir}" && zip -j "${zipPath}" index.mjs fix-contract.mjs`, { stdio: "pipe" });
const zipBuffer = readFileSync(zipPath);

// FIX_TICKET_CONTRACT is forwarded ONLY when set in the deploying shell, so an
// existing install that has never heard of it keeps the code default (off) and
// its config is unchanged by a redeploy.
const lambdaEnvVars =
  TICKET_PROVIDER === "jira"
    ? {
        JIRA_SITE_URL,
        JIRA_EMAIL,
        JIRA_API_TOKEN,
        JIRA_PROJECT_KEY: PROJECT_KEY,
        AWS_REGION_OVERRIDE: REGION,
        ...(ARTIFACT_BUCKET && { ARTIFACT_BUCKET }),
        ...(process.env.FIX_TICKET_CONTRACT && { FIX_TICKET_CONTRACT: process.env.FIX_TICKET_CONTRACT }),
      }
    : {
        TICKETS_TABLE: TABLE_NAME,
        PROJECT_KEY,
        AWS_REGION_OVERRIDE: REGION,
        ...(ARTIFACT_BUCKET && { ARTIFACT_BUCKET }),
        ...(process.env.FIX_TICKET_CONTRACT && { FIX_TICKET_CONTRACT: process.env.FIX_TICKET_CONTRACT }),
      };

const lambdaDescription =
  TICKET_PROVIDER === "jira"
    ? "Ticket tools Lambda — Jira Cloud-backed for AgentCore Hub pipeline"
    : "Ticket tools Lambda — DynamoDB-backed for AgentCore Hub pipeline";

let lambdaArn;
try {
  const existing = await lambda.send(new GetFunctionCommand({ FunctionName: LAMBDA_NAME }));
  lambdaArn = existing.Configuration.FunctionArn;
  console.log(`   ℹ Lambda exists, updating code + env...`);
  await lambda.send(
    new UpdateFunctionCodeCommand({
      FunctionName: LAMBDA_NAME,
      ZipFile: zipBuffer,
    })
  );
  // Wait for the code update to settle before issuing the configuration update.
  // Lambda returns 409 ResourceConflictException if a second update is sent
  // while the function is still in "InProgress" from the first one.
  await waitUntilFunctionUpdatedV2(
    { client: lambda, maxWaitTime: 120 },
    { FunctionName: LAMBDA_NAME }
  );
  // Update env vars too — they may have changed between runs (e.g., new Jira token)
  const { UpdateFunctionConfigurationCommand } = await import("@aws-sdk/client-lambda");
  await lambda.send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: LAMBDA_NAME,
      Environment: { Variables: lambdaEnvVars },
    })
  );
  await waitUntilFunctionUpdatedV2(
    { client: lambda, maxWaitTime: 120 },
    { FunctionName: LAMBDA_NAME }
  );
  console.log(`   ✓ Lambda code + env updated`);
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
        Environment: { Variables: lambdaEnvVars },
        Description: lambdaDescription,
      })
    );
    lambdaArn = createResult.FunctionArn;
    console.log(`   ✓ Lambda created: ${lambdaArn}`);
    // New Lambdas start in "Pending" — wait until Active before invoking.
    await waitUntilFunctionActiveV2(
      { client: lambda, maxWaitTime: 120 },
      { FunctionName: LAMBDA_NAME }
    );
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
  1. Set TICKET_TOOLS_LAMBDA=${LAMBDA_NAME} in .env.local (or on your agents)
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
        phase: { type: "string", description: "Agent phase this fix ticket re-verifies (e.g. 'development', 'ship'). Set on a fix ticket to the ORIGINATING upstream phase so completion gates that phase until the fix closes." },
        spawned_by: {
          type: "object",
          description: "Provenance for a QA/review fix ticket — makes the run's completion guard refuse to close while this fix is open. Only set when filing a fix.",
          properties: {
            kind: { type: "string", enum: ["qa_fix", "codex_fix", "review_fix"], description: "Which pipeline spawned this fix." },
            qaTicketId: { type: "string", description: "Originating QA verification ticket (for kind 'qa_fix')." },
            codexTicketId: { type: "string", description: "Originating code-review ticket (for kind 'codex_fix')." },
            gateTicketId: { type: "string", description: "Originating review-gate ticket (for kind 'review_fix')." },
          },
          required: ["kind"],
        },
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
    name: "Tickets___get_issue",
    description: "Get full details of a ticket including its status and all comments. Use to read a gate/escalation ticket's status and parse human DECISION: lines from its comments.",
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
