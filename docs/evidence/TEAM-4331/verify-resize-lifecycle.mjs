/**
 * TEAM-4331 — standalone drag-resize LIFECYCLE verification probe.
 *
 * Run with node (NOT the Playwright test runner) so it is never collected by
 * playwright.config.ts (testDir: "./tests"). It imports `playwright` directly.
 *
 *   node docs/evidence/TEAM-4331/verify-resize-lifecycle.mjs [--label="AFTER (fix)"]
 *
 * The repo has no jsdom/@testing-library (vitest runs in node) and this ticket
 * adds no deps, so the three review findings are proven live in Chromium against
 * the dev server instead of in a React DOM unit test.
 *
 * Cases (all in dark mode with the sidebar EXPANDED — it seeds collapsed, so the
 * handle would not exist otherwise):
 *   C1  B1: lost pointer capture (== a mouse released OUTSIDE the browser window)
 *           restores body userSelect + cursor and detaches onMove.
 *   C2  B1: pointercancel mid-drag does the same.
 *   C3  B3: a viewport change clamps the RENDERED width without ever writing
 *           localStorage, and widening restores the user's preference.
 *   C4  B2: a stuck drag followed by a normal drag leaks no listeners, and each
 *           completed drag persists exactly once.
 *   C5      the dblclick reset still works WITH pointer capture active (capture
 *           retargets the compat mouse events, so this is proven, not assumed),
 *           and a zero-movement pointerdown/up does not downgrade the preference.
 *
 * Every localStorage.setItem is instrumented (window.__setItemLog) so "exactly one
 * write per drag" and "zero writes on resize" are machine-checked, not inferred.
 *
 * HONEST CAVEAT (C1): Playwright's input API cannot move the OS cursor outside the
 * page, so a literal out-of-window mouse release is not reachable from a script.
 * `lostpointercapture` is the exact event the browser fires at the capture element
 * in that situation, so C1 dispatches it with NO pointerup — which is strictly the
 * harder case (on base, nothing at all runs).
 *
 * Exits non-zero on any failed assertion.
 */
import { chromium } from "playwright";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";
const labelArg = process.argv.find((a) => a.startsWith("--label="));
const LABEL = labelArg ? labelArg.slice("--label=".length) : "";

const HANDLE = "[role='separator'][aria-label='Resize workflows sidebar']";
const WIDTH_KEY = "workflow-history-width";
const DEFAULT_WIDTH = 288;
const MIN_WIDTH = 240;
const MAX_CEILING = 640;

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg, extra) {
  if (cond) {
    log(`  PASS  ${msg}${extra !== undefined ? ` (${extra})` : ""}`);
  } else {
    failures++;
    log(`  FAIL  ${msg}${extra !== undefined ? ` (${extra})` : ""}`);
  }
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- page helpers

/**
 * Seed theme + expanded sidebar + (optionally) a stored width BEFORE navigation,
 * and instrument localStorage.setItem. layout.tsx reads localStorage.theme during
 * hydration, so this must be an init script, not a post-load evaluate.
 */
async function setup(page, opts = {}) {
  await page.addInitScript((o) => {
    // --- instrument every write, before the app can make one ---
    window.__setItemLog = [];
    const raw = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      window.__setItemLog.push({ key: String(k), value: String(v) });
      return raw.call(this, k, v);
    };
    localStorage.setItem("theme", "dark");
    localStorage.setItem("workflow-history-collapsed", "false");
    // The width seed/clear must apply to the FIRST load only: addInitScript re-runs
    // on every navigation, so an unguarded clearWidth would delete a dragged width
    // before a reloaded app could read it (and an unguarded seedWidth would rewrite
    // it), making any post-reload assertion meaningless. sessionStorage survives a
    // reload in the same tab, so it is the right sentinel.
    if (!sessionStorage.getItem("__probe_width_seeded")) {
      sessionStorage.setItem("__probe_width_seeded", "1");
      if (o.clearWidth) localStorage.removeItem("workflow-history-width");
      else if (typeof o.seedWidth === "number") {
        localStorage.setItem("workflow-history-width", String(o.seedWidth));
      }
    }
    // Writes made by this init script are logged too; tests call resetLog() after
    // load so only app-originated writes are ever asserted on.
  }, opts);
  await page.goto(`${BASE_URL}/workflow`, { waitUntil: "domcontentloaded" });
  // Do not wait for networkidle: /workflow polls AWS-backed APIs that may hang or
  // fail in a credential-less environment. The sidebar renders regardless.
  await page.waitForSelector(HANDLE, { state: "visible", timeout: 30000 });
  // The sidebar mounts COLLAPSED (w-8) and animates to its expanded width over
  // 300ms once the effect reads localStorage. Grabbing the handle mid-animation
  // makes pointerdown miss it entirely, so wait for the width to settle before
  // any case interacts.
  await settledWidth(page);
}

const resetLog = (page) => page.evaluate(() => { window.__setItemLog = []; });
const widthWrites = (page) =>
  page.evaluate((k) => window.__setItemLog.filter((e) => e.key === k), WIDTH_KEY);
const storedWidth = (page) =>
  page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY);

/** The sidebar element = the handle's parent (do not couple to DOM shape). */
const sidebar = (page) => page.locator(HANDLE).locator("xpath=..");

/** Rendered width straight off the box model — what the user actually sees. */
async function renderedWidth(page) {
  const box = await sidebar(page).boundingBox();
  return box?.width ?? 0;
}

/** `transition-all duration-300` animates non-drag width changes; poll to settle. */
async function settledWidth(page, timeout = 2500) {
  let last = -1;
  let stable = 0;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const w = await renderedWidth(page);
    stable = near(w, last, 0.6) ? stable + 1 : 0;
    last = w;
    if (stable >= 3) break;
    await page.waitForTimeout(60);
  }
  return last;
}

const aria = async (page, attr) =>
  Number(await page.locator(HANDLE).getAttribute(attr));

/** Body styles the drag mutates globally — the heart of the B1 acceptance. */
const bodyStyles = (page) =>
  page.evaluate(() => ({
    userSelect: document.body.style.userSelect,
    cursor: document.body.style.cursor,
  }));

/**
 * `isResizing` suppresses the container's `transition-all` class while dragging,
 * so its absence is an observable proxy for "React thinks the drag is over".
 */
async function isResizingVisualState(page) {
  const cls = (await sidebar(page).getAttribute("class")) || "";
  return !cls.includes("transition-all"); // true == still mid-drag
}

async function handleCenter(page) {
  const box = await page.locator(HANDLE).boundingBox();
  if (!box) throw new Error("resize handle has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Dispatch a real PointerEvent at the handle (the capture target). */
function dispatchAtHandle(page, type) {
  return page.evaluate(
    ({ sel, t }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error("handle not found for dispatch");
      el.dispatchEvent(
        new PointerEvent(t, { bubbles: true, cancelable: false, pointerId: 1 })
      );
    },
    { sel: HANDLE, t: type }
  );
}

/** The sidebar's left edge in viewport coords. The app's left nav offsets it
 *  (~256px) and the page uses a `-m-6` negative margin, so a drag target must be
 *  expressed as sidebarLeft + desiredWidth, never as a bare screen x. */
async function sidebarLeft(page) {
  const box = await sidebar(page).boundingBox();
  if (!box) throw new Error("sidebar has no bounding box");
  return box.x;
}

/** pointerdown on the handle + N real pointermoves until the sidebar is
 *  `targetWidth` wide. Returns the drag origin and the sidebar's left edge. */
async function startDragToWidth(page, targetWidth) {
  const left = await sidebarLeft(page);
  const c = await handleCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(left + targetWidth, c.y, { steps: 12 }); // steps required for React to see moves
  return { ...c, left };
}

/**
 * Move the bare pointer (no button semantics that matter — the point is that a
 * torn-down drag must ignore these) and report whether the width followed. The
 * targets are chosen to map to widths clearly different from the current one, so
 * a still-live onMove would visibly change the width.
 */
async function widthTracksBareMoves(page, y) {
  const left = await sidebarLeft(page);
  const before = await renderedWidth(page);
  const beforeAria = await aria(page, "aria-valuenow");
  for (const w of [before - 120, before + 90, MIN_WIDTH + 20]) {
    await page.mouse.move(left + w, y, { steps: 4 });
    await page.waitForTimeout(30);
  }
  const after = await renderedWidth(page);
  const afterAria = await aria(page, "aria-valuenow");
  return {
    tracked: !near(after, before, 3) || !near(afterAria, beforeAria, 1),
    before,
    after,
    beforeAria,
    afterAria,
  };
}

// ---------------------------------------------------------------------- cases

async function c1LostCapture(browser) {
  log("\n----- C1 (B1): lost pointer capture == mouse released OUTSIDE the window -----");
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await setup(page, { clearWidth: true });
  await resetLog(page);

  const c = await startDragToWidth(page, 520);
  const dragged = await renderedWidth(page);
  assert(dragged > DEFAULT_WIDTH + 100, "drag widened the sidebar before the interruption", `${Math.round(dragged)}px`);
  assert(await isResizingVisualState(page), "mid-drag: transition suppressed (isResizing true)");

  // Direct proof of the B1 mechanism itself, not just its effect: the handle must
  // actually hold the pointer capture mid-drag (Chromium's mouse is pointerId 1).
  const captured = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return [1, 2, 3].some((id) => el.hasPointerCapture(id));
  }, HANDLE);
  assert(captured, "mid-drag: the handle HOLDS the pointer capture (setPointerCapture took effect)");

  // The exact event a browser fires at the capture element when the pointer is
  // lost to an out-of-window release. NO pointerup is delivered.
  await dispatchAtHandle(page, "lostpointercapture");
  await page.waitForTimeout(120);

  const styles = await bodyStyles(page);
  assert(styles.userSelect === "", 'body.style.userSelect restored to ""', JSON.stringify(styles.userSelect));
  assert(styles.cursor === "", 'body.style.cursor restored to ""', JSON.stringify(styles.cursor));
  assert(!(await isResizingVisualState(page)), "isResizing cleared (transition class back)");

  const t = await widthTracksBareMoves(page, c.y);
  assert(!t.tracked, "bare pointermoves after lost capture do NOT resize the sidebar",
    `rendered ${Math.round(t.before)}->${Math.round(t.after)}, aria ${t.beforeAria}->${t.afterAria}`);

  const writes = await widthWrites(page);
  assert(writes.length === 1, "exactly ONE width write for the interrupted drag", `${writes.length}: ${JSON.stringify(writes.map((w) => w.value))}`);
  assert(writes.length === 1 && near(Number(writes[0].value), dragged, 3),
    "the persisted value equals the width at interruption", writes[0]?.value);

  // A late pointerup must not resurrect anything or double-write.
  await page.mouse.up();
  await page.waitForTimeout(80);
  const after = await widthWrites(page);
  assert(after.length === 1, "a late pointerup adds NO second write (idempotent onEnd)", `${after.length}`);
  const styles2 = await bodyStyles(page);
  assert(styles2.userSelect === "" && styles2.cursor === "", "body styles still clean after the late pointerup");

  await ctx.close();
}

async function c2PointerCancel(browser) {
  log("\n----- C2 (B1): pointercancel mid-drag -----");
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await setup(page, { clearWidth: true });
  await resetLog(page);

  const c = await startDragToWidth(page, 500);
  const dragged = await renderedWidth(page);
  assert(dragged > DEFAULT_WIDTH + 100, "drag widened the sidebar before the cancel", `${Math.round(dragged)}px`);

  await dispatchAtHandle(page, "pointercancel");
  await page.waitForTimeout(120);

  const styles = await bodyStyles(page);
  assert(styles.userSelect === "", 'body.style.userSelect restored to ""', JSON.stringify(styles.userSelect));
  assert(styles.cursor === "", 'body.style.cursor restored to ""', JSON.stringify(styles.cursor));
  assert(!(await isResizingVisualState(page)), "isResizing cleared");

  const t = await widthTracksBareMoves(page, c.y);
  assert(!t.tracked, "bare pointermoves after pointercancel do NOT resize the sidebar",
    `rendered ${Math.round(t.before)}->${Math.round(t.after)}`);

  const writes = await widthWrites(page);
  assert(writes.length === 1, "exactly ONE width write for the cancelled drag", `${writes.length}`);

  await page.mouse.up();
  await ctx.close();
}

async function c3ViewportPreference(browser) {
  log("\n----- C3 (B3): viewport clamp must not destroy the stored preference -----");
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await setup(page, { clearWidth: true });
  await resetLog(page);

  // --- drag to ~600 on a wide viewport (max = min(640, 800) = 640) ---
  const c = await startDragToWidth(page, 600);
  await page.mouse.up();
  await page.waitForTimeout(120);

  const wide = await renderedWidth(page);
  assert(near(wide, 600, 6), "dragged to ~600px on the 1600px viewport", `${Math.round(wide)}px`);
  assert(near(Number(await storedWidth(page)), 600, 6), "stored preference is the dragged ~600", await storedWidth(page));
  assert(near(await aria(page, "aria-valuenow"), wide, 2), "aria-valuenow tracks the rendered width", `${await aria(page, "aria-valuenow")} vs ${Math.round(wide)}`);
  assert(await aria(page, "aria-valuemax") === MAX_CEILING, "aria-valuemax is the 640 ceiling at 1600px", `${await aria(page, "aria-valuemax")}`);

  const storedBeforeResize = await storedWidth(page);
  await resetLog(page);

  // --- narrow the viewport: max becomes 900*0.5 = 450 ---
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(200);
  const clamped = await settledWidth(page);

  const resizeWrites = await widthWrites(page);
  assert(resizeWrites.length === 0, "ZERO width writes fired during the viewport resize",
    `${resizeWrites.length}: ${JSON.stringify(resizeWrites.map((w) => w.value))}`);
  assert((await storedWidth(page)) === storedBeforeResize,
    "stored preference is STILL ~600 after narrowing", `${await storedWidth(page)}`);
  assert(near(clamped, 450, 4), "RENDERED width clamped down to the new max 450", `${Math.round(clamped)}px`);
  assert(near(await aria(page, "aria-valuenow"), clamped, 2), "aria-valuenow tracks the clamped rendered width", `${await aria(page, "aria-valuenow")}`);
  assert(await aria(page, "aria-valuemax") === 450, "aria-valuemax honestly reports 450", `${await aria(page, "aria-valuemax")}`);

  // --- widen back: the preference must come back ---
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(200);
  const restored = await settledWidth(page);
  assert(near(restored, 600, 6), "widening RESTORES the ~600 preference to the rendered width", `${Math.round(restored)}px`);
  assert(near(Number(await storedWidth(page)), 600, 6), "stored preference untouched throughout", await storedWidth(page));
  const allWrites = await widthWrites(page);
  assert(allWrites.length === 0, "still ZERO width writes across both viewport changes", `${allWrites.length}`);

  // --- and it survives a reload (the preference was never corrupted) ---
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(HANDLE, { state: "visible", timeout: 30000 });
  const afterReload = await settledWidth(page);
  assert(near(afterReload, 600, 6), "after reload the sidebar renders the preserved ~600", `${Math.round(afterReload)}px`);

  await ctx.close();
}

async function c4NoListenerLeak(browser) {
  log("\n----- C4 (B2): stuck drag then a normal drag — no leaked listeners -----");
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await setup(page, { clearWidth: true });
  await resetLog(page);

  // --- drag A, left STUCK (lost capture, no pointerup) ---
  const c = await startDragToWidth(page, 480);
  await dispatchAtHandle(page, "lostpointercapture");
  await page.waitForTimeout(100);
  const afterA = await widthWrites(page);
  assert(afterA.length === 1, "drag A (stuck) persisted exactly once", `${afterA.length}`);
  await page.mouse.up(); // release the harness's button state
  await page.waitForTimeout(60);
  await resetLog(page);

  // --- drag B, a full normal drag ---
  await startDragToWidth(page, 560);
  const midB = await renderedWidth(page);
  assert(midB > 500, "drag B is tracking the pointer", `${Math.round(midB)}px`);
  await page.mouse.up();
  await page.waitForTimeout(120);

  const afterB = await widthWrites(page);
  assert(afterB.length === 1,
    "drag B's release produced exactly ONE write (a leaked drag-A onEnd would make 2)",
    `${afterB.length}: ${JSON.stringify(afterB.map((w) => w.value))}`);

  const styles = await bodyStyles(page);
  assert(styles.userSelect === "" && styles.cursor === "", "body styles clean after drag B");

  const t = await widthTracksBareMoves(page, c.y);
  assert(!t.tracked, "after drag B, bare pointermoves change nothing (drag A's onMove is gone)",
    `rendered ${Math.round(t.before)}->${Math.round(t.after)}`);

  // --- a third clean drag, to show writes stay 1:1 with completed drags ---
  await resetLog(page);
  await startDragToWidth(page, 420);
  await page.mouse.up();
  await page.waitForTimeout(120);
  const afterC = await widthWrites(page);
  assert(afterC.length === 1, "drag C also persisted exactly once (writes stay 1:1 with drags)", `${afterC.length}`);
  const t2 = await widthTracksBareMoves(page, c.y);
  assert(!t2.tracked, "after drag C, bare pointermoves still change nothing");

  await ctx.close();
}

async function c5DblClickWithCapture(browser) {
  log("\n----- C5: dblclick reset still works WITH pointer capture; zero-move drag keeps the preference -----");
  // Viewport 900 => max 450, stored preference 600: the exact shape where a
  // zero-movement pointerdown/up could downgrade 600 -> 450.
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await ctx.newPage();
  await setup(page, { seedWidth: 600 });
  await resetLog(page);

  const start = await settledWidth(page);
  assert(near(start, 450, 4), "stored 600 renders clamped to 450 at a 900px viewport", `${Math.round(start)}px`);
  assert((await storedWidth(page)) === "600", "stored preference still 600 on load (mount read does not persist)", await storedWidth(page));

  // --- part 1: a bare zero-movement pointerdown/up (what a dblclick emits first) ---
  const c = await handleCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(120);

  const zeroMoveWrites = await widthWrites(page);
  assert(zeroMoveWrites.length === 1, "the zero-movement press persisted once", `${zeroMoveWrites.length}`);
  assert((await storedWidth(page)) === "600",
    "zero-movement press did NOT downgrade the stored 600 to the clamped 450", await storedWidth(page));
  assert(near(await settledWidth(page), 450, 4), "rendered width still the clamped 450 after the press");

  // --- part 2: the real dblclick reset, with capture active ---
  await resetLog(page);
  await page.locator(HANDLE).dblclick();
  await page.waitForTimeout(200);

  const reset = await settledWidth(page);
  assert(near(reset, DEFAULT_WIDTH, 4), "dblclick reset the RENDERED width to 288 (capture did not break dblclick)", `${Math.round(reset)}px`);
  assert((await storedWidth(page)) === String(DEFAULT_WIDTH), "dblclick persisted 288", await storedWidth(page));
  assert(near(await aria(page, "aria-valuenow"), DEFAULT_WIDTH, 2), "aria-valuenow reports 288", `${await aria(page, "aria-valuenow")}`);

  const styles = await bodyStyles(page);
  assert(styles.userSelect === "" && styles.cursor === "", "body styles clean after the dblclick");

  // --- part 3: the reset survives widening (288 is the preference now, not 600) ---
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(200);
  const wide = await settledWidth(page);
  assert(near(wide, DEFAULT_WIDTH, 4), "after widening, width stays 288 — the reset replaced the 600 preference", `${Math.round(wide)}px`);

  await ctx.close();
}

async function screenshotWide(browser) {
  log("\n----- screenshot: sidebar dragged wide, dark mode -----");
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await setup(page, { clearWidth: true });
  await startDragToWidth(page, 600);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const w = await renderedWidth(page);
  const out = "docs/evidence/TEAM-4331/sidebar-resized-dark.png";
  await page.screenshot({ path: out, fullPage: false });
  log(`  saved ${out} (sidebar rendered at ${Math.round(w)}px, theme=dark)`);
  await ctx.close();
}

// ------------------------------------------------------------------------ main

const WANT = process.argv.filter((a) => /^--case=/.test(a)).map((a) => a.split("=")[1]);
const wants = (id) => WANT.length === 0 || WANT.includes(id);

const browser = await chromium.launch();
log(`===== TEAM-4331 resize-lifecycle probe against ${BASE_URL} =====`);
if (LABEL) log(`label: ${LABEL}`);
log(`chromium: ${browser.version()}`);

try {
  if (wants("c1")) await c1LostCapture(browser);
  if (wants("c2")) await c2PointerCancel(browser);
  if (wants("c3")) await c3ViewportPreference(browser);
  if (wants("c4")) await c4NoListenerLeak(browser);
  if (wants("c5")) await c5DblClickWithCapture(browser);
  if (process.argv.includes("--screenshot")) await screenshotWide(browser);
} finally {
  await browser.close();
}

log(`\n===== ${failures === 0 ? "ALL ASSERTIONS PASSED" : `${failures} ASSERTION(S) FAILED`} =====`);
process.exit(failures === 0 ? 0 : 1);
