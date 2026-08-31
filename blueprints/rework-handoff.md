# Rework handoff — how to send work back without stalling the run

You are a **gate** agent (code review, QA, CI, or release). When your verdict is
not PASS you send work back to an upstream agent to fix. Done wrong, the run
stalls for hours: a fix ticket with no blocker wiring lets the pipeline march
past un-fixed code, and a re-run that is left implicit never gets dispatched.

The orchestrator is deliberately dumb. It only reacts to **ticket status
transitions**, and it re-dispatches a ticket **only** when a ticket in that
ticket's `blocked_by` list transitions to `done`/`cancelled` AND every other
blocker is also resolved. If you don't wire the blocker, nothing re-runs. This
blueprint is the exact protocol. Follow it literally.

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
   `Tickets___update_ticket` is NOT enough — it only edits title/description; it
   cannot add a blocker link. If your provider can't add a link to an existing
   ticket, use the replacement protocol — but the ordering is critical, because
   downstream gates are `blocked_by` your ORIGINAL ticket, and the moment it
   closes the cascade unblocks them:
   - Create the fix ticket, then a fresh re-verify ticket assigned to your own
     agent id with `blocked_by="<fix ticket id>"`.
   - **Leave your original gate ticket OPEN** — do NOT `report_completion`, do
     NOT transition it to done. Transition it to `blocked` if available.
   - When your re-verify ticket later runs and PASSES, close BOTH: report
     completion on the re-verify ticket AND transition the original gate ticket
     to done. THAT is the moment downstream unblocks — never earlier.
   Closing the original while the re-verify is pending releases QA/CI/release
   against un-fixed code (the re-verify ticket is not in their `blocked_by`).
   Either way: a ticket assigned to you must be `blocked_by` the fix, so you
   run again once the fix is `done`.
3. **Do NOT unblock downstream.** Downstream gates (QA after review, CI after QA,
   release after CI) are already `blocked_by` your ticket. As long as your
   re-verify ticket is what closes the gate, they stay parked until the fix is
   actually verified — never running against un-fixed code.

## CODE fixes must re-enter code review — no unreviewed code may reach a later gate

Fix-ticket code is NEW code, and it is usually the riskiest code in the run
(concurrency reworks, error-path changes written under review pressure). If it
only re-enters the pipeline at YOUR gate, every gate between the dev and you is
skipped — the exact failure mode that turns one review round into six: each
later round does first-pass review of the previous round's unreviewed fixes.

So when your fix ticket changes **code** (source, tests, deploy scripts, IaC —
anything executable; NOT docs/redaction/comment-only edits):

1. Create the fix ticket for the dev as above (`blocked_by=""`).
2. **Also create a `Fix review: <batch>` ticket assigned to the code_reviewer
   agent with `blocked_by="<fix ticket id(s)>"`** — one review ticket per fix
   batch, not per finding. Skip this step ONLY if you ARE the code_reviewer
   (your own re-verify ticket from step 2 above IS the re-review).
3. Chain your own re-verify ticket `blocked_by` the **Fix review** ticket (not
   the raw fix), so you re-run only after the fix has passed review.

Docs-only / redaction / comment-only fixes skip the review link: re-block your
re-verify directly on the fix ticket.

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
- **release_manager (ship blocked):** two cases.
  - *Missing/wrong upstream artifact* (no PR, no DEPLOY.md, CI not actually
    green): file a fix ticket to the responsible upstream agent and re-block
    your ship ticket on it.
  - *Code findings from your final-diff review:* these fixes are unreviewed
    code — apply the "CODE fixes must re-enter code review" chain above IN
    FULL: fix ticket (dev) ← `Fix review` ticket (code_reviewer) ← CI
    re-validation ticket (ci_agent) ← your ship re-review. Your ship round
    must be the LAST look at the fix, never the first. Docs/redaction-only
    findings skip the review+CI links.

  Either way: never mark ship `done` without the PR prepared. Never touch the
  human Merge Approval gate or CD ticket — those are downstream and human-owned.

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
