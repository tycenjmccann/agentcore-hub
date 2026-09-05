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
      // Config-evals battery (evals/battery/): runner math, scoring, gate rules
      // — hermetic (mock transport, no Bedrock).
      "evals/battery/**/*.test.ts",
      // Deploy-guard tests: bash subprocess + fixture repos + PATH-shimmed
      // fake gh — still hermetic (no AWS, no network).
      "deploy/lib/__tests__/**/*.test.ts",
      "lambda/eval-packager/**/*.test.mjs",
      "deploy/telegram-bug-intake/**/*.test.mjs",
      // workflow-store is pure DDB-command construction — unit-testable with a
      // stub client, same rationale as the eval-packager classifiers.
      "lambda/orchestrator/workflow-store.test.mjs",
      // repo-check.mjs — the dispatch-time repo URL pre-flight (mirror of
      // src/lib/workflow/repo-check.ts); fetch is injected, so no network.
      "lambda/orchestrator/repo-check.test.mjs",
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
      // detector-mode-default (TEAM-3763 F1) — the index.mjs sweep-dispatch
      // default: DEAD_SESSION_DETECTOR_MODE coalesces to "shadow" (observe-only)
      // when unset, so a fresh deploy stays dark. Drives the real handler with
      // the sweep sentinel and a mocked detector to observe the exact mode
      // forwarded to runSweep.
      "lambda/orchestrator/detector-mode-default.test.mjs",
      // sweep-mode-defaults (TEAM-3763 F2/F6) — the index.mjs defaults for the two
      // dark-by-default sweeps: RECONCILE_SWEEP_MODE unset → "off" (the sweep is
      // now scheduled) and CASCADE_EXTENDED_STATES unset → "off". Drives the real
      // handler with the reconcile_sweep sentinel (mocked cascade + reconcile
      // factories) to observe the modes index resolves before dispatch.
      "lambda/orchestrator/sweep-mode-defaults.test.mjs",
      // agent-invoker-retry (TEAM-3748 D4.2) — bounded transient-5xx retry at the
      // invoke boundary + the D4.3 publishAgentEvent dual-write. Drives the real
      // agent-invoker handler through the harness path with the AgentCore client
      // mocked to throw controlled errors; classification + escalation + the
      // EventBridge/EVENTS_TABLE dual-write are all exercised end-to-end.
      "lambda/orchestrator/agent-invoker-retry.test.mjs",
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
      // ticket-done-blocked-terminal (TEAM-3755 F3) — the contract behind
      // markTaskComplete's unconditional "done": a ticket done whose completion
      // record carries a SHIP_BLOCKED outcome must ALWAYS close the run on a
      // blocked terminal phase, never "complete". Drives BOTH done handlers
      // end-to-end (real markTaskComplete → harvest → ship gate →
      // closeWorkflowBlocked) and pins F1 (commit_sha alone is not a merge).
      "lambda/orchestrator/ticket-done-blocked-terminal.test.mjs",
      // reconcile-sweep.mjs (TEAM-3747 D1) — the scheduled missed-unblock sweep.
      // Fully dependency-injected (stub ddb/cascade/lease + fake clock), same
      // shape as the dead-session detector: shadow/enforce modes, per-candidate
      // classification, and the metrics summary.
      "lambda/orchestrator/reconcile-sweep.test.mjs",
      // replay-d1 (TEAM-3747 D1, AC-D1.2) — three real stalled production runs
      // replayed through the cascade + sweep as plain-object fixtures; asserts
      // ZERO manual re-dispatches. DI only, no AWS.
      "lambda/orchestrator/replay-d1.test.mjs",
      // replay-d2 (TEAM-3747 D2, AC-D2.1/2/3) — three real runs that closed
      // GREEN over unshipped work, replayed through the REAL completeWorkflow;
      // asserts each closes on an honest terminal outcome instead. Same harness
      // as completion-gates: index.mjs real, AWS/store seams mocked.
      "lambda/orchestrator/replay-d2.test.mjs",
      // replay-d3 (TEAM-3748 D3, AC-D3.1) — the ztc61f ship review that never
      // converges, replayed through the REAL review-cap via handleReviewRejection
      // (review-cap.mjs unmocked; only AWS/store seams stubbed). The inverse of
      // replay-d1/d2: asserts 3 in-diff CHANGES-NEEDED rounds STOP the loop —
      // cap-reached fires once, the upstream re-open is suppressed, no round 4.
      "lambda/orchestrator/replay-d3.test.mjs",
      // agentcore-hub-tickets create_ticket (TEAM-3619 D4c) — the spawnedBy/phase
      // pass-through that lets agent-filed QA/review fixes gate completion.
      // Handler driven with a stub DDB doc client; no AWS.
      "lambda/agentcore-hub-tickets/index.test.mjs",
      // agentcore-hub-pipeline-tools (TEAM-3822) — the CD tools Lambda: the
      // execution-scoped get_state race fix (matchesExecution), the
      // get_build_status scan clamp, and the start_deploy clientRequestToken
      // idempotency. AWS SDK clients mocked at the module seam, same shape as
      // agent-invoker-retry.
      "lambda/agentcore-hub-pipeline-tools/index.test.mjs",
      // pipeline-enabled (TEAM-3738, same defect class as TEAM-3723) — the
      // orchestrator's PIPELINE_ENABLED predicate that gates the "## Pipeline
      // Mode" context block. Lives in its own side-effect-free pipeline-enabled.mjs
      // (TEAM-3744) so this test never imports index.mjs's module-load AWS
      // client construction; isPipelineEnabled is pure, no I/O.
      "lambda/orchestrator/pipeline-enabled.test.mjs",
    ],
    // Keep unit tests away from the Playwright specs under tests/.
    exclude: ["tests/**", "node_modules/**", "demo/**"],
  },
});
