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
1. `## Decision`. Open with one of "Approve", "Reject", "Blocked", then your
   recommendation: what you would do next and why, in words a reader who has
   never seen this run understands. Then what happens on approve and on
   reject. One to three sentences, no lists, no table, under 80 words. No
   ticket IDs, commit hashes, finding codes or role, table and route names
   here: say what a thing does and what happens, not what it is called.
2. `## Why it is ready`. Three or four evidence lines, counts not adjectives:
   CI at which head, review rounds and open findings, what was verified live.
   The Verification Ledger table goes here when the checklist ran.
3. `## What needs your eye`. Only what a human must weigh: unverified rows,
   disputed findings, a judgment call, a manual step. Same plain words as
   the decision. "Nothing." is a valid body. Never bury an item here inside
   another section.
4. `## After approval`. What happens next and by whom: merge, deploy path,
   manual handoff steps, where the detail lives (PR body, plan, review).

## Example (real run wf_1789754191167_dbf595, rewritten; original was 14.5 KB)

```
# Merge brief: PR #637 (TEAM-4760)

## Decision
Blocked. Recommendation: grant the test environment database access and
request a rerun, then approve on the rerun, which comes with real-data proof.
About one hour. Approving now means a day of possibly wrong numbers on a new
page; undo is one revert. Reject = nothing merges.

## Why it is ready
- Adds a tracker page for the self-improvement loop (runs, PRs, outcomes).
- All tests pass on the exact version you would merge. Independent review
  complete, no open findings.
- Not done: a run against real data. The test environment has no database
  access.

| Check | Ran | Result |
|---|---|---|
| Build and tests | yes | pass |
| Against the real database | no | test environment has no access |
| Page with real data | no | sample data only |
| Acceptance walk | partial | 5 of 7; 2 need real data |

## What needs your eye
The page may show wrong numbers until it runs against real data. Nothing else.

## After approval
Merge, then 5 manual setup steps the pipeline does not do, listed on the
ticket. Detail: PR #637 body.
```

The reader is the owner, on a phone, between meetings, who has not seen the
run; every sentence above is one they can act on without opening anything else.
What the original said instead, and why it was wrong: "CI-certified at 1b8fbf9",
"the coding runtime role is denied dynamodb:DescribeTable", "input.si through
/api/workflow/start, cd-ledger fields, card v6 fields". Each is a name the
writer knows and the reader does not. The hash, the role and the route belong
in the ledger row, the PR body and the ticket, once each, not in the sentence
the reader has to decide on.
