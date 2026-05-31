/**
 * Quick layout check — opens the workflow page at the new viewport size
 * with dark mode forced, takes a screenshot, then exits.
 *
 * Run: npx playwright test demo/playwright/v4/check-layout.spec.ts --config demo/playwright/v4/playwright-v4.config.ts
 */
import { test } from "@playwright/test";
import * as path from "path";

const BASE_URL = process.env.DEMO_BASE_URL || "http://localhost:3000";

test("Check layout and theme", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 2304, height: 1080 },
    colorScheme: "dark",
  });
  const page = await context.newPage();

  // Dashboard
  await page.goto(BASE_URL);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(__dirname, "../../recordings/check-dashboard.png") });

  // Workflow page
  await page.goto(`${BASE_URL}/workflow`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(__dirname, "../../recordings/check-workflow.png") });

  await context.close();
});
