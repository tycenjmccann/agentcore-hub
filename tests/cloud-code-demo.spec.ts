import { test, expect } from "@playwright/test";

/**
 * Cloud Code — recorded end-to-end demo / feature test.
 *
 * Drives the real deployed tab against the live coding runtime (no mocks):
 *  1. Claude chat: new session on a repo → ask it to analyze a feature for
 *     refactor → watch the streamed reply → ask for a written report.
 *  2. Codex via the live terminal: new session → launch codex in the shell →
 *     same kind of task over the CLI.
 *  3. Leaves a warm Claude session so it can be resumed from mobile.
 *
 * Run against the deployed site, recording video:
 *   PLAYWRIGHT_BASE_URL=https://<app-runner-url> \
 *     npx playwright test tests/cloud-code-demo.spec.ts --headed
 *
 * Video lands in test-results/. These are long, live-agent turns — generous
 * timeouts. The DEMO_REPO defaults to a small public repo; override with env.
 */

// A real codebase (HTML/CSS/JS + tests) so the refactor analysis has substance.
const DEMO_REPO = process.env.DEMO_REPO || "tycenjmccann/tic-tac-toe-ai";
const DEMO_REPO_NAME = DEMO_REPO.split("/").pop()!;
const TURN_TIMEOUT = 300_000; // a live coding turn can take minutes

// Each turn appends an agent bubble; wait for the Nth agent turn to fill in.
async function waitForAgentTurn(page: import("@playwright/test").Page, n: number, minLen = 1) {
  await expect
    .poll(
      async () => {
        const turns = page.getByTestId("cc-agent-turn");
        if ((await turns.count()) < n) return 0;
        return (await turns.nth(n - 1).innerText().catch(() => "")).length;
      },
      { timeout: TURN_TIMEOUT, intervals: [2000] }
    )
    .toBeGreaterThan(minLen);
}

test.describe("Cloud Code demo", () => {
  test.describe.configure({ mode: "serial", timeout: 1_200_000 });

  test("Claude chat: find the repo via gh, then scope a hardening refactor", async ({ page }) => {
    await page.goto("/cloud-code");

    // Start a new Claude session — no repo set, so it must use gh to find it.
    await page.getByTestId("cc-new-session").click();
    await page.getByTestId("cc-cli-claude").click();
    await page.getByTestId("cc-start").click();

    const input = page.getByTestId("cc-message-input");
    await expect(input).toBeVisible({ timeout: 15_000 });

    // Turn 1 — show it has gh: ask it to find the repo.
    await input.fill(
      `Do you have access to a repo called "${DEMO_REPO_NAME}"? Use gh to check, ` +
        `and if so tell me its full owner/name and what's in it.`
    );
    await page.getByTestId("cc-send").click();
    await waitForAgentTurn(page, 1, 80);
    await page.screenshot({ path: "test-results/cc-1-gh-find-repo.png", fullPage: true });

    // Turn 2 — clone it and scope ONE hardening/cleanup refactor (find, don't fix).
    await input.fill(
      `Great — clone ${DEMO_REPO} and review the code. Find the single best ` +
        `refactor opportunity to harden and clean up the codebase (correctness, ` +
        `input validation, dead code, or structure). Describe exactly what you'd ` +
        `change and why — but DON'T make any changes yet. I'll have you fix it next.`
    );
    await page.getByTestId("cc-send").click();
    await waitForAgentTurn(page, 2, 400);
    await page.screenshot({ path: "test-results/cc-2-refactor-scoped.png", fullPage: true });
    // Leaves this session warm + scoped — resume from mobile and tell it "do it".
  });

  test("Codex via the live terminal", async ({ page }) => {
    await page.goto("/cloud-code");
    await page.getByTestId("cc-new-session").click();
    await page.getByTestId("cc-cli-codex").click();
    await page.getByTestId("cc-repo-input").fill(DEMO_REPO);
    await page.getByTestId("cc-start").click();

    // Switch to the Terminal tab and drive codex over the PTY.
    await page.getByRole("button", { name: /Terminal/i }).click();
    // The xterm canvas connects; wait for the ready banner text in the terminal.
    await expect
      .poll(
        async () => (await page.locator(".xterm").innerText().catch(() => "")).includes("Coding agents ready"),
        { timeout: 60_000, intervals: [1500] }
      )
      .toBeTruthy();
    await page.screenshot({ path: "test-results/cc-codex-terminal-ready.png", fullPage: true });

    // Type a codex command into the terminal (xterm captures key events on the
    // focused canvas). Click to focus, let the PTY settle, then type slowly so
    // every keystroke registers over the WebSocket before Enter.
    await page.locator(".xterm").click();
    await page.waitForTimeout(1500);
    await page.keyboard.type(
      "codex exec --skip-git-repo-check 'Review this tic-tac-toe codebase and " +
        "name the single best hardening/cleanup refactor — what and why, do not change anything.'",
      { delay: 25 }
    );
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");

    // codex prints its NDJSON/agent output into the terminal as it runs.
    await expect
      .poll(
        async () => (await page.locator(".xterm").innerText().catch(() => "")).includes("codex exec"),
        { timeout: 30_000, intervals: [1500] }
      )
      .toBeTruthy();
    await expect
      .poll(
        async () => (await page.locator(".xterm").innerText().catch(() => "")).length,
        { timeout: TURN_TIMEOUT, intervals: [2000] }
      )
      .toBeGreaterThan(400);
    await page.screenshot({ path: "test-results/cc-codex-terminal-output.png", fullPage: true });
  });

  // The Claude session from test 1 is the warm, scoped session left for mobile
  // pickup ("do it" finishes the refactor). This test just confirms it's listed
  // and resumable from a fresh page load (i.e. from any device).
  test("scoped session is listed + resumable (mobile pickup)", async ({ page }) => {
    await page.goto("/cloud-code");
    // Fresh page load (simulates opening on another device). Reopen the Claude
    // session — the one carrying the scoped refactor analysis (title is the
    // gh-find prompt; the codex row is terminal-only with no chat turns).
    const claudeRow = page
      .getByTestId("cc-session-row")
      .filter({ hasText: /Do you have access/i })
      .first();
    await expect(claudeRow).toBeVisible({ timeout: 15_000 });
    await claudeRow.click();
    // It reopens with its prior turns intact (the scoped refactor analysis).
    await expect(page.getByTestId("cc-agent-turn").first()).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: "test-results/cc-3-resume-ready.png", fullPage: true });
  });
});
