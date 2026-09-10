import { test, expect } from "@playwright/test";
import {
  ABSURD_TITLE,
  CANVAS_BAR_HEIGHT,
  CODE_BAR_HEIGHT,
  CSS_SOURCES,
  DEFAULT_WIDTH,
  GLOBALS_BAR,
  GLOBALS_THUMB_DARK,
  GLOBALS_TRACK,
  HANDLE,
  KEY_STEP,
  LIST,
  LONG_ROWS,
  MAX_CEILING,
  MEDIUM_TITLE,
  MIN_WIDTH,
  MODAL_BAR_WIDTH,
  OVERFLOW_ROWS,
  PIPELINE_CANVAS_TRACK_DARK,
  PIPELINE_THUMB_DARK,
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
  mountBoardProbes,
  nativeGutter,
  near,
  pressKey,
  probeStyleEnv,
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

    // expect.soft throughout: these are four INDEPENDENT measurements of the
    // same fact, and a hard expect on the first one aborts the test so the rest
    // never report. When this regresses, the failure should name every channel
    // that moved, not just the gutter.
    //
    // THE assertion. 10 -> 6 is exactly the broken -> fixed flip; under the
    // TEAM-4330 mutation this line reads "expected 6, received 10".
    expect.soft(m.gutter).toBe(6);
    // The un-fixed thin path, measured live in the same page and the same run.
    expect.soft(thinGutter).toBe(10);
    // Ordering rather than a hard pin: native is a platform metric.
    expect.soft(native).toBeGreaterThan(thinGutter);
    // Stated directly: in the broken state the app container and the thin path
    // COLLAPSE to the same 10px, because the webkit width is dead code.
    expect.soft(m.gutter).not.toBe(thinGutter);

    // Both computed channels, kept ALONGSIDE the gutter rather than instead of
    // it. Broken state: "thin" and "rgb(42, 42, 58) rgba(0, 0, 0, 0)".
    expect.soft(m.scrollbarWidth).toBe("auto");
    expect.soft(m.scrollbarColor).toBe("auto");
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

    // Clip the ACTUAL reserved gutter, and assert its width softly. A hard
    // expect here would abort the test before a single pixel was examined,
    // which would make A4 add nothing over A1 in exactly the regression it
    // exists to catch. Clipping the measured width also means the strip is the
    // real scrollbar in both states, so the raster channels below are compared
    // like for like rather than sampling 6px of a 10px scrollbar.
    const gutter = await gutterOf(list);
    expect.soft(gutter).toBe(6);

    // Screenshot -> base64 data URL -> Image -> canvas -> getImageData, all
    // in-page. No PNG decoder and no new dependency.
    const s = await analyseGutterStrip(page, list, {
      gutterPx: gutter,
      thumb: TOKENS.dark.thumb,
      background: TOKENS.dark.surface1,
      edgeRows: 4,
      savePath: `${SCREENSHOT_DIR}/A4-gutter-strip-dark.png`,
    });
    console.log(`[A4] dark strip ${JSON.stringify(s.dims)} palette=${JSON.stringify(s.palette)}`);
    console.log(
      `[A4] anyNearWhite=${s.anyNearWhite} thumbTokenPixels=${s.thumbTokenPixels} ` +
        `topRowsHaveThumb=${s.topRowsHaveThumb} bottomRowsAllBackground=${s.bottomRowsAllBackground}`
    );

    // R1.5 literal: never a solid white bar in dark theme. CORROBORATING ONLY —
    // it also holds in the broken state (the thin scrollbar paints the same dark
    // token), so it documents the requirement rather than detecting a regression.
    expect.soft(s.anyNearWhite).toBe(false);
    // Non-vacuity: the thumb really is composited into the raster, so the
    // near-white check above cannot pass just because nothing was captured.
    // Also corroborating — a thumb is painted in both states.
    expect.soft(s.thumbTokenPixels).toBeGreaterThan(50);
    // DISCRIMINATING, and pixels are the only way to see it. At scrollTop 0 the
    // thumb sits flush against row 0 only when the ::-webkit-scrollbar rules
    // govern the paint; on the standard thin path it is inset behind ~9 rows of
    // track. Measured under the TEAM-4330 mutation: false (see
    // docs/evidence/TEAM-4332/differential.md, M1).
    expect.soft(s.topRowsHaveThumb).toBe(true);
    // CORROBORATING ONLY — measured `true` under the M1 mutation as well, so it
    // does NOT detect this regression. Chromium's thin scrollbar turns out to
    // paint no bottom arrow button here, so there is no ▼ chrome to lose. Kept
    // because it still pins ::-webkit-scrollbar-button{display:none} against a
    // future change that reintroduces arrow chrome, but it must not be counted
    // as coverage for TEAM-4330.
    expect.soft(s.bottomRowsAllBackground).toBe(true);
  });

  test("A5: light theme — thumb token follows the theme and the gutter is still 6px", async ({
    page,
  }) => {
    await setup(page, { rows: OVERFLOW_ROWS, clearWidth: true, theme: "light" });
    const list = page.getByTestId("workflow-history-list");
    const m = await listMetrics(list);

    expect(m.overflowsVertically).toBe(true);
    expect.soft(m.gutter).toBe(6);
    expect.soft(m.scrollbarWidth).toBe("auto");
    expect.soft(m.scrollbarColor).toBe("auto");
    expect.soft(m.wkThumbBg).toBe("rgb(206, 212, 218)"); // --color-surface-4, light

    // POSITIVE CONTROL for the A4 decode. The light container background is
    // itself near-white (--color-surface-1 #f1f3f5), so near-white pixels MUST
    // be present here. If A4's `anyNearWhite === false` were passing because
    // the decode sampled the wrong region or an empty buffer, this fails.
    // Clip the measured gutter for the same reason A4 does.
    const s = await analyseGutterStrip(page, list, {
      gutterPx: m.gutter,
      thumb: TOKENS.light.thumb,
      background: TOKENS.light.surface1,
      edgeRows: 4,
    });
    console.log(`[A5] light strip palette=${JSON.stringify(s.palette)}`);
    expect.soft(s.anyNearWhite).toBe(true);
    expect.soft(s.thumbTokenPixels).toBeGreaterThan(50);
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

  test.describe("on a 900px viewport with a stored preference above the ceiling (TEAM-4352)", () => {
    test.use({ viewport: { width: 900, height: 900 } });

    // E6 is the KEYBOARD twin of E5. E5 proves the POINTER path persists the
    // user's intent (preferredWidthRef) rather than the viewport-clamped render
    // width; the keyboard path stepped widthRef and persisted the result, so it
    // still carried TEAM-4331's B3 defect on its own channel — one ArrowRight
    // computed clamp(450 + 16) === 450 and wrote it, silently narrowing the
    // stored 600 to 450 while nothing moved on screen.
    //
    // Three INDEPENDENT channels discriminate, deliberately:
    //   - the WRITE COUNT (0 vs 1). Counted, not compared: a value-only check is
    //     exactly the assertion shape TEAM-4331 already showed passes on broken
    //     code.
    //   - the stored value ("600" vs "450").
    //   - the width RESTORED when the viewport grows back (600 vs 450) — the
    //     actual user-visible consequence of the lost preference, and the one
    //     channel that still fails if someone "fixes" only the write count.
    //
    // Those three are `expect.soft` for the reason group A already documents: a
    // hard expect aborts the test at the FIRST failure, so the differential run
    // would only ever record the write count and the other two channels — which
    // exist precisely so the evidence is not single-channel — would never
    // execute. The PRECONDITIONS stay hard: if 600/450/450 is not the starting
    // state, the rest of the test is measuring nothing and should stop.
    test("E6: an ArrowRight absorbed by the clamp writes nothing and keeps the 600 preference", async ({
      page,
    }) => {
      await setup(page, { rows: SMALL_ROWS, seedWidth: 600 });

      // Precondition: max = min(640, 900 * 0.5) = 450, so the stored 600 is
      // deliberately unrenderable here. That render/preference split is the only
      // state in which the defect is observable at all.
      expect(near(await settledWidth(page), 450, 3)).toBe(true);
      expect(await storedWidth(page)).toBe("600");
      expect(await aria(page, "aria-valuemax")).toBe(450);
      expect(await aria(page, "aria-valuenow")).toBe(450);

      await resetLog(page);
      const seen = await pressKey(page, "ArrowRight", 1);
      const writes = await widthWrites(page);
      console.log(
        `[E6] ArrowRight at the clamped ceiling: seen=${seen.join(",")} ` +
          `writes=${JSON.stringify(writes)} stored=${await storedWidth(page)}`
      );

      // Nothing moved on screen, so nothing may be persisted.
      expect.soft(writes.length).toBe(0);
      expect.soft(await storedWidth(page)).toBe("600");
      expect.soft(near(await settledWidth(page), 450, 3)).toBe(true);
      // aria stays honest — it reports the RENDERED width, never the preference.
      expect.soft(await aria(page, "aria-valuenow")).toBe(450);

      // The consequence the user actually feels: maximise the window and the 600
      // preference comes back. The unfixed handler renders 450 forever.
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.waitForTimeout(400);
      const restored = await settledWidth(page);
      console.log(
        `[E6] widened to 1600: rendered=${restored} valuenow=${await aria(page, "aria-valuenow")} ` +
          `stored=${await storedWidth(page)} writes=${(await widthWrites(page)).length}`
      );
      expect.soft(near(restored, 600, 3)).toBe(true);
      expect.soft(await aria(page, "aria-valuenow")).toBe(600);
      expect.soft(await storedWidth(page)).toBe("600");
      expect.soft((await widthWrites(page)).length).toBe(0); // restoring a preference is render-only
    });

    // The deliberate ASYMMETRY, pinned. From pref 600 / rendered 450, ArrowLeft
    // is NOT absorbed once it falls back to the rendered width: 450 - 16 = 434
    // VISIBLY narrows the sidebar, so 434 is allowed to become the new intent.
    // The alternative — stepping the 600 preference down 600 -> 584 -> ... —
    // would be ~10 keypresses with zero visible feedback, a worse defect. The
    // invariant this group protects is "a keypress that changes NOTHING VISIBLE
    // must not rewrite the preference", not "never rewrite it".
    //
    // This case passes on the UNFIXED handler too, so it is not a detector for
    // the TEAM-4352 defect. It exists to catch the OVER-fix (step the preference
    // with no rendered fallback), which would store "584", render 450 and leave
    // aria-valuenow at 450 — failing all three channels below. See
    // docs/evidence/TEAM-4352/differential.md.
    test("E6b: an ArrowLeft that VISIBLY narrows may replace the preference — exactly one write", async ({
      page,
    }) => {
      await setup(page, { rows: SMALL_ROWS, seedWidth: 600 });
      expect(near(await settledWidth(page), 450, 3)).toBe(true);
      expect(await storedWidth(page)).toBe("600");

      await resetLog(page);
      const seen = await pressKey(page, "ArrowLeft", 1);
      const writes = await widthWrites(page);
      console.log(
        `[E6b] ArrowLeft from pref 600 / rendered 450: seen=${seen.join(",")} ` +
          `writes=${JSON.stringify(writes)} rendered=${await settledWidth(page)}`
      );

      expect(writes.length).toBe(1);
      expect(writes[0].value).toBe(String(450 - KEY_STEP)); // "434"
      expect(await aria(page, "aria-valuenow")).toBe(450 - KEY_STEP);
      expect(near(await settledWidth(page), 450 - KEY_STEP, 3)).toBe(true);
      expect(await storedWidth(page)).toBe(String(450 - KEY_STEP));

      // 434 really is the new INTENT, not just a transient render: widening the
      // viewport must not resurrect the old 600.
      await page.setViewportSize({ width: 1600, height: 900 });
      await page.waitForTimeout(400);
      console.log(
        `[E6b] widened to 1600: rendered=${await settledWidth(page)} stored=${await storedWidth(page)}`
      );
      expect(near(await settledWidth(page), 450 - KEY_STEP, 3)).toBe(true);
      expect(await storedWidth(page)).toBe(String(450 - KEY_STEP));
    });
  });
});

// ════════════ F — the board scrollbars survive the global block (TEAM-4357) ═══
//
// The gap this closes: Group A proves globals.css's own scrollbar block paints,
// on `[data-testid=workflow-history-list]` — an element that carries NO
// pipeline.css class. Nothing anywhere named `.pipeline-canvas`,
// `.code-block-content`, `.modal-content`, `.s3-modal-content` or
// `.artifact-viewer-body`, so a re-broadened globals block (the pre-TEAM-4330
// state) or a globals `!important` would kill all five board scrollbars and the
// whole suite would stay green. See tests/helpers/workflow-resize.ts for the two
// mechanisms under test and why the real CSS is read off disk.
//
// Every value below was MEASURED with a throwaway probe before being pinned
// (Chromium 148, the ladder recorded at the top of this file), not copied from
// docs/TEAM-4330-scrollbar-verification.md — that doc's single `gutterPx` field
// does not say which axis it measured, and for `.code-block-content` its 6
// cannot be the horizontal gutter, which measures 4.

test.describe("F: pipeline.css board scrollbars survive globals.css (TEAM-4357)", () => {
  /** L1 for any board scroller: webkit painting is enabled at all. Identical
   *  logic and identical stakes for all three probes, so it is shared — but the
   *  message always names the class, because the failure output is the product. */
  const expectL1Auto = (
    m: { scrollbarWidth: string; scrollbarColor: string },
    cls: string
  ): void => {
    const why =
      `webkit scrollbar painting is DISABLED for ${cls}. Per MDN a computed ` +
      "`scrollbar-width`/`scrollbar-color` of anything other than `auto` suppresses " +
      "every ::-webkit-scrollbar-* rule, so the `@supports selector(::-webkit-scrollbar)` " +
      "auto-reset in src/styles/globals.css is missing, no longer matches, or has been " +
      "re-broadened. This kills ALL FIVE pipeline.css board scrollbar groups at once, " +
      "not just this one. Context: TEAM-4330 / docs/TEAM-4330-scrollbar-verification.md.";
    expect.soft(m.scrollbarWidth, `L1 ${cls}: ${why}`).toBe("auto");
    expect.soft(m.scrollbarColor, `L1 ${cls}: ${why}`).toBe("auto");
  };

  /** The message for "globals reclaimed the pseudo-element", parameterised. */
  const reclaimed = (cls: string, decl: string, line: string): string =>
    `L2 ${cls}: globals' \`*::-webkit-scrollbar\` has RECLAIMED the pseudo-element — ` +
    "either via !important or via a selector of equal-or-higher specificity than " +
    `(0,1,1). pipeline.css's own \`${decl}\` no longer governs. Compare ${line} ` +
    "against the `*::-webkit-scrollbar` rule in src/styles/globals.css.";

  test("F0: the injected sheets ARE the real files and both survival mechanisms are live", async ({
    page,
  }) => {
    await mountBoardProbes(page);
    const env = await probeStyleEnv(page);
    console.log(`[F0] sources ${JSON.stringify(CSS_SOURCES)}`);
    console.log(`[F0] env ${JSON.stringify(env)}`);

    // Hard, not soft: every other assertion in Group F is meaningless if the
    // harness did not actually load the files or the engine lacks the selector.
    expect(
      env.supportsWebkitSelector,
      "F0 engine gate: this Chromium does not support `selector(::-webkit-scrollbar)`, so " +
        "the @supports reset never applies and `auto` below would mean something else entirely."
    ).toBe(true);
    expect(env.themeAttr, "F0: mountBoardProbes failed to set data-theme=dark").toBe("dark");

    // Token pins, so the rgb() constants stay self-explaining if a token moves.
    expect(
      env.surface4,
      "F0: globals' dark --color-surface-4 moved. GLOBALS_THUMB_DARK in " +
        "tests/helpers/workflow-resize.ts is derived from it and must be updated together."
    ).toBe("#2a2a3a");
    expect(
      env.pipelineBorder,
      "F0: pipeline.css's --pipeline-border moved. PIPELINE_THUMB_DARK is derived from it. " +
        "NOTE it is declared in `:root` (dark is the default), not in a [data-theme=dark] block."
    ).toBe("#1e293b");

    // ── mechanism (a): the auto-reset ──────────────────────────────────────────
    expect(
      env.supportsGroupCount,
      "F0 mechanism (a): expected exactly ONE `@supports selector(::-webkit-scrollbar)` group " +
        "in src/styles/globals.css. Zero means the auto-reset was deleted and every " +
        "::-webkit-scrollbar rule in the app is now dead code (the pre-TEAM-4330 bug); more " +
        "than one means the reset was duplicated and source order now decides the outcome."
    ).toBe(1);
    expect(
      env.supportsResetDecls,
      "F0 mechanism (a): the @supports group must reset BOTH standard properties on `*`. " +
        "scrollbar-color is inherited and scrollbar-width is not, so resetting only one leaves " +
        "the outcome dependent on which MDN sentence you read."
    ).toEqual([{ selector: "*", scrollbarWidth: "auto", scrollbarColor: "auto" }]);

    // Baseline pin: what the global bar declares, i.e. what a reclaimed board
    // scroller would fall back to.
    expect(
      env.starBarDecls,
      "F0: globals' universal `*::-webkit-scrollbar` geometry changed (or the rule is gone). " +
        "GLOBALS_BAR and the F2 negative assertion both depend on it being 6px/6px."
    ).toEqual({ width: "6px", height: "6px" });

    // ── mechanism (b): the five class-qualified groups ────────────────────────
    // Renaming or deleting one reddens HERE, instead of silently shrinking the
    // coverage of the three probes below to a subset of the board.
    expect(
      env.pipelineWebkitGroupSelectors,
      "F0 mechanism (b): the set of `::-webkit-scrollbar` groups in " +
        "src/components/workflow/pipeline.css changed. F1-F3 probe three of these five " +
        "directly; the other two (.s3-modal-content, .artifact-viewer-body) are structurally " +
        "identical to .modal-content and are guarded by this assertion alone."
    ).toEqual([
      ".artifact-viewer-body::-webkit-scrollbar",
      ".code-block-content::-webkit-scrollbar",
      ".modal-content::-webkit-scrollbar",
      ".pipeline-canvas::-webkit-scrollbar",
      ".s3-modal-content::-webkit-scrollbar",
    ]);

    // Non-contamination: the probe harness must not be the reason F1-F3 pass.
    expect(
      env.harnessMentionsScrollbar,
      "F0: the probe harness CSS now mentions `scrollbar`. It styles wrapper IDs only, " +
        "deliberately — a scrollbar declaration in the harness would make Group F assert the " +
        "harness rather than the shipped stylesheets."
    ).toBe(false);

    // Non-vacuity on BOTH axes: if a future runner hides scrollbars (Playwright
    // passes --hide-scrollbars by default; see the test.use at the top of this
    // file), every gutter collapses to 0 and F1-F3 would pass by measuring
    // nothing. These fail loudly instead.
    const nativeY = await nativeGutter(page, "y");
    const nativeX = await nativeGutter(page, "x");
    console.log(`[F0] bare control nativeY=${nativeY} nativeX=${nativeX}`);
    const vacuity =
      "F0 non-vacuity: a bare page with NO author CSS reserves a 0px gutter, so scrollbars are " +
      "hidden in this run (a lost `ignoreDefaultArgs: [--hide-scrollbars]`, or a headless " +
      "default change). Every L3 gutter assertion in F1-F3 would then pass vacuously.";
    expect.soft(nativeY, `${vacuity} (vertical axis)`).toBeGreaterThan(0);
    expect.soft(nativeX, `${vacuity} (horizontal axis)`).toBeGreaterThan(0);
  });

  test("F1: .pipeline-canvas keeps its own 6px bar and --pipeline-bg track", async ({ page }) => {
    await mountBoardProbes(page);
    const m = await listMetrics(page.locator(".pipeline-canvas"));
    console.log(
      `[F1] .pipeline-canvas hGutter=${m.hGutter} vGutter=${m.gutter} ` +
        `wkHeight=${JSON.stringify(m.wkHeight)} thumb=${JSON.stringify(m.wkThumbBg)} ` +
        `track=${JSON.stringify(m.wkTrackBg)} sbW=${JSON.stringify(m.scrollbarWidth)}`
    );

    expect(
      m.overflowsHorizontally,
      "F1 precondition: the canvas probe does not overflow horizontally, so there is no " +
        "horizontal scrollbar to measure and the FIXTURE is what is wrong, not the app. " +
        "8 × .phase-box (290px) inside a 600px wrapper must overflow."
    ).toBe(true);

    expectL1Auto(m, ".pipeline-canvas");

    // L2. NOTE: `height: 6px` is the SAME value globals declares, so geometry
    // alone does NOT discriminate here — a reclaim by globals would still read
    // 6px. The colours below are the real discriminators for this group.
    expect.soft(
      m.wkHeight,
      reclaimed(
        ".pipeline-canvas",
        ".pipeline-canvas::-webkit-scrollbar { height: 6px }",
        "src/components/workflow/pipeline.css:619"
      ) + " (pinned, but NOT discriminating: globals declares 6px too.)"
    ).toBe(CANVAS_BAR_HEIGHT);
    expect.soft(
      m.wkThumbBg,
      reclaimed(
        ".pipeline-canvas",
        ".pipeline-canvas::-webkit-scrollbar-thumb { background: var(--pipeline-border) }",
        "src/components/workflow/pipeline.css:621"
      )
    ).toBe(PIPELINE_THUMB_DARK);
    // The negative form of the same fact. Redundant today by construction, kept
    // because THIS is the line whose failure message names the regression: the
    // board bar is now wearing globals' --color-surface-4.
    expect.soft(
      m.wkThumbBg,
      "L2 .pipeline-canvas: the thumb is now globals' --color-surface-4 (#2a2a3a) instead of " +
        "pipeline.css's --pipeline-border (#1e293b) — the board scrollbar has been repainted " +
        "by src/styles/globals.css's `*::-webkit-scrollbar-thumb`."
    ).not.toBe(GLOBALS_THUMB_DARK);
    expect.soft(
      m.wkThumbRadius,
      reclaimed(
        ".pipeline-canvas",
        ".pipeline-canvas::-webkit-scrollbar-thumb { border-radius: 3px }",
        "src/components/workflow/pipeline.css:621"
      )
    ).toBe("3px");
    // THE canvas discriminator: it is the only one of the five groups with its
    // own track colour, so this channel cannot be confused with globals'.
    expect.soft(
      m.wkTrackBg,
      reclaimed(
        ".pipeline-canvas",
        ".pipeline-canvas::-webkit-scrollbar-track { background: var(--pipeline-bg) }",
        "src/components/workflow/pipeline.css:620"
      ) + " This is the canvas's strongest signal — no other board group sets a track colour."
    ).toBe(PIPELINE_CANVAS_TRACK_DARK);
    expect.soft(
      m.wkTrackBg,
      "L2 .pipeline-canvas: the track is now TRANSPARENT, i.e. globals' " +
        "`*::-webkit-scrollbar-track { background: transparent }` has won over pipeline.css's " +
        "opaque var(--pipeline-bg) track."
    ).not.toBe(GLOBALS_TRACK);

    // L3 — the only proof the rule actually PAINTS. Chromium reports the L2
    // strings from the declaration even when painting is suppressed, which is
    // exactly how the old case 5 passed against the broken code.
    expect.soft(
      m.hGutter,
      "L3 .pipeline-canvas: the reserved HORIZONTAL gutter (offsetHeight - clientHeight) is " +
        "not 6px, so pipeline.css's `.pipeline-canvas::-webkit-scrollbar { height: 6px }` is " +
        "not governing the paint. 10 means the standard `scrollbar-width: thin` path took over " +
        "(the @supports auto-reset is gone); 15 means the platform-native bar; 0 means " +
        "scrollbars are hidden in this run."
    ).toBe(6);
    expect.soft(
      m.gutter,
      "L3 .pipeline-canvas: a VERTICAL gutter appeared. The canvas is `overflow-x: auto` with " +
        "`min-height: 840px`, so it must overflow horizontally only — a vertical bar means the " +
        "probe geometry changed and the horizontal measurement above is no longer attributable " +
        "to one axis."
    ).toBe(0);
  });

  test("F2: .code-block-content keeps pipeline.css's 4px bar, NOT globals' 6px", async ({
    page,
  }) => {
    await mountBoardProbes(page);
    const m = await listMetrics(page.locator(".code-block-content"));
    console.log(
      `[F2] .code-block-content hGutter=${m.hGutter} vGutter=${m.gutter} ` +
        `wkHeight=${JSON.stringify(m.wkHeight)} wkWidth=${JSON.stringify(m.wkWidth)} ` +
        `thumb=${JSON.stringify(m.wkThumbBg)} sbW=${JSON.stringify(m.scrollbarWidth)}`
    );

    expect(
      m.overflowsHorizontally,
      "F2 precondition: the <pre> probe does not overflow horizontally. `white-space: pre` " +
        "comes from the UA stylesheet (pipeline.css sets none), so one long unwrapped line " +
        "must overflow a 600px wrapper — if it does not, the FIXTURE is wrong."
    ).toBe(true);

    expectL1Auto(m, ".code-block-content");

    // L2. This is the ONE genuinely discriminating geometry channel on the whole
    // board: 4px is a value globals does not declare anywhere, so a reclaim by
    // globals is visible here and nowhere else in the geometry.
    expect.soft(
      m.wkHeight,
      reclaimed(
        ".code-block-content",
        ".code-block-content::-webkit-scrollbar { height: 4px }",
        "src/components/workflow/pipeline.css:498"
      ) + " 4px is the only board geometry globals does not also declare, so this is the " +
        "sharpest geometric signal in Group F."
    ).toBe(CODE_BAR_HEIGHT);
    expect.soft(
      m.wkHeight,
      "L2 .code-block-content: the bar is now 6px — globals' universal " +
        "`*::-webkit-scrollbar { height: 6px }` has replaced pipeline.css's 4px code-block bar."
    ).not.toBe(GLOBALS_BAR);
    expect.soft(
      m.wkThumbBg,
      reclaimed(
        ".code-block-content",
        ".code-block-content::-webkit-scrollbar-thumb { background: var(--pipeline-border) }",
        "src/components/workflow/pipeline.css:500"
      )
    ).toBe(PIPELINE_THUMB_DARK);
    expect.soft(
      m.wkThumbBg,
      "L2 .code-block-content: the thumb is now globals' --color-surface-4 (#2a2a3a) instead " +
        "of pipeline.css's --pipeline-border (#1e293b) — globals' " +
        "`*::-webkit-scrollbar-thumb` has repainted the code-block scrollbar."
    ).not.toBe(GLOBALS_THUMB_DARK);
    expect.soft(
      m.wkThumbRadius,
      reclaimed(
        ".code-block-content",
        ".code-block-content::-webkit-scrollbar-thumb { border-radius: 2px }",
        "src/components/workflow/pipeline.css:500"
      )
    ).toBe("2px");
    // Deliberately asserts globals' value: pipeline.css declares no `width` for
    // this group, so globals legitimately governs that axis. A PIN, not a
    // discriminator — it states that the guard means "pipeline wins where it
    // declares", not "globals is dead".
    expect.soft(
      m.wkWidth,
      "L2 .code-block-content: the vertical bar WIDTH is expected to come from globals " +
        "(pipeline.css declares only `height` for this group), so 6px here is correct and " +
        "intended. A different value means globals' universal bar geometry changed — update " +
        "GLOBALS_BAR and re-check F0's starBarDecls pin."
    ).toBe(GLOBALS_BAR);

    // L3 — the paint. 4 vs 6 is the flip both negative controls target.
    expect.soft(
      m.hGutter,
      "L3 .code-block-content: the reserved HORIZONTAL gutter (offsetHeight - clientHeight) " +
        "is not 4px, so pipeline.css's 4px rule is not governing the paint. 6 means globals " +
        "reclaimed it; 10 means the standard thin path took over (the @supports auto-reset is " +
        "gone); 0 means scrollbars are hidden in this run."
    ).toBe(4);
    expect.soft(
      m.hGutter,
      "L3 .code-block-content: the horizontal gutter is 6px — globals' universal 6px bar is " +
        "now painting on the code block instead of pipeline.css's 4px one."
    ).not.toBe(6);
    // Axis attribution. docs/TEAM-4330-scrollbar-verification.md records a single
    // `gutterPx: 6` for this class, which CANNOT be the horizontal gutter measured
    // above (4) — it is the width-axis/globals-governed reading. Pinning the cross
    // axis explicitly is what keeps that ambiguity out of this file.
    expect.soft(
      m.gutter,
      "L3 .code-block-content: a VERTICAL gutter appeared on the <pre> probe. It holds one " +
        "unwrapped line, so it must overflow horizontally only; a vertical bar means the " +
        "horizontal measurement above is no longer attributable to a single axis."
    ).toBe(0);
  });

  test("F3: .modal-content's 6px bar carries pipeline.css's thumb, NOT globals'", async ({
    page,
  }) => {
    await mountBoardProbes(page);
    const m = await listMetrics(page.locator(".modal-content"));
    console.log(
      `[F3] .modal-content vGutter=${m.gutter} hGutter=${m.hGutter} ` +
        `wkWidth=${JSON.stringify(m.wkWidth)} thumb=${JSON.stringify(m.wkThumbBg)} ` +
        `sbW=${JSON.stringify(m.scrollbarWidth)}`
    );

    expect(
      m.overflowsVertically,
      "F3 precondition: the modal body does not overflow vertically. `.modal-content { flex: 1 }` " +
        "needs `.agent-output-modal`'s `display:flex; flex-direction:column; max-height:80vh` " +
        "to have a height to overflow — if it does not, the FIXTURE lost that wrapper."
    ).toBe(true);

    expectL1Auto(m, ".modal-content");

    // L2. NOTE: `width: 6px` is identical to globals', so geometry does NOT
    // discriminate for this group either, and its track is transparent in BOTH
    // sheets. The thumb colour is the ONLY channel that can tell the two apart —
    // which is precisely why the negative assertion below is the load-bearing one.
    expect.soft(
      m.wkWidth,
      reclaimed(
        ".modal-content",
        ".modal-content::-webkit-scrollbar { width: 6px }",
        "src/components/workflow/pipeline.css:510"
      ) + " (pinned, but NOT discriminating: globals declares 6px too.)"
    ).toBe(MODAL_BAR_WIDTH);
    expect.soft(
      m.wkThumbBg,
      reclaimed(
        ".modal-content",
        ".modal-content::-webkit-scrollbar-thumb { background: var(--pipeline-border) }",
        "src/components/workflow/pipeline.css:512"
      ) + " This is the ONLY discriminating channel for this group."
    ).toBe(PIPELINE_THUMB_DARK);
    expect.soft(
      m.wkThumbBg,
      "L2 .modal-content: the thumb is now globals' --color-surface-4 (#2a2a3a) instead of " +
        "pipeline.css's --pipeline-border (#1e293b). For this group the thumb colour is the " +
        "ONLY signal — its 6px width and transparent track are identical in both sheets — so " +
        "this assertion is the whole guard for .modal-content (and, via F0, for the " +
        "structurally identical .s3-modal-content and .artifact-viewer-body)."
    ).not.toBe(GLOBALS_THUMB_DARK);
    expect.soft(
      m.wkThumbRadius,
      reclaimed(
        ".modal-content",
        ".modal-content::-webkit-scrollbar-thumb { border-radius: 3px }",
        "src/components/workflow/pipeline.css:512"
      )
    ).toBe("3px");
    expect.soft(
      m.wkTrackBg,
      "L2 .modal-content: the track colour changed. pipeline.css declares `transparent` here " +
        "and so does globals, so this value is expected to be identical either way — it is a " +
        "pin on the design, NOT a discriminator between the two sheets."
    ).toBe(GLOBALS_TRACK);

    // L3 — the paint, on the VERTICAL axis for this group.
    expect.soft(
      m.gutter,
      "L3 .modal-content: the reserved VERTICAL gutter (offsetWidth - clientWidth) is not 6px, " +
        "so `.modal-content::-webkit-scrollbar { width: 6px }` is not governing the paint. " +
        "10 means the standard thin path took over (the @supports auto-reset is gone); " +
        "15 means the platform-native bar; 0 means scrollbars are hidden in this run."
    ).toBe(6);
    expect.soft(
      m.hGutter,
      "L3 .modal-content: a HORIZONTAL gutter appeared. The modal body is `overflow-y: auto` " +
        "with narrow content, so it must overflow vertically only."
    ).toBe(0);
  });
});

// ═════════════ G — the corrupt stored-width path (TEAM-4357) ══════════════════
//
// `Number.isFinite` guards the mount read (src/app/workflow/page.tsx:108) and was
// only ever exercised indirectly. These four cases pin BOTH of its branches, and
// the storage value is asserted unchanged in each: the read path must never
// rewrite what it just read.

test.describe("G: a corrupt stored width falls back safely (TEAM-4357)", () => {
  for (const seed of ["abc", "NaN", "1e999"]) {
    test(`G: a stored width of ${JSON.stringify(seed)} renders the ${DEFAULT_WIDTH} default`, async ({
      page,
    }) => {
      // "abc"/"NaN" -> Number(...) is NaN; "1e999" -> Infinity. Both are rejected
      // by Number.isFinite, but they are DIFFERENT rejection paths, and "abc"
      // alone never reaches the Infinity one.
      await setup(page, { rows: SMALL_ROWS, seedWidthRaw: seed });

      expect(
        await aria(page, "aria-valuenow"),
        `G(${seed}): a non-finite stored width must leave the width at the ${DEFAULT_WIDTH} ` +
          "default. The Number.isFinite guard at src/app/workflow/page.tsx:108 either accepted " +
          "a non-finite value (NaN/Infinity would then flow into clampHistoryWidth) or the " +
          "SSR-safe seed changed."
      ).toBe(DEFAULT_WIDTH);
      expect(
        near(await settledWidth(page), DEFAULT_WIDTH),
        `G(${seed}): the RENDERED sidebar width does not match the ${DEFAULT_WIDTH} default, ` +
          "even though aria-valuenow does — state and layout have diverged."
      ).toBe(true);
      expect(
        await storedWidth(page),
        `G(${seed}): the mount READ rewrote localStorage. It must be side-effect free — ` +
          "silently normalising a corrupt value would destroy the evidence of the corruption " +
          "and make this class of bug unreproducible."
      ).toBe(seed);
    });
  }

  test(`G: an EMPTY stored width clamps to the ${MIN_WIDTH} floor, not the ${DEFAULT_WIDTH} default`, async ({
    page,
  }) => {
    // NOT the 288 default, and this is the ticket's own brief being wrong rather
    // than the app: `Number("") === 0` and `Number.isFinite(0) === true`, so the
    // guard at src/app/workflow/page.tsx:108 ACCEPTS an empty string. That sets
    // preferredWidthRef to 0 and renders clampHistoryWidth(0), which is
    // HISTORY_MIN_WIDTH === 240. So for "" it is the CLAMP FLOOR, not the
    // Number.isFinite guard, that keeps a broken width off the screen. Pinned at
    // 240 deliberately — asserting 288 here would encode a wrong mental model of
    // which guard is doing the work.
    await setup(page, { rows: SMALL_ROWS, seedWidthRaw: "" });

    expect(
      await aria(page, "aria-valuenow"),
      `G(""): an empty stored width must render the ${MIN_WIDTH} clamp floor. Number("") is 0, ` +
        "which IS finite, so page.tsx:108 accepts it and clampHistoryWidth(0) yields " +
        `${MIN_WIDTH}. Receiving ${DEFAULT_WIDTH} would mean the guard started rejecting "" ` +
        "(a behaviour change, not necessarily a bug — but this test must then be re-decided, " +
        "not silently re-pinned)."
    ).toBe(MIN_WIDTH);
    expect(
      near(await settledWidth(page), MIN_WIDTH),
      `G(""): the RENDERED width does not match the ${MIN_WIDTH} floor that aria-valuenow reports.`
    ).toBe(true);
    expect(
      await storedWidth(page),
      'G(""): the mount read rewrote the empty stored value instead of leaving it alone.'
    ).toBe("");
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
