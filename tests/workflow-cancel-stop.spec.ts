import { test, expect, type Page } from "@playwright/test";

/**
 * Cancel needs a reason; Stop the run (TEAM-5360, the UI half of TEAM-5358 FR-3/FR-8).
 *
 * POST /api/workflow/[id]/cancel and POST /api/workflow/[id]/stop both refuse a
 * request with no reason (400 reason_required). The board's Cancel dialog must ask
 * for one and send it; Stop the run reuses the same dialog, POSTs /stop, and shows
 * which human gates it stopped and which it could not. /stop is human-only (403).
 *
 * Fully hermetic: ONE page.route handler answers every /api/** call (the
 * ticket-decision-picker.spec.ts pattern), so no AWS, no seeded workflow and no
 * write ever reaches a backend. E2E_LIVE_WRITES is not needed.
 *
 * Run: npx playwright test tests/workflow-cancel-stop.spec.ts
 */

const WF = "wf-cancel-stop-5360";
const GATE = "TEAM-1";

type Reply = { status: number; body: unknown };

interface Harness {
  cancels: Record<string, unknown>[];
  stops: Record<string, unknown>[];
  transitions: Record<string, unknown>[];
  phase: string;
}

/** A running (non-terminal) run, so the header shows Cancel and Stop the run. */
function mockState(phase: string) {
  return {
    id: WF,
    phase,
    epicId: "TEAM-5360",
    repoConfig: { layout: "monorepo", repos: [] },
    input: { title: "Cancel/stop fixture", description: "fixture", repoConfig: { layout: "monorepo", repos: [] }, sources: [] },
    agentTasks: {},
    messages: [],
    humanNotifications: [],
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  };
}

function gateTicket() {
  return {
    ticketId: GATE,
    title: "Merge Approval",
    type: "task",
    status: "in_review",
    assignee: "human:operator",
    description: "Approve the merge.\n\nDECISION OPTIONS: merge | hold\n",
    blockedBy: [],
    comments: [],
    artifacts: [],
  };
}

/** PerformanceCard dereferences totals.runs unguarded — `{}` would crash the page. */
const EMPTY_FLEET = {
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

const CANCELLED = { status: 200, body: { status: "cancelled", cancelledAt: new Date().toISOString(), tickets: [], humanGatesLeftOpen: [], ticketsLeftRunning: [], followUpsMoved: 0 } };

async function stubApi(page: Page, opts: { cancel?: Reply; stop?: Reply } = {}): Promise<Harness> {
  const h: Harness = { cancels: [], stops: [], transitions: [], phase: "development" };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    let reply: Reply = { status: 200, body: {} };
    if (path.endsWith(`/api/workflow/${WF}/cancel`) && req.method() === "POST") {
      h.cancels.push(req.postDataJSON());
      reply = opts.cancel ?? CANCELLED;
      if (reply.status === 200) h.phase = "cancelled";
    } else if (path.endsWith(`/api/workflow/${WF}/stop`) && req.method() === "POST") {
      h.stops.push(req.postDataJSON());
      reply = opts.stop ?? { status: 200, body: { ...CANCELLED.body, gatesStopped: [GATE], gatesNotStopped: [] } };
      if (reply.status === 200) h.phase = "cancelled";
    } else if (path.endsWith("/tickets/transition")) {
      h.transitions.push(req.postDataJSON());
    } else if (path.endsWith(`/api/workflow/${WF}/tickets`)) {
      reply = { status: 200, body: { tickets: [gateTicket()] } };
    } else if (path.endsWith(`/api/workflow/${WF}/state`)) {
      reply = { status: 200, body: mockState(h.phase) };
    } else if (path.endsWith("/api/workflow/list")) {
      reply = { status: 200, body: { workflows: [mockState(h.phase)] } };
    } else if (path.includes("/api/workflow/performance")) {
      reply = { status: 200, body: EMPTY_FLEET };
    } else if (path.endsWith("/events")) {
      reply = { status: 200, body: { events: [] } };
    } else if (path.endsWith("/agent-output")) {
      reply = { status: 200, body: { output: "" } };
    } else if (path.endsWith("/watch")) {
      reply = { status: 200, body: { watch: true } };
    }
    await route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) });
  });
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  return h;
}

const dialog = (page: Page) => page.locator("[role='alertdialog'][aria-labelledby='cancel-modal-title']");

async function openBoard(page: Page) {
  await page.goto(`/workflow?id=${WF}`);
  await expect(page.locator("button[aria-label='Cancel workflow']")).toBeVisible({ timeout: 20_000 });
}

test.describe("Cancel needs a reason (TEAM-5358 FR-3)", () => {
  test("confirm stays disabled until a non-blank reason, and the POST carries it", async ({ page }) => {
    const h = await stubApi(page);
    await openBoard(page);

    await page.locator("button[aria-label='Cancel workflow']").click();
    const modal = dialog(page);
    await expect(modal).toBeVisible();
    const confirm = modal.locator("button").filter({ hasText: /^Cancel Workflow$/ });
    const reason = modal.getByTestId("cancel-modal-reason");
    await expect(reason).toHaveAttribute("maxlength", "1000");
    await expect(confirm).toBeDisabled();

    await reason.fill("   ");
    await expect(confirm).toBeDisabled();

    await reason.fill("  wrong repo selected  ");
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect.poll(() => h.cancels.length).toBe(1);
    expect(h.cancels[0]).toEqual({ reason: "wrong repo selected" });
    await expect(modal).toHaveCount(0);
    await expect(page.locator("button[aria-label='Cancel workflow']")).toHaveCount(0);
  });

  test("a reason the route refuses is explained and the dialog stays open", async ({ page }) => {
    await stubApi(page, { cancel: { status: 400, body: { error: "reason_too_long", max: 1000 } } });
    await openBoard(page);

    await page.locator("button[aria-label='Cancel workflow']").click();
    const modal = dialog(page);
    await modal.getByTestId("cancel-modal-reason").fill("because");
    await modal.locator("button").filter({ hasText: /^Cancel Workflow$/ }).click();

    await expect(modal).toContainText("too long (max 1000 characters)");
    await expect(modal).toBeVisible();
  });
});

test.describe("Stop the run (TEAM-5358 FR-8)", () => {
  test("confirm + reason POSTs /stop, and the result names stopped and not-stopped gates", async ({ page }) => {
    const h = await stubApi(page, {
      stop: {
        status: 200,
        body: { ...CANCELLED.body, gatesStopped: [GATE], gatesNotStopped: [{ ticketId: "TEAM-2", error: "cancel_status_missing" }] },
      },
    });
    await openBoard(page);

    await page.locator("button[aria-label='Stop the run']").click();
    const modal = dialog(page);
    await expect(modal.locator("#cancel-modal-title")).toHaveText("Stop the run?");
    const confirm = modal.locator("button").filter({ hasText: /^Stop the run$/ });
    await expect(confirm).toBeDisabled();

    await modal.getByTestId("cancel-modal-reason").fill("customer withdrew the request");
    await confirm.click();

    await expect.poll(() => h.stops.length).toBe(1);
    expect(h.stops[0]).toEqual({ reason: "customer withdrew the request" });
    expect(h.cancels).toHaveLength(0);

    const result = modal.getByTestId("stop-result");
    await expect(result).toContainText("Stopped 1 gate");
    await expect(result).toContainText(GATE);
    await expect(result).toContainText("TEAM-2");
    await expect(result).toContainText("cancel_status_missing");

    await modal.getByRole("button", { name: "Close" }).click();
    await expect(modal).toHaveCount(0);
  });

  test("403 human_identity_required says a signed-in human is needed and shows no result", async ({ page }) => {
    const h = await stubApi(page, {
      stop: { status: 403, body: { error: "human_identity_required", reason: "default_identity" } },
    });
    await openBoard(page);

    await page.locator("button[aria-label='Stop the run']").click();
    const modal = dialog(page);
    await modal.getByTestId("cancel-modal-reason").fill("stop it");
    await modal.locator("button").filter({ hasText: /^Stop the run$/ }).click();

    await expect.poll(() => h.stops.length).toBe(1);
    await expect(modal).toContainText("signed-in human");
    await expect(modal.getByTestId("stop-result")).toHaveCount(0);
    expect(h.phase).toBe("development");
  });

  test("an open human gate ticket offers Stop the run, which opens the same dialog and POSTs /stop", async ({ page }) => {
    const h = await stubApi(page);
    await page.goto(`/workflow?id=${WF}&ticket=${GATE}`);
    await expect(page.locator("#ticket-modal-title")).toHaveText("Merge Approval", { timeout: 20_000 });

    await page.getByTestId("ticket-stop-run").click();
    await expect(page.locator("#ticket-modal-title")).toHaveCount(0);
    const modal = dialog(page);
    await expect(modal.locator("#cancel-modal-title")).toHaveText("Stop the run?");

    await modal.getByTestId("cancel-modal-reason").fill("abandoning the release");
    await modal.locator("button").filter({ hasText: /^Stop the run$/ }).click();

    await expect.poll(() => h.stops.length).toBe(1);
    expect(h.stops[0]).toEqual({ reason: "abandoning the release" });
    expect(h.transitions).toHaveLength(0);
  });
});
