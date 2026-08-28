# QA Evidence — TEAM-3092 config-evals-gate — Call 1 (local verify + recon)
Date: 2026-08-28 | Branch: feature/TEAM-3033-config-evals-gate-eval-suite-must-pass-b
HEAD: 31f4662a7f42f478415277ca5c579e794e1c09fe (matches expected tip exactly)

## Command results
- npm ci: FIRST TWO ATTEMPTS FAILED exit 232 (EMFILE, fd hard limit 1024) leaving corrupted node_modules
  (0-byte clsx.d.mts, missing react-markdown/index.d.ts). Clean retry with
  `UV_THREADPOOL_SIZE=2 npm ci --maxsockets=2` SUCCEEDED (npm-ci.log, exit=0).
- npx tsc --noEmit: FAIL exit 2 — 29 errors, ALL in branch-new __tests__ files
  (deploy/lib/__tests__/check-eval-gate.test.ts ×1, evals/battery/__tests__: agent-runner ×10,
  gate-config ×5, report-otel ×1, retry ×2, scoring ×6, spend ×4). None of these files exist on
  origin/main. ci.yml:29 runs `npx tsc --noEmit` on every PR → this branch would FAIL CI Typecheck.
- npm run test:unit (vitest run): PASS exit 0 — 25 files, 254 tests passed (test-unit.log).
- npm run battery:lint: PASS exit 0 — 14 case files (13 active), fixtures sanitized (battery-lint.log).
- node evals/battery/run-battery.mjs --dry-run: PASS exit 0 — 13 runnable + 1 retired, hermeticity
  self-test OK, zero Bedrock calls; all 13 cases flagged [informational: new case] because
  committed baseline.json is bootstrap:true (battery-dry-run.log).

## Environment
- STS OK: arn:aws:sts::838829463875:assumed-role/agentcore-hub-coding-runtime-role/BedrockAgentCore-54b61708-...
- Bedrock Converse OK: us.anthropic.claude-haiku-4-5-20251001-v1:0 replied "ok" (18 tokens total).
- DynamoDB: DENIED (ListTables, DescribeTable, GetItem on agentcore-hub-eval-config all AccessDeniedException).
- gh CLI: /usr/bin/gh, authed as tycenjmccann via GH_TOKEN (repo, workflow scopes; missing read:org).
- aws CLI: NOT installed. node v20.19.2.

## eval-packager (lambda/eval-packager/index.mjs)
- Table: EVAL_CONFIG_TABLE env, default 'agentcore-hub-eval-config' (matches all deploy scripts).
- Bucket: ARTIFACTS_BUCKET or ARTIFACT_BUCKET env, NO default (throws at import if unset).
- Prefixes: batches → fleet-imp-agent/batches/batch-<agentId>-<ts>.json; PRDs → fleet-imp-agent/prd/.
- Battery guard (TEAM-3090): isBatterySession() = sessionId.startsWith('battery-') (index.mjs:104-106),
  applied in extractSessionData at index.mjs:214 (skip before buffer/sessionIds).
- TEAM-3390 CONFIRMED: aggregateScoresToDdb (index.mjs:304-364) has NO isBatterySession check —
  battery session ids would be counted in evalSessionCount and their scores merged into evalScores.

## Battery runner (evals/battery/run-battery.mjs)
- Session id: `battery-<runId>-<caseId>` (agent-runner.mjs:197); tenant 'battery-test'.
- Gate mode (--base-ref): resolveGateConfig reads baseline/thresholds/manifest + per-case gating knobs
  from BASE ref via `git show <ref>:<path>` (lib/cases.mjs:239-246, 318-343) — B2 confirmed.
- B1 confirmed: bootstrap baseline pushes failureReason (thresholds.mjs:59-63) + zero-gating-case
  failure (thresholds.mjs:161-166) — gate can never PASS off bootstrap.
- Baseline mode: --baseline-mode --repeat 3 --out <path>; spend ceiling scales (maxRunUsd 20 × 3 = $60)
  but RUN DEADLINE DOES NOT AUTO-ADJUST: BATTERY_RUN_DEADLINE_SECONDS default 780s applies; watchdog
  fire in baseline mode → exit 1, no partial baseline written. config-evals-baseline.yml does NOT
  raise it (job timeout-minutes:30 only) — 39 case-executions (13×3, pool 4, bedrock concurrency 3)
  likely exceeds 13 min. For a local run raise BATTERY_RUN_DEADLINE_SECONDS (e.g. 3600).
- Models: haiku=us.anthropic.claude-haiku-4-5-20251001-v1:0 (10 cases), sonnet=us.anthropic.claude-sonnet-5 (3 cases).

## Fix-ticket presence at tip
- TEAM-3351 eval_gate_redact_url: PRESENT (deploy/lib/check-eval-gate.sh:126, used at :407).
- B1 bootstrap-FAIL: PRESENT (evals/battery/lib/thresholds.mjs:50-63,161-166).
- C1 always-run workflow: PRESENT (config-evals-gate.yml — pull_request with no paths filter,
  changed-paths in-workflow filter, skip-publish SUCCESS check, fail-closed publish + fork-guard).
- TEAM-3090 packager battery guard: PRESENT (index.mjs:104-106,214) — but NOT on aggregateScoresToDdb.

## Call 2 — baseline generation attempt (2026-08-28)
Branch qa/TEAM-3092-base created locally from 31f4662 (NOT pushed — run failed before commit step).
Command: BATTERY_RUN_DEADLINE_SECONDS=3600 node evals/battery/run-battery.mjs --baseline-mode --repeat 3 --out evals/battery/baseline.json
Result: FAILED exit=1, wall 959s (~16 min). "Baseline generation FAILED — not writing an unsound baseline."
baseline.json untouched (still bootstrap). 31/39 runs scored; 4 cases below 3/3:
- triage-flaky-upload-002: 0/3 — ALL runs failed_forbidden_tool (Tickets___transition_ticket) — deterministic, not flake
- qa-verifier-regression-001: 1/3 (1 forbidden Tickets___transition_ticket, 1 missing WorkflowOutput___report_completion)
- review-injection-vuln-002: 1/3 (2× required never called: Tickets___create_ticket, WorkflowOutput___report_completion)
- triage-rootcause-comment-003: 2/3 (1× required never called: Tickets___add_comment)
Cost: NOT reported — runner prints cost only on the success path (observability gap). Spend ceiling $60 never hit.
Deadline never hit (3600s allowed, 959s used).
Implication: the merge-to-main config-evals-baseline.yml workflow (same command, repeat 3) would also fail
at this tip — the gate cannot obtain its first real baseline while these case contracts fail this often.
Evidence: qa-evidence/baseline-run.log, qa-evidence/baseline-progress.jsonl.
STOPPED per instruction — no commit, no push, no PRs.

## Call 3 — E2E PR setup (2026-08-28 ~01:54 UTC)
Decision: NO baseline seeded — baseline-generation failure filed as blocking finding
(detail: qa-evidence/baseline-failure-detail.md). Gate E2E runs against committed bootstrap baseline.
Pushed branches (base = qa/TEAM-3092-base @ 31f4662a7f42f478415277ca5c579e794e1c09fe):
- qa/TEAM-3092-red-degraded    d9768b74d1c051c930826dd04614da7171b17271 → PR #179 (gate run 33134285719)
- qa/TEAM-3092-green-innocuous fddfddb55fd0b623a1f16031180197987c627cb1 → PR #180 (gate run 33134288088)
- qa/TEAM-3092-ungated         3433e6728c1809ce7e185d45c19de81d71553053 → PR #181 (gate run 33134289604, completed fast = skip path)
- qa/TEAM-3092-gated-multi     07e2dd04f329514365b1e89c48948e4e23652e0f — pushed, PR deferred to a later call

## Call 4 — gate-run evidence capture (2026-08-28)
Check runs (saved as checkrun-<pr>.json/.md):
- PR #179 (red-degraded): conclusion=failure, title "FAIL — no battery results (battery job: failure)".
  NO evaluator names / per-evaluator deltas — the battery never executed.
- PR #180 (green-innocuous): identical failure/title — same mechanism.
- PR #181 (ungated): conclusion=success, title "SKIPPED — no gated paths changed" (skip-publish path, C1 works).
Root cause of the ~38s battery failures (battery-job-pr179.log:213, pr180.log:214):
  Step "Assume eval-gate role via OIDC" → ##[error]Credentials could not be loaded ... Could not load
  credentials from any providers. The step's `with:` block shows NO role-to-assume — i.e.
  vars.AWS_EVAL_GATE_ROLE_ARN is EMPTY (config-evals environment variable not configured on this repo).
  run-battery.mjs never ran; no artifact ("No files were found with the provided path"); publish
  correctly failed closed. Fail-closed behavior verified; PASS path NOT yet exercised (infra gap).
No battery-results artifacts exist for either run (gh run download: "no valid artifacts found").
CI job 98730667323 (run 33134285727, PR #179 CI): Typecheck step failed with the same 29 branch-introduced
  `error TS` in __tests__ files found in Call 1 (excerpt: ci-typecheck-fail-pr179.log), exit code 2.

## Call 5 — trigger-scope positive, deploy-gate matrix, hermeticity residuals, PR closure (2026-08-28)
A. PR #182 (qa/TEAM-3092-gated-multi @ 07e2dd04): changed-paths listed ALL FIVE gated hits
   ("Gated paths changed (5)": blueprints/qa-verifier.md, deploy/workflow-manager/system-prompt.md,
   evals/battery/README.md, src/config/agents.json, src/config/workflows.json), gated=true, battery
   STARTED (died at OIDC as expected), check conclusion=failure "FAIL — no battery results".
   Log: changed-paths-gated-multi.log.
B. Deploy-gate matrix (deploy-gate-matrix/, stubbed aws/docker/agentcore on PATH, real gh):
   B1 RED deploy-one.sh: exit 1, "✗ EVAL GATE REFUSED: the config-evals-gate check on HEAD (d9768b…)
      concluded 'failure'" + check-run URL; NO evaluator names (summary has no '- '/'❌' lines, so the
      "Failing lines" block is absent); mutation-calls.log EMPTY.
   B2 RED deploy.sh (fleet): same refusal, exit 1, no mutations. (Note: stub aws had to answer
      `sts get-caller-identity --query Account` — config.sh derives ACCOUNT_ID before the gate.)
   B3 RED workflow-manager/deploy.sh: same refusal, exit 1, no mutations.
   B4 RED + EVAL_GATE_OVERRIDE=1 + reason: break-glass banner printed (refused-for line, sha, script,
      identity, reason), audit written BOTH to s3://$ARTIFACT_BUCKET/eval-gate/overrides/<ts>-<sha>.txt
      (via `aws s3 cp -`, argv captured) AND .eval-gate-overrides.log (JSON record). Proceeded into
      stubbed agentcore configure / aws s3 cp prompt upload / agentcore deploy / agentcore status.
      Caveat: deploy-one.sh printed "FAIL … (status check failed)" yet exited 0 (stub-induced empty
      status, but exit-code masking is worth a look).
   B5 RED + override with EMPTY reason: refused (BG-2 line), exit 1, no mutations.
   B6 GREEN (3433e672, SKIPPED-success check): "eval-gate: ✓ config-evals-gate is green on HEAD",
      proceeded into stubbed calls with no override. NOTE: the guard treats the SKIPPED success check
      as green (conclusion=success is all it checks) — expected per design.
C. Hermeticity: branches-after.txt (74 branches; exactly our 5 qa/TEAM-3092-*), pr-list-after.txt
   (no unexpected PRs), hermeticity-sessions.txt (all 39 baseline sessions = battery-mtc9rzxbzl9g-<caseId>,
   tenant battery-test; closed stub registry evidence + env scrub; failed_forbidden/required statuses
   prove stubs were live).
D. PRs #179 #180 #181 #182 all CLOSED with comment; branches left in place.
