---
name: crash-rca
description: Root-cause analysis for crashed/dead pipeline agent runs. Use when a WATCH-mode stuck run shows dead agent sessions (agent.started with no completion, multiple session ids on one ticket, or a retry that was itself preceded by silent deaths). Produces a formal RCA and files a bug that auto-fires the bug-fix pipeline when the crash looks systemic.
---

# Crash RCA — dead agent sessions

A "crashed run" is an agent invocation that started (`agent.started` event, its
own session id) but died without a completion report: the ticket sits
`in_progress`, the run goes quiet, and eventually WATCH fires. Each retry gets
a FRESH session id, so a ticket with N session ids in the event log had N-1
dead attempts. Dead runs are also invisible to the eval loop (no closing span),
so nobody else will analyze them — you are the only component that does.

## Procedure

**1. Unblock first, analyze second.** The run's owner is waiting. Apply the
standard stuck-agent test (dossier `lastText` + artifacts). If work didn't
ship: `python3 /mnt/workspace/toolkit/intervene.py retry <wfId> <agentId>`.
Never hold the run hostage to the investigation.

**2. Enumerate the dead sessions.** From the dossier events, collect every
session id seen for the stuck ticket (they embed the pattern
`<ticketId>_<wfId>-<agentId>-<timestamp>`). All but the newest are corpses.

**3. Pull the evidence for each corpse:**

```bash
python3 /mnt/workspace/toolkit/pull_session_logs.py <sessionId> [--wf <wfId>]
```

This queries CloudWatch (shared runtime, coding runtime, span destinations)
and writes `/mnt/workspace/<wfId>/session-<id>.json` with the log tail, last
OTEL spans, and last tool activity before death. What to read off it:

- Last log lines: exception? timeout? OOM? silence?
- Last span operation: died inside `execute_tool`? Which tool? A
  `claude_code`/`codex` call that never returned points at the coding runtime
  handoff, not the persona.
- Time from last activity to nothing: instant death (crash) vs slow bleed
  (timeout).

**4. Write the RCA.** Keep it to this shape:

```
## Crash RCA: <agentId> on <ticketId> (<wfId>)
- Symptom: <what the run looked like from outside>
- Occurrences: <N dead sessions, timestamps, retry lineage>
- Last activity: <final tool call / log line / span before death, quoted>
- Suspected cause: <your best diagnosis, with the evidence line>
- Blast radius: <other runs/agents showing the same signature — check your
  memory and the dossier's prior analyses>
- Suggested fix direction: <one sentence, only if the evidence supports it>
```

**5. Decide: file or note.**

- **Systemic** (≥2 dead sessions with the same signature, or the same
  signature across different runs/agents) → file a bug. It auto-fires the
  bug-fix pipeline:

  ```bash
  python3 /mnt/workspace/toolkit/intervene.py file-bug <wfId> \
    --title "..." --description "<the full RCA>" \
    --agent <agentId> [--repo owner/name]
  ```

  Dedupe is enforced in code: if an open crash bug for that agent already
  exists, your RCA lands as a comment on it instead of a duplicate ticket.
  Omit `--repo` and it defaults to the hub repo — crashes are almost always
  infrastructure, not the workload's repo.

- **One-off transient** (single death, retry succeeded, no matching signature
  anywhere) → do NOT file. Comment the RCA on the ticket
  (`intervene.py comment ...`) and store the signature in memory so a repeat
  upgrades it to systemic.

**6. Remember it.** Save the crash signature (agent, last-activity shape,
suspected cause, date) to memory. The signature match in step 5 only works if
past crashes are retrievable.

## Boundaries

- Never file a bug without log evidence from step 3 — "it died" is not an RCA.
- Never re-file what dedupe suppressed; add new occurrences to the open bug.
- The bug's job is diagnosis, not blame: cite sessions, spans, and log lines,
  not agent quality.
- If `pull_session_logs.py` returns nothing for any corpse (logs expired or
  never landed), say so explicitly in the RCA and escalate instead of guessing.
