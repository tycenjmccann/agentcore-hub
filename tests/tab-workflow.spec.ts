import { test, expect, type Page } from "@playwright/test";

/**
 * Comprehensive workflow page test suite.
 *
 * Covers every interactive element on /workflow:
 *  - Workflow list sidebar (search, select, history toggle)
 *  - Intake form (title, description, model selector, submit)
 *  - Status header (phase indicator)
 *  - Cancel workflow flow (button + modal)
 *  - Replay scrubber (when replay events present)
 *  - Phase boxes (5 phases)
 *  - Agent items (click → output panel)
 *  - Ticket pills (TicketStatusBadge → TicketDetailModal)
 *  - S3 output items (S3 icon → S3ArtifactsModal)
 *  - Agent output panel (close)
 *
 * Strategy: pick a recent COMPLETE workflow for read-only interactions
 * (clicks should not mutate state). Cancel flow uses a fresh workflow.
 *
 * Run: PLAYWRIGHT_BASE_URL=https://k2krtgqjiu.us-east-1.awsapprunner.com \
 *      npx playwright test tests/tab-workflow.spec.ts
 */

// Playwright wipes test-results/ between runs, so write screenshots to a sibling dir.
const SCREENSHOT_DIR = "playwright-screenshots/workflow";

// Helper: pick a recent completed workflow id for read-only interactions
async function pickCompleteWorkflow(page: Page): Promise<string | null> {
  const res = await page.request.get("/api/workflow/list");
  if (!res.ok()) return null;
  const { workflows } = await res.json();
  const complete = (workflows || []).find((w: { phase: string }) => w.phase === "complete");
  return complete?.id ?? null;
}

test.describe("Workflow Page — basics", () => {
  test("page loads with sidebar and main area", async ({ page }) => {
    await page.goto("/workflow");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("body")).toContainText(/workflow|pipeline|new|history/i);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-page-loaded.png`, fullPage: true });
  });

  test("workflow list loads from API", async ({ page }) => {
    await page.goto("/workflow");
    const listRes = await page.request.get("/api/workflow/list");
    expect(listRes.ok()).toBeTruthy();
    const data = await listRes.json();
    expect(Array.isArray(data.workflows)).toBeTruthy();
    console.log(`Workflow list returned ${data.workflows.length} items`);
  });

  test("history sidebar toggle works", async ({ page }) => {
    await page.goto("/workflow");
    await page.waitForLoadState("networkidle");
    // Look for the chevron toggle near the sidebar
    const toggleBtn = page.locator("button").filter({ has: page.locator("svg.lucide-chevron-left, svg.lucide-chevron-right") }).first();
    if (await toggleBtn.count() === 0) {
      test.skip(true, "No history toggle found");
      return;
    }
    await toggleBtn.click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-sidebar-toggled.png`, fullPage: true });
  });
});

// Helper: open the intake form. The sidebar is collapsed by default,
// so the only "+" button initially visible is the empty-state "New Workflow"
// button OR the sidebar's Plus icon (only after expanding). We try both.
async function openIntakeForm(page: Page) {
  // Empty state button (visible when no workflow selected)
  const emptyStateBtn = page.locator("button", { hasText: /^New Workflow$/ });
  if (await emptyStateBtn.count() > 0 && await emptyStateBtn.first().isVisible()) {
    await emptyStateBtn.first().click();
    return;
  }
  // Otherwise expand the sidebar and use the "+" icon button
  const expandBtn = page.locator("button[aria-label='Expand workflow history sidebar']");
  if (await expandBtn.count() > 0) {
    await expandBtn.click();
    await page.waitForTimeout(300);
  }
  const plusBtn = page.locator("button[title='New Workflow']");
  await plusBtn.click();
}

test.describe("Workflow Page — intake form", () => {
  test("clicking new opens intake form with all fields", async ({ page }) => {
    await page.goto("/workflow");
    await page.waitForLoadState("networkidle");

    await openIntakeForm(page);
    await page.waitForTimeout(800);

    const titleInput = page.locator("input[placeholder*='profile photo carousel']");
    const descInput = page.locator("textarea[placeholder*='Describe the feature']");
    await expect(titleInput).toBeVisible();
    await expect(descInput).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-intake-open.png`, fullPage: true });
  });

  test("intake form accepts input and shows model selector", async ({ page }) => {
    await page.goto("/workflow");
    await page.waitForLoadState("networkidle");

    await openIntakeForm(page);
    await page.waitForTimeout(800);

    const titleInput = page.locator("input[placeholder*='profile photo carousel']");
    const descInput = page.locator("textarea[placeholder*='Describe the feature']");
    await titleInput.fill("[TEST] Feature title");
    await descInput.fill("Test description");
    await expect(titleInput).toHaveValue("[TEST] Feature title");

    // Model selector should appear (after async load)
    const modelSelect = page.locator("#model-select");
    await expect(modelSelect).toBeVisible({ timeout: 8000 });

    // Source URL input
    const sourceInput = page.locator("input[placeholder*='s3://bucket/key']");
    await expect(sourceInput).toBeVisible();

    // Repo layout radios
    const monorepoRadio = page.locator("input[name='repo-layout'][value='monorepo']");
    await expect(monorepoRadio).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/04-intake-filled.png`, fullPage: true });
  });
});

test.describe("Workflow Page — selected workflow interactions", () => {
  let workflowId: string | null = null;

  test.beforeEach(async ({ page }) => {
    workflowId = await pickCompleteWorkflow(page);
    if (!workflowId) {
      test.skip(true, "No completed workflow to interact with");
      return;
    }
    await page.goto(`/workflow?id=${workflowId}`);
    await page.waitForLoadState("networkidle");
    // Wait for board to render
    await page.waitForSelector(".pipeline-viz", { timeout: 15_000 });
  });

  test("status header reflects phase", async ({ page }) => {
    const header = page.locator(".pipeline-status-header");
    await expect(header).toBeVisible();
    const text = await header.textContent();
    expect(text).toMatch(/complete|cancelled|error|in progress/i);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/10-status-header.png` });
  });

  test("five phase boxes render", async ({ page }) => {
    const phases = page.locator(".agent-box");
    await expect(phases).toHaveCount(5, { timeout: 10_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/11-phase-boxes.png`, fullPage: true });
  });

  test("agent item click expands AgentOutputPanel", async ({ page }) => {
    // Find first agent item (anything with .item.cursor-pointer that's an agent row)
    const agentItem = page.locator(".item.cursor-pointer").filter({ has: page.locator("img.svc-icon") }).first();
    const count = await agentItem.count();
    if (count === 0) {
      test.skip(true, "No agent items rendered");
      return;
    }
    await agentItem.click();
    await page.waitForTimeout(1200);
    // AgentOutputPanel renders as a fixed-position pop-out
    // Look for any close button or the panel's distinctive content
    await page.screenshot({ path: `${SCREENSHOT_DIR}/12-agent-output-panel.png`, fullPage: true });

    // Close panel (Escape or click outside)
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  });

  test("ticket pill click opens TicketDetailModal", async ({ page }) => {
    // Ticket pills are rendered by TicketStatusBadge inside agent items
    // They wrap in a span with onClick — find by data-ticket-id or by status-related class
    const ticketPill = page.locator(".item span").filter({ hasText: /done|in progress|to do|ready|blocked|review/i }).first();
    if (await ticketPill.count() === 0) {
      test.skip(true, "No ticket pills visible");
      return;
    }
    await ticketPill.click();
    await page.waitForTimeout(1500);
    // Modal: TicketDetailModal — look for any modal-like element
    const modalShown = await page.locator("[role='dialog'], [aria-labelledby*='ticket'], .fixed").filter({ hasText: /TEAM-/i }).count();
    expect(modalShown).toBeGreaterThan(0);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/13-ticket-modal.png`, fullPage: true });
    // Close modal
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  });

  test("S3 output click opens S3ArtifactsModal", async ({ page }) => {
    // S3 outputs have class .item.clickable and an S3 icon
    const s3Output = page.locator(".item.clickable").first();
    if (await s3Output.count() === 0) {
      test.skip(true, "No S3 output items present");
      return;
    }
    await s3Output.click();
    await page.waitForTimeout(1200);
    const modal = page.locator("[role='dialog'][aria-labelledby='s3-modal-title']");
    await expect(modal).toBeVisible({ timeout: 5000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/14-s3-modal.png`, fullPage: true });
    // Close
    await page.locator("button[aria-label='Close artifacts panel']").click();
    await page.waitForTimeout(400);
  });
});

test.describe("Workflow Page — cancel flow", () => {
  test("cancel button + modal flow on a fresh workflow", async ({ page }) => {
    test.setTimeout(60_000);

    // Create a new throwaway workflow to test cancel
    // Payload must match WorkflowInput shape (top-level: title, description, repoConfig, sources)
    const startRes = await page.request.post("/api/workflow/start", {
      data: {
        title: "[E2E-CANCEL] Test cancel flow",
        description: "Workflow created solely to test the cancel UI; will be cancelled immediately.",
        repoConfig: { layout: "monorepo", repos: [] },
        sources: [],
      },
    });
    if (!startRes.ok()) {
      console.log(`workflow/start failed: ${startRes.status()} ${await startRes.text().catch(() => "")}`);
    }
    expect(startRes.ok()).toBeTruthy();
    const { workflowId } = await startRes.json();
    expect(workflowId).toBeTruthy();
    console.log(`Created throwaway workflow ${workflowId}`);

    await page.goto(`/workflow?id=${workflowId}`);
    await page.waitForSelector(".pipeline-viz", { timeout: 15_000 });

    // Cancel button should be visible for non-terminal workflow
    const cancelBtn = page.locator("button[aria-label='Cancel workflow']");
    await expect(cancelBtn).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/20-cancel-btn-visible.png` });

    await cancelBtn.click();
    await page.waitForTimeout(600);

    // Cancel modal: role=alertdialog
    const modal = page.locator("[role='alertdialog'][aria-labelledby='cancel-modal-title']");
    await expect(modal).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/21-cancel-modal.png` });

    // Click the destructive red "Cancel Workflow" button (the second button in the modal)
    // Use exact text match to avoid colliding with the h2 modal title
    const confirmBtn = modal.locator("button").filter({ hasText: /^Cancel Workflow$/ });
    await expect(confirmBtn).toHaveCount(1);

    // Watch for the cancel API call so we know when it resolves
    const cancelResponse = page.waitForResponse(
      (r) => r.url().includes(`/api/workflow/${workflowId}/cancel`) && r.request().method() === "POST",
      { timeout: 10_000 }
    );
    await confirmBtn.click();
    const resp = await cancelResponse;
    console.log(`Cancel API status: ${resp.status()}`);
    expect(resp.ok()).toBeTruthy();

    // Small settle delay before reading state
    await page.waitForTimeout(500);

    // Verify backend status flipped to cancelled
    const stateRes = await page.request.get(`/api/workflow/${workflowId}/state`);
    expect(stateRes.ok()).toBeTruthy();
    const state = await stateRes.json();
    expect(state.phase).toBe("cancelled");
    console.log(`Workflow ${workflowId} successfully cancelled`);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/22-after-cancel.png`, fullPage: true });
  });
});

test.describe("Workflow Page — replay scrubber", () => {
  test("scrubber controls render for completed workflow with events", async ({ page }) => {
    const workflowId = await pickCompleteWorkflow(page);
    if (!workflowId) {
      test.skip(true, "No completed workflow available");
      return;
    }
    await page.goto(`/workflow?id=${workflowId}`);
    await page.waitForLoadState("networkidle");
    await page.waitForSelector(".pipeline-viz", { timeout: 15_000 });

    // Wait a moment for replay events to populate
    await page.waitForTimeout(3500);

    const scrubber = page.locator("input.replay-scrubber");
    const scrubberCount = await scrubber.count();
    if (scrubberCount === 0) {
      test.skip(true, "No replay events for this workflow");
      return;
    }

    await expect(scrubber.first()).toBeVisible();
    const replayBtn = page.locator("button.replay-btn");
    await expect(replayBtn).toBeVisible();
    const speedSelect = page.locator("select.replay-speed");
    await expect(speedSelect).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/30-scrubber.png`, fullPage: true });

    // Toggle speed
    await speedSelect.selectOption("10");
    await page.waitForTimeout(300);

    // Click play/pause
    await replayBtn.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/31-scrubber-playing.png` });
    await replayBtn.click();
    await page.waitForTimeout(300);
  });
});
