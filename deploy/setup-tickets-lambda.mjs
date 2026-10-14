#!/usr/bin/env node
/**
 * setup-tickets-lambda.mjs
 *
 * Deploys the ticket-tools Lambda. Branches on TICKET_PROVIDER:
 *   - "jira" (default) — deploys lambda/agentcore-hub-jira/ with JIRA_*
 *     env vars. No tickets table is created (Jira Cloud is the store).
 *   - "dynamodb" — deploys lambda/agentcore-hub-tickets/ + creates the
 *     agentcore-hub-tickets DynamoDB table.
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
 *   TICKET_PROVIDER         — "jira" (default) or "dynamodb"
 *   JIRA_SITE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY
 *                           — required when TICKET_PROVIDER=jira
 *   ARTIFACT_BUCKET         — the artifact bucket the Lambda reads (agent roster,
 *                             completions/*). REQUIRED: derived from the STS account
 *                             when unset (TEAM-5867); the deploy refuses to run without one
 *
 * The role policy, the bucket derivation and the function env are built by the pure
 * module deploy/lib/tickets-lambda-config.mjs, which is unit-tested; this script only
 * sequences the AWS calls. The TICKET_PROVIDER default is deploy/lib/ticket-provider.mjs
 * (TEAM-6087), shared with deploy/workflow-manager/setup-workflow-manager.mjs so the two
 * Node setup scripts can't drift from each other or from the shell deploy scripts' own
 * "jira" default.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { execSync } from "child_process";
import {
  resolveArtifactBucket,
  buildTicketsPolicyStatements,
  buildTicketsLambdaEnv,
} from "./lib/tickets-lambda-config.mjs";
import { resolveTicketProvider, ticketToolsLambdaName } from "./lib/ticket-provider.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Parse CLI args ---
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : null;
}

const REGION = getArg("region") || process.env.AWS_REGION || "us-east-1";
const GATEWAY_ID = getArg("gateway-id");
const TICKET_PROVIDER = resolveTicketProvider(process.env);
if (!["dynamodb", "jira"].includes(TICKET_PROVIDER)) {
  console.error(`✗ TICKET_PROVIDER must be "dynamodb" or "jira" (got "${TICKET_PROVIDER}")`);
  process.exit(1);
}

const TABLE_NAME = getArg("table-name") || "agentcore-hub-tickets";
const PROJECT_KEY =
  getArg("project-key") || process.env.JIRA_PROJECT_KEY || "TEAM";

// Per-provider Lambda config
const LAMBDA_NAME = ticketToolsLambdaName(TICKET_PROVIDER);
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

// TEAM-4739 — the typed gate guard's two OPTIONAL dependencies. NOT derived by
// convention: both are only forwarded when the deploying shell sets them, so an
// install that has never heard of them gets today's env and today's IAM policy back,
// unchanged, on redeploy. Unset ⇒ the guard is inert (every probe indeterminate, i.e.
// every gate close admitted and stamped) rather than a wall.
const PIPELINE_TOOLS_LAMBDA = process.env.PIPELINE_TOOLS_LAMBDA || "";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "";
// TEAM-5716 — the orchestrator's workflows table (deploy/config.sh exports it). Same
// rule: forwarded only when set. Unset ⇒ the claim-generation park fence is inert.
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "";

// gateway-id is optional — if not provided, skip gateway target registration

// --- Dynamic imports ---
const { DynamoDBClient, CreateTableCommand, DescribeTableCommand, DescribeTimeToLiveCommand, UpdateTimeToLiveCommand } = await import("@aws-sdk/client-dynamodb");
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

// TEAM-5867 P1: the artifact bucket is resolved HERE, after STS has answered, not from an
// AWS_ACCOUNT_ID that is usually unset in a bare shell. It used to be computed at import
// time, never recomputed, forwarded only when truthy and the Lambda env replaced wholesale
// - so a standalone re-run stripped ARTIFACT_BUCKET from the live function. Fail before
// Step 1: nothing below (table, role policy, function) may be touched without a bucket.
let ARTIFACT_BUCKET;
try {
  ARTIFACT_BUCKET = resolveArtifactBucket({ accountId, region: REGION });
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}

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
console.log(`   Bucket:      ${ARTIFACT_BUCKET}`);
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

  // TEAM-5712: TTL on `ttl`, so create_ticket's client_token lock rows
  // (IDEMP#<token>) expire. No ticket row carries `ttl`, so this cannot expire a
  // ticket. Idempotent: left alone when already on; a table whose TTL is already
  // on ANOTHER attribute only warns — lock rows then never expire, but every
  // read path filters them, so that is clutter, not a fault.
  const ttl = await ddb.send(new DescribeTimeToLiveCommand({ TableName: TABLE_NAME }));
  const ttlDesc = ttl.TimeToLiveDescription || {};
  const ttlOn = ttlDesc.TimeToLiveStatus === "ENABLED" || ttlDesc.TimeToLiveStatus === "ENABLING";
  if (ttlOn && ttlDesc.AttributeName === "ttl") {
    console.log(`   ✓ TTL already enabled on "ttl"`);
  } else if (ttlOn) {
    console.warn(`   ⚠ TTL is enabled on "${ttlDesc.AttributeName}", not "ttl" — client_token lock rows will not expire`);
  } else {
    await ddb.send(new UpdateTimeToLiveCommand({
      TableName: TABLE_NAME,
      TimeToLiveSpecification: { Enabled: true, AttributeName: "ttl" },
    }));
    console.log(`   ✓ TTL enabled on "ttl" (client_token lock rows)`);
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

// Attach inline policy. The statements are built by buildTicketsPolicyStatements
// (deploy/lib/tickets-lambda-config.mjs) and unit-tested there; see its doc comment for
// what each grants and why. In short: CloudWatch Logs; DynamoDB (dynamodb provider only);
// s3:GetObject on the artifact bucket's objects (roster + completions/<ticket>.json, the
// body the Done guard reads since TEAM-4706/TEAM-4757); and - TEAM-5867 - s3:ListBucket on
// the bucket itself, unconditioned, so S3 reports a MISSING completion record as 404
// rather than 403. The twins' guard (TEAM-5832) admits a recordless Done only on 404 and
// refuses on anything else, so without ListBucket no human gate could ever close. The
// pipeline probe / events / workflows statements stay conditional on their env vars.
// scripts/verify-infra.sh asserts both S3 grants are still present on the live role.
const policyStatements = buildTicketsPolicyStatements({
  provider: TICKET_PROVIDER,
  region: REGION,
  accountId,
  tableName: TABLE_NAME,
  artifactBucket: ARTIFACT_BUCKET,
  pipelineToolsLambda: PIPELINE_TOOLS_LAMBDA,
  eventsTable: EVENTS_TABLE,
  workflowsTable: WORKFLOWS_TABLE,
});

await iam.send(
  new PutRolePolicyCommand({
    RoleName: ROLE_NAME,
    PolicyName: "TicketsLambdaAccess",
    PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: policyStatements }),
  })
);
console.log(
  `   ✓ Policy attached (${TICKET_PROVIDER === "dynamodb" ? "DynamoDB + " : ""}CloudWatch Logs + S3 read + S3 list (404 on a missing record)${TICKET_PROVIDER === "jira" ? " + ticket-claims/* create claim" : ""}${PIPELINE_TOOLS_LAMBDA ? " + pipeline probe invoke" : ""}${EVENTS_TABLE ? " + events PutItem" : ""}${WORKFLOWS_TABLE ? " + workflows claim read" : ""})`
);

// ============================================================
// Step 3: Deploy Lambda
// ============================================================
console.log("\n3/5 Deploying Lambda function...");

// Zip the Lambda code (per-provider source dir). fix-contract.mjs (TEAM-4121
// FR-8) and gate-contract.mjs (TEAM-4739) are local imports of index.mjs in BOTH
// providers — omitting either kills the function at cold start with
// ERR_MODULE_NOT_FOUND. scripts/check-lambda-zip-manifest.sh validates this line
// against index.mjs's actual import closure; run it before changing the line.
const lambdaDir = join(__dirname, "..", "lambda", LAMBDA_SOURCE_DIR);
const zipPath = `/tmp/${LAMBDA_NAME}.zip`;
execSync(`cd "${lambdaDir}" && zip -j "${zipPath}" index.mjs fix-contract.mjs gate-contract.mjs`, {
  stdio: "pipe",
});
const zipBuffer = readFileSync(zipPath);

// The env is built by buildTicketsLambdaEnv (deploy/lib/tickets-lambda-config.mjs).
// ARTIFACT_BUCKET is ALWAYS set (TEAM-5867 P1 - UpdateFunctionConfiguration below replaces
// the whole env, so a conditional spread is what let a re-run strip it). The optional vars
// (FIX_TICKET_CONTRACT, PIPELINE_TOOLS_LAMBDA, EVENTS_TABLE, WORKFLOWS_TABLE) are forwarded
// ONLY when set in the deploying shell, in BOTH provider arms, so an install that has never
// heard of one keeps the code default - the twins must be configurable the same way.
const lambdaEnvVars = buildTicketsLambdaEnv({
  provider: TICKET_PROVIDER,
  region: REGION,
  tableName: TABLE_NAME,
  projectKey: PROJECT_KEY,
  artifactBucket: ARTIFACT_BUCKET,
  jira: { siteUrl: JIRA_SITE_URL, email: JIRA_EMAIL, apiToken: JIRA_API_TOKEN },
  fixTicketContract: process.env.FIX_TICKET_CONTRACT || "",
  pipelineToolsLambda: PIPELINE_TOOLS_LAMBDA,
  eventsTable: EVENTS_TABLE,
  workflowsTable: WORKFLOWS_TABLE,
});

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
        Runtime: "nodejs22.x",
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
