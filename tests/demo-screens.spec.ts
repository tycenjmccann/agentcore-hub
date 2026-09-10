import { test } from "@playwright/test";

/**
 * Walks every top-level surface and grabs a full-page screenshot.
 * Output: tests/demo-screens/*.png
 */
const DIR = "tests/demo-screens";

const PAGES: { name: string; path: string; waitFor?: string }[] = [
  { name: "01-dashboard", path: "/" },
  { name: "02-agents-list", path: "/agents" },
  { name: "03-build", path: "/build" },
  { name: "04-workflow", path: "/workflow" },
  { name: "05-tickets", path: "/tickets" },
  { name: "06-invoke", path: "/invoke" },
  { name: "07-evaluations", path: "/evaluations" },
  { name: "08-evaluations-config", path: "/evaluations/config" },
];

for (const p of PAGES) {
  test(`screen ${p.name}`, async ({ page }) => {
    await page.goto(p.path, { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${DIR}/${p.name}.png`, fullPage: true });
  });
}

test("screen 09-agent-detail", async ({ page }) => {
  await page.goto("/agents", { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(1500);
  // Click the first agent row/link if present.
  const link = page.locator("a[href*='/agents/']").first();
  if (await link.count()) {
    await link.click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${DIR}/09-agent-detail.png`, fullPage: true });
  }
});
