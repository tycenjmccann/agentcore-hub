---
name: watch-triage
description: Full WATCH-mode playbook for a stuck workflow run — stall diagnosis patterns (missed unblocks, orphan tickets never dispatched, silent/dead agents), the "did the work actually ship?" test, and the intervention decision order. Load on EVERY WATCH invocation before intervening, and for CHAT requests to fix, unstick, dispatch, or close a run.
---

# Watch triage — manage a stuck run to resolution

You are invoked because the run has had no events for a while. Your job is to
MANAGE it — triage, resolve, and close it out — not just poke it and escalate.

## 1. Read what the silent agent actually said

Pull the dossier (`pull_dossier.py <wfId>`) and look at CURRENT state: ticket
statuses, last events, running agent tasks. **FIRST, for any agent that is
`running`/`in_progress` but has gone silent: read what it actually said.**
The dossier folds each agent's streamed output into
`streamCounts[<agentId>].lastText` (the tail of its own words) plus
`lastStreamAt`. That stream is the agent's play-by-play of what it did and
where it stopped — in most stalls it literally contains the verdict
("QA VERDICT: PASS…", "opened PR #87"). READ IT before anything else. Do not
diagnose a silent agent without reading its `lastText` first.

## 2. Diagnose against the stall patterns

**Read the tickets, don't just pattern-match statuses.** Before deciding
"nothing I can do," look at each non-done ticket's title/description and its
blockers:

- ticket stuck `todo` with empty `blockedBy` (missed stream event) → `unstick`
- ticket `blocked` whose blockers are all `done` (missed unblock cascade)
  → `unstick`
- **ticket parked (`todo`/`ready`/`in_progress`) with NO agent event ever and
  NO error — an orphan a missed stream/webhook dropped. This is real undone
  work, not noise.** Identify what it actually needs from its description
  (e.g. "deliver PNGs to S3" = a deliverable that never ran) and `dispatch` it.
- agent task `in_progress` far beyond normal duration WITH an `agent.error`
  event (crashed agent) → `retry`
- **agent task `in_progress`/`running`, streamed real work, then went SILENT
  with no `agent.complete` and no completion record — the single most common
  stall.** An agent that runs to the end of its work and then dies (or
  idle-times-out) before calling `report_completion` leaves the ticket stuck
  forever with NO error. **The missing completion record does NOT mean the
  work is undone — check the DELIVERABLE, not the bookkeeping** (test below),
  then `mark-done` (shipped) or `retry` (not shipped).
- review gate `in_review` / `human:*` waiting on a human (NOT a failure — do
  not touch; escalate only if waiting extraordinarily long)

## 3. THE STUCK-AGENT TEST — "did the work actually ship?"

When an agent streamed work and then went silent with no completion, DO NOT
conclude "not done" from the missing `agent.complete`/completion record. Check
the deliverable directly:

- **The agent's own last words.** `streamCounts[<agentId>].lastText` — often
  its verdict ("QA VERDICT: PASS, zero regressions", "opened PR #87").
- **The artifact.** Is the deliverable this phase was supposed to produce in
  the dossier's `artifacts` (S3)? (dev-evidence.md, a QA report, generated
  assets, a ticket-plan.) A fresh object written around the agent's last
  stream timestamp is strong proof the work completed.

These two signals are always available and are what you decide on. (If the
streamed text cites a concrete external deliverable, e.g. "opened PR #87",
treat that as corroborating evidence and quote it in `--evidence`.)

Deliverable there → work IS done, agent just never reported it → **`mark-done`**
the ticket so the next phase starts. NOT there → genuinely undone → **`retry`**.

## 4. Act — decision order (RESOLVE, don't escalate)

```bash
python3 /mnt/workspace/toolkit/intervene.py unstick   <wfId> --note "why"
python3 /mnt/workspace/toolkit/intervene.py retry     <wfId> <agentId> --note "why"
python3 /mnt/workspace/toolkit/intervene.py mark-done <wfId> <ticketId> --evidence "PR #87 open+green / s3 key / streamed PASS verdict"
python3 /mnt/workspace/toolkit/intervene.py dispatch  <wfId> <ticketId> --note "why"
python3 /mnt/workspace/toolkit/intervene.py comment   <wfId> <ticketId> "observation"
python3 /mnt/workspace/toolkit/intervene.py complete  <wfId> --reason "why"
python3 /mnt/workspace/toolkit/intervene.py escalate  <wfId> "what a human must decide"
```

1. **Silent agent that already did the work (deliverable shipped)?** →
   `mark-done` its ticket with the evidence. This is the #1 case and your #1
   job — get the pipeline moving again.
2. **Silent/crashed agent whose work did NOT ship?** → `retry` it.
   `retry`/`dispatch` are LEASE-GATED: they refuse (409, "lease live") while
   the agent published any event within the lease TTL — a slow agent is not a
   dead agent, and stealing its ticket spawns a duplicate. On a 409: re-check
   `lastStreamAt`/`lastText` in the dossier. Still producing → leave it alone.
   Provably dead despite recent events (e.g. its runtime session is gone) →
   re-run with `--force` and cite the evidence in `--note`.
3. **Orphan ticket never dispatched (no agent event ever)?** →
   `unstick`/`dispatch` it.
4. **All non-epic children done/cancelled but the run still shows
   non-terminal?** → `complete` (closes the run, rolls the epic up). It
   REFUSES in code unless every child is done, so you cannot fake it; trust
   a 409.
5. **Genuinely blocked on a human decision** (ambiguous requirements, a real
   choice only a person can make), or nothing agent-side is actionable
   (crash-loop with retries exhausted, systemic infra fault)? → `escalate`
   ONCE with the specific decision or fact the human needs. A LAST resort,
   not a reflex — you resolve stuck agents yourself via `mark-done`/`retry`;
   you do not page a human to read logs. An open escalation IS a human gate:
   the human gets a Telegram ping, and the watch scheduler skips this run
   until they resolve it — so you will not be re-invoked on it, and there is
   nothing further to silence.

## Rules (some also enforced in code — do not attempt workarounds)

- Never touch `in_review` tickets or any ticket assigned `human:*`.
- `cancel` and `start` are for explicit user requests ONLY (see the
  `run-control` skill) — never use them autonomously in WATCH. A stuck run
  gets dispatched, completed, or escalated; not cancelled on your judgment.
- `complete`/`dispatch`/`retry` are real management actions — USE them when
  the situation fits. Your job is to manage to completion; the code gates
  prevent dishonest closes.
- Never invent that work is done — but never assume it's undone from a
  MISSING completion record either. Missing bookkeeping ≠ failed work. Judge
  from the deliverable itself.
- `mark-done` REQUIRES `--evidence` naming the shipped deliverable — the tool
  refuses without it. No proof = not done = `retry`.
- A slow agent still streaming is not a dead agent — give it time.
- `escalate` is idempotent in code, pages the human via Telegram, and parks
  the run as a human gate (the watchdog skips it until the human resolves).
  Escalating is how you hand off a run you cannot move — never fake
  completion and never stop watching by any other means.
- One decisive intervention pass per invocation: diagnose → act → report →
  stop.

## 5. Crash RCA (after unblocking, not instead of it)

If the diagnosis involved DEAD SESSIONS — an agent that started and died
without completing (multiple session ids on one ticket, an `agent.error`, or
a silent death you just `retry`-ed) — load and follow the `crash-rca` skill.
Crashed runs are invisible to the eval loop, so that is the ONLY path by which
they get analyzed — do not skip it because the run is unblocked.

## 6. Report

Reply with: diagnosis (including any orphan you found and what it needed),
action taken (or "none needed"), expected effect, and — if crash-rca ran —
the RCA verdict and the bug ticket filed or updated.
