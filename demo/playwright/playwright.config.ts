import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 900000, // 15 minutes (real pipeline)
  use: {
    baseURL: "http://localhost:3000",
    browserName: "chromium",
    viewport: { width: 1920, height: 1080 },
  },
  webServer: {
    command: "DEMO_MODE=true npm run dev",
    port: 3000,
    reuseExistingServer: true,
    timeout: 30000,
    env: {
      DEMO_MODE: "true",
    },
  },
});
