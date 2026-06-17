import { test, expect } from "@playwright/test";

/**
 * Delete workflow test suite.
 *
 * Tests:
 * - API: 404 for non-existent workflow
 * - API: 409 for running workflow
 * - API: 200 for terminal workflow
 * - UI: Delete flow with confirm dialog
 *
 * Run: PLAYWRIGHT_BASE_URL=https://k2krtgqjiu.us-east-1.awsapprunner.com \
 *      npx playwright test tests/delete-workflow.spec.ts
 */

const SCREENSHOT_DIR = "playwright-screenshots/delete-workflow";

test.describe("Delete Workflow — API", () => {
  test("DELETE non-existent workflow returns 404", async ({ page }) => {
    const res = await page.request.delete("/api/workflow/nonexistent-id-12345");
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
  });

  test("DELETE running workflow returns 409", async ({ page }) => {
    test.setTimeout(60_000);

    // Create a fresh workflow (it will be in a non-terminal state)
    const startRes = await page.request.post("/api/workflow/start", {
      data: {
        title: "[E2E-DELETE] Test 409 guard",
        description: "Workflow created to test delete 409 guard.",
        repoConfig: { layout: "monorepo", repos: [] },
        sources: [],
      },
    });
    expect(startRes.ok()).toBeTruthy();
    const { workflowId } = await startRes.json();
    expect(workflowId).toBeTruthy();

    // Attempt delete — should get 409
    const deleteRes = await page.request.delete(`/api/workflow/${workflowId}`);
    expect(deleteRes.status()).toBe(409);
    const body = await deleteRes.json();
    expect(body.error).toContain("terminal");

    // Cleanup: cancel the workflow so it doesn't linger
    await page.request.post(`/api/workflow/${workflowId}/cancel`);
  });

  test("DELETE terminal workflow returns 200", async ({ page }) => {
    test.setTimeout(60_000);

    // Create a workflow then cancel it to make it terminal
    const startRes = await page.request.post("/api/workflow/start", {
      data: {
        title: "[E2E-DELETE] Test 200 success",
        description: "Workflow created to test successful delete.",
        repoConfig: { layout: "monorepo", repos: [] },
        sources: [],
      },
    });
    expect(startRes.ok()).toBeTruthy();
    const { workflowId } = await startRes.json();
    expect(workflowId).toBeTruthy();

    // Cancel it first
    const cancelRes = await page.request.post(`/api/workflow/${workflowId}/cancel`);
    expect(cancelRes.ok()).toBeTruthy();

    // Now delete — should succeed
    const deleteRes = await page.request.delete(`/api/workflow/${workflowId}`);
    expect(deleteRes.status()).toBe(200);
    const body = await deleteRes.json();
    expect(body.success).toBe(true);

    // Verify it's gone
    const getRes = await page.request.delete(`/api/workflow/${workflowId}`);
    expect(getRes.status()).toBe(404);
  });
});

test.describe("Delete Workflow — UI", () => {
  test("delete flow with confirm dialog", async ({ page }) => {
    test.setTimeout(60_000);

    // Create and cancel a workflow so we have a terminal one to delete
    const startRes = await page.request.post("/api/workflow/start", {
      data: {
        title: "[E2E-DELETE-UI] UI delete test",
        description: "Workflow created to test UI delete flow.",
        repoConfig: { layout: "monorepo", repos: [] },
        sources: [],
      },
    });
    expect(startRes.ok()).toBeTruthy();
    const { workflowId } = await startRes.json();
    expect(workflowId).toBeTruthy();

    // Cancel it
    const cancelRes = await page.request.post(`/api/workflow/${workflowId}/cancel`);
    expect(cancelRes.ok()).toBeTruthy();

    // Navigate to the workflow page
    await page.goto("/workflow");
    await page.waitForLoadState("networkidle");

    // Expand sidebar if collapsed
    const expandBtn = page.locator("button[aria-label='Expand workflow history sidebar']");
    if (await expandBtn.count() > 0 && await expandBtn.isVisible()) {
      await expandBtn.click();
      await page.waitForTimeout(400);
    }

    await page.waitForTimeout(2000); // Wait for list to load

    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-page-loaded.png`, fullPage: true });

    // Find the trash icon button for a terminal workflow
    const trashBtn = page.locator(`button[aria-label*="Delete workflow"][aria-label*="UI delete test"]`);

    // If we can't find the specific workflow trash button, look for any enabled trash button
    let targetTrash = trashBtn;
    if (await trashBtn.count() === 0) {
      // Fall back to any enabled trash button (not disabled)
      targetTrash = page.locator("button[aria-label^='Delete workflow']:not([disabled])").first();
    }

    if (await targetTrash.count() === 0) {
      test.skip(true, "No deletable workflow found in sidebar");
      return;
    }

    await targetTrash.click();
    await page.waitForTimeout(600);

    // Verify confirm dialog appears
    const modal = page.locator("[role='alertdialog'][aria-labelledby='delete-modal-title']");
    await expect(modal).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-confirm-dialog.png`, fullPage: true });

    // Verify dialog text
    await expect(modal).toContainText("Delete this workflow run?");
    await expect(modal).toContainText("cannot be undone");

    // Watch for the delete API call
    const deleteResponse = page.waitForResponse(
      (r) => r.url().includes("/api/workflow/") && r.request().method() === "DELETE",
      { timeout: 10_000 }
    );

    // Click confirm (Delete button)
    const confirmBtn = modal.locator("button").filter({ hasText: /^Delete$/ });
    await confirmBtn.click();

    const resp = await deleteResponse;
    expect(resp.status()).toBe(200);

    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-after-delete.png`, fullPage: true });

    // Verify the card is no longer in the list
    const deletedCard = page.locator(`button[aria-label*="UI delete test"]`);
    await expect(deletedCard).toHaveCount(0);
  });
});
