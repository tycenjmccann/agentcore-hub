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
    // lambda/**: the eval-packager's classifiers are pure ESM with zero AWS
    // imports precisely so they can be unit-tested here rather than in a
    // per-Lambda jest setup.
    // deploy/telegram-bug-intake/**: the intake Lambda's AWS imports are mocked
    // at the module seam, so its voice/Transcribe contract is testable here too.
    include: [
      "src/**/*.test.ts",
      "lambda/eval-packager/**/*.test.mjs",
      "deploy/telegram-bug-intake/**/*.test.mjs",
      // workflow-store is pure DDB-command construction — unit-testable with a
      // stub client, same rationale as the eval-packager classifiers.
      "lambda/orchestrator/workflow-store.test.mjs",
      // lease.mjs is the orchestrator port of the lease primitives (TEAM-3618)
      // — pure liveness math + DDB-command construction, stub-client testable.
      // Its parity with src/lib/workflow/lease.ts is asserted by the auto-
      // included src/lib/workflow/lease-parity.test.ts.
      "lambda/orchestrator/lease.test.mjs",
      // watchdog.mjs mirrors the TS watchdog resolver (TEAM-3618 D1.1) — pure
      // config resolution, unit-testable via setWatchdogSource().
      "lambda/orchestrator/watchdog.test.mjs",
      // dead-session-detector.mjs (TEAM-3618 D1.2) — the sweep is fully
      // dependency-injected (stub ddb/store/lease + fake clock), so its
      // guard/trigger/retry/escalate logic is unit-testable with no AWS.
      "lambda/orchestrator/dead-session-detector.test.mjs",
    ],
    // Keep unit tests away from the Playwright specs under tests/.
    exclude: ["tests/**", "node_modules/**", "demo/**"],
  },
});
