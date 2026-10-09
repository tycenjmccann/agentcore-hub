# Template: Record (family `record`)

A record tracks state over time for someone who was not watching: a human
deciding whether to continue a run, an auditor of a deploy, the next agent
resuming work. Deliverables: `operator-status.md`, `cd-evidence/deploy-<sha>.md`,
`assets-manifest.md`. (JSON records such as `cd-ledger.json` and
`ship-review-state.json` are machine-read and not linted.)

## Sections (exact `##` headings, this order)
1. `## Status`. Where things stand right now in one to three sentences, and
   the one thing that decides what happens next. No lists, under 80 words.
2. `## Timeline`. A table, oldest first: `| When (UTC) | What happened | Evidence |`.
   One row per event that changed state. Link the evidence key, not a
   description of it.
3. `## Open items`. What is not done, who owns it, what unblocks it. "None."
   when complete.

## Example (operator checkpoint for wf_1789754191167_dbf595, condensed from the run's checkpoint facts)

```
# Operator checkpoint: TEAM-4760 SI tracker

## Status
Build is complete and reviewed; the merge brief is BLOCKED on live
verification because the coding runtime role lacks DynamoDB and S3 access.
Continuing costs nothing until IAM is granted; the next step is a human choice
between granting IAM (then a rerun of live verify) or approving as-is.

## Timeline
| When (UTC) | What happened | Evidence |
|---|---|---|
| 2026-09-18 18:04 | Plan approved, 9 units | shared/plan.md |
| 2026-09-18 20:31 | Worker turns 1 to 4 done, draft PR #637 opened | PR #637 |
| 2026-09-18 20:58 | Live verify attempted: AccessDenied on every table, 403 on S3 | .operator/evidence/live-00-credentials.txt |
| 2026-09-18 21:40 | Review round 1: 4 findings, 3 fixed at 1b8fbf9 | shared/review.md |
| 2026-09-18 22:05 | Review round 2 PASS; CI SUCCEEDED at 1b8fbf9 | CodeBuild eb8b2cd7 |
| 2026-09-18 22:12 | Merge brief written, gate ticket pinged | shared/merge-brief.md |

## Open items
- IAM grant for agentcore-hub-coding-runtime-role (human). Unblocks the live rows.
- Table agentcore-hub-si-ledger does not exist (human, post-merge handoff step 1).
```
