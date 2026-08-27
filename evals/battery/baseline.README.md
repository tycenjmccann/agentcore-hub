# baseline.json semantics

JSON has no comments, so the baseline contract lives here, adjacent to the file.

- **Bootstrap state.** `bootstrap: true` with `runs_per_case: 0` and empty `cases` means no real
  baseline has been recorded yet; every case runs informational until the first baseline workflow
  run populates this file.
- **New cases (git-diff-added vs the PR base) run informational**: they get no delta verdict
  against the baseline in the PR that introduces them.
- **A pre-existing case missing from the baseline is a gate FAILURE** (fail closed) — it means
  the baseline drifted or was hand-edited.
- **The baseline is regenerated ONLY by the merge-to-main baseline workflow.** PR runs NEVER
  write this file.
