# Intent — TEAM-3029: Committed artifact chain: intent/spec/plan checked into the PR branch
- **Requested by:** Epic TEAM-3029 (project tracker) — workflow orchestrator
- **Date:** 2026-08-26
- **Workflow:** wf_1787777062568_172bt5 | **Type:** feature

## Problem statement (verbatim from the root ticket)
> Workflow phases hand off via S3 artifacts and Jira comments. The final PR contains only the diff — reviewers and auditors cannot see WHY a change was made, what the spec was, or whether the implementation matches the plan, without leaving GitHub.

## Why now / impact
Per Anthropic's AI-Native SDLC "committed artifact" pattern, each pipeline phase should commit its artifact into the workflow branch under `docs/workflow/<ticketId>/` so the PR carries the full audit trail: who asked, what was specified, what was planned, what was built. Reviewers gain an explicit plan-vs-diff check.

## Success criteria
- Next 5 merged workflow PRs each contain `intent.md` + `spec.md` + `plan.md` under `docs/workflow/<ticketId>/`.
- At least one review finding cites plan-vs-diff comparison.
- Artifacts stay additive, ≤1 page each, excluded from dead-code sweeps; S3 handoff remains the transport.
