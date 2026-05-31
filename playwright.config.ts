import { defineConfig } from "@playwright/test";

/**
 * Target the deployed App Runner site or default to localhost for local dev.
 * Set PLAYWRIGHT_BASE_URL in your environment to override (see .env.example).
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  timeout: 30000,
  use: {
    baseURL,
    screenshot: "on",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
  ],
});
