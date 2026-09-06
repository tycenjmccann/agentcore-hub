# Blueprint: Playbook Build (plan.md before code)

Loaded by dev agents on playbook runs (software-delivery with the playbook framework). Your ticket description says
which section applies: **PLAN TICKET** or **IMPLEMENTATION TICKET**. Your
`## SDLC Framework` context names `artifact_dir` (`.sdlc/<workflow_id>`) and
`artifact_branch` (the run's shared feature branch). Your `## Branch` context
still applies for implementation (branch from base_branch, PR into it, merge
your PR into it).

The playbook rule you serve: nothing is implemented without an accepted
written plan; the later review checks the diff against that plan.

---

## PLAN TICKET (title starts with `Plan:`)

You write `plan.md`. You do NOT implement. The orchestrator blocks this ticket
at close if `<artifact_dir>/plan.md` is not on `artifact_branch`.

### Step 1: Read the chain
`<artifact_dir>/spec.md` and `<artifact_dir>/intent.md` on `artifact_branch`
(also mirrored at `workflows/{workflow_id}/shared/`). The spec's Requirements,
Design and Test plan are your inputs. Do not re-decide the design; plan how to
build it in THIS codebase.

### Step 2: Plan with claude_code — read-only except the plan file
Pass `repo` on the first call. Brief:

```
claude_code(
  repo="<owner>/<repo>",
  task="PLAN MODE. Check out <artifact_branch>. Read <artifact_dir>/spec.md and <artifact_dir>/intent.md.
  Explore the codebase (structure, existing patterns, tests, build/lint commands, CLAUDE.md if present).
  Write <artifact_dir>/plan.md with EXACTLY these sections:
  # Plan: <title>
  - Workflow / Spec commit: <sha> / Author: <your agent id> / Status: proposed
  ## Approach — how the spec's Design lands in this codebase, in order. Reference concrete files and functions.
  ## Files — table: | Path | Change (add/modify/delete) | Why | — every file you expect to touch.
  ## What could this break? — the engineer's interrogation, answered in advance: existing callers, shared state, migrations, config/env, error paths, races, performance, accessibility. One line each with the mitigation.
  ## Test plan — the tests you will ADD or CHANGE (file + case names), how you will run them, and the visual/iOS evidence you will produce (per the dev blueprint for this surface).
  ## Rollback — how to undo this change if it ships and misbehaves.
  ## Open questions — anything the engineer must decide at Plan Approval; 'None.' if none.
  ## Deviations — leave as 'None yet.' (the implementer records deviations here).
  Commit ONLY that file with message 'plan: <title> (<workflow_id>)' and push to <artifact_branch>. Report the commit sha.
  Do NOT modify any other file. Do NOT implement."
)
```

Verify the result names the commit sha and the path. If the push failed, fix
it now.

### Step 3: Mirror + review package
- `S3Storage___write_object` the plan text to `workflows/{workflow_id}/shared/plan.md`.
- `load_blueprint("review-package")` and write
  `workflows/{workflow_id}/shared/review-package-plan.json` with `gate: "plan"`.
  The reviewer is an engineer asking "what could this break?": summary = the
  approach in one sentence; bullets = the top risks from `## What could this
  break?` with their mitigations, the files count, the tests you will add, the
  open questions; links: `shared/plan.md` first, then `shared/spec.md`.

### Step 4: report_completion
`WorkflowOutput___report_completion` with `artifacts` = `<artifact_dir>/plan.md`,
`commit_sha`, `branch`. Nothing else is expected from this ticket.

---

## IMPLEMENTATION TICKET (blocked by the Plan Approval gate)

Follow your surface's standard dev blueprint (`backend-dev`, `frontend-dev`,
`api-dev`) for branch model, evidence, tests, visual/iOS verification, PR and
merge into base_branch — ALL of that still applies. This section adds the
playbook constraints on top.

### Read the approved plan first
`<artifact_dir>/plan.md` on `artifact_branch` is the accepted plan; the
engineer approved THAT. Implement its `## Approach`, touch the files in
`## Files`, add the tests in `## Test plan`. Read `## Open questions` — the
engineer's answers are in the Plan Approval ticket's comments; apply them.

### Deviations are recorded, never silent
If reality forces a change from the plan (a file the plan missed, a different
approach, a test that cannot be written as planned): append a row to plan.md
`## Deviations` — `| # | What changed | Why | Risk |` — and commit it on
`artifact_branch` alongside the code. The code reviewer diffs the branch
against plan.md; an unrecorded deviation is a finding and sends the work back.

### Do not edit the chain otherwise
`intent.md` and `spec.md` are read-only for you. A spec problem goes to the
ticket as a comment and, if blocking, `report_completion` with BLOCKED.

### Resume your session
Your `## Prior Coding Session` block (if any) is the Plan ticket's session
when you also wrote the plan — resume it; it already knows the codebase.

### report_completion
As your standard blueprint: `pr_url`, `commit_sha`, `branch`, evidence paths,
plus the sentence "Deviations from plan: <n> (recorded in plan.md)".

## Rules
- Plan ticket: exactly one file changes on the branch (`<artifact_dir>/plan.md`).
- Implementation ticket: nothing outside the approved plan without a recorded deviation.
- Evidence rules of your surface's dev blueprint are unchanged (tests, build, screenshots, iOS gateway).
