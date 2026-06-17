import { test, expect } from "@playwright/test";

/**
 * Workflow archive feature — API and list filtering tests.
 *
 * Run: PLAYWRIGHT_BASE_URL=https://k2krtgqjiu.us-east-1.awsapprunner.com \
 *      npx playwright test tests/workflow-archive.spec.ts
 */

test.describe("Workflow Archive", () => {
  let workflowId: string;

  test.beforeAll(async ({ request }) => {
    // Create a throwaway workflow
    const startRes = await request.post("/api/workflow/start", {
      data: {
        title: "[E2E-ARCHIVE] Test archive flow",
        description: "Workflow created solely to test the archive feature; will be archived immediately.",
        repoConfig: { layout: "monorepo", repos: [] },
        sources: [],
      },
    });
    expect(startRes.ok()).toBeTruthy();
    const data = await startRes.json();
    workflowId = data.workflowId;
    expect(workflowId).toBeTruthy();
    console.log(`Created throwaway workflow ${workflowId}`);
  });

  test("PATCH /api/workflow/{id}/archive returns 200", async ({ request }) => {
    const res = await request.patch(`/api/workflow/${workflowId}/archive`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe("archived");
    expect(body.archivedAt).toBeTruthy();
  });

  test("archiving is idempotent (second call returns 200)", async ({ request }) => {
    const res = await request.patch(`/api/workflow/${workflowId}/archive`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe("archived");
  });

  test("PATCH /api/workflow/nonexistent-id/archive returns 404", async ({ request }) => {
    const res = await request.patch("/api/workflow/nonexistent-workflow-id-xyz/archive");
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Workflow not found");
  });

  test("GET /api/workflow/list does NOT include archived workflow", async ({ request }) => {
    const res = await request.get("/api/workflow/list");
    expect(res.ok()).toBeTruthy();
    const { workflows } = await res.json();
    const found = workflows.find((w: { id: string }) => w.id === workflowId);
    expect(found).toBeUndefined();
  });

  test("GET /api/workflow/list?includeArchived=1 DOES include archived workflow", async ({ request }) => {
    const res = await request.get("/api/workflow/list?includeArchived=1");
    expect(res.ok()).toBeTruthy();
    const { workflows } = await res.json();
    const found = workflows.find((w: { id: string }) => w.id === workflowId);
    expect(found).toBeDefined();
  });
});
