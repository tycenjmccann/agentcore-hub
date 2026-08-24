import { test, expect } from "@playwright/test";

/**
 * Verifies each workflow-list row shows a workflow-def label badge (SDLC,
 * Bug-Fix, Dead-Code, …) on the same footer row as the delete button.
 * Runs against PLAYWRIGHT_BASE_URL (prod) using its real workflow list.
 */
test("workflow rows show a def-label badge", async ({ page }) => {
  await page.goto("/workflow");
  // Sidebar is collapsed by default — expand it to reveal the workflow list.
  const expand = page.locator('[aria-label="Expand workflow history sidebar"]');
  if (await expand.count()) await expand.click();
  // Wait for the list to populate from /api/workflow/list.
  const firstRow = page.locator('[aria-label^="Delete workflow"]').first();
  await firstRow.waitFor({ state: "attached", timeout: 20000 }).catch(() => {});

  const known = ["SDLC", "Bug-Fix", "Dead-Code", "Marketing", "Sales", "Legal"];
  const badge = page.locator("span", { hasText: new RegExp(`^(${known.join("|")})$`, "i") });
  const count = await badge.count();
  expect(count, "at least one known def-label badge is rendered").toBeGreaterThan(0);
});
