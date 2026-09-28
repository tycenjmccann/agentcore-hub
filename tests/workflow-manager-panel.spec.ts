import { test, expect } from "@playwright/test";

/**
 * Workflow Manager panel + chat drawer.
 *
 * Fully mocked via page.route() — no backend. Covers:
 *  - analysis panel renders verdict, score, metric cards, findings, recs
 *  - "Run Analysis" empty state → POST /analyze
 *  - chat drawer opens from the floating button and streams an SSE reply
 */

const WF_ID = "wf-complete-001";

const MOCK_WORKFLOWS = [
  {
    id: WF_ID,
    phase: "complete",
    epicId: "TEAM-100",
    input: { title: "Completed Feature", description: "A completed workflow" },
    workflowDefId: "software-delivery",
    startedAt: new Date(Date.now() - 3600000).toISOString(),
    completedAt: new Date().toISOString(),
  },
];

const MOCK_ANALYSIS = {
  workflowId: WF_ID,
  analysisId: "1719946800000-a3f9",
  schemaVersion: 1,
  workflowDefId: "software-delivery",
  epicId: "TEAM-100",
  analyzedAt: new Date().toISOString(),
  trigger: "auto",
  runOutcome: "complete",
  model: "us.anthropic.claude-opus-4-6-v1",
  s3Prefix: "workflows/wf-complete-001/analysis/1719946800000-a3f9/",
  metrics: {
    startedAt: new Date(Date.now() - 3600000).toISOString(),
    completedAt: new Date().toISOString(),
    totalDurationMs: 3600000,
    phases: [],
    agentTasks: [],
    humanReviews: [],
    humanWaitTotalMs: 900000,
    changeRequests: { count: 2, cycles: [] },
    fixTickets: { count: 1, ticketIds: ["TEAM-105"] },
    nudgeCount: 0,
    managerInterventions: [],
    errors: [],
    tokens: { totalInput: 120000, totalOutput: 30000, byAgent: {} },
    evalSummaries: [],
    counts: { tickets: 6, events: 40, artifacts: 12, completions: 5 },
    dataQuality: { ticketProvider: "dynamodb", missingSignals: [], notes: [] },
  },
  scores: { overall: 78, planning: 82, execution: 74, reviewEfficiency: 65, reworkDiscipline: 80 },
  verdict: "Solid delivery with review-cycle drag.",
  findings: [
    { title: "Design review blocked progress for 15m", kind: "bottleneck", severity: "high", phase: "design", evidence: "Gate TEAM-109 waited 15m (humanWaitTotalMs=900000)." },
    { title: "Clean requirements decomposition", kind: "success", severity: "low", phase: "requirements", evidence: "6 tickets, no orphaned dependencies." },
  ],
  recommendations: [
    { title: "Make the design gate non-blocking", priority: "P1", type: "gate-config", target: "design", description: "Switch onReject to hold-free async review.", expectedImpact: "Removes ~15m of idle wait per run." },
  ],
  trend: { priorRunsCompared: 0, deltas: { totalDurationMs: null, humanWaitTotalMs: null, changeRequests: null, overallScore: null }, notes: "First analyzed run for this definition." },
  summaryMarkdown: "## Summary\n\nThe workflow completed successfully with two change requests and one fix cycle. The design review gate was the main bottleneck.\n\n### Bottlenecks\n\n- Design review: 15 minutes of idle wait.",
};

const MOCK_STATE = {
  ...MOCK_WORKFLOWS[0],
  workflowId: WF_ID,
  repoConfig: { repos: [] },
  input: { title: "Completed Feature", description: "A completed workflow", workflowDefId: "software-delivery", sources: [] },
  agentTasks: {},
  messages: [],
  humanNotifications: [],
};

async function mockBoardEndpoints(page: import("@playwright/test").Page) {
  await page.route("**/api/workflow/list", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ workflows: MOCK_WORKFLOWS }) }));
  await page.route("**/api/workflow/*/state**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_STATE) }));
  await page.route("**/api/workflow/*/events", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [] }) }));
  await page.route("**/api/workflow/*/tickets", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tickets: [] }) }));
  await page.route("**/api/workflow/*/agent-output**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ output: "" }) }));
  await page.route("**/api/workflow/*/watch", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ watch: true }) }));
}

async function selectWorkflow(page: import("@playwright/test").Page) {
  await page.goto(`/workflow`);
  await page.waitForLoadState("networkidle");
  const expandBtn = page.locator("button[aria-label='Expand workflow history sidebar']");
  if (await expandBtn.isVisible().catch(() => false)) await expandBtn.click();
  await page.getByText("Completed Feature").first().click();
}

/**
 * WCAG contrast ratio for every element inside `.wm-panel` matching `selector`,
 * against the effective background actually behind it — not just the panel's
 * own background. Some elements (`.wm-kind`, `.wm-priority`) paint their own
 * translucent tint on top of the panel's opaque background, so the real
 * background is a composite of every ancestor's background-color, outermost
 * first (TEAM-5246). For an element with no tint of its own (e.g. `.wm-title`),
 * this reduces to the panel's background, matching the TEAM-5244 check.
 */
async function panelContrast(page: import("@playwright/test").Page, selector: string) {
  return page.locator(".wm-panel").first().evaluate((panel, sel) => {
    // getComputedStyle serializes color-mix() results as `color(srgb r g b / a)`
    // with 0-1 fractional channels, not `rgb()` 0-255 — normalize both forms.
    const toRgba = (color: string): [number, number, number, number] => {
      const m = color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
      const [r, g, b, a = 1] = m;
      if (color.trim().startsWith("color(")) return [r * 255, g * 255, b * 255, a];
      return [r ?? 0, g ?? 0, b ?? 0, a];
    };
    const luminance = ([r, g, b]: number[]) => {
      const [R, G, B] = [r, g, b].map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * R + 0.7152 * G + 0.0722 * B;
    };
    const compositeBg = (el: Element): [number, number, number] => {
      const chain: Element[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) chain.unshift(n);
      let [r, g, b] = [255, 255, 255];
      for (const node of chain) {
        const [cr, cg, cb, ca] = toRgba(getComputedStyle(node).backgroundColor);
        if (!ca) continue;
        r = cr * ca + r * (1 - ca);
        g = cg * ca + g * (1 - ca);
        b = cb * ca + b * (1 - ca);
      }
      return [r, g, b];
    };
    const els = Array.from(panel.querySelectorAll(sel)) as HTMLElement[];
    return els.map((el) => {
      const fg = getComputedStyle(el).color;
      const bgRgb = compositeBg(el);
      const fgRgb = toRgba(fg).slice(0, 3);
      const [l1, l2] = [luminance(bgRgb), luminance(fgRgb)].sort((a, b) => b - a);
      return {
        fg,
        bg: `rgb(${bgRgb.map((v) => Math.round(v)).join(",")})`,
        ratio: (l1 + 0.05) / (l2 + 0.05),
        text: el.textContent?.trim().slice(0, 40) ?? "",
      };
    });
  }, selector);
}

test.describe("Workflow Manager panel", () => {
  test("renders analysis: verdict, score, metric cards, findings, recommendations", async ({ page }) => {
    await mockBoardEndpoints(page);
    await page.route("**/api/workflow/*/analysis", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ latest: MOCK_ANALYSIS, history: [MOCK_ANALYSIS], trend: [] }) }));

    await selectWorkflow(page);

    await expect(page.getByText("Workflow Manager").first()).toBeVisible();
    await expect(page.getByText("Solid delivery with review-cycle drag.")).toBeVisible();
    await expect(page.getByText("78").first()).toBeVisible();
    await expect(page.getByText("Change requests")).toBeVisible();
    await expect(page.getByText("Design review blocked progress for 15m")).toBeVisible();
    await expect(page.getByText("Make the design gate non-blocking")).toBeVisible();
  });

  // TEAM-5244: `.wm-panel` used the undefined var(--pipeline-card, #18181b), so
  // in light theme the title (var(--pipeline-text) = #0f172a) sat on a dark
  // fallback background — contrast ~1.1:1. Pins WCAG AA (4.5:1) in both themes.
  for (const theme of ["dark", "light"] as const) {
    test(`panel title is readable against its own background (${theme} theme)`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
      await mockBoardEndpoints(page);
      await page.route("**/api/workflow/*/analysis", (r) =>
        r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ latest: MOCK_ANALYSIS, history: [MOCK_ANALYSIS], trend: [] }) }));

      await selectWorkflow(page);
      const panel = page.locator(".wm-panel").first();
      await expect(panel).toBeVisible();

      const appliedTheme = await page.evaluate(() => document.documentElement.dataset.theme);
      expect(appliedTheme).toBe(theme);

      const [{ bg, fg, ratio }] = await panelContrast(page, ".wm-title");
      expect(ratio, `title ${fg} on panel ${bg} must meet WCAG AA (4.5:1)`).toBeGreaterThanOrEqual(4.5);
    });

    // TEAM-5246: `.wm-error` was hardcoded #f87171 in both themes — 2.77:1 on
    // the light panel background (`--pipeline-card-bg` = #ffffff). Reuses the
    // TEAM-5240 "failure newer than latest analysis" mock so the error renders
    // on load, no click/poll needed.
    test(`analysis-failed error line is readable (${theme} theme)`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
      await mockBoardEndpoints(page);
      await page.route("**/api/workflow/*/analysis*", (r) =>
        r.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            latest: MOCK_ANALYSIS,
            history: [MOCK_ANALYSIS],
            trend: [],
            latestFailure: {
              eventId: `${Date.now()}-ee12`,
              timestamp: new Date().toISOString(),
              detail: { errorClass: "MaxTokensReachedException", message: "Harness error: max tokens", attempts: 2, trigger: "auto", attemptId: "att-contrast" },
            },
          }),
        }));

      await selectWorkflow(page);
      await expect(page.locator(".wm-error")).toContainText("Analysis failed");

      const [{ fg, bg, ratio }] = await panelContrast(page, ".wm-error");
      expect(ratio, `error ${fg} on ${bg} must meet WCAG AA (4.5:1)`).toBeGreaterThanOrEqual(4.5);
    });

    // TEAM-5246: scoreColor/SEVERITY_COLOR/KIND_BADGE/PRIORITY_COLOR and the
    // "Ask about this run" button text were hardcoded for the dark panel
    // background too. MOCK_ANALYSIS carries a "bottleneck" (orange) and a
    // "success" (green) finding plus a P1 (orange) recommendation, so all
    // three families of color are exercised, not just red.
    test(`score, kind and priority colors are readable (${theme} theme)`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
      await mockBoardEndpoints(page);
      await page.route("**/api/workflow/*/analysis", (r) =>
        r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ latest: MOCK_ANALYSIS, history: [MOCK_ANALYSIS], trend: [] }) }));

      await selectWorkflow(page);
      await expect(page.getByText("Solid delivery with review-cycle drag.")).toBeVisible();

      for (const selector of [".wm-score-chip", ".wm-overall", ".wm-kind", ".wm-priority", ".wm-ask-btn"]) {
        const rows = await panelContrast(page, selector);
        expect(rows.length, `expected at least one ${selector} element`).toBeGreaterThan(0);
        for (const { fg, bg, ratio, text } of rows) {
          expect(ratio, `${selector} "${text}" (${fg} on ${bg}) must meet WCAG AA (4.5:1)`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    // TEAM-5246: `.wm-run-btn`'s text was also hardcoded #38bdf8 — 1.94:1 on its
    // own light-theme tint background (rgba(14,165,233,.1) over #fff).
    test(`Run Analysis button text is readable in the empty state (${theme} theme)`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
      await mockBoardEndpoints(page);
      await page.route("**/api/workflow/*/analysis", (r) =>
        r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ latest: null, history: [], trend: [] }) }));

      await selectWorkflow(page);
      await expect(page.getByRole("button", { name: "Run Analysis" })).toBeVisible();

      for (const selector of [".wm-run-btn", ".wm-ask-btn"]) {
        const [{ fg, bg, ratio, text }] = await panelContrast(page, selector);
        expect(ratio, `${selector} "${text}" (${fg} on ${bg}) must meet WCAG AA (4.5:1)`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  test("empty state shows Run Analysis and posts to /analyze", async ({ page }) => {
    await mockBoardEndpoints(page);
    await page.route("**/api/workflow/*/analysis", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ latest: null, history: [], trend: [] }) }));

    let analyzeCalled = false;
    await page.route("**/api/workflow/*/analyze", (r) => {
      analyzeCalled = true;
      r.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ status: "analyzing", workflowId: WF_ID }) });
    });

    await selectWorkflow(page);
    const runBtn = page.getByRole("button", { name: "Run Analysis" });
    await expect(runBtn).toBeVisible();
    await runBtn.click();
    await expect.poll(() => analyzeCalled).toBe(true);
  });

  // TEAM-5226: a failed ANALYZE used to leave "Analyzing…" up for 10 minutes and
  // then reset silently. TEAM-5240: the poll is scoped to ITS attempt — the POST
  // returns an attemptId, the poll passes ?attempt=<id>, and only that attempt's
  // workflow.analysis_failed ends it.
  test("a failed analysis after Run Analysis is shown as an error", async ({ page }) => {
    await mockBoardEndpoints(page);
    const attemptSeen: string[] = [];
    await page.route("**/api/workflow/*/analysis*", (r) => {
      const attempt = new URL(r.request().url()).searchParams.get("attempt");
      if (attempt) attemptSeen.push(attempt);
      const latestFailure = attempt === "att-1"
        ? {
            eventId: `${Date.now()}-ab12`,
            timestamp: new Date().toISOString(),
            detail: { errorClass: "MaxTokensReachedException", message: "Harness error: max tokens", attempts: 4, trigger: "manual", attemptId: "att-1" },
          }
        : null;
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ latest: null, history: [], trend: [], latestFailure }),
      });
    });
    await page.route("**/api/workflow/*/analyze", (r) =>
      r.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ status: "analyzing", workflowId: WF_ID, attemptId: "att-1" }) }));

    await selectWorkflow(page);
    await page.getByRole("button", { name: "Run Analysis" }).click();
    // First poll tick is POLL_MS (10s) after the click.
    await expect(page.getByText(/Analysis failed: MaxTokensReachedException after 4 attempts/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Run Analysis" })).toBeEnabled();
    expect(attemptSeen).toContain("att-1");
  });

  // TEAM-5240: an auto-analysis failure (or reopening the panel after any
  // failure) must show without a Run Analysis click. The route returns the
  // newest failure newer than the latest analysis on every GET.
  test("a failure newer than the latest analysis shows on load, with no click", async ({ page }) => {
    await mockBoardEndpoints(page);
    await page.route("**/api/workflow/*/analysis*", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          latest: MOCK_ANALYSIS,
          history: [MOCK_ANALYSIS],
          trend: [],
          latestFailure: {
            eventId: `${Date.now()}-cd34`,
            timestamp: new Date().toISOString(),
            detail: { errorClass: "MaxTokensReachedException", message: "Harness error: max tokens", attempts: 2, trigger: "auto", attemptId: "att-auto" },
          },
        }),
      }));

    await selectWorkflow(page);
    await expect(page.getByText("Solid delivery with review-cycle drag.")).toBeVisible();
    await expect(page.getByText(/Analysis failed: MaxTokensReachedException after 2 attempts/)).toBeVisible();
  });
});

test.describe("Workflow Manager chat", () => {
  test("floating button opens the drawer and streams a reply", async ({ page }) => {
    await mockBoardEndpoints(page);
    await page.route("**/api/workflow/*/analysis", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ latest: null, history: [], trend: [] }) }));

    // SSE mock: shared harness schema — two text chunks + done.
    await page.route("**/api/workflow-manager/chat", (r) => {
      const body =
        `data: ${JSON.stringify({ type: "text", content: "Your slowest phase is " })}\n\n` +
        `data: ${JSON.stringify({ type: "text", content: "**design review**." })}\n\n` +
        `data: ${JSON.stringify({ type: "done" })}\n\n`;
      r.fulfill({ status: 200, contentType: "text/event-stream", body });
    });

    await page.goto(`/workflow`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Workflow Manager" }).click();
    await expect(page.getByPlaceholder("Ask the Workflow Manager…")).toBeVisible();

    await page.getByRole("button", { name: "What's our biggest bottleneck across recent runs?" }).click();
    await expect(page.getByText("design review", { exact: false })).toBeVisible();
  });
});
