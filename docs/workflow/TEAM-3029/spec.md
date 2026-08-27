# Spec — TEAM-3029: Committed artifact chain: intent/spec/plan checked into the PR branch
Source of record: this file. Transport copy: s3://…/workflows/wf_1787777062568_172bt5/shared/

## Functional requirements
- **FR1:** Requirements phase produces `intent.md` + `spec.md` (S3 → committed by first dev agent, mechanism D1) — AC: both files present under `docs/workflow/<ticketId>/` in the workflow PR; requirements blueprints/prompts (`blueprints/requirements-analyst.md`, `blueprints/bug-fix-requirements.md`, 2 prompt txts) updated with the obligation + templates.
- **FR2:** Dev/fixer phase commits `docs/workflow/<ticketId>/plan.md` (files-to-touch, approach, test plan) before implementation; multi-dev workflows append sections — AC: 4 dev blueprints + 5 dev prompt txts contain "Commit the plan first" instructions.
- **FR3:** Code reviewer performs explicit plan-vs-diff check; divergence or missing artifacts = P1 (Important) finding — AC: `blueprints/code-reviewer.md` gains the step + tolerance rule; `agentcore_hub_code_reviewer.txt` lists the failure modes.
- **FR4:** NET NEW `.github/pull_request_template.md` with `## Audit Trail` linking the three artifacts — AC: file exists, ≤40 lines, relative links.
- **FR5:** Guardrails — `blueprints/code-sweeper.md` gains "NEVER remove docs/workflow/**"; `knip.json` byte-identical (docs/ already out of scope); artifacts additive-only, ≤60 lines each; S3 writes unchanged.

## Out of scope
- Any change under `src/`, `lambda/`, `mcp/`, `scripts/`, `tests/` (app code) or to `knip.json`.
- Replacing the S3 artifact handoff (it remains the transport; the repo copy is the audit record).

## Ticket plan
| Ticket | Assignee (agent) | Blocked by |
|---|---|---|
| T1 — Design: artifact templates + per-file insertion spec | agentcore_hub_backend_designer | none |
| T2 — Implement: apply insertion spec across blueprints, prompts, PR template | agentcore_hub_backend_dev | T1 |
| T3 — Review: insertion fidelity + plan-vs-diff | agentcore_hub_code_reviewer | T2 |
| T4 — QA: independent verification | agentcore_hub_qa_verifier | T3 |
| T5 — CI: pipeline green | agentcore_hub_ci_agent | T4 |
