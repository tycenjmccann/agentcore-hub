import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Evaluations tab: window selector, shared-runtime persona expansion, the
 * per-agent drilldown (score-over-time + scored sessions) and the session panel
 * (TEAM-4688).
 *
 * Fully hermetic — every /api/** call is intercepted in-page, so this spec needs
 * no AWS credentials and no seeded evaluation data. It only needs the app served
 * at PLAYWRIGHT_BASE_URL (default http://localhost:3000).
 *
 * Run: npx playwright test tests/tab-evaluations.spec.ts
 */

const AGENT_ID = "agentcore_hub_agent";
const AGENT_NAME = "Hub Agent (Shared Runtime)";
const PERSONA = "backend_dev";
const SESSION_A = "sess-4688-a";
const SESSION_B = "sess-4688-b";

type Json = Record<string, unknown>;

function json(route: Route, body: Json, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Overview payload; `windowLabel` echoes the requested window so the label assertion is real. */
function overview(days: string): Json {
  const label = days === "all" ? "all time" : `last ${days} days`;
  return {
    agents: [AGENT_NAME, "Workflow Manager"],
    // The server derives the column universe from the live roster's runtimeArns;
    // hosted personas never appear here, only under `personas`.
    columns: [
      { agentId: AGENT_ID, displayName: AGENT_NAME },
      { agentId: "agentcore_hub_workflow_manager", displayName: "Workflow Manager" },
    ],
    hosted: {
      agentcore_hub_requirements_analyst: AGENT_ID,
      agentcore_hub_backend_dev: AGENT_ID,
      agentcore_hub_qa_verifier: AGENT_ID,
      agentcore_hub_code_reviewer: AGENT_ID,
    },
    scorecard: {
      [AGENT_NAME]: {
        "Builtin.Correctness": { avg: 0.94, count: 40, passing: 100 },
        "Builtin.Helpfulness": { avg: 0.81, count: 40, passing: 81 },
      },
    },
    metrics: {
      [AGENT_NAME]: {
        sessions: 40,
        tokensIn: 2_400_000,
        tokensOut: 180_000,
        cacheRead: 1_200_000,
        cost: 92.5,
        costPerSession: 2.31,
        models: [{ model: "us.anthropic.claude-fable-5-1", input: 1, output: 1, cost: 92.5 }],
      },
    },
    personas: {
      [AGENT_NAME]: [
        {
          persona: PERSONA,
          sessions: 12,
          scores: {
            Correctness: { avg: 0.97, count: 12, passing: 100 },
            Helpfulness: { avg: 0.62, count: 12, passing: 62 },
          },
          cost: 31.4,
          costPerSession: 2.62,
        },
        {
          persona: "qa_verifier",
          sessions: 6,
          scores: { Correctness: { avg: 0.88, count: 6, passing: 88 } },
        },
      ],
    },
    evaluators: ["Correctness", "Helpfulness"],
    window: { days: days === "all" ? 365 : Number(days), start: "2026-09-08", end: "2026-09-15", timezone: "UTC" },
    windowLabel: label,
    lastUpdated: "2026-09-15T12:00:00.000Z",
  };
}

const TIMESERIES: Json = {
  series: [
    { day: "2026-09-13", sessions: 4, evaluators: { Correctness: { avg: 0.91, count: 4 }, Helpfulness: { avg: 0.7, count: 4 } } },
    { day: "2026-09-14", sessions: 6, evaluators: { Correctness: { avg: 0.95, count: 6 }, Helpfulness: { avg: 0.78, count: 6 } } },
    { day: "2026-09-15", sessions: 5, evaluators: { Correctness: { avg: 0.97, count: 5 }, Helpfulness: { avg: 0.84, count: 5 } } },
  ],
  window: { days: 7 },
};

/** First page ends mid-session: SESSION_B repeats on page 2 with its other evaluator. */
const RESULTS_PAGE_1: Json = {
  sessions: [
    {
      sessionId: SESSION_A,
      persona: PERSONA,
      workflowId: "wf-4688",
      ticketId: "TEAM-4688",
      evaluatedAt: "2026-09-15T11:30:00.000Z",
      evaluators: {
        Correctness: { score: 0.96, scoreLabel: "96%", status: "COMPLETED" },
        Helpfulness: { score: 0.58, scoreLabel: "58%", status: "COMPLETED" },
      },
    },
    {
      sessionId: SESSION_B,
      persona: "qa_verifier",
      workflowId: "wf-4688",
      evaluatedAt: "2026-09-15T10:05:00.000Z",
      evaluators: { Correctness: { score: 0.89, scoreLabel: "89%", status: "COMPLETED" } },
    },
  ],
  cursor: "cursor-page-2",
};

const RESULTS_PAGE_2: Json = {
  sessions: [
    {
      sessionId: SESSION_B,
      persona: "qa_verifier",
      workflowId: "wf-4688",
      evaluatedAt: "2026-09-15T10:05:00.000Z",
      evaluators: { Helpfulness: { score: 0.44, scoreLabel: "44%", status: "FAILED" } },
    },
    {
      sessionId: "sess-4688-c",
      persona: PERSONA,
      evaluatedAt: "2026-09-14T09:00:00.000Z",
      evaluators: { Correctness: { score: 0.93, scoreLabel: "93%", status: "COMPLETED" } },
    },
  ],
  cursor: null,
};

const CORRECTNESS_EXPLANATION =
  "The agent resolved every acceptance criterion in the ticket and cited the files it changed.";
const HELPFULNESS_EXPLANATION = "The final answer omitted the follow-up steps the operator asked for.";

const SESSION_DETAIL: Json = {
  sessionId: SESSION_A,
  agentId: AGENT_ID,
  persona: PERSONA,
  workflowId: "wf-4688",
  ticketId: "TEAM-4688",
  results: [
    {
      evaluator: "Builtin.Correctness",
      score: 0.96,
      scoreLabel: "96%",
      explanation: CORRECTNESS_EXPLANATION,
      explanationTruncated: false,
      errorType: null,
      errorMessage: null,
      status: "COMPLETED",
      statusReason: "",
      evaluatedAt: "2026-09-15T11:30:00.000Z",
      traceId: "1-68c7-abcdef",
      spanId: "0123456789abcdef",
    },
    {
      evaluator: "Builtin.Helpfulness",
      score: 0.58,
      scoreLabel: "58%",
      explanation: HELPFULNESS_EXPLANATION,
      explanationTruncated: true,
      errorType: "JudgeTimeout",
      errorMessage: "judge retried once",
      status: "COMPLETED",
      statusReason: "retry",
      evaluatedAt: "2026-09-15T11:31:00.000Z",
      traceId: "1-68c7-abcdef",
      spanId: "fedcba9876543210",
    },
  ],
  tracesHref: "/traces?sessionId=sess-4688-a",
  workflowHref: "/workflow?id=wf-4688",
};

// ─── Harness ────────────────────────────────────────────────────────────────

interface Mocks {
  /** `days` value of every /api/evaluations request, in order. */
  overviewDays: string[];
  /** Full URL of every /api/evaluations/timeseries request. */
  timeseries: string[];
  /** Full URL of every /api/evaluations/results request. */
  results: string[];
}

async function installMocks(page: Page): Promise<Mocks> {
  const calls: Mocks = { overviewDays: [], timeseries: [], results: [] };

  // Catch-all first: later, more specific handlers take precedence.
  await page.route((url) => url.pathname.startsWith("/api/"), (r) => json(r, {}));

  await page.route(
    (url) => url.pathname === "/api/evaluations/agents",
    (r) => json(r, { agents: [{ agentId: AGENT_ID, enabled: true }] })
  );

  await page.route(
    (url) => url.pathname === "/api/evaluations/timeseries",
    (r) => {
      calls.timeseries.push(r.request().url());
      return json(r, TIMESERIES);
    }
  );

  await page.route(
    (url) => url.pathname === "/api/evaluations/results",
    (r) => {
      const url = new URL(r.request().url());
      calls.results.push(r.request().url());
      return json(r, url.searchParams.get("cursor") ? RESULTS_PAGE_2 : RESULTS_PAGE_1);
    }
  );

  await page.route(
    (url) => url.pathname.startsWith("/api/evaluations/sessions/"),
    (r) => {
      const id = new URL(r.request().url()).pathname.split("/").pop() || "";
      return id === SESSION_A
        ? json(r, SESSION_DETAIL)
        : json(r, { error: "not found" }, 404);
    }
  );

  await page.route(
    (url) => url.pathname === "/api/evaluations",
    (r) => {
      const days = new URL(r.request().url()).searchParams.get("days") || "";
      calls.overviewDays.push(days);
      return json(r, overview(days || "7"));
    }
  );

  return calls;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe("Evaluations tab (TEAM-4688)", () => {
  test("window selector drives ?days= — the request and the label both change", async ({ page }) => {
    const calls = await installMocks(page);

    await page.goto("/evaluations");
    await expect(page.locator("[data-testid=eval-window-selector]")).toBeVisible();
    await expect(page.locator("[data-testid=eval-window-label]")).toHaveText("last 7 days");
    expect(calls.overviewDays).toContain("7");

    await page.locator("[data-testid=eval-window-30]").click();
    await expect(page.locator("[data-testid=eval-window-label]")).toHaveText("last 30 days");
    await expect.poll(() => calls.overviewDays).toContain("30");
    expect(new URL(page.url()).searchParams.get("days")).toBe("30");
    // The timeseries request follows the window too. It is polled, not asserted
    // outright: the sparkline fetch only fires once the overview response has
    // repopulated the agent columns, so it trails the label by a tick.
    await expect.poll(() => calls.timeseries.some((u) => u.includes("days=30"))).toBe(true);

    await page.locator("[data-testid=eval-window-all]").click();
    await expect(page.locator("[data-testid=eval-window-label]")).toHaveText("all time");
    await expect.poll(() => calls.overviewDays).toContain("all");
  });

  test("the shared-runtime column expands into its personas", async ({ page }) => {
    await installMocks(page);
    await page.goto("/evaluations?days=7");

    const agentCol = page.locator(`[data-testid=eval-col-${AGENT_ID}]`);
    await expect(agentCol.first()).toBeVisible();
    // A sparkline rides the agent's evaluator scores (one timeseries call per agent row).
    await expect(page.locator(`[data-testid=eval-sparkline-${AGENT_ID}-Correctness]`).first()).toBeVisible();

    // Personas are hidden until the group is expanded.
    await expect(page.locator(`[data-testid=eval-persona-col-${PERSONA}]`)).toHaveCount(0);

    await page.locator(`[data-testid=eval-expand-${AGENT_ID}]`).first().click();
    await expect(page.locator(`[data-testid=eval-persona-col-${PERSONA}]`).first()).toBeVisible();
    await expect(page.locator("[data-testid=eval-persona-col-qa_verifier]").first()).toBeVisible();
    // Persona rows carry their own scores and link to the drilldown with ?persona=.
    await expect(page.locator(`[data-testid="eval-score-${AGENT_ID}-${PERSONA}-Correctness"]`).first()).toHaveText("97%");
    await expect(
      page.locator(`[data-testid=eval-persona-col-${PERSONA}] a`).first()
    ).toHaveAttribute("href", new RegExp(`/evaluations/${AGENT_ID}\\?days=7&persona=${PERSONA}`));

    await page.locator(`[data-testid=eval-expand-${AGENT_ID}]`).first().click();
    await expect(page.locator(`[data-testid=eval-persona-col-${PERSONA}]`)).toHaveCount(0);
  });

  test("personas hosted on the shared runtime are never top-level columns", async ({ page }) => {
    await installMocks(page);
    await page.goto("/evaluations?days=7");
    await expect(page.locator(`[data-testid=eval-col-${AGENT_ID}]`).first()).toBeVisible();
    // Agents that own a runtime keep a column of their own...
    await expect(page.locator("[data-testid=eval-col-agentcore_hub_workflow_manager]").first()).toBeVisible();
    // ...while personas the API reports as hosted on the shared runtime render only
    // as ↳ sub-columns under the host, so no always-empty top-level column exists.
    for (const hosted of ["agentcore_hub_requirements_analyst", "agentcore_hub_backend_dev", "agentcore_hub_qa_verifier", "agentcore_hub_code_reviewer"]) {
      await expect(page.locator(`[data-testid=eval-col-${hosted}]`)).toHaveCount(0);
    }
  });

  test("drilldown renders the score-over-time chart and the sessions table", async ({ page }) => {
    const calls = await installMocks(page);
    await page.goto(`/evaluations/${AGENT_ID}?days=7&workflowId=wf-4688`);

    await expect(page.locator("[data-testid=eval-drilldown-title]")).toContainText(AGENT_NAME);

    // Chart: one small-multiple facet per evaluator, each an actual plotted line.
    await expect(page.locator("[data-testid=eval-trend-chart]")).toBeVisible();
    await expect(page.locator("[data-testid=eval-trend-Correctness]")).toBeVisible();
    await expect(page.locator("[data-testid=eval-trend-Helpfulness]")).toBeVisible();
    await expect(page.locator("[data-testid=eval-trend-Correctness] svg path.recharts-line-curve")).toHaveCount(1);

    // Y-axis tick labels must not start left of their own chart's SVG edge — the
    // TrendChart margin/width regression that silently clipped "50%"/"100%" down
    // to "0%" (visually indistinguishable in a screenshot; only the DOM catches it).
    const clippedTicks = await page.locator("[data-testid=eval-trend-chart]").evaluate((container) => {
      const bad: string[] = [];
      container.querySelectorAll(".recharts-yAxis").forEach((axis) => {
        const svgX = axis.closest("svg")?.getBoundingClientRect().x;
        if (svgX === undefined) return;
        axis.querySelectorAll(".recharts-cartesian-axis-tick text").forEach((el) => {
          const x = el.getBoundingClientRect().x;
          if (x < svgX) bad.push(`${el.textContent} at x=${x} < svg x=${svgX}`);
        });
      });
      return bad;
    });
    expect(clippedTicks).toEqual([]);

    // The workflow pre-filter is passed through to /results.
    expect(calls.results.some((u) => u.includes("workflowId=wf-4688"))).toBe(true);

    // Sessions table + evaluator score chips.
    await expect(page.locator("[data-testid=eval-sessions-table]")).toBeVisible();
    await expect(page.locator(`[data-testid=eval-session-row-${SESSION_A}]`)).toBeVisible();
    await expect(page.locator(`[data-testid=eval-session-score-${SESSION_A}-Correctness]`)).toHaveText("96%");
    await expect(page.locator(`[data-testid=eval-session-score-${SESSION_A}-Helpfulness]`)).toHaveText("58%");

    // Cursor pagination: page 2 merges the straddling session instead of duplicating it.
    await expect(page.locator(`[data-testid=eval-session-row-${SESSION_B}]`)).toHaveCount(1);
    await page.locator("[data-testid=eval-sessions-load-more]").click();
    await expect(page.locator("[data-testid=eval-session-row-sess-4688-c]")).toBeVisible();
    await expect(page.locator(`[data-testid=eval-session-row-${SESSION_B}]`)).toHaveCount(1);
    await expect(page.locator(`[data-testid=eval-session-score-${SESSION_B}-Helpfulness]`)).toHaveText("44%");
    await expect(page.locator("[data-testid=eval-sessions-load-more]")).toHaveCount(0);

    // Persona filter is present and rewrites the URL.
    await page.locator("[data-testid=eval-persona-filter]").selectOption(PERSONA);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("persona"))
      .toBe(PERSONA);
    expect(calls.timeseries.some((u) => u.includes(`persona=${PERSONA}`))).toBe(true);
  });

  test("session panel shows per-evaluator explanations plus trace and workflow links", async ({ page }) => {
    await installMocks(page);
    await page.goto(`/evaluations/${AGENT_ID}?days=7`);

    await page.locator(`[data-testid=eval-session-row-${SESSION_A}]`).click();
    const panel = page.locator("[data-testid=eval-session-panel]");
    await expect(panel).toBeVisible();
    await expect(page.locator("[data-testid=eval-session-panel-id]")).toContainText(SESSION_A);

    await expect(page.locator("[data-testid=eval-session-result-Correctness]")).toBeVisible();
    await expect(page.locator("[data-testid=eval-session-explanation-Correctness]")).toContainText(
      CORRECTNESS_EXPLANATION
    );
    await expect(page.locator("[data-testid=eval-session-explanation-Helpfulness]")).toContainText(
      HELPFULNESS_EXPLANATION
    );
    // Error detail is surfaced, not swallowed.
    await expect(page.locator("[data-testid=eval-session-error-Helpfulness]")).toContainText("JudgeTimeout");

    await expect(page.locator("[data-testid=eval-session-trace-link]")).toHaveAttribute(
      "href",
      "/traces?sessionId=sess-4688-a"
    );
    await expect(page.locator("[data-testid=eval-session-workflow-link]")).toHaveAttribute(
      "href",
      "/workflow?id=wf-4688"
    );

    await page.locator("[data-testid=eval-session-panel-close]").click();
    await expect(panel).toHaveCount(0);
  });
});
