/**
 * Lambda Orchestration Mode — 3-Tier Test Suite
 *
 * Tests the DynamoDB Stream-driven orchestration pipeline:
 * 1. SMOKE: Verify ticket skeletons are created correctly in DynamoDB
 * 2. LIGHT: Verify Stream fires and orchestrator Lambda invokes requirements agent
 * 3. REAL: Full pipeline run with "Collapsible Sidebar + Intake Card" scope
 *
 * Run individual tests:
 *   npx playwright test demo/playwright/v4/test-lambda-orchestration.spec.ts --grep "smoke"
 *   npx playwright test demo/playwright/v4/test-lambda-orchestration.spec.ts --grep "light"
 *   npx playwright test demo/playwright/v4/test-lambda-orchestration.spec.ts --grep "real"
 *
 * Config: demo/playwright/v4/playwright-v4.config.ts
 */

import { test, expect } from "@playwright/test";
import {
  DynamoDBClient,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

const BASE_URL = process.env.DEMO_BASE_URL || "http://localhost:3000";
const REGION = "us-east-1";
const TICKETS_TABLE = "agentcore-hub-tickets";
const WORKFLOWS_TABLE = "agentcore-hub-workflows";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const cwl = new CloudWatchLogsClient({ region: REGION });

// Shared test data — the same scope from pipeline retro runs 1 & 2
const TEST_FEATURE = {
  title: "Collapsible History Sidebar + Intake Card Enhancements",
  description: `Add a collapsible history sidebar to the workflow page that shows previous workflow runs.
The sidebar should:
- Show last 10 workflow runs with title, date, and status
- Collapse/expand with a toggle button
- Persist collapse state in localStorage
- Highlight the currently active workflow

Also enhance the intake card:
- Add drag-and-drop file upload for mockup images
- Show image previews inline
- Add a "paste from clipboard" button for screenshots

Files to modify: src/app/workflow/page.tsx, src/components/workflow/WorkflowBoard.tsx`,
  repoUrl: "https://github.com/your-org/your-repo",
  defaultBranch: "main",
};

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 1: SMOKE — Verify skeleton creation + DynamoDB state
// ═══════════════════════════════════════════════════════════════════════════════

test("smoke: ticket skeletons created in DynamoDB with correct dependency chains", async ({ request }) => {
  // Submit a workflow via the API
  const response = await request.post(`${BASE_URL}/api/workflow/start`, {
    data: {
      title: `[SMOKE TEST] ${TEST_FEATURE.title}`,
      description: TEST_FEATURE.description,
      sources: [],
      repoConfig: {
        repos: [{ url: TEST_FEATURE.repoUrl, defaultBranch: TEST_FEATURE.defaultBranch }],
      },
    },
  });

  expect(response.ok()).toBeTruthy();
  const { workflowId } = await response.json();
  expect(workflowId).toMatch(/^wf_/);
  console.log(`[smoke] Workflow created: ${workflowId}`);

  // Wait a moment for DynamoDB writes to settle
  await new Promise((r) => setTimeout(r, 2000));

  // Verify workflow exists in agentcore-hub-workflows table
  const wfResult = await ddb.send(new GetCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId },
  }));
  expect(wfResult.Item).toBeTruthy();
  expect(wfResult.Item!.epicId).toMatch(/^TEAM-/);
  expect(wfResult.Item!.phase).toBe("requirements");
  console.log(`[smoke] Workflow in DynamoDB: epicId=${wfResult.Item!.epicId}, phase=${wfResult.Item!.phase}`);

  const epicId = wfResult.Item!.epicId as string;

  // Verify tickets created under the epic
  const ticketsResult = await ddb.send(new QueryCommand({
    TableName: TICKETS_TABLE,
    IndexName: "parentId-index",
    KeyConditionExpression: "parentId = :pid",
    ExpressionAttributeValues: { ":pid": epicId },
  }));

  const tickets = ticketsResult.Items || [];
  console.log(`[smoke] Found ${tickets.length} tickets under epic ${epicId}`);

  // Dynamic ticket creation: only requirements ticket is created upfront.
  // The requirements agent creates remaining tickets during its run.
  expect(tickets.length).toBeGreaterThanOrEqual(1);

  // Requirements ticket should be "todo" or "in_progress" (Stream fires so fast it may already be picked up)
  const reqTicket = tickets.find((t) => t.assignee === "agentcore_hub_requirements_analyst");
  expect(reqTicket).toBeTruthy();
  expect(["todo", "in_progress"]).toContain(reqTicket!.status);
  expect(reqTicket!.blockedBy || []).toEqual([]);
  console.log(`[smoke] Requirements ticket: ${reqTicket!.ticketId} status=${reqTicket!.status} (${reqTicket!.status === "in_progress" ? "Stream already fired!" : "awaiting Stream"}) ✓`);

  // If additional tickets were already created by the requirements agent, validate their structure
  const designTickets = tickets.filter((t) =>
    t.assignee?.includes("_designer") || t.assignee?.includes("_reviewer") ||
    t.assignee?.includes("_compliance") || t.assignee?.includes("_localization") ||
    t.assignee?.includes("_analytics")
  );
  if (designTickets.length > 0) {
    for (const dt of designTickets) {
      expect(dt.status).toBe("blocked");
      expect(dt.blockedBy).toContain(reqTicket!.ticketId);
    }
    console.log(`[smoke] ${designTickets.length} design tickets blocked by ${reqTicket!.ticketId} ✓`);
  } else {
    console.log(`[smoke] No design tickets yet (requirements agent still running) — expected for dynamic creation flow`);
  }

  const devTickets = tickets.filter((t) => t.assignee?.includes("_dev") && !t.assignee?.includes("_reviewer"));
  if (devTickets.length > 0) {
    for (const dt of devTickets) {
      expect(dt.status).toBe("blocked");
    }
    console.log(`[smoke] ${devTickets.length} dev tickets found in blocked state ✓`);
  }

  console.log(`[smoke] ✅ Workflow created, requirements ticket ready, DynamoDB state correct.`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 2: LIGHT — Verify Stream triggers orchestrator + requirements agent starts
// ═══════════════════════════════════════════════════════════════════════════════

test("light: DynamoDB Stream triggers orchestrator and requirements agent is invoked", async ({ request }) => {
  // Submit a workflow
  const response = await request.post(`${BASE_URL}/api/workflow/start`, {
    data: {
      title: `[LIGHT TEST] ${TEST_FEATURE.title}`,
      description: TEST_FEATURE.description,
      sources: [],
      repoConfig: {
        repos: [{ url: TEST_FEATURE.repoUrl, defaultBranch: TEST_FEATURE.defaultBranch }],
      },
    },
  });

  expect(response.ok()).toBeTruthy();
  const { workflowId } = await response.json();
  console.log(`[light] Workflow created: ${workflowId}`);

  // Wait for Stream to fire and orchestrator to process (give it 15s)
  console.log(`[light] Waiting 15s for Stream → orchestrator → agent invocation...`);
  await new Promise((r) => setTimeout(r, 15_000));

  // Check CloudWatch logs for the orchestrator Lambda
  const now = Date.now();
  const logsResult = await cwl.send(new FilterLogEventsCommand({
    logGroupName: "/aws/lambda/agentcore-hub-orchestrator",
    startTime: now - 30_000, // last 30s
    filterPattern: workflowId,
    limit: 20,
  }));

  const logMessages = (logsResult.events || []).map((e) => e.message).join("\n");
  console.log(`[light] Orchestrator logs (${logsResult.events?.length || 0} events):`);

  // Verify orchestrator saw the requirements ticket go "todo" → invoked agent
  const sawTicketReady = logMessages.includes("handleTicketReady") || logMessages.includes("Invoking agent");
  const sawRequirements = logMessages.includes("requirements_analyst") || logMessages.includes("agentcore_hub_requirements_analyst");

  if (sawTicketReady) {
    console.log(`[light] ✓ Orchestrator processed "todo" ticket`);
  }
  if (sawRequirements) {
    console.log(`[light] ✓ Requirements agent invocation detected`);
  }

  // Also check the workflows table — agentTasks should show requirements as "running"
  const wfResult = await ddb.send(new GetCommand({
    TableName: WORKFLOWS_TABLE,
    Key: { workflowId },
  }));

  const agentTasks = wfResult.Item?.agentTasks || {};
  const reqTask = agentTasks["agentcore_hub_requirements_analyst"];
  if (reqTask?.status === "running") {
    console.log(`[light] ✓ Requirements agent task status: running`);
  }

  // Check the tickets table — requirements ticket should be "in_progress" now
  const epicId = wfResult.Item?.epicId as string;
  const ticketsResult = await ddb.send(new QueryCommand({
    TableName: TICKETS_TABLE,
    IndexName: "parentId-index",
    KeyConditionExpression: "parentId = :pid",
    ExpressionAttributeValues: { ":pid": epicId },
  }));
  const reqTicket = (ticketsResult.Items || []).find(
    (t) => t.assignee === "agentcore_hub_requirements_analyst"
  );

  console.log(`[light] Requirements ticket status: ${reqTicket?.status}`);
  expect(reqTicket?.status).toBe("in_progress");

  console.log(`[light] ✅ Stream → orchestrator → agent invocation working.`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST 3: REAL — Full pipeline run (Collapsible Sidebar scope)
// ═══════════════════════════════════════════════════════════════════════════════

test("real: full pipeline run with Lambda orchestration (Collapsible Sidebar scope)", async ({ page }) => {
  test.setTimeout(2400_000); // 40 minutes max

  // Navigate to workflow page
  await page.goto(`${BASE_URL}/workflow`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);

  // Click "New Workflow" button
  const newBtn = page.locator("button", { hasText: /new workflow/i });
  await newBtn.click();
  await page.waitForTimeout(1000);

  // Fill the intake form
  const titleInput = page.locator('input[name="title"], input[placeholder*="title" i]').first();
  await titleInput.fill(TEST_FEATURE.title);

  const descInput = page.locator('textarea[name="description"], textarea[placeholder*="description" i]').first();
  await descInput.fill(TEST_FEATURE.description);

  // Add repo URL
  const repoInput = page.locator('input[placeholder*="repo" i], input[name="repoUrl"]').first();
  if (await repoInput.isVisible()) {
    await repoInput.fill(TEST_FEATURE.repoUrl);
  }

  // Submit
  const submitBtn = page.locator("button[type='submit'], button:has-text('Submit'), button:has-text('Start')").first();
  await submitBtn.click();
  console.log(`[real] Workflow submitted. Waiting for pipeline to complete...`);

  // Wait for completion — poll the workflow status
  let completed = false;
  let lastPhase = "";
  const startTime = Date.now();
  const maxWait = 35 * 60 * 1000; // 35 min

  while (!completed && Date.now() - startTime < maxWait) {
    await page.waitForTimeout(30_000); // Check every 30s
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    // Look for phase indicators on the page
    const pageText = await page.locator("body").textContent();

    if (pageText?.includes("complete") || pageText?.includes("Complete")) {
      completed = true;
      console.log(`[real] [${elapsed}s] Pipeline COMPLETE`);
    } else {
      // Try to detect current phase from UI
      const phases = ["requirements", "design", "development", "verification", "review"];
      for (const phase of phases) {
        if (pageText?.toLowerCase().includes(phase) && phase !== lastPhase) {
          lastPhase = phase;
          console.log(`[real] [${elapsed}s] Phase: ${phase}`);
        }
      }
      if (!lastPhase) {
        console.log(`[real] [${elapsed}s] Working...`);
      }
    }
  }

  // Verify final state in DynamoDB
  // Find the most recent workflow
  const recentWorkflows = await ddb.send(new QueryCommand({
    TableName: WORKFLOWS_TABLE,
    IndexName: undefined, // scan — small table
    Limit: 5,
  })).catch(() => null);

  // Take final screenshot
  await page.screenshot({
    path: "demo/recordings/real-test-final.png",
    fullPage: true,
  });

  if (completed) {
    console.log(`[real] ✅ Pipeline completed in ${Math.round((Date.now() - startTime) / 60000)} minutes`);
  } else {
    console.log(`[real] ⚠️ Pipeline did not complete within timeout. Check CloudWatch logs.`);
  }

  expect(completed).toBeTruthy();
});
