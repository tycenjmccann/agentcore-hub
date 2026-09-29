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
 * Stop every CSS transition/animation and wait for any finite ones still
 * finishing, so a measurement reads the settled colour — globals.css gives
 * every element `transition: color .2s, background-color .2s`, and a read taken
 * mid-transition (e.g. right after data-theme is applied) sees an in-between
 * colour (TEAM-5251 N3).
 */
async function settle(page: import("@playwright/test").Page) {
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/**
 * Installs `window.__wmContrast` in the page: WCAG contrast measured through a
 * 1x1 canvas. The effective background is every ancestor's background-color
 * painted outermost-first over opaque white, so translucent tints composite
 * exactly as the browser does, and the canvas parses whatever getComputedStyle
 * serializes (`rgb()`, `color(srgb …)` from color-mix(), …) — no regex parsing
 * (TEAM-5246, TEAM-5251). The foreground is then painted over that background
 * with its own alpha times the cumulative `opacity` of its ancestors.
 */
async function installContrastKit(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    type Row = { what: string; text: string; fg: string; bg: string; ratio: number };
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const paint = (color: string, alpha = 1) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#000"; // an unparseable color would keep the previous fillStyle
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      ctx.globalAlpha = 1;
    };
    const pixel = () => Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    const rgb = (p: number[]) => `rgb(${p.join(",")})`;
    const luminance = (p: number[]) => {
      const [R, G, B] = p.map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * R + 0.7152 * G + 0.0722 * B;
    };
    const ratioOf = (a: number[], b: number[]) => {
      const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (l1 + 0.05) / (l2 + 0.05);
    };
    const bgPixel = (el: Element): number[] => {
      const chain: Element[] = [];
      for (let n: Element | null = el; n; n = n.parentElement) chain.unshift(n);
      ctx.clearRect(0, 0, 1, 1);
      paint("#ffffff");
      for (const node of chain) paint(getComputedStyle(node).backgroundColor);
      return pixel();
    };
    const opacityOf = (el: Element) => {
      let o = 1;
      for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
      return o;
    };
    /** `fg` painted on `bgEl`'s composite background. */
    const measure = (what: string, text: string, fg: string, bgEl: Element, fgEl: Element): Row => {
      const bg = bgPixel(bgEl);
      paint(rgb(bg));
      paint(fg, opacityOf(fgEl));
      const fgPx = pixel();
      return { what, text, fg: rgb(fgPx), bg: rgb(bg), ratio: Math.round(ratioOf(fgPx, bg) * 100) / 100 };
    };
    const describe = (el: Element) => {
      const own = `${el.tagName.toLowerCase()}${el.classList.length ? "." + Array.from(el.classList).join(".") : ""}`;
      const owner = el.closest("[class*='wm-']");
      const ownerCls = owner && owner !== el ? Array.from(owner.classList).find((c) => c.startsWith("wm-")) : null;
      return ownerCls ? `.${ownerCls} > ${own}` : own;
    };
    const visible = (el: Element) =>
      (el as HTMLElement).checkVisibility?.({ checkOpacity: true, visibilityProperty: true } as CheckVisibilityOptions) ?? true;
    const panel = () => {
      const p = document.querySelector(".wm-panel");
      if (!p) throw new Error("no .wm-panel");
      return p;
    };

    (window as unknown as { __wmContrast: unknown }).__wmContrast = {
      /** Elements matching `sel`: their `color` on their composite background. */
      bySelector(sel: string): Row[] {
        return Array.from(panel().querySelectorAll(sel)).map((el) =>
          measure(sel, el.textContent?.trim().slice(0, 40) ?? "", getComputedStyle(el).color, el, el));
      },
      /** Every visible, non-blank text node in the panel. */
      text(): Row[] {
        const rows: Row[] = [];
        const selects = new Set<Element>();
        const walker = document.createTreeWalker(panel(), NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = n.textContent?.trim() ?? "";
          let el = n.parentElement;
          if (!text || !el || el.closest("style,script")) continue;
          // <option> text is drawn by (and in the colours of) its <select>.
          const select = el.closest("select");
          if (select) {
            if (selects.has(select)) continue;
            selects.add(select);
            el = select;
          } else {
            const range = document.createRange();
            range.selectNodeContents(n);
            if (!range.getClientRects().length) continue;
          }
          if (!visible(el)) continue;
          const shown = select ? (select as HTMLSelectElement).selectedOptions[0]?.text ?? text : text;
          rows.push(measure(describe(el), shown.slice(0, 60), getComputedStyle(el).color, el, el));
        }
        return rows;
      },
      /** Non-text UI that carries meaning: icons, bar fills, score ring, severity rule, sparkline. */
      nonText(): Row[] {
        const p = panel();
        const rows: Row[] = [];
        for (const svg of Array.from(p.querySelectorAll("svg"))) {
          if (svg.classList.contains("recharts-surface") || !visible(svg)) continue;
          rows.push(measure(`icon ${describe(svg)}`, "", getComputedStyle(svg).color, svg, svg));
        }
        for (const fill of Array.from(p.querySelectorAll(".wm-bar-fill"))) {
          const label = fill.closest(".wm-subscore")?.querySelector(".wm-subscore-label")?.textContent ?? "";
          rows.push(measure(".wm-bar-fill vs track", label, getComputedStyle(fill).backgroundColor, fill.parentElement!, fill));
        }
        for (const ring of Array.from(p.querySelectorAll(".wm-overall"))) {
          rows.push(measure(".wm-overall ring", ring.textContent ?? "", getComputedStyle(ring).borderTopColor, ring, ring));
        }
        for (const f of Array.from(p.querySelectorAll(".wm-finding"))) {
          const title = f.querySelector(".wm-finding-title")?.textContent ?? "";
          rows.push(measure(".wm-finding severity rule", title, getComputedStyle(f).borderLeftColor, f.parentElement!, f));
        }
        for (const line of Array.from(p.querySelectorAll(".wm-sparkline .recharts-line-curve"))) {
          rows.push(measure("sparkline stroke", "", getComputedStyle(line).stroke, line, line));
        }
        return rows;
      },
      /** The sub-score bar track against the panel — must be visible at all (not a WCAG ratio). */
      track(): Row[] {
        return Array.from(panel().querySelectorAll(".wm-bar")).map((bar) => {
          const bg = bgPixel(bar.parentElement!);
          const tr = bgPixel(bar);
          return { what: ".wm-bar track vs panel", text: "", fg: rgb(tr), bg: rgb(bg), ratio: Math.round(ratioOf(tr, bg) * 100) / 100 };
        });
      },
    };
  });
}

type ContrastRow = { what: string; text: string; fg: string; bg: string; ratio: number };
type ContrastKit = Record<"text" | "nonText" | "track", () => ContrastRow[]> & { bySelector(sel: string): ContrastRow[] };

async function contrast(page: import("@playwright/test").Page, probe: "text" | "nonText" | "track"): Promise<ContrastRow[]> {
  await settle(page);
  await installContrastKit(page);
  return page.evaluate((k) => (window as unknown as { __wmContrast: ContrastKit }).__wmContrast[k](), probe);
}

/**
 * WCAG contrast for every element inside `.wm-panel` matching `selector`,
 * against the effective (composited) background behind it — see
 * installContrastKit. Measured after settle(), so never mid-transition.
 */
async function panelContrast(page: import("@playwright/test").Page, selector: string) {
  await settle(page);
  await installContrastKit(page);
  return page.evaluate((sel) => (window as unknown as { __wmContrast: ContrastKit }).__wmContrast.bySelector(sel), selector);
}

const fmtRows = (rows: ContrastRow[]) =>
  rows.map((r) => `  ${r.ratio.toFixed(2)}:1  ${r.what}  "${r.text}"  ${r.fg} on ${r.bg}`).join("\n");

/** Asserts every row meets `min`, listing every failure (not just the first). */
function expectAllAtLeast(rows: ContrastRow[], min: number, label: string) {
  const failing = rows.filter((r) => r.ratio < min);
  expect(failing, `${label}: ${failing.length}/${rows.length} below ${min}:1\n${fmtRows(failing)}`).toEqual([]);
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

/**
 * Every TONE the panel can paint, at once: sub-scores in all three score bands,
 * every finding kind (+ an unknown one, neutral) and severity (+ unknown),
 * every priority (+ P3, neutral), two history entries (history <select> +
 * label), two trend points (sparkline) and a failure (.wm-error). `overall`
 * picks the score chip / ring band.
 */
function allTonesResponse(overall: number) {
  const base = {
    ...MOCK_ANALYSIS,
    scores: { overall, planning: 92, execution: 71, reviewEfficiency: 40, reworkDiscipline: 80 },
    findings: [
      { title: "Critical gate stall", kind: "failure", severity: "critical", phase: "design", evidence: "Gate held 40m." },
      { title: "Review bottleneck", kind: "bottleneck", severity: "high", phase: "review", evidence: "3 review rounds." },
      { title: "Flaky CI risk", kind: "risk", severity: "medium", phase: "ci", evidence: "2 reruns." },
      { title: "Clean decomposition", kind: "success", severity: "low", phase: "requirements", evidence: "No orphans." },
      { title: "Unclassified note", kind: "observation", severity: "info", phase: "ship", evidence: "Neutral kind." },
    ],
    recommendations: [
      { title: "Unblock the gate", priority: "P0", type: "gate-config", target: "design", description: "Async review.", expectedImpact: "-40m idle." },
      { title: "Batch review comments", priority: "P1", type: "blueprint", target: "review", description: "One round.", expectedImpact: "-2 rounds." },
      { title: "Quarantine flaky test", priority: "P2", type: "ci", target: "ci", description: "Skip + ticket.", expectedImpact: "-2 reruns." },
      { title: "Tidy labels", priority: "P3", type: "hygiene", target: "ship", description: "Cosmetic.", expectedImpact: "Readability." },
    ],
  };
  const older = { ...base, analysisId: "1719940000000-b1c2", analyzedAt: new Date(Date.now() - 86_400_000).toISOString(), trigger: "manual" };
  const point = (a: typeof base, score: number) => ({
    analysisId: a.analysisId, workflowId: WF_ID, analyzedAt: a.analyzedAt, runOutcome: "complete",
    overallScore: score, totalDurationMs: 3600000, humanWaitTotalMs: 900000, changeRequestCount: 2,
  });
  return {
    latest: base,
    history: [base, older],
    trend: [point(base, overall), point(older, 64)],
    latestFailure: {
      eventId: `${Date.now()}-ff01`,
      timestamp: new Date().toISOString(),
      detail: { errorClass: "MaxTokensReachedException", message: "Harness error: max tokens", attempts: 2, trigger: "auto", attemptId: "att-tones" },
    },
  };
}

/**
 * TEAM-5251: a full sweep of the panel, not a hand-picked selector list — every
 * visible text node >= 4.5:1 (WCAG 1.4.3) and every meaningful non-text mark
 * (icons, bar fill vs its track, score ring, severity rule, sparkline) >= 3:1
 * (WCAG 1.4.11), in both themes, measured settled (see settle()). The
 * TEAM-5244 rename to the real --pipeline-text-muted (#64748b) put headings,
 * card labels, verdict kind/meta, impact lines and "No analysis yet" at 3.32:1
 * on the dark panel; #0ea5e9 icons were 2.77:1 on the light one.
 *
 * Not swept: the expanded "Full report" (MarkdownRenderer's own styles), the
 * sparkline hover tooltip, and the deterministic chip (needs a full perf card;
 * it inherits .wm-verdict-meta's colour, which is swept).
 */
test.describe("Workflow Manager panel contrast sweep (TEAM-5251)", () => {
  const states: Array<{ name: string; body: () => unknown; mustSee: string[] }> = [
    { name: "on-load", body: () => ({ latest: MOCK_ANALYSIS, history: [MOCK_ANALYSIS], trend: [] }),
      mustSee: ["Workflow Manager", "Findings", "Recommendations", "Trend", "Duration", "Impact:", "Workflow Manager assessment (agent-authored)", "design"] },
    { name: "empty", body: () => ({ latest: null, history: [], trend: [] }),
      mustSee: ["No analysis yet for this run.", "Run Analysis"] },
    ...[45, 70, 90].map((overall) => ({
      name: `all-tones overall=${overall}`,
      body: () => allTonesResponse(overall),
      mustSee: ["Findings", "Critical gate stall", "Unclassified note", "P3", "Prior analyses of this run:", "Full report", "Analysis failed"],
    })),
  ];

  for (const theme of ["dark", "light"] as const) {
    for (const state of states) {
      test(`${state.name}: every text node >= 4.5:1, non-text >= 3:1 (${theme} theme)`, async ({ page }) => {
        await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
        await mockBoardEndpoints(page);
        await page.route("**/api/workflow/*/analysis*", (r) =>
          r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state.body()) }));

        await selectWorkflow(page);
        const panel = page.locator(".wm-panel").first();
        await expect(panel).toContainText(state.mustSee[0]);
        await expect(panel.locator(".wm-spin")).toHaveCount(0);
        if (state.name.startsWith("all-tones")) await expect(panel.locator(".wm-sparkline .recharts-line-curve")).toHaveCount(1);
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);

        const text = await contrast(page, "text");
        // Guard against a vacuous pass: the sweep must actually have reached these.
        const swept = text.map((r) => r.text).join("\n");
        for (const s of state.mustSee) expect(swept, `sweep never measured "${s}"`).toContain(s);
        expectAllAtLeast(text, 4.5, `text (${theme}, ${state.name})`);

        const nonText = await contrast(page, "nonText");
        expect(nonText.some((r) => r.what.startsWith("icon")), "expected icons to be swept").toBe(true);
        expectAllAtLeast(nonText, 3, `non-text (${theme}, ${state.name})`);

        // The bar track must be visible at all in both themes (rgba(255,255,255,…)
        // on #fff is 1.00:1). Not a WCAG threshold — the fill carries the value.
        if (state.name !== "empty") {
          const track = await contrast(page, "track");
          expect(track.length).toBeGreaterThan(0);
          expectAllAtLeast(track, 1.2, `sub-score track visibility (${theme}, ${state.name})`);
        }
      });
    }
  }
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
