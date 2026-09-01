import { defineConfig } from "@playwright/test";

/**
 * Demo-only Playwright config. Long timeouts because each act runs the full
 * VO duration before ending. Videos go to demo/video/raw/<act>/.
 *
 * Run from repo root:
 *   PLAYWRIGHT_BASE_URL=https://<app-runner> \
 *     npx playwright test --config demo/playwright.config.ts
 */

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: ".",
  testMatch: "record.spec.ts",
  outputDir: "./video/raw",
  timeout: 300_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL,
    viewport: { width: 1920, height: 1080 },
    video: { mode: "on", size: { width: 1920, height: 1080 } },
    screenshot: "off",
    trace: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
});
