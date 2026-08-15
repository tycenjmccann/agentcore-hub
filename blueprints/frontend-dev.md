# Frontend Dev Blueprint

## Process

### Step 1: Gather Context
1. Read the design doc / requirements from S3 shared artifacts
2. Read the relevant source files from the repo (component, styles, config)
3. Understand the existing patterns (CSS approach, component structure, state management)
4. Check CLAUDE.md in the repo for project conventions

### Step 2: Plan Implementation
1. Identify exactly which files need changes
2. Determine if new files are needed
3. Note constraints from the ticket (e.g., "do NOT touch X")
4. Frame a clear brief for claude_code

### Step 3: Implement
1. Use `claude_code` to:
   - Clone the repo / checkout the correct base branch
   - Create a feature branch (`feature/{TICKET_ID}-frontend-dev`)
   - Implement the changes
   - Run `npx tsc --noEmit` to verify TypeScript compiles
   - Run `npm run build` to verify production build passes
2. If compilation fails, fix the errors before proceeding

### Step 4: Visual Verification (MANDATORY for UI changes)
After implementation, you MUST verify your work visually:

1. Use `claude_code` to start the dev server and take a screenshot:
   ```
   cd /tmp/repo && npm run dev &
   sleep 10
   npx playwright install chromium
   node -e "
   const { chromium } = require('playwright');
   (async () => {
     const browser = await chromium.launch();
     const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
     await page.goto('http://localhost:3000/workflow');
     await page.waitForTimeout(3000);
     await page.screenshot({ path: 'docs/implementation-screenshot.png', fullPage: false });
     await browser.close();
   })();
   "
   ```
2. Review the screenshot — does it match the design spec?
3. If NOT, iterate until it does
4. Commit the screenshot to the branch

### Step 4b: iOS Projects (MANDATORY — replaces Step 4 for iOS)
claude_code cannot build iOS. Verify on the CodeBuild macOS gateway instead:

1. Have claude_code implement the change AND write/update XCTest (unit + UI) coverage
   for the acceptance criteria — tests are part of the implementation, not QA's job
   to author. Push the branch.
2. `list_schemes(branch)` if you don't know the scheme.
3. `ios_test(branch, scheme)` — async, returns `build_id`. For UI changes pass
   `record_session=true` and review the simulator video like you would a screenshot.
4. Poll `ios_build_status(build_id)` every ~60s until terminal.
   - `BUILD_ERROR` → doesn't compile → your implementation is broken; fix and re-run.
   - Test failures in code you touched → fix and re-run.
5. Use `get_test_logs(build_id, test_name)` to diagnose failures (includes screenshots).
6. Reference the gateway build_id + test_summary in the PR the way you'd reference a
   screenshot for web work.

Do NOT open a PR for iOS work without a passing (or explained) gateway run.

### Step 5: Push & PR
1. Commit all changes with a clear message referencing the ticket
2. Push the branch
3. Create a PR with:
   - Summary of changes
   - Files modified
   - Screenshot of the result (reference the committed screenshot)
4. Report completion with branch, commit SHA, and PR URL

## Rules
- NEVER submit a UI change without first rendering it and verifying visually
- iOS: the gateway run is the render — never open an iOS PR without one; write XCTests with the implementation
- If the dev server won't start after your changes, your implementation is broken — fix it
- Include a screenshot in every PR that has visual changes
- Follow existing code patterns — don't introduce new paradigms
- Keep changes scoped to what the ticket asks for
