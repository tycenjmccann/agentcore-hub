import { test, expect } from "@playwright/test";

test.describe("AgentCore Hub - UI Smoke Tests", () => {
  test("Dashboard renders with agent activity metrics", async ({ page }) => {
    await page.goto("/");
    // h1 renders NEXT_PUBLIC_BRAND_NAME (installer-configurable), falling back
    // to "AgentCore Hub". Read the same source the app does — a custom brand is
    // a healthy app, not a bug.
    const expectedBrand = process.env.NEXT_PUBLIC_BRAND_NAME || "AgentCore Hub";
    await expect(page.locator("h1")).toContainText(expectedBrand);
    // Navigation
    await expect(page.locator("[data-testid='nav-dashboard']")).toBeVisible();
    await expect(page.locator("[data-testid='nav-agents']")).toBeVisible();
    await expect(page.locator("[data-testid='nav-build']")).toBeVisible();
    // Agent Activity metrics
    await expect(page.getByText("Invocations")).toBeVisible();
    await expect(page.getByText("Tokens", { exact: true })).toBeVisible();
    await expect(page.getByText("Active Agents")).toBeVisible();
    // Agent Performance table
    await expect(page.getByText("Agent Performance")).toBeVisible();
  });

  test("Dashboard loads real agent data", async ({ page }) => {
    await page.goto("/");
    // Wait for agents to load (replaces "Discovering agents...")
    await expect(page.getByText("Discovering agents...")).not.toBeVisible({ timeout: 15000 });
    // Should show agent table with real data
    await expect(page.locator("table")).toBeVisible();
    // At least one agent should be listed
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  });

  test("Agents page shows discovered agents", async ({ page }) => {
    await page.goto("/agents");
    // Wait for agent cards to load
    await expect(page.getByText("Discovering agents...")).not.toBeVisible({ timeout: 15000 });
    // Should have at least one agent card
    await expect(page.locator("[data-testid^='agent-card-']").first()).toBeVisible();
  });

  test("Agent detail page renders chat interface", async ({ page }) => {
    await page.goto("/agents");
    // Wait for agent cards to load
    await expect(page.getByText("Discovering agents...")).not.toBeVisible({ timeout: 15000 });
    // Click first agent card
    await page.locator("[data-testid^='agent-card-']").first().click();
    // Should show agent detail with chat input and trace panel
    await expect(page.getByText("Agent Detail")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("input[placeholder*='Message'], textarea[placeholder*='Message']").first()).toBeVisible();
    await expect(page.getByText("EXECUTION TRACE")).toBeVisible();
  });

  test("Build page shows builder chat interface", async ({ page }) => {
    await page.goto("/build");
    await expect(page.getByText("Agent Builder Chat")).toBeVisible();
    await expect(page.getByText("Harness Mode")).toBeVisible();
    await expect(page.locator("[data-testid='build-description-input']")).toBeVisible();
    await expect(page.locator("[data-testid='build-submit-btn']")).toBeVisible();
    await expect(page.locator("[data-testid='deploy-agent-btn']")).toBeVisible();
  });

  test("Build page - input accepts text", async ({ page }) => {
    await page.goto("/build");
    const input = page.locator("[data-testid='build-description-input']");
    await input.fill("I need a backend API agent");
    await expect(input).toHaveValue("I need a backend API agent");
    await expect(page.locator("[data-testid='build-submit-btn']")).toBeEnabled();
  });

  test("Navigation between pages works", async ({ page }) => {
    await page.goto("/");
    await page.locator("[data-testid='nav-agents']").click();
    await expect(page).toHaveURL("/agents");
    await page.locator("[data-testid='nav-build']").click();
    await expect(page).toHaveURL("/build");
    await page.locator("[data-testid='nav-dashboard']").click();
    await expect(page).toHaveURL("/");
  });

  test("Region selector is visible in header", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("us-east-1")).toBeVisible();
  });
});
