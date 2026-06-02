import { test, expect } from "@playwright/test";

test.describe("Dashboard Tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("renders header with configured branding", async ({ page }) => {
    // The sidebar h1 renders NEXT_PUBLIC_BRAND_NAME (installer-configurable),
    // falling back to "AgentCore Hub". Read the same source the app does rather
    // than hardcoding the default — a custom brand is a healthy app, not a bug.
    const expectedBrand = process.env.NEXT_PUBLIC_BRAND_NAME || "AgentCore Hub";
    await expect(page.locator("h1")).toContainText(expectedBrand);
  });

  test("shows all navigation items", async ({ page }) => {
    await expect(page.locator("[data-testid='nav-dashboard']")).toBeVisible();
    await expect(page.locator("[data-testid='nav-agents']")).toBeVisible();
    await expect(page.locator("[data-testid='nav-build']")).toBeVisible();
    await expect(page.locator("[data-testid='nav-workflow']")).toBeVisible();
    await expect(page.locator("[data-testid='nav-ticket history']")).toBeVisible();
  });

  test("displays agent activity metrics", async ({ page }) => {
    // "Invocations" also appears as an Agent Performance table column header;
    // scope to the metric-card label (a paragraph) to avoid a strict-mode
    // ambiguity once the table renders.
    await expect(page.getByRole("paragraph").filter({ hasText: /^Invocations$/ })).toBeVisible();
    await expect(page.getByText("Tokens", { exact: true })).toBeVisible();
    await expect(page.getByText("Active Agents")).toBeVisible();
  });

  test("shows agent performance table with live data", async ({ page }) => {
    await expect(page.getByText("Agent Performance")).toBeVisible();
    // Wait for agents to load
    await expect(page.getByText("Discovering agents...")).not.toBeVisible({ timeout: 30000 });
    await expect(page.locator("table")).toBeVisible();
    await expect(page.locator("table tbody tr").first()).toBeVisible();
  });

  test("region selector shows us-east-1", async ({ page }) => {
    await expect(page.getByText("us-east-1")).toBeVisible();
  });

  test("sidebar collapse/expand works", async ({ page }) => {
    const sidebar = page.locator("aside");
    await expect(sidebar).toHaveClass(/w-64|w-16/);
    // Click collapse button
    await page.getByLabel(/collapse sidebar/i).click();
    await expect(sidebar).toHaveClass(/w-16/);
    // Click expand
    await page.getByLabel(/expand sidebar/i).click();
    await expect(sidebar).toHaveClass(/w-64/);
  });
});
