# Config-evals battery: ❌ FAIL

- **Run:** `mtc9cbadxgfm` @ `cff23d5a0201bfb6a328280eb931419edd5f2834`
- **Baseline:** `mock-synthetic-baseline` (backend: mock)
- **Cost:** $0.4 — **Runtime:** 1.3s
- **Gating cases:** 13 compared against the baseline
- **Overall:** baseline 85.6 → current 77.24 (Δ -8.36, scale 0-100)

## Failure reasons
- case qa-build-verification-002, evaluator Builtin.InstructionFollowing: current 20 < floor 80 (baseline mean 90)
- case qa-build-verification-002, evaluator persona_contract_compliance: current 20 < floor 80 (baseline mean 90)
- case qa-design-mismatch-003, evaluator Builtin.InstructionFollowing: current 20 < floor 80 (baseline mean 90)
- case qa-design-mismatch-003, evaluator persona_contract_compliance: current 20 < floor 80 (baseline mean 90)
- case qa-verifier-degradation-canary-004, evaluator Builtin.InstructionFollowing: current 20 < floor 80 (baseline mean 90)
- case qa-verifier-degradation-canary-004, evaluator persona_contract_compliance: current 20 < floor 80 (baseline mean 90)
- case qa-verifier-regression-001, evaluator Builtin.InstructionFollowing: current 20 < floor 80 (baseline mean 90)
- case qa-verifier-regression-001, evaluator persona_contract_compliance: current 20 < floor 80 (baseline mean 90)
- overall mean dropped 8.36 points (baseline 85.6 → current 77.24); allowed drop is 5 (strict)

## Per-evaluator deltas
| Case | Evaluator | Baseline | Current | Δ | Floor | Verdict |
|---|---|---:|---:|---:|---:|---|
| fix-null-session-crash-001 | Builtin.ToolSelectionAccuracy | 85 | 85 | 0 | 75 | ✅ pass |
| fix-null-session-crash-001 | Builtin.ToolParameterAccuracy | 85 | 85 | 0 | 75 | ✅ pass |
| fix-null-session-crash-001 | Builtin.InstructionFollowing | 85 | 85 | 0 | 75 | ✅ pass |
| fix-null-session-crash-001 | Builtin.GoalSuccessRate | 85 | 85 | 0 | 75 | ✅ pass |
| fix-null-session-crash-001 | Builtin.Correctness | 85 | 85 | 0 | 75 | ✅ pass |
| fix-pagination-offbyone-002 | Builtin.ToolSelectionAccuracy | 85 | 85 | 0 | 75 | ✅ pass |
| fix-pagination-offbyone-002 | Builtin.InstructionFollowing | 85 | 85 | 0 | 75 | ✅ pass |
| fix-pagination-offbyone-002 | Builtin.GoalSuccessRate | 85 | 85 | 0 | 75 | ✅ pass |
| fix-pagination-offbyone-002 | Builtin.Correctness | 85 | 85 | 0 | 75 | ✅ pass |
| fix-pagination-offbyone-002 | Builtin.Coherence | 85 | 85 | 0 | 75 | ✅ pass |
| fix-race-condition-cas-003 | Builtin.ToolSelectionAccuracy | 85 | 85 | 0 | 75 | ✅ pass |
| fix-race-condition-cas-003 | Builtin.InstructionFollowing | 85 | 85 | 0 | 75 | ✅ pass |
| fix-race-condition-cas-003 | Builtin.GoalSuccessRate | 85 | 85 | 0 | 75 | ✅ pass |
| fix-race-condition-cas-003 | Builtin.Correctness | 85 | 85 | 0 | 75 | ✅ pass |
| fix-race-condition-cas-003 | Builtin.Coherence | 85 | 85 | 0 | 75 | ✅ pass |
| qa-build-verification-002 | Builtin.ToolSelectionAccuracy | 85 | 85 | 0 | 75 | ✅ pass |
| qa-build-verification-002 | Builtin.ToolParameterAccuracy | 85 | 85 | 0 | 75 | ✅ pass |
| qa-build-verification-002 | Builtin.InstructionFollowing | 90 | 20 | -70 | 80 | ❌ floor_breach |
| qa-build-verification-002 | Builtin.GoalSuccessRate | 85 | 85 | 0 | 75 | ✅ pass |
| qa-build-verification-002 | Builtin.Correctness | 85 | 85 | 0 | 75 | ✅ pass |
| qa-build-verification-002 | persona_contract_compliance | 90 | 20 | -70 | 80 | ❌ floor_breach |
| qa-design-mismatch-003 | Builtin.InstructionFollowing | 90 | 20 | -70 | 80 | ❌ floor_breach |
| qa-design-mismatch-003 | Builtin.GoalSuccessRate | 85 | 85 | 0 | 75 | ✅ pass |
| qa-design-mismatch-003 | Builtin.Correctness | 85 | 85 | 0 | 75 | ✅ pass |
| qa-design-mismatch-003 | Builtin.Faithfulness | 85 | 85 | 0 | 75 | ✅ pass |
| qa-design-mismatch-003 | Builtin.Helpfulness | 85 | 85 | 0 | 75 | ✅ pass |
| qa-design-mismatch-003 | persona_contract_compliance | 90 | 20 | -70 | 80 | ❌ floor_breach |
| qa-verifier-degradation-canary-004 | Builtin.InstructionFollowing | 90 | 20 | -70 | 80 | ❌ floor_breach |
| qa-verifier-degradation-canary-004 | Builtin.GoalSuccessRate | 85 | 85 | 0 | 75 | ✅ pass |
| qa-verifier-degradation-canary-004 | Builtin.Correctness | 85 | 85 | 0 | 75 | ✅ pass |
| qa-verifier-degradation-canary-004 | Builtin.Faithfulness | 85 | 85 | 0 | 75 | ✅ pass |
| qa-verifier-degradation-canary-004 | persona_contract_compliance | 90 | 20 | -70 | 80 | ❌ floor_breach |
| qa-verifier-regression-001 | Builtin.ToolSelectionAccuracy | 85 | 85 | 0 | 75 | ✅ pass |
| qa-verifier-regression-001 | Builtin.InstructionFollowing | 90 | 20 | -70 | 80 | ❌ floor_breach |
| qa-verifier-regression-001 | Builtin.GoalSuccessRate | 85 | 85 | 0 | 75 | ✅ pass |
| qa-verifier-regression-001 | Builtin.Correctness | 85 | 85 | 0 | 75 | ✅ pass |
| qa-verifier-regression-001 | persona_contract_compliance | 90 | 20 | -70 | 80 | ❌ floor_breach |
| review-error-handling-001 | Builtin.ToolSelectionAccuracy | 85 | 85 | 0 | 75 | ✅ pass |
| review-error-handling-001 | Builtin.InstructionFollowing | 85 | 85 | 0 | 75 | ✅ pass |
| review-error-handling-001 | Builtin.GoalSuccessRate | 85 | 85 | 0 | 75 | ✅ pass |
| review-error-handling-001 | Builtin.Correctness | 85 | 85 | 0 | 75 | ✅ pass |
| review-error-handling-001 | Builtin.Faithfulness | 85 | 85 | 0 | 75 | ✅ pass |
| review-eventual-consistency-003 | Builtin.InstructionFollowing | 85 | 85 | 0 | 75 | ✅ pass |
| review-eventual-consistency-003 | Builtin.GoalSuccessRate | 85 | 85 | 0 | 75 | ✅ pass |
| review-eventual-consistency-003 | Builtin.Correctness | 85 | 85 | 0 | 75 | ✅ pass |
| review-eventual-consistency-003 | Builtin.Faithfulness | 85 | 85 | 0 | 75 | ✅ pass |
| review-eventual-consistency-003 | Builtin.Coherence | 85 | 85 | 0 | 75 | ✅ pass |
| review-injection-vuln-002 | Builtin.Correctness | 85 | 85 | 0 | 75 | ✅ pass |
| review-injection-vuln-002 | Builtin.GoalSuccessRate | 85 | 85 | 0 | 75 | ✅ pass |
| review-injection-vuln-002 | Builtin.InstructionFollowing | 85 | 85 | 0 | 75 | ✅ pass |
| review-injection-vuln-002 | Builtin.Faithfulness | 85 | 85 | 0 | 75 | ✅ pass |
| review-injection-vuln-002 | Builtin.Helpfulness | 85 | 85 | 0 | 75 | ✅ pass |
| triage-crash-chain-001 | Builtin.ToolSelectionAccuracy | 85 | 85 | 0 | 75 | ✅ pass |
| triage-crash-chain-001 | Builtin.ToolParameterAccuracy | 85 | 85 | 0 | 75 | ✅ pass |
| triage-crash-chain-001 | Builtin.InstructionFollowing | 85 | 85 | 0 | 75 | ✅ pass |
| triage-crash-chain-001 | Builtin.GoalSuccessRate | 85 | 85 | 0 | 75 | ✅ pass |
| triage-crash-chain-001 | dependency_chain_compliance-VyBv7H2bCi | 85 | 85 | 0 | 75 | ✅ pass |
| triage-flaky-upload-002 | Builtin.InstructionFollowing | 85 | 85 | 0 | 75 | ✅ pass |
| triage-flaky-upload-002 | Builtin.GoalSuccessRate | 85 | 85 | 0 | 75 | ✅ pass |
| triage-flaky-upload-002 | Builtin.Correctness | 85 | 85 | 0 | 75 | ✅ pass |
| triage-flaky-upload-002 | Builtin.Faithfulness | 85 | 85 | 0 | 75 | ✅ pass |
| triage-flaky-upload-002 | Builtin.Coherence | 85 | 85 | 0 | 75 | ✅ pass |
| triage-rootcause-comment-003 | Builtin.ToolSelectionAccuracy | 85 | 85 | 0 | 75 | ✅ pass |
| triage-rootcause-comment-003 | Builtin.InstructionFollowing | 85 | 85 | 0 | 75 | ✅ pass |
| triage-rootcause-comment-003 | Builtin.GoalSuccessRate | 85 | 85 | 0 | 75 | ✅ pass |
| triage-rootcause-comment-003 | Builtin.Helpfulness | 85 | 85 | 0 | 75 | ✅ pass |
| triage-rootcause-comment-003 | Builtin.Conciseness | 85 | 85 | 0 | 75 | ✅ pass |

## Floor violations
- **qa-build-verification-002** / **Builtin.InstructionFollowing**: 20 < floor 80
  - Judge: mock judge: working-tree prompt for agentcore_hub_qa_verifier covers 43% of the reference persona contract (threshold 55%)
- **qa-build-verification-002** / **persona_contract_compliance**: 20 < floor 80
  - Judge: mock judge: working-tree prompt for agentcore_hub_qa_verifier covers 43% of the reference persona contract (threshold 55%)
- **qa-design-mismatch-003** / **Builtin.InstructionFollowing**: 20 < floor 80
  - Judge: mock judge: working-tree prompt for agentcore_hub_qa_verifier covers 29% of the reference persona contract (threshold 55%)
- **qa-design-mismatch-003** / **persona_contract_compliance**: 20 < floor 80
  - Judge: mock judge: working-tree prompt for agentcore_hub_qa_verifier covers 29% of the reference persona contract (threshold 55%)
- **qa-verifier-degradation-canary-004** / **Builtin.InstructionFollowing**: 20 < floor 80
  - Judge: mock judge: working-tree prompt for agentcore_hub_qa_verifier covers 33% of the reference persona contract (threshold 55%)
- **qa-verifier-degradation-canary-004** / **persona_contract_compliance**: 20 < floor 80
  - Judge: mock judge: working-tree prompt for agentcore_hub_qa_verifier covers 33% of the reference persona contract (threshold 55%)
- **qa-verifier-regression-001** / **Builtin.InstructionFollowing**: 20 < floor 80
  - Judge: mock judge: working-tree prompt for agentcore_hub_qa_verifier covers 33% of the reference persona contract (threshold 55%)
- **qa-verifier-regression-001** / **persona_contract_compliance**: 20 < floor 80
  - Judge: mock judge: working-tree prompt for agentcore_hub_qa_verifier covers 33% of the reference persona contract (threshold 55%)

## Retired cases (excluded from execution — retirement is visible, never silent)
- **template-copy-me-and-rename**: template file — never runs; copy, edit, set status:active

