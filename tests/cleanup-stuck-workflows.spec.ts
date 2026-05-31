import { test, expect } from "@playwright/test";

/**
 * Cancels every non-terminal workflow on the deployed instance.
 * Terminal phases are: complete, error, cancelled.
 *
 * Run with: PLAYWRIGHT_BASE_URL=https://k2krtgqjiu.us-east-1.awsapprunner.com \
 *           npx playwright test tests/cleanup-stuck-workflows.spec.ts
 */
test.describe.configure({ mode: "serial" });

test("cancel all stuck (non-terminal) workflows", async ({ request }) => {
  test.setTimeout(120_000);

  const listRes = await request.get("/api/workflow/list");
  expect(listRes.ok()).toBeTruthy();
  const { workflows } = await listRes.json();
  expect(Array.isArray(workflows)).toBeTruthy();

  const TERMINAL = new Set(["complete", "error", "cancelled"]);
  const stuck = workflows.filter((w: { phase: string }) => !TERMINAL.has(w.phase));

  console.log(`Found ${stuck.length} non-terminal workflows out of ${workflows.length} total`);
  for (const w of stuck) {
    console.log(`  ${w.id} | phase=${w.phase} | "${w.input?.title || ""}"`);
  }

  if (stuck.length === 0) {
    console.log("Nothing to cancel.");
    return;
  }

  const results = await Promise.all(
    stuck.map(async (w: { id: string; phase: string }) => {
      const res = await request.post(`/api/workflow/${w.id}/cancel`, {
        data: { reason: "cleanup before E2E test run" },
      });
      return { id: w.id, ok: res.ok(), status: res.status() };
    })
  );

  const ok = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok);
  console.log(`Cancelled ${ok}/${stuck.length} workflows`);
  if (fail.length) {
    console.log(`Failed:`, JSON.stringify(fail, null, 2));
  }

  // Allow some failures (e.g. workflows that completed in flight) — assert majority succeeded
  expect(ok).toBeGreaterThanOrEqual(Math.floor(stuck.length * 0.8));
});
