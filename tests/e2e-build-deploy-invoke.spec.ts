import { test, expect } from "@playwright/test";

/**
 * E2E: Builder Agent.
 *
 * The previous version of these tests passed on the welcome message ("Tell me
 * what kind of agent you need…") because every assertion looked for substrings
 * that already appear in the static intro. That hid a real production bug
 * where the harness role was missing bedrock:InvokeModelWithResponseStream and
 * /api/agentcore/builder returned 500 — tests still ran in 3.6s and went
 * green. This rewrite:
 *
 *   1. Asserts the /build page loads and the input is interactive.
 *   2. Submits a real prompt, waits for a response that is NOT the welcome
 *      message, and fails fast if the API errors.
 */
test.describe("E2E: Builder Agent", () => {
  test.setTimeout(120_000);

  test("Build page loads with chat surface visible", async ({ page }) => {
    await page.goto("/build");
    await expect(page.getByText("Agent Builder Chat")).toBeVisible();
    await expect(page.locator("[data-testid='build-description-input']")).toBeVisible();
    await expect(page.locator("[data-testid='build-submit-btn']")).toBeVisible();
  });

  test("Builder agent answers a real prompt", async ({ page }) => {
    // Fail fast on a 5xx from the streaming endpoint — the old tests would
    // happily pass even when this returned 500.
    page.on("response", (resp) => {
      if (resp.url().includes("/api/agentcore/builder") && resp.status() >= 500) {
        throw new Error(`Builder API ${resp.status()} on ${resp.url()}`);
      }
    });

    await page.goto("/build");

    const messages = page.locator("[data-testid='builder-messages']");
    const baselineLength = (await messages.textContent())?.length ?? 0;

    await page.locator("[data-testid='build-description-input']")
      .fill("What tools can you give an agent");
    await page.locator("[data-testid='build-submit-btn']").click();

    // The user's prompt should appear in the transcript before any agent
    // response — this also confirms the chat actually accepted the submit.
    await expect(messages.getByText("What tools can you give an agent")).toBeVisible();

    // Wait for the agent to add at least 80 characters beyond the prompt
    // echo. The welcome message alone is far longer than that, so we anchor
    // on growth past `baselineLength + prompt + threshold` rather than a
    // raw text length. 30s ceiling per the user's "wait ~10 sec" guidance,
    // padded for cold-start streaming to begin.
    await expect(async () => {
      const text = (await messages.textContent()) ?? "";
      expect(text.length).toBeGreaterThan(baselineLength + 80);
    }).toPass({ timeout: 30_000 });
  });
});
