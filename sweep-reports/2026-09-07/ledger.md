| # | Tool(s) | Rule | Location | Symbol | Verdict | Evidence |
|---:|---|---|---|---|---|---|
| 1 | knip-root | Unused files | demo/playwright.config.ts | demo/playwright.config.ts | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=4 |
| 2 | knip-root | Unused files | demo/playwright/playwright.config.ts | demo/playwright/playwright.config.ts | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=4 |
| 3 | knip-root | Unused files | demo/playwright/test-popup.spec.ts | demo/playwright/test-popup.spec.ts | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 4 | knip-root | Unused files | demo/playwright/test-s3-modal.spec.ts | demo/playwright/test-s3-modal.spec.ts | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 5 | knip-root | Unused files | demo/playwright/v4/check-layout.spec.ts | demo/playwright/v4/check-layout.spec.ts | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 6 | knip-root | Unused files | demo/playwright/v4/playwright-v4.config.ts | demo/playwright/v4/playwright-v4.config.ts | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=4 |
| 7 | knip-root | Unused files | demo/playwright/v4/record-demo-v4.spec.ts | demo/playwright/v4/record-demo-v4.spec.ts | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 8 | knip-root | Unused files | demo/playwright/v4/test-agent-streaming.spec.ts | demo/playwright/v4/test-agent-streaming.spec.ts | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 9 | knip-root | Unused files | demo/playwright/v4/test-lambda-orchestration.spec.ts | demo/playwright/v4/test-lambda-orchestration.spec.ts | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 10 | knip-root | Unused files | demo/record.spec.ts | demo/record.spec.ts | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=3 |
| 11 | knip-root | Unused files | deploy/pipeline/bin/pipeline.ts | deploy/pipeline/bin/pipeline.ts | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 12 | knip-root | Unused files | deploy/pipeline/harness-snapshot.mjs | deploy/pipeline/harness-snapshot.mjs | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 13 | knip-root | Unused files | deploy/pipeline/lib/pipeline-stack.ts | deploy/pipeline/lib/pipeline-stack.ts | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 14 | knip-root | Unused files | deploy/pipeline/restore-harness.mjs | deploy/pipeline/restore-harness.mjs | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 15 | knip-root | Unused files | deploy/routine-builder/setup-routine-builder.mjs | deploy/routine-builder/setup-routine-builder.mjs | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=2, vitest.config.ts=0 |
| 16 | knip-root | Unused files | deploy/runtime-agent/healthcheck-fixtures/buggy-component.tsx | deploy/runtime-agent/healthcheck-fixtures/buggy-component.tsx | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 17 | knip-root | Unused files | deploy/runtime-agent/healthcheck-fixtures/fixed-component.tsx | deploy/runtime-agent/healthcheck-fixtures/fixed-component.tsx | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 18 | knip-root | Unused files | deploy/setup-builder-agent.mjs | deploy/setup-builder-agent.mjs | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=2, vitest.config.ts=0 |
| 19 | knip-root | Unused files | deploy/setup-tickets-lambda.mjs | deploy/setup-tickets-lambda.mjs | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=2, vitest.config.ts=0 |
| 20 | knip-root | Unused files | deploy/workflow-manager/setup-workflow-manager.mjs | deploy/workflow-manager/setup-workflow-manager.mjs | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=2, vitest.config.ts=0 |
| 21 | knip-root | Unused files | evals/battery/fixtures/fix-null-session-crash-001/session-utils.ts | evals/battery/fixtures/fix-null-session-crash-001/session-utils.ts | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=5 |
| 22 | knip-root | Unused files | evals/battery/fixtures/fix-pagination-offbyone-002/pagination.ts | evals/battery/fixtures/fix-pagination-offbyone-002/pagination.ts | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=3 |
| 23 | knip-root | Unused files | evals/battery/fixtures/fix-race-condition-cas-003/store.ts | evals/battery/fixtures/fix-race-condition-cas-003/store.ts | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=4 |
| 24 | knip-root | Unused files | lambda/agentcore-hub-jira/index.test.mjs | lambda/agentcore-hub-jira/index.test.mjs | KEEP-H11/H14 | H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 25 | knip-root | Unused files | lambda/anomaly-watcher/detect.test.mjs | lambda/anomaly-watcher/detect.test.mjs | KEEP-H11/H14 | H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 26 | knip-root | Unused files | lambda/anomaly-watcher/index.test.mjs | lambda/anomaly-watcher/index.test.mjs | KEEP-H11/H14 | H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 27 | knip-root | Unused files | lambda/builder-tools/index.mjs | lambda/builder-tools/index.mjs | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=4 |
| 28 | knip-root | Unused files | lambda/cost-report/index.test.mjs | lambda/cost-report/index.test.mjs | KEEP-H11/H14 | H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 29 | knip-root | Unused files | lambda/cost-report/pricing.test.mjs | lambda/cost-report/pricing.test.mjs | KEEP-H11/H14 | H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 30 | knip-root | Unused files | lambda/orchestrator/model-router.mjs | lambda/orchestrator/model-router.mjs | KEEP-H11/H14 | documented test-only (check-lambda-zip-manifest.sh:13-14); deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 31 | knip-root | Unused files | lambda/orchestrator/model-router.test.mjs | lambda/orchestrator/model-router.test.mjs | KEEP-H11/H14 | H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 32 | knip-root | Unused files | lambda/prd-submitter/index.mjs | lambda/prd-submitter/index.mjs | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=4 |
| 33 | knip-root | Unused files | lambda/routines-runner/index.mjs | lambda/routines-runner/index.mjs | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=4 |
| 34 | knip-root | Unused files | lambda/routines-runner/index.test.mjs | lambda/routines-runner/index.test.mjs | KEEP-H11/H14 | H13 standalone suite run by `node --test`/vitest include; deploy.sh basename hits=0; surfaces.json basename hits=0 |
| 35 | knip-root | Unused files | lambda/token-aggregator/index.mjs | lambda/token-aggregator/index.mjs | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=4 |
| 36 | knip-root | Unused files | lambda/workflow-analyzer/index.mjs | lambda/workflow-analyzer/index.mjs | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=4 |
| 37 | knip-root | Unused files | scripts/backfill-workflow-tombstones.mjs | scripts/backfill-workflow-tombstones.mjs | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 38 | knip-root | Unused files | scripts/migrate-default-identity.mjs | scripts/migrate-default-identity.mjs | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=4 |
| 39 | knip-root | Unused files | src/components/workflow/PipelineVisualization.tsx | src/components/workflow/PipelineVisualization.tsx | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 40 | knip-root | Unused files | src/lib/models/harness-models.ts | src/lib/models/harness-models.ts | KEEP-ambiguous | 0 non-definition hits; not removed this sweep — default KEEP — conservative; candidate for the next sweep |
| 41 | knip-root | Unused devDependencies | package.json:69:6 | depcheck | KEEP-H5 | sweep tooling, invoked via npx |
| 42 | knip-root | Unused devDependencies | package.json:75:6 | ts-prune | KEEP-H5 | sweep tooling, invoked via npx |
| 43 | knip-root | Unlisted dependencies | evals/battery/lib/cases.mjs:91:29 | ajv/dist/2020 | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 44 | knip-root | Unlisted dependencies | evals/battery/lint-fixtures.mjs:53:27 | ajv/dist/2020 | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 45 | knip-root | Unlisted dependencies | lambda/anomaly-watcher/index.mjs:627:31 | js-yaml | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 46 | knip-root | Unlisted dependencies | lambda/orchestrator/agent-invoker.mjs:150:11 | @smithy/node-http-handler | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 47 | knip-root | Unlisted binaries | deploy/lib/__tests__/check-eval-gate.test.ts | script | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 48 | knip-root | Unlisted binaries | deploy/lib/__tests__/check-eval-gate.test.ts | setsid | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 49 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/agent-runner.mjs:22:14 | PRICING_PER_MTOK | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 50 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/agent-runner.mjs:37:14 | MAX_TURNS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 51 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/agent-runner.mjs:85:14 | INFRA_RETRY_DELAY_MS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 52 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/cases.mjs:12:14 | PERSONA_EVALUATOR_ID | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 53 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/cases.mjs:15:14 | batteryDir | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 54 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/cases.mjs:87:17 | loadCaseValidator | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 55 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/cases.mjs:100:17 | loadBattery | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 56 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/cases.mjs:276:17 | defaultGitShow | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 57 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/mock-transport.mjs:25:14 | MOCK_DEFAULT | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 58 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/mock-transport.mjs:28:14 | SENSITIVE_EVALUATORS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 59 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/redact.mjs:14:14 | GITHUB_OWNER_ALLOWLIST | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 60 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/scoring.mjs:19:14 | JUDGE_MAX_TOKENS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 61 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/scoring.mjs:21:14 | CUSTOM_EVALUATOR_ID | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 62 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/scoring.mjs:83:17 | builtinInstruction | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=8 |
| 63 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/scoring.mjs:92:14 | HTTP_CONNECTION_TIMEOUT_MS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 64 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/scoring.mjs:93:14 | HTTP_REQUEST_TIMEOUT_MS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 65 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/scoring.mjs:94:14 | SDK_MAX_ATTEMPTS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 66 | knip-root, ts-prune-root | Unused exports, Unused export | evals/battery/lib/thresholds.mjs:5:14 | SCALE | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 67 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:72:14 | REWORK_FIX_KINDS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 68 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:86:14 | SPAWN_ORIGIN_KEYS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 69 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:94:14 | SPAWN_EXTRA_KEYS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 70 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:100:14 | EVIDENCE_SOURCES | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 71 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:102:14 | CONTRACT_VERSION | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 72 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:109:14 | SYSTEM_LABEL_PREFIXES | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 73 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:138:14 | RESERVED_ADVISORY_LABEL | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 74 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:395:17 | parseFixContractBlock | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 75 | knip-root | Unused exports | lambda/agentcore-hub-jira/fix-contract.mjs:506:17 | advisoryIsReserved | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 76 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:66:14 | FIX_KINDS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 77 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:72:14 | REWORK_FIX_KINDS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 78 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:76:14 | KIND_TO_ORIGIN_KEY | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 79 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:86:14 | SPAWN_ORIGIN_KEYS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 80 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:94:14 | SPAWN_EXTRA_KEYS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 81 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:100:14 | EVIDENCE_SOURCES | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 82 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:102:14 | CONTRACT_VERSION | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 83 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:109:14 | SYSTEM_LABEL_PREFIXES | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 84 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:138:14 | RESERVED_ADVISORY_LABEL | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 85 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:140:14 | TICKET_KEY_RE | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 86 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:347:17 | renderFixContractBlock | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 87 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:395:17 | parseFixContractBlock | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 88 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:482:17 | contractLabels | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 89 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:506:17 | advisoryIsReserved | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 90 | knip-root | Unused exports | lambda/agentcore-hub-tickets/fix-contract.mjs:574:17 | escapeJql | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 91 | knip-root | Unused exports | lambda/anomaly-watcher/bands-schema.mjs:28:14 | VERIFIED_EVENT_TYPES | KEEP-H11/H14 | surfaces.json entry bands-schema.mjs; surfaces.json basename hits=1 |
| 92 | knip-root | Unused exports | lambda/anomaly-watcher/detect.mjs:30:14 | MAX_OPEN_PAIRS | KEEP-H11/H14 | surfaces.json entry detect.mjs; surfaces.json basename hits=1 |
| 93 | knip-root | Unused exports | lambda/anomaly-watcher/detect.mjs:32:14 | MAX_CONTRIBUTORS | KEEP-H11/H14 | surfaces.json entry detect.mjs; surfaces.json basename hits=1 |
| 94 | knip-root | Unused exports | lambda/anomaly-watcher/detect.mjs:75:17 | hourBucket | KEEP-H11/H14 | surfaces.json entry detect.mjs; surfaces.json basename hits=1 |
| 95 | knip-root | Unused exports | lambda/orchestrator/artifact-chain.mjs:19:14 | ARTIFACT_CHAIN_GATE_MODES | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 96 | knip-root | Unused exports | lambda/orchestrator/artifact-chain.mjs:72:14 | CODE_REVIEWER_AGENT | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 97 | knip-root | Unused exports | lambda/orchestrator/artifact-chain.mjs:73:14 | PLAN_TICKET_TITLE | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 98 | knip-root | Unused exports | lambda/orchestrator/cascade.mjs:685:17 | hasCascadeActivity | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 99 | knip-root | Unused exports | lambda/orchestrator/cascade.mjs:700:17 | emitCascadeMetrics | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 100 | knip-root | Unused exports | lambda/orchestrator/dead-session-detector.mjs:560:17 | emitMetrics | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 101 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:66:14 | FIX_KINDS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 102 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:72:14 | REWORK_FIX_KINDS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 103 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:86:14 | SPAWN_ORIGIN_KEYS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 104 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:94:14 | SPAWN_EXTRA_KEYS | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 105 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:100:14 | EVIDENCE_SOURCES | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 106 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:102:14 | CONTRACT_VERSION | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 107 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:109:14 | SYSTEM_LABEL_PREFIXES | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 108 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:138:14 | RESERVED_ADVISORY_LABEL | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 109 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:173:17 | normalizeContractMode | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 110 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:482:17 | contractLabels | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 111 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:506:17 | advisoryIsReserved | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 112 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:526:17 | sanitizeUserLabels | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 113 | knip-root | Unused exports | lambda/orchestrator/fix-contract.mjs:574:17 | escapeJql | KEEP-H12-fix-contract | byte-compared triplicate; scripts/check-fix-kinds-parity.sh |
| 114 | knip-root | Unused exports | lambda/orchestrator/reconcile-sweep.mjs:255:17 | emitReconcileMetrics | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 115 | knip-root | Unused exports | lambda/orchestrator/repo-check.mjs:100:23 | checkRepoConfig | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=2 |
| 116 | knip-root, ts-prune-root | Unused exports, Unused export | lambda/orchestrator/review-cap.mjs:396:17 | emitReviewCapMetrics | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 117 | knip-root, ts-prune-root | Unused exports, Unused export | lambda/orchestrator/review-cap.mjs:435:17 | emitReviewCapFailOpenMetrics | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 118 | knip-root | Unused exports | lambda/orchestrator/sync-main.mjs:102:14 | MAX_SYNC_FIX_ROUNDS | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 119 | knip-root | Unused exports | lambda/orchestrator/watchdog.mjs:45:17 | _getWatchdogSource | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 120 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/artifacts.ts:41:14 | DEFAULT_FILE_CAP_BYTES | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 121 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/artifacts.ts:42:14 | DEFAULT_TOTAL_CAP_BYTES | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 122 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/artifacts.ts:43:14 | DEFAULT_FILE_COUNT_CAP | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 123 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/artifacts.ts:370:17 | safeRelPath | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 124 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/git.ts:53:17 | parseRepo | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 125 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/git.ts:65:17 | normalizeCloneUrl | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 126 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/git.ts:106:23 | canPushToOrigin | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 127 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/transcript.ts:18:17 | slugForPath | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 128 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/transcript.ts:22:23 | projectDirFor | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 129 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/cloud-code/transcript.ts:52:23 | localTranscriptPath | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 130 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:3:14 | RepoTargetSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 131 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:10:14 | RepoConfigSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 132 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:31:14 | IntakeSourceSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 133 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:49:14 | ModelOverrideSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 134 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:62:14 | PortedSessionSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 135 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:73:14 | IntentBriefSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 136 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:82:14 | WorkflowInputSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 137 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:132:14 | RoutineScheduleSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 138 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exports, Unused export | mcp/hub/src/workflow/schemas.ts:140:14 | RoutineInputTemplateSchema | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 139 | knip-root, ts-prune-root | Unused exports, Unused export | src/components/cloud-code/CliBrand.tsx:9:14 | CLI_BRAND | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 140 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/agentcore-sdk.ts:94:17 | getMemoryMapping | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 141 | knip-root | Unused exports | src/lib/agentcore-sdk.ts:141:17 | getLogsClient | KEEP-referenced | 12 non-definition hits; first: src/app/api/agentcore/metrics/route.ts:22 |
| 142 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/auth/identity.ts:50:17 | authDisabled | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 143 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/auth/resolver.ts:14:17 | authMode | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 144 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/cd-registry.ts:46:14 | CD_REGISTRY_KEY | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 145 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/client-cache.ts:75:17 | invalidateCache | REMOVED | git grep -n -w -- 'invalidateCache' origin/main → 1 hits, all definition/unrelated same-name locals; commit 3608447 |
| 146 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/cloud-code/config-store.ts:47:14 | DEFAULT_SCOPE | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 147 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/connectors/secrets.ts:17:17 | secretIdFor | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 148 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/connectors/store.ts:23:23 | readRegistry | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 149 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/pipeline-config.ts:83:14 | TOOL_ICON_MAP | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 150 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/pipeline-config.ts:126:14 | PHASE_DISPLAY_META | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 151 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/pipeline-config.ts:447:14 | PIPELINE_PHASES | REMOVED | git grep -n -w -- 'PIPELINE_PHASES' origin/main → 2 hits, all definition/unrelated same-name locals; commit f3ef1e4 |
| 152 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/routines/schedule.ts:40:17 | scheduleNameFor | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 153 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/routines/store.ts:23:10 | DEFAULT_USER_ID | REMOVED | git grep -n -w -- 'DEFAULT_USER_ID' origin/main → 23 hits, all definition/unrelated same-name locals; commit aa416ae |
| 154 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/routines/store.ts:23:27 | DEFAULT_TENANT_ID | REMOVED | git grep -n -w -- 'DEFAULT_TENANT_ID' origin/main → 45 hits, all definition/unrelated same-name locals; commit aa416ae |
| 155 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/routines/store.ts:37:23 | getRoutine | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 156 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/utils.ts:8:17 | formatDuration | REMOVED | git grep -n -w -- 'formatDuration' origin/main → 9 hits, all definition/unrelated same-name locals; commit 52f0225 |
| 157 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/utils.ts:15:17 | truncate | REMOVED | git grep -n -w -- 'truncate' origin/main → 54 hits, all definition/unrelated same-name locals; commit 52f0225 |
| 158 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/intake.ts:19:10 | redactUrl | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 159 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/jira-client.ts:11:14 | JIRA_STATUS_TO_INTERNAL | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 160 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/jira-client.ts:25:14 | INTERNAL_STATUS_TO_JIRA | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 161 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/performance.ts:83:14 | FLEET_KPIS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 162 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/performance.ts:101:14 | BASELINE_DAYS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 163 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/performance.ts:102:14 | BASELINE_MIN | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 164 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/performance.ts:113:17 | quantile | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 165 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/performance.ts:154:17 | getPath | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 166 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/performance.ts:217:17 | isValidCard | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 167 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/roster-loader.ts:22:23 | loadRoster | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 168 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/source-shape.ts:29:14 | INTAKE_SOURCE_TYPES | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 169 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/workflow-defs.ts:280:17 | sdlcFrameworkForDef | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 170 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/workflow-defs.ts:285:17 | isHumanAssignee | REMOVED | git grep -n -w -- 'isHumanAssignee' origin/main → 10 hits, all definition/unrelated same-name locals; commit ce9ba18 |
| 171 | knip-root, ts-prune-root | Unused exports, Unused export | src/lib/workflow/workspace.ts:36:23 | writeArtifact | REMOVED | git grep -n -w -- 'writeArtifact' origin/main → 1 hits, all definition/unrelated same-name locals; commit ce9ba18 |
| 172 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exported types, Unused export | mcp/hub/src/cloud-code/artifacts.ts:45:13 | ArtifactKind | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 173 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exported types, Unused export | mcp/hub/src/cloud-code/artifacts.ts:47:18 | ArtifactCandidate | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 174 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exported types, Unused export | mcp/hub/src/cloud-code/cli-config.ts:26:13 | ServerCategory | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 175 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exported types, Unused export | mcp/hub/src/cloud-code/cli-config.ts:27:13 | ServerTransport | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 176 | knip-root, knip-mcp-hub, ts-prune-mcp-hub | Unused exported types, Unused export | mcp/hub/src/cloud-code/cli-config.ts:36:18 | ClassifiedServer | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 177 | knip-root, ts-prune-root | Unused exported types, Unused export | src/components/workflow/useWorkflowStream.ts:6:13 | StreamStatus | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 178 | knip-root, ts-prune-root | Unused exported types, Unused export | src/config/modules.ts:28:13 | ModuleId | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 179 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/agentcore-sdk.ts:910:13 | RegistryAuthorizerType | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 180 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/connectors/types.ts:33:13 | ConnectorStatus | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 181 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/pipeline-config.ts:93:13 | PipelinePhaseId | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 182 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/pipeline-config.ts:99:18 | PipelineIdentityItem | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 183 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/pipeline-config.ts:104:18 | PipelineConfigItem | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 184 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/pipeline-config.ts:109:18 | PipelineDisplayItem | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 185 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/pipeline-config.ts:244:18 | PipelineAgentConfig | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 186 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/pipeline/status.ts:23:18 | CiBuildSummary | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 187 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/pipeline/status.ts:32:18 | StageState | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 188 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/routines/types.ts:19:18 | RoutineRepoConfig | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 189 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/routines/types.ts:48:18 | RoutineLastRun | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 190 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:13:13 | AnalysisTrigger | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 191 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:19:13 | FindingKind | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 192 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:20:13 | FindingSeverity | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 193 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:21:13 | RecommendationPriority | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 194 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:22:13 | RecommendationType | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 195 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:29:18 | PhaseMetric | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 196 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:37:18 | AgentTaskMetric | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 197 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:48:18 | HumanReviewMetric | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 198 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:67:18 | FixTicketEntry | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 199 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:84:18 | ChangeRequestCycle | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 200 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:91:18 | ManagerIntervention | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 201 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:98:18 | WorkflowMetrics | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 202 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:139:18 | AnalysisScores | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 203 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/analysis-types.ts:165:18 | AnalysisTrend | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 204 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/command-queue.ts:23:18 | WorkflowCommand | REMOVED | git grep -n -w -- 'WorkflowCommand' origin/main → 1 hits, all definition/unrelated same-name locals; commit ce9ba18 |
| 205 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/completion-evidence.ts:21:18 | CompletionRecord | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 206 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/intake.ts:75:13 | SourceOutcome | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 207 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/intake.ts:104:13 | LookupImpl | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 208 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/model-config.ts:18:13 | ModelProvider | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 209 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/model-config.ts:26:18 | ModelOptionBase | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 210 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/model-config.ts:44:18 | BedrockModelOption | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 211 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/model-config.ts:52:18 | OpenAIModelOption | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 212 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/performance.ts:45:18 | InfraSnapshot | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 213 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/performance.ts:70:18 | KpiDef | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 214 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/performance.ts:161:18 | KpiStat | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 215 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/performance.ts:174:18 | AgentAgg | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 216 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/roster-loader.ts:12:18 | RosterAgent | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 217 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/ship-review.ts:18:18 | ShipFindingLike | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 218 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:106:18 | FixContract | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 219 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:134:13 | AgentPhase | REMOVED | git grep -n -w -- 'AgentPhase' origin/main → 1 hits, all definition/unrelated same-name locals; commit ce9ba18 |
| 220 | knip-root | Unused exported types | src/lib/workflow/types.ts:153:13 | WorkflowPhase | KEEP-referenced | 11 non-definition hits; first: src/components/workflow/PipelineVisualization.tsx:4 |
| 221 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:217:18 | StoredEvent | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 222 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:222:13 | WorkflowType | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 223 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:281:18 | RepoTarget | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 224 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:290:13 | MessageType | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 225 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:292:18 | AgentMessage | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 226 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:304:13 | IntakeSourceType | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 227 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:412:18 | PortedSession | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 228 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:427:13 | NotificationType | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 229 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/types.ts:436:18 | ReviewPackageLink | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 230 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/workflow-defs.ts:20:13 | WorkflowPhaseType | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 231 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/workflow-defs.ts:22:18 | WorkflowDefPhase | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 232 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/workflow-defs.ts:92:18 | ArtifactChainEntry | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 233 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/workflow-defs.ts:109:18 | ArtifactChain | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 234 | knip-root, ts-prune-root | Unused exported types, Unused export | src/lib/workflow/workflow-defs.ts:126:18 | FrameworkOverlay | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 235 | knip-root, knip-mcp-hub | Duplicate exports | mcp/hub/src/workflow/schemas.ts | WorkflowInputSchema | KEEP-policy | mcp/hub ts-prune twin: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 236 | knip-root | Configuration hints | knip.json | [src/app/**/page.tsx, …]           knip.json  Remove, or move unused top-level entry to one of "workspaces" | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 237 | knip-root | Configuration hints | knip.json | [src/**/*.{ts,tsx}, …]             knip.json  Remove, or move unused top-level project to one of "workspaces" | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 238 | knip-root | Configuration hints | knip.json | src/index.ts              mcp/hub  knip.json  Remove redundant entry pattern | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 239 | knip-mcp-hub | Configuration hints | knip.json | src/index.ts  mcp/hub  knip.json  Remove redundant entry pattern | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 240 | ts-prune-root | Unused export | playwright.config.ts:40 | default | KEEP-referenced | 1052 non-definition hits; first: .claude-plugin/README.md:54 |
| 241 | ts-prune-root | Unused export | vitest.config.ts:14 | default | KEEP-referenced | 1052 non-definition hits; first: .claude-plugin/README.md:54 |
| 242 | ts-prune-root | Unused export | demo/playwright.config.ts:14 | default | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=4 |
| 243 | ts-prune-root | Unused export | src/middleware.ts:56 | middleware | KEEP-H1 | Next.js convention export |
| 244 | ts-prune-root | Unused export | src/middleware.ts:87 | config | KEEP-H1 | Next.js convention export |
| 245 | ts-prune-root | Unused export | demo/playwright/playwright.config.ts:3 | default | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=4 |
| 246 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:92 | notTerminalPhaseGuard | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 247 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:116 | notTerminalPhaseFilter | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 248 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:147 | missingEvidenceTickets | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 249 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:243 | resolveMissingEvidenceFromRecords | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 250 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:297 | normalizeAdvisoryRoutingMode | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 251 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:323 | advisoryNeverApplies | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 252 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:338 | isAdvisoryTicket | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 253 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:345 | nonAdvisory | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 254 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:360 | isWorkflowComplete | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 255 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:466 | shipVerdictOf | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 256 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:498 | evaluateShipVerdict | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 257 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:35 | FIX_KINDS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 258 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:45 | REWORK_FIX_KINDS | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 259 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:56 | SHIP_BLOCKED_OUTCOMES | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 260 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:75 | TERMINAL_WORKFLOW_PHASES | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 261 | ts-prune-root | Unused export | lambda/orchestrator/completion.mjs:131 | SHIP_PHASES | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 262 | ts-prune-root | Unused export | lambda/orchestrator/lease.mjs:83 | lastAgentActivity | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=3 |
| 263 | ts-prune-root | Unused export | lambda/orchestrator/lease.mjs:133 | lastStreamedText | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=3 |
| 264 | ts-prune-root | Unused export | lambda/orchestrator/lease.mjs:178 | hasAgentErrorSince | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=3 |
| 265 | ts-prune-root | Unused export | lambda/orchestrator/lease.mjs:214 | stealClaim | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=3 |
| 266 | ts-prune-root | Unused export | lambda/orchestrator/lease.mjs:42 | DEFAULT_TTL_MINUTES | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=3 |
| 267 | ts-prune-root | Unused export | lambda/orchestrator/lease.mjs:43 | STALE_CLAIM_MULTIPLIER | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=3 |
| 268 | ts-prune-root | Unused export | lambda/orchestrator/lease.mjs:51 | LEASE_TTL_MS | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 269 | ts-prune-root | Unused export | lambda/orchestrator/review-cap.mjs:119 | fingerprintFinding | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 270 | ts-prune-root | Unused export | lambda/orchestrator/review-cap.mjs:146 | roundContentFingerprint | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 271 | ts-prune-root | Unused export | lambda/orchestrator/review-cap.mjs:164 | openEscalation | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 272 | ts-prune-root | Unused export | lambda/orchestrator/review-cap.mjs:192 | parseDecision | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 273 | ts-prune-root | Unused export | lambda/orchestrator/review-cap.mjs:300 | buildRoundRecord | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 274 | ts-prune-root | Unused export | lambda/orchestrator/review-cap.mjs:471 | createReviewCap | KEEP-H11/H14 | manifested in deploy.sh:59 + check-lambda-zip-manifest.sh; deploy.sh basename hits=1 |
| 275 | ts-prune-root | Unused export | lambda/orchestrator/review-cap.mjs:469 | REVIEW_CAP_FAIL_OPEN_LIMIT | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 276 | ts-prune-root | Unused export | src/app/layout.tsx:18 | default | KEEP-H1 | Next.js convention export |
| 277 | ts-prune-root | Unused export | src/app/layout.tsx:13 | metadata | KEEP-H1 | Next.js convention export |
| 278 | ts-prune-root | Unused export | src/app/page.tsx:58 | default | KEEP-H1 | Next.js convention export |
| 279 | ts-prune-root | Unused export | src/config/modules.ts:39 | NavItem | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 280 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:152 | DiscoveredAgent | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 281 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:169 | DiscoveredMemory | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 282 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:510 | PayloadFormat | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 283 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:912 | Registry | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 284 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:925 | RegistryRecord | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 285 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:939 | RegistryRecordDetail | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 286 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:946 | CreateRegistryInput | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 287 | ts-prune-root | Unused export | src/lib/agentcore-sdk.ts:955 | CreateRegistryRecordInput | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 288 | ts-prune-root | Unused export | src/lib/agentcore-stream.ts:19 | StreamRequest | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 289 | ts-prune-root | Unused export | src/lib/agentcore-stream.ts:43 | BuilderStreamRequest | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 290 | ts-prune-root | Unused export | src/lib/cd-registry.ts:44 | DeliveryMode | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 291 | ts-prune-root | Unused export | demo/playwright/v4/playwright-v4.config.ts:3 | default | KEEP-ambiguous | out of scope / operational script; needs human judgment; basename hits in origin/main=4 |
| 292 | ts-prune-root | Unused export | deploy/runtime-agent/healthcheck-fixtures/buggy-component.tsx:7 | ThemeToggle | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 293 | ts-prune-root | Unused export | deploy/runtime-agent/healthcheck-fixtures/fixed-component.tsx:7 | ThemeToggle | KEEP-H16/H4 | deploy/** out of scope (H16 separate CDK sub-project for deploy/pipeline; others covered by surfaces.json/vitest includes); basename grep counts surfaces.json=0, vitest.config.ts=0 |
| 294 | ts-prune-root | Unused export | evals/battery/lib/agent-runner.mjs:46 | MAX_TRANSPORT_RETRIES | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 295 | ts-prune-root | Unused export | evals/battery/lib/cases.mjs:133 | duplicateCaseIds | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 296 | ts-prune-root | Unused export | evals/battery/lib/cases.mjs:13 | SCORING_BACKEND | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 297 | ts-prune-root | Unused export | evals/battery/lib/scoring.mjs:98 | createConverseTransport | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=8 |
| 298 | ts-prune-root | Unused export | evals/battery/lib/scoring.mjs:15 | SCORING_BACKEND | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=8 |
| 299 | ts-prune-root | Unused export | src/app/agents/page.tsx:57 | default | KEEP-H1 | Next.js convention export |
| 300 | ts-prune-root | Unused export | src/app/build/page.tsx:17 | default | KEEP-H1 | Next.js convention export |
| 301 | ts-prune-root | Unused export | src/app/cloud-code/page.tsx:49 | default | KEEP-H1 | Next.js convention export |
| 302 | ts-prune-root | Unused export | src/app/connectors/page.tsx:22 | default | KEEP-H1 | Next.js convention export |
| 303 | ts-prune-root | Unused export | src/app/evaluations/page.tsx:113 | default | KEEP-H1 | Next.js convention export |
| 304 | ts-prune-root | Unused export | src/app/invoke/page.tsx:27 | default | KEEP-H1 | Next.js convention export |
| 305 | ts-prune-root | Unused export | src/app/pipeline/page.tsx:38 | default | KEEP-H1 | Next.js convention export |
| 306 | ts-prune-root | Unused export | src/app/registry/page.tsx:80 | default | KEEP-H1 | Next.js convention export |
| 307 | ts-prune-root | Unused export | src/app/routines/page.tsx:19 | default | KEEP-H1 | Next.js convention export |
| 308 | ts-prune-root | Unused export | src/app/tickets/page.tsx:118 | default | KEEP-H1 | Next.js convention export |
| 309 | ts-prune-root | Unused export | src/app/workflow/page.tsx:36 | default | KEEP-H1 | Next.js convention export |
| 310 | ts-prune-root | Unused export | src/components/workflow/ArtifactViewer.tsx:20 | ArtifactKind | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 311 | ts-prune-root | Unused export | src/components/workflow/PipelineVisualization.tsx:333 | default | KEEP-human | kept 2026-08-31 by human decision (PR #239) — carry forward, not re-litigated |
| 312 | ts-prune-root | Unused export | src/components/workflow/useWorkflowStream.ts:8 | UseWorkflowStreamOptions | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 313 | ts-prune-root | Unused export | src/components/workflow/useWorkflowStream.ts:26 | UseWorkflowStreamReturn | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 314 | ts-prune-root | Unused export | src/lib/cloud-code/config-store.ts:52 | UserConfig | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 315 | ts-prune-root | Unused export | src/lib/cloud-code/github-store.ts:31 | GithubConnection | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 316 | ts-prune-root | Unused export | src/lib/cloud-code/runtime.ts:36 | CodingTurnResult | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 317 | ts-prune-root | Unused export | src/lib/cloud-code/runtime.ts:47 | CodingTurnParams | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 318 | ts-prune-root | Unused export | src/lib/cloud-code/shell-protocol.ts:21 | DecodedFrame | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 319 | ts-prune-root | Unused export | src/lib/cloud-code/use-voice-input.ts:49 | VoiceInput | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 320 | ts-prune-root | Unused export | src/lib/metrics/gate-dwell.ts:15 | StatusTransition | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 321 | ts-prune-root | Unused export | src/lib/metrics/throughput.ts:10 | WorkflowDuration | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 322 | ts-prune-root | Unused export | src/lib/models/harness-models.ts:32 | BedrockApiFormat | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 323 | ts-prune-root | Unused export | src/lib/models/harness-models.ts:33 | OpenAiApiFormat | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 324 | ts-prune-root | Unused export | src/lib/models/harness-models.ts:36 | HarnessModelConfig | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 325 | ts-prune-root | Unused export | src/lib/models/harness-models.ts:51 | ModelProvider | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 326 | ts-prune-root | Unused export | src/lib/models/harness-models.ts:53 | HarnessModelOption | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 327 | ts-prune-root | Unused export | src/lib/pipeline/status.ts:44 | PipelineStatus | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 328 | ts-prune-root | Unused export | src/lib/workflow/completion-evidence.ts:32 | EvidenceEntryLike | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 329 | ts-prune-root | Unused export | src/lib/workflow/completion-evidence.ts:41 | MissingEvidenceTicket | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 330 | ts-prune-root | Unused export | src/lib/workflow/completion-evidence.ts:46 | BackfillFields | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 331 | ts-prune-root | Unused export | src/lib/workflow/completion-evidence.ts:53 | ResolveEvidenceDeps | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 332 | ts-prune-root | Unused export | src/lib/workflow/intake.ts:97 | SourceValidationMode | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 333 | ts-prune-root | Unused export | src/lib/workflow/intake.ts:108 | ValidateIntakeSourcesOptions | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 334 | ts-prune-root | Unused export | src/lib/workflow/jira-client.ts:60 | JiraClientConfig | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 335 | ts-prune-root | Unused export | src/lib/workflow/jira-client.ts:66 | JiraIssue | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 336 | ts-prune-root | Unused export | src/lib/workflow/jira-client.ts:91 | JiraTransition | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 337 | ts-prune-root | Unused export | src/lib/workflow/jira-client.ts:97 | JiraSearchResult | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 338 | ts-prune-root | Unused export | src/lib/workflow/lease.ts:42 | AgentTaskEntry | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 339 | ts-prune-root | Unused export | src/lib/workflow/performance.ts:125 | Band | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 340 | ts-prune-root | Unused export | src/lib/workflow/repo-check.ts:21 | RepoCheckResult | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 341 | ts-prune-root | Unused export | src/lib/workflow/repo-check.ts:38 | RepoCheckOptions | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 342 | ts-prune-root | Unused export | src/lib/workflow/sdlc-framework.ts:9 | SdlcFramework | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 343 | ts-prune-root | Unused export | src/lib/workflow/ship-review.ts:52 | EffectiveRoundCountOpts | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 344 | ts-prune-root | Unused export | src/lib/workflow/source-shape.ts:105 | SourceDisplay | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 345 | ts-prune-root | Unused export | src/lib/workflow/transform-event.ts:11 | TransformOptions | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 346 | ts-prune-root | Unused export | src/lib/workflow/watchdog.ts:27 | WatchdogConfig | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 347 | ts-prune-root | Unused export | src/lib/workflow/watchdog.ts:34 | PartialWatchdog | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 348 | ts-prune-root | Unused export | src/lib/workflow/workflow-defs.ts:116 | SdlcFramework | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 349 | ts-prune-root | Unused export | evals/battery/fixtures/fix-null-session-crash-001/session-utils.ts:10 | parseSession | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=5 |
| 350 | ts-prune-root | Unused export | evals/battery/fixtures/fix-null-session-crash-001/session-utils.ts:26 | getTenantScope | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=5 |
| 351 | ts-prune-root | Unused export | evals/battery/fixtures/fix-null-session-crash-001/session-utils.ts:4 | Session | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 352 | ts-prune-root | Unused export | evals/battery/fixtures/fix-pagination-offbyone-002/pagination.ts:10 | paginate | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=3 |
| 353 | ts-prune-root | Unused export | evals/battery/fixtures/fix-pagination-offbyone-002/pagination.ts:3 | Page | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 354 | ts-prune-root | Unused export | evals/battery/fixtures/fix-race-condition-cas-003/store.ts:5 | ConversationRecord | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 355 | ts-prune-root | Unused export | evals/battery/fixtures/fix-race-condition-cas-003/store.ts:19 | ConversationStore | KEEP-H12-scope | knip scope gap: vitest.config.ts includes evals/battery/**; not analysed by knip; basename grep counts vitest.config.ts=0, evals/=4 |
| 356 | ts-prune-root | Unused export | src/app/agents/[id]/page.tsx:60 | default | KEEP-H1 | Next.js convention export |
| 357 | ts-prune-root | Unused export | src/app/api/connectors/route.ts:27 | GET | KEEP-H1 | Next.js convention export |
| 358 | ts-prune-root | Unused export | src/app/api/connectors/route.ts:37 | POST | KEEP-H1 | Next.js convention export |
| 359 | ts-prune-root | Unused export | src/app/api/connectors/route.ts:25 | dynamic | KEEP-H1 | Next.js convention export |
| 360 | ts-prune-root | Unused export | src/app/api/evaluations/route.ts:42 | GET | KEEP-H1 | Next.js convention export |
| 361 | ts-prune-root | Unused export | src/app/api/evaluations/route.ts:14 | dynamic | KEEP-H1 | Next.js convention export |
| 362 | ts-prune-root | Unused export | src/app/api/evaluations/route.ts:15 | revalidate | KEEP-H1 | Next.js convention export |
| 363 | ts-prune-root | Unused export | src/app/api/evaluations/route.ts:16 | fetchCache | KEEP-H1 | Next.js convention export |
| 364 | ts-prune-root | Unused export | src/app/api/health/route.ts:3 | GET | KEEP-H1 | Next.js convention export |
| 365 | ts-prune-root | Unused export | src/app/api/models/route.ts:40 | GET | KEEP-H1 | Next.js convention export |
| 366 | ts-prune-root | Unused export | src/app/api/routines/route.ts:22 | GET | KEEP-H1 | Next.js convention export |
| 367 | ts-prune-root | Unused export | src/app/api/routines/route.ts:36 | POST | KEEP-H1 | Next.js convention export |
| 368 | ts-prune-root | Unused export | src/app/api/routines/route.ts:20 | dynamic | KEEP-H1 | Next.js convention export |
| 369 | ts-prune-root | Unused export | src/app/evaluations/config/page.tsx:85 | default | KEEP-H1 | Next.js convention export |
| 370 | ts-prune-root | Unused export | src/app/api/agentcore/agents/route.ts:11 | GET | KEEP-H1 | Next.js convention export |
| 371 | ts-prune-root | Unused export | src/app/api/agentcore/builder/route.ts:13 | POST | KEEP-H1 | Next.js convention export |
| 372 | ts-prune-root | Unused export | src/app/api/agentcore/deploy/route.ts:12 | POST | KEEP-H1 | Next.js convention export |
| 373 | ts-prune-root | Unused export | src/app/api/agentcore/invoke/route.ts:9 | POST | KEEP-H1 | Next.js convention export |
| 374 | ts-prune-root | Unused export | src/app/api/agentcore/metrics/route.ts:94 | GET | KEEP-H1 | Next.js convention export |
| 375 | ts-prune-root | Unused export | src/app/api/agentcore/metrics/route.ts:3 | dynamic | KEEP-H1 | Next.js convention export |
| 376 | ts-prune-root | Unused export | src/app/api/agentcore/payload-format/route.ts:8 | GET | KEEP-H1 | Next.js convention export |
| 377 | ts-prune-root | Unused export | src/app/api/agentcore/payload-format/route.ts:21 | POST | KEEP-H1 | Next.js convention export |
| 378 | ts-prune-root | Unused export | src/app/api/agentcore/region/route.ts:19 | GET | KEEP-H1 | Next.js convention export |
| 379 | ts-prune-root | Unused export | src/app/api/agentcore/region/route.ts:31 | POST | KEEP-H1 | Next.js convention export |
| 380 | ts-prune-root | Unused export | src/app/api/agentcore/registry/route.ts:10 | GET | KEEP-H1 | Next.js convention export |
| 381 | ts-prune-root | Unused export | src/app/api/agentcore/registry/route.ts:26 | POST | KEEP-H1 | Next.js convention export |
| 382 | ts-prune-root | Unused export | src/app/api/agentcore/registry/route.ts:4 | dynamic | KEEP-H1 | Next.js convention export |
| 383 | ts-prune-root | Unused export | src/app/api/agentcore/traces/route.ts:71 | GET | KEEP-H1 | Next.js convention export |
| 384 | ts-prune-root | Unused export | src/app/api/agentcore/traces/route.ts:126 | POST | KEEP-H1 | Next.js convention export |
| 385 | ts-prune-root | Unused export | src/app/api/cloud-code/config/route.ts:37 | GET | KEEP-H1 | Next.js convention export |
| 386 | ts-prune-root | Unused export | src/app/api/cloud-code/config/route.ts:43 | POST | KEEP-H1 | Next.js convention export |
| 387 | ts-prune-root | Unused export | src/app/api/cloud-code/config/route.ts:106 | PUT | KEEP-H1 | Next.js convention export |
| 388 | ts-prune-root | Unused export | src/app/api/cloud-code/config/route.ts:30 | dynamic | KEEP-H1 | Next.js convention export |
| 389 | ts-prune-root | Unused export | src/app/api/cloud-code/config/route.ts:31 | maxDuration | KEEP-H1 | Next.js convention export |
| 390 | ts-prune-root | Unused export | src/app/api/cloud-code/github/route.ts:16 | GET | KEEP-H1 | Next.js convention export |
| 391 | ts-prune-root | Unused export | src/app/api/cloud-code/github/route.ts:43 | DELETE | KEEP-H1 | Next.js convention export |
| 392 | ts-prune-root | Unused export | src/app/api/cloud-code/github/route.ts:14 | dynamic | KEEP-H1 | Next.js convention export |
| 393 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/route.ts:14 | GET | KEEP-H1 | Next.js convention export |
| 394 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/route.ts:35 | POST | KEEP-H1 | Next.js convention export |
| 395 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/route.ts:12 | dynamic | KEEP-H1 | Next.js convention export |
| 396 | ts-prune-root | Unused export | src/app/api/connectors/[id]/route.ts:16 | GET | KEEP-H1 | Next.js convention export |
| 397 | ts-prune-root | Unused export | src/app/api/connectors/[id]/route.ts:23 | PATCH | KEEP-H1 | Next.js convention export |
| 398 | ts-prune-root | Unused export | src/app/api/connectors/[id]/route.ts:64 | DELETE | KEEP-H1 | Next.js convention export |
| 399 | ts-prune-root | Unused export | src/app/api/connectors/[id]/route.ts:14 | dynamic | KEEP-H1 | Next.js convention export |
| 400 | ts-prune-root | Unused export | src/app/api/evaluations/agents/route.ts:6 | GET | KEEP-H1 | Next.js convention export |
| 401 | ts-prune-root | Unused export | src/app/api/evaluations/agents/route.ts:4 | dynamic | KEEP-H1 | Next.js convention export |
| 402 | ts-prune-root | Unused export | src/app/api/evaluations/loop/route.ts:55 | GET | KEEP-H1 | Next.js convention export |
| 403 | ts-prune-root | Unused export | src/app/api/evaluations/loop/route.ts:75 | POST | KEEP-H1 | Next.js convention export |
| 404 | ts-prune-root | Unused export | src/app/api/evaluations/loop/route.ts:15 | dynamic | KEEP-H1 | Next.js convention export |
| 405 | ts-prune-root | Unused export | src/app/api/jira/metrics/route.ts:546 | GET | KEEP-H1 | Next.js convention export |
| 406 | ts-prune-root | Unused export | src/app/api/jira/metrics/route.ts:6 | dynamic | KEEP-H1 | Next.js convention export |
| 407 | ts-prune-root | Unused export | src/app/api/pipeline/status/route.ts:9 | GET | KEEP-H1 | Next.js convention export |
| 408 | ts-prune-root | Unused export | src/app/api/pipeline/status/route.ts:7 | dynamic | KEEP-H1 | Next.js convention export |
| 409 | ts-prune-root | Unused export | src/app/api/routines/[id]/route.ts:20 | GET | KEEP-H1 | Next.js convention export |
| 410 | ts-prune-root | Unused export | src/app/api/routines/[id]/route.ts:31 | PATCH | KEEP-H1 | Next.js convention export |
| 411 | ts-prune-root | Unused export | src/app/api/routines/[id]/route.ts:86 | DELETE | KEEP-H1 | Next.js convention export |
| 412 | ts-prune-root | Unused export | src/app/api/routines/[id]/route.ts:18 | dynamic | KEEP-H1 | Next.js convention export |
| 413 | ts-prune-root | Unused export | src/app/api/routines/chat/route.ts:38 | POST | KEEP-H1 | Next.js convention export |
| 414 | ts-prune-root | Unused export | src/app/api/routines/chat/route.ts:21 | runtime | KEEP-H1 | Next.js convention export |
| 415 | ts-prune-root | Unused export | src/app/api/routines/chat/route.ts:22 | dynamic | KEEP-H1 | Next.js convention export |
| 416 | ts-prune-root | Unused export | src/app/api/routines/definitions/route.ts:29 | GET | KEEP-H1 | Next.js convention export |
| 417 | ts-prune-root | Unused export | src/app/api/routines/definitions/route.ts:13 | dynamic | KEEP-H1 | Next.js convention export |
| 418 | ts-prune-root | Unused export | src/app/api/workflow/[id]/route.ts:33 | DELETE | KEEP-H1 | Next.js convention export |
| 419 | ts-prune-root | Unused export | src/app/api/workflow/[id]/route.ts:31 | dynamic | KEEP-H1 | Next.js convention export |
| 420 | ts-prune-root | Unused export | src/app/api/workflow/artifacts/route.ts:4 | GET | KEEP-H1 | Next.js convention export |
| 421 | ts-prune-root | Unused export | src/app/api/workflow/cd-registry/route.ts:27 | GET | KEEP-H1 | Next.js convention export |
| 422 | ts-prune-root | Unused export | src/app/api/workflow/cd-registry/route.ts:41 | POST | KEEP-H1 | Next.js convention export |
| 423 | ts-prune-root | Unused export | src/app/api/workflow/cd-registry/route.ts:62 | DELETE | KEEP-H1 | Next.js convention export |
| 424 | ts-prune-root | Unused export | src/app/api/workflow/cd-registry/route.ts:25 | dynamic | KEEP-H1 | Next.js convention export |
| 425 | ts-prune-root | Unused export | src/app/api/workflow/definitions/route.ts:15 | GET | KEEP-H1 | Next.js convention export |
| 426 | ts-prune-root | Unused export | src/app/api/workflow/definitions/route.ts:13 | dynamic | KEEP-H1 | Next.js convention export |
| 427 | ts-prune-root | Unused export | src/app/api/workflow/list/route.ts:6 | GET | KEEP-H1 | Next.js convention export |
| 428 | ts-prune-root | Unused export | src/app/api/workflow/list/route.ts:4 | dynamic | KEEP-H1 | Next.js convention export |
| 429 | ts-prune-root | Unused export | src/app/api/workflow/performance/route.ts:47 | GET | KEEP-H1 | Next.js convention export |
| 430 | ts-prune-root | Unused export | src/app/api/workflow/performance/route.ts:19 | dynamic | KEEP-H1 | Next.js convention export |
| 431 | ts-prune-root | Unused export | src/app/api/workflow/state/route.ts:9 | GET | KEEP-H1 | Next.js convention export |
| 432 | ts-prune-root | Unused export | src/app/api/workflow/webhook/route.ts:21 | POST | KEEP-H1 | Next.js convention export |
| 433 | ts-prune-root | Unused export | src/app/api/workflow-manager/chat/route.ts:97 | POST | KEEP-H1 | Next.js convention export |
| 434 | ts-prune-root | Unused export | src/app/api/workflow-manager/chat/route.ts:24 | runtime | KEEP-H1 | Next.js convention export |
| 435 | ts-prune-root | Unused export | src/app/api/workflow-manager/chat/route.ts:25 | dynamic | KEEP-H1 | Next.js convention export |
| 436 | ts-prune-root | Unused export | src/app/api/agentcore/memory/events/route.ts:26 | GET | KEEP-H1 | Next.js convention export |
| 437 | ts-prune-root | Unused export | src/app/api/agentcore/memory/events/route.ts:114 | POST | KEEP-H1 | Next.js convention export |
| 438 | ts-prune-root | Unused export | src/app/api/agentcore/memory/mapping/route.ts:14 | GET | KEEP-H1 | Next.js convention export |
| 439 | ts-prune-root | Unused export | src/app/api/agentcore/memory/mapping/route.ts:28 | POST | KEEP-H1 | Next.js convention export |
| 440 | ts-prune-root | Unused export | src/app/api/agentcore/memory/sessions/route.ts:24 | GET | KEEP-H1 | Next.js convention export |
| 441 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/route.ts:12 | GET | KEEP-H1 | Next.js convention export |
| 442 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/route.ts:28 | PATCH | KEEP-H1 | Next.js convention export |
| 443 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/route.ts:44 | DELETE | KEEP-H1 | Next.js convention export |
| 444 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/route.ts:4 | dynamic | KEEP-H1 | Next.js convention export |
| 445 | ts-prune-root | Unused export | src/app/api/agentcore/traces/health/route.ts:51 | GET | KEEP-H1 | Next.js convention export |
| 446 | ts-prune-root | Unused export | src/app/api/agentcore/traces/health/route.ts:17 | TraceHealthIssue | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 447 | ts-prune-root | Unused export | src/app/api/agentcore/traces/health/route.ts:30 | TraceHealth | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 448 | ts-prune-root | Unused export | src/app/api/agentcore/traces/sessions/route.ts:27 | GET | KEEP-H1 | Next.js convention export |
| 449 | ts-prune-root | Unused export | src/app/api/cloud-code/github/callback/route.ts:30 | GET | KEEP-H1 | Next.js convention export |
| 450 | ts-prune-root | Unused export | src/app/api/cloud-code/github/callback/route.ts:24 | dynamic | KEEP-H1 | Next.js convention export |
| 451 | ts-prune-root | Unused export | src/app/api/cloud-code/github/install/route.ts:21 | GET | KEEP-H1 | Next.js convention export |
| 452 | ts-prune-root | Unused export | src/app/api/cloud-code/github/install/route.ts:15 | dynamic | KEEP-H1 | Next.js convention export |
| 453 | ts-prune-root | Unused export | src/app/api/cloud-code/github/manifest/route.ts:30 | GET | KEEP-H1 | Next.js convention export |
| 454 | ts-prune-root | Unused export | src/app/api/cloud-code/github/manifest/route.ts:24 | dynamic | KEEP-H1 | Next.js convention export |
| 455 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/route.ts:61 | PATCH | KEEP-H1 | Next.js convention export |
| 456 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/route.ts:87 | GET | KEEP-H1 | Next.js convention export |
| 457 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/route.ts:104 | DELETE | KEEP-H1 | Next.js convention export |
| 458 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/route.ts:19 | dynamic | KEEP-H1 | Next.js convention export |
| 459 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/port/route.ts:137 | POST | KEEP-H1 | Next.js convention export |
| 460 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/port/route.ts:48 | dynamic | KEEP-H1 | Next.js convention export |
| 461 | ts-prune-root | Unused export | src/app/api/connectors/[id]/credentials/route.ts:17 | POST | KEEP-H1 | Next.js convention export |
| 462 | ts-prune-root | Unused export | src/app/api/connectors/[id]/credentials/route.ts:15 | dynamic | KEEP-H1 | Next.js convention export |
| 463 | ts-prune-root | Unused export | src/app/api/evaluations/agents/[agentId]/route.ts:45 | PUT | KEEP-H1 | Next.js convention export |
| 464 | ts-prune-root | Unused export | src/app/api/evaluations/agents/[agentId]/route.ts:4 | dynamic | KEEP-H1 | Next.js convention export |
| 465 | ts-prune-root | Unused export | src/app/api/routines/[id]/run/route.ts:17 | POST | KEEP-H1 | Next.js convention export |
| 466 | ts-prune-root | Unused export | src/app/api/routines/[id]/run/route.ts:15 | dynamic | KEEP-H1 | Next.js convention export |
| 467 | ts-prune-root | Unused export | src/app/api/workflow/[id]/agent-output/route.ts:73 | GET | KEEP-H1 | Next.js convention export |
| 468 | ts-prune-root | Unused export | src/app/api/workflow/[id]/agent-output/route.ts:32 | dynamic | KEEP-H1 | Next.js convention export |
| 469 | ts-prune-root | Unused export | src/app/api/workflow/[id]/analyze/route.ts:27 | POST | KEEP-H1 | Next.js convention export |
| 470 | ts-prune-root | Unused export | src/app/api/workflow/[id]/analyze/route.ts:25 | dynamic | KEEP-H1 | Next.js convention export |
| 471 | ts-prune-root | Unused export | src/app/api/workflow/[id]/archive/route.ts:21 | PATCH | KEEP-H1 | Next.js convention export |
| 472 | ts-prune-root | Unused export | src/app/api/workflow/[id]/archive/route.ts:19 | dynamic | KEEP-H1 | Next.js convention export |
| 473 | ts-prune-root | Unused export | src/app/api/workflow/[id]/escalations/route.ts:32 | GET | KEEP-H1 | Next.js convention export |
| 474 | ts-prune-root | Unused export | src/app/api/workflow/[id]/escalations/route.ts:45 | PATCH | KEEP-H1 | Next.js convention export |
| 475 | ts-prune-root | Unused export | src/app/api/workflow/[id]/escalations/route.ts:23 | dynamic | KEEP-H1 | Next.js convention export |
| 476 | ts-prune-root | Unused export | src/app/api/workflow/[id]/events/route.ts:22 | GET | KEEP-H1 | Next.js convention export |
| 477 | ts-prune-root | Unused export | src/app/api/workflow/[id]/events/route.ts:13 | dynamic | KEEP-H1 | Next.js convention export |
| 478 | ts-prune-root | Unused export | src/app/api/workflow/[id]/message/route.ts:30 | POST | KEEP-H1 | Next.js convention export |
| 479 | ts-prune-root | Unused export | src/app/api/workflow/[id]/message/route.ts:19 | dynamic | KEEP-H1 | Next.js convention export |
| 480 | ts-prune-root | Unused export | src/app/api/workflow/[id]/nudge/route.ts:267 | POST | KEEP-H1 | Next.js convention export |
| 481 | ts-prune-root | Unused export | src/app/api/workflow/[id]/nudge/route.ts:32 | dynamic | KEEP-H1 | Next.js convention export |
| 482 | ts-prune-root | Unused export | src/app/api/workflow/[id]/retry/route.ts:151 | POST | KEEP-H1 | Next.js convention export |
| 483 | ts-prune-root | Unused export | src/app/api/workflow/[id]/retry/route.ts:73 | dynamic | KEEP-H1 | Next.js convention export |
| 484 | ts-prune-root | Unused export | src/app/api/workflow/[id]/state/route.ts:35 | GET | KEEP-H1 | Next.js convention export |
| 485 | ts-prune-root | Unused export | src/app/api/workflow/[id]/state/route.ts:4 | dynamic | KEEP-H1 | Next.js convention export |
| 486 | ts-prune-root | Unused export | src/app/api/workflow/[id]/stream/route.ts:29 | GET | KEEP-H1 | Next.js convention export |
| 487 | ts-prune-root | Unused export | src/app/api/workflow/[id]/stream/route.ts:17 | runtime | KEEP-H1 | Next.js convention export |
| 488 | ts-prune-root | Unused export | src/app/api/workflow/[id]/stream/route.ts:18 | dynamic | KEEP-H1 | Next.js convention export |
| 489 | ts-prune-root | Unused export | src/app/api/workflow/[id]/tickets/route.ts:9 | GET | KEEP-H1 | Next.js convention export |
| 490 | ts-prune-root | Unused export | src/app/api/workflow/[id]/tickets/route.ts:5 | dynamic | KEEP-H1 | Next.js convention export |
| 491 | ts-prune-root | Unused export | src/app/api/workflow/[id]/watch/route.ts:23 | GET | KEEP-H1 | Next.js convention export |
| 492 | ts-prune-root | Unused export | src/app/api/workflow/[id]/watch/route.ts:33 | PATCH | KEEP-H1 | Next.js convention export |
| 493 | ts-prune-root | Unused export | src/app/api/workflow/[id]/watch/route.ts:21 | dynamic | KEEP-H1 | Next.js convention export |
| 494 | ts-prune-root | Unused export | src/app/api/workflow/artifacts/content/route.ts:51 | GET | KEEP-H1 | Next.js convention export |
| 495 | ts-prune-root | Unused export | src/app/api/workflow/artifacts/content/route.ts:93 | PUT | KEEP-H1 | Next.js convention export |
| 496 | ts-prune-root | Unused export | src/app/api/workflow/artifacts/download/route.ts:11 | GET | KEEP-H1 | Next.js convention export |
| 497 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/route.ts:18 | GET | KEEP-H1 | Next.js convention export |
| 498 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/route.ts:43 | POST | KEEP-H1 | Next.js convention export |
| 499 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/route.ts:10 | dynamic | KEEP-H1 | Next.js convention export |
| 500 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/search/route.ts:17 | POST | KEEP-H1 | Next.js convention export |
| 501 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/search/route.ts:8 | dynamic | KEEP-H1 | Next.js convention export |
| 502 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/artifacts/route.ts:61 | GET | KEEP-H1 | Next.js convention export |
| 503 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/artifacts/route.ts:121 | POST | KEEP-H1 | Next.js convention export |
| 504 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/artifacts/route.ts:24 | dynamic | KEEP-H1 | Next.js convention export |
| 505 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/checkpoint/route.ts:30 | POST | KEEP-H1 | Next.js convention export |
| 506 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/checkpoint/route.ts:23 | dynamic | KEEP-H1 | Next.js convention export |
| 507 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/checkpoint/route.ts:24 | maxDuration | KEEP-H1 | Next.js convention export |
| 508 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/message/route.ts:55 | POST | KEEP-H1 | Next.js convention export |
| 509 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/message/route.ts:20 | dynamic | KEEP-H1 | Next.js convention export |
| 510 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/message/route.ts:22 | maxDuration | KEEP-H1 | Next.js convention export |
| 511 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/shell/route.ts:32 | POST | KEEP-H1 | Next.js convention export |
| 512 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/shell/route.ts:22 | dynamic | KEEP-H1 | Next.js convention export |
| 513 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/shell/route.ts:26 | maxDuration | KEEP-H1 | Next.js convention export |
| 514 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/stop/route.ts:42 | POST | KEEP-H1 | Next.js convention export |
| 515 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/stop/route.ts:35 | dynamic | KEEP-H1 | Next.js convention export |
| 516 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/stop/route.ts:36 | maxDuration | KEEP-H1 | Next.js convention export |
| 517 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/warm/route.ts:21 | POST | KEEP-H1 | Next.js convention export |
| 518 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/warm/route.ts:18 | dynamic | KEEP-H1 | Next.js convention export |
| 519 | ts-prune-root | Unused export | src/app/api/cloud-code/sessions/[id]/warm/route.ts:19 | maxDuration | KEEP-H1 | Next.js convention export |
| 520 | ts-prune-root | Unused export | src/app/api/evaluations/agents/[agentId]/flush/route.ts:17 | POST | KEEP-H1 | Next.js convention export |
| 521 | ts-prune-root | Unused export | src/app/api/evaluations/agents/[agentId]/flush/route.ts:15 | dynamic | KEEP-H1 | Next.js convention export |
| 522 | ts-prune-root | Unused export | src/app/api/workflow/[id]/tickets/comment/route.ts:29 | POST | KEEP-H1 | Next.js convention export |
| 523 | ts-prune-root | Unused export | src/app/api/workflow/[id]/tickets/comment/route.ts:27 | dynamic | KEEP-H1 | Next.js convention export |
| 524 | ts-prune-root | Unused export | src/app/api/workflow/[id]/tickets/transition/route.ts:24 | POST | KEEP-H1 | Next.js convention export |
| 525 | ts-prune-root | Unused export | src/app/api/workflow/[id]/tickets/transition/route.ts:7 | dynamic | KEEP-H1 | Next.js convention export |
| 526 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/[recordId]/route.ts:17 | GET | KEEP-H1 | Next.js convention export |
| 527 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/[recordId]/route.ts:34 | PATCH | KEEP-H1 | Next.js convention export |
| 528 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/[recordId]/route.ts:67 | DELETE | KEEP-H1 | Next.js convention export |
| 529 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/[recordId]/route.ts:9 | dynamic | KEEP-H1 | Next.js convention export |
| 530 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/[recordId]/approval/route.ts:24 | POST | KEEP-H1 | Next.js convention export |
| 531 | ts-prune-root | Unused export | src/app/api/agentcore/registry/[registryId]/records/[recordId]/approval/route.ts:9 | dynamic | KEEP-H1 | Next.js convention export |
| 532 | ts-prune-mcp-hub | Unused export | mcp/hub/src/auth.ts:109 | ClientResult | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 533 | ts-prune-mcp-hub | Unused export | mcp/hub/src/cloud-code/artifacts.ts:56 | DetectResult | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 534 | ts-prune-mcp-hub | Unused export | mcp/hub/src/cloud-code/artifacts.ts:181 | DetectOptions | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 535 | ts-prune-mcp-hub | Unused export | mcp/hub/src/cloud-code/cli-config.ts:44 | GatherResult | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 536 | ts-prune-mcp-hub | Unused export | mcp/hub/src/cloud-code/git.ts:44 | GitState | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 537 | ts-prune-mcp-hub | Unused export | mcp/hub/src/cloud-code/git.ts:113 | GitHandoff | KEEP-policy | ts-prune: used in module; stripping `export` is a refactor, not a deletion (policy) |
| 538 | depcheck-root | Unused dependencies | - | @aws-sdk/client-bedrock-agent-runtime | KEEP-H5 | git grep -n -l 'client-bedrock-agent-runtime' origin/main → 22 hits: lambda/orchestrator/advisory-routing.test.mjs, lambda/orchestrator/cd-handoff.test.mjs, lambda/orchestrator/ci-check-context.test.mjs |
| 539 | depcheck-root | Unused devDependencies | - | autoprefixer | KEEP-H5 | postcss.config / Tailwind toolchain (postcss configs=1: postcss.config.js) |
| 540 | depcheck-root | Unused devDependencies | - | depcheck | KEEP-H5 | sweep tooling, invoked via npx |
| 541 | depcheck-root | Unused devDependencies | - | knip | KEEP-H5 | sweep tooling, invoked via npx |
| 542 | depcheck-root | Unused devDependencies | - | postcss | KEEP-H5 | postcss.config / Tailwind toolchain (postcss configs=1: postcss.config.js) |
| 543 | depcheck-root | Unused devDependencies | - | ts-prune | KEEP-H5 | sweep tooling, invoked via npx |
| 544 | depcheck-root | Missing dependencies | ./evals/battery/lint-fixtures.mjs | ajv | ADVISORY | hygiene note, not a removal candidate (additions/config are out of scope) |
| 545 | cascade | cascade orphan of writeArtifact | src/lib/workflow/agent-setup.ts:20 | getSharedArtifactsPrefix | REMOVED | cascade orphan of writeArtifact; git grep -n -w -- 'getSharedArtifactsPrefix' origin/main → 3 hits; commit ce9ba18 |
