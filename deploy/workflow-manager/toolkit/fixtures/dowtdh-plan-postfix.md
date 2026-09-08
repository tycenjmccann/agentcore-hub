<!--
FIXTURE — the counter-case to dowtdh-plan-001fe322.md, and it is NOT a real commit.

dowtdh-plan-001fe322.md is verbatim `.sdlc/wf_1788731227559_dowtdh/plan.md` at
tycenjmccann/demo-app@001fe322 — the plan TEAM-4178 (Plan Approval) approved. It
resolves Concern 3 as "Keep fixed 5000 ms; no focus-pause (designer rec)", cites
TEAM-4174 zero times, and closes with "## Deviations: None yet.", which is why
reviewer finding F1 P1 had to catch the lost product-owner decision at the end of
the run.

This file is the minimal shape of the SAME plan written after the fix: the
Concern-3 row text below is the one the product owner's comment on TEAM-4174 was
finally reconciled into (TEAM-4174 comment 2026-09-06 15:09), and the Deviations
section names the decision id. Only the sections `unreferencedDecisions` reads are
reproduced — this is a fixture for the citation rule, not a replica of the 180-line
original.
-->

# Plan: Clear the Activity feed with an undo window
- Workflow: wf_1788731227559_dowtdh / Epic: TEAM-4162 / Plan ticket: TEAM-4177 / Author: agentcore_hub_frontend_dev / Status: proposed

## Approach

Unchanged from the approved plan except for the undo-window behaviour, which now
follows the product owner's gate decision.

## Concerns

| # | Concern | Policy | Owner | Proposed resolution | Status |
| --- | --- | --- | --- | --- | --- |
| 3 | (spec) Undo auto-dismisses at 5000 ms, not persistent. | UX | human:design-lead | 5000 ms window; pause the countdown while Undo has focus or hover (PO). Implemented as hover-pause on the notice row; focus-pause omitted — see Deviations D1. (PO, TEAM-4174 comment 2026-09-06 15:09.) | resolved |

## Deviations

- **D1 — Concern 3 / TEAM-4174#3, partially implemented.** The product owner's
  decision at Spec Approval TEAM-4174 was "5000 ms window; pause the countdown
  while Undo has focus or hover", restated at Design Approval TEAM-4176. Hover-pause
  ships as decided. Focus-pause is omitted: the notice row's only focusable child is
  the Undo button itself, so a focus-pause would hold the window open indefinitely
  for a keyboard user who tabs to Undo and does not press it, which contradicts
  Concern 2's "undo is the safety net, not a modal". Raised for the engineer at Plan
  Approval rather than decided here.
