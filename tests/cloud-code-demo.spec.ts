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

const DEMO_REPO = process.env.DEMO_REPO || "tycenjmccann/hello-world";
const TURN_TIMEOUT = 240_000; // a live coding turn can take minutes

test.describe("Cloud Code demo", () => {
  test.describe.configure({ mode: "serial", timeout: 900_000 });

  test("Claude chat: clone a repo, analyze a feature, request a report", async ({ page }) => {
    await page.goto("/cloud-code");

    // Start a new Claude session on the demo repo.
    await page.getByTestId("cc-new-session").click();
    await page.getByTestId("cc-cli-claude").click();
    await page.getByTestId("cc-repo-input").fill(DEMO_REPO);
    await page.getByTestId("cc-start").click();

    const input = page.getByTestId("cc-message-input");
    await expect(input).toBeVisible({ timeout: 15_000 });

    // Turn 1 — analyze for refactor. Stream renders into the chat.
    await input.fill(
      "Clone and look around this repo. Pick one feature or file and analyze it " +
        "for refactor opportunities — call out what you'd change and why. Keep it concise."
    );
    await page.getByTestId("cc-send").click();

    // The agent reply grows in place; wait until the agent turn has real text.
    await expect
      .poll(
        async () => (await page.getByTestId("cc-agent-turn").last().innerText().catch(() => "")).length,
        { timeout: TURN_TIMEOUT, intervals: [2000] }
      )
      .toBeGreaterThan(400);
    await page.screenshot({ path: "test-results/cc-claude-analysis.png", fullPage: true });

    // Turn 2 — ask for a written report (the "download the report" beat).
    await input.fill(
      "Write that up as a short REFACTOR_REPORT.md in the repo, commit it on a " +
        "new branch, and tell me the branch name."
    );
    await page.getByTestId("cc-send").click();
    await expect
      .poll(
        async () => (await page.getByTestId("cc-agent-turn").last().innerText().catch(() => "")).toLowerCase().includes("branch"),
        { timeout: TURN_TIMEOUT, intervals: [2000] }
      )
      .toBeTruthy();
    await page.screenshot({ path: "test-results/cc-claude-report.png", fullPage: true });
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
      "codex exec --skip-git-repo-check 'List the files here and suggest one refactor.'",
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

  test("leaves a warm Claude session for mobile resume", async ({ page }) => {
    await page.goto("/cloud-code");
    await page.getByTestId("cc-new-session").click();
    await page.getByTestId("cc-cli-claude").click();
    await page.getByTestId("cc-repo-input").fill(DEMO_REPO);
    await page.getByTestId("cc-start").click();

    const input = page.getByTestId("cc-message-input");
    await input.fill("Remember this: my demo codeword is ORCHID. Reply with just: OK");
    await page.getByTestId("cc-send").click();
    // Wait for a real agent turn (not the prompt echo) to contain OK.
    await expect
      .poll(
        async () => (await page.getByTestId("cc-agent-turn").last().innerText().catch(() => "")).includes("OK"),
        { timeout: TURN_TIMEOUT, intervals: [2000] }
      )
      .toBeTruthy();

    // The session now shows in the sidebar — resume it from any device by
    // opening /cloud-code and clicking it. Capture its title for the demo.
    await page.screenshot({ path: "test-results/cc-warm-session.png", fullPage: true });
  });
});
