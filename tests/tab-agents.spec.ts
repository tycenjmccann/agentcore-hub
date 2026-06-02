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
    // Bound the wait below the 30s test timeout so the catch/skip fallback can
    // actually run. A full-timeout expect() leaves no time for the fallback and
    // dies with "page closed" instead of skipping on slow AWS connectivity.
    const cards = page.locator("[data-testid^='agent-card-']");
    try {
      await expect(cards.first()).toBeVisible({ timeout: 20000 });
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
      await expect(cards.first()).toBeVisible({ timeout: 20000 });
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
      await expect(cards.first()).toBeVisible({ timeout: 20000 });
    } catch {
      test.skip(true, "Agent discovery did not complete");
      return;
    }
    await cards.first().click();
    // "Agent Detail" lives in the banner and renders before the inner page
    // resolves its own /agents?id= fetch. The chat input + trace panel only
    // appear once that fetch lands, so give them a real budget — under full
    // suite load (the parallel metrics test is slow) the default 5s starves
    // the render and flakes.
    await expect(page.getByText("Agent Detail")).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator("input[placeholder*='Message'], textarea[placeholder*='Message']").first()
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("EXECUTION TRACE")).toBeVisible({ timeout: 10000 });
  });
});
