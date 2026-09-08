import { test, expect, type Page, type Route } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Workflow board — mocked-UI regression suite for FR-D2.9 (TEAM-4249) and the
 * QA fixes TEAM-4276 filed against it. No AWS, no live runtime.
 *
 * WHY page.route() rather than a source stub: /workflow is a CLIENT component.
 * The page fetches /api/workflow/list from a useEffect, and WorkflowBoard fetches
 * /state, /events, /tickets, /watch, /agent-output and opens an EventSource on
 * /stream — all from the browser. Nothing is server-rendered from DynamoDB, so
 * intercepting at the network layer exercises the REAL component tree, the REAL
 * run-outcome-display.ts and the REAL CSS against a plain `next start` with zero
 * credentials — the merge-gate tier. Fixtures are the ones the TEAM-4251 QA probe
 * reported against, so this spec locks in exactly what QA measured.
 *
 * What it pins:
 *   • the finished no-op run lists under Completed with its "Nothing to remove" badge
 *   • the board header reads the outcome ("Nothing to Remove", no-op tone), never a slug
 *   • QA-2a: a finished run shows the replay control, no stream pill, and opens
 *     no EventSource at all
 *   • QA-2b: the orchestrator notice tracks the scrub position AND returns to the
 *     last event when the scrubber comes back to the live edge
 *   • the PR evidence screenshot (docs/team-4276-nothing-to-remove-finished.png)
 */

const NOOP_ID = "wf_qa_noop";
const LIVE_ID = "wf_qa_control";

const STARTED = "2026-09-07T18:02:11.000Z";
const FINISHED = "2026-09-07T18:19:40.000Z";

const NOOP_TITLE = "Dead-code sweep - ember";

/** The list: one finished no-op sweep + one active control run, so the
 *  Active/Completed split in the run-history sidebar is observable. */
const LIST = {
  workflows: [
    {
      id: NOOP_ID,
      phase: "nothing-to-remove",
      epicId: "TEAM-9999",
      input: {
        title: NOOP_TITLE,
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
    title: NOOP_TITLE,
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
 * The events in the shape /api/workflow/[id]/events actually returns
 * (transform-event.ts's default passthrough: { eventId, type, ...detail,
 * timestamp }). The three orchestrator events are NOT members of the closed
 * WorkflowEvent union — that is the whole point of FR-D2.9.
 *
 * Order matters twice over:
 *   - applyEventToState owns the phase in replay, so workflow.nothing_to_remove
 *     (e003) is what closes the run at its scrub position — the two later events
 *     return phase: null from describeOrchestratorEvent and leave the header alone;
 *   - the notice is the LAST orchestrator event up to replayIndex, so exactly one
 *     notice is on screen at a time. That is what the scrub journey below reads.
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

/** A complete-but-empty FleetView (src/lib/workflow/performance.ts) — the
 *  "no run selected" placeholder renders PerformanceCard, and a partial shape
 *  throws inside its useMemo and takes the page down via the error boundary.
 *  The same route serves RunPerformanceCard's ?workflowId= call, which reads
 *  `card` → undefined → header only. */
const FLEET_VIEW = {
  window: { days: 7, start: STARTED, end: FINISHED, priorStart: STARTED, baselineStart: STARTED },
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
};

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** Counts EventSource connections to the run's SSE endpoint (QA-2a). */
interface StreamHits {
  count: number;
}

async function installRoutes(page: Page): Promise<StreamHits> {
  const streamHits: StreamHits = { count: 0 };

  // Broadest FIRST — Playwright matches the LAST-registered handler first, so the
  // specific handlers below win and this one only catches leftovers (keeping the
  // suite hermetic even if the board grows a new fetch).
  await page.route("**/api/**", (r) => json(r, {}));

  await page.route("**/api/workflow/list**", (r) => json(r, LIST));
  await page.route(`**/api/workflow/${NOOP_ID}/state**`, (r) => json(r, STATE));
  await page.route(`**/api/workflow/${NOOP_ID}/events**`, (r) => json(r, EVENTS));
  await page.route(`**/api/workflow/${NOOP_ID}/tickets**`, (r) => json(r, { tickets: [], browseBaseUrl: "" }));
  await page.route(`**/api/workflow/${NOOP_ID}/watch**`, (r) => json(r, { watch: false }));
  await page.route(`**/api/workflow/${NOOP_ID}/agent-output**`, (r) => json(r, { output: "", runs: [] }));
  await page.route(`**/api/workflow/${NOOP_ID}/analysis**`, (r) => json(r, { analysis: null }));
  await page.route("**/api/workflow/performance**", (r) => json(r, FLEET_VIEW));
  await page.route("**/api/pipeline/status**", (r) => json(r, { enabled: false, stages: [] }));

  // SSE: an idle stream that opens and stays silent. On a FINISHED run this route
  // must never be hit at all — that is the QA-2a assertion.
  await page.route(`**/api/workflow/${NOOP_ID}/stream**`, (route) => {
    streamHits.count += 1;
    return route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: ": stubbed idle stream\n\n",
    });
  });

  return streamHits;
}

/** Open the finished no-op run and wait out the ~3s catch-up replay. */
async function openNoOpBoard(page: Page) {
  await page.goto("/workflow", { waitUntil: "domcontentloaded" });
  const row = page.getByText(NOOP_TITLE).first();
  await row.waitFor({ timeout: 20000 });
  await row.click();
  await page.waitForSelector(".pipeline-status-header", { timeout: 20000 });
  await page.waitForFunction(() => !document.body.innerText.includes("Catching up..."), null, {
    timeout: 25000,
  });
}

/** The PERSISTENT orchestrator line — never the .wm-pulse-toast, which self-clears. */
function notice(page: Page) {
  return page.locator('[data-testid="orchestrator-notice"]');
}

async function readNotice(page: Page) {
  return ((await notice(page).innerText()) || "").replace(/\s+/g, " ").trim();
}

/** React's controlled range input ignores fill() — set through the native
 *  descriptor and dispatch the events React listens for. */
async function scrubTo(page: Page, index: number) {
  await page.locator("input.replay-scrubber").first().evaluate((el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, String(value));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, index);
}

test.describe("Workflow board — nothing-to-remove terminal outcome (mocked)", () => {
  let streamHits: StreamHits;

  test.beforeEach(async ({ page }) => {
    // A run through catch-up (~3s) plus the 4s orchestrator-toast expiry does not
    // fit the config's 30s default with any margin.
    test.setTimeout(60_000);
    // The run-history sidebar defaults to collapsed and reads localStorage —
    // expand it so the Active/Completed split is on screen. UI state only.
    await page.addInitScript(() => localStorage.setItem("workflow-history-collapsed", "false"));
    streamHits = await installRoutes(page);
  });

  test("run history lists the finished no-op run under Completed with its badge", async ({ page }) => {
    await page.goto("/workflow", { waitUntil: "domcontentloaded" });
    await page.getByText(NOOP_TITLE).first().waitFor({ timeout: 20000 });

    const section = (label: string) =>
      page.locator(`xpath=//p[normalize-space(text())="${label}"]/following-sibling::div`);

    await expect(section("Completed")).toContainText(NOOP_TITLE);
    await expect(section("Active")).not.toContainText(NOOP_TITLE);
    await expect(section("Active")).toContainText("Control run - active feature");

    // The badge span is CSS-uppercased, so match the DOM text case-insensitively.
    const badge = page.locator("span", { hasText: /^Nothing to remove$/i }).first();
    expect(((await badge.textContent()) || "").trim()).toMatch(/^nothing to remove$/i);
  });

  test("board header reads the outcome, not a phase slug", async ({ page }) => {
    await openNoOpBoard(page);

    const header = page.locator(".pipeline-status-header").first();
    // textContent, not innerText: the header carries text-transform:capitalize.
    expect((await header.textContent()) || "").toContain("Nothing to Remove");
    expect((await header.getAttribute("class")) || "").toMatch(/\bnoop\b/);

    const body = await page.locator("body").innerText();
    expect(body).not.toContain("In Progress:");
    expect(body).not.toContain("Waiting to start");
    expect(body).not.toContain("nothing-to-remove"); // the raw slug is never shown
  });

  test("QA-2a: finished run shows the replay control, no stream pill, and opens no EventSource", async ({
    page,
  }) => {
    await openNoOpBoard(page);

    await expect(page.getByTestId("replay-finished")).toBeVisible();
    await expect(page.getByTestId("stream-status")).toHaveCount(0);
    await expect(page.locator(".live-btn")).toHaveCount(0);

    // A terminal run can never emit again, so the board must not hold an
    // EventSource open — including the mount-time one before /state resolves
    // (the `!!state` clause of the gate).
    await page.waitForTimeout(1500);
    expect(streamHits.count).toBe(0);
  });

  test("QA-2b: orchestrator notice tracks the scrub position and returns to the last event", async ({
    page,
  }) => {
    await openNoOpBoard(page);
    await notice(page).waitFor({ timeout: 10000 });

    // At the live edge the notice is the LAST orchestrator event: workflow.skipped,
    // with its slug humanised and its evidence flattened.
    await expect(notice(page)).toContainText("Run skipped");
    await expect(notice(page)).toContainText("an earlier sweep PR is still open");
    await expect(notice(page)).toContainText("pr=56");
    await expect(notice(page)).toContainText("repo=tycenjmccann/ember");

    // Scrub back one: completion_blocked becomes the last event applied. The header
    // stays "Nothing to Remove" — e003 is what closed the run, and both later
    // events report phase: null.
    await scrubTo(page, 3);
    await expect(notice(page)).toContainText("Completion blocked");
    for (const sha of ["933ea6f", "12e9ac6", "001259d"]) {
      await expect(notice(page)).toContainText(sha);
    }
    expect((await page.locator(".pipeline-status-header").first().textContent()) || "").toContain(
      "Nothing to Remove",
    );

    // Back to e003, its own notice.
    await scrubTo(page, 2);
    await expect(notice(page)).toContainText("Nothing to remove");
    await expect(notice(page)).toContainText("93");

    // The QA-2b regression: returning to the last index used to leave the notice
    // frozen at the earlier scrub position, because the reconstruction effect
    // early-returned on atLiveEdge and seekTo(last) sets it true.
    await scrubTo(page, 4);
    await expect(notice(page)).toContainText("Run skipped");
    await expect(notice(page)).toContainText("an earlier sweep PR is still open");
  });

  test("evidence screenshot of the settled finished board", async ({ page }) => {
    await openNoOpBoard(page);
    await expect(notice(page)).toContainText("Run skipped");

    // Collapse the app nav so the 1440px viewport fits the centred board header
    // (.pipeline-status-header is position:absolute;left:50% of a board wider than
    // the viewport). Pure layout; changes no data.
    await page.getByText("Collapse", { exact: true }).click().catch(() => {});
    await page.locator(".pipeline-status-header").first().scrollIntoViewIfNeeded().catch(() => {});
    // Every orchestrator event fires a 4s transient toast — let the last expire so
    // it does not cover the header.
    await expect(page.locator(".wm-pulse-toast")).toHaveCount(0, { timeout: 10000 });

    const out = path.resolve(__dirname, "../docs/team-4276-nothing-to-remove-finished.png");
    await page.screenshot({ path: out });
    expect(existsSync(out)).toBe(true);
  });
});
