import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Hero KPI strip + sidebar KPI chips (TEAM-4482).
 *
 * Fully hermetic — every /api/** call is intercepted in-page, so this spec needs
 * no AWS credentials and no seeded workflows. It only needs the app served at
 * PLAYWRIGHT_BASE_URL (default http://localhost:3000).
 *
 * What it is really guarding: a terminal run's cost/time/quality must be above
 * the fold (the full performance card sits ~1 viewport down, inside .pipeline-viz),
 * and no missing value may ever render as a real-looking number — no $0 that reads
 * as spend, no 0/100, no grade F standing in for "we don't know".
 *
 * Run: npx playwright test tests/tab-workflow-hero-kpis.spec.ts
 */

// Under the gitignored playwright-screenshots/ (same convention as the other
// workflow specs): a tracked path would dirty the tree on every `npm test`.
const SCREENSHOT_DIR = "playwright-screenshots/team-4482";

const STRIP = "[data-testid=hero-kpi-strip]";
const COST = "[data-testid=hero-kpi-cost]";
const TIME = "[data-testid=hero-kpi-time]";
const QUALITY = "[data-testid=hero-kpi-quality]";

const WF = "wf-hero-4482";

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** The empty FleetView the pre-selection PerformanceCard needs (see beforeEach). */
const EMPTY_FLEET_VIEW = {
  window: { days: 7, start: "", end: "", priorStart: "", baselineStart: "" },
  workflowDefId: "all",
  defIds: [],
  runs: [],
  priorRuns: 0,
  kpis: [],
  agents: [],
  engines: {},
  totals: { runs: 0, cost: 0, persona: 0, coding: 0, tokens: 0, cacheRead: 0, cacheWrite: 0, agentWorkMs: 0, wallMs: 0, loops: 0, reworkRounds: 0 },
  infra: null,
  infraPerRun: null,
  status: "insufficient",
  anomalies: [],
  indexUpdatedAt: null,
};

type Json = Record<string, unknown>;

/** A v4 card — everything today's card has, and no `kpi` block. */
function v4Card(overrides: Json = {}): Json {
  return {
    reportVersion: 4,
    workflowId: WF,
    epicId: "TEAM-4482",
    workflowDefId: "sdlc-14",
    title: "Hero KPI fixture",
    run: { outcome: "complete", startedAt: null, completedAt: null, prUrl: null },
    cost: {
      totalUsd: 41.27, personaUsd: 30.27, codingUsd: 11, perTaskUsd: 1.2,
      tokens: { input: 900000, output: 120000, cached: 400000, total: 1420000 },
      personaCacheHitRate: 0.44, byEngine: { persona: { usd: 30.27 }, claude_code: { usd: 11 } },
    },
    time: {
      wallMs: 9180000, humanWaitMs: 1200000, activeMs: 7980000, agentWorkMs: 6000000,
      busyMs: 5400000, idleMs: 2580000, agentUtilization: 0.68, humanGates: 2, phases: [],
    },
    quality: {
      outcome: "complete", tasks: 14, tasksCompleted: 14, reworkRounds: 2, changeRequests: 1,
      fixTickets: 1, gateRounds: 3, loops: 3, nudges: 0, interventions: 0, errors: 0,
      retries: 1, firstPassYield: 0.79, prUrl: null,
    },
    agents: {},
    bands: {
      status: "ok",
      baseline: { workflowDefId: "sdlc-14", n: 7, nCost: 7, windowDays: 28, minSamples: 5 },
      anomalies: [],
      kpis: {
        "cost.totalUsd": { label: "Cost", unit: "usd", status: "ok", value: 41.27, median: 38, z: 0.4 },
        "time.wallMs": { label: "Wall time", unit: "ms", status: "warn", value: 9180000, median: 7200000, z: 1.6 },
        "quality.score": { label: "Quality", unit: "count", status: "ok", value: 74, median: 71, z: 0.2 },
      },
    },
    dataQuality: { gaps: [] },
    ...overrides,
  };
}

/** The deterministic v5 block; `quality` merges over the default so cases stay short. */
function kpiBlock(quality: Json = {}, cost: Json = {}): Json {
  return {
    version: 5,
    computedAt: new Date().toISOString(),
    cost: { usd: 41.27, band: "ok", z: 0.4, ...cost },
    time: { wallMs: 9180000, activeMs: 7980000, humanWaitMs: 1200000, band: "warn", z: 1.6 },
    quality: {
      score: 74, grade: "C", confidence: "full", evidenceWeight: 100, outcome: "complete",
      band: "ok", z: 0.2,
      components: [
        { key: "fpy", label: "First-pass yield", weight: 30, raw: 0.79, normalized: 0.79, points: 23.7, included: true, note: null },
        { key: "ci", label: "CI health", weight: 20, raw: 1, normalized: 1, points: 20, included: true, note: null },
      ],
      excluded: [],
      capsApplied: [],
      ...quality,
    },
  };
}

function v5Card(quality: Json = {}, cost: Json = {}, cardOverrides: Json = {}): Json {
  return { ...v4Card({ reportVersion: 5, ...cardOverrides }), kpi: kpiBlock(quality, cost) };
}

/**
 * The three cards that more than one case needs, named so the layout case (16)
 * and the content cases (3, 7) cannot drift apart and start proving different
 * things about "the same" card.
 */

/** An outcome-capped, cancelled run (case 3). Its quality sub-line is the longest
 *  in the fixture set, so it is also the tile that wraps to two lines first. */
function cappedCard(): Json {
  return v5Card({
    score: 69, grade: "D", outcome: "cancelled", band: "alert",
    capsApplied: [{ kind: "outcome", outcome: "cancelled", cap: 69 }],
  });
}

/** Cost was never measured, and the quality evidence is too thin to score (case 7). */
function costMissingCard(): Json {
  return v5Card(
    { score: null, grade: null, confidence: "insufficient", evidenceWeight: 30, band: "insufficient",
      excluded: ["CI health (no runs)", "Review depth (no reviews)"] },
    { usd: null, band: "insufficient", z: null },
    { dataQuality: { gaps: ["no token usage recorded"], costMissing: true } },
  );
}

/** A v5 card with nothing to compare against: every chip reads "no baseline". */
function noBaselineCard(): Json {
  return v5Card({ band: "insufficient", z: null }, { band: "insufficient", z: null }, {
    bands: {
      status: "insufficient",
      baseline: { workflowDefId: "sdlc-14", n: 0, nCost: 0, windowDays: 28, minSamples: 5 },
      anomalies: [],
      kpis: {
        "cost.totalUsd": { label: "Cost", unit: "usd", status: "insufficient", value: 41.27 },
        "time.wallMs": { label: "Wall time", unit: "ms", status: "insufficient", value: 9180000 },
        "quality.score": { label: "Quality", unit: "count", status: "insufficient", value: 74 },
      },
    },
  });
}

function mockState(id: string, phase = "complete"): Json {
  return {
    id,
    phase,
    epicId: "TEAM-4482",
    repoConfig: { layout: "monorepo", repos: [] },
    input: {
      title: "Hero KPI fixture",
      description: "fixture",
      repoConfig: { layout: "monorepo", repos: [] },
      sources: [],
    },
    agentTasks: {},
    messages: [],
    humanNotifications: [],
    startedAt: new Date(Date.now() - 9180000).toISOString(),
    ...(phase === "development" ? {} : { completedAt: new Date().toISOString() }),
  };
}

function listRow(id: string, title: string, extra: Json = {}): Json {
  return {
    id,
    phase: "complete",
    epicId: "TEAM-4482",
    input: { title, description: "" },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...extra,
  };
}

// ─── Mock harness ───────────────────────────────────────────────────────────

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

interface PerfMock {
  /** Per-GET response, consumed in order; the last entry repeats. */
  gets: ({ card: Json } | { status: number })[];
  /** Response to the POST, if the case clicks Compute now. */
  post?: { status: number; body?: Json };
  counts: { get: number; post: number };
  postBodies: unknown[];
}

/**
 * ONE handler for /api/workflow/performance, because the same path serves the
 * fleet card (no workflowId — the pre-selection empty state mounts it and
 * dereferences view.totals.runs, so it must get a real FleetView) and the
 * per-run card.
 *
 * `hold` (case 16) parks the per-run GET until the test releases it, so the
 * skeleton can be measured. The fleet GET is never held: the board mounts it too,
 * and holding it would freeze the page instead of just the strip.
 */
async function mockPerformance(page: Page, mock: PerfMock, hold?: Promise<void>) {
  await page.route("**/api/workflow/performance**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      mock.counts.post += 1;
      mock.postBodies.push(JSON.parse(request.postData() || "null"));
      const p = mock.post ?? { status: 202 };
      return json(route, p.body ?? { status: "accepted", pollAfterMs: 500 }, p.status);
    }
    const url = new URL(request.url());
    if (!url.searchParams.has("workflowId")) return json(route, EMPTY_FLEET_VIEW);
    if (hold) await hold;
    const step = mock.gets[Math.min(mock.counts.get, mock.gets.length - 1)];
    mock.counts.get += 1;
    if ("card" in step) return json(route, { card: step.card });
    return json(route, { error: "not found" }, step.status);
  });
}

function perfMock(gets: PerfMock["gets"], post?: PerfMock["post"]): PerfMock {
  return { gets, post, counts: { get: 0, post: 0 }, postBodies: [] };
}

async function mockBoard(page: Page, state: Json, analysis: Json = { latest: null, history: [] }) {
  await page.route("**/api/workflow/*/state**", (r) => json(r, state));
  await page.route("**/api/workflow/*/analysis", (r) => json(r, analysis));
  await page.route("**/api/workflow/*/events", (r) => json(r, { events: [] }));
  await page.route("**/api/workflow/*/tickets", (r) => json(r, { tickets: [] }));
  await page.route("**/api/workflow/*/agent-output**", (r) => json(r, { output: "" }));
  await page.route("**/api/workflow/*/watch", (r) => json(r, { watch: true }));
  await page.route("**/api/pipeline/status**", (r) => json(r, {}));
}

async function mockList(page: Page, rows: Json[]) {
  await page.route("**/api/workflow/list", (r) => json(r, { workflows: rows }));
}

/** Opens the board directly by id and waits for it to have rendered. */
async function openRun(page: Page, id = WF) {
  await page.goto(`/workflow?id=${id}`);
  await page.waitForSelector(".pipeline-status-header", { timeout: 15_000 });
}

test.describe("Hero KPI strip (TEAM-4482)", () => {
  test.beforeEach(async ({ page }) => {
    // Catch-all FIRST: Playwright checks the most-recently-registered matching
    // route first, so this (oldest) catches anything the per-case mocks below
    // don't cover, and never lets a call reach a live backend.
    await page.route("**/api/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));

    await page.addInitScript(() => {
      localStorage.setItem("theme", "dark");
      // The sidebar defaults to collapsed; the chip/sort cases need it open.
      localStorage.setItem("workflow-history-collapsed", "false");
    });
  });

  test("1. a complete run shows the strip above .pipeline-viz with formatted v5 KPIs", async ({ page }) => {
    await mockList(page, [listRow(WF, "Hero KPI fixture")]);
    await mockBoard(page, mockState(WF));
    await mockPerformance(page, perfMock([{ card: v5Card() }]));
    await openRun(page);

    const strip = page.locator(STRIP);
    await expect(strip).toBeVisible();

    // Above the fold means above the pipeline, which is min-height:100vh.
    const stripBox = (await strip.boundingBox())!;
    const vizBox = (await page.locator(".pipeline-viz").boundingBox())!;
    expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(vizBox.y + 1);

    // formatKpi is the only formatter: 41.27 -> "$41", 9180000ms -> "2h 33m".
    await expect(page.locator(COST)).toContainText("$41");
    await expect(page.locator(TIME)).toContainText("2h 33m");
    await expect(page.locator(QUALITY)).toContainText("74/100");
    await expect(page.locator(QUALITY)).toContainText("C");
    // Status is spelled out, never colour alone.
    await expect(page.locator(COST)).toContainText("within bands");
    await expect(page.locator(TIME)).toContainText("warn");

    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-strip-v5.png` });
  });

  test("2. a mid-flight run shows no strip", async ({ page }) => {
    await mockList(page, [listRow(WF, "Hero KPI fixture", { phase: "development" })]);
    await mockBoard(page, mockState(WF, "development"));
    await mockPerformance(page, perfMock([{ card: v5Card() }]));
    await openRun(page);

    await expect(page.locator(STRIP)).toHaveCount(0);
  });

  test("3. an outcome-capped run names the cap and the outcome", async ({ page }) => {
    await mockList(page, [listRow(WF, "Hero KPI fixture", { phase: "cancelled" })]);
    await mockBoard(page, mockState(WF, "cancelled"));
    await mockPerformance(page, perfMock([{ card: cappedCard() }]));
    await openRun(page);

    await expect(page.locator(STRIP)).toBeVisible();
    await expect(page.locator(QUALITY)).toContainText("capped at 69 — outcome cancelled");
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-capped.png` });
  });

  test("4. a v4 card (no kpi block) renders without throwing and admits it has no score", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await mockList(page, [listRow(WF, "Hero KPI fixture")]);
    await mockBoard(page, mockState(WF));
    await mockPerformance(page, perfMock([{ card: v4Card() }]));
    await openRun(page);

    await expect(page.locator(STRIP)).toBeVisible();
    await expect(page.locator(QUALITY)).toContainText("—");
    await expect(page.locator(QUALITY)).toContainText("no deterministic score");
    // The measured values are still real and still formatted.
    await expect(page.locator(COST)).toContainText("$41");
    await expect(page.locator(TIME)).toContainText("2h 33m");
    // Never a fabricated score.
    await expect(page.locator(QUALITY)).not.toContainText("0/100");
    expect(errors).toEqual([]);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/04-v4-card.png` });
  });

  test("5. no card yet: Compute now POSTs exactly once, then polling fills the tiles", async ({ page }) => {
    test.setTimeout(60_000);
    const mock = perfMock(
      [{ status: 404 }, { status: 404 }, { status: 404 }, { card: v5Card() }],
      { status: 202, body: { status: "accepted", pollAfterMs: 500 } },
    );
    await mockList(page, [listRow(WF, "Hero KPI fixture")]);
    await mockBoard(page, mockState(WF));
    await mockPerformance(page, mock);
    await openRun(page);

    // A terminal run with no card still gets a strip, and a way forward.
    await expect(page.locator(STRIP)).toBeVisible();
    await expect(page.locator(COST)).toContainText("not computed yet");
    const button = page.locator("[data-testid=hero-kpi-compute-now]");
    await expect(button).toBeVisible();
    await button.click();

    await expect(page.locator(QUALITY)).toContainText("74/100", { timeout: 30_000 });
    await expect(page.locator(COST)).toContainText("$41");
    expect(mock.counts.post).toBe(1);
    expect(mock.postBodies).toEqual([{ workflowId: WF }]);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-compute-now.png` });
  });

  test("6. a 429 means someone else is computing — say so, do not POST again", async ({ page }) => {
    test.setTimeout(60_000);
    // retryAfterMs is intentionally 60s (the field's real ceiling): if the code
    // polled on it instead of pollAfterMs, the 30s assertion below would time out.
    const mock = perfMock(
      [{ status: 404 }, { status: 404 }, { card: v5Card() }],
      { status: 429, body: { error: "already running", retryAfterMs: 60_000, pollAfterMs: 3000 } },
    );
    await mockList(page, [listRow(WF, "Hero KPI fixture")]);
    await mockBoard(page, mockState(WF));
    await mockPerformance(page, mock);
    await openRun(page);

    await page.locator("[data-testid=hero-kpi-compute-now]").click();
    await expect(page.locator(STRIP)).toContainText("already computing");
    await expect(page.locator(QUALITY)).toContainText("74/100", { timeout: 30_000 });
    expect(mock.counts.post).toBe(1);
  });

  test("7. missing cost reads '$0 · no usage data' with no band, and thin evidence never invents a score", async ({ page }) => {
    await mockList(page, [listRow(WF, "Hero KPI fixture")]);
    await mockBoard(page, mockState(WF));
    await mockPerformance(page, perfMock([{ card: costMissingCard() }]));
    await openRun(page);

    const cost = page.locator(COST);
    await expect(cost).toHaveText(/\$0\s*·\s*no usage data/);
    // No band chip: we have nothing to compare, and "$0" is not a measurement.
    await expect(cost).not.toContainText("within bands");
    await expect(cost).not.toContainText("no baseline");

    const quality = page.locator(QUALITY);
    await expect(quality).toContainText("insufficient evidence");
    await expect(quality).toContainText("—");

    // The whole strip: no fabricated zero score, no unearned F.
    const stripText = (await page.locator(STRIP).innerText()).replace(/\s+/g, " ");
    expect(stripText).not.toContain("0/100");
    expect(stripText).not.toMatch(/\bF\b/);

    // TEAM-4515 D-3: the full card sits directly below the strip and must not
    // contradict it. This fixture keeps v4Card's real cost block (41.27 / 30.27 /
    // 11 / 1.2) and only flags dataQuality.costMissing, so a card that ignored the
    // flag would happily print those numbers.
    const runCard = page.locator("#run-performance-card");
    await expect(runCard).toContainText(/\$0\s*·\s*no usage data/);
    await expect(runCard).not.toContainText("$41");
    await expect(runCard).not.toContainText("$1.20");
    // Time is measured and stays measured — only the cost rows go blank.
    await expect(runCard).toContainText("2h 33m");

    await page.screenshot({ path: `${SCREENSHOT_DIR}/07-missing-data.png` });
  });

  // ─── Sidebar chips + sort/filter ─────────────────────────────────────────

  // Explicit descending startedAt AND completedAt: Past is ordered by FINISH time
  // (byFinishedDesc — TEAM-4504), so listRow's `new Date()` completedAt default
  // would make the default order depend on which millisecond each row happened to
  // be constructed in. Both keys descend together here, so these three rows have
  // the one unambiguous order the cases below expect.
  const CHIP_ROWS = [
    listRow("wf-a", "Cheap run A", {
      startedAt: new Date(Date.UTC(2026, 0, 3)).toISOString(),
      completedAt: new Date(Date.UTC(2026, 0, 3, 1)).toISOString(),
      kpi: { version: 5, cost: { usd: 41.27 }, time: { wallMs: 9180000 }, quality: { score: 74, grade: "C", confidence: "full" } },
    }),
    listRow("wf-b", "Expensive run B", {
      startedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
      completedAt: new Date(Date.UTC(2026, 0, 2, 1)).toISOString(),
      kpi: { version: 5, cost: { usd: 182 }, time: { wallMs: 259200000 }, quality: { score: 58, grade: "F", confidence: "full" } },
    }),
    listRow("wf-c", "Uncomputed run C", {
      startedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      completedAt: new Date(Date.UTC(2026, 0, 1, 1)).toISOString(),
      kpi: null,
    }),
  ];

  async function openSidebar(page: Page) {
    await mockList(page, CHIP_ROWS);
    await mockBoard(page, mockState(WF));
    await mockPerformance(page, perfMock([{ status: 404 }]));
    await page.goto("/workflow");
    await page.waitForSelector("[data-testid=wf-sort]", { timeout: 15_000 });
  }

  /** The KPI chip text of every completed row, in render order. */
  async function chipRows(page: Page): Promise<string[]> {
    return (await page.locator("[data-testid=wf-kpi-chips]").allInnerTexts())
      .map((t) => t.replace(/\s+/g, " ").trim());
  }

  test("8. completed rows carry cost / time / grade chips, and '—' where there is no card", async ({ page }) => {
    await openSidebar(page);
    const rows = await chipRows(page);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe("$41 2h 33m 74 C");
    expect(rows[1]).toBe("$182 72h 58 F");
    expect(rows[2]).toBe("— — —");
    await page.screenshot({ path: `${SCREENSHOT_DIR}/08-list-chips.png` });
  });

  test("9. sorting by cost puts the priciest run first and the uncomputed run last", async ({ page }) => {
    await openSidebar(page);
    await page.locator("[data-testid=wf-sort]").selectOption("cost");
    const rows = await chipRows(page);
    expect(rows[0]).toBe("$182 72h 58 F");
    expect(rows[2]).toBe("— — —");
  });

  test("10. the grade filter narrows the list and reports how much it hid", async ({ page }) => {
    await openSidebar(page);
    const grade = page.locator("[data-testid=wf-grade]");

    await grade.selectOption("df");
    expect(await chipRows(page)).toEqual(["$182 72h 58 F"]);
    await expect(page.locator("[data-testid=workflow-history-list]")).toContainText("1 of 3");

    // A run with no score is "No score", never a D/F.
    await grade.selectOption("none");
    expect(await chipRows(page)).toEqual(["— — —"]);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/10-grade-filter.png` });
  });

  test("11. sort + filter survive the sidebar's 5s list re-poll", async ({ page }) => {
    test.setTimeout(60_000);
    let listCalls = 0;
    await page.route("**/api/workflow/list", (r) => { listCalls += 1; return json(r, { workflows: CHIP_ROWS }); });
    await mockBoard(page, mockState(WF));
    await mockPerformance(page, perfMock([{ status: 404 }]));
    await page.goto("/workflow");
    await page.waitForSelector("[data-testid=wf-sort]", { timeout: 15_000 });

    await page.locator("[data-testid=wf-sort]").selectOption("cost");
    await page.locator("[data-testid=wf-grade]").selectOption("all");
    const before = await chipRows(page);

    await expect.poll(() => listCalls, { timeout: 20_000 }).toBeGreaterThan(1);

    await expect(page.locator("[data-testid=wf-sort]")).toHaveValue("cost");
    await expect(page.locator("[data-testid=wf-grade]")).toHaveValue("all");
    expect(await chipRows(page)).toEqual(before);
  });

  // ─── Review fixes (TEAM-4509) ────────────────────────────────────────────

  test("12. Recompute on a v4 card keeps polling past stale v4 reads until the v5 card lands", async ({ page }) => {
    test.setTimeout(60_000);
    const mock = perfMock(
      [{ card: v4Card() }, { card: v4Card() }, { card: v4Card() }, { card: v5Card() }],
      { status: 202, body: { status: "accepted", pollAfterMs: 500 } },
    );
    await mockList(page, [listRow(WF, "Hero KPI fixture")]);
    await mockBoard(page, mockState(WF));
    await mockPerformance(page, mock);
    await openRun(page);

    await expect(page.locator(STRIP)).toBeVisible();
    await expect(page.locator(QUALITY)).toContainText("no deterministic score");
    const button = page.locator("[data-testid=hero-kpi-compute-now]");
    await expect(button).toHaveText("Recompute");
    await button.click();

    await expect(page.locator(QUALITY)).toContainText("74/100", { timeout: 30_000 });
    await expect(page.locator(COST)).toContainText("$41");
    // The button disappears once the card has a kpi block — nothing left to fix.
    await expect(button).toHaveCount(0);
    expect(mock.counts.post).toBe(1);
    // Proves polling continued past the two stale v4 reads instead of stopping
    // on the first one.
    expect(mock.counts.get).toBeGreaterThanOrEqual(4);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/12-recompute-v4.png` });
  });

  test("13. a v4 $0 card (span gap) reads '$0 · no usage data' with no band chip", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await mockList(page, [listRow(WF, "Hero KPI fixture")]);
    await mockBoard(page, mockState(WF));
    await mockPerformance(page, perfMock([
      {
        card: v4Card({
          cost: {
            totalUsd: 0, personaUsd: 0, codingUsd: 0, perTaskUsd: null,
            tokens: { input: 0, output: 0, cached: 0, total: 0 },
            personaCacheHitRate: null, byEngine: {},
          },
        }),
      },
    ]));
    await openRun(page);

    const cost = page.locator(COST);
    await expect(page.locator(STRIP)).toBeVisible();
    await expect(cost).toHaveText(/\$0\s*·\s*no usage data/);
    // bands.kpis["cost.totalUsd"] is still "ok" here — the chip is suppressed by
    // costMissing, not by an absent band.
    await expect(cost).not.toContainText("within bands");
    await expect(cost).not.toContainText("no baseline");
    await expect(cost).not.toContainText("personas");
    await expect(page.locator(TIME)).toContainText("2h 33m");
    await expect(page.locator(QUALITY)).toContainText("no deterministic score");

    // TEAM-4515 D-3: the full card read "$0.00" for the total and every cost row
    // while the strip above it said "no usage data" — a v4 $0 is an unmatched span,
    // not a free run, and $0.00 is the rendering that reads as a real bill.
    const runCard = page.locator("#run-performance-card");
    await expect(runCard).toContainText(/\$0\s*·\s*no usage data/);
    await expect(runCard).not.toContainText("$0.00");
    await expect(runCard).toContainText("2h 33m");
    expect(errors).toEqual([]);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/13-v4-zero-cost.png` });
  });

  test("14. a thin cost baseline shows the priced-run count, not the full n", async ({ page }) => {
    const bands = {
      status: "ok",
      baseline: { workflowDefId: "sdlc-14", n: 7, nCost: 2, windowDays: 28, minSamples: 5 },
      anomalies: [],
      kpis: {
        "cost.totalUsd": { label: "Cost", unit: "usd", status: "insufficient", value: 41.27 },
        "time.wallMs": { label: "Wall time", unit: "ms", status: "warn", value: 9180000, median: 7200000, z: 1.6 },
        "quality.score": { label: "Quality", unit: "count", status: "ok", value: 74, median: 71, z: 0.2 },
      },
    };
    await mockList(page, [listRow(WF, "Hero KPI fixture")]);
    await mockBoard(page, mockState(WF));
    await mockPerformance(page, perfMock([{ card: v5Card({}, { band: "insufficient", z: null }, { bands }) }]));
    await openRun(page);

    const cost = page.locator(COST);
    await expect(page.locator(STRIP)).toBeVisible();
    await expect(cost).toHaveAttribute("title", /2 of 5 priced runs/);
    await expect(page.locator(STRIP)).toContainText("baseline 7 runs / 28d · 2 priced");
    // BAND_TEXT.insufficient spells "insufficient" as "no baseline" (band-style.ts).
    await expect(cost).toContainText("no baseline");
    await expect(cost).not.toContainText("within bands");

    const runCard = page.locator("#run-performance-card");
    await expect(runCard).toContainText("no cost baseline (2/5 priced runs)");
    await expect(runCard).toContainText("2 priced");

    await page.screenshot({ path: `${SCREENSHOT_DIR}/14-thin-cost-baseline.png` });
  });

  // ─── Past order is finish-time based (TEAM-4515 D-1 / TEAM-4504) ──────────

  /**
   * A run that started FIRST but finished LAST, and one that started later but
   * finished earlier. Handed to the page in startedAt-descending order — exactly
   * the order the list API returns — so a "newest" that passed its input through,
   * or sorted on startedAt, would put the wrong row first.
   */
  const FINISH_ORDER_ROWS = [
    listRow("wf-late-start", "Started late, finished early", {
      startedAt: new Date(Date.UTC(2026, 0, 5)).toISOString(),
      completedAt: new Date(Date.UTC(2026, 0, 6)).toISOString(),
      kpi: { version: 5, cost: { usd: 88 }, time: { wallMs: 3600000 }, quality: { score: 90, grade: "A", confidence: "full" } },
    }),
    listRow("wf-early-start", "Started early, finished late", {
      startedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      completedAt: new Date(Date.UTC(2026, 0, 10)).toISOString(),
      kpi: { version: 5, cost: { usd: 12 }, time: { wallMs: 3600000 }, quality: { score: 80, grade: "B", confidence: "full" } },
    }),
  ];

  const LATE_START = "$88 1h 0m 90 A";
  const EARLY_START = "$12 1h 0m 80 B";

  test("15. the default 'newest' order is newest-FINISHED, not newest-started", async ({ page }) => {
    await mockList(page, FINISH_ORDER_ROWS);
    await mockBoard(page, mockState(WF));
    await mockPerformance(page, perfMock([{ status: 404 }]));
    await page.goto("/workflow");
    await page.waitForSelector("[data-testid=wf-sort]", { timeout: 15_000 });

    await expect(page.locator("[data-testid=wf-sort]")).toHaveValue("newest");
    // The run that started 4 days EARLIER but finished 4 days LATER leads.
    expect(await chipRows(page)).toEqual([EARLY_START, LATE_START]);

    // Round-trip through another sort: "newest" must RE-DERIVE finish order rather
    // than inherit whatever order the list was last left in.
    await page.locator("[data-testid=wf-sort]").selectOption("cost");
    expect(await chipRows(page)).toEqual([LATE_START, EARLY_START]);
    await page.locator("[data-testid=wf-sort]").selectOption("newest");
    expect(await chipRows(page)).toEqual([EARLY_START, LATE_START]);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/15-finish-time-order.png` });
  });

  // ─── The strip must not move the pipeline when the card lands (TEAM-4519) ──

  /**
   * QA measured the strip growing from 139.5px to 168.5px the moment the
   * performance GET resolved, which pushed `.pipeline-viz` down by 29px — the
   * skeleton reserved less space than the card it was standing in for. The design
   * NFR is that skeleton -> ready moves nothing, so these cases hold the GET open,
   * measure, release, and measure again.
   *
   * `.pipeline-viz` is the strip's next sibling and the full performance card and
   * Workflow Manager panel both live INSIDE it, so its top is a pure function of
   * the strip's own height: assert both and a regression names its own cause.
   */

  /** A hand-held promise: the deferred per-run GET waits here until release(). */
  function gate() {
    let release = () => {};
    const opened = new Promise<void>((resolve) => { release = () => resolve(); });
    return { opened, release };
  }

  /**
   * Both numbers in ONE evaluate, so they come from the same frame — two
   * round-trips could straddle a re-layout and compare different states. scrollY
   * comes too: getBoundingClientRect is viewport-relative, so a stray scroll
   * between the reads would otherwise look like a layout shift.
   */
  async function stripGeometry(page: Page) {
    return page.evaluate(() => {
      const viz = document.querySelector(".pipeline-viz")!;
      const strip = document.querySelector("[data-testid=hero-kpi-strip]")!;
      const round = (n: number) => Math.round(n * 100) / 100;
      return {
        vizTop: round(viz.getBoundingClientRect().top),
        stripHeight: round(strip.getBoundingClientRect().height),
        scrollY: window.scrollY,
      };
    });
  }

  interface ShiftCase {
    key: string;
    name: string;
    /** What the held GET answers once released. */
    gets: PerfMock["gets"];
    /** Board phase, for the cancelled run. */
    phase?: string;
    /** A Workflow Manager assessment makes the strip a 4-column grid. */
    analysis?: Json;
    /** Proof the resolved state really rendered before the second measurement. */
    ready: (page: Page) => Promise<void>;
    screenshots?: boolean;
  }

  const WM_ANALYSIS = {
    latest: { scores: { overall: 81 }, verdict: "Solid run — two avoidable rework loops." },
    history: [],
  };

  const SHIFT_CASES: ShiftCase[] = [
    {
      key: "a", name: "a v5 card with bands",
      gets: [{ card: v5Card() }],
      ready: async (page) => { await expect(page.locator(COST)).toContainText("$41"); },
      screenshots: true,
    },
    {
      key: "b", name: "a v5 card with no baseline",
      gets: [{ card: noBaselineCard() }],
      ready: async (page) => {
        await expect(page.locator(COST)).toContainText("$41");
        await expect(page.locator(COST)).toContainText("no baseline");
      },
    },
    {
      key: "c", name: "a v4 card (Recompute)",
      gets: [{ card: v4Card() }],
      ready: async (page) => {
        await expect(page.locator(QUALITY)).toContainText("no deterministic score");
        await expect(page.locator("[data-testid=hero-kpi-compute-now]")).toHaveText("Recompute");
      },
    },
    {
      key: "d", name: "a card whose cost was never measured",
      gets: [{ card: costMissingCard() }],
      ready: async (page) => { await expect(page.locator(COST)).toHaveText(/\$0\s*·\s*no usage data/); },
    },
    {
      key: "e", name: "a capped, cancelled run",
      gets: [{ card: cappedCard() }],
      phase: "cancelled",
      ready: async (page) => { await expect(page.locator(QUALITY)).toContainText("capped at 69 — outcome cancelled"); },
    },
    {
      key: "f", name: "no card yet (404 — Compute now)",
      gets: [{ status: 404 }],
      ready: async (page) => {
        await expect(page.locator(COST)).toContainText("not computed yet");
        await expect(page.locator("[data-testid=hero-kpi-compute-now]")).toHaveText("Compute now");
      },
    },
    {
      key: "g", name: "a v5 card plus a Workflow Manager assessment (4 columns)",
      gets: [{ card: v5Card() }],
      analysis: WM_ANALYSIS,
      ready: async (page) => { await expect(page.locator(COST)).toContainText("$41"); },
    },
  ];

  for (const c of SHIFT_CASES) {
    test(`16${c.key}. skeleton → ready never moves .pipeline-viz: ${c.name}`, async ({ page }) => {
      const { opened, release } = gate();
      await mockList(page, [listRow(WF, "Hero KPI fixture", c.phase ? { phase: c.phase } : {})]);
      await mockBoard(page, mockState(WF, c.phase ?? "complete"), c.analysis ?? { latest: null, history: [] });
      await mockPerformance(page, perfMock(c.gets), opened);

      try {
        await openRun(page);

        // The skeleton, on screen and still waiting on the GET.
        await expect(page.locator(`${STRIP}[aria-busy="true"]`)).toBeVisible();
        await expect(page.locator(`${COST} .animate-pulse`).first()).toBeVisible();
        // The Workflow Manager tile is fetched separately, so wait for the 4th
        // column BEFORE measuring: a tile that appeared between the two reads
        // would re-flow the grid and fail this for the wrong reason.
        if (c.analysis) await expect(page.locator("[data-testid=hero-kpi-wm]")).toBeVisible();
        const before = await stripGeometry(page);
        if (c.screenshots) await page.screenshot({ path: `${SCREENSHOT_DIR}/16-no-shift-loading.png` });

        release();

        await expect(page.locator(`${STRIP}[aria-busy="false"]`)).toBeVisible();
        await expect(page.locator(`${COST} .animate-pulse`)).toHaveCount(0);
        await c.ready(page);
        const after = await stripGeometry(page);
        if (c.screenshots) await page.screenshot({ path: `${SCREENSHOT_DIR}/16-no-shift-ready.png` });

        expect(after.vizTop).toBe(before.vizTop);           // the NFR
        expect(after.stripHeight).toBe(before.stripHeight); // ...and its only cause
        expect(after.scrollY).toBe(before.scrollY);         // nothing scrolled between the reads
      } finally {
        // Never leave the route parked if an assertion above threw.
        release();
      }
    });
  }
});
