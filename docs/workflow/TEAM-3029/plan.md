# Plan — TEAM-3029
<!-- Append-only. Each agent APPENDS one `## Plan — <agent id> (<devTicketKey>)`
     section below; NEVER edit or overwrite another agent's section.
     Hard cap: each appended section ≤ 60 lines of markdown. -->

## Plan — agentcore_hub_backend_dev (TEAM-3061)
### Files to touch
- `blueprints/requirements-analyst.md` — Step 4 gains numbered intent/spec S3-write + dev-ticket-embedding instructions (templates verbatim)
- `blueprints/bug-fix-requirements.md` — new Step 2b (intent/spec S3 writes, bug variant) + fix sub-task description bullet
- `blueprints/backend-dev.md` — new Step 1c "Commit the plan first" + claude_code task-template edit
- `blueprints/api-dev.md` — new Step 1c + claude_code task-template edit
- `blueprints/frontend-dev.md` — new Step 2c + two bullets in Step 3 brief list
- `blueprints/bug-fixer.md` — new Step 2c + leading bullet in Step 3 fix list
- `blueprints/code-reviewer.md` — new Step 2b "Plan-vs-diff check" + Rules exemption bullet
- `blueprints/code-sweeper.md` — docs/workflow/** never-remove rule in false-positive list + Rules
- `deploy/runtime-agent/prompts/agentcore_hub_requirements_analyst.txt` — "## COMMITTED AUDIT ARTIFACTS" section
- `deploy/runtime-agent/prompts/agentcore_hub_requirements.txt` — audit-artifacts paragraph (prose style)
- `deploy/runtime-agent/prompts/agentcore_hub_backend_dev.txt` — "## COMMITTED AUDIT ARTIFACTS" section
- `deploy/runtime-agent/prompts/agentcore_hub_api_dev.txt` — same section
- `deploy/runtime-agent/prompts/agentcore_hub_frontend_dev.txt` — same section
- `deploy/runtime-agent/prompts/agentcore_hub_bug_fixer.txt` — same section (Bug-key variant)
- `deploy/runtime-agent/prompts/agentcore_hub_development.txt` — audit-artifacts paragraph (prose style)
- `deploy/runtime-agent/prompts/agentcore_hub_code_reviewer.txt` — two failure-mode bullets + "## COMMITTED AUDIT ARTIFACTS" section
- `.github/pull_request_template.md` — NET NEW (Summary / Testing / Audit Trail, 13 lines)

### Approach
Apply the per-file insertion specs from the approved design (TEAM-3060) verbatim at the quoted anchors — no rewording, no renumbering (suffix steps 1c/2b/2c only). Rejected alternative: centralizing the artifact instructions in one shared doc — each prompt/blueprint is that agent's entire context, so the obligation must live inline in all 17 files.

### Test plan
- `npx knip` passes and `knip.json` is byte-identical to base (proves the change is invisible to dead-code analysis)
- Existing lint/tests pass unchanged (proves zero app-code impact)
- `git diff --stat` vs base_branch lists ONLY the 17 allowlisted files plus `docs/workflow/TEAM-3029/**` (AC5.5)

### Risks / rollback
Text-only change; rollback = revert one PR. Main risk is anchor drift if a blueprint changed since design verification — verify each anchor string exists before inserting.
