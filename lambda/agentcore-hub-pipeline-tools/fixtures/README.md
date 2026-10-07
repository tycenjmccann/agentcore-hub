# Pre-approval fixtures (TEAM-5322)

Read by `../index.test.mjs` ("preapproval matrix (TEAM-5148)"). Source: the TEAM-5317
fixture export (`workflows/wf_1791220686225_znl7a4/shared/fixtures/workflow-output/` in
the artifact bucket), already redacted there. Both files are copied verbatim; nothing
here was re-fetched from a live pipeline.

| File | What it is |
|---|---|
| `TEAM-5148-preapproval-matrix.synthetic.json` | Eight synthetic FR-11 cases over the TEAM-5038 run, each with its pre-FR-11 (`before`) and FR-11 (`after`) `preapproval` result. |
| `TEAM-5038-cd-ledger.json` | The real run's CD ledger row the matrix's `base` is drawn from. |

How the test serves each case (the fixture names outcomes, not mocks):

- `mergeApproval: {status:"done", decision:"approve"}` → a twin-written
  `gate-decisions/<wf>/merge-approval.json` approving `base.approved_head_sha`.
  Any other `mergeApproval` (`decision:null`, `in_review`, `null`) → no record (404):
  the twins write one only when a human decision is admitted.
- `override.merge_commit` → GitHub reports that PR's `merge_commit_sha` as the
  override value, so the binding to the deployed commit is false.
- `override.ci:"failed"` → the approved head's CI build is `FAILED`.
- "GitHub unreachable" → `fetch` throws. "rejection not verifiable" → the
  `.rejected.json` HeadObject answers 500.

The workflow id is not in the export; the test uses `wf_bug_TEAM-5038` (the run's id
shape). Four rows the export does not have, plus an `approve-with-known-findings`
row, are added in the test itself rather than edited into the fixture.
