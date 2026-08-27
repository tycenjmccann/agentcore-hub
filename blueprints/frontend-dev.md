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
that doesn't contain the code being fixed.

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

### Step 3: Implement
Pass `repo` on your FIRST `claude_code` call so the workspace is cloned. Every
claude_code call shares ONE workspace and ONE conversation — later calls remember
this one and its files, so do NOT reference absolute paths like `/tmp/...`; say
"the same workspace as the previous call".

1. Use `claude_code` to:
   - Clone the repo (pass `repo`) / checkout `base_branch` (see Branch Model above)
   - Create your feature branch (`feature/{TICKET_ID}-frontend-dev`) from it
   - Implement the changes
   - Run `npx tsc --noEmit` to verify TypeScript compiles
   - Run `npm run build` to verify production build passes
2. If compilation fails, fix the errors before proceeding

### Step 4: Visual Verification (MANDATORY for UI changes)
After implementation, you MUST verify your work visually. claude_code has its
own workspace, so the screenshot and its review both happen INSIDE claude_code —
you don't read the file yourself.

Ask `claude_code` (same session) to:
1. Start the dev server, install chromium, and screenshot the changed view with
   Playwright, saving it INTO the repo (e.g. `docs/implementation-screenshot.png`).
2. Review the screenshot against the design spec and describe what it shows in
   its response — iterate until it matches.
3. **Commit the screenshot to the branch** so the evidence travels via git (this
   is how it reaches you, QA, and the PR — no local file handoff).
The runtime also auto-harvests generated files to S3, but the committed-to-branch
copy is the source of truth. Reference the committed path in your PR.

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
1. Commit all changes with a clear message referencing the ticket
2. Push the branch
3. Create a PR **into base_branch** (see Branch Model) with:
   - Summary of changes
   - Files modified
   - Screenshot of the result (reference the committed screenshot)
4. Merge the PR into base_branch once your evidence is complete
5. Report completion with branch, commit SHA, and PR URL

## Rules
- Before deleting/weakening/proxying ANY existing check: state what it enforces and grep every writer of the replacement value across all tiers (client + backend handlers + schema). A check you can't explain is a check you don't remove.
- Never `try` → `try?` (or swallow errors) in a write path unless you prove the failure case can't clobber good state
- Performance work: measured before/after numbers (operation counts / latency) on the same scenario are mandatory evidence; tests assert the invariant (count/latency bound), never the implementation choice
- Pick the intelligence tier per `claude_code` call with `model=`: `"fable"` (default — top reasoning, plans/complex debugging), `"opus"` (deep implementation work), `"sonnet"` (routine, well-specified coding), `"haiku"` (trivial mechanical edits). Match the tier to the difficulty; when unsure, leave it empty.
- NEVER submit a UI change without first rendering it and verifying visually
- iOS: the gateway run is the render — never open an iOS PR without one; write XCTests with the implementation
- If the dev server won't start after your changes, your implementation is broken — fix it
- Include a screenshot in every PR that has visual changes
- Follow existing code patterns — don't introduce new paradigms
- Keep changes scoped to what the ticket asks for
- PRs target base_branch, never the repo default branch (unless base_branch IS the default)
