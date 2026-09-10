import { test, expect } from "@playwright/test";
import {
  ABSURD_TITLE,
  DEFAULT_WIDTH,
  HANDLE,
  LIST,
  LONG_ROWS,
  MAX_CEILING,
  MEDIUM_TITLE,
  MIN_WIDTH,
  OVERFLOW_ROWS,
  SCREENSHOT_DIR,
  SHORT_TITLE,
  SMALL_ROWS,
  TOKENS,
  analyseGutterStrip,
  aria,
  bodyStyles,
  dispatchAtHandle,
  dispatchPointerDownAtHandle,
  dispatchWindowPointer,
  gutterOf,
  handleCenter,
  injectThinControl,
  isResizingVisualState,
  keyboardToWidth,
  listMetrics,
  makeRows,
  nativeGutter,
  near,
  pressKey,
  renderedWidth,
  resetLog,
  settledWidth,
  setup,
  sidebarLeft,
  startDragToWidth,
  storedWidth,
  tabToHandle,
  titleMetric,
  widthTracksBareMoves,
  widthWrites,
} from "./helpers/workflow-resize";

/**
 * TEAM-4316 / TEAM-4330 / TEAM-4331 / TEAM-4332 — drag-to-resize workflows-history
 * sidebar, its keyboard equivalent, and the global dark scrollbars.
 *
 * TEAM-4332 rewrote this file so it actually DISCRIMINATES. The previous version
 * had three defects, all closed here:
 *   - case 5 asserted `getComputedStyle(el).scrollbarWidth === "thin"` (which is
 *     `"auto"` by design since TEAM-4330 — it asserted the bug) and
 *     `::-webkit-scrollbar` width `=== "6px"`, which Chromium reports from the
 *     DECLARATION whether or not it paints, so it passed on the broken code.
 *     Group A replaces both with the reserved LAYOUT GUTTER, which only reads 6
 *     when the rule genuinely governs the paint.
 *   - the keyboard path (R2.9) and both clamp bounds (R2.3) were untested.
 *     Groups B and C cover them.
 *   - case 6 `test.skip()`ed on ambient data, so the headline user benefit was
 *     never actually exercised. There is now NO `test.skip()` in this file and
 *     every `/api/**` response is a fixture, so the suite runs in CI on every PR.
 *
 * Everything is hermetic: no AWS credentials, no ambient workflow data, no
 * dependence on what happens to be deployed. See tests/helpers/workflow-resize.ts.
 *
 * Run: npx playwright test tests/tab-workflow-resize.spec.ts
 */

/**
 * Playwright passes `--hide-scrollbars` to headless Chromium BY DEFAULT. With it
 * on, every scroller reserves a 0px gutter, which is what made the earlier
 * probes read `0 → 0` and conclude the layout check was impossible. Suppressing
 * it makes the engine reserve a classic gutter, and the ladder becomes the
 * discriminator TEAM-4330's verification doc records
 * (docs/TEAM-4330-scrollbar-verification.md):
 *
 *     15  native (no author scrollbar CSS)
 *     10  the standard `scrollbar-width: thin` path  ← BEFORE TEAM-4330
 *      6  `::-webkit-scrollbar { width: 6px }` actually painting  ← AFTER
 *
 * That doc's BEFORE block contains verbatim the failure this file reproduces:
 *   "[chromium/dark] reserved gutter must be 6px (proves the webkit width
 *    paints) - got 10".
 *
 * File scope, not Group A only: a real gutter shrinks every scroller's
 * clientWidth, so Group D's title calibration is only honest if D runs under the
 * same layout. One launch config for the file also means one worker, hence no
 * wall-clock penalty. This is a spec-level launch option and needs no CI change.
 */
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

// ═════════════════════════════════════════════════════ core (kept cases 1-4)

test.describe("Workflow sidebar resize (TEAM-4316)", () => {
  test("1: default expanded width is 288px", async ({ page }) => {
    await setup(page, { rows: SMALL_ROWS, clearWidth: true });
    expect(await aria(page, "aria-valuenow")).toBe(DEFAULT_WIDTH);
    expect(near(await settledWidth(page), DEFAULT_WIDTH)).toBe(true);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-default.png`, fullPage: true });
  });

  test("2: dragging the handle right widens >= 400px and survives reload", async ({ page }) => {
    // No width option -> the key is left untouched, and the init script's
    // sessionStorage sentinel means a reload cannot re-run a seed/clear either,
    // so the dragged width genuinely round-trips through localStorage.
    await setup(page, { rows: SMALL_ROWS });
    const c = await handleCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 180, c.y, { steps: 10 }); // steps required for React to see pointermoves
    await page.mouse.up();

    expect(await aria(page, "aria-valuenow")).toBeGreaterThanOrEqual(400);
    // The drag suppresses `transition-all`, so the rendered box is immediate.
    expect(await renderedWidth(page)).toBeGreaterThanOrEqual(400);
    // Counted, not just compared: exactly one persist for one complete drag.
    const writes = await widthWrites(page);
    expect(writes.length).toBe(1);
    expect(Number(writes[0].value)).toBeGreaterThanOrEqual(400);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-dragged-wide.png`, fullPage: true });

    await page.reload();
    await page.waitForSelector(HANDLE, { state: "visible" });
    expect(await aria(page, "aria-valuenow")).toBeGreaterThanOrEqual(400);
    expect(await settledWidth(page)).toBeGreaterThanOrEqual(400);
  });

  test("3: double-click on the handle resets to 288px", async ({ page }) => {
    await setup(page, { rows: SMALL_ROWS, clearWidth: true });
    const c = await handleCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 160, c.y, { steps: 10 });
    await page.mouse.up();
    expect(await aria(page, "aria-valuenow")).toBeGreaterThanOrEqual(400);

    await page.locator(HANDLE).dblclick();

    expect(await aria(page, "aria-valuenow")).toBe(DEFAULT_WIDTH);
    expect(await storedWidth(page)).toBe(String(DEFAULT_WIDTH));
    expect(near(await settledWidth(page), DEFAULT_WIDTH)).toBe(true);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-reset.png`, fullPage: true });
  });

  test("4: collapse then expand restores the persisted (wide) width, not 288", async ({ page }) => {
    await setup(page, { rows: SMALL_ROWS, seedWidth: 420 });
    expect(await aria(page, "aria-valuenow")).toBe(420);

    await page.locator("button[aria-label='Collapse workflow history sidebar']").click();
    await page.waitForTimeout(400); // let the collapse transition settle
    await page.locator("button[aria-label='Expand workflow history sidebar']").click();
    await page.waitForSelector(HANDLE, { state: "visible" });

    // Restored logical width is the persisted 420, explicitly not the 288 default.
    expect(await aria(page, "aria-valuenow")).toBe(420);
    expect(near(await settledWidth(page), 420)).toBe(true);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/04-restore.png`, fullPage: true });
  });
});

// ══════════════════════════════════════════ A — R1.4/R1.5 scrollbar paint

test.describe("A: scrollbar actually paints at 6px (TEAM-4330)", () => {
  test("A1: the overflowing list reserves a 6px gutter, not the 10px thin-path gutter", async ({
    page,
  }) => {
    await setup(page, { rows: OVERFLOW_ROWS, clearWidth: true });
    const list = page.getByTestId("workflow-history-list");
    const m = await listMetrics(list);

    // Hard, not a skip: if the list does not overflow there is no gutter to
    // measure and the fixture (not the app) is what is wrong.
    expect(m.overflowsVertically).toBe(true);
    // The engine gate. Without `selector()` support the @supports reset never
    // applies and `auto` below would mean something else entirely.
    expect(m.supportsWebkitSelector).toBe(true);

    const thinControl = await injectThinControl(page, "rgb(42, 42, 58)");
    const thinGutter = await gutterOf(thinControl);
    const native = await nativeGutter(page);
    console.log(
      `[A1] gutter ladder: native=${native} thin=${thinGutter} app=${m.gutter} ` +
        `| scrollbarWidth=${JSON.stringify(m.scrollbarWidth)} scrollbarColor=${JSON.stringify(m.scrollbarColor)}`
    );

    // THE assertion. 10 -> 6 is exactly the broken -> fixed flip; under the
    // TEAM-4330 mutation this line reads "expected 6, received 10".
    expect(m.gutter).toBe(6);
    // The un-fixed thin path, measured live in the same page and the same run.
    expect(thinGutter).toBe(10);
    // Ordering rather than a hard pin: native is a platform metric.
    expect(native).toBeGreaterThan(thinGutter);
    // Stated directly: in the broken state the app container and the thin path
    // COLLAPSE to the same 10px, because the webkit width is dead code.
    expect(m.gutter).not.toBe(thinGutter);

    // Both computed channels, kept ALONGSIDE the gutter rather than instead of
    // it. Broken state: "thin" and "rgb(42, 42, 58) rgba(0, 0, 0, 0)".
    expect(m.scrollbarWidth).toBe("auto");
    expect(m.scrollbarColor).toBe("auto");
  });

  test("A2: webkit pseudo-element geometry and thumb token are declared as specified", async ({
    page,
  }) => {
    await setup(page, { rows: OVERFLOW_ROWS, clearWidth: true });
    const m = await listMetrics(page.getByTestId("workflow-history-list"));

    // ─────────────────────────────────────────────────────────────────────────
    // NON-DISCRIMINATING ON THEIR OWN. Chromium resolves ::-webkit-scrollbar-*
    // from the DECLARATION and returns these same strings even when a non-auto
    // `scrollbar-width` means they never paint — which is exactly how the
    // previous case 5 passed against the broken code (finding C1). Their value
    // here is pinning the tokens/geometry the design specifies; A1 (layout
    // gutter) and A4 (pixels) are what prove the rules take effect.
    // ─────────────────────────────────────────────────────────────────────────
    expect(m.wkWidth).toBe("6px");
    expect(m.wkHeight).toBe("6px");
    expect(m.wkThumbBg).toBe("rgb(42, 42, 58)"); // --color-surface-4, dark
    expect(m.wkThumbRadius).toBe("3px");
    expect(m.wkTrackBg).toBe("rgba(0, 0, 0, 0)");
    expect(m.wkButtonDisplay).toBe("none");
  });

  test("A3: control — an element that opts back into scrollbar-width:thin reserves 10px", async ({
    page,
  }) => {
    await setup(page, { rows: OVERFLOW_ROWS, clearWidth: true });
    const app = page.getByTestId("workflow-history-list");

    // Inline style, not the `.scrollbar-thin` utility class, so the control
    // cannot be perturbed by Tailwind purge behaviour even though that class is
    // used elsewhere (src/app/agents/[id]/page.tsx).
    const control = await injectThinControl(page, "rgb(42, 42, 58)");
    const controlCss = await control.evaluate((el) => getComputedStyle(el).scrollbarWidth);

    // 10-vs-6 in one page, one run: this is what "declared but not painting"
    // looks like, and it is the state the whole app was in before TEAM-4330.
    expect(controlCss).toBe("thin");
    expect(await gutterOf(control)).toBe(10);
    expect(await app.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe("auto");
    expect(await gutterOf(app)).toBe(6);
  });

  test("A4: R1.5 — the gutter strip carries the token thumb, no white bar, no arrow buttons", async ({
    page,
  }) => {
    await setup(page, { rows: OVERFLOW_ROWS, clearWidth: true });
    const list = page.getByTestId("workflow-history-list");
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    expect(await gutterOf(list)).toBe(6);

    // Screenshot -> base64 data URL -> Image -> canvas -> getImageData, all
    // in-page. No PNG decoder and no new dependency.
    const s = await analyseGutterStrip(page, list, {
      gutterPx: 6,
      thumb: TOKENS.dark.thumb,
      background: TOKENS.dark.surface1,
      edgeRows: 4,
    });
    console.log(`[A4] dark strip ${JSON.stringify(s.dims)} palette=${JSON.stringify(s.palette)}`);
    console.log(
      `[A4] anyNearWhite=${s.anyNearWhite} thumbTokenPixels=${s.thumbTokenPixels} ` +
        `topRowsHaveThumb=${s.topRowsHaveThumb} bottomRowsAllBackground=${s.bottomRowsAllBackground}`
    );

    // R1.5 literal: never a solid white bar in dark theme.
    expect(s.anyNearWhite).toBe(false);
    // Non-vacuity: the thumb really is composited into the raster, so the
    // near-white check above cannot pass just because nothing was captured.
    expect(s.thumbTokenPixels).toBeGreaterThan(50);
    // DISCRIMINATING. At scrollTop 0 the thumb sits flush against the top of
    // the track only when ::-webkit-scrollbar-button{display:none} is honoured;
    // on the standard thin path the top rows are track/arrow chrome instead.
    expect(s.topRowsHaveThumb).toBe(true);
    // DISCRIMINATING, and pixels are the ONLY way to see it: the bottom of the
    // strip is plain container background, i.e. there is no bottom arrow button.
    expect(s.bottomRowsAllBackground).toBe(true);
  });

  test("A5: light theme — thumb token follows the theme and the gutter is still 6px", async ({
    page,
  }) => {
    await setup(page, { rows: OVERFLOW_ROWS, clearWidth: true, theme: "light" });
    const list = page.getByTestId("workflow-history-list");
    const m = await listMetrics(list);

    expect(m.overflowsVertically).toBe(true);
    expect(m.gutter).toBe(6);
    expect(m.scrollbarWidth).toBe("auto");
    expect(m.scrollbarColor).toBe("auto");
    expect(m.wkThumbBg).toBe("rgb(206, 212, 218)"); // --color-surface-4, light

    // POSITIVE CONTROL for the A4 decode. The light container background is
    // itself near-white (--color-surface-1 #f1f3f5), so near-white pixels MUST
    // be present here. If A4's `anyNearWhite === false` were passing because
    // the decode sampled the wrong region or an empty buffer, this fails.
    const s = await analyseGutterStrip(page, list, {
      gutterPx: 6,
      thumb: TOKENS.light.thumb,
      background: TOKENS.light.surface1,
      edgeRows: 4,
    });
    console.log(`[A5] light strip palette=${JSON.stringify(s.palette)}`);
    expect(s.anyNearWhite).toBe(true);
    expect(s.thumbTokenPixels).toBeGreaterThan(50);
  });
});

// ═══════════════════════════════════════════════ B — R2.3 clamp bounds (drag)

test.describe("B: drag clamps to both bounds (TEAM-4316 R2.3)", () => {
  test("B1: dragging past the floor clamps to 240 and persists exactly one write of 240", async ({
    page,
  }) => {
    await setup(page, { rows: SMALL_ROWS, clearWidth: true });
    const left = await sidebarLeft(page);
    const c = await handleCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    // Well past the floor, then two further leftward moves that must not
    // accumulate below it.
    await page.mouse.move(left + 60, c.y, { steps: 10 });
    await page.mouse.move(left + 20, c.y, { steps: 4 });
    await page.mouse.move(left + 5, c.y, { steps: 4 });
    expect(await aria(page, "aria-valuenow")).toBe(MIN_WIDTH);
    await page.mouse.up();

    expect(await aria(page, "aria-valuenow")).toBe(MIN_WIDTH);
    expect(near(await settledWidth(page), MIN_WIDTH)).toBe(true);
    const writes = await widthWrites(page);
    expect(writes.length).toBe(1);
    expect(writes[0].value).toBe(String(MIN_WIDTH));
  });

  test("B2: dragging past the ceiling clamps to 640 on a 1440px viewport", async ({
    page,
  }, testInfo) => {
    // 1440 -> min(640, 1440*0.5 = 720) = 640, so the CEILING branch is what bites.
    await setup(page, { rows: SMALL_ROWS, clearWidth: true });
    const vw = testInfo.project.use.viewport?.width ?? 1440;
    const left = await sidebarLeft(page);
    const c = await handleCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    // A real pointer move to the far right edge. left is ~256, so the proposed
    // width is ~1180 — comfortably past 640 without leaving the viewport (which
    // Playwright's mouse cannot do anyway).
    await page.mouse.move(vw - 5, c.y, { steps: 12 });
    expect(vw - 5 - left).toBeGreaterThan(MAX_CEILING + 100);
    await page.mouse.up();

    expect(await aria(page, "aria-valuenow")).toBe(MAX_CEILING);
    expect(await aria(page, "aria-valuemax")).toBe(MAX_CEILING);
    expect(near(await settledWidth(page), MAX_CEILING)).toBe(true);
    const writes = await widthWrites(page);
    expect(writes.length).toBe(1);
    expect(writes[0].value).toBe(String(MAX_CEILING));
  });

  test.describe("on a 900px viewport", () => {
    // The OTHER clamp branch: min(640, 900*0.5 = 450) = 450, so the viewport
    // half-width wins over the 640 ceiling. Overridden per-describe, never
    // globally — the 1440 default is what makes B2 exercise 640.
    test.use({ viewport: { width: 900, height: 900 } });

    test("B3: dragging past the ceiling clamps to 450, not 640", async ({ page }) => {
      await setup(page, { rows: SMALL_ROWS, clearWidth: true });
      const c = await handleCenter(page);
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      await page.mouse.move(895, c.y, { steps: 12 });
      await page.mouse.up();

      expect(await aria(page, "aria-valuenow")).toBe(450);
      expect(await aria(page, "aria-valuemax")).toBe(450);
      expect(near(await settledWidth(page), 450)).toBe(true);
      const writes = await widthWrites(page);
      expect(writes.length).toBe(1);
      expect(writes[0].value).toBe("450");
    });
  });
});

// ═══════════════════════════════════════════════════ C — R2.9 keyboard resize

test.describe("C: keyboard resize (TEAM-4316 R2.9)", () => {
  test("C1: the handle is reachable by Tab from the search input", async ({ page }) => {
    // 2 rows -> 4 intervening tabbables (Archive + Delete each), so the handle
    // is ~5 tabs away. A 40-row fixture would be ~80, hence the small fixture.
    await setup(page, { rows: SMALL_ROWS, clearWidth: true });
    const { tabs, trail } = await tabToHandle(page, 25);
    console.log(`[C1] tabs=${tabs} trail=${trail.join(" | ")}`);
    // Reachability, not `.focus()`: an element removed from the tab order would
    // still accept .focus() and the test would pass while the feature is broken.
    expect(tabs).toBeGreaterThan(0);
    expect(tabs).toBeLessThanOrEqual(25);
  });

  test("C2: ArrowRight/ArrowLeft move exactly 16px, one write each", async ({ page }) => {
    await setup(page, { rows: SMALL_ROWS, clearWidth: true });
    expect(await aria(page, "aria-valuenow")).toBe(DEFAULT_WIDTH);

    await pressKey(page, "ArrowRight", 1);
    expect(await aria(page, "aria-valuenow")).toBe(304);
    expect(near(await settledWidth(page), 304)).toBe(true);
    let writes = await widthWrites(page);
    expect(writes.length).toBe(1);
    expect(writes[0].value).toBe("304");

    await resetLog(page);
    await pressKey(page, "ArrowLeft", 1);
    expect(await aria(page, "aria-valuenow")).toBe(DEFAULT_WIDTH);
    expect(near(await settledWidth(page), DEFAULT_WIDTH)).toBe(true);
    writes = await widthWrites(page);
    expect(writes.length).toBe(1);
    expect(writes[0].value).toBe(String(DEFAULT_WIDTH));
  });

  test("C3: ArrowLeft clamps at the 240 floor", async ({ page }) => {
    await setup(page, { rows: SMALL_ROWS, clearWidth: true });
    // 20 presses from 288 is 288 - 320 = -32 unclamped.
    const seen = await pressKey(page, "ArrowLeft", 20);
    console.log(`[C3] observed tail=${seen.slice(-6).join(",")} min=${Math.min(...seen)}`);
    expect(await aria(page, "aria-valuenow")).toBe(MIN_WIDTH);
    // Every intermediate step, not just the endpoint.
    expect(Math.min(...seen)).toBe(MIN_WIDTH);
    expect(await storedWidth(page)).toBe(String(MIN_WIDTH));
    expect(near(await settledWidth(page), MIN_WIDTH)).toBe(true);
  });

  test("C4: ArrowRight clamps at the 640 ceiling on a 1440px viewport", async ({ page }) => {
    await setup(page, { rows: SMALL_ROWS, clearWidth: true });
    // 288 + 16*22 lands exactly on 640, so 30 presses overshoots by 8 steps.
    const seen = await pressKey(page, "ArrowRight", 30);
    console.log(`[C4] observed tail=${seen.slice(-6).join(",")} max=${Math.max(...seen)}`);
    expect(await aria(page, "aria-valuenow")).toBe(MAX_CEILING);
    expect(Math.max(...seen)).toBe(MAX_CEILING);
    expect(await storedWidth(page)).toBe(String(MAX_CEILING));
    expect(near(await settledWidth(page), MAX_CEILING)).toBe(true);
  });

  test.describe("on a 900px viewport", () => {
    test.use({ viewport: { width: 900, height: 900 } });

    test("C5: ArrowRight clamps at 450, the viewport half-width", async ({ page }) => {
      await setup(page, { rows: SMALL_ROWS, clearWidth: true });
      // 288 + 16k gives 448 then 464 — it never lands on 450. So an unclamped
      // keyboard path reads 464 here, and `toBe(450)` is precisely the assertion
      // that catches a keyboard handler that skips clampHistoryWidth().
      const seen = await pressKey(page, "ArrowRight", 30);
      console.log(`[C5] observed tail=${seen.slice(-6).join(",")} max=${Math.max(...seen)}`);
      expect(await aria(page, "aria-valuenow")).toBe(450);
      expect(Math.max(...seen)).toBe(450);
      expect(await storedWidth(page)).toBe("450");
      expect(await aria(page, "aria-valuemax")).toBe(450);
    });
  });
});

// ══════════════════════════════════════════════════════ D — R2.8 truncation

test.describe("D: truncation reveal and no horizontal overflow (TEAM-4316 R2.8)", () => {
  test("D1: widening 288 -> 640 reveals the medium title; the 300-char title stays clipped", async ({
    page,
  }) => {
    await setup(page, { rows: LONG_ROWS, clearWidth: true });
    const fontsOk = await page.evaluate(() => document.fonts.check("12px Inter"));

    const at288 = await titleMetric(page, MEDIUM_TITLE);
    const shortAt288 = await titleMetric(page, SHORT_TITLE);
    console.log(
      `[D1] fonts.check('12px Inter')=${fontsOk} @288 medium=${JSON.stringify(at288)} short=${JSON.stringify(shortAt288)}`
    );
    // Margins, not just booleans, so font-metric drift between local and CI is
    // visible in the log instead of silently flipping the result. Measured
    // margin is ~170px, so the threshold sits well clear of the boundary.
    expect(at288.clipped).toBe(true);
    expect(at288.clippedBy).toBeGreaterThanOrEqual(100);
    // The control row: a 30-char title is never clipped, so "clipped" above is
    // a property of the WIDTH, not of every row.
    expect(shortAt288.clipped).toBe(false);

    // Keyboard, so 640 is exact (C4 proves the clamp lands on it).
    await keyboardToWidth(page, MAX_CEILING);

    const at640 = await titleMetric(page, MEDIUM_TITLE);
    const absurdAt640 = await titleMetric(page, ABSURD_TITLE);
    console.log(`[D1] @640 medium=${JSON.stringify(at640)} absurd=${JSON.stringify(absurdAt640)}`);
    expect(at640.clipped).toBe(false);
    expect(at640.headroom).toBeGreaterThanOrEqual(100); // measured ~182px

    // Non-vacuity: a 300-char title is STILL clipped at the 640 max, so the
    // reveal above is the sidebar getting wider, not truncation being absent.
    expect(absurdAt640.clipped).toBe(true);
    expect(absurdAt640.clippedBy).toBeGreaterThanOrEqual(500); // measured ~1242px

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/D1-truncation-reveal-dark.png`,
      fullPage: true,
    });
  });

  test("D2: no horizontal overflow in the list at 240, 288 and 640", async ({ page }) => {
    await setup(page, { rows: LONG_ROWS, clearWidth: true });
    const list = page.getByTestId("workflow-history-list");

    // Reached by keyboard so each width is exact, and asserted WITH the
    // 300-char title present. Meaningful precisely because the 6px vertical
    // gutter is genuinely reserved now (it eats clientWidth), which is the
    // condition under which a horizontal bar would actually appear.
    for (const w of [MIN_WIDTH, DEFAULT_WIDTH, MAX_CEILING]) {
      await keyboardToWidth(page, w, w === MIN_WIDTH || w === MAX_CEILING ? 4 : 0);
      const m = await listMetrics(list);
      console.log(
        `[D2] width=${w} gutter=${m.gutter} clientWidth=${m.clientWidth} ` +
          `scrollWidth=${m.scrollWidth} overflowsVertically=${m.overflowsVertically}`
      );
      expect(m.overflowsVertically).toBe(true);
      expect(m.gutter).toBe(6);
      expect(m.noHorizontalScroll).toBe(true);
      expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
    }
  });
});

// ══════════════════════════════════════════════ E — TEAM-4331 drag lifecycle

test.describe("E: drag lifecycle (TEAM-4331)", () => {
  test("E1: pointercancel mid-drag restores body styles and tears down the drag", async ({
    page,
  }) => {
    await setup(page, { rows: SMALL_ROWS, clearWidth: true });
    const c = await startDragToWidth(page, 480);
    expect(await isResizingVisualState(page)).toBe(true);
    expect((await bodyStyles(page)).userSelect).toBe("none");

    await dispatchAtHandle(page, "pointercancel");
    await page.waitForTimeout(120);

    const body = await bodyStyles(page);
    expect(body.userSelect).toBe("");
    expect(body.cursor).toBe("");
    expect(await isResizingVisualState(page)).toBe(false);

    const track = await widthTracksBareMoves(page, c.y);
    console.log(`[E1] bare-move tracking after pointercancel: ${JSON.stringify(track)}`);
    expect(track.tracked).toBe(false);

    expect((await widthWrites(page)).length).toBe(1);
  });

  test("E2: lostpointercapture with no pointerup ends the drag exactly once", async ({ page }) => {
    await setup(page, { rows: SMALL_ROWS, clearWidth: true });
    const c = await startDragToWidth(page, 500);

    // Pointer capture is what makes the out-of-window release recoverable.
    const captured = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return [1, 2, 3].some((id) => (el as Element).hasPointerCapture(id));
    }, HANDLE);
    expect(captured).toBe(true);

    const atInterrupt = await aria(page, "aria-valuenow");
    // No pointerup at all — strictly the harder case, and the exact event the
    // browser fires at the capture element when the button is released outside
    // the window (which Playwright's input API cannot reproduce).
    await dispatchAtHandle(page, "lostpointercapture");
    await page.waitForTimeout(120);

    const body = await bodyStyles(page);
    expect(body.userSelect).toBe("");
    expect(body.cursor).toBe("");
    expect(await isResizingVisualState(page)).toBe(false);

    let writes = await widthWrites(page);
    expect(writes.length).toBe(1);
    expect(Number(writes[0].value)).toBe(atInterrupt);
    expect(atInterrupt).toBeGreaterThanOrEqual(400);

    // Idempotent onEnd: a LATE real pointerup must not persist a second time.
    await page.mouse.up();
    await page.waitForTimeout(120);
    writes = await widthWrites(page);
    expect(writes.length).toBe(1);
    const after = await bodyStyles(page);
    expect(after.userSelect).toBe("");
    expect(after.cursor).toBe("");

    const track = await widthTracksBareMoves(page, c.y);
    expect(track.tracked).toBe(false);
  });

  test.describe("on a 1600px viewport", () => {
    test.use({ viewport: { width: 1600, height: 900 } });

    test("E3: a viewport resize clamps the RENDERED width with ZERO localStorage writes", async ({
      page,
    }) => {
      await setup(page, { rows: SMALL_ROWS, clearWidth: true });
      await startDragToWidth(page, 600);
      await page.mouse.up();
      const dragged = await aria(page, "aria-valuenow");
      expect(near(dragged, 600, 2)).toBe(true);
      expect(await storedWidth(page)).toBe(String(dragged));
      expect(await aria(page, "aria-valuemax")).toBe(MAX_CEILING);

      await resetLog(page);
      await page.setViewportSize({ width: 900, height: 900 });
      await page.waitForTimeout(400);

      // The whole point of preferredWidthRef: a window resize adjusts what is
      // RENDERED without ever touching the user's stored preference.
      expect((await widthWrites(page)).length).toBe(0);
      expect(await storedWidth(page)).toBe(String(dragged));
      expect(near(await settledWidth(page), 450, 3)).toBe(true);
      expect(await aria(page, "aria-valuemax")).toBe(450);

      // Widening again restores the preference from the ref, still no writes.
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.waitForTimeout(400);
      expect(near(await settledWidth(page), dragged, 3)).toBe(true);
      expect((await widthWrites(page)).length).toBe(0);
      expect(await storedWidth(page)).toBe(String(dragged));

      // And the preference survives a reload, which is what a lost write would
      // have destroyed.
      await page.reload();
      await page.waitForSelector(HANDLE, { state: "visible" });
      expect(near(await settledWidth(page), dragged, 3)).toBe(true);
      expect(await aria(page, "aria-valuenow")).toBe(dragged);
    });
  });

  test("E4: a stuck drag followed by a full drag leaks no listeners and writes drag B's width", async ({
    page,
  }) => {
    await setup(page, { rows: SMALL_ROWS, clearWidth: true });
    const left = Math.round(await sidebarLeft(page));
    const c = await handleCenter(page);

    // Drag A: stuck. Interrupted by lostpointercapture with NO pointerup, so if
    // teardown-before-reinstall is missing, its window listeners survive.
    await dispatchPointerDownAtHandle(page, c.x, c.y);
    await dispatchWindowPointer(page, "pointermove", left + 400, c.y);
    await dispatchAtHandle(page, "lostpointercapture");
    await page.waitForTimeout(120);
    expect((await widthWrites(page)).length).toBe(1);

    // Drag B: complete. A leaked drag-A handler would either double the write
    // count or persist a stale drag-A width.
    await resetLog(page);
    await dispatchPointerDownAtHandle(page, c.x, c.y);
    await dispatchWindowPointer(page, "pointermove", left + 560, c.y);
    await dispatchWindowPointer(page, "pointerup", left + 560, c.y);
    await page.waitForTimeout(150);

    let writes = await widthWrites(page);
    console.log(`[E4] drag B writes=${JSON.stringify(writes)}`);
    expect(writes.length).toBe(1);
    expect(near(Number(writes[0].value), 560, 2)).toBe(true);
    // Explicitly NOT drag A's width — a stale value is the failure mode here.
    expect(Number(writes[0].value)).toBeGreaterThan(500);

    // A bare pointermove after the drag ended must change nothing at all.
    await resetLog(page);
    const track = await widthTracksBareMoves(page, c.y);
    expect(track.tracked).toBe(false);
    expect((await widthWrites(page)).length).toBe(0);

    // Drag C: writes stay 1:1 with completed drags, not cumulative.
    await resetLog(page);
    const c3 = await handleCenter(page);
    await dispatchPointerDownAtHandle(page, c3.x, c3.y);
    await dispatchWindowPointer(page, "pointermove", left + 380, c3.y);
    await dispatchWindowPointer(page, "pointerup", left + 380, c3.y);
    await page.waitForTimeout(150);
    writes = await widthWrites(page);
    expect(writes.length).toBe(1);
    expect(near(Number(writes[0].value), 380, 2)).toBe(true);
  });

  test.describe("on a 900x900 viewport with a stored width above the ceiling", () => {
    test.use({ viewport: { width: 900, height: 900 } });

    test("E5: a zero-movement press keeps the stored 600; double-click still resets to 288", async ({
      page,
    }) => {
      // Stored 600 but max is 450, so the stored preference is deliberately
      // above what can be rendered.
      await setup(page, { rows: SMALL_ROWS, seedWidth: 600 });
      expect(near(await settledWidth(page), 450, 3)).toBe(true);
      expect(await storedWidth(page)).toBe("600");

      await resetLog(page);
      const c = await handleCenter(page);
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      await page.mouse.up(); // zero movement
      await page.waitForTimeout(150);

      const writes = await widthWrites(page);
      console.log(`[E5] zero-movement press writes=${JSON.stringify(writes)}`);
      expect(writes.length).toBe(1);
      // NOT downgraded to the clamped 450: a press that moved nothing must not
      // quietly overwrite the user's wider preference.
      expect(await storedWidth(page)).toBe("600");
      expect((await bodyStyles(page)).userSelect).toBe("");

      // Double-click resets even with pointer capture active on the handle.
      await page.locator(HANDLE).dblclick();
      await page.waitForTimeout(150);
      expect(await aria(page, "aria-valuenow")).toBe(DEFAULT_WIDTH);
      expect(await storedWidth(page)).toBe(String(DEFAULT_WIDTH));
      expect(near(await settledWidth(page), DEFAULT_WIDTH)).toBe(true);
      const body = await bodyStyles(page);
      expect(body.userSelect).toBe("");
      expect(body.cursor).toBe("");

      // Widening the window does not resurrect the old 600.
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.waitForTimeout(400);
      expect(near(await settledWidth(page), DEFAULT_WIDTH, 3)).toBe(true);
      expect(await storedWidth(page)).toBe(String(DEFAULT_WIDTH));
    });
  });
});

// A tiny guard on the fixture builder itself: if makeRows ever stops producing
// distinct titles, D1's exact-text lookup would fail for a confusing reason.
test("fixture sanity: the calibrated titles are distinct and the expected lengths", () => {
  expect(SHORT_TITLE.length).toBe(30);
  expect(MEDIUM_TITLE.length).toBe(65);
  expect(ABSURD_TITLE.length).toBe(300);
  expect(new Set(LONG_ROWS.map((r) => r.input.title)).size).toBe(LONG_ROWS.length);
  expect(makeRows(["a", "b"]).map((r) => r.id)).toEqual(["wf-t4332-0", "wf-t4332-1"]);
});
