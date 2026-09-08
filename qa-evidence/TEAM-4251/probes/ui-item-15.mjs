/**
 * TEAM-4251 acceptance item 15 — LIVE browser check of TEAM-4249 D2.9
 * (run-outcome-display.ts) rendering in the real Next.js app.
 *
 * WHY page.route() rather than a source stub:
 *   /workflow is a CLIENT component. src/app/workflow/page.tsx:74 fetches
 *   "/api/workflow/list" from inside a useCallback/useEffect, and
 *   WorkflowBoard.tsx fetches /state, /events, /tickets, /watch, /agent-output
 *   and opens an EventSource on /stream — all from the browser. Nothing about the
 *   workflow list or the board is server-rendered from DynamoDB, so intercepting
 *   at the network layer exercises the REAL component tree, the REAL
 *   run-outcome-display.ts, and the REAL CSS. No src/ file is stubbed or edited.
 *
 * Run (a dev server must already be on :3111 — playwright.config.ts has no
 * webServer block):
 *   node qa-evidence/TEAM-4251/probes/ui-item-15.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3111";
const OUT = path.resolve("qa-evidence/TEAM-4251");
mkdirSync(OUT, { recursive: true });

const NOOP_ID = "wf_qa_noop";
const LIVE_ID = "wf_qa_control";

const STARTED = "2026-09-07T18:02:11.000Z";
const FINISHED = "2026-09-07T18:19:40.000Z";

/** (1) the list: one finished no-op sweep + one active control run. */
const LIST = {
  workflows: [
    {
      id: NOOP_ID,
      phase: "nothing-to-remove",
      epicId: "TEAM-9999",
      input: {
        title: "Dead-code sweep - ember",
        description: "Scheduled dead-code sweep of tycenjmccann/ember.",
      },
      createdAt: STARTED,
      startedAt: STARTED,
      completedAt: FINISHED,
      workflowType: "feature",
      workflowDefId: "dead-code-sweep",
      sdlcFramework: "standard",
    },
    {
      id: LIVE_ID,
      phase: "development",
      epicId: "TEAM-9998",
      input: {
        title: "Control run - active feature",
        description: "Non-terminal control so the Active/Completed split is visible.",
      },
      createdAt: STARTED,
      startedAt: STARTED,
      workflowType: "feature",
      workflowDefId: "software-delivery",
      sdlcFramework: "standard",
    },
  ],
};

const REPO_CONFIG = {
  owner: "tycenjmccann",
  repo: "ember",
  repoUrl: "https://github.com/tycenjmccann/ember",
  branch: "main",
  defaultBranch: "main",
};

const STATE = {
  id: NOOP_ID,
  phase: "nothing-to-remove",
  epicId: "TEAM-9999",
  repoConfig: REPO_CONFIG,
  input: {
    title: "Dead-code sweep - ember",
    description: "Scheduled dead-code sweep of tycenjmccann/ember.",
    workflowDefId: "dead-code-sweep",
    repoUrl: "https://github.com/tycenjmccann/ember",
    sdlcFramework: "standard",
  },
  agentTasks: {},
  messages: [],
  humanNotifications: [],
  createdAt: STARTED,
  startedAt: STARTED,
  completedAt: FINISHED,
  workflowType: "feature",
  workflowDefId: "dead-code-sweep",
  sdlcFramework: "standard",
};

/**
 * (2) the events, in the shape /api/workflow/[id]/events actually returns
 * (transform-event.ts's default passthrough: { eventId, type, ...detail,
 * timestamp }). The three orchestrator events are NOT members of the closed
 * WorkflowEvent union — that is the whole point of D2.9.
 *
 * Order matters twice over:
 *   - applyEventToState is the single owner of the phase in replay, so
 *     workflow.nothing_to_remove is what closes the run at its scrub position;
 *   - the notice is the LAST orchestrator event up to replayIndex
 *     (WorkflowBoard.tsx:660-665), so only one notice is on screen at a time.
 *     Hence two screenshots at two scrubber positions, not one.
 */
const EVENTS = {
  events: [
    { eventId: "e001", type: "phase_change", phase: "requirements", timestamp: "2026-09-07T18:02:12.000Z" },
    {
      eventId: "e002",
      type: "agent_status",
      agentId: "dead_code_sweeper",
      status: "complete",
      ticketId: "TEAM-9999-1",
      timestamp: "2026-09-07T18:11:00.000Z",
    },
    {
      eventId: "e003",
      type: "workflow.nothing_to_remove",
      outcome: "nothing-to-remove",
      verifiedRemovable: 0,
      candidates: 93,
      timestamp: "2026-09-07T18:18:02.000Z",
    },
    {
      eventId: "e004",
      type: "orchestrator.completion_blocked",
      reason: "head-divergence",
      heads: { qa: "933ea6f", ci: "12e9ac6", pr: "001259d" },
      timestamp: "2026-09-07T18:19:01.000Z",
    },
    {
      eventId: "e005",
      type: "workflow.skipped",
      reason: "open-sweep-pr",
      evidence: { pr: 56, repo: "tycenjmccann/ember" },
      timestamp: "2026-09-07T18:19:39.000Z",
    },
  ],
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const intercepted = new Set();

async function installRoutes(page) {
  // Broadest first; Playwright matches the LAST-registered handler first, so the
  // specific handlers below win and this one only catches leftovers.
  await page.route("**/api/**", async (route) => {
    const u = new URL(route.request().url());
    intercepted.add(`(fallback) ${u.pathname}`);
    await json(route, {});
  });

  await page.route("**/api/workflow/list**", async (route) => {
    intercepted.add("GET /api/workflow/list");
    await json(route, LIST);
  });

  await page.route(`**/api/workflow/${NOOP_ID}/state**`, async (route) => {
    intercepted.add(`GET /api/workflow/${NOOP_ID}/state?t=<ts>`);
    await json(route, STATE);
  });

  await page.route(`**/api/workflow/${NOOP_ID}/events**`, async (route) => {
    intercepted.add(`GET /api/workflow/${NOOP_ID}/events`);
    await json(route, EVENTS);
  });

  await page.route(`**/api/workflow/${NOOP_ID}/tickets**`, async (route) => {
    intercepted.add(`GET /api/workflow/${NOOP_ID}/tickets`);
    await json(route, { tickets: [], browseBaseUrl: "" });
  });

  await page.route(`**/api/workflow/${NOOP_ID}/watch**`, async (route) => {
    intercepted.add(`GET /api/workflow/${NOOP_ID}/watch`);
    await json(route, { watch: false });
  });

  await page.route(`**/api/workflow/${NOOP_ID}/agent-output**`, async (route) => {
    intercepted.add(`GET /api/workflow/${NOOP_ID}/agent-output?agentId=<id>`);
    await json(route, { output: "", runs: [] });
  });

  await page.route(`**/api/workflow/${NOOP_ID}/analysis**`, async (route) => {
    intercepted.add(`GET /api/workflow/${NOOP_ID}/analysis`);
    await json(route, { analysis: null });
  });

  // A complete-but-empty FleetView (src/lib/workflow/performance.ts:209) — the
  // "no run selected" placeholder renders PerformanceCard, and a partial shape
  // throws inside its useMemo and takes the whole page down via the error boundary.
  await page.route("**/api/workflow/performance**", async (route) => {
    intercepted.add("GET /api/workflow/performance");
    await json(route, {
      window: {
        days: 7,
        start: STARTED,
        end: FINISHED,
        priorStart: STARTED,
        baselineStart: STARTED,
      },
      workflowDefId: "all",
      defIds: [],
      runs: [],
      priorRuns: 0,
      kpis: [],
      agents: [],
      engines: {},
      totals: {
        runs: 0, cost: 0, persona: 0, coding: 0, tokens: 0,
        cacheRead: 0, cacheWrite: 0, agentWorkMs: 0, wallMs: 0,
        loops: 0, reworkRounds: 0,
      },
      infra: null,
      infraPerRun: null,
      status: "ok",
      anomalies: [],
      indexUpdatedAt: null,
    });
  });

  await page.route("**/api/pipeline/status**", async (route) => {
    intercepted.add("GET /api/pipeline/status");
    await json(route, { enabled: false, stages: [] });
  });

  // SSE: a stream that opens and stays silent. The board only enables the
  // EventSource after catch-up finishes; a 200 text/event-stream with a comment
  // keeps it "Live" instead of flapping through Reconnecting.
  await page.route(`**/api/workflow/${NOOP_ID}/stream**`, async (route) => {
    intercepted.add(`GET /api/workflow/${NOOP_ID}/stream (SSE)`);
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: ": stubbed idle stream\n\n",
    });
  });
}

const log = [];
function say(...parts) {
  const line = parts.join(" ");
  log.push(line);
  console.log(line);
}

async function bodyText(page) {
  return (await page.locator("body").innerText()).replace(/ /g, " ");
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") say(`      [browser console error] ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => say(`      [pageerror] ${String(e).slice(0, 400)}`));
  await installRoutes(page);
  // The run-history sidebar defaults to collapsed (page.tsx:44) and reads its
  // state from localStorage (page.tsx:54-56) — expand it so the Active/Completed
  // list is on screen. UI state only; no data is faked here.
  await context.addInitScript(() =>
    localStorage.setItem("workflow-history-collapsed", "false")
  );

  say("=== TEAM-4251 item 15 — live UI check of TEAM-4249 D2.9 ===");
  say(`    base URL: ${BASE}   viewport: 1440x900   browser: chromium (headless)`);
  say("");

  // ── 15a: the list ────────────────────────────────────────────────────────
  await page.goto(`${BASE}/workflow`, { waitUntil: "domcontentloaded" });
  await page.getByText("Dead-code sweep - ember").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);

  say("--- 15a  /workflow list");
  const sectionOf = async (label) => {
    // The section header <p> and its sibling cards live in the same <div>.
    const items = await page
      .locator(`xpath=//p[normalize-space(text())="${label}"]/following-sibling::div`)
      .allInnerTexts();
    return items.map((t) => t.replace(/\s+/g, " ").trim());
  };
  const active = await sectionOf("Active");
  const completed = await sectionOf("Completed");
  say(`      ACTIVE section    (${active.length}): ${JSON.stringify(active)}`);
  say(`      COMPLETED section (${completed.length}): ${JSON.stringify(completed)}`);
  const noopInCompleted = completed.some((t) => t.includes("Dead-code sweep - ember"));
  const noopInActive = active.some((t) => t.includes("Dead-code sweep - ember"));
  say(`      ASSERT no-op run is in COMPLETED, not ACTIVE: ${noopInCompleted && !noopInActive ? "PASS" : "FAIL"}`);
  const badgeEl = page.locator("span", { hasText: /^Nothing to remove$/i }).first();
  const badge = await badgeEl.innerText().catch(() => "(not found)");
  const badgeDom = await badgeEl.textContent().catch(() => "(not found)");
  say(`      list badge RENDERED: ${JSON.stringify(badge)}  (span is \`uppercase tracking-wider\`)`);
  say(`      list badge DOM text: ${JSON.stringify(badgeDom)}`);
  const dot = await page.locator("div.bg-sky-400\\/60").count();
  say(`      sky status dot (bg-sky-400/60) present: ${dot > 0 ? "YES" : "NO"} (count=${dot})`);
  await page.screenshot({ path: path.join(OUT, "ui-15a-workflow-list.png") });
  say(`      -> ui-15a-workflow-list.png`);
  say("");

  // ── select the no-op run, let catch-up replay finish ─────────────────────
  await page.getByText("Dead-code sweep - ember").first().click();
  await page.waitForSelector(".pipeline-status-header", { timeout: 20000 });
  // catch-up is fixed at ~3s, then replayMode/catchingUp flip false
  await page.waitForFunction(
    () => !document.body.innerText.includes("Catching up..."),
    null,
    { timeout: 25000 }
  );
  // Every orchestrator event also fires a 4s transient toast (WorkflowBoard.tsx:633-642)
  // — let the last one expire so it doesn't cover the header in the screenshots.
  await page.waitForTimeout(4800);
  // Collapse the app nav so the 1440px viewport can fit the centred board header
  // (.pipeline-status-header is position:absolute;left:50% of a board wider than
  // the viewport). Pure layout; changes no data.
  await page.getByText("Collapse", { exact: true }).click().catch(() => {});
  await page.waitForTimeout(600);
  await page.locator(".pipeline-status-header").first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);

  // ── 15b: the board header ────────────────────────────────────────────────
  say("--- 15b  board header for the nothing-to-remove run");
  const header = page.locator(".pipeline-status-header").first();
  const headerText = (await header.innerText()).replace(/\s+/g, " ").trim();
  const headerDom = (await header.textContent()).replace(/\s+/g, " ").trim();
  const headerClass = await header.getAttribute("class");
  say(`      header innerText : ${JSON.stringify(headerText)}   <- as RENDERED`);
  say(`      header textContent: ${JSON.stringify(headerDom)}   <- DOM string`);
  say("      (the two differ only in word case: .pipeline-status-header carries");
  say("       text-transform:capitalize at WorkflowBoard.tsx:2130, a pre-existing");
  say('       style that also renders "Deploy Blocked" / "Complete". Not a D2.9 change.)');
  say(`      header class     : ${JSON.stringify(headerClass)}`);
  say(`      ASSERT class carries the no-op tone ("noop"): ${/\bnoop\b/.test(headerClass) ? "PASS" : "FAIL"}`);
  const headerBg = await header.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, background: s.backgroundColor, border: s.borderColor };
  });
  say(`      header computed  : ${JSON.stringify(headerBg)}`);

  let text = await bodyText(page);
  const notContains = (needle) => {
    const hit = text.includes(needle);
    say(`      ASSERT page text does NOT contain ${JSON.stringify(needle)}: ${hit ? "FAIL (present)" : "PASS"}`);
    return !hit;
  };
  const a1 = notContains("In Progress: nothing-to-remove");
  const a2 = notContains("Waiting to start");
  const a3 = notContains("Idle - Waiting to start");
  const headerOk = headerDom.includes("Nothing to Remove");
  say(`      ASSERT header DOM text is "Nothing to Remove": ${headerOk ? "PASS" : "FAIL"}`);
  // The finished-run section: WorkflowManagerPanel renders for isNoOpPhase runs
  // (WorkflowBoard.tsx:1932) and the Cancel/watch controls are gone for a
  // terminal phase (WorkflowBoard.tsx:1519 `!isTerminalPhase`).
  const managerPanel = await page.locator("text=/Run analysis|Analyze run|Workflow Manager/i").count();
  const cancelBtn = await page.getByRole("button", { name: /^Cancel/i }).count();
  say(`      finished-run analysis panel rendered: ${managerPanel > 0 ? "YES" : "NO"} (matches=${managerPanel})`);
  say(`      active-run Cancel control rendered  : ${cancelBtn > 0 ? "YES (unexpected)" : "NO (expected: terminal run)"}`);
  await page.screenshot({ path: path.join(OUT, "ui-15b-board-header.png") });
  say(`      -> ui-15b-board-header.png`);
  say("");

  // ── 15c: the orchestrator notices ────────────────────────────────────────
  say("--- 15c  orchestrator notices (completion_blocked / skipped)");
  say("      NOTE: WorkflowBoard.tsx:660-665 reconstructs the notice as the LAST");
  say("      orchestrator event up to replayIndex, so exactly ONE notice is on");
  say("      screen at a time. Captured at two scrubber positions.");
  const notice = page.locator('[data-testid="orchestrator-notice"]');
  const readNotice = async () => (await notice.innerText()).replace(/\s+/g, " ").trim();

  // At the end of the log the last orchestrator event is workflow.skipped.
  await notice.waitFor({ timeout: 10000 });
  const skippedLine = await readNotice();
  say(`      [scrub 5/5] rendered notice: ${JSON.stringify(skippedLine)}`);
  const noticeStyle = await notice.locator(".review-banner-label").evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, fontSize: s.fontSize, fontWeight: s.fontWeight };
  });
  say(`      notice label computed style: ${JSON.stringify(noticeStyle)}`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "ui-15c-events.png") });
  say(`      -> ui-15c-events.png  (workflow.skipped notice + Nothing to Remove header)`);

  // Scrub back one event so completion_blocked becomes the last one applied.
  const scrubber = page.locator("input.replay-scrubber").first();
  await scrubber.evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "3");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(1200);
  const blockedLine = await readNotice();
  say(`      [scrub 4/5] rendered notice: ${JSON.stringify(blockedLine)}`);
  const headerAfterScrub = (await header.textContent()).replace(/\s+/g, " ").trim();
  say(`      header at 4/5 (phase still closed by e003): ${JSON.stringify(headerAfterScrub)}`);
  await page.waitForTimeout(4200); // let the scrub's transient toast expire
  await page.screenshot({ path: path.join(OUT, "ui-15c2-events-completion-blocked.png") });
  say(`      -> ui-15c2-events-completion-blocked.png  (orchestrator.completion_blocked notice)`);

  // And back to e003 for the nothing_to_remove notice itself.
  await scrubber.evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "2");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(1000);
  const nothingLine = await readNotice();
  say(`      [scrub 3/5] rendered notice: ${JSON.stringify(nothingLine)}`);
  say("");

  // ── the requested string assertions, against what actually rendered ──────
  say("--- 15d  requested text assertions vs what the UI actually renders");
  const shas = ["933ea6f", "12e9ac6", "001259d"];
  const blockedHasShas = shas.every((s) => blockedLine.includes(s));
  say(`      ASSERT completion-blocked line contains all three sha7s ${JSON.stringify(shas)}: ${blockedHasShas ? "PASS" : "FAIL"}`);
  say(`             rendered: ${JSON.stringify(blockedLine)}`);

  const skippedHasSlug = skippedLine.includes("open-sweep-pr");
  say(`      ASSERT skipped line contains the literal slug "open-sweep-pr": ${skippedHasSlug ? "PASS" : "FAIL"}`);
  say(`             rendered: ${JSON.stringify(skippedLine)}`);
  if (!skippedHasSlug) {
    say('             WHY: run-outcome-display.ts:177-180 SKIP_REASONS maps the slug to');
    say('             prose — "open-sweep-pr" -> "an earlier sweep PR is still open" — so the');
    say("             raw slug is by design never shown to a human. The equivalent assertion");
    say("             on the humanised wording is checked next.");
  }
  const skippedHasProse =
    skippedLine.includes("Run skipped") &&
    skippedLine.includes("an earlier sweep PR is still open") &&
    skippedLine.includes("pr=56") &&
    skippedLine.includes("repo=tycenjmccann/ember");
  say(`      ASSERT skipped line = "Run skipped - <prose reason> + evidence": ${skippedHasProse ? "PASS" : "FAIL"}`);

  // ── side observation found while scrubbing (see 15f) ─────────────────────
  await scrubber.evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "4");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(1000);
  const noticeBackAtEdge = await readNotice();

  // ── 15e: whole-page sweep on a FRESH load of the finished run ────────────
  // This is the state a reviewer actually lands on: navigate, select, let the
  // ~3s catch-up replay run to the end, read the page.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Dead-code sweep - ember").first().waitFor({ timeout: 20000 });
  await page.getByText("Dead-code sweep - ember").first().click();
  await page.waitForSelector(".pipeline-status-header", { timeout: 20000 });
  await page.waitForFunction(
    () => !document.body.innerText.includes("Catching up..."),
    null,
    { timeout: 25000 }
  );
  await page.waitForTimeout(1500);
  text = await bodyText(page);
  const freshNotice = await readNotice();
  const freshHeaderDom = (await header.textContent()).replace(/\s+/g, " ").trim();
  say("");
  say("--- 15e  whole-page sweep on a FRESH load of the finished run");
  say(`      header (DOM)   : ${JSON.stringify(freshHeaderDom)}`);
  say(`      notice (DOM)   : ${JSON.stringify(freshNotice)}`);
  const finalChecks = [
    ["does NOT contain 'In Progress: nothing-to-remove'", !text.includes("In Progress: nothing-to-remove")],
    ["does NOT contain 'Waiting to start'", !text.includes("Waiting to start")],
    ["does NOT contain the raw phase slug 'nothing-to-remove' anywhere", !text.includes("nothing-to-remove")],
    ["header DOM text is 'Nothing to Remove'", freshHeaderDom.includes("Nothing to Remove")],
    // innerText reflects CSS text-transform, and the badge span is `uppercase
    // tracking-wider` (page.tsx:593) — so match case-insensitively here and pin
    // the authored casing off textContent instead.
    ["contains the list badge (case-insensitive: renders UPPERCASE)", /nothing to remove/i.test(text)],
    ["notice on fresh load is the LAST event (workflow.skipped)", freshNotice.startsWith("Run skipped")],
  ];
  let freshOk = true;
  for (const [what, ok] of finalChecks) {
    if (!ok) freshOk = false;
    say(`      ${ok ? "PASS" : "FAIL"}  page ${what}`);
  }

  say("");
  say("--- 15f  OBSERVATION (not part of the acceptance item): stale notice at the live edge");
  say("      Scrubbing BACKWARD then forward to the last index leaves the notice on the");
  say("      value from the earlier scrub position:");
  say(`         after seek 5/5 -> 4/5 -> 3/5 -> 5/5, notice = ${JSON.stringify(noticeBackAtEdge)}`);
  say(`         expected the last event's line = ${JSON.stringify(skippedLine)}`);
  say("      Cause: WorkflowBoard.tsx:649 `if (!replayMode && atLiveEdge) return;` skips");
  say("      the reconstruction that owns the notice, and seekTo (:704) sets atLiveEdge");
  say("      true at the last index; the live handleEvent path deliberately does not");
  say("      write the notice (:635-640). Fresh load is correct (15e), so this only");
  say("      affects a user who scrubs back and returns. Cosmetic, pre-existing shape.");

  const streamPill = await page
    .locator("span", { hasText: /^(Live|Reconnecting\.\.\.|Connecting\.\.\.|Idle)$/ })
    .first()
    .innerText()
    .catch(() => "(not found)");
  say("");
  say("--- 15g  OBSERVATION: `finished` does not stop the SSE for a no-op close");
  say("      run-outcome-display.ts:59 documents `finished` as \"pollers, intervals and");
  say("      the SSE nudge stop\". Wiring check: the only consumer of outcome.finished is");
  say("      WorkflowBoard.tsx:1018 `outcome.tone === \"complete\" && outcome.finished`, so");
  say("      a nothing-to-remove run is never `isComplete`; wasLoadedCompleteRef stays");
  say("      false and the board takes the LIVE path, enabling the EventSource (:970).");
  say(`      status pill on the finished no-op run reads: ${JSON.stringify(streamPill)}`);
  say("      What IS correctly wired for the no-op phase: the tickets poller (:492-497,");
  say("      explicit D2.9 isNoOpPhase guard), the pipeline/deploy-gate poller (:161,");
  say("      via isTerminalPhase) and the /state poller (cleared at :448 on catch-up).");
  say("      So this is the SSE only — and it is pre-existing shape shared with the");
  say("      cancelled / error / deploy-blocked / static-ci-only closes, not new in D2.9.");

  const allPass =
    noopInCompleted && !noopInActive && a1 && a2 && a3 &&
    headerOk && blockedHasShas && skippedHasProse && freshOk;
  say("");
  say(`=== ITEM 15 RESULT: ${allPass ? "PASS" : "SEE FAILURES ABOVE"} ===`);
  say("    One requested assertion is unsatisfiable by design: the literal reason");
  say('    slug "open-sweep-pr" is never rendered — the UI humanises it. Verified on');
  say("    the humanised wording instead, and reported as a spec/UI wording mismatch,");
  say("    not a defect.");
  say("");
  say("--- endpoints intercepted (network layer only; no src/ file stubbed or edited)");
  for (const e of [...intercepted].sort()) say(`      ${e}`);

  await browser.close();
  return allPass;
}

main()
  .then((ok) => {
    console.log(`\nPROBE_EXIT=${ok ? 0 : 1}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("PROBE ERROR:", err);
    console.log("\nPROBE_EXIT=2");
    process.exit(0);
  });
