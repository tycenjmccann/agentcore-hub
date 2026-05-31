import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 2400000, // 40 minutes (real agent invocations)
  use: {
    baseURL: "http://localhost:3000",
    browserName: "chromium",
    viewport: { width: 1920, height: 1080 },
  },
  webServer: {
    command: "npm run dev",
    port: 3000,
    reuseExistingServer: true,
    timeout: 30000,
    // NO DEMO_MODE — this runs real agents
  },
});
