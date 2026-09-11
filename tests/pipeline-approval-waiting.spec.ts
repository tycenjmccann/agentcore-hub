import { test, expect, type Page } from "@playwright/test";

/**
 * /pipeline — the "waiting deploy gate" context (TEAM-4433).
 *
 * Before this, a parked Approval stage showed only name/status/12-char
 * revisionSummary — no wait duration, no commit, no approve link. This pins the
 * amber "waiting" card: how long it has waited, a link to the source commit
 * (only when the target's sourceRepo is known), and the CodePipeline approve
 * deep link.
 *
 * Fully hermetic — every /api/** call is intercepted in-page (one handler
 * switching on URL, same shape as tests/tab-workflow-sidebar.spec.ts), so this
 * spec needs no AWS credentials and no live pipeline. It only needs the app
 * served at PLAYWRIGHT_BASE_URL (default http://localhost:3000).
 *
 * Run: npx playwright test tests/pipeline-approval-waiting.spec.ts
 */

// Playwright wipes test-results/ between runs, so write evidence to a sibling
// dir. It has to stay under the gitignored playwright-screenshots/ (same
// convention as tests/tab-workflow-sidebar.spec.ts).
const SCREENSHOT_DIR = "playwright-screenshots/team-4419";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4";
const WAITED_MS = 15 * 60 * 1000 + 5_000; // → floor(15.08) minutes = "15 min"
const APPROVE_URL =
  "https://console.aws.amazon.com/codesuite/codepipeline/pipelines/hub-juno-deploy/view?region=us-east-1";

interface OpenOpts {
  approvalStatus: string;
  sourceRepo?: boolean;
  sourceSha?: boolean;
}

/**
 * One handler for every /api/** call — switching on the URL rather than
 * layering routes avoids depending on Playwright's route precedence, and keeps
 * serving across the page's 20s re-poll. The pipeline fixture is built INSIDE
 * the handler so `waitingSince` is fresh at fulfil time (including on the
 * re-poll), not computed once at test setup.
 */
async function stubApi(page: Page, opts: OpenOpts) {
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    let json: unknown = {};
    if (url.includes("/api/pipeline/status")) {
      const waitingSince = new Date(Date.now() - WAITED_MS).toISOString();
      json = {
        enabled: true,
        pipelines: [
          {
            repo: "acme/juno",
            pipeline: "hub-juno-deploy",
            region: "us-east-1",
            ciProject: "hub-juno-ci",
            sourceRepo: opts.sourceRepo === false ? undefined : "acme/juno",
            recentBuilds: [],
            stages: [
              {
                name: "Source",
                status: "Succeeded",
                lastUpdated: waitingSince,
                waitingSince,
                revisionSummary: SHA.slice(0, 12),
                sourceSha: SHA,
              },
              {
                name: "Approval",
                status: opts.approvalStatus,
                lastUpdated: waitingSince,
                waitingSince,
                revisionSummary: "deadbeefcafe",
                sourceSha: opts.sourceSha === false ? undefined : SHA,
                awaitingApproval: opts.approvalStatus === "InProgress",
                approvalUrl: APPROVE_URL,
              },
            ],
          },
        ],
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(json),
    });
  });
}

async function open(page: Page, opts: OpenOpts) {
  await stubApi(page, opts);
  await page.addInitScript(() => {
    localStorage.setItem("theme", "dark");
  });
  await page.goto("/pipeline");
  await expect(page.locator('[data-testid="pipeline-target"]')).toHaveCount(1);
}

test.describe("Pipeline — deploy gate waiting context", () => {
  test("1. Approval InProgress shows wait duration, commit link, and approve link", async ({ page }) => {
    await open(page, { approvalStatus: "InProgress" });

    const waitingSince = page.locator('[data-testid="approval-waiting-since"]');
    await expect(waitingSince).toHaveText("Waiting since 15 min");

    const commitLink = page.locator('[data-testid="approval-commit-link"]');
    await expect(commitLink).toHaveText("a1b2c3d");
    await expect(commitLink).toHaveAttribute(
      "href",
      `https://github.com/acme/juno/commit/${SHA}`
    );
    await expect(commitLink).toHaveAttribute("rel", "noopener noreferrer");
    await expect(commitLink).toHaveAttribute("target", "_blank");

    const approveLink = page.locator('[data-testid="approval-approve-link"]');
    await expect(approveLink).toContainText("Approve in CodePipeline");
    await expect(approveLink).toHaveAttribute("href", APPROVE_URL);
    await expect(approveLink).toHaveAttribute("rel", "noopener noreferrer");

    await expect(page.locator('[data-testid="approval-waiting-card"]')).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/01-approval-waiting.png` });
  });

  test("2. Approval Succeeded shows none of the waiting affordances", async ({ page }) => {
    await open(page, { approvalStatus: "Succeeded" });

    await expect(page.locator('[data-testid="approval-waiting-since"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="approval-commit-link"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="approval-commit-sha"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="approval-approve-link"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="approval-waiting-card"]')).toHaveCount(0);
  });

  test("3. the Source card carries none of the waiting testids; exactly one target renders", async ({ page }) => {
    await open(page, { approvalStatus: "InProgress" });

    await expect(page.locator('[data-testid="pipeline-target"]')).toHaveCount(1);

    const sourceCard = page.locator("div.bg-surface-2", { hasText: "Source" });
    await expect(sourceCard).toHaveCount(1);
    await expect(sourceCard.locator('[data-testid="approval-waiting-since"]')).toHaveCount(0);
    await expect(sourceCard.locator('[data-testid="approval-commit-link"]')).toHaveCount(0);
    await expect(sourceCard.locator('[data-testid="approval-commit-sha"]')).toHaveCount(0);
    await expect(sourceCard.locator('[data-testid="approval-approve-link"]')).toHaveCount(0);
  });

  test("4. sourceRepo omitted -> plain SHA text, no link; wait + approve still render", async ({ page }) => {
    await open(page, { approvalStatus: "InProgress", sourceRepo: false });

    await expect(page.locator('[data-testid="approval-commit-link"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="approval-commit-sha"]')).toHaveText("a1b2c3d");
    await expect(page.locator('[data-testid="approval-waiting-since"]')).toHaveText("Waiting since 15 min");
    await expect(page.locator('[data-testid="approval-approve-link"]')).toBeVisible();
  });

  test("5. sourceSha omitted -> neither commit testid renders; wait + approve still render", async ({ page }) => {
    await open(page, { approvalStatus: "InProgress", sourceSha: false });

    await expect(page.locator('[data-testid="approval-commit-link"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="approval-commit-sha"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="approval-waiting-since"]')).toHaveText("Waiting since 15 min");
    await expect(page.locator('[data-testid="approval-approve-link"]')).toBeVisible();
  });
});
