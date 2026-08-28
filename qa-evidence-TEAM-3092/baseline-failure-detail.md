# Baseline-generation failure detail (blocking finding — TEAM-3092 QA)

Run: `BATTERY_RUN_DEADLINE_SECONDS=3600 node evals/battery/run-battery.mjs --baseline-mode --repeat 3 --out evals/battery/baseline.json`
at qa/TEAM-3092-base = 31f4662a7f42f478415277ca5c579e794e1c09fe. Exit 1, wall 959s, 2026-08-28 01:25–01:41 UTC.
Verdict line: "Baseline generation FAILED — not writing an unsound baseline." baseline.json untouched (bootstrap).
The production merge-to-main workflow (.github/workflows/config-evals-baseline.yml:79) runs the IDENTICAL
command, so the first real baseline can never be published at this tip.

## Per-case scored counts (repeat 3; from baseline-progress.jsonl, 39 runs)
| case | scored | statuses |
|---|---|---|
| fix-null-session-crash-001 | 3/3 | scored ×3 |
| fix-pagination-offbyone-002 | 3/3 | scored ×3 |
| fix-race-condition-cas-003 | 3/3 | scored ×3 |
| qa-build-verification-002 | 3/3 | scored ×3 |
| qa-design-mismatch-003 | 3/3 | scored ×3 |
| qa-verifier-degradation-canary-004 | 3/3 | scored ×3 |
| **qa-verifier-regression-001** | **1/3** | failed_forbidden_tool, failed_required_tool, scored |
| review-error-handling-001 | 3/3 | scored ×3 |
| review-eventual-consistency-003 | 3/3 | scored ×3 |
| **review-injection-vuln-002** | **1/3** | failed_required_tool, scored, failed_required_tool |
| triage-crash-chain-001 | 3/3 | scored ×3 |
| **triage-flaky-upload-002** | **0/3** | failed_forbidden_tool ×3 |
| **triage-rootcause-comment-003** | **2/3** | failed_required_tool, scored, scored |

## The 8 failed runs — exact mechanical failures (baseline-run.log line refs)
| log line | case | failure |
|---|---|---|
| :71  | qa-verifier-regression-001 | forbidden tool called: `Tickets___transition_ticket` (37.44s) |
| :76  | qa-verifier-regression-001 | required never called: `WorkflowOutput___report_completion` (29.7s) |
| :98  | review-injection-vuln-002 | required never called: `Tickets___create_ticket`, `WorkflowOutput___report_completion` (103.26s) |
| :103 | review-injection-vuln-002 | required never called: `Tickets___create_ticket`, `WorkflowOutput___report_completion` (198.32s) |
| :109 | triage-flaky-upload-002 | forbidden tool called: `Tickets___transition_ticket` (79.23s) |
| :114 | triage-rootcause-comment-003 | required never called: `Tickets___add_comment` (16.4s) |
| :118 | triage-flaky-upload-002 | forbidden tool called: `Tickets___transition_ticket` (70.98s) |
| :119 | triage-flaky-upload-002 | forbidden tool called: `Tickets___transition_ticket` ×3 in one run (48.2s) |

## Determinism
triage-flaky-upload-002 failed **3/3 runs**, every time by calling the forbidden `Tickets___transition_ticket`
(the third run called it three times). This is deterministic model behavior against the case contract,
not flake — re-running the baseline will not fix it. All failures are trajectory-contract violations by
the model under test (haiku for 3 cases, sonnet for review-injection-vuln-002); zero transport/judge/
deadline/spend failures occurred.

## Can the 4 misbehaving cases be retired?
No. `minActiveCases` lives in evals/battery/manifest.json (:3) — NOT thresholds.json — and is **10**,
with 13 currently active. Retiring the 4 failing cases leaves 9 < 10, which runner preflight rejects.
At most 3 can be retired without lowering minActiveCases; fixing the case contracts (or agent prompts)
is required regardless for triage-flaky-upload-002 plus at least one of the other three.

## Amplification note
--repeat 3 demands 3/3 scored per case, so a case with per-run failure rate p baselines with
probability (1-p)^3: the observed ~1/3 flake rate on three cases each gives ~30% per-case success —
the baseline workflow would fail on most attempts even ignoring the deterministic case.
