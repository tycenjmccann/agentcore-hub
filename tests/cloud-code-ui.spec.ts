import { test, expect, type Page, type Route } from "@playwright/test";

/**
 * Cloud Code — mocked-UI regression suite (no AWS, no live runtime).
 *
 * Every backend call is intercepted with page.route, so this runs green against
 * a plain `next start` with zero credentials — the merge-gate tier. It locks the
 * UI contracts the four cherry-picked features added:
 *   • composer state machine: mic ⇄ send ⇄ stop (the swap that shipped broken
 *     twice — inverted render condition, then wrong-session stop)
 *   • Artifacts tab: gallery renders from the list payload; empty state; upload affordance
 *   • GitHub App section in the config modal: not-connected → Connect; connected → Disconnect
 *   • pull-to-laptop command button copies the exact MCP slash command
 *
 * The live end-to-end path (real runtime, real S3/DynamoDB) stays in
 * cloud-code-demo.spec.ts, which is opt-in against a deployed URL.
 */

const SESSION_ID = "cc-test-0001";

interface SessionOpts {
  cli?: "claude" | "codex";
  turns?: { role: "user" | "agent"; text: string; at: string }[];
}

function sessionRow(opts: SessionOpts = {}) {
  return {
    sessionId: SESSION_ID,
    tenantId: "default",
    title: "Harden the widget parser",
    cli: opts.cli ?? "claude",
    repo: "acme/widgets",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    warmth: "warm",
  };
}

function sessionDetail(opts: SessionOpts = {}) {
  return {
    ...sessionRow(opts),
    userId: "default",
    turns: opts.turns ?? [],
    rev: 0,
  };
}

/** Stub the Web Speech API so VoiceButton reports supported → the mic renders
 *  on an empty composer (otherwise it returns null and the swap is untestable). */
async function stubSpeech(page: Page) {
  await page.addInitScript(() => {
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {}
      stop() {
        this.onend?.();
      }
      abort() {}
    }
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition =
      FakeRecognition;
  });
}

/** Baseline routes: one warm Claude session, empty config + disconnected GitHub.
 *  Individual tests override specific routes by registering them first. */
async function baseRoutes(page: Page, opts: SessionOpts = {}) {
  await page.route("**/api/cloud-code/sessions", (r) =>
    r.fulfill({ json: { sessions: [sessionRow(opts)] } })
  );
  await page.route(`**/api/cloud-code/sessions/${SESSION_ID}`, (r) => {
    if (r.request().method() !== "GET") return r.fulfill({ json: { ok: true } });
    return r.fulfill({ json: { session: sessionDetail(opts) } });
  });
  await page.route("**/api/cloud-code/config", (r) =>
    r.fulfill({ json: { versions: [], currentVersion: undefined } })
  );
  await page.route("**/api/cloud-code/github", (r) =>
    r.fulfill({ json: { appConfigured: true, isAdmin: false, connection: null } })
  );
}

async function openSession(page: Page) {
  await page.goto("/cloud-code");
  await page.getByTestId("cc-session-row").first().click();
  await expect(page.getByTestId("cc-message-input")).toBeVisible({ timeout: 10_000 });
}

test.describe("Cloud Code UI (mocked)", () => {
  test.beforeEach(async ({ page }) => {
    await stubSpeech(page);
  });

  test("composer swaps mic ⇄ send by draft content", async ({ page }) => {
    await baseRoutes(page);
    await openSession(page);

    // Empty composer → push-to-talk mic (speech stubbed as supported).
    await expect(page.getByTestId("cc-voice")).toBeVisible();
    await expect(page.getByTestId("cc-send")).toHaveCount(0);

    // Typing a draft swaps the mic out for the send button.
    await page.getByTestId("cc-message-input").fill("do the thing");
    await expect(page.getByTestId("cc-send")).toBeVisible();
    await expect(page.getByTestId("cc-voice")).toHaveCount(0);

    // Clearing it swaps back to the mic.
    await page.getByTestId("cc-message-input").fill("");
    await expect(page.getByTestId("cc-voice")).toBeVisible();
  });

  test("send → stop button appears mid-stream, then clears on stop", async ({ page }) => {
    await baseRoutes(page);

    // Hold the streaming turn open so `sending` stays true and cc-stop is observable.
    let releaseStream = () => {};
    const held = new Promise<void>((res) => {
      releaseStream = res;
    });
    await page.route(`**/api/cloud-code/sessions/${SESSION_ID}/message*`, async (route: Route) => {
      await held; // keep the request in flight
      try {
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: `data: ${JSON.stringify({ type: "done", response: "done" })}\n\n`,
        });
      } catch {
        /* client aborted on Stop — expected */
      }
    });
    // Stop returns the interrupted turn persisted (the shape the client repaints from).
    await page.route(`**/api/cloud-code/sessions/${SESSION_ID}/stop`, (r) =>
      r.fulfill({
        json: {
          stopped: true,
          session: sessionDetail({
            turns: [
              { role: "user", text: "long task", at: "2026-01-01T00:00:01.000Z" },
              { role: "agent", text: "⏹ Stopped.", at: "2026-01-01T00:00:02.000Z" },
            ],
          }),
        },
      })
    );

    await openSession(page);
    await page.getByTestId("cc-message-input").fill("long task");
    await page.getByTestId("cc-send").click();

    // Mid-stream: the send button becomes a red stop square.
    await expect(page.getByTestId("cc-stop")).toBeVisible();
    await expect(page.getByTestId("cc-send")).toHaveCount(0);

    // Stop it → client aborts, calls /stop, repaints, and returns to idle.
    await page.getByTestId("cc-stop").click();
    releaseStream();
    await expect(page.getByTestId("cc-stop")).toHaveCount(0);
    await expect(page.getByText("⏹ Stopped.")).toBeVisible();
  });

  test("Artifacts tab renders the gallery from the list payload", async ({ page }) => {
    await baseRoutes(page);
    // 1x1 transparent PNG so the <img> actually loads without S3.
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42m" +
      "NkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    await page.route(`**/api/cloud-code/sessions/${SESSION_ID}/artifacts`, (r) => {
      if (r.request().method() !== "GET") return r.fulfill({ json: { ok: true } });
      return r.fulfill({
        json: {
          artifacts: [
            { path: "out/chart.png", url: png, bytes: 2048, contentType: "image/png" },
            { path: "report.csv", url: "about:blank", bytes: 512, contentType: "text/csv" },
          ],
        },
      });
    });

    await openSession(page);
    await page.getByRole("button", { name: /Artifacts/i }).click();

    await expect(page.getByText("out/chart.png")).toBeVisible();
    await expect(page.getByText("report.csv")).toBeVisible();
    await expect(page.getByText("2 KB")).toBeVisible(); // humanSize(2048)
    await expect(page.getByRole("button", { name: /Upload a file/i })).toBeVisible();
  });

  test("Artifacts tab shows the empty state with no artifacts", async ({ page }) => {
    await baseRoutes(page);
    await page.route(`**/api/cloud-code/sessions/${SESSION_ID}/artifacts`, (r) =>
      r.fulfill({ json: { artifacts: [] } })
    );
    await openSession(page);
    await page.getByRole("button", { name: /Artifacts/i }).click();
    await expect(page.getByText(/No artifacts yet/i)).toBeVisible();
  });

  test("pull-to-laptop button copies the exact MCP slash command", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await baseRoutes(page);
    await openSession(page);

    await page.getByRole("button", { name: /Copy the command to pull/i }).click();
    await expect(page.getByText("Copied")).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(`/mcp__agentcore-hub__pull ${SESSION_ID}`);
  });

  test("GitHub section: Connect when app configured but not connected", async ({ page }) => {
    await baseRoutes(page);
    await openSession(page);
    await page.getByRole("button", { name: /My CLI config/i }).click();

    await expect(page.getByText("Not connected")).toBeVisible();
    const connect = page.getByRole("link", { name: /^Connect$/ });
    await expect(connect).toBeVisible();
    await expect(connect).toHaveAttribute("href", "/api/cloud-code/github/install");
  });

  test("GitHub section: shows account + Disconnect when connected", async ({ page }) => {
    await baseRoutes(page);
    await page.route("**/api/cloud-code/github", (r) => {
      if (r.request().method() === "DELETE") return r.fulfill({ json: { disconnected: true } });
      return r.fulfill({
        json: {
          appConfigured: true,
          isAdmin: false,
          connection: {
            account: "acme-org",
            repoSelection: "selected",
            repoCount: 3,
            connectedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      });
    });
    await openSession(page);
    await page.getByRole("button", { name: /My CLI config/i }).click();

    await expect(page.getByText("acme-org")).toBeVisible();
    await expect(page.getByText(/3 repos · short-lived tokens/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Disconnect/i })).toBeVisible();
  });
});
