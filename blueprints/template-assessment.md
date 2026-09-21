# Template: Assessment (family `assessment`)

An assessment evaluates something that exists (a diff, a bug, a contract, a
campaign) for a reader who will act on the findings: fix, rework, escalate.
Deliverables: `findings.md`, `review.md`, `security-review.md`,
`bug-analysis.md`, `ship-review-summary.md`, `qa-review.md`,
`deal-brief.md`, `deal-desk-review.md`, `triage.md`, `*-review.md` (legal).

## Sections (exact `##` headings, this order)
1. `## Verdict`. The conclusion in one to three sentences: PASS or CHANGES
   NEEDED, root cause found or not, risk posture. Name what was examined and
   at which head or version. No lists, under 80 words.
2. `## Findings`. Numbered, highest severity first. Each finding is one item:
   severity, what is wrong, where (`file:line` or clause), the evidence or
   repro, the fix. Sibling occurrences of the same pattern go in the same
   item. "None." when there are none.
3. `## Not covered`. What you could not or did not examine and why: a tool
   that would not run, a seam you could only read, scope you excluded.
   "Nothing." when complete.
4. `## Next actions`. Who does what next, one line each: the fix tickets you
   filed, the re-check you expect, what the human must decide.

Domain-specific structure (bug analysis: symptom, repro, hypothesis, blast
radius; review rounds; policy areas) goes as `###` sub-headings inside
`## Findings`, or as `##` appendix sections after `## Next actions`.

## Example (real run wf_1789754191167_dbf595 review.md round 1, rewritten)

```
# Independent review: PR #637 (TEAM-4760), round 1

## Verdict
Changes needed. Three findings block: the backfill script calls ledger
functions that do not exist, the list route runs an unbounded scan, and a
missing table returns a 500. Head abac016, read-only, codex fresh session.

## Findings
1. P1. Backfill cannot run. scripts/si-ledger-backfill.mjs:586 calls makeLedger, listRows, upsertOccurrence(args), stampAttempt(args); si-ledger.mjs exports only SiLedger with list(), upsertOccurrence(key, title, occ), stampAttempt(key, attempt). Repro: grep si-ledger.mjs for makeLedger returns nothing. Same pattern at :591, :609, :613.
2. P1. Unbounded scan. src/lib/si-ledger.ts:244 scans the whole table with no Limit and route.ts:59 returns it all. Siblings: workflow-analyzer/si-ledger.mjs:569, prd-submitter/si-ledger.mjs:569, si_ledger.py:610.
3. P2. Missing table is a 500. route.ts:81 propagates ResourceNotFoundException; route.test.ts:166 codifies it.
4. P1. Verified by construction. Every runtime seam is mocked with a hand-written shape (prd-submitter index.test.mjs:49, analyzer index.test.mjs:64, test_si_metrics.py:55) and no captured real response exists.

## Not covered
tsc and vitest did not run: node_modules is empty in the shared workspace.
7 of 41 node tests failed on module resolution, not on the branch.

## Next actions
Worker: fix 1 to 3 with tests, one commit each; answer 4 with a real capture
or carry it as BLOCKED in the merge brief. Reviewer: re-check the delta only.
```
