import { test, expect, type Page } from "@playwright/test";

/**
 * Workflows sidebar: drag-to-resize + app-wide thin scrollbars (TEAM-4320).
 *
 * Fully hermetic — every /api/** call is intercepted in-page, so this spec needs
 * no AWS credentials and no seeded workflows. It only needs the app served at
 * PLAYWRIGHT_BASE_URL (default http://localhost:3000).
 *
 * Run: npx playwright test tests/tab-workflow-sidebar.spec.ts
 */

// Playwright wipes test-results/ between runs, so write evidence to a sibling dir.
// It has to stay under the gitignored playwright-screenshots/ (same convention as
// tests/tab-workflow.spec.ts): a tracked path dirties the tree on every `npm test`.
const SCREENSHOT_DIR = "playwright-screenshots/team-4320";

const SIDEBAR = "[data-testid=workflow-history-sidebar]";
const HANDLE = "[data-testid=workflow-history-resize-handle]";
const LIST = "[data-testid=workflow-history-list]";
const MAIN = "[data-testid=workflow-main-region]";

const LONG_TITLE =
  "Dead Code Sweep — agentcore-hub repository-wide unused export and dependency removal pass";

const MIN = 240;
const DEFAULT = 288;
const MAX = 640; // effective max at the 1440px project viewport (min(640, 1440/2))
// Width used for the "long title fits" case — measured, see the console.log in case 8.
const WIDE = 600;

interface MockWorkflow {
  id: string;
  phase: string;
  epicId: string;
  input: { title: string; description: string };
  startedAt: string;
}

/** One long-titled row (for the ellipsis case) + fillers so the list overflows. */
function mockWorkflows(): MockWorkflow[] {
  const rows: MockWorkflow[] = [
    {
      id: "wf-long",
      phase: "complete",
      epicId: "TEAM-4320",
      input: { title: LONG_TITLE, description: "long title row" },
      startedAt: new Date().toISOString(),
    },
  ];
  for (let i = 0; i < 30; i++) {
    rows.push({
      id: `wf-${i}`,
      phase: "complete",
      epicId: `TEAM-${1000 + i}`,
      input: { title: `Filler run ${i}`, description: "filler" },
      startedAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
    });
  }
  return rows;
}

/**
 * A single handler for every /api/** call — switching on the URL rather than
 * layering routes avoids depending on Playwright's route precedence. It keeps
 * serving for the lifetime of the page (the list is re-polled every 5s).
 *
 * /api/workflow/performance must return a *valid* empty FleetView: PerformanceCard
 * dereferences `view.totals.runs` unguarded, so `{}` would crash the page.
 */
async function stubApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    let json: unknown = {};
    if (url.includes("/api/workflow/list")) {
      json = { workflows: mockWorkflows() };
    } else if (url.includes("/api/workflow/performance")) {
      json = {
        status: "ok",
        totals: { runs: 0, persona: 0, coding: 0, cost: 0 },
        priorRuns: 0,
        kpis: [],
        anomalies: [],
        defIds: [],
        runs: [],
        agents: [],
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(json),
    });
  });
}

let seedNonce = 0;

/**
 * Seed theme + sidebar prefs before any app script runs.
 *
 * Init scripts re-run on every navigation, so the width seed is gated behind a
 * per-call sessionStorage sentinel: it applies to the first load after this call
 * and never clobbers what the app persisted afterwards (test 2 reloads), while
 * a later seed() call still wins on the next goto (tests 7 and 10).
 */
async function seed(page: Page, width: string | null) {
  const sentinel = `__wfSidebarSeed${++seedNonce}`;
  await page.addInitScript(
    ({ w, key }) => {
      localStorage.setItem("theme", "dark");
      localStorage.setItem("workflow-history-collapsed", "false");
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
      if (w === null) localStorage.removeItem("workflow-history-width");
      else localStorage.setItem("workflow-history-width", w);
    },
    { w: width, key: sentinel }
  );
}

const widthOf = (page: Page, sel = SIDEBAR): Promise<number> =>
  page.locator(sel).boundingBox().then((b) => (b ? b.width : -1));

/**
 * The sidebar animates 32 -> N (transition-all 300ms) once the mount effect reads
 * localStorage, so every width assertion has to settle rather than read once.
 */
async function expectWidth(page: Page, expected: number, tol = 1) {
  await expect
    .poll(async () => Math.abs((await widthOf(page)) - expected) <= tol, { timeout: 5000 })
    .toBe(true);
}

/**
 * Wait out the 32 -> N expand animation. Until it settles the handle slides out
 * from under the pointer between mouse.move and mouse.down, so a drag started too
 * early lands on the wrong element and never begins.
 */
async function waitForStableWidth(page: Page) {
  let previous = -1;
  await expect
    .poll(
      async () => {
        const current = Math.round(await widthOf(page));
        const stable = current > 32 && current === previous;
        previous = current;
        return stable;
      },
      { timeout: 5000, intervals: [100] }
    )
    .toBe(true);
}

async function open(page: Page, width: string | null = null) {
  await stubApi(page);
  await seed(page, width);
  await page.goto("/workflow");
  await expect(page.locator(HANDLE)).toBeVisible();
  await waitForStableWidth(page);
}

/** Drag the handle horizontally. `midAssert` runs before mouse.up (mid-drag). */
async function dragBy(page: Page, dx: number, midAssert?: () => Promise<void>) {
  const box = await page.locator(HANDLE).boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 12 });
  if (midAssert) await midAssert();
  await page.mouse.up();
}

const stored = (page: Page): Promise<string | null> =>
  page.evaluate(() => localStorage.getItem("workflow-history-width"));

/** The two body styles a drag mutates - both must be back to "" after any gesture. */
const bodyStyles = (page: Page): Promise<{ cursor: string; userSelect: string }> =>
  page.evaluate(() => ({
    cursor: document.body.style.cursor,
    userSelect: document.body.style.userSelect,
  }));

/** scrollbarWidth / scrollbarColor / overflow / gutter for a scroll region. */
async function scrollMetrics(page: Page, sel: string) {
  return page.locator(sel).evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      scrollbarWidth: cs.scrollbarWidth,
      scrollbarColor: cs.scrollbarColor,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      gutter: (el as HTMLElement).offsetWidth - el.clientWidth,
    };
  });
}

test.describe("Workflow sidebar — resize + scrollbars", () => {
  test("1. defaults to 288px", async ({ page }) => {
    await open(page);
    await expectWidth(page, DEFAULT, 1);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-default-288.png` });
  });

  test("2. drag widens live, persists once, survives reload", async ({ page }) => {
    await open(page);
    await expectWidth(page, DEFAULT, 1);

    await dragBy(page, 180, async () => {
      // Mid-drag: the sidebar tracks the pointer before the button is released.
      expect(await widthOf(page)).toBeGreaterThanOrEqual(400);
    });

    const after = Math.round(await widthOf(page));
    expect(after).toBeGreaterThanOrEqual(400);
    expect(await stored(page)).toBe(String(after));
    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-dragged.png` });

    await page.reload();
    await expect(page.locator(HANDLE)).toBeVisible();
    await expect.poll(async () => (await widthOf(page)) >= 400, { timeout: 5000 }).toBe(true);
  });

  test("3. double-click resets to 288", async ({ page }) => {
    await open(page);
    await dragBy(page, 150);
    expect(await widthOf(page)).toBeGreaterThan(400);

    await page.locator(HANDLE).dblclick();
    await expectWidth(page, DEFAULT, 1);
    expect(await stored(page)).toBe("288");
  });

  test("4. collapse keeps the dragged width for expand", async ({ page }) => {
    await open(page);
    await dragBy(page, 192); // ~480
    await expectWidth(page, 480, 2);

    await page.locator('button[aria-label="Collapse workflow history sidebar"]').click();
    await expectWidth(page, 32, 0.5);

    await page.locator('button[aria-label="Expand workflow history sidebar"]').click();
    await expectWidth(page, 480, 2);
    const restored = await widthOf(page);
    expect(Math.abs(restored - DEFAULT)).toBeGreaterThan(2); // not reset to 288
  });

  test("5. list scroll region has a thin token scrollbar", async ({ page }) => {
    await open(page);
    const m = await scrollMetrics(page, LIST);
    expect(m.scrollbarWidth).toBe("thin");
    expect(m.scrollbarColor).not.toBe("auto");
    expect(m.scrollHeight).toBeGreaterThan(m.clientHeight); // guard: it really scrolls
    expect(m.gutter).toBeLessThanOrEqual(12);
  });

  test("6. main region has a thin token scrollbar", async ({ page }) => {
    // Short viewport so the main region (h-[calc(100vh-64px)]) is guaranteed to overflow.
    await page.setViewportSize({ width: 1440, height: 400 });
    await open(page);
    const m = await scrollMetrics(page, MAIN);
    expect(m.scrollbarWidth).toBe("thin");
    expect(m.scrollbarColor).not.toBe("auto");
    expect(m.scrollHeight).toBeGreaterThan(m.clientHeight);
    expect(m.gutter).toBeLessThanOrEqual(12);
  });

  test("7. no horizontal overflow at 240 / 288 / 640", async ({ page }) => {
    for (const w of ["240", "288", "640"]) {
      await open(page, w);
      await expectWidth(page, Number(w), 1);
      const m = await scrollMetrics(page, LIST);
      expect(m.scrollWidth, `list overflows at ${w}px`).toBeLessThanOrEqual(m.clientWidth);
      const doc = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(doc.scrollWidth, `document overflows at ${w}px`).toBeLessThanOrEqual(doc.clientWidth);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/07-width-${w}.png` });
    }
  });

  test("8. long title un-truncates as the sidebar widens", async ({ page }) => {
    await open(page);
    const title = page.locator("p.truncate", { hasText: "Dead Code Sweep" }).first();
    await expect(title).toBeVisible();

    const narrow = await title.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(narrow.scrollWidth, "title should be ellipsised at 288px").toBeGreaterThan(
      narrow.clientWidth
    );

    await dragBy(page, WIDE - DEFAULT);
    await expectWidth(page, WIDE, 2);

    const wide = await title.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    const clipNarrow = narrow.scrollWidth - narrow.clientWidth;
    const clipWide = wide.scrollWidth - wide.clientWidth;
    console.log(
      `test 8 — title at 288: scrollWidth=${narrow.scrollWidth} clientWidth=${narrow.clientWidth} ` +
        `(clipped ${clipNarrow}px); at ${WIDE}: scrollWidth=${wide.scrollWidth} ` +
        `clientWidth=${wide.clientWidth} (clipped ${clipWide}px)`
    );
    // This title needs 600px of text width; the 640px cap only affords ~581px of
    // inner width, so it cannot fully un-truncate within MAX. Assert what the
    // resize is actually for: much more of the title becomes visible.
    expect(wide.clientWidth).toBeGreaterThan(narrow.clientWidth);
    expect(clipWide).toBeLessThan(clipNarrow * 0.25);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/08-long-title-wide.png` });
  });

  test("9. keyboard resize + ARIA", async ({ page }) => {
    await open(page);
    const handle = page.locator(HANDLE);
    await handle.focus();

    await expect(handle).toHaveAttribute("role", "separator");
    await expect(handle).toHaveAttribute("aria-orientation", "vertical");
    await expect(handle).toHaveAttribute("aria-valuemin", String(MIN));
    await expect(handle).toHaveAttribute("aria-valuenow", String(DEFAULT));
    await expect(handle).toHaveAccessibleName("Resize workflows list");
    const valueMax = Number(await handle.getAttribute("aria-valuemax"));
    expect(Number.isFinite(valueMax)).toBe(true);
    expect(valueMax).toBeGreaterThanOrEqual(MIN);

    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await expectWidth(page, DEFAULT + 3 * 16, 1); // 336
    await expect(handle).toHaveAttribute("aria-valuenow", "336");
    expect(await stored(page)).toBe("336");
    await page.screenshot({ path: `${SCREENSHOT_DIR}/09-keyboard-focus.png` });

    // ArrowLeft clamps at the minimum.
    await open(page, "240");
    await expectWidth(page, MIN, 1);
    await page.locator(HANDLE).focus();
    for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowLeft");
    await expectWidth(page, MIN, 1);
    expect(await stored(page)).toBe("240");
  });

  test("10. corrupt persisted width falls back cleanly", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await open(page, "abc");
    await expectWidth(page, DEFAULT, 1);

    // Ignore transport noise (mocked routes / favicon), keep real app errors.
    const realErrors = consoleErrors.filter(
      (t) => !/Failed to load resource|net::ERR|status of \d{3}/i.test(t)
    );
    expect(pageErrors, `pageerrors: ${pageErrors.join(" | ")}`).toEqual([]);
    expect(realErrors, `console errors: ${realErrors.join(" | ")}`).toEqual([]);

    await open(page, "99999");
    await expectWidth(page, MAX, 1);

    await open(page, "12");
    await expectWidth(page, MIN, 1);
  });

  /**
   * TEAM-4345 F1. A second pointerdown mid-drag (second finger, pen+touch, or a
   * non-primary mouse button) must be refused outright. Re-entering the start
   * handler re-snapshots the *already mutated* body styles, so the restore writes
   * back cursor:col-resize / user-select:none and wedges the whole document; it
   * also clobbers dragRef.startWidth, which silently skips the persist-on-drop.
   *
   * Trusted input cannot express this: per the Pointer Events chorded-button rules
   * a second mouse button pressed while one is already down fires pointermove, not
   * pointerdown. Hence dispatchEvent. Two of the three legs use pointerId 1 - the
   * live captured mouse pointer - because with an id that is not an active pointer
   * the unguarded handler throws inside setPointerCapture() *before* it re-snapshots
   * and the leak does not reproduce. The pointerId 2 leg is the reviewer's literal
   * criterion ("different pointerId, isPrimary:false"); pre-fix it still clobbers
   * startWidth before that throw, so the persist is skipped.
   */
  test("11. second non-primary pointerdown mid-drag does not leak body styles", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await open(page);
    await expectWidth(page, DEFAULT, 1);

    const box = await page.locator(HANDLE).boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 180, y, { steps: 12 });

    // Mid-drag the body is mutated on purpose - proves the gesture is live.
    expect(await bodyStyles(page)).toEqual({ cursor: "col-resize", userSelect: "none" });
    const dragged = Math.round(await widthOf(page));
    expect(dragged).toBeGreaterThanOrEqual(400);

    for (const extra of [
      { pointerId: 1, isPrimary: false, button: 0, pointerType: "touch" }, // second finger
      { pointerId: 1, isPrimary: true, button: 2, pointerType: "mouse" }, // second button
      { pointerId: 2, isPrimary: false, button: 0, pointerType: "touch" }, // different id
    ]) {
      await page.locator(HANDLE).dispatchEvent("pointerdown", {
        ...extra,
        clientX: x + 180,
        clientY: y,
        bubbles: true,
        cancelable: true,
      });
      // The original gesture is untouched: still at the dragged width.
      expect(Math.round(await widthOf(page)), `width after ${JSON.stringify(extra)}`).toBe(dragged);
    }

    await page.mouse.up();

    expect(await bodyStyles(page)).toEqual({ cursor: "", userSelect: "" });
    await expectWidth(page, dragged, 1);
    // startWidth survived, so the one-write-per-gesture persist still fired.
    expect(await stored(page)).toBe(String(dragged));
    expect(pageErrors, `pageerrors: ${pageErrors.join(" | ")}`).toEqual([]);
  });

  /**
   * TEAM-4345 F1, the other half: with no button down, a non-primary or
   * right-button pointerdown must not arm a drag at all. Unguarded it sets
   * dragRef, and the sidebar then follows a *buttonless* pointermove.
   */
  test("12. a stray non-primary pointerdown never arms a drag", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await open(page);
    await expectWidth(page, DEFAULT, 1);

    const box = await page.locator(HANDLE).boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    for (const extra of [
      { pointerId: 9, isPrimary: false, button: 0, pointerType: "touch" },
      { pointerId: 1, isPrimary: true, button: 2, pointerType: "mouse" },
    ]) {
      await page.locator(HANDLE).dispatchEvent("pointerdown", {
        ...extra,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
      });
      await page.mouse.move(x + 120, y, { steps: 6 }); // no button is down
      expect(await bodyStyles(page), `body after ${JSON.stringify(extra)}`).toEqual({
        cursor: "",
        userSelect: "",
      });
      await expectWidth(page, DEFAULT, 1);
      expect(await stored(page), `persisted after ${JSON.stringify(extra)}`).toBeNull();
      await page.mouse.move(x, y);
    }
    expect(pageErrors, `pageerrors: ${pageErrors.join(" | ")}`).toEqual([]);
  });

  /**
   * TEAM-4345 F3. Under 480px of viewport, half the viewport is below the 240px
   * floor - the floor has to win, or the sidebar clamps under its own minimum and
   * the handle renders aria-valuemax < aria-valuemin (invalid ARIA).
   */
  test("13. narrow viewport keeps the 240px floor (max never dips below min)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 }); // half = 187, below the floor
    await open(page, "288");
    await expectWidth(page, MIN, 1);

    const handle = page.locator(HANDLE);
    await expect(handle).toHaveAttribute("aria-valuemax", String(MIN));
    await expect(handle).toHaveAttribute("aria-valuenow", String(MIN));
    expect(Number(await handle.getAttribute("aria-valuemax"))).toBeGreaterThanOrEqual(
      Number(await handle.getAttribute("aria-valuemin"))
    );
  });

  /**
   * TEAM-4346 F5. The double-click reset wrote HISTORY_DEFAULT_WIDTH (288) straight
   * through with no clamp. Under 576px of viewport the effective max is below 288
   * (375px -> the 240 floor), so the reset rendered a sidebar wider than its own
   * maximum and the handle published aria-valuenow > aria-valuemax (invalid ARIA);
   * the next reload re-clamped to 240, so the reset did not even stick.
   */
  test("14. double-click reset is clamped to the viewport max", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 }); // half = 187 -> max is the 240 floor
    await open(page, "240");
    await expectWidth(page, MIN, 1);

    // Count writes of the width key only, so the seed and the collapsed-flag write
    // don't pollute the "exactly one persist per gesture" assertion. Installed after
    // load, so nothing the mount did is counted.
    await page.evaluate(() => {
      const w = window as unknown as { __wfWrites: number };
      w.__wfWrites = 0;
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
        if (key === "workflow-history-width") w.__wfWrites += 1;
        return original.call(this, key, value);
      };
    });

    await page.locator(HANDLE).dblclick();

    // The reset lands on the clamped max, not the raw 288 default.
    await expectWidth(page, MIN, 1);
    const handle = page.locator(HANDLE);
    await expect(handle).toHaveAttribute("aria-valuenow", String(MIN));
    expect(Number(await handle.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(
      Number(await handle.getAttribute("aria-valuemax"))
    );
    // expectWidth polls for "becomes true", so on its own it would also pass on a
    // width that merely animates *through* 240 on its way to an unclamped 288. By
    // now the 300ms transition has settled, so read it once more, directly.
    expect(Math.round(await widthOf(page)), "settled width").toBeLessThanOrEqual(MIN + 1);
    // Persisted clamped, so a reload is a no-op instead of silently re-clamping.
    expect(await stored(page)).toBe(String(MIN));
    expect(await page.evaluate(() => (window as unknown as { __wfWrites: number }).__wfWrites)).toBe(
      1
    );
    await page.screenshot({ path: `${SCREENSHOT_DIR}/14-dblclick-clamped.png` });
  });

  /**
   * TEAM-4346 F6. Neither pointermove nor pointerup checked the event's pointerId
   * against the captured one. setPointerCapture only redirects *that* pointer's
   * events; any other pointer physically over the 6px separator still hit-tests to
   * it. So a second finger's move drove the width from the wrong clientX, and its
   * up tore the live drag down early - restoring the body styles and persisting a
   * width the user never released at.
   */
  test("15. a second pointer over the handle cannot hijack or end the drag", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await open(page);
    await expectWidth(page, DEFAULT, 1);

    const box = await page.locator(HANDLE).boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    // Playwright's mouse is pointerId 1 (same assumption as case 11).
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 180, y, { steps: 12 });
    expect(await bodyStyles(page)).toEqual({ cursor: "col-resize", userSelect: "none" });
    const dragged = Math.round(await widthOf(page));
    expect(dragged).toBeGreaterThanOrEqual(400);

    // Finger 2 moves across the separator: must not move the sidebar.
    await page.locator(HANDLE).dispatchEvent("pointermove", {
      pointerId: 2,
      isPrimary: false,
      button: -1,
      buttons: 1,
      pointerType: "touch",
      clientX: x + 40,
      clientY: y,
      bubbles: true,
      cancelable: true,
    });
    expect(Math.round(await widthOf(page)), "foreign pointermove moved the sidebar").toBe(dragged);

    // Finger 2 lifts: must not end the mouse's drag.
    await page.locator(HANDLE).dispatchEvent("pointerup", {
      pointerId: 2,
      isPrimary: false,
      button: 0,
      pointerType: "touch",
      clientX: x + 40,
      clientY: y,
      bubbles: true,
      cancelable: true,
    });
    expect(await bodyStyles(page), "foreign pointerup ended the drag").toEqual({
      cursor: "col-resize",
      userSelect: "none",
    });
    expect(Math.round(await widthOf(page))).toBe(dragged);

    // Pointer 1 still owns the gesture, so the sidebar still tracks it.
    await page.mouse.move(x + 200, y, { steps: 4 });
    const final = Math.round(await widthOf(page));
    expect(final).toBeGreaterThan(dragged);

    await page.mouse.up();
    expect(await bodyStyles(page)).toEqual({ cursor: "", userSelect: "" });
    await expectWidth(page, final, 1);
    expect(await stored(page)).toBe(String(final));
    expect(pageErrors, `pageerrors: ${pageErrors.join(" | ")}`).toEqual([]);
  });
});
