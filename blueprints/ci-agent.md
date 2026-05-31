# CI Agent Blueprint

## Process

### Step 1: Identify Branch
1. Find the implementation branch from the ticket (search tickets for the parent work item)
2. Get the latest commit SHA

### Step 2: Run Full CI Pipeline
Use `claude_code` to execute the following checks IN ORDER:

```bash
# 1. Clone and install
git clone <repo> /tmp/ci-workspace
cd /tmp/ci-workspace
git checkout <branch>
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
- **PASS**: tsc + build pass, scope is clean
- **FAIL**: tsc OR build fails — include exact error output
- If lint/tests are SKIPPED due to pre-existing repo gaps, note it but don't block

## Rules
- Always compare against base branch to confirm issues are pre-existing vs introduced
- Include actual command output as evidence
- If FAIL, create a fix ticket assigned back to the dev agent
