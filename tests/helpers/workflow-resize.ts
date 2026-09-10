/**
 * TEAM-4332 — fixtures + helpers for tests/tab-workflow-resize.spec.ts.
 *
 * Deliberately NOT named *.spec.ts: playwright.config.ts sets testDir "./tests"
 * with the default testMatch, so this file is never collected as a test. It IS
 * type-checked (tsconfig include: "**\/*.ts"), which is why the window
 * augmentation for __setItemLog lives here.
 *
 * Everything the spec measures is hermetic: every **\/api\/** request is
 * intercepted, so the suite needs no AWS credentials and no ambient local data,
 * and it can run in CI on every PR.
 *
 * The drag/lifecycle helpers below are ported from TEAM-4331's live probe
 * (docs/evidence/TEAM-4331/verify-resize-lifecycle.mjs) rather than re-derived,
 * so the ported cases prove the same thing that ticket's evidence proved.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export const SCREENSHOT_DIR = "playwright-screenshots/workflow-resize";
export const HANDLE = "[role='separator'][aria-label='Resize workflows sidebar']";
export const LIST = "[data-testid=workflow-history-list]";
export const WIDTH_KEY = "workflow-history-width";

export const DEFAULT_WIDTH = 288;
export const MIN_WIDTH = 240;
export const MAX_CEILING = 640;
export const KEY_STEP = 16;

/** Design tokens the scrollbar assertions pin (src/styles/globals.css). */
export const TOKENS = {
  dark: { thumb: [42, 42, 58] as RGB, surface1: [18, 18, 26] as RGB },
  light: { thumb: [206, 212, 218] as RGB, surface1: [241, 243, 245] as RGB },
};

export type RGB = [number, number, number];

declare global {
  interface Window {
    __setItemLog: { key: string; value: string }[];
  }
}

// ───────────────────────────────────────────────────────────────── fixture rows

/** Shape of one row of GET /api/workflow/list — mirrors the page's private
 *  WorkflowSummary interface (src/app/workflow/page.tsx:28, not exported). */
export interface FixtureRow {
  id: string;
  workflowId: string;
  phase: string;
  epicId: string;
  input: { title: string; description: string };
  startedAt: string;
  completedAt: string;
  workflowType: "feature" | "bug";
  workflowDefId: string;
  sdlcFramework: "playbook" | "aidlc";
}

/**
 * Deterministic prose filler. Real words of mixed length, so the measured text
 * metrics are representative rather than a monospace-ish run of one glyph.
 */
const WORDS = [
  "Refactor", "the", "workflow", "sidebar", "resize", "handle", "and",
  "persist", "width", "across", "reloads", "for", "operators",
];

export function titleOfLength(n: number): string {
  let s = "";
  let i = 0;
  while (s.length < n) {
    s += (s ? " " : "") + WORDS[i % WORDS.length];
    i++;
  }
  return s.slice(0, n).trimEnd().padEnd(n, "x");
}

/**
 * Title lengths are MEASURED, not guessed — see
 * docs/evidence/TEAM-4332/step0-empirical-checks.md. Under the launch config
 * this spec uses (a real 6px scrollbar gutter is reserved, so the title's
 * available width is 6px narrower than it would otherwise be):
 *
 *   length | scrollWidth | avail@288 | avail@640 | verdict
 *      30  |     189px   |   223px   |   575px   | fits everywhere (control row)
 *      65  |     393px   |   223px   |   575px   | CLIPPED at 288 by 170px,
 *          |             |           |           | FITS at 640 with 182px spare
 *     300  |    1823px   |   223px   |   575px   | clipped at EVERY width
 *
 * 65 maximises the smaller of the two margins (170 / 182), so the reveal is
 * ~170px clear of the clip boundary in both directions and cannot flip on a
 * small font-metric drift between local and CI.
 */
export const SHORT_TITLE = titleOfLength(30);
export const MEDIUM_TITLE = titleOfLength(65);
export const ABSURD_TITLE = titleOfLength(300);

function row(id: string, title: string, i: number): FixtureRow {
  return {
    id,
    workflowId: id,
    // "complete" ⇒ isTerminalPhase ⇒ the row lands in "Completed" and renders a
    // stable Archive + Delete pair, which is what makes the Tab order in Group C
    // deterministic (exactly 2 tabbables per row).
    phase: "complete",
    epicId: `TEAM-4${String(400 + i).padStart(3, "0")}`,
    input: { title, description: "TEAM-4332 fixture row" },
    startedAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5) - i * 3600_000).toISOString(),
    completedAt: new Date(Date.UTC(2026, 0, 2, 4, 4, 5) - i * 3600_000).toISOString(),
    workflowType: "feature",
    workflowDefId: "sdlc-v1",
    sdlcFramework: "playbook",
  };
}

export function makeRows(titles: string[]): FixtureRow[] {
  return titles.map((t, i) => row(`wf-t4332-${i}`, t, i));
}

/** Two rows — the smallest fixture that still exercises the Tab chain (Group C). */
export const SMALL_ROWS = makeRows([SHORT_TITLE, "Second row"]);

/**
 * ~40 rows so the list provably overflows vertically and therefore actually
 * reserves a scrollbar gutter (Group A). Without overflow there is no gutter to
 * measure and the whole of R1.4 would be untestable.
 */
export const OVERFLOW_ROWS = makeRows(
  Array.from({ length: 40 }, (_, i) => `Fleet run ${i + 1} — nightly regression sweep`)
);

/**
 * Short + MEDIUM + ABSURD, padded to 18 rows so the list still overflows (Group
 * D). The overflow matters twice: it keeps the 6px gutter reserved (so the
 * title widths below match the calibration table above) and it is the condition
 * under which a horizontal scrollbar would actually appear.
 */
export const LONG_ROWS = makeRows([
  SHORT_TITLE,
  MEDIUM_TITLE,
  ABSURD_TITLE,
  ...Array.from({ length: 15 }, (_, i) => `Filler run ${i + 1}`),
]);

// ───────────────────────────────────────────────────────────────────── the setup

export interface SetupOptions {
  rows: FixtureRow[];
  clearWidth?: boolean;
  seedWidth?: number;
  theme?: "dark" | "light";
}

/** A minimal but WELL-FORMED FleetView. PerformanceCard renders
 *  `view.totals.runs` unguarded (src/components/workflow/PerformanceCard.tsx),
 *  so fulfilling this route with a bare {} throws during render and blanks the
 *  whole page — every assertion in the file would then fail for the wrong
 *  reason. totals.runs === 0 short-circuits before agents/runs/anomalies. */
const FLEET_VIEW = {
  status: "insufficient",
  generatedAt: "2026-01-02T00:00:00.000Z",
  totals: { runs: 0, cost: 0, tokens: 0, durationMs: 0 },
  kpis: [],
  agents: [],
  runs: [],
  anomalies: [],
};

export async function setup(page: Page, opts: SetupOptions): Promise<void> {
  const theme = opts.theme ?? "dark";

  // Playwright matches route handlers in REVERSE registration order, so the
  // catch-all MUST be registered FIRST or it shadows every specific handler
  // below it (which is how the /api/workflow/performance fixture gets lost and
  // the page blanks). Registration order here is load-bearing.
  await page.route("**/api/**", (r) => r.fulfill({ json: { items: [] } }));
  await page.route("**/api/workflow/list*", (r) =>
    r.fulfill({ json: { workflows: opts.rows } })
  );
  await page.route("**/api/workflow/performance*", (r) => r.fulfill({ json: FLEET_VIEW }));
  // current: null so Header does not incidentally write localStorage["aws-region"].
  await page.route("**/api/agentcore/region*", (r) =>
    r.fulfill({ json: { available: [], current: null } })
  );

  await page.addInitScript(
    (o: { theme: string; clearWidth?: boolean; seedWidth?: number }) => {
      // Instrument EVERY write before the app can make one. Assertions count
      // writes rather than compare the final stored value, because TEAM-4331's
      // listener leak wrote the same value twice — a value-only check passes on
      // the broken code.
      window.__setItemLog = [];
      const raw = Storage.prototype.setItem;
      Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
        window.__setItemLog.push({ key: String(k), value: String(v) });
        return raw.call(this, k, v);
      };

      localStorage.setItem("theme", o.theme);
      localStorage.setItem("workflow-history-collapsed", "false");
      localStorage.setItem("sidebar-collapsed", "false");

      // The width seed/clear must apply to the FIRST load only: addInitScript
      // re-runs on every navigation, so an unguarded clearWidth would delete a
      // dragged width before a reloaded app could read it, making any
      // post-reload assertion meaningless. sessionStorage survives a reload in
      // the same tab, so it is the right sentinel.
      if (!sessionStorage.getItem("__t4332_width_seeded")) {
        sessionStorage.setItem("__t4332_width_seeded", "1");
        if (o.clearWidth) localStorage.removeItem("workflow-history-width");
        else if (typeof o.seedWidth === "number") {
          localStorage.setItem("workflow-history-width", String(o.seedWidth));
        }
      }
    },
    { theme, clearWidth: opts.clearWidth, seedWidth: opts.seedWidth }
  );

  // NOT networkidle: /workflow polls on a 5s timer, so networkidle is never
  // reliably reached. domcontentloaded + an explicit wait for the handle is both
  // faster and deterministic.
  await page.goto("/workflow", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(HANDLE, { state: "visible" });
  // The sidebar mounts COLLAPSED (w-8) and animates to its expanded width over
  // `transition-all duration-300` once the effect reads localStorage. Grabbing
  // the handle mid-animation makes pointerdown miss the 4px strip entirely.
  await settledWidth(page);
  await resetLog(page);
}

// ────────────────────────────────────────────────────── localStorage write log

export const resetLog = (page: Page): Promise<void> =>
  page.evaluate(() => {
    window.__setItemLog = [];
  });

export const widthWrites = (page: Page): Promise<{ key: string; value: string }[]> =>
  page.evaluate((k) => window.__setItemLog.filter((e) => e.key === k), WIDTH_KEY);

export const storedWidth = (page: Page): Promise<string | null> =>
  page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY);

// ───────────────────────────────────────────────────────── geometry / lifecycle
// Ported from docs/evidence/TEAM-4331/verify-resize-lifecycle.mjs.

export const near = (a: number, b: number, tol = 2): boolean => Math.abs(a - b) <= tol;

/** The sidebar element = the handle's parent (do not couple to DOM shape). */
export const sidebar = (page: Page): Locator => page.locator(HANDLE).locator("xpath=..");

export async function renderedWidth(page: Page): Promise<number> {
  const box = await sidebar(page).boundingBox();
  return box?.width ?? 0;
}

/** `transition-all duration-300` animates non-drag width changes; poll to settle. */
export async function settledWidth(page: Page, timeout = 2500): Promise<number> {
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

export const aria = async (page: Page, attr: string): Promise<number> =>
  Number(await page.locator(HANDLE).getAttribute(attr));

/** Body styles the drag mutates globally — the heart of the B1 acceptance. */
export const bodyStyles = (page: Page): Promise<{ userSelect: string; cursor: string }> =>
  page.evaluate(() => ({
    userSelect: document.body.style.userSelect,
    cursor: document.body.style.cursor,
  }));

/**
 * `isResizing` suppresses the container's `transition-all` class while dragging,
 * so its absence is an observable proxy for "React thinks the drag is over".
 */
export async function isResizingVisualState(page: Page): Promise<boolean> {
  const cls = (await sidebar(page).getAttribute("class")) || "";
  return !cls.includes("transition-all"); // true == still mid-drag
}

export async function handleCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator(HANDLE).boundingBox();
  if (!box) throw new Error("resize handle has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * The sidebar's left edge in viewport coords. The app's left nav offsets it
 * (~256px) and the page uses a `-m-6` negative margin, so a drag target must be
 * expressed as sidebarLeft + desiredWidth, never as a bare screen x.
 */
export async function sidebarLeft(page: Page): Promise<number> {
  const box = await sidebar(page).boundingBox();
  if (!box) throw new Error("sidebar has no bounding box");
  return box.x;
}

/** Dispatch a real PointerEvent at the handle (the capture target).
 *
 *  Playwright's input API cannot move the OS cursor outside the page, so a
 *  literal out-of-window mouse release is unreachable from a script.
 *  `lostpointercapture` is the exact event the browser fires at the capture
 *  element in that situation, so dispatching it with NO pointerup is strictly
 *  the harder case. Same reasoning for `pointercancel`. */
export function dispatchAtHandle(page: Page, type: string): Promise<void> {
  return page.evaluate(
    ({ sel, t }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error("handle not found for dispatch");
      el.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: false, pointerId: 1 }));
    },
    { sel: HANDLE, t: type }
  );
}

/**
 * Direct PointerEvent dispatch for a second/subsequent drag in the SAME test.
 * A real page.mouse pointerdown requires hitting the handle's 4px-wide strip,
 * whose position is a moving target once a prior drag (possibly still leaking a
 * listener) has repositioned it — geometry that is fragile to reproduce with
 * Playwright's mouse and irrelevant to the logic under test. Dispatching the
 * PointerEvent directly on the handle (bubbles:true reaches React's synthetic
 * delegation exactly as a real event would) tests the state-machine logic
 * deterministically, independent of hit-testing.
 *
 * A dispatched (not real-input) event is processed by React at a lower scheduler
 * priority than a genuine OS-level event, so the DOM does not necessarily
 * reflect the resulting state update by the time the dispatching evaluate()
 * resolves. Each helper waits one tick past dispatch so every call site gets an
 * already-flushed DOM to read next.
 */
export async function dispatchPointerDownAtHandle(
  page: Page,
  clientX: number,
  clientY: number,
  pointerId = 1
): Promise<void> {
  await page.evaluate(
    ({ sel, x, y, id }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error("handle not found for dispatch");
      el.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true, cancelable: true, pointerId: id,
          clientX: x, clientY: y, button: 0, buttons: 1, pointerType: "mouse",
        })
      );
    },
    { sel: HANDLE, x: clientX, y: clientY, id: pointerId }
  );
  await page.waitForTimeout(40);
}

export async function dispatchWindowPointer(
  page: Page,
  type: string,
  clientX: number,
  clientY: number,
  pointerId = 1
): Promise<void> {
  await page.evaluate(
    ({ t, x, y, id }) => {
      window.dispatchEvent(
        new PointerEvent(t, {
          bubbles: true, cancelable: true, pointerId: id,
          clientX: x, clientY: y, buttons: t === "pointerup" ? 0 : 1, pointerType: "mouse",
        })
      );
    },
    { t: type, x: clientX, y: clientY, id: pointerId }
  );
  await page.waitForTimeout(40);
}

/** pointerdown on the handle + N real pointermoves until the sidebar is
 *  `targetWidth` wide. Returns the drag origin and the sidebar's left edge. */
export async function startDragToWidth(
  page: Page,
  targetWidth: number
): Promise<{ x: number; y: number; left: number }> {
  const left = await sidebarLeft(page);
  const c = await handleCenter(page);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  // steps required for React to see intermediate pointermoves
  await page.mouse.move(left + targetWidth, c.y, { steps: 12 });
  return { ...c, left };
}

/**
 * Move the bare pointer (no button semantics that matter — the point is that a
 * torn-down drag must ignore these) and report whether the width followed. The
 * targets map to widths clearly different from the current one, so a still-live
 * onMove would visibly change the width.
 */
export async function widthTracksBareMoves(
  page: Page,
  y: number
): Promise<{ tracked: boolean; before: number; after: number; beforeAria: number; afterAria: number }> {
  const left = await sidebarLeft(page);
  // SETTLED, not instantaneous. Ending a drag clears `isResizing`, which
  // re-enables `transition-all duration-300`, so a bare renderedWidth() sampled
  // right after the interruption catches the box mid-transition and reads a few
  // px off the logical width — that is the transition finishing, not a leaked
  // move handler, and comparing it against a later settled sample reports a
  // false positive.
  const before = await settledWidth(page);
  const beforeAria = await aria(page, "aria-valuenow");
  for (const w of [before - 120, before + 90, MIN_WIDTH + 20]) {
    await page.mouse.move(left + w, y, { steps: 4 });
    await page.waitForTimeout(30);
  }
  const after = await settledWidth(page);
  const afterAria = await aria(page, "aria-valuenow");
  // A leaked handler moves BOTH channels (the targets above are 90-240px away
  // from the current width), so either one flipping is enough to fail.
  return {
    tracked: !near(after, before, 3) || !near(afterAria, beforeAria, 1),
    before, after, beforeAria, afterAria,
  };
}

// ──────────────────────────────────────────────────────────── keyboard (R2.9)

/**
 * Focus the handle and press `key` n times, returning aria-valuenow observed
 * after EVERY press. The intermediate values are what make "never goes below
 * the floor at any step" checkable rather than just the endpoint.
 */
export async function pressKey(page: Page, key: string, n: number): Promise<number[]> {
  await page.locator(HANDLE).focus();
  const seen: number[] = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(key);
    seen.push(await aria(page, "aria-valuenow"));
  }
  await page.waitForTimeout(120);
  return seen;
}

/**
 * Tab from the search input until the resize handle has focus, bounded. Returns
 * the number of presses and the trail. Uses real Tab presses, not .focus(),
 * because R2.9's requirement is keyboard REACHABILITY, and .focus() would pass
 * even on an element removed from the tab order.
 */
export async function tabToHandle(
  page: Page,
  max = 25
): Promise<{ tabs: number; trail: string[] }> {
  await page.locator('input[placeholder="Search epics..."]').click();
  const trail: string[] = [];
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const a = document.activeElement;
      return {
        tag: a?.tagName ?? "?",
        role: a?.getAttribute("role") ?? "-",
        label: a?.getAttribute("aria-label") ?? a?.getAttribute("title") ?? "-",
      };
    });
    trail.push(`${i}:${info.tag}/${info.role}/${info.label}`);
    if (info.role === "separator" && info.label === "Resize workflows sidebar") {
      return { tabs: i, trail };
    }
  }
  return { tabs: -1, trail };
}

// ──────────────────────────────────────────────────────── scrollbar geometry

/** Reserved scrollbar gutter of a scroll container, in CSS px. */
export const gutterOf = (locator: Locator): Promise<number> =>
  locator.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth);

export const listMetrics = (locator: Locator) =>
  locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    const wk = (pseudo: string) => getComputedStyle(el, pseudo);
    return {
      gutter: (el as HTMLElement).offsetWidth - el.clientWidth,
      offsetWidth: (el as HTMLElement).offsetWidth,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowsVertically: el.scrollHeight > el.clientHeight,
      noHorizontalScroll: el.scrollWidth <= el.clientWidth,
      scrollbarWidth: cs.scrollbarWidth,
      scrollbarColor: cs.scrollbarColor,
      wkWidth: wk("::-webkit-scrollbar").width,
      wkHeight: wk("::-webkit-scrollbar").height,
      wkThumbBg: wk("::-webkit-scrollbar-thumb").backgroundColor,
      wkThumbRadius: wk("::-webkit-scrollbar-thumb").borderRadius,
      wkTrackBg: wk("::-webkit-scrollbar-track").backgroundColor,
      wkButtonDisplay: wk("::-webkit-scrollbar-button").display,
      supportsWebkitSelector: CSS.supports("selector(::-webkit-scrollbar)"),
    };
  });

/**
 * Inject a forced-overflow scroller that opts BACK IN to the standard
 * `scrollbar-width: thin` path — i.e. exactly the state the app was in before
 * TEAM-4330. It is the in-page control for the gutter ladder: it must report a
 * different (wider) gutter than the app's own container.
 *
 * The style is INLINE rather than the `.scrollbar-thin` utility class so the
 * control cannot be perturbed by Tailwind's purge behaviour.
 */
export async function injectThinControl(page: Page, thumb: string): Promise<Locator> {
  await page.evaluate((t) => {
    document.getElementById("__t4332_thin")?.remove();
    const d = document.createElement("div");
    d.id = "__t4332_thin";
    d.setAttribute(
      "style",
      "position:fixed;left:0;bottom:0;width:200px;height:120px;overflow-y:scroll;" +
        `scrollbar-width:thin;scrollbar-color:${t} transparent;z-index:99999`
    );
    d.innerHTML = '<div style="height:2000px"></div>';
    document.body.appendChild(d);
  }, thumb);
  return page.locator("#__t4332_thin");
}

/**
 * The platform's NATIVE gutter, measured on a bare page with no author
 * scrollbar CSS at all. It cannot be measured on /workflow: globals.css applies
 * its rules via `*`, so every element there is already styled. A second page in
 * the same context keeps the app page intact.
 */
export async function nativeGutter(page: Page): Promise<number> {
  const bare = await page.context().newPage();
  await bare.setContent(
    `<style>html,body{margin:0}#n{width:200px;height:120px;overflow-y:scroll}</style>
     <div id="n"><div style="height:2000px"></div></div>`
  );
  const g = await bare.$eval("#n", (el) => (el as HTMLElement).offsetWidth - el.clientWidth);
  await bare.close();
  return g;
}

// ─────────────────────────────────────────────────────────── pixel decode (R1.5)

export interface StripAnalysis {
  dims: { width: number; height: number };
  palette: [string, number][];
  anyNearWhite: boolean;
  thumbTokenPixels: number;
  /** Any thumb-token pixel within the first `edgeRows` rows. With scrollTop 0 the
   *  thumb sits flush at the top ONLY when ::-webkit-scrollbar-button is honoured;
   *  the standard thin scrollbar insets it behind arrow-button chrome. */
  topRowsHaveThumb: boolean;
  /** Every pixel in the last `edgeRows` rows is plain container background —
   *  i.e. no bottom arrow-button chrome. */
  bottomRowsAllBackground: boolean;
  firstRows: string[][];
  lastRows: string[][];
}

/**
 * Decode the rightmost `gutterPx` strip of `locator` and describe it.
 *
 * No new dependency and no PNG decoder: screenshot -> base64 data URL ->
 * new Image() -> canvas -> getImageData, all inside page.evaluate.
 */
export async function analyseGutterStrip(
  page: Page,
  locator: Locator,
  opts: {
    gutterPx: number;
    thumb: RGB;
    background: RGB;
    edgeRows?: number;
    tol?: number;
    /** Also write the decoded strip to disk, as committable evidence. */
    savePath?: string;
  }
): Promise<StripAnalysis> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("scroll container has no bounding box");
  const buf = await page.screenshot({
    clip: {
      x: Math.round(box.x + box.width - opts.gutterPx),
      y: Math.round(box.y),
      width: opts.gutterPx,
      height: Math.round(box.height),
    },
    ...(opts.savePath ? { path: opts.savePath } : {}),
  });
  const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  return await page.evaluate(
    async ({ url, thumb, background, edgeRows, tol }) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const rows: number[][][] = [];
      const palette = new Map<string, number>();
      for (let y = 0; y < height; y++) {
        const px: number[][] = [];
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const p = [data[i], data[i + 1], data[i + 2]];
          px.push(p);
          const k = p.join(",");
          palette.set(k, (palette.get(k) || 0) + 1);
        }
        rows.push(px);
      }
      const isNear = (p: number[], c: number[]) =>
        Math.abs(p[0] - c[0]) <= tol && Math.abs(p[1] - c[1]) <= tol && Math.abs(p[2] - c[2]) <= tol;
      const flat = rows.flat();

      return {
        dims: { width, height },
        palette: [...palette.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
        anyNearWhite: flat.some((p) => p[0] >= 235 && p[1] >= 235 && p[2] >= 235),
        thumbTokenPixels: flat.filter((p) => isNear(p, thumb)).length,
        topRowsHaveThumb: rows.slice(0, edgeRows).some((r) => r.some((p) => isNear(p, thumb))),
        bottomRowsAllBackground: rows
          .slice(-edgeRows)
          .every((r) => r.every((p) => isNear(p, background))),
        firstRows: rows.slice(0, 3).map((r) => r.map((p) => p.join(","))),
        lastRows: rows.slice(-3).map((r) => r.map((p) => p.join(","))),
      };
    },
    {
      url: dataUrl,
      thumb: opts.thumb as number[],
      background: opts.background as number[],
      edgeRows: opts.edgeRows ?? 4,
      tol: opts.tol ?? 6,
    }
  );
}

// ─────────────────────────────────────────────────────────── title metrics (R2.8)

export interface TitleMetric {
  text: string;
  clientWidth: number;
  scrollWidth: number;
  /** The width actually AVAILABLE to the title — its flex parent's content box.
   *  A `truncate` <p> shrinks to its content when the text fits, so
   *  clientWidth - scrollWidth is 0 whenever it is NOT clipped and cannot
   *  express headroom. The parent is the only honest denominator. */
  availableWidth: number;
  clipped: boolean;
  /** >0 when clipped: how many px are hidden. */
  clippedBy: number;
  /** >0 when it fits: how many px of the available width are still free. */
  headroom: number;
}

/**
 * Metrics for the title whose textContent is EXACTLY `text`.
 *
 * Exact match, not Playwright's substring `hasText`: the calibrated 65-char
 * MEDIUM_TITLE is cut mid-word ("...width acr") and so IS a substring of the
 * 300-char ABSURD_TITLE ("...width across..."), which a `hasText` filter would
 * silently match as well.
 */
export async function titleMetric(page: Page, text: string): Promise<TitleMetric> {
  await page.evaluate(() => document.fonts.ready);
  // Deliberately `p`, NOT `p.truncate`: selecting on the class under test makes
  // the element merely *disappear* when `truncate` is removed, so D1 would fail
  // with "not found" instead of on the measured clip margin — it would be proving
  // the class string exists, not that the title is actually being clipped.
  // Matching every title <p> and picking by exact textContent keeps the element
  // findable in BOTH states, so the failure is the real behavioural consequence:
  // a wrapping <p> has scrollWidth === clientWidth, hence clippedBy 0.
  const m = await page.locator(`${LIST} p`).evaluateAll((els, wanted) => {
    const el = els.find((e) => (e.textContent || "") === wanted);
    if (!el) {
      throw new Error(
        `no title <p> with exact text (len ${wanted.length}); saw lengths ` +
          `[${els.map((e) => (e.textContent || "").length).join(",")}]`
      );
    }
    const parent = el.parentElement;
    if (!parent) throw new Error("title <p> has no parent");
    return {
      text: el.textContent || "",
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      availableWidth: parent.clientWidth,
    };
  }, text);
  return {
    ...m,
    clipped: m.scrollWidth > m.clientWidth,
    clippedBy: Math.max(0, m.scrollWidth - m.availableWidth),
    headroom: Math.max(0, m.availableWidth - m.scrollWidth),
  };
}

/**
 * Drive the sidebar to an EXACT width with the keyboard rather than a drag, so
 * the width under test carries no sub-pixel drag arithmetic.
 *
 * `extraPresses` is only ever non-zero for a target that IS a clamp bound,
 * where overshooting is pinned. Overshooting a NON-bound target would sail past
 * it, so the press count is otherwise exact and 240/288/640 are all a whole
 * number of 16px steps apart.
 */
export async function keyboardToWidth(
  page: Page,
  target: number,
  extraPresses = 0
): Promise<void> {
  const start = await aria(page, "aria-valuenow");
  const delta = target - start;
  const steps = Math.abs(delta) / KEY_STEP;
  if (extraPresses === 0 && !Number.isInteger(steps)) {
    throw new Error(`${start} -> ${target} is not a whole number of ${KEY_STEP}px steps`);
  }
  if (delta !== 0) {
    await pressKey(page, delta > 0 ? "ArrowRight" : "ArrowLeft", Math.ceil(steps) + extraPresses);
  }
  expect(await aria(page, "aria-valuenow")).toBe(target);
  await settledWidth(page);
}
