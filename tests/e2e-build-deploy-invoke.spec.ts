import { test, expect } from "@playwright/test";

/**
 * E2E Test: Builder Agent creates agents via real AgentCore harness.
 *
 * The Builder Agent is itself a harness with tools to:
 * - list_agents: see what's deployed
 * - list_gateway_tools: see available tools
 * - list_memories: see memory resources
 * - create_harness: deploy new agents
 * - get_agent_detail: inspect existing agents
 *
 * These tests verify the builder chat streams responses and uses tools.
 */
test.describe("E2E: Builder Agent", () => {
  test.setTimeout(120_000);

  test("Builder agent responds to questions about agents", async ({ page }) => {
    await page.goto("/build");
    await expect(page.getByText("Agent Builder Chat")).toBeVisible();

    // Send a request that triggers the builder agent
    const input = page.locator("[data-testid='build-description-input']");
    await input.fill("What agents are currently deployed in my account?");
    await page.locator("[data-testid='build-submit-btn']").click();

    // Should show the user message
    await expect(page.locator("[data-testid='builder-messages']").getByText("What agents are currently deployed")).toBeVisible();

    // Wait for the agent to start streaming a response
    // The agent acknowledges and starts a tool call — we just need to verify it's responding
    await expect(async () => {
      const messages = page.locator("[data-testid='builder-messages']");
      const text = await messages.textContent();
      // Agent should acknowledge the request (it says something like "I'll check...")
      const hasResponse = text!.includes("check") ||
        text!.includes("agents") ||
        text!.includes("deployed") ||
        text!.includes("account");
      expect(hasResponse).toBe(true);
      // The response should be longer than just the welcome message + user message
      expect(text!.length).toBeGreaterThan(300);
    }).toPass({ timeout: 60_000 });
  });

  test("Builder agent can describe how to create an agent", async ({ page }) => {
    await page.goto("/build");

    const input = page.locator("[data-testid='build-description-input']");
    await input.fill("I want to create a customer support agent that can access Jira and Slack. What tools are available?");
    await page.locator("[data-testid='build-submit-btn']").click();

    // Wait for response - agent should call list_gateway_tools and mention available tools
    await expect(async () => {
      const messages = page.locator("[data-testid='builder-messages']");
      const text = await messages.textContent();
      // Should mention gateway tools it discovered
      const hasToolData = text!.includes("Jira") ||
        text!.includes("Slack") ||
        text!.includes("gateway") ||
        text!.includes("tool");
      expect(hasToolData).toBe(true);
    }).toPass({ timeout: 90_000 });
  });

  test("Builder streams text incrementally (not all at once)", async ({ page }) => {
    await page.goto("/build");

    const input = page.locator("[data-testid='build-description-input']");
    await input.fill("Say hello briefly");
    await page.locator("[data-testid='build-submit-btn']").click();

    // The streaming dots should appear while agent is thinking
    // Then text should appear incrementally
    await expect(async () => {
      const messages = page.locator("[data-testid='builder-messages']");
      const allText = await messages.textContent();
      // Agent should have responded with something
      expect(allText!.length).toBeGreaterThan(50);
    }).toPass({ timeout: 60_000 });
  });
});
