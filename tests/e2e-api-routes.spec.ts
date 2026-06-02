import { test, expect } from "@playwright/test";

/**
 * E2E Test: API routes and agent discovery
 *
 * Tests the backend API endpoints that power the console:
 * - Agent discovery (harnesses + runtimes)
 * - Payload format configuration
 * - Metrics
 */
test.describe("E2E: API Routes", () => {
  test.setTimeout(30_000);

  test("Agents API returns discovered agents", async ({ request }) => {
    const res = await request.get("/api/agentcore/agents");
    expect(res.status()).toBe(200);
    const agents = await res.json();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThan(0);

    // Each agent should have required fields
    const first = agents[0];
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("status");
  });

  test("Agents API includes harness agents", async ({ request }) => {
    const res = await request.get("/api/agentcore/agents");
    const agents = await res.json();
    const harness = agents.find((a: { type: string }) => a.type === "harness");
    expect(harness).toBeTruthy();
    expect(harness.name).toBeTruthy();
  });

  test("Payload format API - get default", async ({ request }) => {
    const res = await request.get("/api/agentcore/payload-format?agent_id=test-agent");
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.format).toBe("prompt");
  });

  test("Payload format API - set and retrieve", async ({ request }) => {
    const setRes = await request.post("/api/agentcore/payload-format", {
      data: { agent_id: "e2e-test-agent", format: "messages" },
    });
    expect(setRes.status()).toBe(200);
    const setData = await setRes.json();
    expect(setData.saved).toBe(true);
    expect(setData.format).toBe("messages");

    // Retrieve it
    const getRes = await request.get("/api/agentcore/payload-format?agent_id=e2e-test-agent");
    expect(getRes.status()).toBe(200);
    const getData = await getRes.json();
    expect(getData.format).toBe("messages");
  });

  test("Payload format API - rejects invalid format", async ({ request }) => {
    const res = await request.post("/api/agentcore/payload-format", {
      data: { agent_id: "test", format: "invalid_format" },
    });
    expect(res.status()).toBe(400);
  });

  test("Metrics API returns usage data", async ({ request }) => {
    // The metrics route runs CloudWatch Logs Insights queries (each polls up to
    // 15s) plus CW metric stats, so a cold call can take ~30s+. Give it a
    // realistic budget instead of the default 30s; results are cached 2min after.
    test.setTimeout(90_000);
    const res = await request.get("/api/agentcore/metrics", { timeout: 80_000 });
    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("usage");
    expect(data.usage).toHaveProperty("totalInvocations");
    expect(data.usage).toHaveProperty("activeAgents");
    expect(data).toHaveProperty("agentMetrics");
    expect(Array.isArray(data.agentMetrics)).toBe(true);
  });
});
