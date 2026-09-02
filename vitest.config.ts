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
      // cascade.mjs (TEAM-3618 D3) — the shared unblock cascade behind both
      // "ticket done" paths. Fully dependency-injected (stub ddb/provider/event
      // publisher + fake clock), so the union + extended-state logic is
      // unit-testable with no AWS.
      "lambda/orchestrator/cascade.test.mjs",
      // done-handlers-cascade (TEAM-3688 F3) — HANDLER-level cascade coverage.
      // Invokes the REAL handleTicketDoneUnified + handleTicketDone from index.mjs
      // through the REAL cascade (cascade.mjs/lease.mjs unmocked; only AWS/store
      // seams stubbed), proving BOTH done paths drive the unblock cascade.
      "lambda/orchestrator/done-handlers-cascade.test.mjs",
      // review-cap.mjs (TEAM-3619 D2c) — the review→rework round cap. Same DI
      // shape as the cascade (stub store/event publisher/roster + fake clock).
      // Its ship-review.mjs arithmetic port is pinned against the TS original by
      // the auto-included src/lib/workflow/ship-review-parity.test.ts.
      "lambda/orchestrator/review-cap.test.mjs",
      // completion.mjs (TEAM-3619 D4c) — the pure per-phase re-verify behind
      // isWorkflowComplete (done work + approved gates + no open fixes). Plain
      // data in, boolean out; no AWS.
      "lambda/orchestrator/completion.test.mjs",
      // review-rejection (TEAM-3619 D2c/D4c) — the orchestrator caller of the
      // review cap: escalation short-circuit + the review_fix reopen stamp.
      // index.mjs imported for real with its AWS/store/cap seams mocked.
      "lambda/orchestrator/review-rejection.test.mjs",
      // completion-gates (TEAM-3686 F3/F4) — the orchestrator's evidence gate
      // in completeWorkflow and the fix-spawn completion re-check. Same harness
      // as review-rejection: index.mjs real, AWS/store seams mocked.
      "lambda/orchestrator/completion-gates.test.mjs",
      // evidence-harvest — markTaskComplete pulls the agent's report_completion
      // record (S3 completions/{tid}.json) into agentTasks so the evidence gate
      // has something to read on the done cascade. Same harness as
      // done-handlers-cascade: real handlers, mocked I/O seams.
      "lambda/orchestrator/evidence-harvest.test.mjs",
      // agentcore-hub-tickets create_ticket (TEAM-3619 D4c) — the spawnedBy/phase
      // pass-through that lets agent-filed QA/review fixes gate completion.
      // Handler driven with a stub DDB doc client; no AWS.
      "lambda/agentcore-hub-tickets/index.test.mjs",
    ],
    // Keep unit tests away from the Playwright specs under tests/.
    exclude: ["tests/**", "node_modules/**", "demo/**"],
  },
});
