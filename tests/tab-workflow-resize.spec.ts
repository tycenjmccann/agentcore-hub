import { test, expect, type Page } from "@playwright/test";

/**
 * TEAM-4316 — drag-to-resize workflows-history sidebar + global dark scrollbars.
 *
 * Chrome-only assertions (handle + container + list container) so they do not
 * flake on an empty/remote workflow list. Case 6 (truncation reveal) needs a
 * long-titled workflow in the data and test.skip()s gracefully otherwise.
 *
 * Dark mode + expanded sidebar are seeded via addInitScript BEFORE navigation
 * (layout.tsx reads localStorage.theme and sets data-theme on documentElement).
 *
 * Run: npx playwright test tests/tab-workflow-resize.spec.ts
 */

const SCREENSHOT_DIR = "playwright-screenshots/workflow-resize";
const HANDLE = "[role='separator'][aria-label='Resize workflows sidebar']";

// Parameterized setup. The init script ALWAYS seeds theme + collapsed=false.
// It only touches the width key when explicitly asked (clearWidth / seedWidth),
// so a width written by a drag survives page.reload() when no option is passed.
async function setup(
  page: Page,
  opts: { clearWidth?: boolean; seedWidth?: number } = {}
) {
  await page.addInitScript((o) => {
    localStorage.setItem("theme", "dark");
    localStorage.setItem("workflow-history-collapsed", "false");
    if (o.clearWidth) localStorage.removeItem("workflow-history-width");
    else if (typeof o.seedWidth === "number") {
      localStorage.setItem("workflow-history-width", String(o.seedWidth));
    }
    // When neither option is given the width key is left ENTIRELY untouched.
  }, opts);
  await page.goto("/workflow");
  await page.waitForLoadState("networkidle");
  await expect(page.locator(HANDLE)).toBeVisible();
}

// Sidebar container = the handle's parent. Measure by boundingBox so we do not
// couple to DOM shape. The container animates width via `transition-all` between
// drags, so callers that need a settled value should poll (see settledWidth).
async function sidebarWidth(page: Page): Promise<number> {
  const box = await page.locator(HANDLE).locator("xpath=..").boundingBox();
  return box?.width ?? 0;
}

// The handle's aria-valuenow tracks React state synchronously (no 300ms CSS
// animation lag), so it is the reliable source of the *logical* width.
async function ariaWidth(page: Page): Promise<number> {
  const v = await page.locator(HANDLE).getAttribute("aria-valuenow");
  return Number(v);
}

// Poll the rendered boundingBox until the width transition settles near target.
async function expectSettledWidth(page: Page, target: number, tol = 2) {
  await expect.poll(async () => Math.abs((await sidebarWidth(page)) - target) <= tol, {
    timeout: 2000,
  }).toBe(true);
}

async function handleCenter(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator(HANDLE).boundingBox();
  if (!box) throw new Error("resize handle has no bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe("Workflow sidebar resize (TEAM-4316)", () => {
  test("1: default expanded width is 288px", async ({ page }) => {
    await setup(page, { clearWidth: true });
    expect(Math.abs((await ariaWidth(page)) - 288)).toBeLessThanOrEqual(1);
    await expectSettledWidth(page, 288);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-default.png`, fullPage: true });
  });

  test("2: dragging the handle right widens >= 400px and survives reload", async ({ page }) => {
    await setup(page); // no width option → key untouched on reload
    const c = await handleCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 180, c.y, { steps: 10 }); // steps required for React to see pointermoves
    await page.mouse.up();

    // Logical width (state) updates synchronously; no drag transition to wait on.
    expect(await ariaWidth(page)).toBeGreaterThanOrEqual(400);
    // And the rendered box (drag suppresses the transition, so it's immediate).
    expect(await sidebarWidth(page)).toBeGreaterThanOrEqual(400);

    const persisted = await page.evaluate(() => localStorage.getItem("workflow-history-width"));
    expect(Number(persisted)).toBeGreaterThanOrEqual(400);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/02-dragged-wide.png`, fullPage: true });

    await page.reload();
    await expect(page.locator(HANDLE)).toBeVisible();
    // After reload the width is applied post-mount then animates in; assert the
    // logical value immediately and poll the rendered box until it settles.
    expect(await ariaWidth(page)).toBeGreaterThanOrEqual(400);
    await expect.poll(async () => Math.round(await sidebarWidth(page)), { timeout: 2000 })
      .toBeGreaterThanOrEqual(400);
  });

  test("3: double-click on the handle resets to 288px", async ({ page }) => {
    await setup(page, { clearWidth: true });
    // Widen first so the reset is observable.
    const c = await handleCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 160, c.y, { steps: 10 });
    await page.mouse.up();
    expect(await ariaWidth(page)).toBeGreaterThanOrEqual(400);

    await page.locator(HANDLE).dblclick();

    // Logical reset is synchronous; the rendered box animates 465→288.
    expect(Math.abs((await ariaWidth(page)) - 288)).toBeLessThanOrEqual(1);
    const persisted = await page.evaluate(() => localStorage.getItem("workflow-history-width"));
    expect(persisted).toBe("288");
    await expectSettledWidth(page, 288);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/03-reset.png`, fullPage: true });
  });

  test("4: collapse then expand restores the persisted (wide) width, not 288", async ({ page }) => {
    await setup(page, { seedWidth: 420 });
    expect(Math.abs((await ariaWidth(page)) - 420)).toBeLessThanOrEqual(1);

    await page.locator("button[aria-label='Collapse workflow history sidebar']").click();
    await page.waitForTimeout(400); // let the collapse transition settle
    await page.locator("button[aria-label='Expand workflow history sidebar']").click();
    await expect(page.locator(HANDLE)).toBeVisible();
    await page.waitForTimeout(400); // let the expand transition settle

    // Restored logical width is the persisted 420, explicitly not the 288 default.
    expect(Math.abs((await ariaWidth(page)) - 420)).toBeLessThanOrEqual(1);
    await expectSettledWidth(page, 420);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/04-restore.png`, fullPage: true });
  });

  test("5: scrollbar styling — thin + 6px webkit width (no default white bar)", async ({ page }) => {
    await setup(page, { clearWidth: true });
    // The workflows list scroll container, addressed by a stable test id
    // (decoupled from Tailwind class names).
    const listContainer = page.getByTestId("workflow-history-list");
    await expect(listContainer).toBeAttached();

    const result = await listContainer.evaluate((el) => ({
      scrollbarWidth: getComputedStyle(el).scrollbarWidth,
      webkitWidth: getComputedStyle(el, "::-webkit-scrollbar").width,
      noHorizontalScroll: el.scrollWidth <= el.clientWidth,
    }));
    // Report exact values so an empty return is visible, not silently loosened.
    console.log(`scrollbar computed: scrollbarWidth=${JSON.stringify(result.scrollbarWidth)} webkitWidth=${JSON.stringify(result.webkitWidth)}`);
    expect(result.scrollbarWidth).toBe("thin");
    expect(result.webkitWidth).toBe("6px");
    // R2.8 (data-independent): the list never grows a horizontal scrollbar at
    // the default 288px width, regardless of whether any rows are present.
    expect(result.noHorizontalScroll).toBe(true);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/05-scrollbar.png`, fullPage: true });
  });

  test("6: widening reveals a previously-truncated epic title", async ({ page }) => {
    await setup(page, { clearWidth: true });
    // Find a title that is actually clipped at 288px.
    const count = await page.locator("p.truncate").count();
    if (count === 0) {
      test.skip(true, "No workflow titles in local data");
      return;
    }
    // Pick the first clipped title, if any.
    const clippedIndex = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("p.truncate")) as HTMLElement[];
      return els.findIndex((el) => el.scrollWidth > el.clientWidth);
    });
    if (clippedIndex < 0) {
      test.skip(true, "No sufficiently long (clipped) title in local data");
      return;
    }

    const c = await handleCenter(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 300, c.y, { steps: 10 });
    await page.mouse.up();

    const stillClipped = await page.evaluate((idx) => {
      const els = Array.from(document.querySelectorAll("p.truncate")) as HTMLElement[];
      const el = els[idx];
      return el ? el.scrollWidth > el.clientWidth : true;
    }, clippedIndex);
    expect(stillClipped).toBe(false);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/06-truncation-reveal.png`, fullPage: true });
  });
});
