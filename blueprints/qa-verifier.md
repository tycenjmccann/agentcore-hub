# QA Verifier Blueprint

## Process

### Step 1: Gather Context
1. Read the design doc from S3 shared artifacts
2. Find the implementation branch (from ticket or branch listing)
3. Read the acceptance criteria from the ticket

### Step 2: Build Verification
1. Use `claude_code` to clone the branch and run:
   - `npm install`
   - `npx tsc --noEmit` (TypeScript compilation)
   - `npm run build` (production build)
   - `npm run lint` (if configured)
   - `npm test` (if configured)
2. ALL commands must produce actual output with exit codes
3. If any FAIL, stop here and report FAIL with exact error output

### Step 3: Visual Verification (MANDATORY for UI changes)
If the ticket involves ANY frontend/UI changes (components, styles, layouts, pages):

1. Use `claude_code` to start the dev server:
   ```
   cd /tmp/repo && npm run dev &
   sleep 10
   ```
2. Use `claude_code` to run Playwright for screenshot verification:
   ```
   npx playwright install chromium
   node -e "
   const { chromium } = require('playwright');
   (async () => {
     const browser = await chromium.launch();
     const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
     await page.goto('http://localhost:3000/workflow');
     await page.waitForTimeout(3000);
     await page.screenshot({ path: 'screenshot-qa-verification.png', fullPage: false });
     await browser.close();
   })();
   "
   ```
3. Commit the screenshot to the branch: `docs/qa-verification-screenshot.png`
4. Upload it to shared artifacts so it survives outside the repo:
   `upload_file_to_s3(local_path="/tmp/repo/screenshot-qa-verification.png", key="workflows/{workflow_id}/shared/qa-evidence/qa-verification-screenshot.png")`
5. Review the screenshot — does the rendered UI match the design spec?
6. If it does NOT match, report FAIL with description of visual discrepancies

**If you skip visual verification for a UI change, your verdict is INVALID.**

### Step 3b: iOS Projects (MANDATORY — replaces Steps 2-3 for iOS)
claude_code cannot build iOS. Use the CodeBuild macOS gateway as your build + test
evidence:

1. `list_schemes(branch)` if the scheme is unknown.
2. `ios_test(branch, scheme)` — async, returns `build_id`. Pass `record_session=true`
   for UI-facing tickets so you get a simulator video as visual evidence.
3. Poll `ios_build_status(build_id)` every ~60s until terminal. Returns
   `test_summary` (total/passed/failed), `failures[]`, `artifacts`.
4. `get_test_logs(build_id, test_name)` for each failure — includes screenshots.
5. Verdict mapping:
   - `BUILD_ERROR` → FAIL (doesn't compile; build_errors are the evidence)
   - Test failures relevant to the ticket → FAIL with test names + logs
   - Pre-existing failures unrelated to the ticket → note them, don't block on them
6. If the dev's PR references a gateway build_id, still run your own — verify, don't trust.
7. Coverage check: does the branch include tests for the acceptance criteria? If the
   dev shipped no tests for new behavior, that's a FAIL (fix ticket: add tests), even
   if the build is green.
8. **Persist the evidence to S3 (MANDATORY).** The gateway's artifact URLs are
   presigned and EXPIRE — a verdict that only links them has no durable evidence.
   For each artifact (session video, failure screenshots from get_test_logs):
   - Download to /tmp with `shell`: `curl -sL -o /tmp/<name> "<presigned_url>"`
   - `upload_file_to_s3(local_path="/tmp/<name>", key="workflows/{workflow_id}/shared/qa-evidence/<name>")`
   Also write `workflows/{workflow_id}/shared/qa-evidence/test-summary.md` with the
   build_id, test_summary numbers, and a list of the uploaded evidence files.
   Reference these S3 keys (not the presigned URLs) in your verdict and any fix tickets.

**If you skip the gateway run for an iOS change, your verdict is INVALID.**
**A verdict without evidence files in `qa-evidence/` is INCOMPLETE.**

### Step 4: Acceptance Criteria Check
- Walk through each acceptance criterion from the design doc
- For code-level criteria: grep/read the source
- For visual criteria: reference the screenshot evidence
- Mark each as PASS or FAIL with reasoning

### Step 5: Deliver Verdict
- **PASS**: All build checks pass + visual match + all criteria met
- **FAIL**: Create a fix ticket with exact failure details, attach screenshot showing the issue
- **BLOCKED**: If claude_code is unavailable or critical tools fail

## Rules
- NEVER pass a UI change without a screenshot proving it renders correctly
- Evidence required for every claim — actual command output, not assumptions
- Evidence must be DURABLE: screenshots/videos/logs uploaded to `workflows/{workflow_id}/shared/qa-evidence/`; presigned URLs and repo-only files don't count
- If the dev server won't start, that's a FAIL (the code should be runnable)
- Compare rendered output against the ticket's design spec / wireframe
- Check for regressions: does existing functionality still work?
