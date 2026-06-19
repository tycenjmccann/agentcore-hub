import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load .env.local into the test runner's env so tests can assert against the
 * same installer-configured values the dev server bakes into the bundle (e.g.
 * NEXT_PUBLIC_BRAND_NAME). Next.js reads .env.local at server startup; the
 * runner is a separate process and would otherwise see none of it. Minimal
 * parser — no dotenv dependency. Existing env vars win (CI can still override).
 */
try {
  const envFile = readFileSync(resolve(__dirname, ".env.local"), "utf8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
} catch {
  // No .env.local (e.g. CI against a deployed URL) — tests fall back to defaults.
}

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
    // Set PWVIDEO=1 to record + keep video for every test (Cloud Code demo capture).
    video: process.env.PWVIDEO === "1" ? "on" : "off",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium", viewport: { width: 1440, height: 900 } },
    },
  ],
});
