# Template: Brief (family `brief`)

A brief exists so one reader can approve or reject. It is the document behind
every approval in the hub: Merge Approval (`merge-brief.md`), the deploy gate
(`cd-evidence/deploy-<sha>.md`), sales approval (`approval.md`), counsel
sign-off (`signoff.md`), an operator checkpoint, a ship-review escalation.
The gate changes only the question in `## Decision`; the shape never changes.

| Gate | The reader decides | Brief |
|---|---|---|
| Spec Approval | Is this the right thing to build? | `requirements.md` (spec family, its `## Outcome` is the decision line) |
| Plan Approval | Is this the right way to build it? | design docs (spec family) |
| Merge Approval | Does this merge? | `merge-brief.md` |
| Deploy approval | Does this go live? | `cd-evidence/deploy-<sha>.md` + the merge brief |
| Counsel Sign-off | Do these redlines go to the counterparty? | `redlines.md` (external) + `contract-review.md` |
| Operator checkpoint | Do we keep spending on this run? | `operator-status.md` (record) |

The Telegram ping (`review-package-<gate>.json`, see `review-package`) is
derived from the brief: `summary` = the first sentence of `## Decision`,
`bullets` = `## What needs your eye` plus the top evidence lines, `links` =
the brief first. Write the brief, then the package.

## Sections (exact `##` headings, this order)
1. `## Decision`. What you are asking for and your recommendation, with the
   basis, in one to three sentences. Use one of: "Approve", "Reject",
   "Blocked". State what happens on reject. No lists, no table, under 80 words.
2. `## Why it is ready`. Three or four evidence lines, counts not adjectives:
   CI at which head, review rounds and open findings, what was verified live.
   The Verification Ledger table goes here when the checklist ran.
3. `## What needs your eye`. Only what a human must weigh: unverified rows,
   disputed findings, a judgment call, a manual step. "Nothing." is a valid
   body. Never bury an item here inside another section.
4. `## After approval`. What happens next and by whom: merge, deploy path,
   manual handoff steps, where the detail lives (PR body, plan, review).

## Example (real run wf_1789754191167_dbf595, rewritten; original was 14.5 KB)

```
# Merge brief: PR #637 SI tracker (TEAM-4760)

## Decision
Blocked. Approve only if you accept merging code that is CI-certified and
independently reviewed but never exercised against the real backend. The live
checks could not run: the coding runtime role is denied DynamoDB and S3, and
the ledger table does not exist yet. Reject = nothing merges.

## Why it is ready
- CI green at the reviewed head 1b8fbf9: lint, tsc, unit, build, 7 Playwright, 287 pytest. GitHub Actions green.
- Independent review (codex, fresh session): round 1 found 4 issues, 3 fixed, 1 rejected with evidence. Round 2 PASS, 0 open.
- Additive only: new table, route, panel, toolkit scripts. Nothing under lambda/orchestrator. One revert restores main.

| Check | Ran | Result |
|---|---|---|
| Build + tests | yes | pass (CodeBuild eb8b2cd7) |
| Live integration (C2) | no | BLOCKED: AccessDenied on dynamodb:DescribeTable, 403 on S3 |
| UI with real data (C1) | no | BLOCKED: fixture render only |
| Acceptance walk (C5) | partial | 5 of 7 by test; AC1 and AC5 blocked against real data |

## What needs your eye
- Nothing was exercised against a real table, route or Lambda. The shapes the tests assume (input.si through /api/workflow/start, cd-ledger fields, card v6 fields) are unconfirmed.
- To unblock instead of accepting: grant the IAM statement on the epic comment to agentcore-hub-coding-runtime-role, then request changes with "IAM granted, rerun live verify". Same SHA, no code change.
- The reviewer shared the worker's checkout (different model, empty context, read-only).

## After approval
Merge, then five manual steps CD will not do: create the table, set
SI_LEDGER_TABLE on analyzer, prd-submitter, WM harness and ECS, apply IAM, run
the backfill dry-run then apply, confirm the toolkit sync. Detail: PR #637
body, shared/plan.md, shared/review.md.
```
