import { test, Page, Locator } from "@playwright/test";

/**
 * Per-act demo recordings. Each test() = one act = one .webm in raw/.
 * Re-shoot any act independently. Stitch in post with ffmpeg.
 *
 * Run: PLAYWRIGHT_BASE_URL=https://<app-runner> npx playwright test demo/record.spec.ts --project=chromium --headed=false
 *
 * Pacing helpers below mimic a human demoist:
 *   - slowType: typewriter feel
 *   - dramaticPause: explicit beat for VO to land
 *   - smoothScrollTo: scroll into view with motion
 *   - highlightFlash: CSS pulse on a hero element
 */

const VIEW = { width: 1920, height: 1080 };

test.use({
  viewport: VIEW,
  video: { mode: "on", size: VIEW },
});

// Force dark mode for every act — the app reads localStorage["theme"] on load
// (src/lib/theme.ts) and applies data-theme. Records dark regardless of the
// in-flight light-mode fix.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("theme", "dark");
      document.documentElement.setAttribute("data-theme", "dark");
    } catch {}
  });
});

// --- helpers ----------------------------------------------------------------

async function dramaticPause(page: Page, ms: number, label = "") {
  if (label) console.log(`  ⏸  ${label} (${ms}ms)`);
  await page.waitForTimeout(ms);
}

async function slowType(loc: Locator, text: string, msPerChar = 70) {
  for (const ch of text) {
    await loc.type(ch, { delay: msPerChar });
  }
}

async function smoothScrollTo(page: Page, selector: string) {
  const loc = page.locator(selector).first();
  if (!(await loc.count())) return;
  await loc
    .evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }))
    .catch(() => {});
  await page.waitForTimeout(900);
}

async function highlightFlash(page: Page, selector: string) {
  const loc = page.locator(selector).first();
  if (await loc.count()) {
    await loc
      .evaluate((el: HTMLElement) => {
        const prev = el.style.transition;
        el.style.transition = "outline 200ms ease, box-shadow 200ms ease";
        el.style.outline = "3px solid #38bdf8";
        el.style.boxShadow = "0 0 0 6px rgba(56,189,248,0.25)";
        setTimeout(() => {
          el.style.outline = "";
          el.style.boxShadow = "";
          el.style.transition = prev;
        }, 1200);
      })
      .catch(() => {});
  }
  await page.waitForTimeout(1300);
}

// --- ACTS -------------------------------------------------------------------

test("01-cold-open", async ({ page }) => {
  // ~12s — montage flash through 4 surfaces
  await page.goto("/");
  await dramaticPause(page, 1500, "land");
  for (const path of ["/agents", "/build", "/evaluations", "/workflow"]) {
    await page.goto(path);
    await dramaticPause(page, 1800);
  }
  await page.goto("/");
  await dramaticPause(page, 2500, "settle on dashboard");
});

test("02-dashboard", async ({ page }) => {
  // ~32s — slow tour of each strip
  await page.goto("/");
  await dramaticPause(page, 2500, "establish");
  await highlightFlash(page, "[data-testid='agent-activity'], section:has-text('AGENT ACTIVITY')");
  await dramaticPause(page, 3500, "agent activity");
  await smoothScrollTo(page, "section:has-text('TICKETS')");
  await dramaticPause(page, 4000, "tickets jira");
  await smoothScrollTo(page, "section:has-text('Epic Progress'), [data-testid='epic-progress']");
  await dramaticPause(page, 3500, "epic progress");
  await smoothScrollTo(page, "section:has-text('AGENT PERFORMANCE')");
  await dramaticPause(page, 4000, "agent performance");
  // region switcher hover
  await page.locator("button:has-text('us-east-1'), [aria-label*='region' i]").first().hover().catch(() => {});
  await dramaticPause(page, 2000, "region switcher");
  // dark mode click
  await page.locator("button[aria-label*='theme' i], button:has(svg.lucide-moon), button:has(svg.lucide-sun)").first().click().catch(() => {});
  await dramaticPause(page, 2500, "dark mode");
  await page.locator("button[aria-label*='theme' i], button:has(svg.lucide-moon), button:has(svg.lucide-sun)").first().click().catch(() => {});
  await dramaticPause(page, 1500);
});

test("03-agents-list", async ({ page }) => {
  // ~18s
  await page.goto("/agents");
  await dramaticPause(page, 3000, "land");
  // hover each card in turn
  const cards = page.locator("a[href*='/agents/'], [data-testid='agent-card']");
  const n = Math.min(await cards.count(), 4);
  for (let i = 0; i < n; i++) {
    await cards.nth(i).hover().catch(() => {});
    await dramaticPause(page, 2200);
  }
  await dramaticPause(page, 2500);
});

test("04-agent-detail", async ({ page }) => {
  // ~38s
  await page.goto("/agents");
  await dramaticPause(page, 1500);
  const link = page.locator("a[href*='/agents/']").first();
  await link.click();
  await dramaticPause(page, 3500, "agent detail loads");
  // Toggle Memory / Traces tabs in left rail
  await page.locator("button:has-text('Memory')").first().click().catch(() => {});
  await dramaticPause(page, 2500, "memory tab");
  await page.locator("button:has-text('Traces')").first().click().catch(() => {});
  await dramaticPause(page, 2500, "traces tab");
  // Toggle Chat / Playground in center
  await page.locator("button:has-text('Playground')").first().click().catch(() => {});
  await dramaticPause(page, 2500, "playground");
  await page.locator("button:has-text('Chat')").first().click().catch(() => {});
  await dramaticPause(page, 2000, "back to chat");
  // Type a prompt slowly, then ACTUALLY SEND it and watch the live reply stream.
  const input = page.locator("textarea[placeholder*='Message' i]").first();
  if (await input.count()) {
    await input.click();
    await slowType(input, "Hello — show me what you can do.", 55);
    await dramaticPause(page, 1200, "prompt typed");
    await input.press("Enter");
    await dramaticPause(page, 1500, "sent — agent thinking");
    // Wait for the streamed assistant reply to render (real harness invoke).
    await page
      .locator("[data-testid='chat-message'], .prose, [class*='message']")
      .last()
      .waitFor({ state: "visible", timeout: 60_000 })
      .catch(() => {});
    await dramaticPause(page, 6000, "reply streaming");
  }
  // Highlight execution trace rail as the trace populates from the live call
  await highlightFlash(page, "section:has-text('EXECUTION TRACE'), [data-testid='execution-trace']");
  await dramaticPause(page, 4000, "trace rail");
});

test("05-build", async ({ page }) => {
  // ~26s
  await page.goto("/build");
  await dramaticPause(page, 3000, "land");
  const input = page.locator("textarea[placeholder*='Describe' i], textarea").first();
  await input.click();
  await slowType(input, "Create an agent that monitors my CloudWatch alarms and posts a Slack summary every morning.", 50);
  await dramaticPause(page, 1500, "prompt typed");
  // ACTUALLY submit — let the builder agent design the harness config live.
  await input.press("Enter");
  await dramaticPause(page, 2000, "sent — builder thinking");
  // Wait for the streamed builder reply / config to populate.
  await page
    .locator("section:has-text('Harness Configuration'), [data-testid='harness-config'], [class*='message']")
    .last()
    .waitFor({ state: "visible", timeout: 90_000 })
    .catch(() => {});
  await dramaticPause(page, 4000, "config streaming");
  await highlightFlash(page, "section:has-text('Harness Configuration'), [data-testid='harness-config']");
  await dramaticPause(page, 3000, "harness config");
  // Deploy the real runtime.
  await page.locator("button:has-text('Deploy Agent')").first().click().catch(() => {});
  await dramaticPause(page, 3000, "deploy clicked");
  // Watch the deploy result land (real AgentCore runtime create).
  await page
    .locator("*:has-text('deployed'), *:has-text('Deployed'), *:has-text('runtime'), [data-testid='deploy-result']")
    .last()
    .waitFor({ state: "visible", timeout: 120_000 })
    .catch(() => {});
  await dramaticPause(page, 6000, "deploy result");
});

test("06-evaluations", async ({ page }) => {
  // ~32s
  await page.goto("/evaluations");
  await dramaticPause(page, 3000, "land");
  await highlightFlash(page, "*:has-text('14 AGENTS')");
  await dramaticPause(page, 3000, "header stats");
  await highlightFlash(page, "section:has-text('SELF-IMPROVEMENT LOOP')");
  await dramaticPause(page, 4000, "self-improvement loop");
  await smoothScrollTo(page, "section:has-text('OPERATIONAL METRICS')");
  await dramaticPause(page, 5000, "operational metrics matrix");
  // jump to config sub-page
  await page.goto("/evaluations/config");
  await dramaticPause(page, 4000, "per-agent config");
});

test("07a-workflow-intro", async ({ page }) => {
  // ~18s — empty state framing
  await page.goto("/workflow");
  await dramaticPause(page, 4000, "empty state");
  await highlightFlash(page, "button:has-text('New Workflow')");
  await dramaticPause(page, 3000);
  await highlightFlash(page, "button:has-text('Test Workflow')");
  await dramaticPause(page, 3000);
});

test("07b-workflow-bug", async ({ page }) => {
  // ~28s — pick the first BUG-shaped workflow if one exists, else the first
  await page.goto("/workflow");
  await dramaticPause(page, 2500);
  // Open the workflow sidebar (it's collapsed by default)
  await page.locator("button[aria-label*='expand' i], [data-testid='workflow-sidebar-toggle']").first().click().catch(() => {});
  await dramaticPause(page, 1500);
  const items = page.locator("[data-testid='workflow-list-item'], a[href*='/workflow/']");
  if ((await items.count()) > 0) {
    await items.first().click();
    await dramaticPause(page, 5000, "workflow loads");
  }
  await dramaticPause(page, 6000, "watch tickets");
});

test("07c-workflow-feature", async ({ page }) => {
  // ~30s — find a feature workflow (more tickets) and open it
  await page.goto("/workflow");
  await dramaticPause(page, 2500);
  await page.locator("button[aria-label*='expand' i], [data-testid='workflow-sidebar-toggle']").first().click().catch(() => {});
  await dramaticPause(page, 1500);
  const items = page.locator("[data-testid='workflow-list-item'], a[href*='/workflow/']");
  const count = await items.count();
  if (count > 1) {
    await items.nth(Math.min(1, count - 1)).click();
    await dramaticPause(page, 5000);
  }
  await dramaticPause(page, 8000, "fan-out montage");
});

test("08-ticket-history", async ({ page }) => {
  // ~16s
  await page.goto("/tickets");
  await dramaticPause(page, 3000);
  // type a filter
  const filter = page.locator("input[placeholder*='Filter' i]").first();
  if (await filter.count()) {
    await filter.click();
    await slowType(filter, "developer", 70);
    await dramaticPause(page, 2500, "filter typed");
  }
  // click first session if present
  const session = page.locator("[data-testid='ticket-session'], li[role='button']").first();
  if (await session.count()) {
    await session.click().catch(() => {});
    await dramaticPause(page, 4000, "session detail");
  }
});

test("09-outro", async ({ page }) => {
  // ~12s — montage back through nav, end on dashboard
  for (const path of ["/", "/agents", "/build", "/evaluations", "/workflow", "/"]) {
    await page.goto(path);
    await dramaticPause(page, 1400);
  }
  await dramaticPause(page, 2500, "linger on dashboard");
});
