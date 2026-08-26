# CI Agent Blueprint

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
- Pick the intelligence tier per `claude_code` call with `model=`: `"fable"` (default — top reasoning, plans/complex debugging), `"opus"` (deep implementation work), `"sonnet"` (routine, well-specified coding), `"haiku"` (trivial mechanical edits). Match the tier to the difficulty; when unsure, leave it empty.
- Always compare against base branch to confirm issues are pre-existing vs introduced
- Include actual command output as evidence
- Include claude_code's `[coding-session: ...]` footer in your completion record —
  it lets the exact CI session be reopened and resumed later
- If FAIL, create fix tickets grouped by file/component (one per component, not
  per failure), assigned back to the owning dev agent; chain same-file tickets
  with blocked_by so they run serially
