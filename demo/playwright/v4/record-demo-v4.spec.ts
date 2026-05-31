/**
 * V4 Demo Recording — AgentCore Hub: Collapsible Sidebar + Intake Card
 *
 * Records a REAL pipeline run. Agents implement collapsible sidebar + intake card.
 *
 * Run:
 *   npx playwright test demo/playwright/v4/record-demo-v4.spec.ts --config demo/playwright/v4/playwright-v4.config.ts
 */

import { test } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = process.env.DEMO_BASE_URL || "http://localhost:3000";
const RECORDING_DIR = path.join(__dirname, "../../recordings");

const S3_BUCKET = process.env.S3_BUCKET || "${process.env.S3_BUCKET}";

const FEATURE_REQUEST = {
  title: "Collapsible History Sidebar + Intake Card Enhancements",
  description: [
    "Enhance the workflow page with two improvements:",
    "",
    "1. COLLAPSIBLE SIDEBAR: Make the left history sidebar collapsible/resizable:",
    "   - Auto-collapses when user selects a workflow (gives pipeline full width)",
    "   - ChevronRight expand button appears on left edge when collapsed",
    "   - Drag handle on right edge for resize (220px-480px range, default 320px)",
    "   - Epic titles in list wrap instead of truncating",
    "   - Smooth 300ms transition animation",
    "",
    "2. INTAKE CARD ENHANCEMENTS: Enrich the Intake phase card in the pipeline:",
    "   - Show epic/feature title (from state.input.title) as subtitle in Phase 1 box",
    '   - Make "User Actions" items expandable with chevron indicators',
    "   - Expanded items reveal actual source links from state.input.sources",
    "   - S3 sources show filename, URL sources open in new tab",
    "   - Epic ID shown in Trigger section when workflow is loaded",
    "",
    "Files to modify:",
    "- src/app/workflow/page.tsx (sidebar logic)",
    "- src/components/workflow/WorkflowBoard.tsx (intake card)",
    "",
    "Dependencies already available: lucide-react (ChevronLeft, ChevronRight, GripVertical, ChevronDown), Tailwind CSS, CSS variables.",
    "",
    "See attached PRD and mockup images for full spec and visual reference.",
  ].join("\n"),
  repoUrl: "https://github.com/your-org/your-repo",
  sources: [
    `s3://${S3_BUCKET}/intake-sources/sidebar-intake-v4/prd.md`,
    `s3://${S3_BUCKET}/intake-sources/sidebar-intake-v4/mockup/sidebar-desired-state.png`,
    `s3://${S3_BUCKET}/intake-sources/sidebar-intake-v4/mockup/sidebar-current-state.png`,
    `s3://${S3_BUCKET}/intake-sources/sidebar-intake-v4/context/page.tsx`,
    `s3://${S3_BUCKET}/intake-sources/sidebar-intake-v4/context/WorkflowBoard.tsx`,
    `s3://${S3_BUCKET}/intake-sources/sidebar-intake-v4/context/types.ts`,
  ],
};

test.setTimeout(2400000); // 40 minutes max

test("Record AgentCore Hub demo v4", async ({ browser }) => {
  fs.mkdirSync(RECORDING_DIR, { recursive: true });

  // ─── Pre-warm ─────────────────────────────────────────────────────
  console.log("[pre] Warming up...");
  const warmupCtx = await browser.newContext({ viewport: { width: 2304, height: 1080 } });
  const warmupPage = await warmupCtx.newPage();
  await warmupPage.goto(BASE_URL);
  await warmupPage.waitForLoadState("domcontentloaded");
  await warmupPage.waitForTimeout(2000);
  await warmupCtx.close();
  console.log("[pre] Warmup complete");

  // ─── Start recording ──────────────────────────────────────────────
  const context = await browser.newContext({
    viewport: { width: 2304, height: 1080 },
    colorScheme: "dark",
    recordVideo: { dir: RECORDING_DIR, size: { width: 2304, height: 1080 } },
  });
  const page = await context.newPage();

  // ─── Scene 1: Dashboard ───────────────────────────────────────────
  console.log("[scene1] Dashboard");
  await page.goto(BASE_URL);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(5000);

  // ─── Scene 2: Navigate to Workflow ────────────────────────────────
  console.log("[scene2] Workflow page");
  await page.goto(`${BASE_URL}/workflow`);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3000);

  // ─── Scene 3: New Workflow ────────────────────────────────────────
  console.log("[scene3] New Workflow");
  const newWfBtn = page.locator('button[title="New Workflow"]');
  if (!(await newWfBtn.isVisible().catch(() => false))) {
    // Fallback: try the text button in empty state
    await page.locator('button:has-text("New Workflow")').first().click();
  } else {
    await newWfBtn.click();
  }
  await page.waitForTimeout(1500);

  // ─── Scene 4: Fill Intake Form ────────────────────────────────────
  console.log("[scene4] Fill Intake Form");

  // Wait for form
  const titleInput = page.locator('input[placeholder*="profile photo carousel"]');
  await titleInput.waitFor({ state: "visible", timeout: 10000 });

  // Title (type for visual effect)
  await titleInput.click();
  await titleInput.type(FEATURE_REQUEST.title, { delay: 25 });
  await page.waitForTimeout(500);

  // Description (fill instantly — too long to type)
  console.log("[scene4] Filling description...");
  const descInput = page.locator('textarea[placeholder*="Describe"]');
  await descInput.click();
  await descInput.fill(FEATURE_REQUEST.description);
  await page.waitForTimeout(2000);

  // Add S3 sources
  console.log("[scene4] Adding sources...");
  for (const source of FEATURE_REQUEST.sources) {
    const srcInput = page.locator('input[placeholder*="https://... or s3://"]');
    await srcInput.scrollIntoViewIfNeeded();
    await srcInput.click();
    await srcInput.fill(source);
    await page.waitForTimeout(200);
    await page.locator('button:text-is("Add")').click();
    await page.waitForTimeout(400);
  }
  console.log("[scene4] Sources added");
  await page.waitForTimeout(1000);

  // Repo URL (already pre-filled — just verify it's there)
  console.log("[scene4] Repo URL...");
  const repoInput = page.locator('input[placeholder*="github.com/org/repo"]');
  await repoInput.scrollIntoViewIfNeeded();
  await repoInput.fill("");
  await repoInput.fill(FEATURE_REQUEST.repoUrl);
  await page.waitForTimeout(300);
  console.log("[scene4] Repo filled");

  // Model selector — pick Opus 4.6
  console.log("[scene4] Model select...");
  const modelSelect = page.locator("#model-select");
  if (await modelSelect.isVisible().catch(() => false)) {
    await modelSelect.selectOption({ label: "Claude Opus 4.6" });
    await page.waitForTimeout(300);
    console.log("[scene4] Model selected");
  }

  // Pause to show filled form
  await page.waitForTimeout(3000);

  // ─── Scene 5: Submit ──────────────────────────────────────────────
  console.log("[scene5] Submit");
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(5000);

  // ─── Scene 6+: Watch agents work ─────────────────────────────────
  console.log("[scene6] Agents working...");
  const startTime = Date.now();
  const MAX_WAIT = 2100000; // 35 minutes
  let completed = false;
  let lastPhase = "";

  while (Date.now() - startTime < MAX_WAIT) {
    const bodyText = await page.textContent("body").catch(() => "");
    const lower = (bodyText || "").toLowerCase();

    if (
      lower.includes("all agents have completed their work") ||
      lower.includes("pull request created") ||
      lower.includes("pr ready for review")
    ) {
      completed = true;
      break;
    }

    const phases = ["requirements", "design", "development", "verification", "review", "complete"];
    for (const phase of phases) {
      if (lower.includes(`phase: ${phase}`) || lower.includes(`phase ${phase}`)) {
        if (phase !== lastPhase) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          console.log(`  [${elapsed}s] Phase: ${phase}`);
          lastPhase = phase;
        }
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    if (elapsed % 60 < 6) {
      console.log(`  [${elapsed}s] Working... (${lastPhase || "starting"})`);
    }

    await page.waitForTimeout(5000);
  }

  const totalElapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(completed
    ? `[done] Workflow completed in ${totalElapsed}s`
    : `[timeout] Stopped after ${Math.round(totalElapsed / 60)} minutes`);

  // ─── Scene 7: Dwell ───────────────────────────────────────────────
  await page.waitForTimeout(10000);
  await page.screenshot({ path: path.join(RECORDING_DIR, "v4-final-state.png"), fullPage: true });

  // ─── Close & rename recording ─────────────────────────────────────
  await context.close();

  const files = fs.readdirSync(RECORDING_DIR).filter(f => f.endsWith(".webm") && !f.startsWith("raw-demo"));
  if (files.length > 0) {
    const sorted = files
      .map(f => ({ name: f, time: fs.statSync(path.join(RECORDING_DIR, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);
    const finalPath = path.join(RECORDING_DIR, "raw-demo-v4.webm");
    fs.renameSync(path.join(RECORDING_DIR, sorted[0].name), finalPath);
    console.log(`Recording: ${finalPath} (${(fs.statSync(finalPath).size / 1024 / 1024).toFixed(1)} MB)`);
  }
});
