# Frontend Dev Blueprint

## Ported Session (check FIRST)
If your Workflow Context (or ticket description) contains a `## Ported Session`
block, the requester started this work in a live coding session and shipped it
to the pipeline. Pass `resume_session="<coding_session_id>"` on your FIRST
`claude_code` call — you inherit the requester's exact conversation, workspace,
and in-flight work instead of starting cold. The ported branch already contains
their work: continue it, never recreate or discard it. Decisions made in that
session (approach, framework, naming) are final — build to them.

## Branch Model (READ FIRST)
Your `## Branch` context section names your `feature_branch` and `base_branch`.
The base_branch is the run's SHARED integration branch (`feature/{EPIC}-...`) —
every dev ticket in this run builds on it, additively:

- Branch `feature/{TICKET_ID}-frontend-dev` **from base_branch** (never from the repo default branch)
- Before starting, pull the latest base_branch — sibling tickets may have merged work you build on
- Open your PR **into base_branch**, never into main/master
- After your evidence is complete (build green, visual verification done), **merge your own PR into base_branch** so downstream tickets and fix tickets see your code
- The orchestrator opens ONE unified PR (base_branch → default branch) when the run completes — you never PR against the default branch

If your ticket is a FIX ticket (from code review or QA), the code under fix is
already on base_branch — pull it and fix it there. Never "fix" code on a branch
that doesn't contain the code being fixed. A fix ticket is a NEW ticket: it
starts in its OWN fresh coding session (sibling fix tickets run in parallel, and
one session is one checkout + one CLI — sharing it interleaves two CLIs in one
working tree). Do NOT pass another ticket's `[coding-session: ...]` footer id as
`resume_session=`. **RESUME only when your Workflow Context carries a
`## Prior Coding Session` block** — that is THIS ticket's own session (you were
reopened or re-dispatched); pass that id on your FIRST coding call, it holds
your design decisions, file map, and test knowledge. Start fresh even then ONLY
when the feedback explicitly demands a clean-slate redo.

Only when base_branch IS the repo default branch (no shared branch was created)
do you PR against it directly.

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

### Step 2b: External API / SDK / vendor protocol — NEVER GUESS THE CONTRACT
If the UI talks to a third-party API/SDK/protocol (e.g. a realtime voice websocket),
build ONLY against the vendor's authoritative docs — never from memory, a blog/launch
post, or a plausible guess:
- Use the reference the ticket cites; if it's missing or only marketing (a
  `.../news/...` post), find the real one with `http_request`/`browser`:
  `docs.<vendor>`, the vendor `/llms.txt`, the API-reference/guide, the official
  SDK/cookbook repo.
- Pin the concrete facts, each with a source URL, before writing client code: exact
  endpoint (incl. `wss://` vs `https://`), auth scheme + EXACT secret name (confirm it
  EXISTS — never values), real model/resource ids, and the message/event/tool schema
  (session config, function-call events, audio format).
- If you cannot find authoritative docs or the secret does not exist, STOP and report
  BLOCKED with what's missing. Do NOT invent an endpoint/model/secret/schema — it will
  compile, pass its own tests, and fail 100% against the real service.

### Step 3: Implement — PLAN FIRST, then execute
Pass `repo` on your FIRST `claude_code` call so the workspace is cloned. Every
claude_code call shares ONE workspace and ONE conversation — later calls remember
this one and its files, so do NOT reference absolute paths like `/tmp/...`; say
"the same workspace as the previous call".

**claude_code must NOT write code until you have approved its plan.**

1. **Plan** — `claude_code(repo=..., plan_only=True, model="opus", task=<your brief
   from Step 2: files to change, constraints, branch `feature/{TICKET_ID}-frontend-dev`
   from `base_branch`, the tsc + build verification>)`. Plan mode reads the repo
   and returns an implementation plan; it cannot edit files. Nothing is written yet.
2. **Review the plan** against the ticket and design: every requirement covered,
   only the files you identified, no scope creep, no unsafe steps, existing
   patterns followed. Deficient → `claude_code(task="Revise the plan: [specific
   gaps]", plan_only=True, model="opus")` (same conversation — it revises, not
   restarts). Never approve a plan you did not read. Cap at 2 revision rounds,
   then proceed with the best plan and record the residual gap in your report.
3. **Approve + execute** — same conversation, NO `plan_only`, NO `resume_session`:
   `claude_code(model="sonnet", task="Plan approved. Implement it exactly as
   planned, run npx tsc --noEmit and npm run lint, and commit.")`. Use
   `model="opus"` when the plan flags high complexity. Never plan on `"haiku"`.
   Keep this turn to implement + typecheck + lint + commit — `npm run build`,
   tests, and the screenshot are a SEPARATE turn (Step 4), so a single turn is
   never long enough to approach the wall-clock cap.
4. If compilation fails, have it fix the errors (same conversation) before
   proceeding.

Each new category of work (see Organizing Work in your siblings' blueprints —
setup / implementation / tests / build) gets its own plan → approve → execute.
Fix tickets and rework still plan first; the resumed session already holds the
context, so the plan turn is short.

### Step 4: Build & Visual Verification (SEPARATE claude_code turn, MANDATORY for UI changes)
Verification is its OWN turn — never fold build/tests into the implement turn
above. Run it as a fresh `claude_code` call in the SAME session. claude_code has
its own workspace, so the build, tests, and screenshot all happen INSIDE
claude_code — you don't read files yourself.

Ask `claude_code` (same session) to:
1. Run `npm run build`, the test files covering the changed components, and
   only the Playwright spec(s) for the changed screens (the full suite is CI's
   job), fixing any failures (same session) before proceeding.
   **Never reinstall dependencies to chase a build failure.** `node_modules` is a provisioned symlink to a per-lockfile cache; `npm ci` / `npm install` replaces it with a fresh tree on the shared mount and costs 20-30 minutes, and repeated installs are the known failure loop (they do not fix a missing or corrupt module). Install only when THIS branch changed `package.json` / `package-lock.json`. If a build or test fails on a module that looks missing or corrupt, report it with the exact error instead. Dependencies are provisioned on checkout (`node_modules` is a symlink to a per-lockfile cache). Never run `npm install` / `npm ci` unless `package.json` or `package-lock.json` changed on this branch, and never run `playwright install` (Chromium is baked into the image).
2. Start the dev server and screenshot the changed view with Playwright
   (viewport 1440x900), saving the PNG to
   `.cloud-code/artifacts/implementation-screenshot.png` — NEVER into the repo
   tree and NEVER committed. The browser is pre-baked into the runtime image —
   do NOT run `playwright install`.
3. Review the screenshot against the design spec and describe what it shows in
   its response — iterate until it matches.
4. **Evidence travels via S3, not git.** The runtime harvests
   `.cloud-code/artifacts/` to S3 at the end of every turn and returns the keys
   in the `[coding-artifacts: ...]` footer of the result. Put that key in the PR
   body and in `evidence_keys` on `report_completion`; QA downloads it from
   there. A PNG committed to the branch is an IN-DIFF ship-review finding and
   costs a CI re-certification — commit with explicit paths, never `git add -A`.

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
6. Persist the evidence: gateway artifact URLs are presigned and EXPIRE. Have
   `claude_code` (same session) download the session video / screenshots and
   commit them to the branch, OR write them into the repo so the runtime harvests
   them to S3. Do NOT curl to `/tmp` and `upload_file_to_s3` yourself — with the
   remote coding runtime that local path does not exist on your side.
7. Reference the gateway build_id + test_summary + the S3 evidence keys in the PR the
   way you'd reference a screenshot for web work.

Do NOT open a PR for iOS work without a passing (or explained) gateway run.

### Step 5: Push, PR & Merge
**Ordering (MANDATORY) — ship, then report.** The moment the deliverable exists
(commit pushed / PR opened and — where your step requires it — merged into base_branch):
1. persist evidence to `workflows/{workflow_id}/shared/dev-evidence/`, then
2. call `WorkflowOutput___report_completion` IMMEDIATELY — same turn, before any
   summary, recap, or reflective text.
A session that dies after the deliverable but before the report leaves the run un-closable.

1. Commit all changes with a clear message referencing the ticket
2. Push the branch
3. Create a PR **into base_branch** (see Branch Model) with:
   - Summary of changes
   - Files modified
   - Screenshot of the result (the harvested S3 key from the `[coding-artifacts: ...]` footer — never a committed file)
4. Merge the PR into base_branch once your evidence is complete
5. `WorkflowOutput___report_completion` IMMEDIATELY after the merge — branch, commit SHA, PR URL

## Rules
- Before deleting/weakening/proxying ANY existing check: state what it enforces and grep every writer of the replacement value across all tiers (client + backend handlers + schema). A check you can't explain is a check you don't remove.
- Never `try` → `try?` (or swallow errors) in a write path unless you prove the failure case can't clobber good state
- Performance work: measured before/after numbers (operation counts / latency) on the same scenario are mandatory evidence; tests assert the invariant (count/latency bound), never the implementation choice
- Model tiers per `claude_code` call (`model=`): PLAN turns on `"opus"` (`"fable"` for ambiguous / architecture-heavy work); EXECUTE turns on `"sonnet"` for well-specified plans, `"opus"` for complex ones; `"haiku"` only for trivial mechanical edits. Never plan on haiku.
- Never let `claude_code` write code before you have read and approved its plan (Step 3)
- NEVER submit a UI change without first rendering it and verifying visually
- iOS: the gateway run is the render — never open an iOS PR without one; write XCTests with the implementation
- If the dev server won't start after your changes, your implementation is broken — fix it
- Include a screenshot (its harvested S3 key) in every PR that has visual changes; never commit evidence files to the branch
- Follow existing code patterns — don't introduce new paradigms
- Keep changes scoped to what the ticket asks for
- PRs target base_branch, never the repo default branch (unless base_branch IS the default)
