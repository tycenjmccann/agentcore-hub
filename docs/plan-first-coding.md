# Plan-first coding delegation

**Status:** shipped behind a flag, default OFF. Enable per fleet with
`PLAN_FIRST_CODING=on` (see Rollout).

## What it is

Today a coding persona (backend dev, frontend dev, bug fixer) hands a brief to
`claude_code`, the CLI implements it in one autonomous turn, and the persona
inspects the result. The inspection is real but shallow: the persona only sees
the outcome, never the approach.

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
one, per call.

## Evidence

Validated locally on 2026-09-06 before any product change, using the **real**
`agentcore_hub_backend_dev` system prompt and the **real** `backend-dev`
blueprint plus the protocol below, persona on Fable 5.1, CLI on Haiku, a
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

**Coding runtime** (`deploy/coding-agent-runtime/main.py`) — a per-turn
`permission_mode` payload field. Only `"plan"` is honored, swapping
`--dangerously-skip-permissions` for `--permission-mode plan`; anything else
(absent, unknown, typo) runs today's full-autonomy turn. Threaded through the
sync, streaming, and async (submit+poll) paths.

**Fleet** (`deploy/runtime-agent/main.py`)
- `claude_code(..., plan_only: bool = False)`. Remote path → `permission_mode:
  "plan"` in the payload (claude only; a legacy far side ignores the field and
  runs a normal turn). Local fallback path → `--permission-mode plan`, and once
  a task has used `plan_only` every local call runs with JSON output and
  `--resume`s the stashed conversation, so the execute turn lands on the plan.
  A task that never passes `plan_only` keeps today's argv byte-for-byte.
- `load_blueprint` appends the protocol fragment to coding blueprints when
  `PLAN_FIRST_CODING` is on. Source of truth is
  `blueprints/_plan-first-coding.md` in the artifact bucket (hot-editable,
  synced by the deploy stage with the other blueprints); an embedded copy is
  the fallback if that read fails, so an S3 hiccup cannot silently drop the
  gate. A unit test pins the two copies equal.
- Flag off → blueprint text and CLI argv are identical to before. The
  `plan_only` argument itself is always honored if a persona passes it.

**Config** — `PLAN_FIRST_CODING` (off | on) and `PLAN_FIRST_BLUEPRINTS`
(default `backend-dev,frontend-dev,bug-fixer`) in `deploy/config.sh`, passed
through by `deploy/runtime-agent/deploy-one.sh`.

## The protocol (as the persona sees it)

The text of `blueprints/_plan-first-coding.md`, appended to the persona's
blueprint on `load_blueprint`. Model split: plan on `opus` (`fable` for
ambiguous or architecture-heavy work), execute on `sonnet` (`opus` when the
plan flags high complexity). Never plan on `haiku`. Fix tickets and rework
still plan first — the resumed session already holds the context, so the plan
turn is short.

## Rollout

1. Deploy the coding runtime image (the `permission_mode` field) **first**. A
   fleet that sends the field to a legacy runtime degrades gracefully (normal
   turn), but there is no reason to run in that state.
2. Deploy the fleet image and sync `blueprints/` to the artifact bucket (the
   pipeline's deploy stage does both).
3. Enable on one persona first: `PLAN_FIRST_CODING=on
   PLAN_FIRST_BLUEPRINTS=backend-dev` on the shared fleet runtime
   (`deploy-one.sh` passes it through). Watch a few runs — the plan turn shows
   up as its own `claude_code` call with `plan_only` in the agent output log,
   followed by the execute call on the same `conversation=` id.
4. Widen to the default set (unset `PLAN_FIRST_BLUEPRINTS`).

Kill switch: unset `PLAN_FIRST_CODING` and redeploy the fleet env. Personas
stop receiving the protocol on their next `load_blueprint`; no other state.

## Not in this change

- **Codex** has no plan mode equivalent. `plan_only` is ignored for `codex`
  (the payload never carries `permission_mode` for it). A read-only sandbox
  turn (`codex exec --sandbox read-only`) could serve the same role later.
- **Static blueprint edits.** The protocol is injected under the flag rather
  than written into `backend-dev.md` etc., so flag-off is provably identical.
  Once the flag has been on for a while, folding the text into the blueprints
  and deleting the flag is the natural cleanup.
- **Plan artifacts.** Claude Code persists plans under its config dir on the
  coding runtime's EFS; they are not yet harvested to S3 or surfaced in the
  workflow artifact viewer.
