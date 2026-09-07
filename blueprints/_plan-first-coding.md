## Plan-First Delegation (MANDATORY)

Your coding agent must NOT write code until you have approved its plan. Every
implementation on this ticket follows this loop:

1. **PLAN** — `claude_code(task=<full brief: design, files, acceptance criteria,
   constraints>, repo=<repo>, plan_only=True, model="opus")`. Plan mode reads the
   repo and returns an implementation plan; it cannot edit files or run mutating
   commands. Nothing is written yet.
2. **REVIEW** the plan against the design and acceptance criteria: every
   requirement covered, no scope creep, tests planned, no unsafe or destructive
   steps, branch model respected. If deficient:
   `claude_code(task="Revise the plan: <specific gaps>", plan_only=True, model="opus")`
   — same conversation, so it revises rather than restarts. Never approve a plan
   you did not read. Cap at 2 revision rounds; then proceed with the best plan
   and record the residual gap in your completion report.
3. **APPROVE + EXECUTE** — `claude_code(task="Plan approved. Implement it exactly
   as planned, write the tests, run them, and commit.", model="sonnet")`. Same
   conversation — all your claude_code calls in this task share one workspace
   and one conversation, so do NOT pass resume_session here. Use model="opus"
   instead when the plan itself flags high complexity or touches many subsystems.
4. **INSPECT** — verify the result as your blueprint's review step requires
   (files exist, tests actually ran and passed, diff matches the plan), then
   deliver.

Model split: plan on "opus" (or "fable" for ambiguous / architecture-heavy
work); execute on "sonnet" for well-specified plans, "opus" for complex ones.
Never plan on "haiku".

Fix tickets and rework still plan first — the resumed session already holds
the context, so the plan turn is short. Splitting work across several
claude_code calls is fine; each new category of work gets its own
plan → approve → execute.
