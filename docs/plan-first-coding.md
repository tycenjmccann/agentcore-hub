# Plan-first coding delegation

**Status:** the standard for every coding persona. Always on, no flag.

## What it is

Before this change a coding persona (backend dev, frontend dev, bug fixer)
handed a brief to `claude_code`, the CLI implemented it in one autonomous turn,
and the persona inspected the result. The inspection was real but shallow: the
persona only saw the outcome, never the approach.

Plan-first splits the delegation into two turns on one conversation:

1. **Plan turn** — `claude_code(task=<brief>, plan_only=True, model="opus")`.
   Claude Code runs in plan mode (`--permission-mode plan`): it reads the repo
   and returns an implementation plan. It cannot edit files or run mutating
   commands. Nothing is written.
2. **Review** — the persona checks the plan against the design and acceptance
   criteria. A deficient plan goes back with specific feedback
   (`plan_only=True` again, same conversation, so it revises rather than
   restarts). Capped at two revision rounds.
3. **Execute turn** — `claude_code(task="Plan approved. Implement it exactly as
   planned…", model="sonnet")`. A normal full-autonomy turn that `--resume`s
   the plan turn's conversation, so the approved plan is its context.
4. **Inspect** — unchanged: the persona verifies files, tests, and diff as its
   blueprint already requires.

Each turn is a separate CLI process; only the session id is shared. That is
what makes the model split free: plan on a strong model, execute on a cheaper
one, per call. Default split: plan on `opus` (`fable` for ambiguous or
architecture-heavy work), execute on `sonnet` (`opus` when the plan flags high
complexity). Never plan on `haiku`.

## Evidence

Validated locally on 2026-09-06 before any product change, using the **real**
`agentcore_hub_backend_dev` system prompt and the **real** `backend-dev`
blueprint plus the protocol, persona on Fable 5.1, CLI on Haiku, a
workflow-shaped ticket against a scratch git repo, and independent pytest
verification of the result.

| Check | Result |
|---|---|
| Plan turn wrote no code | 20/20 |
| Persona approved, then executed in the same session | 20/20 |
| Tests passed (verified independently of the persona's claim) | 20/20 |
| Persona rejected the first plan, got a revision, then approved | 2/20 |
| Stranded / orphaned CLI sessions | 0 |
| Mean wall time per run | ~3.5 min (one 18-min upstream-latency outlier, clean flow) |

The two revision rounds are the important number: the gate is a real review,
not a rubber stamp, and the revise path recovers.

## What shipped

**Blueprints** — the protocol is written into the delegation step of
`blueprints/backend-dev.md` (Step 2), `blueprints/frontend-dev.md` (Step 3)
and `blueprints/bug-fixer.md` (Step 3: the fix is planned after the root cause
is confirmed in Step 2). Each blueprint's Rules pin the model split. Synced to
the artifact bucket by the deploy stage like every other blueprint; unit tests
pin the protocol's presence in all three.

**Coding runtime** (`deploy/coding-agent-runtime/main.py`) — a per-turn
`permission_mode` payload field. Only `"plan"` is honored, swapping
`--dangerously-skip-permissions` for `--permission-mode plan`; anything else
(absent, unknown, typo) runs a normal full-autonomy turn. Threaded through the
sync, streaming, and async (submit+poll) paths.

**Fleet** (`deploy/runtime-agent/main.py`) — `claude_code(..., plan_only: bool
= False)`. Remote path → `permission_mode: "plan"` in the payload (claude only;
a legacy far side ignores the field and runs a normal turn). Local fallback
path → `--permission-mode plan`, and once a task has used `plan_only` every
local call runs with JSON output and `--resume`s the stashed conversation, so
the execute turn lands on the plan. A task that never passes `plan_only` keeps
the previous argv byte-for-byte.

## Rollout

1. Deploy the coding runtime image (the `permission_mode` field) **first**. A
   fleet or blueprint that asks for a plan turn from a legacy runtime degrades
   gracefully (normal turn), but there is no reason to run in that state.
2. Deploy the fleet image (the `plan_only` tool arg) and sync `blueprints/` to
   the artifact bucket. The pipeline's deploy stage syncs blueprints; runtime
   images are a handoff and are deployed by hand.
3. Watch a few runs: the plan turn shows up as its own `claude_code` call with
   `plan_only` in the agent output log, followed by the execute call on the
   same `conversation=` id.

Rollback is a blueprint edit: restore the previous delegation step and re-sync
`blueprints/`. The tool arg is inert unless a blueprint asks for it.

## Not in this change

- **Codex** has no plan mode equivalent. `plan_only` is ignored for `codex`
  (the payload never carries `permission_mode` for it). The bug-fixer blueprint
  tells the persona to ask codex for a text plan and approve it before the fix
  turn when on that fallback. A read-only sandbox turn
  (`codex exec --sandbox read-only`) could enforce it later.
- **Other coding personas** (api-dev, code-sweeper, playbook-build) keep their
  current delegation; adopt by copying the delegation step.
- **Plan artifacts.** Claude Code persists plans under its config dir on the
  coding runtime's EFS; they are not yet harvested to S3 or surfaced in the
  workflow artifact viewer.
