import { test, expect } from "@playwright/test";

test.describe("Agents Tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/agents");
  });

  test("renders agents page", async ({ page }) => {
    // Page should load with either agent cards or a loading/discovery state
    await expect(
      page.getByText("Discovering agents...").or(page.locator("[data-testid^='agent-card-']").first())
    ).toBeVisible({ timeout: 5000 });
  });

  test("shows agent cards when discovery completes", async ({ page }) => {
    // Wait up to 30s for agent discovery (depends on AWS connectivity)
    const cards = page.locator("[data-testid^='agent-card-']");
    try {
      await expect(cards.first()).toBeVisible({ timeout: 30000 });
      const count = await cards.count();
      expect(count).toBeGreaterThan(0);
      console.log(`Found ${count} agent cards`);
    } catch {
      // If discovery doesn't complete, verify the loading state is shown
      await expect(page.getByText("Discovering agents...")).toBeVisible();
      test.skip(true, "Agent discovery did not complete - AWS connectivity issue");
    }
  });

  test("agent card is clickable", async ({ page }) => {
    const cards = page.locator("[data-testid^='agent-card-']");
    try {
      await expect(cards.first()).toBeVisible({ timeout: 30000 });
    } catch {
      test.skip(true, "Agent discovery did not complete");
      return;
    }
    await cards.first().click();
    await expect(page).toHaveURL(/\/agents\/.+/);
  });

  test("agent detail page shows chat interface", async ({ page }) => {
    const cards = page.locator("[data-testid^='agent-card-']");
    try {
      await expect(cards.first()).toBeVisible({ timeout: 30000 });
    } catch {
      test.skip(true, "Agent discovery did not complete");
      return;
    }
    await cards.first().click();
    await expect(page.getByText("Agent Detail")).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator("input[placeholder*='Message'], textarea[placeholder*='Message']").first()
    ).toBeVisible();
    await expect(page.getByText("EXECUTION TRACE")).toBeVisible();
  });
});
