# TEAM-4353 — CI parity: the authoritative check ran 0 of 27 resize tests

## The drift

TEAM-4332 added a blocking Playwright gate to `.github/workflows/ci.yml` (the
`cloud-code-ui` job, step "Workflow sidebar resize + scrollbar suite",
`ci.yml:205` pre-fix) but never wired it into
`deploy/pipeline/buildspec-ci.yml` — the CodeBuild required check that branch
protection actually blocks merge on, and whose own `pre_build` comment says it
"must run EVERY blocking gate the GitHub CI workflow runs" and is "Kept in
lockstep with .github/workflows/ci.yml".

Pre-fix, `buildspec-ci.yml:99` ran only `npm run test:cloud-code`, and
`package.json:18` defined that script as exactly
`playwright test tests/cloud-code-ui.spec.ts` — one explicit file, no glob, no
project selector. So the authoritative check ran **0 of the 27** tests in
`tests/tab-workflow-resize.spec.ts` (count confirmed by
`docs/evidence/TEAM-4352/raw/after-full-file.txt`, tail: `27 passed`).
Downstream agents treat a green CodeBuild check as authoritative and skip
their own tests, so a regression in the exact behaviour this epic is about
could merge green.

`npm test` globs `tests/tab-*.spec.ts` and would have matched, but the
buildspec deliberately excludes it — it makes real AWS-backed calls and
cannot pass in a credential-less CI container (`buildspec-ci.yml:84-89`). Not
a viable fix.

## The fix

A second pasted `npx playwright test tests/...` line in the buildspec was
rejected: that leaves two places to remember on the next hermetic UI spec,
which is the same drift class recurring. Instead, `test:cloud-code` in
`package.json` becomes the single source of truth for hermetic UI specs:

```
"test:cloud-code": "playwright test tests/cloud-code-ui.spec.ts tests/tab-workflow-resize.spec.ts --workers=1"
```

Both CI surfaces already ran (and continue to run) this npm script verbatim,
so both now cover both specs with zero duplicated command lines. The
GH-only "Workflow sidebar resize + scrollbar suite" step is deleted; its
`--trace retain-on-failure` behaviour is preserved because the surviving
`Cloud Code UI regression suite` step already passed that same flag.

Before → after, what the authoritative CodeBuild check executes:

| | before | after |
|---|---|---|
| `cloud-code-ui.spec.ts` tests run | 7 | 7 |
| `tab-workflow-resize.spec.ts` tests run | **0** | **27** |

## Why `--workers=1`

`playwright.config.ts` sets no `workers`, `retries`, or `fullyParallel` (all
three are absent from the file — confirmed by grep). `fullyParallel` defaults
to `false`, so parallelism happens **across spec files**, not within one.

Before this fix, every CI command passed exactly one spec file → one file
group → **one worker**, on both surfaces, regardless of core count. That is
why every prior committed capture (e.g. `docs/evidence/TEAM-4352/raw/after-
full-file.txt`) reads `using 1 worker`.

Folding two files into one `playwright test` invocation creates two file
groups with different worker-option hashes (the resize spec's file-level
`test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } })`),
so Playwright cannot run them in the same worker process. On CodeBuild's CI
project (`ComputeType.SMALL`, 2 vCPU) the default worker count is still 1, so
nothing changes there. But GitHub Actions' `ubuntu-latest` is 4 vCPU, so the
default worker count is 2 — meaning, without a pin, the two groups could run
**concurrently** against the single `next start` on :3737, a contention
condition that has never existed on either surface before this change.

`--workers=1` removes that new variable outright: it pins both surfaces to
the exact single-worker execution shape every previously-committed green
capture was taken under. It costs no additional wall-clock time versus
today, since the two GH steps this replaces already ran sequentially (one
worker each, back to back).

`playwright.config.ts` was deliberately **not** changed — it stays
byte-identical to `main`. Setting `workers` there would also pin `npm test`
(the live AWS-backed tab/api smoke suite) and every other Playwright
invocation in the repo, not just this one hermetic UI gate. Scoping the pin
to the `--workers=1` CLI flag on the `test:cloud-code` script keeps the
change local to the surface this ticket is actually about.

## Evidence to follow (separate turn)

- `raw/gate-run.txt` — verbatim output of
  `PLAYWRIGHT_BASE_URL=http://localhost:3000 npm run test:cloud-code -- --trace retain-on-failure`
  against a production build, expected tail `34 passed` (7 + 27).
- `raw/yaml-parse.txt` — verbatim output of the YAML/command-scalar sanity
  parse of both changed YAML files.
