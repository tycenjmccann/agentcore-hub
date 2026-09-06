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
      // artifact-chain.mjs — the playbook's committed-artifact chain (pure
      // helpers: owed artifacts per ticket, context block, gate overrides).
      "lambda/orchestrator/artifact-chain.test.mjs",
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
      // level-trigger-dispatch (TEAM-4060) — DI coverage for the dead-zone fix:
      // off|shadow|enforce, the already-Ready in-process dispatch, and non-fatal
      // isolation when dispatchReady (the claim-CAS webhook path) loses a race.
      "lambda/orchestrator/level-trigger-dispatch.test.mjs",
      // merge-on-green.mjs (TEAM-4110) — DI coverage for the auto-merge of a
      // human-approved, clean+green final PR: off | shadow | enforce (default
      // off, byte-identical), gate-must-be-done, mergeable_state:"clean" only,
      // exact-head-SHA merge, and non-fatal GitHub-refusal handling.
      "lambda/orchestrator/merge-on-green.test.mjs",
      // ship-head-stability.mjs (TEAM-4111) — DI coverage for the dispatch-time
      // head-stability gate: off (no probe, byte-identical) | shadow (measures
      // would-defer, always dispatches) | enforce (defer until head quiet +
      // CI green on that exact head). CI-red passes through, probe-throw and
      // maxDeferrals both fail open, unknown mode fails safe to off.
      "lambda/orchestrator/ship-head-stability.test.mjs",
      // ship-dispatch-gate.mjs (TEAM-4112) — DI coverage for the ship-dispatch
      // prerequisite gate: ship is gated iff a non-epic, completion-required,
      // present pre-ship-phase sibling is not terminal. Epics/other-ship-phase/
      // unclassifiable (human-gate) tickets never gate (fail-safe), absent phases
      // never wedge, repairBlocker prefers verification/CI, and mode normalization
      // is the same strict allow-list as ship-head (legacy on/true/1 → off).
      "lambda/orchestrator/ship-dispatch-gate.test.mjs",
      // rework-loop-cap.mjs (TEAM-4113) — the per-(workflow,phase) lineage
      // backstop the per-gate review-cap can't provide: counts fix tickets per
      // PHASE so a loop hopping ticket ids still accumulates. DI coverage of
      // off|shadow|enforce (fail-safe to SHADOW, opposite of the ship gates),
      // distinct-id round counting, DECISION: continue reset, idempotent
      // escalation, and ledger-failure fail-open.
      "lambda/orchestrator/rework-loop-cap.test.mjs",
      // rework-loop-replay (TEAM-4113) — a 9-round QA→dev runaway that files a
      // fresh fix ticket (new gate id) each round, replayed through the REAL
      // cap: asserts the lineage cap trips at maxRounds and signals ONCE, while
      // a per-gate-id ledger (the review-cap's keying) never reaches the cap.
      "lambda/orchestrator/rework-loop-replay.test.mjs",
      // jira-fix-label (TEAM-4113) — mapJiraIssueToTicket reconstructs an agent-
      // filed fix ticket's spawnedBy.kind from the `fix:<kind>` label the jira
      // tools Lambda stamps, so Jira-mode fixes gate completion + the rework cap
      // the same as DynamoDB mode. Pure map, no I/O.
      "lambda/orchestrator/jira-fix-label.test.mjs",
      // done-handlers-cascade (TEAM-3688 F3) — HANDLER-level cascade coverage.
      // Invokes the REAL handleTicketDoneUnified + handleTicketDone from index.mjs
      // through the REAL cascade (cascade.mjs/lease.mjs unmocked; only AWS/store
      // seams stubbed), proving BOTH done paths drive the unblock cascade.
      "lambda/orchestrator/done-handlers-cascade.test.mjs",
      // source-context (TEAM-4093, ship-review F2) — formatSourceLine, the "##
      // Input Sources" line the agent-context builder emits. Since TEAM-4054
      // made lenient mode the default, a failed reachability check only stamps
      // verification.status="unverified" + a redacted detail; this pins that the
      // verdict (and its bucket-policy hint) reaches the intake agent's prompt,
      // and that pre-TEAM-4054 rows with no `verification` field render as
      // before. Pure string rendering; index.mjs's AWS seams mocked for load.
      "lambda/orchestrator/source-context.test.mjs",
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
      // setup-pipeline-tools-lambda (TEAM-4122 FR-4) — the IAM policy as DATA:
      // buildInlinePolicy is pure, so the blast radius of PIPELINE_CI_START_BUILD
      // (StartBuild on the ONE validated PR-check ARN, never a deploy project,
      // never PutApprovalResult) is asserted rather than reviewed. Also pins the
      // byte-duplicated validateCiProjectName against the Lambda's copy. Import
      // is inert — main() is behind the argv guard.
      "deploy/setup-pipeline-tools-lambda.test.mjs",
      // pipeline-enabled (TEAM-3738, same defect class as TEAM-3723) — the
      // orchestrator's PIPELINE_ENABLED predicate that gates the "## Pipeline
      // Mode" context block. Lives in its own side-effect-free pipeline-enabled.mjs
      // (TEAM-3744) so this test never imports index.mjs's module-load AWS
      // client construction; isPipelineEnabled is pure, no I/O.
      "lambda/orchestrator/pipeline-enabled.test.mjs",
      // cd-registry.mjs — pure registry parsing / repo matching / ship-phase
      // stripping (which repos the hub merges + deploys); no I/O.
      "lambda/orchestrator/cd-registry.test.mjs",
      // event-id.mjs (TEAM-4120 FR-2) — the deterministic event id that collapses
      // the events table's EventBridge/direct double-write. Pure (node:crypto
      // only): determinism, the 13-digit-ms id shape the anomaly-watcher's
      // eventId range query depends on, byte-for-byte agreement with the
      // cost-report consumer-side dedupe key, and the fail-safe directions
      // (strict mode allow-list, agent.streaming + bad timestamp → random).
      "lambda/orchestrator/event-id.test.mjs",
      // events-writer (TEAM-4120 FR-2) — the EventBridge-fan-out half of the
      // double-write. Drives the REAL handler with a stub DDB doc client,
      // reloaded per EVENT_DEDUPE_MODE, to prove that under enforce its row key
      // equals the publisher's (so the Put overwrites instead of doubling) and
      // that off is byte-identical (base36 monotonic ids).
      "lambda/orchestrator/events-writer.test.mjs",
      // cd-handoff — index.mjs REAL, AWS/store seams mocked: an unregistered
      // repo gets no ship phase (Ship/CD tickets + Merge Approval gate resolved,
      // never dispatched/paged; intake context stops the chain at CI; completion
      // opens the handoff PR), a registered one keeps the full ship phase.
      "lambda/orchestrator/cd-handoff.test.mjs",
      // gate-state.mjs (TEAM-4120 FR-1) — the pure truth table behind the
      // review-gate guard (which `→ blocked` is a real human rejection vs a
      // creation block / redelivery / never-presented gate) plus the strict mode
      // allow-list. Zero imports, no I/O.
      "lambda/orchestrator/gate-state.test.mjs",
      // gate-state-guard (TEAM-4120 FR-1) — index.mjs REAL, AWS/store seams
      // mocked: proves off does ZERO extra I/O (no store.markGate*, no extra
      // workflow read, no gate.reject_ignored), that enforce admits a presented
      // gate exactly once and drops the duplicate/unrequested ones, and that
      // shadow records + reports but never drops. Both twins (Jira webhook +
      // DDB stream).
      "lambda/orchestrator/gate-state-guard.test.mjs",
      // replay-gate-state (TEAM-4120 FR-1 acceptance) — the gate history of REAL
      // runs (yteqfl + sffzti reduced dossiers, deduped by the real contentKey)
      // plus a reconstructed TEAM-4045-pattern run, replayed through the REAL
      // blocked twins: asserts the guard admits exactly as many rejections as a
      // human actually filed (zero, in every dossier we have), that the
      // creation-time block still costs no I/O, and that off is unchanged.
      "lambda/orchestrator/replay-gate-state.test.mjs",
      // dead-session-escalation (TEAM-4120 FR-3) — the page→synthesize→park tree,
      // fully DI: the mode normalizer's shadow-coalescing fail-safe, the redaction
      // table one vector per pattern (including a secret straddling the 600-char
      // clip boundary), child selection replayed against the REAL yteqfl ticket
      // set, the decision order (agent error > fresh record > children > park,
      // never Done on a stale/blank record), shadow's single write, and that no
      // dep failure can make it reject mid-sweep.
      "lambda/orchestrator/dead-session-escalation.test.mjs",
      // dead-session gate wake (TEAM-4120 FR-3) — index.mjs REAL, AWS/store seams
      // mocked: a human Done'ing an `Escalation: dead session on TEAM-x (agent)`
      // gate hands that ticket's retry budget back and announces the decision
      // WITHOUT re-dispatching anything (the gate's own cascade unblocks it), and
      // the release-manager escalation title still takes the TEAM-3971 branch.
      "lambda/orchestrator/dead-session-gate-wake.test.mjs",
      // replay-yteqfl-dead-session (TEAM-4120 FR-3 acceptance) — the real yteqfl
      // slice 06:51→07:36Z replayed through the REAL sweep → cascade → escalation
      // tree: the dead release manager's TEAM-4066 gets blocked on the six tickets
      // it spawned (both the AC's literal 4101/4102 pair and the full closure) and
      // ONE reconcile tick re-drives it when the last child lands — versus mode
      // off, where escalationHeld reproduces the 3h26m stall prod actually took.
      "lambda/orchestrator/replay-yteqfl-dead-session.test.mjs",
      // contract-warning (TEAM-4121 FR-8) — index.mjs REAL, AWS/store seams
      // mocked: a fix ticket filed under FIX_TICKET_CONTRACT=shadow republishes
      // its incompleteness as ONE `ticket.contract_warning` event on the run's own
      // stream (so shadow is measurable before enforce is switched on), in both
      // creation twins — the DDB-stream INSERT and the Jira webhook's todo — and
      // never fails to ROUTE the ticket when that advisory can't be published.
      "lambda/orchestrator/contract-warning.test.mjs",
      // workflow-output report_completion (TEAM-4121 FR-9) — the completion record
      // is what live-reverify.mjs reads to decide whether a "live" fix actually
      // produced live evidence, so the two new fields must be additive (a record
      // written without them keeps EXACTLY the pre-4121 key set) and closed (an
      // unrecognized evidence_kind is dropped with a warning, never stored). REAL
      // handler, AWS SDK mocked at the module seam.
      "lambda/workflow-output/index.test.mjs",
      // live-reverify (TEAM-4121 FR-9), unit level — the module is fully DI'd, so
      // this drives the REAL decision logic with hand-built deps and asserts the
      // CALLS: exactly one `Re-verify (QA): <fix> @ <sha7>` per (fix, head) with
      // the exact params, the independent `verification: "unverified"` mark when a
      // "live" fix closes with no live artifact, ship tickets blocked only while
      // open, shadow writing nothing, and the STRICT mode allow-list (garbage →
      // off, unlike every other flag) that keeps a typo from minting tickets.
      "lambda/orchestrator/live-reverify.test.mjs",
      // ticket-blockers.mjs (TEAM-4130 F1) — the blocker-edge write extracted out
      // of index.mjs's addBlockers so its two-attempt conditional write is
      // testable at all. Zero imports (the AWS command is constructed by the
      // caller and handed in as `send`), so the test's fake actually EVALUATES
      // the ConditionExpression against a row — the only way to assert that the
      // park-it and preserve-the-status conditions are mutually exclusive and
      // jointly exhaustive, which a read-then-write could not be.
      "lambda/orchestrator/ticket-blockers.test.mjs",
      // awaited-ids.mjs (TEAM-4166 D1) — the awaited-ids re-wake decision module.
      // Fully DI'd (no AWS): mode normalization, the off/shadow/enforce write
      // rules, the addBlockers seam contract (both return shapes), the
      // preconditionUnmet stamp, the once-only await-timeout CAS, and the EMF
      // record — all asserted under a jira == dynamodb provider parity loop.
      "lambda/orchestrator/awaited-ids.test.mjs",
      // report_precondition_unmet channel (TEAM-4166 §1.2) — the non-terminal
      // twin of report_completion. workflow-output/precondition-unmet: the REAL
      // handler's ONLY side effects are the annotate invoke + the journey event
      // (never a transition, never a completions/<id>.json write); parse/dedup/
      // cap/self-drop and the inferToolFromArgs routing that keeps awaiting_ids
      // off the completion path. The two annotate-precondition files pin each
      // ticket Lambda's action in isolation (DDB column merge / Jira labels +
      // marker + the label→awaitingIds round-trip). precondition-contract drives
      // BOTH ticket Lambdas under a `for (provider of [dynamodb, jira])` loop to
      // prove the SAME `{ ticketId, preconditionUnmet }` shape and that NEITHER
      // transitions — the parity workflow-output relies on to stay backend-blind.
      "lambda/workflow-output/precondition-unmet.test.mjs",
      "lambda/agentcore-hub-tickets/annotate-precondition.test.mjs",
      "lambda/agentcore-hub-jira/annotate-precondition.test.mjs",
      "lambda/agentcore-hub-jira/precondition-contract.test.mjs",
      // yteqfl loop 2 replay (TEAM-4121 FR-9) — the real prod failure this FR
      // exists for, from the dossier fixture: TEAM-4089 closed claiming live
      // evidence with none, QA re-verify TEAM-4092 caught it 48m later and filed
      // TEAM-4105 as a fresh loop. Under enforce the re-verification is filed at
      // Done (sha 0949f9d), the fix is marked unverified, the open ship ticket
      // TEAM-4066 is blocked, and re-running the trigger is `already` — so
      // TEAM-4105's loop never starts. Off mode reproduces prod byte-identically.
      "lambda/orchestrator/replay-yteqfl-reverify.test.mjs",
      // `## Unverified Fixes` ship context (TEAM-4121 FR-9) — REAL buildAgentContext
      // from index.mjs: the block renders for a ship-phase agent under enforce with
      // the ticket id, sha7, re-verify id and a SANITIZED repro (it is another
      // agent's claim, so backticks/newlines are stripped and it is labelled as one),
      // and is absent for non-ship agents, for mode off, and when nothing is
      // unverified — the "off costs nothing in the prompt" half of the flag.
      "lambda/orchestrator/unverified-fixes-context.test.mjs",
      // ci-check.mjs (TEAM-4122 FR-5) — the dispatch-time "can a CodeBuild build
      // for this head SHA exist at all?" probe. Fully DI'd (plain deps + fake
      // clock + stub store), so every branch runs with no AWS: the strict mode
      // allow-list (garbage → off, because enforce labels a real epic), the
      // never-warn-on-unknown direction, the 6h/30min TTL cache that keeps a
      // 14-ticket run to one probe, and the F10 boundary — a project description
      // carries webhook.url/secret + every env var, and the assertion is on
      // JSON.stringify(result) because that record is persisted, logged AND
      // rendered into every agent's prompt.
      "lambda/orchestrator/ci-check.test.mjs",
      // ci-check wiring (TEAM-4122 FR-5) — index.mjs REAL, AWS/store seams
      // mocked: the ## CI Certification block only appears on a pipeline-mode
      // run, mode off does ZERO extra I/O (asserted as zero calls on the
      // codebuild/lambda/setCiCheck seams, i.e. byte-identical to pre-4122),
      // enforce labels the epic ci:uncertifiable exactly ONCE per workflow while
      // shadow never writes, and the human merge gate's ping/comment/package
      // carries the ⚠ CI UNCERTIFIABLE prefix.
      "lambda/orchestrator/ci-check-context.test.mjs",
      // sync-main.mjs (TEAM-4122 FR-6) — merge the default branch INTO the run's
      // integration branch before CI certifies its head. Fully DI'd (plain deps +
      // a recording GitHub fake keyed by `METHOD path`), which is what makes the
      // dangerous matrix cheap to pin: the F9 direction lock (base is always the
      // feature branch, so this can never push to main) and its refusals, the
      // percent-encoding of every path segment, the merge-head idempotency key,
      // 201/204/409 and the fail-OPEN behaviour of every other status, and the
      // 409 path end to end — one sync_fix ticket whose fix_contract is checked
      // with the tickets Lambda's own validateFixContract.
      "lambda/orchestrator/sync-main.test.mjs",
      // pre-CI sync replay (TEAM-4122 FR-6 acceptance) — index.mjs REAL on its
      // Jira-webhook entry (handleTicketReadyUnified), only fetch/AWS/store
      // mocked, driven with the wf_1788582225496_yteqfl loop-6 fixture where the
      // run's CI agent had to file TEAM-4106 ("merge origin/main into
      // feature/TEAM-4054…") by hand. Under enforce a conflict files EXACTLY ONE
      // sync_fix ticket, blocks TEAM-4065 on it and never reaches the agent-invoke
      // seam (no green certification of a SHA that would not land); a webhook
      // REDELIVERY files no second ticket; landing the fix dispatches CI once.
      "lambda/orchestrator/replay-yteqfl-sync-main.test.mjs",
      // ADVISORY_ROUTING wiring (TEAM-4122 FR-7) — index.mjs REAL, AWS/store/cap
      // seams mocked. completion.test.mjs owns the pure filter; what only shows
      // up here is the plumbing: the `## Branch` block an advisory ticket's dev
      // is handed (`feature/<id>-advisory` off the DEFAULT branch, advisory NOTE,
      // no shared-integration NOTE) versus a non-advisory block asserted
      // BYTE-IDENTICAL to mode off by string comparison, the refusal to ever adopt
      // a `-advisory` branch as a run's shared integration branch (the ported-
      // session path, the one place a branch name comes from outside), and that
      // the ship review's change set enumerates its own PR's files only — so an
      // advisory branch's files cannot enter the reviewed diff.
      "lambda/orchestrator/advisory-routing.test.mjs",
    ],
    // Keep unit tests away from the Playwright specs under tests/.
    exclude: ["tests/**", "node_modules/**", "demo/**"],
  },
});
