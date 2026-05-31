import { test, expect } from "@playwright/test";

test.describe("Build Tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/build");
  });

  test("renders builder chat interface", async ({ page }) => {
    await expect(page.getByText("Agent Builder Chat")).toBeVisible();
  });

  test("shows harness mode indicator", async ({ page }) => {
    await expect(page.getByText("Harness Mode")).toBeVisible();
  });

  test("description input is visible and accepts text", async ({ page }) => {
    const input = page.locator("[data-testid='build-description-input']");
    await expect(input).toBeVisible();
    await input.fill("Build me a customer support agent that handles refunds");
    await expect(input).toHaveValue("Build me a customer support agent that handles refunds");
  });

  test("submit button is visible and enabled after input", async ({ page }) => {
    const btn = page.locator("[data-testid='build-submit-btn']");
    await expect(btn).toBeVisible();
    // Fill input to enable
    await page.locator("[data-testid='build-description-input']").fill("test agent");
    await expect(btn).toBeEnabled();
  });

  test("deploy button is present", async ({ page }) => {
    await expect(page.locator("[data-testid='deploy-agent-btn']")).toBeVisible();
  });

  test("chat area is present for conversation", async ({ page }) => {
    await expect(page.locator("[data-testid='builder-messages']")).toBeVisible();
  });
});
