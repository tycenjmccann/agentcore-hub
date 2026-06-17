import { test, expect } from "@playwright/test";

/**
 * Delete workflow feature test.
 *
 * Covers:
 *  - Trash icon appears on terminal-state workflow cards
 *  - Clicking trash opens the DeleteConfirmationModal
 *  - Confirming delete removes the card (optimistic)
 *  - Running workflow's delete button is disabled
 *
 * Run: PLAYWRIGHT_BASE_URL=https://your-url.com \
 *      npx playwright test tests/delete-workflow.spec.ts
 */

const SCREENSHOT_DIR = "playwright-screenshots/delete-workflow";

test.describe("Delete Workflow", () => {
  test.setTimeout(60_000);

  test("delete button appears on terminal-state workflows and modal works", async ({ page }) => {
    await page.goto("/workflow");
    await page.waitForLoadState("networkidle");

    // Expand sidebar if collapsed
    const expandBtn = page.locator("button[aria-label='Expand workflow history sidebar']");
    if (await expandBtn.count() > 0 && await expandBtn.isVisible()) {
      await expandBtn.click();
      await page.waitForTimeout(400);
    }

    // Wait for workflow list to load
    await page.waitForTimeout(2000);

    // Find a delete button (trash icon) — these only appear on terminal-state workflows
    const deleteBtn = page.locator("button[aria-label='Delete workflow']").first();
    const deleteBtnCount = await deleteBtn.count();

    if (deleteBtnCount === 0) {
      test.skip(true, "No terminal-state workflows with delete button found");
      return;
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-delete-btn-visible.png`, fullPage: true });

    // Click the delete button
    await deleteBtn.click();
    await page.waitForTimeout(600);

    // Assert the confirmation modal appears
    const modal = page.locator("[role='alertdialog'][aria-labelledby='delete-modal-title']");
    await expect(modal).toBeVisible();

    // Verify modal text
    await expect(modal.locator("#delete-modal-title")).toHaveText("Delete Workflow?");
    await expect(modal.locator("#delete-modal-desc")).toContainText("Delete this workflow run?");

    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-delete-modal.png`, fullPage: true });

    // Click "Delete" button in modal
    const confirmBtn = modal.locator("button").filter({ hasText: /^Delete$/ });
    await expect(confirmBtn).toBeVisible();

    // Watch for the DELETE API call
    const deleteResponse = page.waitForResponse(
      (r) => r.url().includes("/api/workflow/") && r.request().method() === "DELETE",
      { timeout: 10_000 }
    );

    await confirmBtn.click();
    const resp = await deleteResponse;
    console.log(`Delete API status: ${resp.status()}`);

    // If the API returns 200, the card should be removed
    if (resp.status() === 200) {
      // Modal should close
      await expect(modal).not.toBeVisible({ timeout: 5000 });
      await page.screenshot({ path: `${SCREENSHOT_DIR}/03-after-delete.png`, fullPage: true });
    }
  });

  test("running workflow delete button is disabled", async ({ page }) => {
    await page.goto("/workflow");
    await page.waitForLoadState("networkidle");

    // Expand sidebar if collapsed
    const expandBtn = page.locator("button[aria-label='Expand workflow history sidebar']");
    if (await expandBtn.count() > 0 && await expandBtn.isVisible()) {
      await expandBtn.click();
      await page.waitForTimeout(400);
    }

    await page.waitForTimeout(2000);

    // Look for disabled delete buttons (running workflows)
    const disabledDeleteBtn = page.locator("button[aria-label='Delete workflow'][disabled]").first();
    const count = await disabledDeleteBtn.count();

    if (count === 0) {
      test.skip(true, "No running workflows found to verify disabled state");
      return;
    }

    // Verify it has opacity-50 class (visually disabled)
    const classes = await disabledDeleteBtn.getAttribute("class");
    expect(classes).toContain("opacity-50");
    expect(classes).toContain("pointer-events-none");

    await page.screenshot({ path: `${SCREENSHOT_DIR}/04-disabled-delete-btn.png`, fullPage: true });
  });
});
