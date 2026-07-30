import { test, expect } from "@playwright/test";

/**
 * Workflow Manager panel + chat drawer.
 *
 * Fully mocked via page.route() — no backend. Covers:
 *  - analysis panel renders verdict, score, metric cards, findings, recs
 *  - "Run Analysis" empty state → POST /analyze
 *  - chat drawer opens from the floating button and streams an SSE reply
 */

const WF_ID = "wf-complete-001";

const MOCK_WORKFLOWS = [
  {
    id: WF_ID,
    phase: "complete",
    epicId: "TEAM-100",
    input: { title: "Completed Feature", description: "A completed workflow" },
    workflowDefId: "software-delivery",
    startedAt: new Date(Date.now() - 3600000).toISOString(),
    completedAt: new Date().toISOString(),
  },
];

const MOCK_ANALYSIS = {
  workflowId: WF_ID,
  analysisId: "1719946800000-a3f9",
  schemaVersion: 1,
  workflowDefId: "software-delivery",
  epicId: "TEAM-100",
  analyzedAt: new Date().toISOString(),
  trigger: "auto",
  runOutcome: "complete",
  model: "us.anthropic.claude-opus-4-6-v1",
  s3Prefix: "workflows/wf-complete-001/analysis/1719946800000-a3f9/",
  metrics: {
    startedAt: new Date(Date.now() - 3600000).toISOString(),
    completedAt: new Date().toISOString(),
    totalDurationMs: 3600000,
    phases: [],
    agentTasks: [],
    humanReviews: [],
    humanWaitTotalMs: 900000,
    changeRequests: { count: 2, cycles: [] },
    fixTickets: { count: 1, ticketIds: ["TEAM-105"] },
    nudgeCount: 0,
    managerInterventions: [],
    errors: [],
    tokens: { totalInput: 120000, totalOutput: 30000, byAgent: {} },
    evalSummaries: [],
    counts: { tickets: 6, events: 40, artifacts: 12, completions: 5 },
    dataQuality: { ticketProvider: "dynamodb", missingSignals: [], notes: [] },
  },
  scores: { overall: 78, planning: 82, execution: 74, reviewEfficiency: 65, reworkDiscipline: 80 },
  verdict: "Solid delivery with review-cycle drag.",
  findings: [
    { title: "Design review blocked progress for 15m", kind: "bottleneck", severity: "high", phase: "design", evidence: "Gate TEAM-109 waited 15m (humanWaitTotalMs=900000)." },
    { title: "Clean requirements decomposition", kind: "success", severity: "low", phase: "requirements", evidence: "6 tickets, no orphaned dependencies." },
  ],
  recommendations: [
    { title: "Make the design gate non-blocking", priority: "P1", type: "gate-config", target: "design", description: "Switch onReject to hold-free async review.", expectedImpact: "Removes ~15m of idle wait per run." },
  ],
  trend: { priorRunsCompared: 0, deltas: { totalDurationMs: null, humanWaitTotalMs: null, changeRequests: null, overallScore: null }, notes: "First analyzed run for this definition." },
  summaryMarkdown: "## Summary\n\nThe workflow completed successfully with two change requests and one fix cycle. The design review gate was the main bottleneck.\n\n### Bottlenecks\n\n- Design review: 15 minutes of idle wait.",
};

const MOCK_STATE = {
  ...MOCK_WORKFLOWS[0],
  workflowId: WF_ID,
  repoConfig: { repos: [] },
  input: { title: "Completed Feature", description: "A completed workflow", workflowDefId: "software-delivery", sources: [] },
  agentTasks: {},
  messages: [],
  humanNotifications: [],
};

async function mockBoardEndpoints(page: import("@playwright/test").Page) {
  await page.route("**/api/workflow/list", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ workflows: MOCK_WORKFLOWS }) }));
  await page.route("**/api/workflow/*/state**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_STATE) }));
  await page.route("**/api/workflow/*/events", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [] }) }));
  await page.route("**/api/workflow/*/tickets", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tickets: [] }) }));
  await page.route("**/api/workflow/*/agent-output**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ output: "" }) }));
  await page.route("**/api/workflow/*/watch", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ watch: true }) }));
}

async function selectWorkflow(page: import("@playwright/test").Page) {
  await page.goto(`/workflow`);
  await page.waitForLoadState("networkidle");
  const expandBtn = page.locator("button[aria-label='Expand workflow history sidebar']");
  if (await expandBtn.isVisible().catch(() => false)) await expandBtn.click();
  await page.getByText("Completed Feature").first().click();
}

test.describe("Workflow Manager panel", () => {
  test("renders analysis: verdict, score, metric cards, findings, recommendations", async ({ page }) => {
    await mockBoardEndpoints(page);
    await page.route("**/api/workflow/*/analysis", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ latest: MOCK_ANALYSIS, history: [MOCK_ANALYSIS], trend: [] }) }));

    await selectWorkflow(page);

    await expect(page.getByText("Workflow Manager").first()).toBeVisible();
    await expect(page.getByText("Solid delivery with review-cycle drag.")).toBeVisible();
    await expect(page.getByText("78").first()).toBeVisible();
    await expect(page.getByText("Change requests")).toBeVisible();
    await expect(page.getByText("Design review blocked progress for 15m")).toBeVisible();
    await expect(page.getByText("Make the design gate non-blocking")).toBeVisible();
  });

  test("empty state shows Run Analysis and posts to /analyze", async ({ page }) => {
    await mockBoardEndpoints(page);
    await page.route("**/api/workflow/*/analysis", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ latest: null, history: [], trend: [] }) }));

    let analyzeCalled = false;
    await page.route("**/api/workflow/*/analyze", (r) => {
      analyzeCalled = true;
      r.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ status: "analyzing", workflowId: WF_ID }) });
    });

    await selectWorkflow(page);
    const runBtn = page.getByRole("button", { name: "Run Analysis" });
    await expect(runBtn).toBeVisible();
    await runBtn.click();
    await expect.poll(() => analyzeCalled).toBe(true);
  });
});

test.describe("Workflow Manager chat", () => {
  test("floating button opens the drawer and streams a reply", async ({ page }) => {
    await mockBoardEndpoints(page);
    await page.route("**/api/workflow/*/analysis", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ latest: null, history: [], trend: [] }) }));

    // SSE mock: shared harness schema — two text chunks + done.
    await page.route("**/api/workflow-manager/chat", (r) => {
      const body =
        `data: ${JSON.stringify({ type: "text", content: "Your slowest phase is " })}\n\n` +
        `data: ${JSON.stringify({ type: "text", content: "**design review**." })}\n\n` +
        `data: ${JSON.stringify({ type: "done" })}\n\n`;
      r.fulfill({ status: 200, contentType: "text/event-stream", body });
    });

    await page.goto(`/workflow`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Workflow Manager" }).click();
    await expect(page.getByPlaceholder("Ask the Workflow Manager…")).toBeVisible();

    await page.getByRole("button", { name: "What's our biggest bottleneck across recent runs?" }).click();
    await expect(page.getByText("design review", { exact: false })).toBeVisible();
  });
});
