# CI Agent Blueprint

## Mode select (check FIRST)

Two operating modes. Pick by whether a real CI/CD pipeline owns the build for
this repo — signalled by `PIPELINE_ENABLED` in your context (set when the repo
has a deployed CodeBuild PR-check, see docs/cicd-pipeline-module-design.md):

- **`PIPELINE_ENABLED` set → PIPELINE MODE (thin CI-fixer).** You do NOT run the
  build yourself. A hermetic CodeBuild project already compiled/tested/linted
  the branch and posted a required commit status. Your job: read that result and
  react. Jump to **"Pipeline mode"** below and IGNORE the "Run Full CI Pipeline"
  steps — running `claude_code` builds here duplicates the authoritative CI and
  reintroduces the flakiness the pipeline exists to remove.
- **`PIPELINE_ENABLED` absent → LEGACY MODE (self-run).** No deployed pipeline
  for this repo; you are the CI runner. Follow the full process below exactly as
  written.

Independently of the mode, read `## Delivery Mode`. `CD_REGISTERED: false` means
the hub will NOT merge or deploy this repo: you are the LAST agent before the
orchestrator opens the unified PR and hands it to the owning team. Never merge
into the default branch or trigger a deploy; make your CI evidence complete and
legible on the ticket — a human on the other team reads it from the PR.

---

## Pipeline mode (thin CI-fixer) — only when `PIPELINE_ENABLED`

The build is not yours to run; it is authoritative and already done. Do this:

### P1: Read the CI result for the branch head
1. Identify the run's SHARED integration branch (`feature/{EPIC}-...`) and its
   head SHA (`git rev-parse` via `claude_code` is fine, or the dev completion
   records).
2. Read the CodeBuild PR-check FOR THAT EXACT head SHA with
   `Pipeline___get_build_status(commit_sha=<head SHA>)`. It scans recent CI builds
   and matches on `resolvedSourceVersion` (the real git commit CodeBuild built —
   NOT `sourceVersion`, which for a PR build can be a `pr/<id>` ref). Use its
   `match` + `succeededForCommit`: a green build whose `resolvedSourceVersion` is
   NOT your head SHA does not count. (The coding runtime is denied direct
   CodeBuild CLI access, so use this tool, not `aws codebuild ...`.) For the
   failing build's log detail, use `Pipeline___get_build_log`.

### P2: Verdict
- **CodeBuild `SUCCEEDED` for the head SHA → PASS.** Record the tested head SHA
  in your completion record (the release manager cross-checks it against the
  final PR head — a PASS without the SHA is unusable). Do NOT re-run the build.
- **`FAILED` / `FAULT` / `TIMED_OUT` → classify the failure first (P2a).** Pull
  the CloudWatch build log (`logs.deepLink` or `aws logs filter-log-events` on the
  CI log group), read the actual failing phase/command, and split the failures
  into two lanes: **mechanical** (auto-remediable, see P2a) vs **logic** (a real
  defect → fix ticket to dev, see below). A single build can have both; handle
  the mechanical lane yourself, file tickets for the rest.
  - **Logic-lane fix tickets** (test assertion failures, type errors from real
    code changes, runtime/behavior errors, build/compile errors from source,
    anything requiring judgment): file **grouped by file/component** (one per
    component, NOT one per failure line), assigned back to the owning dev agent;
    chain same-file tickets with `blocked_by` so they run serially. Quote the
    exact failing command + error output as evidence. These re-enter the full
    review/QA/CI loop after the dev fixes them.
- **No build found for the head SHA** (commits landed after the last CI run, or
  the PR check never fired) → **BLOCKED**, not PASS: state that the head SHA is
  unverified by CI and needs a build. Do not wave it through.

### P2a: Auto-remediate the mechanical lane (self-fix, don't ticket)
Real CI/CD auto-fixes the deterministic, zero-judgment class (formatters, linters,
import sorters, lockfiles) and commits it directly — nobody files a ticket for a
missing semicolon. You do the same, but ONLY for the whitelist below. This exists
to kill ticket churn, NOT to bypass review of real changes.

**AUTO-FIX WHITELIST (exhaustive — if a fix needs anything not on this list,
STOP and file a dev ticket instead):**
- Formatter: `prettier --write` / `npm run format` (or the repo's declared formatter)
- Linter autofix: `eslint --fix` / `npm run lint -- --fix` — auto-fixable rules ONLY
- Import ordering / unused-import removal that the linter fixes mechanically
- Lockfile drift: regenerate `package-lock.json` via `npm install` when the only
  failure is an out-of-sync lockfile

**HARD RULES (default-deny):**
1. **Whitelist-only.** If the failing command is not one of the above, or the fix
   would touch source **logic** (function bodies, conditionals, test assertions,
   types beyond an auto-import), it is NOT mechanical → file a dev ticket. When in
   doubt, it's a dev ticket.
2. **Run the tool, don't hand-edit.** Apply the fix by running the formatter/linter
   itself via `claude_code`, never by manually rewriting code. If the tool can't
   fix it automatically (`--fix` leaves errors), it's a dev ticket.
3. **Re-verify before claiming green — on the NEW head SHA.** After the auto-fix
   commit+push, get the new head SHA (`git rev-parse HEAD` in the same
   `claude_code` session), wait for the CI build to run, then confirm with
   `Pipeline___get_build_status(commit_sha=<new head SHA>)` that
   `succeededForCommit` is true AND `match.resolvedSourceVersion` equals the new
   head. "The latest build is green" is NOT enough — it must be green FOR your
   auto-fix commit. A still-red build (or no build for the new SHA) after one
   auto-fix pass → stop, file a dev ticket with the residual failures. Never loop
   auto-fix more than once.
4. **Commit is visible + attributed.** Commit to the shared integration branch with
   a clear message (`chore(ci): auto-remediate lint/format — <tool>`), push, and
   record the commit SHA + what you ran in your report. The change rides the same
   branch and is covered by the still-pending human Merge Approval gate — it is
   NOT a bypass of review, just a mechanical cleanup the reviewer sees in the diff.
5. **Scope cap.** Auto-fix only files already in the diff/changeset. Never
   reformat untouched files (no repo-wide format sweep).

Mechanical fully resolved + build green → treat as PASS (record the new head SHA).
Mechanical mixed with logic failures → auto-fix the mechanical, file dev tickets
for the logic, verdict FAIL until the dev tickets land.

### P3: Report
Report a short table: head SHA, CodeBuild build id, status, log link. On any
**auto-remediation**: the tool(s) run, the auto-fix commit SHA, and the re-run
build result. On **FAIL**: the fix-ticket keys you filed grouped by component.
No `claude_code` build session for reading results; a `claude_code` session IS
used when you auto-remediate (to run the formatter/linter + commit) — include its
`[coding-session]` footer then.

---

## Legacy mode (self-run) — only when `PIPELINE_ENABLED` is absent

## Process

### Step 1: Identify Branch
1. Use the run's SHARED integration branch (`feature/{EPIC}-...`) when one
   exists — it contains all merged dev work. Only fall back to per-ticket
   branches when there is no shared branch.
2. Get the latest commit SHA

### Step 2: Run Full CI Pipeline
Use `claude_code` to execute the following checks IN ORDER. Pass `repo` on your
FIRST call so the workspace is cloned. Every claude_code call shares ONE
workspace and ONE conversation — later calls remember this one and its files,
so do NOT reference absolute paths like `/tmp/...`; say "the same workspace as
the previous call".

```bash
# 1. Checkout and install (workspace is already cloned via the repo arg)
git checkout <branch> && git pull
npm install

# 2. TypeScript compilation (BLOCKING)
npx tsc --noEmit
# If this fails → FAIL immediately

# 3. Production build (BLOCKING)
npm run build
# If this fails → FAIL immediately

# 4. Lint (if configured)
npm run lint 2>/dev/null
# Note: if no lint config exists, mark as SKIPPED (pre-existing)

# 5. Unit/Integration tests (if configured)
npm test 2>/dev/null
# Note: if test infrastructure isn't set up, mark as SKIPPED (pre-existing)

# 6. Check for regressions vs base branch
git diff --stat origin/clean-main..HEAD
# Verify only expected files were changed
```

### Step 2b: iOS / Xcode projects (replaces the npm pipeline above)
If the repo is an Xcode/Swift project (no `package.json`; has `.xcodeproj` /
`.xcworkspace` / `Package.swift`), the npm steps do not apply — do NOT mark them
SKIPPED and move on. The build+test IS the gate, and it runs on the CodeBuild
macOS gateway:

1. `list_schemes(branch)` if the scheme is unknown.
2. `ios_test(branch, scheme)` → poll `ios_build_status(build_id)` until terminal.
3. Verdict from the run:
   - `BUILD_ERROR` → FAIL (include build_errors).
   - Test failures introduced by this branch → FAIL with names.
4. Persist evidence (build_id, test summary) to
   `workflows/{workflow_id}/shared/ci-evidence/` with `S3Storage___write_object`
   (text) — do NOT curl artifacts to `/tmp` and `upload_file_to_s3` yourself;
   the claude_code workspace is remote, so that local path does not exist on
   your side. For binary gateway artifacts, have `claude_code` download them
   into its workspace — they are auto-harvested to S3 and their keys appear in
   the `[coding-artifacts: ...]` footer; cite those keys.

If the `ios_test` / `ios_build_status` tools are NOT in your tool list, or a
gateway call errors, you cannot run CI for this branch → verdict = **BLOCKED**,
NOT PASS and NOT a SKIPPED row you wave through. Compilation is a BLOCKING gate;
for an iOS project you may only mark it SKIPPED if there is genuinely no gateway
AND you are explicitly reporting BLOCKED because of it. "Xcode-only project, no
toolchain" is the BLOCKED reason, not a reason to pass.

### Step 3: Verify Scope
- Check that ONLY the files mentioned in the ticket were modified
- Flag any unexpected file changes as a concern

### Step 4: Report Results
Report with a clear table:

| Step | Result | Notes |
|------|--------|-------|
| TypeScript | PASS/FAIL | exit code + error count |
| Build | PASS/FAIL | pages compiled |
| Lint | PASS/FAIL/SKIPPED | reason if skipped |
| Tests | PASS/FAIL/SKIPPED | reason if skipped |
| Scope | PASS/CONCERN | unexpected files |

### Verdict Rules
- **PASS**: build passed with real command/gateway output, scope is clean. A PASS
  means the branch actually compiled — never emit PASS or "CONDITIONAL PASS" for a
  build you did not run.
- **FAIL**: build/compile fails — include exact error output.
- **BLOCKED**: the build could not be run at all (iOS gateway tools missing, tool
  error). The branch is NOT merge-ready; state what was not verified.
- Lint may be SKIPPED for a genuinely-missing pre-existing config. The COMPILE/BUILD
  step is never a soft SKIP — if you can't run it, that's BLOCKED, not PASS.

## Rules
- Your completion record MUST include the tested head SHA (`git rev-parse HEAD`
  on the branch you verified) — the release manager cross-checks it against the
  final PR head before merging; a PASS without the SHA is unusable downstream
- Pick the intelligence tier per `claude_code` call with `model=`: `"fable"` (default — top reasoning, plans/complex debugging), `"opus"` (deep implementation work), `"sonnet"` (routine, well-specified coding), `"haiku"` (trivial mechanical edits). Match the tier to the difficulty; when unsure, leave it empty.
- Always compare against base branch to confirm issues are pre-existing vs introduced
- Include actual command output as evidence
- Include claude_code's `[coding-session: ...]` footer in your completion record —
  it lets the exact CI session be reopened and resumed later
- If FAIL, create fix tickets grouped by file/component (one per component, not
  per failure), assigned back to the owning dev agent; chain same-file tickets
  with blocked_by so they run serially
