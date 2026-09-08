<!--
FIXTURE — the counter-case to dowtdh-plan-001fe322.md.

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

WHAT IS VERBATIM HERE, AND WHAT IS NOT.
Verbatim: the CITATION FORM of rows 1-6. The real post-fix plan writes each
resolution followed by "(PO, TEAM-4174 comment 2026-09-06 15:09.)" — the gate
ticket key and the date, never a `TEAM-4174#n` id, because the id is our
invention and no human wrote one. The `| n |` leading cell is likewise the real
table shape (`| # | Concern | Policy | Owner | Proposed resolution | Status |`).
Trimmed: the Concern and Approach prose is the minimal shape of the same plan —
short enough to read in a test failure — and the resolution text in each row is
the product owner's real decision from the TEAM-4174 comment, condensed.
Rows 7-12 of the real post-fix plan cite TEAM-4176 and TEAM-4178, which resolved
no NUMBERED concerns (Design Approval restates Concern 3 in prose; Plan Approval
carries only the Telegram receipt), so they yield no ledger entries and nothing
here has to clear them — rows 1-6 are the whole citation surface.

This is the artifact `unreferencedDecisions` must NOT flag, and it is the reason
that rule is line-scoped and table-aware: a row that names the gate ticket and
opens `| 3 |` is an unambiguous citation of Concern 3 to any human reading it, and
flagging it would reopen a good plan under DECISION_LEDGER=enforce. Row 3 also
happens to spell "Concern 3" out on the same line; rows 1, 2, 4, 5 and 6 are
carried by the table cell alone, which is what pins the table-row form.
-->

# Plan: Clear the Activity feed with an undo window
- Workflow: wf_1788731227559_dowtdh / Epic: TEAM-4162 / Plan ticket: TEAM-4177 / Author: agentcore_hub_frontend_dev / Status: proposed

## Approach

Unchanged from the approved plan except for the undo-window behaviour, which now
follows the product owner's gate decision.

## Concerns

| # | Concern | Policy | Owner | Proposed resolution | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | (spec) Copy and colour values are unreviewed. | Brand | human:brand-lead | Ship 'Clear activity', 'Undo', 'Activity cleared.', 'Activity restored.' and reuse the existing App.css values as-is; demo-app has no brand kit. (PO, TEAM-4174 comment 2026-09-06 15:09.) | resolved |
| 2 | (spec) Destructive action with no confirm dialog. | UX | human:design-lead | Undo-only, no confirm dialog — the intent asked for undo as the safety net. (PO, TEAM-4174 comment 2026-09-06 15:09.) | resolved |
| 3 | (spec) Undo auto-dismisses at 5000 ms, not persistent. | UX | human:design-lead | 5000 ms window; pause the countdown while Undo has focus or hover. Implemented as hover-pause on the notice row; focus-pause omitted — see Deviations D1 on Concern 3. (PO, TEAM-4174 comment 2026-09-06 15:09.) | resolved |
| 4 | (spec) A reload inside the undo window loses the pending clear. | Data | human:product-owner | Commit at click time; a reload inside the window is permanent, which is the simplest and most honest behaviour. (PO, TEAM-4174 comment 2026-09-06 15:09.) | resolved |
| 5 | (spec) Live-region and keyboard semantics unspecified. | A11y | human:design-lead | Native buttons plus a role=status region; do NOT move focus into the live region. (PO, TEAM-4174 comment 2026-09-06 15:09.) | resolved |
| 6 | (spec) A second Clear inside an open undo window is undefined. | Data | human:product-owner | Merge-and-restart: the second Clear merges into the snapshot and restarts the 5 s window, so one Undo restores everything. (PO, TEAM-4174 comment 2026-09-06 15:09.) | resolved |

## Deviations

| id | Concern | Departure and reason |
| --- | --- | --- |
| D1 | 3 | PO decision on Concern 3 (TEAM-4174 comment 2026-09-06 15:09) was "5000 ms window; pause the countdown while Undo has focus or hover", restated at Design Approval TEAM-4176. Hover-pause ships as decided. Focus-pause is omitted: the notice row's only focusable child is the Undo button itself, so a focus-pause would hold the window open indefinitely for a keyboard user who tabs to Undo and does not press it, which contradicts Concern 2's "undo is the safety net, not a modal". Raised for the engineer at Plan Approval rather than decided here. |
