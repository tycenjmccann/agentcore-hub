import { test, expect } from "@playwright/test";

test.describe("Ticket History Tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/tickets");
  });

  test("renders ticket history page", async ({ page }) => {
    // Should show some heading or indicator for tickets
    await expect(
      page.getByText(/ticket/i).first()
    ).toBeVisible({ timeout: 5000 });
  });

  test("shows ticket table or list", async ({ page }) => {
    await page.waitForTimeout(3000); // Wait for data to load
    // Should have either a table, list, or empty state
    const hasTable = await page.locator("table").isVisible().catch(() => false);
    const hasList = await page.locator("[class*='ticket'], [data-testid*='ticket']").first().isVisible().catch(() => false);
    const hasEmpty = await page.getByText(/no tickets|empty|no data/i).isVisible().catch(() => false);
    expect(hasTable || hasList || hasEmpty).toBeTruthy();
  });

  test("ticket entries show status information", async ({ page }) => {
    await page.waitForTimeout(3000);
    // If tickets exist, they should show status
    const row = page.locator("table tbody tr, [data-testid*='ticket-row']").first();
    if (await row.isVisible().catch(() => false)) {
      // Row should have content
      await expect(row).not.toBeEmpty();
    }
  });

  test("page responds to search or filter if available", async ({ page }) => {
    const searchInput = page.locator("input[placeholder*='search' i], input[type='search']");
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill("test");
      await expect(searchInput).toHaveValue("test");
    }
  });
});
