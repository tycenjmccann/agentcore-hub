import { test, expect } from "@playwright/test";

/**
 * Delete workflow feature test suite.
 *
 * Uses page.route() to mock API responses (no real backend needed).
 * Covers:
 *  - Delete button visible on terminal-state workflows
 *  - Delete button NOT visible on running workflows
 *  - Click delete → modal opens → confirm → card removed
 *  - Success toast appears
 */

const MOCK_WORKFLOWS = [
  {
    id: "wf-complete-001",
    phase: "complete",
    epicId: "TEAM-100",
    input: { title: "Completed Feature", description: "A completed workflow" },
    startedAt: new Date(Date.now() - 3600000).toISOString(),
    completedAt: new Date().toISOString(),
  },
  {
    id: "wf-running-002",
    phase: "planning",
    epicId: "TEAM-200",
    input: { title: "Running Feature", description: "An active workflow" },
    startedAt: new Date(Date.now() - 1800000).toISOString(),
  },
  {
    id: "wf-error-003",
    phase: "error",
    epicId: "TEAM-300",
    input: { title: "Errored Feature", description: "A failed workflow" },
    startedAt: new Date(Date.now() - 7200000).toISOString(),
  },
];

test.describe("Delete Workflow", () => {
  test.beforeEach(async ({ page }) => {
    // Mock the workflow list API
    await page.route("**/api/workflow/list", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ workflows: MOCK_WORKFLOWS }),
      });
    });

    // Mock DELETE API for workflows
    await page.route(/\/api\/workflow\/wf-[^/]+$/, (route, request) => {
      if (request.method() === "DELETE") {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ deleted: true, workflowId: "wf-complete-001", eventsDeleted: 5 }),
        });
      } else {
        route.continue();
      }
    });
  });

  test("delete button is visible on terminal-state workflows", async ({ page }) => {
    await page.goto("/workflow");
    await page.waitForLoadState("networkidle");

    // Expand sidebar if collapsed
    const expandBtn = page.locator("button[aria-label='Expand workflow history sidebar']");
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
      await page.waitForTimeout(400);
    }

    // Hover over the completed workflow item to reveal the delete button
    const completedItem = page.locator("text=Completed Feature").first();
    await expect(completedItem).toBeVisible({ timeout: 5000 });

    // The item's parent container should have a delete button
    const listItem = completedItem.locator("xpath=ancestor::div[contains(@class, 'group')]").first();
    await listItem.hover();
    await page.waitForTimeout(300);

    const deleteBtn = listItem.locator("button[aria-label*='Delete workflow']");
    await expect(deleteBtn).toBeVisible();
  });

  test("delete button is NOT visible on running workflows", async ({ page }) => {
    await page.goto("/workflow");
    await page.waitForLoadState("networkidle");

    // Expand sidebar
    const expandBtn = page.locator("button[aria-label='Expand workflow history sidebar']");
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
      await page.waitForTimeout(400);
    }

    // The running workflow should NOT have a delete button
    const runningItem = page.locator("text=Running Feature").first();
    await expect(runningItem).toBeVisible({ timeout: 5000 });

    const listItem = runningItem.locator("xpath=ancestor::div[contains(@class, 'cursor-pointer')]").first();
    await listItem.hover();
    await page.waitForTimeout(300);

    const deleteBtn = listItem.locator("button[aria-label*='Delete workflow']");
    await expect(deleteBtn).toHaveCount(0);
  });

  test("delete flow: click → modal → confirm → card removed", async ({ page }) => {
    await page.goto("/workflow");
    await page.waitForLoadState("networkidle");

    // Expand sidebar
    const expandBtn = page.locator("button[aria-label='Expand workflow history sidebar']");
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
      await page.waitForTimeout(400);
    }

    // Find and hover the completed workflow
    const completedItem = page.locator("text=Completed Feature").first();
    await expect(completedItem).toBeVisible({ timeout: 5000 });

    const listItem = completedItem.locator("xpath=ancestor::div[contains(@class, 'group')]").first();
    await listItem.hover();
    await page.waitForTimeout(300);

    // Click the delete button
    const deleteBtn = listItem.locator("button[aria-label*='Delete workflow']");
    await deleteBtn.click();
    await page.waitForTimeout(300);

    // Modal should appear
    const modal = page.locator("[role='alertdialog'][aria-labelledby='delete-modal-title']");
    await expect(modal).toBeVisible();

    // Verify modal content
    await expect(modal.locator("text=Delete Workflow?")).toBeVisible();
    await expect(modal.locator("text=Delete this workflow run?")).toBeVisible();

    // Click "Delete Workflow" confirm button
    const confirmBtn = modal.locator("button").filter({ hasText: /^Delete Workflow$/ });
    await confirmBtn.click();

    // Wait for the modal to close and card to be removed
    await page.waitForTimeout(500);

    // The completed workflow card should be removed from the list
    await expect(page.locator("text=Completed Feature")).toHaveCount(0);

    // Success toast should appear
    await expect(page.locator("text=Workflow deleted")).toBeVisible({ timeout: 3000 });
  });

  test("errored workflow can also be deleted", async ({ page }) => {
    await page.goto("/workflow");
    await page.waitForLoadState("networkidle");

    // Expand sidebar
    const expandBtn = page.locator("button[aria-label='Expand workflow history sidebar']");
    if (await expandBtn.isVisible()) {
      await expandBtn.click();
      await page.waitForTimeout(400);
    }

    // Find and hover the errored workflow
    const erroredItem = page.locator("text=Errored Feature").first();
    await expect(erroredItem).toBeVisible({ timeout: 5000 });

    const listItem = erroredItem.locator("xpath=ancestor::div[contains(@class, 'group')]").first();
    await listItem.hover();
    await page.waitForTimeout(300);

    // Delete button should be visible on hover
    const deleteBtn = listItem.locator("button[aria-label*='Delete workflow']");
    await expect(deleteBtn).toBeVisible();
  });
});
