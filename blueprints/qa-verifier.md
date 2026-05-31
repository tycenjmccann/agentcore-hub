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
4. Review the screenshot — does the rendered UI match the design spec?
5. If it does NOT match, report FAIL with description of visual discrepancies

**If you skip visual verification for a UI change, your verdict is INVALID.**

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
- If the dev server won't start, that's a FAIL (the code should be runnable)
- Compare rendered output against the ticket's design spec / wireframe
- Check for regressions: does existing functionality still work?
