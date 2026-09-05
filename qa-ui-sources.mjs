// QA untracked Playwright harness (TEAM-4064 / Part D, re-verify on a5b4ac42).
// Renders WorkflowBoard against FIXTURE state (page.route intercepts every
// /api/workflow/* call — no live AWS). Two cases:
//
// CASE 1 (main): 3 sources —
//   1. s3   -> verification.status="verified"   (HeadObject 200)         [no badge]
//   2. url  -> verification.status="unverified" (GET Range 0-0 -> 403)   [amber badge]
//        value + detail carry a presigned URL whose X-Amz-Signature="deadbeefcafe…"
//        AND whose LAST 12 chars are "TAILCANARY99" (as a trailing query value).
//        With the OLD raw slice(-23) the tail canary would surface; the NEW
//        redact-then-truncate (source-shape.ts formatSourceDisplay) must not.
//   3. upload -> verification.status="skipped"  [no badge]
//
// CASE 2 (invalid): the TEAM-4078 crash row { value: null, type: {} } — board
//   must render (no React crash) and show a safe placeholder.
//
// Run: BASE=http://localhost:3000 node qa-ui-sources.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:3000";
const SIG_CANARY = "deadbeefcafe";
const TAIL_CANARY = "TAILCANARY99"; // exactly 12 chars; placed as the LAST 12 chars of the URL

// X-Amz-Signature carries the sig canary; a trailing &tail=<...TAILCANARY99> makes
// TAILCANARY99 the final 12 chars of the URL. URL length > 64 so truncation triggers.
const PRESIGNED =
  "https://qa-bucket.s3.amazonaws.com/specs/prd.pdf" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
  `&X-Amz-Signature=${SIG_CANARY}00001111222233334444` +
  `&tail=${TAIL_CANARY}`;

function makeState(id, sources, title) {
  return {
    id, phase: "complete", epicId: "TEAM-4054",
    repoConfig: { layout: "multi-repo", repos: [{ url: "https://github.com/tycenjmccann/agentcore-hub", defaultBranch: "main", platform: "backend" }] },
    workflowType: "feature", sdlcFramework: "playbook",
    startedAt: "2026-09-05T00:00:00.000Z", completedAt: "2026-09-05T00:10:00.000Z",
    agentTasks: {}, messages: [], humanNotifications: [], eventLog: [],
    input: {
      title, description: "Fixture render for source-badge QA.",
      repoConfig: { layout: "multi-repo", repos: [{ url: "https://github.com/tycenjmccann/agentcore-hub", defaultBranch: "main", platform: "backend" }] },
      sources,
    },
  };
}

const CASE1_ID = "wf-qa-4064";
const CASE1 = makeState(CASE1_ID, [
  { type: "s3", value: "s3://agentcore-hub-artifacts-838829463875-us-east-1/workflows/wf_x/shared/spec.md", label: "verified spec",
    verification: { status: "verified", method: "HeadObject", detail: "S3 object readable — HeadObject -> 200 (own bucket)", checkedAt: "2026-09-05T00:00:01.000Z" } },
  { type: "url", value: PRESIGNED, label: "presigned PRD (unreachable at submit)",
    verification: { status: "unverified", method: "GET (Range 0-0)", detail: `URL not verified — GET (Range 0-0) -> 403 (Forbidden): ${PRESIGNED}`, checkedAt: "2026-09-05T00:00:02.000Z" } },
  { type: "upload", value: "design-mockups.zip", label: "uploaded bundle",
    verification: { status: "skipped", method: "none", detail: "Upload — validated in browser before submit", checkedAt: "2026-09-05T00:00:03.000Z" } },
], "TEAM-4064 QA fixture — intake source verification badges");

const CASE2_ID = "wf-qa-4064-invalid";
const CASE2 = makeState(CASE2_ID, [
  // TEAM-4078 crash row: value null, type a bare object.
  { type: {}, value: null, label: null, verification: { status: "unverified", detail: null } },
], "TEAM-4064 QA fixture — invalid legacy source row");

const json = (route, obj) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(obj) });

function summaryOf(state) {
  return { id: state.id, phase: "complete", epicId: "TEAM-4054",
    input: { title: state.input.title, description: state.input.description },
    startedAt: state.startedAt, completedAt: state.completedAt,
    workflowType: "feature", workflowDefId: "software-delivery", sdlcFramework: "playbook" };
}

async function renderCase(browser, state) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("**/api/workflow/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.endsWith("/api/workflow/list")) return json(route, { workflows: [summaryOf(state)] });
    if (p.includes(`/api/workflow/${state.id}/state`)) return json(route, state);
    if (p.includes("/events")) return json(route, { events: [] });
    if (p.includes("/agent-output")) return json(route, { output: "", runs: [] });
    if (p.includes("/tickets")) return json(route, { tickets: [] });
    if (p.includes("/watch")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
    return json(route, {});
  });
  await page.route("**/api/**", (route) =>
    route.request().url().includes("/api/workflow/") ? route.fallback() : json(route, {}));

  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

  await page.goto(`${BASE}/workflow?id=${state.id}`, { waitUntil: "networkidle" });
  return { page, consoleErrors };
}

(async () => {
  mkdirSync("docs/qa-evidence", { recursive: true });
  const browser = await chromium.launch();

  // ── CASE 1 ──
  {
    const { page, consoleErrors } = await renderCase(browser, CASE1);
    await page.waitForSelector("text=/unverified/", { timeout: 15000 });
    await page.waitForTimeout(400);

    const badges = page.locator("span", { hasText: /^unverified$/ });
    const unverifiedCount = await badges.count();
    const badgeTitle = unverifiedCount ? await badges.first().getAttribute("title") : null;
    const sourcesBlock = page.locator("div.flex.flex-col.gap-1").filter({ has: page.locator("span.uppercase") }).first();
    const sourcesText = await sourcesBlock.innerText().catch(() => "");
    const bodyText = await page.locator("body").innerText();

    console.log("================ CASE 1 (main fixture) ================");
    console.log(JSON.stringify({
      head: "a5b4ac42", WF_ID: CASE1_ID,
      unverifiedBadgeCount: unverifiedCount,
      badgeTitle,
      badgeTitle_contains_deadbeefcafe: badgeTitle ? badgeTitle.includes(SIG_CANARY) : null,
      badgeTitle_contains_TAILCANARY99: badgeTitle ? badgeTitle.includes(TAIL_CANARY) : null,
      sourcesList_visibleText: sourcesText,
      visibleText_contains_deadbeefcafe: bodyText.includes(SIG_CANARY),
      visibleText_contains_TAILCANARY99: bodyText.includes(TAIL_CANARY),
      consoleErrors,
    }, null, 2));

    await page.screenshot({ path: "docs/qa-evidence/TEAM-4064-workflowboard-sources.png", fullPage: true });
    const el = badges.first();
    const box = await el.boundingBox();
    if (box) {
      const clip = { x: Math.max(0, box.x - 760), y: Math.max(0, box.y - 60), width: 1160, height: 170 };
      await page.screenshot({ path: "docs/qa-evidence/TEAM-4064-workflowboard-sources-crop.png", clip });
    }
    await page.close();
  }

  // ── CASE 2 (invalid legacy row) ──
  {
    const { page, consoleErrors } = await renderCase(browser, CASE2);
    // The board itself should render; wait for the pipeline canvas to exist.
    await page.waitForSelector(".pipeline-canvas, text=/invalid/i", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);

    const sourcesBlock = page.locator("div.flex.flex-col.gap-1").filter({ has: page.locator("span.uppercase") }).first();
    const rowText = await sourcesBlock.innerText().catch(() => "(sources block not found)");
    const boardRendered = await page.locator(".pipeline-canvas").count();

    console.log("\n================ CASE 2 (invalid legacy row: value:null, type:{}) ================");
    console.log(JSON.stringify({
      WF_ID: CASE2_ID,
      boardRendered_pipelineCanvasCount: boardRendered,
      sourceRowText: rowText,
      rowText_shows_invalid_placeholder: rowText.includes("(invalid)"),
      consoleErrors,
    }, null, 2));

    await page.screenshot({ path: "docs/qa-evidence/TEAM-4064-workflowboard-invalid-source.png", fullPage: true });
    await page.close();
  }

  await browser.close();
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
