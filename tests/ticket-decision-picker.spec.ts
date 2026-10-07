import { test, expect, type Page } from "@playwright/test";

/**
 * Ticket detail modal: gate DECISION picker (TEAM-5324, FR-9 UI half of TEAM-5322).
 *
 * TEAM-5358/5360 FR-7: every transition carries a required reason (`comment`),
 * and the picker offers ONLY the ticket's DECISION OPTIONS plus the universal
 * `stopped` (which cancels the gate, never closes it).
 *
 * A human:* gate whose description declares `DECISION OPTIONS: a | b` closes only
 * on a decision the human picked. The modal must offer the options as a radio
 * group, keep Approve disabled until one is picked, send it as `decision`, and
 * explain each decision refusal the transition route returns. Plain tickets must
 * behave exactly as before; an open human:* gate always shows the universal stop.
 * TEAM-5391: every human gate is decision-bound — one with no DECISION OPTIONS line
 * offers the default `approve | reject`, and Approve needs a pick there too.
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

const WHY = "checked the run log";

/** Fill the required transition reason (TEAM-5358 FR-7). */
async function giveReason(page: Page, text = WHY) {
  await page.getByTestId("ticket-transition-reason").fill(text);
}

/** Open the status dropdown (if it is not already open) and return one of its items. */
async function statusItem(page: Page, name: RegExp) {
  const dialog = page.getByRole("dialog");
  const toggle = dialog.getByRole("button", { name: /In Review/ });
  // The toggle closes an open dropdown, and typing the reason does not close it.
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  return dialog.getByRole("button", { name });
}

/** Open the status dropdown and return its Approve item. */
async function approveItem(page: Page) {
  return statusItem(page, /^Approve/);
}

/** The option names the picker renders, in order. */
async function radioNames(page: Page) {
  return page.getByRole("radio").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
}

test.describe("Ticket decision picker (TEAM-5324)", () => {
  test("a decision-bound gate requires exactly one pick, and the POST carries it", async ({ page }) => {
    const h = await stubApi(page, BOUND);
    await openModal(page);

    const group = page.getByRole("radiogroup");
    await expect(group).toBeVisible();
    const repaired = page.getByRole("radio", { name: "Decision: repaired" });
    const abort = page.getByRole("radio", { name: "Decision: abort" });
    // Declared first, then the universal stop — nothing else.
    expect(await radioNames(page)).toEqual(["Decision: repaired", "Decision: abort", "Decision: stopped"]);
    await giveReason(page);
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
    expect(h.posts[0]).toEqual({ ticketId: TICKET, targetStatus: "done", comment: WHY, decision: "repaired" });
  });

  test("TEAM-5391: an undeclared human gate offers approve | reject | stopped; Approve needs a pick and sends it", async ({ page }) => {
    const h = await stubApi(page, PLAIN);
    await openModal(page);

    // No DECISION OPTIONS: the picker holds the default set plus the universal stop, before any 409.
    await expect(page.getByRole("radiogroup")).toBeVisible();
    expect(await radioNames(page)).toEqual(["Decision: approve", "Decision: reject", "Decision: stopped"]);

    await giveReason(page);
    let approve = await approveItem(page);
    await expect(approve).toBeDisabled();
    await page.getByRole("radio", { name: "Decision: approve" }).click();
    approve = await approveItem(page);
    await expect(approve).toBeEnabled();
    await approve.click();

    await expect.poll(() => h.posts.length).toBe(1);
    expect(h.posts[0]).toEqual({ ticketId: TICKET, targetStatus: "done", comment: WHY, decision: "approve" });
  });

  test("TEAM-5396 F1: a reject pick never rides an Approve; Request changes sends -> blocked with no decision", async ({ page }) => {
    const h = await stubApi(page, PLAIN, [{ status: 200, body: { success: true, ticketId: TICKET, newStatus: "blocked" } }]);
    await openModal(page);
    await giveReason(page);

    await page.getByRole("radio", { name: "Decision: reject" }).click();
    await expect(await approveItem(page)).toBeDisabled();
    const requestChanges = await statusItem(page, /^Request changes/);
    await expect(requestChanges).toBeEnabled();
    await requestChanges.click();

    await expect.poll(() => h.posts.length).toBe(1);
    expect(h.posts[0]).toEqual({ ticketId: TICKET, targetStatus: "blocked", comment: WHY });
  });

  test("an undeclared human gate stops with the universal pick, and stopped never rides an Approve", async ({ page }) => {
    const h = await stubApi(page, PLAIN, [{ status: 200, body: { success: true, ticketId: TICKET, newStatus: "cancelled" } }]);
    await openModal(page);
    await giveReason(page);

    await expect(await statusItem(page, /^Stop gate/)).toBeDisabled();
    await page.getByRole("radio", { name: "Decision: stopped" }).click();
    await expect(await approveItem(page)).toBeDisabled();
    await (await statusItem(page, /^Stop gate/)).click();

    await expect.poll(() => h.posts.length).toBe(1);
    expect(h.posts[0]).toEqual({ ticketId: TICKET, targetStatus: "cancelled", comment: WHY, decision: "stopped" });
  });

  test("409 decision_required lists the options, narrows the picker, and the retry sends the pick", async ({ page }) => {
    const h = await stubApi(page, BOUND, [
      {
        status: 409,
        body: { error: "Ticket transition rejected", reason: "decision_required", options: ["abort", "stopped"], detail: "decision_option_undeclared", ticketId: TICKET, targetStatus: "done" },
      },
      OK,
    ]);
    await openModal(page);
    await giveReason(page);
    await page.getByRole("radio", { name: "Decision: repaired" }).click();
    await (await approveItem(page)).click();

    const alert = page.getByTestId("ticket-decision-notice");
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert).toContainText("abort, stopped");
    expect(await radioNames(page)).toEqual(["Decision: abort", "Decision: stopped"]);
    await expect(await approveItem(page)).toBeDisabled();

    await page.getByRole("radio", { name: "Decision: abort" }).click();
    await (await approveItem(page)).click();

    await expect.poll(() => h.posts.length).toBe(2);
    expect(h.posts[0]).toEqual({ ticketId: TICKET, targetStatus: "done", comment: WHY, decision: "repaired" });
    expect(h.posts[1]).toEqual({ ticketId: TICKET, targetStatus: "done", comment: WHY, decision: "abort" });
  });

  test("a 409 that omits stopped still leaves stopped on offer", async ({ page }) => {
    await stubApi(page, BOUND, [
      {
        status: 409,
        body: { error: "Ticket transition rejected", reason: "decision_required", options: ["abort"], detail: "decision_option_undeclared", ticketId: TICKET, targetStatus: "done" },
      },
    ]);
    await openModal(page);
    await giveReason(page);
    await page.getByRole("radio", { name: "Decision: repaired" }).click();
    await (await approveItem(page)).click();

    await expect(page.getByTestId("ticket-decision-notice")).toBeVisible();
    expect(await radioNames(page)).toEqual(["Decision: abort", "Decision: stopped"]);
  });

  test("409 decision_required with no options falls back to the declared ones", async ({ page }) => {
    await stubApi(page, BOUND, [
      {
        status: 409,
        body: { error: "Ticket transition rejected", reason: "decision_required", options: [], detail: "decision_option_undeclared", ticketId: TICKET, targetStatus: "done" },
      },
    ]);
    await openModal(page);
    await giveReason(page);
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
    await giveReason(page);
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
    await giveReason(page);
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
    await giveReason(page);
    await page.getByRole("radio", { name: "Decision: approve" }).click();
    await (await approveItem(page)).click();

    await expect(page.getByRole("dialog").getByText("Ticket transition rejected")).toBeVisible();
    await expect(page.getByTestId("ticket-decision-notice")).toHaveCount(0);
    // Only the up-front options (default set + universal stop) — a generic refusal reveals nothing more.
    expect(await radioNames(page)).toEqual(["Decision: approve", "Decision: reject", "Decision: stopped"]);
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

    await giveReason(page);
    await page.getByRole("radio", { name: "Decision: repaired" }).click();
    await (await approveItem(page)).click();

    await expect.poll(() => h.posts.length).toBe(1);
    expect(h.posts[0]).toEqual({ ticketId: TICKET, targetStatus: "done", comment: WHY, decision: "repaired" });

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
    await giveReason(page);
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
    expect(h.posts[0]).toEqual({ ticketId: TICKET, targetStatus: "done", comment: WHY, decision: "abort" });

    await expect(banner).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /^Done/ })).toBeVisible();
  });

  // ─── TEAM-5358/5360 FR-7: required reason, contract-only options, stopped ───

  test("no reason, no transition: every status item is disabled until a non-blank reason is given", async ({ page }) => {
    const h = await stubApi(page, BOUND);
    await openModal(page);

    await expect(page.getByTestId("ticket-transition-reason")).toHaveAttribute("maxlength", "1000");
    await page.getByRole("radio", { name: "Decision: repaired" }).click();
    await expect(await approveItem(page)).toBeDisabled();
    await expect(await statusItem(page, /^Request changes/)).toBeDisabled();

    await giveReason(page, "   ");
    await expect(await approveItem(page)).toBeDisabled();

    await giveReason(page);
    const approve = await approveItem(page);
    await expect(approve).toBeEnabled();
    await approve.click();

    await expect.poll(() => h.posts.length).toBe(1);
    expect(h.posts[0]).toEqual({ ticketId: TICKET, targetStatus: "done", comment: WHY, decision: "repaired" });
  });

  test("stopped is always offered on a bound gate, cancels (never approves), and posts cancelled + stopped", async ({ page }) => {
    const h = await stubApi(page, BOUND, [{ status: 200, body: { success: true, ticketId: TICKET, newStatus: "cancelled" } }]);
    await openModal(page);
    await giveReason(page, "the run is being abandoned");

    // Before any pick, neither close nor stop is allowed.
    await expect(await statusItem(page, /^Stop gate/)).toBeDisabled();

    await page.getByRole("radio", { name: "Decision: stopped" }).click();
    await expect(await approveItem(page)).toBeDisabled();
    const stop = await statusItem(page, /^Stop gate/);
    await expect(stop).toBeEnabled();
    await stop.click();

    await expect.poll(() => h.posts.length).toBe(1);
    expect(h.posts[0]).toEqual({ ticketId: TICKET, targetStatus: "cancelled", comment: "the run is being abandoned", decision: "stopped" });
  });

  test("a declared pick never rides a Stop gate", async ({ page }) => {
    await stubApi(page, BOUND);
    await openModal(page);
    await giveReason(page);
    await page.getByRole("radio", { name: "Decision: repaired" }).click();
    await expect(await statusItem(page, /^Stop gate/)).toBeDisabled();
  });

  test("probe: a 409 option the ticket does not declare is never offered", async ({ page }) => {
    await stubApi(page, BOUND, [
      {
        status: 409,
        body: { error: "Ticket transition rejected", reason: "decision_required", options: ["repaired", "evil-option", "stopped"], detail: "decision_option_undeclared", ticketId: TICKET, targetStatus: "done" },
      },
    ]);
    await openModal(page);
    await giveReason(page);
    await page.getByRole("radio", { name: "Decision: abort" }).click();
    await (await approveItem(page)).click();

    await expect(page.getByTestId("ticket-decision-notice")).toContainText("evil-option");
    await expect(page.getByTestId("ticket-decision-option-evil-option")).toHaveCount(0);
    for (const name of await radioNames(page)) {
      expect(["Decision: repaired", "Decision: abort", "Decision: stopped"]).toContain(name);
    }
    expect(await radioNames(page)).toContain("Decision: stopped");
  });

  test("probe: on a ticket with no DECISION OPTIONS, a 409's undeclared options are dropped; the default set stays", async ({ page }) => {
    await stubApi(page, PLAIN, [
      {
        status: 409,
        body: { error: "Ticket transition rejected", reason: "decision_required", options: ["continue", "cancel"], ticketId: TICKET, targetStatus: "done" },
      },
    ]);
    await openModal(page);
    await giveReason(page);
    await page.getByRole("radio", { name: "Decision: approve" }).click();
    await (await approveItem(page)).click();

    await expect(page.getByTestId("ticket-decision-notice")).toContainText("continue, cancel");
    expect(await radioNames(page)).toEqual(["Decision: approve", "Decision: reject", "Decision: stopped"]);
  });

  test("Request changes needs the reason, and sends it as the comment", async ({ page }) => {
    const h = await stubApi(page, PLAIN, [{ status: 200, body: { success: true, ticketId: TICKET, newStatus: "blocked" } }]);
    await openModal(page);
    await expect(await statusItem(page, /^Request changes/)).toBeDisabled();
    expect(h.posts).toHaveLength(0);

    await giveReason(page, "split the migration into two steps");
    await (await statusItem(page, /^Request changes/)).click();

    await expect.poll(() => h.posts.length).toBe(1);
    expect(h.posts[0]).toEqual({ ticketId: TICKET, targetStatus: "blocked", comment: "split the migration into two steps" });
  });
});
