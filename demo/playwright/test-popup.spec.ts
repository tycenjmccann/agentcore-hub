import { test } from "@playwright/test";

test("capture replay bar with play interaction", async ({ page }) => {
  await page.goto("http://localhost:3000/workflow?id=wf_1779347493579_ei1v9h", { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  // Scroll to find the replay bar
  const replayBar = page.locator('.replay-bar');
  const isVisible = await replayBar.isVisible().catch(() => false);
  console.log(`Replay bar visible: ${isVisible}`);
  
  if (isVisible) {
    await replayBar.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: "/tmp/replay-bar-visible.png" });
    
    // Click play button
    const playBtn = page.locator('.replay-btn');
    await playBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/replay-bar-playing.png" });
    
    // Wait and see progress
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "/tmp/replay-bar-3s.png" });
    
    await page.waitForTimeout(5000);
    await page.screenshot({ path: "/tmp/replay-bar-8s.png" });
    
    // Scroll up to see pipeline state
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: "/tmp/replay-pipeline-during.png" });
  } else {
    // Maybe it's below fold
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
    await page.screenshot({ path: "/tmp/replay-bar-scroll-bottom.png" });
  }
});
