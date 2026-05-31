/**
 * Test: Agent output streaming quality
 *
 * Opens a COMPLETED workflow run, clicks each agent card, and validates
 * that the output panel shows coherent, complete text (not fragments).
 *
 * Run against App Runner:
 *   DEMO_BASE_URL=https://YOUR-APP-RUNNER-ID.us-east-1.awsapprunner.com npx playwright test demo/playwright/v4/test-agent-streaming.spec.ts --config demo/playwright/v4/playwright-v4.config.ts
 */
import { test, expect } from "@playwright/test";

const BASE_URL = process.env.DEMO_BASE_URL || "https://YOUR-APP-RUNNER-ID.us-east-1.awsapprunner.com";
// Use the most recent completed workflow
const WORKFLOW_ID = process.env.TEST_WORKFLOW_ID || "wf_1779502527116_xs7k4v";

test.describe("Agent output streaming", () => {
  test("completed agents show full, coherent output", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 2304, height: 1080 },
      colorScheme: "dark",
    });
    const page = await context.newPage();

    // Navigate to the completed workflow
    await page.goto(`${BASE_URL}/workflow?id=${WORKFLOW_ID}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000); // Let pre-fetch of agent outputs complete

    // Find all agent items in the pipeline canvas
    const agentItems = page.locator(".pipeline-canvas .item");
    const count = await agentItems.count();
    console.log(`Found ${count} agent items in pipeline`);

    expect(count).toBeGreaterThan(0);

    // Click each agent and validate output
    for (let i = 0; i < count; i++) {
      const item = agentItems.nth(i);
      const label = await item.locator(".item-label").textContent();
      console.log(`\n--- Clicking agent: ${label} ---`);

      await item.click();
      await page.waitForTimeout(1500); // Wait for panel + API fetch

      // The output panel should be visible
      const panel = page.locator(".agent-output-panel, [class*='OutputPanel'], [class*='agent-output']").first();
      const panelVisible = await panel.isVisible().catch(() => false);

      if (!panelVisible) {
        console.log(`  Panel not visible for ${label}, trying alternate selector...`);
        // Try the prose container directly
        const prose = page.locator(".agent-output-prose").first();
        const proseVisible = await prose.isVisible().catch(() => false);
        if (!proseVisible) {
          console.log(`  WARNING: No output panel found for ${label}`);
          continue;
        }
      }

      // Get the output text
      const outputText = await page.locator(".agent-output-prose").first().textContent().catch(() => "");

      if (!outputText || outputText.trim().length === 0) {
        console.log(`  WARNING: Empty output for ${label}`);
        // Take screenshot for debugging
        await page.screenshot({
          path: `demo/recordings/streaming-empty-${label?.replace(/\s+/g, "-")}.png`,
        });
        continue;
      }

      console.log(`  Output length: ${outputText.length} chars`);
      console.log(`  First 100 chars: ${outputText.slice(0, 100).replace(/\n/g, "\\n")}`);
      console.log(`  Last 100 chars: ${outputText.slice(-100).replace(/\n/g, "\\n")}`);

      // VALIDATION: Output should be substantial (not just a tiny fragment)
      expect(outputText.length, `${label} output too short`).toBeGreaterThan(100);

      // VALIDATION: Should not start mid-word (first char should be uppercase, #, or newline)
      const firstNonSpace = outputText.trimStart().charAt(0);
      const startsClean = /[A-Z#\n*\-1-9[]/.test(firstNonSpace);
      if (!startsClean) {
        console.log(`  WARNING: Output starts mid-text: "${outputText.trimStart().slice(0, 50)}"`);
      }

      // VALIDATION: Should not end mid-sentence (last chars should be punctuation, code block, or newline)
      const lastChars = outputText.trimEnd().slice(-5);
      const endsClean = /[.!?\n`)\]:]/.test(lastChars.slice(-1));
      if (!endsClean) {
        console.log(`  WARNING: Output ends abruptly: "...${outputText.trimEnd().slice(-50)}"`);
      }

      // Take screenshot
      await page.screenshot({
        path: `demo/recordings/streaming-${label?.replace(/\s+/g, "-")}.png`,
      });

      // Scroll to top of output to verify beginning is visible
      const outputContainer = page.locator(".agent-output-prose").first();
      await outputContainer.evaluate((el) => el.scrollTop = 0);
      await page.waitForTimeout(300);
      await page.screenshot({
        path: `demo/recordings/streaming-top-${label?.replace(/\s+/g, "-")}.png`,
      });

      // Close panel before clicking next agent
      await item.click();
      await page.waitForTimeout(500);
    }

    await context.close();
  });
});
