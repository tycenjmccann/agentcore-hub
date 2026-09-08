<!--
FIXTURE — the counter-case to dowtdh-plan-001fe322.md, and it is NOT a real commit.

dowtdh-plan-001fe322.md is verbatim `.sdlc/wf_1788731227559_dowtdh/plan.md` at
tycenjmccann/demo-app@001fe322 — the plan TEAM-4178 (Plan Approval) approved. It
resolves Concern 3 as "Keep fixed 5000 ms; no focus-pause (designer rec)", cites
TEAM-4174 zero times, and closes with "## Deviations: None yet.", which is why
reviewer finding F1 P1 had to catch the lost product-owner decision at the end of
the run.

What the real gate comment (dowtdh-gate-decisions.json, fetched from Jira) makes
clear is that F1 under-reported the damage: the product owner resolved SIX
numbered Concerns in that one TEAM-4174 comment, so the approved plan dropped six
decisions, not one. Concern 3 (the undo-window focus/hover pause) is simply the
one the reviewer happened to catch.

This file is the minimal shape of the SAME plan written after the fix: the
resolution text in each row 1-6 is the product owner's real decision from that
comment, and each row cites the decision it implements. Rows 7-12 of the real
post-fix plan cite TEAM-4176 and TEAM-4178, which resolved no NUMBERED concerns
(the Design Approval comment restates Concern 3 in prose; Plan Approval carries
only the Telegram receipt), so they yield no ledger entries and nothing here has
to clear them — rows 1-6 are the whole citation surface.

One citation detail this fixture exists to pin: the real plan's rows end
"(PO, TEAM-4174 comment 2026-09-06 15:09)", and a table row that opens `| 3 |`
does NOT satisfy `unreferencedDecisions` rule 2 on its own — that rule wants the
gate key AND a `Concern <n>` / `#<n>` token, and a bare table-cell number is
neither. Writing the decision id (`TEAM-4174#3`) satisfies rule 1 outright, which
is why the blueprints tell every persona to cite the id and not the date.
Row 3 below is deliberately cited BOTH ways; the others cite the id only.
-->

# Plan: Clear the Activity feed with an undo window
- Workflow: wf_1788731227559_dowtdh / Epic: TEAM-4162 / Plan ticket: TEAM-4177 / Author: agentcore_hub_frontend_dev / Status: proposed

## Approach

Unchanged from the approved plan except for the undo-window behaviour, which now
follows the product owner's gate decision.

## Concerns

| # | Concern | Policy | Owner | Proposed resolution | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | (spec) Copy and colour values are unreviewed. | Brand | human:brand-lead | Ship 'Clear activity', 'Undo', 'Activity cleared.', 'Activity restored.' and reuse the existing App.css values as-is; demo-app has no brand kit (PO, TEAM-4174#1). | resolved |
| 2 | (spec) Destructive action with no confirm dialog. | UX | human:design-lead | Undo-only, no confirm dialog — the intent asked for undo as the safety net (PO, TEAM-4174#2). | resolved |
| 3 | (spec) Undo auto-dismisses at 5000 ms, not persistent. | UX | human:design-lead | 5000 ms window; pause the countdown while Undo has focus or hover. Implemented as hover-pause on the notice row; focus-pause omitted — see Deviations D1. (PO, TEAM-4174 comment 2026-09-06 15:09, Concern 3.) | resolved |
| 4 | (spec) A reload inside the undo window loses the pending clear. | Data | human:product-owner | Commit at click time; a reload inside the window is permanent, which is the simplest and most honest behaviour (PO, TEAM-4174#4). | resolved |
| 5 | (spec) Live-region and keyboard semantics unspecified. | A11y | human:design-lead | Native buttons plus a role=status region; do NOT move focus into the live region (PO, TEAM-4174#5). | resolved |
| 6 | (spec) A second Clear inside an open undo window is undefined. | Data | human:product-owner | Merge-and-restart: the second Clear merges into the snapshot and restarts the 5 s window, so one Undo restores everything (PO, TEAM-4174#6). | resolved |

## Deviations

- **D1 — Concern 3 / TEAM-4174#3, partially implemented.** The product owner's
  decision at Spec Approval TEAM-4174 was "5000 ms window; pause the countdown
  while Undo has focus or hover", restated at Design Approval TEAM-4176. Hover-pause
  ships as decided. Focus-pause is omitted: the notice row's only focusable child is
  the Undo button itself, so a focus-pause would hold the window open indefinitely
  for a keyboard user who tabs to Undo and does not press it, which contradicts
  Concern 2's "undo is the safety net, not a modal". Raised for the engineer at Plan
  Approval rather than decided here.
