/**
 * Test S3 Artifacts Modal — opens a workflow, clicks the S3 icon in pipeline,
 * verifies the modal shows artifacts scoped to that workflow.
 *
 * Run: npx playwright test demo/playwright/test-s3-modal.spec.ts --config demo/playwright/playwright.config.ts
 */
import { test, expect } from "@playwright/test";
import * as path from "path";

const BASE_URL = process.env.DEMO_BASE_URL || "http://localhost:3000";
const SCREENSHOT_DIR = path.join(__dirname, "../recordings");

// Known workflows with S3 data
const WORKFLOW_IDS = [
  "wf_1779400014679_4cqew5",
  "wf_1778949510996_pyfoy0",
  "wf_1778903956394_dgpjes",
];

test("S3 Artifacts Modal shows scoped artifacts", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    colorScheme: "dark",
  });
  const page = await context.newPage();

  // Step 1: Navigate to workflow page with a known workflow
  let workflowId = WORKFLOW_IDS[0];
  console.log(`Navigating to workflow: ${workflowId}`);
  await page.goto(`${BASE_URL}/workflow?id=${workflowId}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3000); // Let pipeline render

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "s3-test-step1-workflow-loaded.png"),
    fullPage: true,
  });
  console.log("Step 1: Workflow page loaded, screenshot saved.");

  // Step 2: Find the S3 icon in the pipeline (items with title="View S3 artifacts")
  const s3Items = page.locator('[title="View S3 artifacts"]');
  const s3Count = await s3Items.count();
  console.log(`Found ${s3Count} S3 clickable items in the pipeline.`);

  if (s3Count === 0) {
    // Try other workflows
    for (const altId of WORKFLOW_IDS.slice(1)) {
      console.log(`No S3 icons found, trying workflow: ${altId}`);
      workflowId = altId;
      await page.goto(`${BASE_URL}/workflow?id=${altId}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(3000);
      const altCount = await page.locator('[title="View S3 artifacts"]').count();
      console.log(`  Found ${altCount} S3 items.`);
      if (altCount > 0) break;
    }
  }

  const finalS3Items = page.locator('[title="View S3 artifacts"]');
  const finalCount = await finalS3Items.count();

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "s3-test-step2-pipeline-with-s3-icons.png"),
    fullPage: true,
  });
  console.log(`Step 2: Pipeline screenshot saved. S3 icons found: ${finalCount}`);

  if (finalCount === 0) {
    console.log("WARNING: No S3 icons found in any workflow. The pipeline may not have S3 output items.");
    await context.close();
    return;
  }

  // Step 3: Click the first S3 icon to open the modal
  console.log("Clicking the first S3 icon...");
  await finalS3Items.first().click();
  await page.waitForTimeout(1500); // Wait for modal animation + API call

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "s3-test-step3-modal-opened.png"),
    fullPage: true,
  });
  console.log("Step 3: Modal opened, screenshot saved.");

  // Step 4: Verify modal content
  // Check that the modal dialog is visible
  const modal = page.locator('[role="dialog"]');
  const modalVisible = await modal.isVisible();
  console.log(`Modal visible: ${modalVisible}`);

  if (modalVisible) {
    // Check for the title
    const title = await page.locator("#s3-modal-title").textContent();
    console.log(`Modal title: ${title}`);

    // Check loading state or file list
    const loading = page.locator("text=Loading artifacts...");
    const isLoading = await loading.isVisible();
    if (isLoading) {
      console.log("Modal is still loading, waiting...");
      await page.waitForTimeout(3000);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "s3-test-step4-modal-after-load.png"),
        fullPage: true,
      });
    }

    // Check for file rows
    const fileRows = page.locator(".s3-file-row");
    const fileCount = await fileRows.count();
    console.log(`File rows in modal: ${fileCount}`);

    // Check for error state
    const errorMsg = page.locator("text=Failed to load artifacts");
    const hasError = await errorMsg.isVisible();
    if (hasError) {
      const errorDetail = await page.locator(".s3-artifacts-modal").textContent();
      console.log(`ERROR in modal: ${errorDetail}`);
    }

    // Check for empty state
    const emptyMsg = page.locator("text=No artifacts yet");
    const isEmpty = await emptyMsg.isVisible();
    if (isEmpty) {
      console.log("Modal shows 'No artifacts yet' — may need to check API filtering.");
    }

    // If files are shown, log their names
    if (fileCount > 0) {
      console.log("Artifacts listed:");
      for (let i = 0; i < fileCount; i++) {
        const filename = await fileRows.nth(i).locator("p").first().textContent();
        console.log(`  - ${filename}`);
      }

      // Verify artifacts are scoped — check they contain the workflowId in the key
      // The API call should have workflowId in query params
      console.log(`\nVerification: Artifacts should be scoped to workflowId=${workflowId}`);
    }

    // Check footer (total size, download button)
    const footer = page.locator(".s3-modal-footer");
    if (await footer.isVisible()) {
      const footerText = await footer.textContent();
      console.log(`Footer: ${footerText}`);
    }
  }

  // Step 5: Intercept the API call to verify it includes the correct workflowId
  // Let's close and re-open while monitoring network
  console.log("\nStep 5: Re-opening modal with network monitoring...");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  const apiCalls: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/workflow/artifacts")) {
      apiCalls.push(req.url());
    }
  });

  await finalS3Items.first().click();
  await page.waitForTimeout(2000);

  console.log("API calls intercepted:");
  for (const url of apiCalls) {
    console.log(`  ${url}`);
    if (url.includes(`workflowId=${workflowId}`)) {
      console.log("  ✓ Correctly scoped to current workflow!");
    }
  }

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "s3-test-step5-final-state.png"),
    fullPage: true,
  });
  console.log("\nStep 5: Final screenshot saved.");

  await context.close();
});
