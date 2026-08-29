# Rework handoff — how to send work back without stalling the run

You are a **gate** agent (code review, QA, CI, or release). When your verdict is
not PASS you send work back to an upstream agent to fix. Done wrong, the run
stalls for hours: a fix ticket with no blocker wiring lets the pipeline march
past un-fixed code, and a re-run that is left implicit never gets dispatched.

The orchestrator is deliberately dumb. It only reacts to **ticket status
transitions**, and it re-dispatches a ticket **only** when a ticket in that
ticket's `blocked_by` list transitions to `done`/`cancelled` AND every other
blocker is also resolved. If you don't wire the blocker, nothing re-runs. This
skill is the exact protocol. Follow it literally.

## The one rule that prevents every stall

> **The ticket that must run AFTER the fix must list the fix ticket in its
> `blocked_by`. If a ticket has to re-run and nothing it depends on will
> transition to `done`, it will never be dispatched.**

Concretely, when you (a gate) fail work and file a fix ticket for the dev:

1. **Create the fix ticket**, assigned to the dev/owner who must fix it, with
   `blocked_by=""` (the dev can start immediately):
   `Tickets___create_ticket(title="Fix (<gate>): <finding>", description="<file:line + scenario + severity + how to verify>", assignee="<dev agent id>", blocked_by="")`
2. **Re-block YOUR OWN gate ticket on that fix ticket** so you re-run and
   re-verify after the fix lands — this is what makes the loop converge:
   `Tickets___transition_ticket(ticket_id="<your gate ticket>", transition_id="blocked", reason="awaiting fix <fix ticket id>")`
   then record the dependency so the cascade re-dispatches you:
   `Tickets___update_ticket` is NOT enough — the blocker link must exist. If your
   provider can't add a link to an existing ticket, instead **do not report_completion**;
   create the fix ticket, then create a fresh re-verify ticket for yourself
   assigned to your own agent id with `blocked_by="<fix ticket id>"`, and let
   your current gate ticket close. Either way: a ticket assigned to you must be
   `blocked_by` the fix, so you run again once the fix is `done`.
3. **Do NOT unblock downstream.** Downstream gates (QA after review, CI after QA,
   release after CI) are already `blocked_by` your ticket. As long as your
   re-verify ticket is what closes the gate, they stay parked until the fix is
   actually verified — never running against un-fixed code.

### Why not just file the ticket and `report_completion` PASS-style?

Because `report_completion` marks YOUR ticket `done`, which unblocks the NEXT
gate immediately — QA/CI then run against code your fix ticket says is broken,
and the fix ticket floats with nothing waiting on it. The fix might merge, but
the gate that found the problem never re-checks it. Always keep a ticket
assigned to you `blocked_by` the fix.

## Per-role specifics

- **code_reviewer / qa_verifier (CHANGES NEEDED / FAIL):** one fix ticket per
  finding, each assigned to the dev, each with `file:line` + repro + severity.
  Re-block yourself on ALL of them (you re-review once every fix is done).
- **ci_agent (BLOCKED — build/test infra failed, not a code finding):** if the
  failure is a real code/build break, file a fix ticket to the dev and re-block
  yourself exactly as above. If it is missing infrastructure you cannot control
  (e.g. no iOS gateway), you cannot pass or fail — report BLOCKED in your
  completion text and, if no one can act, this is an escalation case, not a
  silent Done.
- **release_manager (ship blocked):** if you cannot ship because an upstream
  artifact is missing/wrong (no PR, no DEPLOY.md, CI not actually green), file a
  fix ticket to the responsible upstream agent and re-block your ship ticket on
  it. Never mark ship `done` without the PR prepared. Never touch the human
  Merge Approval gate or CD ticket — those are downstream and human-owned.

## Sanity check before you finish

- [ ] Every finding has a fix ticket assigned to the agent who can fix it.
- [ ] A ticket assigned to ME is `blocked_by` those fix ticket(s) — so I re-run.
- [ ] I did NOT `report_completion(done)` in a way that unblocks the next gate
      before the fix is verified.
- [ ] Fix ticket descriptions are self-contained (file:line, repro, severity,
      how to verify) — the dev resumes from the ticket, not from my head.

If you cannot wire a blocker in your ticket provider and cannot create a
self-blocked re-verify ticket, STOP and say so explicitly in your completion
text (the Workflow Manager reads it) — do not close the gate and let the run
sail past unverified.
