import { test, expect, type Page } from "@playwright/test";

/**
 * Workflow tab — Workflows list sidebar resize + scrollbar coverage (TEAM-4387).
 *
 * The sidebar starts collapsed by default (`historyCollapsed` state), so every
 * test here seeds `workflow-history-collapsed=false` via addInitScript (same
 * pattern as tests/cloud-code-ui.spec.ts) instead of clicking the toggle. Each
 * Playwright test gets a fresh, isolated browser context/localStorage, so we
 * don't need to explicitly clear `workflow-history-width` — it just starts
 * absent unless a test seeds it. Note: addInitScript re-runs on every
 * navigation of the page (including reload), so it must never unconditionally
 * clear state a test expects to survive a reload.
 *
 * The sidebar keeps `transition-all duration-300` applied except while
 * actively dragging, so any width change driven by something other than a
 * drag (initial localStorage-driven expand, double-click reset, arrow-key
 * nudge, collapse/expand click) animates over 300ms. SETTLE_MS is comfortably
 * longer than that so boundingBox() reads the settled value, not a
 * mid-transition sample.
 */
const SETTLE_MS = 400;

const SIDEBAR = '[data-testid="workflow-history-sidebar"]';
const HANDLE = '[data-testid="workflow-history-resize"]';
const LIST = '[data-testid="workflow-history-list"]';

test.describe.configure({ timeout: 45000 });

async function gotoExpanded(page: Page, extraLocalStorage?: Record<string, string>) {
  await page.addInitScript((extra) => {
    localStorage.setItem("workflow-history-collapsed", "false");
    for (const [k, v] of Object.entries(extra || {})) {
      localStorage.setItem(k, v);
    }
  }, extraLocalStorage || {});
  await page.goto("/workflow");
  await page.locator(SIDEBAR).waitFor({ state: "visible" });
  await page.waitForTimeout(SETTLE_MS);
}

async function sidebarWidth(page: Page): Promise<number> {
  const box = await page.locator(SIDEBAR).boundingBox();
  if (!box) throw new Error("sidebar not found");
  return box.width;
}

test.describe("Workflow list sidebar — resize", () => {
  test("default width is 288px", async ({ page }) => {
    await gotoExpanded(page);
    const width = await sidebarWidth(page);
    expect(width).toBeGreaterThanOrEqual(287);
    expect(width).toBeLessThanOrEqual(289);
  });

  test("drag handle widens the list and the width persists across reload", async ({ page }) => {
    await gotoExpanded(page);
    const handle = page.locator(HANDLE);
    const handleBox = await handle.boundingBox();
    if (!handleBox) throw new Error("handle not found");

    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 100, startY, { steps: 5 });
    await page.mouse.move(startX + 200, startY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(SETTLE_MS);

    const widened = await sidebarWidth(page);
    expect(widened).toBeGreaterThanOrEqual(400);

    const stored = await page.evaluate(() => localStorage.getItem("workflow-history-width"));
    expect(Number(stored)).toBeGreaterThanOrEqual(400);

    await page.reload();
    await page.locator(SIDEBAR).waitFor({ state: "visible" });
    await page.waitForTimeout(SETTLE_MS);
    const afterReload = await sidebarWidth(page);
    expect(afterReload).toBeGreaterThanOrEqual(400);
  });

  test("double-click on the handle resets to 288px", async ({ page }) => {
    await gotoExpanded(page, { "workflow-history-width": "500" });
    const before = await sidebarWidth(page);
    expect(before).toBeGreaterThanOrEqual(490);

    await page.locator(HANDLE).dblclick();
    await page.waitForTimeout(SETTLE_MS);
    const after = await sidebarWidth(page);
    expect(after).toBeGreaterThanOrEqual(287);
    expect(after).toBeLessThanOrEqual(289);

    const stored = await page.evaluate(() => localStorage.getItem("workflow-history-width"));
    expect(stored).toBe("288");
  });

  test("arrow keys resize the handle by 16px", async ({ page }) => {
    await gotoExpanded(page);
    const before = await sidebarWidth(page);
    await page.locator(HANDLE).focus();

    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(SETTLE_MS);
    const afterRight = await sidebarWidth(page);
    expect(afterRight).toBeGreaterThanOrEqual(before + 14);

    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(SETTLE_MS);
    const afterLeft = await sidebarWidth(page);
    expect(afterLeft).toBeLessThanOrEqual(afterRight - 14);
  });

  test("shrinking the viewport re-clamps the width and aria-valuemax to min(640, 50vw)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await gotoExpanded(page, { "workflow-history-width": "640" });
    expect(await sidebarWidth(page)).toBeGreaterThanOrEqual(630);
    await expect(page.locator(HANDLE)).toHaveAttribute("aria-valuemax", "640");

    // 50vw of an 800px viewport is 400px, below the stored 640.
    await page.setViewportSize({ width: 800, height: 900 });
    await page.waitForTimeout(SETTLE_MS);
    const clamped = await sidebarWidth(page);
    expect(clamped).toBeGreaterThanOrEqual(399);
    expect(clamped).toBeLessThanOrEqual(401);
    await expect(page.locator(HANDLE)).toHaveAttribute("aria-valuemax", "400");

    // The chosen width is not persisted away by a temporarily narrow window, so
    // widening back restores it.
    const stored = await page.evaluate(() => localStorage.getItem("workflow-history-width"));
    expect(stored).toBe("640");
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(SETTLE_MS);
    expect(await sidebarWidth(page)).toBeGreaterThanOrEqual(630);

    // Shrink again: an arrow-key nudge must step from the *rendered* 400px, not
    // from the stored 640px, so the keypress visibly moves the edge — and that
    // explicit adjustment becomes the new chosen (persisted) width.
    await page.setViewportSize({ width: 800, height: 900 });
    await page.waitForTimeout(SETTLE_MS);
    await page.locator(HANDLE).focus();
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(SETTLE_MS);
    const nudged = await sidebarWidth(page);
    expect(nudged).toBeGreaterThanOrEqual(383);
    expect(nudged).toBeLessThanOrEqual(385);
    expect(await page.evaluate(() => localStorage.getItem("workflow-history-width"))).toBe("384");
  });

  test("collapse then expand restores the persisted width", async ({ page }) => {
    await gotoExpanded(page, { "workflow-history-width": "450" });
    const wide = await sidebarWidth(page);
    expect(wide).toBeGreaterThanOrEqual(440);

    const collapseBtn = page.locator('button[aria-label="Collapse workflow history sidebar"]');
    await collapseBtn.click();
    await page.waitForTimeout(SETTLE_MS);
    const collapsed = await sidebarWidth(page);
    expect(collapsed).toBeLessThanOrEqual(40);

    const expandBtn = page.locator('button[aria-label="Expand workflow history sidebar"]');
    await expandBtn.click();
    await page.waitForTimeout(SETTLE_MS);
    const reExpanded = await sidebarWidth(page);
    expect(reExpanded).toBeGreaterThanOrEqual(440);
  });
});

test.describe("Workflow list sidebar — scrollbar", () => {
  test("workflows list has a thin scrollbar and no horizontal overflow", async ({ page }) => {
    await gotoExpanded(page);
    const list = page.locator(LIST);
    await expect(list).toBeVisible();

    const scrollbarWidth = await list.evaluate((el) => getComputedStyle(el).scrollbarWidth);
    expect(scrollbarWidth).toBe("thin");

    const overflow = await list.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});
