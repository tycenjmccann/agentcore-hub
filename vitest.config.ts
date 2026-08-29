import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Hermetic unit tests for the pieces whose logic is easy to get subtly wrong and
 * expensive to get wrong in prod: the tenant S3-key layout + path-traversal
 * guard, the HMAC state-token round-trip (SSO emails carry `.`, the token
 * delimiter), the SSE frame plumbing the chat stream rides on, and the
 * optimistic-concurrency CAS that serializes the /stop vs /message write race.
 *
 * No AWS, no server, no network — safe to run on every push (see ci.yml). The
 * `@/…` alias mirrors tsconfig so tests import the same modules the app does.
 */
export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "evals/battery/**/*.test.ts",
      // Deploy-guard tests: bash subprocess + fixture repos + PATH-shimmed
      // fake gh — still hermetic (no AWS, no network).
      "deploy/lib/__tests__/**/*.test.ts",
      // lambda/**: the eval-packager's classifiers are pure ESM with zero AWS
      // imports precisely so they can be unit-tested here rather than in a
      // per-Lambda jest setup.
      "lambda/eval-packager/**/*.test.mjs",
    ],
    // Keep unit tests away from the Playwright specs under tests/.
    exclude: ["tests/**", "node_modules/**", "demo/**"],
  },
});
