import { test, expect, type Page } from "@playwright/test";

/**
 * Ticket detail modal: gate DECISION picker (TEAM-5324, FR-9 UI half of TEAM-5322).
 *
 * A human:* gate whose description declares `DECISION OPTIONS: a | b` closes only
 * on a decision the human picked. The modal must offer the options as a radio
 * group, keep Approve disabled until one is picked, send it as `decision`, and
 * explain each decision refusal the transition route returns. Plain tickets must
 * behave exactly as before.
 *
 * Fully hermetic: ONE page.route handler answers every /api/** call (switching on
 * the URL avoids depending on Playwright's route precedence), so no AWS, no seeded
 * workflow and no write ever reaches a backend. E2E_LIVE_WRITES is not needed.
 *
 * Run: npx playwright test tests/ticket-decision-picker.spec.ts
 */

const WF = "wf-decision-5324";
const TICKET = "TEAM-1";
const BOUND = "Lift the CI stall.\n\nDECISION OPTIONS: repaired | abort\n";
const PLAIN = "Review the spec and approve.";

type Reply = { status: number; body: unknown };

interface Harness {
  /** Every POST /tickets/transition body, in order. */
  posts: Record<string, unknown>[];
  /**
   * TEAM-5339: merged onto the fixture ticket on every GET /tickets — set this
   * between opens to simulate a ticket that already carries gate:verifying /
   * gate:approved-unverified (e.g. after a reprobe ran while the modal was shut).
   */
  ticketExtra: Record<string, unknown>;
}

/** A completed run is enough for the board to render and host the modal. */
function mockState() {
  return {
    id: WF,
    phase: "complete",
    epicId: "TEAM-5324",
    repoConfig: { layout: "monorepo", repos: [] },
    input: { title: "Decision picker fixture", description: "fixture", repoConfig: { layout: "monorepo", repos: [] }, sources: [] },
    agentTasks: {},
    messages: [],
    humanNotifications: [],
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    completedAt: new Date().toISOString(),
  };
}

function gateTicket(description: string) {
  return {
    ticketId: TICKET,
    title: "Merge Approval",
    type: "task",
    status: "in_review",
    assignee: "human:operator",
    description,
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

const OK: Reply = { status: 200, body: { success: true, ticketId: TICKET, newStatus: "done" } };

/**
 * Stub every API call. `replies` are served to successive transition POSTs; the
 * last one repeats.
 */
async function stubApi(page: Page, description: string, replies: Reply[] = [OK]): Promise<Harness> {
  const harness: Harness = { posts: [], ticketExtra: {} };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    let reply: Reply = { status: 200, body: {} };
    if (path.endsWith("/tickets/transition")) {
      harness.posts.push(req.postDataJSON());
      reply = replies[Math.min(harness.posts.length - 1, replies.length - 1)];
    } else if (path.endsWith(`/api/workflow/${WF}/tickets`)) {
      reply = { status: 200, body: { tickets: [{ ...gateTicket(description), ...harness.ticketExtra }] } };
    } else if (path.endsWith(`/api/workflow/${WF}/state`)) {
      reply = { status: 200, body: mockState() };
    } else if (path.endsWith("/api/workflow/list")) {
      reply = { status: 200, body: { workflows: [mockState()] } };
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
  return harness;
}

/** Deep link straight into the modal (WorkflowBoard's ?ticket= handler). */
async function openModal(page: Page) {
  await page.goto(`/workflow?id=${WF}&ticket=${TICKET}`);
  await expect(page.locator("#ticket-modal-title")).toHaveText("Merge Approval", { timeout: 20_000 });
}

/** Open the status dropdown and return its Approve item. */
async function approveItem(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /In Review/ }).click();
  return dialog.getByRole("button", { name: /^Approve/ });
}

test.describe("Ticket decision picker (TEAM-5324)", () => {
  test("a decision-bound gate requires exactly one pick, and the POST carries it", async ({ page }) => {
    const h = await stubApi(page, BOUND);
    await openModal(page);

    const group = page.getByRole("radiogroup");
    await expect(group).toBeVisible();
    const repaired = page.getByRole("radio", { name: "Decision: repaired" });
    const abort = page.getByRole("radio", { name: "Decision: abort" });
    await expect(repaired).toHaveAttribute("aria-checked", "false");
    await expect(abort).toHaveAttribute("aria-checked", "false");

    // Default none selected → Approve disabled, nothing sent.
    let approve = await approveItem(page);
    await expect(approve).toBeDisabled();

    // Keyboard: focus the group's tab stop, arrows move AND select.
    await repaired.focus();
    await page.keyboard.press("ArrowRight");
    await expect(abort).toHaveAttribute("aria-checked", "true");
    await expect(abort).toBeFocused();

    // Single click picks.
    await repaired.click();
    await expect(repaired).toHaveAttribute("aria-checked", "true");
    await expect(abort).toHaveAttribute("aria-checked", "false");

    approve = await approveItem(page);
    await expect(approve).toBeEnabled();
    await approve.click();

    await expect.poll(() => h.posts.length).toBe(1);
    expect(h.posts[0]).toEqual({ ticketId: TICKET, targetStatus: "done", decision: "repaired" });
  });

  test("a plain ticket has no picker and sends no decision", async ({ page }) => {
    const h = await stubApi(page, PLAIN);
    await openModal(page);

    await expect(page.getByRole("radiogroup")).toHaveCount(0);
    const approve = await approveItem(page);
    await expect(approve).toBeEnabled();
    await approve.click();

    await expect.poll(() => h.posts.length).toBe(1);
    expect(h.posts[0]).toEqual({ ticketId: TICKET, targetStatus: "done" });
    expect(h.posts[0]).not.toHaveProperty("decision");
  });

  test("409 decision_required lists the options, reveals the picker, and the retry sends the pick", async ({ page }) => {
    const h = await stubApi(page, PLAIN, [
      {
        status: 409,
        body: { error: "Ticket transition rejected", reason: "decision_required", options: ["continue", "cancel"], ticketId: TICKET, targetStatus: "done" },
      },
      OK,
    ]);
    await openModal(page);
    await expect(page.getByRole("radiogroup")).toHaveCount(0);

    await (await approveItem(page)).click();

    const alert = page.getByTestId("ticket-decision-notice");
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert).toContainText("continue");
    await expect(alert).toContainText("cancel");
    await expect(page.getByRole("radiogroup")).toBeVisible();
    await expect(await approveItem(page)).toBeDisabled();

    await page.getByRole("radio", { name: "Decision: cancel" }).click();
    await (await approveItem(page)).click();

    await expect.poll(() => h.posts.length).toBe(2);
    expect(h.posts[0]).not.toHaveProperty("decision");
    expect(h.posts[1]).toEqual({ ticketId: TICKET, targetStatus: "done", decision: "cancel" });
  });

  test("409 decision_required with no options falls back to the declared ones", async ({ page }) => {
    await stubApi(page, BOUND, [
      {
        status: 409,
        body: { error: "Ticket transition rejected", reason: "decision_required", options: [], detail: "decision_option_undeclared", ticketId: TICKET, targetStatus: "done" },
      },
    ]);
    await openModal(page);
    await page.getByRole("radio", { name: "Decision: abort" }).click();
    await (await approveItem(page)).click();

    const alert = page.getByRole("alert").filter({ hasText: "needs a decision" });
    await expect(alert).toContainText("repaired, abort");
    // The refused pick is cleared, so Approve is disabled again.
    await expect(page.getByRole("radio", { name: "Decision: abort" })).toHaveAttribute("aria-checked", "false");
  });

  test("decision_channel_unavailable gets its own message and keeps the pick", async ({ page }) => {
    await stubApi(page, BOUND, [
      {
        status: 409,
        body: { error: "Ticket transition rejected", reason: "decision_required", options: ["repaired", "abort"], detail: "decision_channel_unavailable", ticketId: TICKET, targetStatus: "done" },
      },
    ]);
    await openModal(page);
    await page.getByRole("radio", { name: "Decision: repaired" }).click();
    await (await approveItem(page)).click();

    const alert = page.getByTestId("ticket-decision-notice");
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert).toContainText("can't sign decisions");
    await expect(alert).not.toContainText("Choose one of");
    await expect(page.getByRole("radio", { name: "Decision: repaired" })).toHaveAttribute("aria-checked", "true");
  });

  test("403 service identity gets its own message", async ({ page }) => {
    await stubApi(page, BOUND, [
      {
        status: 403,
        body: { error: "Ticket transition rejected", reason: "decision_required", options: ["repaired", "abort"], detail: "service_identity_cannot_decide", ticketId: TICKET, targetStatus: "done" },
      },
    ]);
    await openModal(page);
    await page.getByRole("radio", { name: "Decision: repaired" }).click();
    await (await approveItem(page)).click();

    await expect(page.getByTestId("ticket-decision-notice")).toContainText("service identity");
  });

  test("any other 409 keeps the generic error banner, no decision notice", async ({ page }) => {
    await stubApi(page, PLAIN, [
      {
        status: 409,
        body: { error: "Ticket transition rejected", details: 'Invalid transition "done"', ticketId: TICKET, targetStatus: "done" },
      },
    ]);
    await openModal(page);
    await (await approveItem(page)).click();

    await expect(page.getByRole("dialog").getByText("Ticket transition rejected")).toBeVisible();
    await expect(page.getByTestId("ticket-decision-notice")).toHaveCount(0);
    await expect(page.getByRole("radiogroup")).toHaveCount(0);
  });

  test("a local note saying DECISION: is not a decision", async ({ page }) => {
    const h = await stubApi(page, BOUND);
    await openModal(page);

    const note = page.getByPlaceholder("Add a note...");
    await note.fill("DECISION: repaired");
    await page.getByRole("button", { name: "Send note" }).click();
    await expect(page.getByRole("dialog").getByText("DECISION: repaired")).toBeVisible();

    await expect(page.getByRole("radio", { name: "Decision: repaired" })).toHaveAttribute("aria-checked", "false");
    await expect(await approveItem(page)).toBeDisabled();
    expect(h.posts).toHaveLength(0);
  });

  // ─── TEAM-5339: held (gate:verifying) and re-paged (gate:approved-unverified) ───

  test("an approved close with an unmet post-condition holds: In Review stays, a verifying banner shows, and reopening shows it from the ticket's own label", async ({ page }) => {
    const VERIFY_UNTIL = "2026-10-06T12:30:00.000Z";
    const h = await stubApi(page, BOUND, [
      {
        status: 200,
        body: {
          success: true, held: true, status: "verifying", ticketId: TICKET, targetStatus: "done",
          newStatus: "in_review", verifyUntil: VERIFY_UNTIL,
          postCondition: { met: false, detail: "lambda_version: want 7, have 6" },
          decision: "repaired",
        },
      },
    ]);
    await openModal(page);

    await page.getByRole("radio", { name: "Decision: repaired" }).click();
    await (await approveItem(page)).click();

    await expect.poll(() => h.posts.length).toBe(1);
    expect(h.posts[0]).toEqual({ ticketId: TICKET, targetStatus: "done", decision: "repaired" });

    // Held, not Done: the route's `held:true` must win over `newStatus`-as-targetStatus.
    await expect(page.getByRole("dialog").getByRole("button", { name: /In Review/ })).toBeVisible();
    const banner = page.getByTestId("ticket-gate-verifying");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("lambda_version: want 7, have 6");

    // Requirement 4: reopening with gate:verifying already on the ticket shows the
    // same banner from the label alone — no transition call needed to see it again.
    h.ticketExtra = { labels: ["gate:verifying"], gateVerify: { verifyUntil: VERIFY_UNTIL } };
    await openModal(page);
    await expect(page.getByTestId("ticket-gate-verifying")).toBeVisible();
    expect(h.posts).toHaveLength(1);
  });

  test("an expired hold (gate-approved-unverified) re-pages for an override through the SAME picker, and the override posts the plain option", async ({ page }) => {
    const h = await stubApi(page, BOUND, [OK]);
    // Jira's colon-to-hyphen label rewrite — the [:-] regex must still catch it.
    h.ticketExtra = { labels: ["gate-approved-unverified"] };
    await openModal(page);

    const banner = page.getByTestId("ticket-gate-approved-unverified");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("not observed");

    // Reuses the existing decision picker/Approve flow (no second picker): Approve
    // is relabelled to make the override explicit, and stays disabled until a pick.
    const dialog = page.getByRole("dialog");
    const openDropdown = () => dialog.getByRole("button", { name: /In Review/ }).click();
    await openDropdown();
    let overrideItem = dialog.getByRole("button", { name: /^Override \(unverified\)/ });
    await expect(overrideItem).toBeDisabled();

    // Picking a radio is outside the status dropdown's own ref, so the dropdown's
    // outside-click handler closes it (same as every other test here reopens via
    // approveItem() before each click) — reopen before the final click.
    await page.getByRole("radio", { name: "Decision: abort" }).click();
    await openDropdown();
    overrideItem = dialog.getByRole("button", { name: /^Override \(unverified\)/ });
    await expect(overrideItem).toBeEnabled();
    await overrideItem.click();

    await expect.poll(() => h.posts.length).toBe(1);
    // The override is sent as a plain decision — the route 400s "override:<opt>".
    expect(h.posts[0]).toEqual({ ticketId: TICKET, targetStatus: "done", decision: "abort" });

    await expect(banner).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /^Done/ })).toBeVisible();
  });
});
