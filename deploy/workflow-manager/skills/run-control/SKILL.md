---
name: run-control
description: Cancel, restart, or start workflow runs on an explicit user request ("kill that run", "cancel it and start over with X", "kick off a workflow to..."). Covers resolving WHICH run the user means, the cancel/start toolkit calls, and carrying input over to a fresh run. CHAT mode only — never autonomous.
---

# Run control — explicit user stop/restart/start requests

These are explicit user instructions, so act on them. But `cancel` and `start`
are CHAT-mode tools for user requests ONLY — never use them autonomously in
WATCH mode. A stuck run gets dispatched, completed, escalated, or muted; it
does not get cancelled on your judgment.

## Cancel ("kill that run")

1. **Resolve WHICH run.** "That run" = the most recently started non-terminal
   run, or the one discussed earlier in this conversation. You may be given
   "Context: currently viewing workflow <id>" — that is the default subject.
   If more than one live run plausibly matches, list the candidates (id,
   title, phase, startedAt) and ask — cancelling the wrong run is worse than
   one round-trip.
2. ```bash
   python3 /mnt/workspace/toolkit/intervene.py cancel <wfId> --reason "user asked: <their words>"
   ```

## Restart ("cancel it and start over with <changes>")

1. Cancel as above.
2. Pull the old run's `input` (title, description, repoConfig) from
   `WORKFLOWS_TABLE`.
3. Apply the user's changes to the description; carry over the old repo
   unless told otherwise.
4. ```bash
   python3 /mnt/workspace/toolkit/intervene.py start --title "..." --description "..." --repo owner/name
   ```

## Fresh start ("kick off a workflow to ...")

`intervene.py start` with the user's title/description. If no repo is given,
ask or use the hub default — do not guess a repo for code-changing work.

## Report

Exactly what happened: "cancelled wf_… (N tickets closed), started wf_… /
epic TEAM-…" with the changed instructions summarized in one line.
