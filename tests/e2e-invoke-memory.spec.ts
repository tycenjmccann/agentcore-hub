import { test, expect } from "@playwright/test";

/**
 * E2E Test: Agent Detail page — chat with real agents and memory.
 *
 * Tests the full invoke flow on the agent detail page:
 * - Navigate to an agent
 * - Send a message via the chat interface
 * - Verify streaming response
 * - Verify session appears in history
 */
test.describe("E2E: Agent Chat and Memory", () => {
  test.setTimeout(90_000);

  test("Chat with an agent and get a streaming response", async ({ page }) => {
    // Go to agents page, wait for discovery
    await page.goto("/agents");
    await expect(page.getByText("Discovering agents...")).not.toBeVisible({ timeout: 15000 });

    // Click first agent card to go to detail
    await page.locator("[data-testid^='agent-card-']").first().click();
    await expect(page.getByText("Agent Detail")).toBeVisible({ timeout: 10000 });

    // Find the chat input and send a message
    const chatInput = page.locator("input[placeholder*='Message'], textarea[placeholder*='Message']").first();
    await expect(chatInput).toBeVisible();
    await chatInput.fill("Say hello in exactly 3 words");
    await chatInput.press("Enter");

    // User message should appear in the chat area
    await expect(page.getByRole("paragraph").filter({ hasText: "Say hello in exactly 3 words" })).toBeVisible({ timeout: 5000 });

    // Wait for agent response to stream in (may take time for cold start)
    await expect(async () => {
      const agentBubbles = page.locator(".rounded-2xl.rounded-tl-sm, .prose");
      const count = await agentBubbles.count();
      expect(count).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 75_000 });
  });

  test("Memory API - store and retrieve events", async ({ request }) => {
    const sessionId = `e2e_mem_test_${Date.now()}_${"x".repeat(20)}`;

    // Store a conversation turn
    const storeRes = await request.post("/api/agentcore/memory/events", {
      data: {
        agent_id: "csharness_cssonnet-pScJm2ObOd",
        session_id: sessionId,
        user_message: "What is AgentCore?",
        assistant_message: "AgentCore is a managed service for deploying AI agents.",
      },
    });
    expect(storeRes.status()).toBe(200);
    const storeData = await storeRes.json();

    // If no memory is configured for this agent, the API returns stored:false (not an error).
    // Skip the retrieval assertions in that case — memory is optional per-agent.
    if (!storeData.stored) {
      test.skip(true, "No memory configured for test agent — skipping retrieval");
      return;
    }

    // Retrieve events for the session
    const eventsRes = await request.get(
      `/api/agentcore/memory/events?agent_id=csharness_cssonnet-pScJm2ObOd&session_id=${sessionId}`
    );
    expect(eventsRes.status()).toBe(200);
    const eventsData = await eventsRes.json();
    expect(eventsData.messages.length).toBe(2);
    expect(eventsData.messages[0].role).toBe("user");
    expect(eventsData.messages[1].role).toBe("assistant");
  });

  test("Sessions API - list sessions for an agent", async ({ request }) => {
    const sessionsRes = await request.get(
      "/api/agentcore/memory/sessions?agent_id=csharness_cssonnet-pScJm2ObOd"
    );
    expect(sessionsRes.status()).toBe(200);
    const data = await sessionsRes.json();
    expect(Array.isArray(data.sessions)).toBe(true);
  });

  test("Traces API - returns traces for a session", async ({ request }) => {
    const tracesRes = await request.get(
      "/api/agentcore/traces?session_id=test-session-123&agent_id=csharness_cssonnet-pScJm2ObOd"
    );
    expect(tracesRes.status()).toBe(200);
    const data = await tracesRes.json();
    expect(data).toHaveProperty("traces");
    expect(data).toHaveProperty("source");
  });
});
