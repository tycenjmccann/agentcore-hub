# Race-Condition Deep Dive — Workflow Component

> Study date: 2026-08-30. Scope: orchestrator Lambda, agent-invoker, workflow API routes,
> Workflow Manager (WATCH), jira-tools Lambda, workflow-output Lambda, and the git history
> of every race fix shipped since June.

## 1. Why coding loops keep fighting races

The workflow engine is a **choreographed** distributed state machine. There is no single
serialization point: state transitions are triggered by at-least-once events (Jira webhooks,
DDB streams, EventBridge schedules, agent tool calls, human clicks, WM interventions) that
re-enter the same code concurrently. Every writer therefore has to defend itself with its own
conditional write — and the codebase shows exactly that: **dozens of per-symptom guards**
(invocation claim, cancel guards ×3, stale-claim escape hatch, per-key map writes, dedup-by-summary
in Jira create, wmAutoAnalyzedAt CAS, watch cooldown CAS, "belt & suspenders" ticket claim…).
Each guard was a real incident. Each new feature adds a new writer and a new guard. That is the
loop the coding agents keep getting trapped in: they aren't fixing bugs, they're hand-rolling
distributed locking one incident at a time.

Git history confirms the pattern is chronic, not incidental:

| Era | Incident | Fix |
|---|---|---|
| PR #69 | duplicate tickets | dedup-by-summary in jira-tools create |
| PR #84 | same ticket invoked 3× in 3s → duplicate agent sessions + PRs | atomic `agentTasks[ticketId]` claim |
| PR #94 | cross-session stream bleed | per-session stream isolation |
| PR #109/#115 | 15-min idle kill mistaken for crash → duplicate runs | submit+poll, detach |
| PR #114 | WM bug-filing flood | kill switch + family cap |
| PR #187 + ~12 follow-ups (TEAM-3381→3427) | eval-packager dedup/cooldown/buffer races | seen-set CAS, flush-claim CAS, cooldown-in-CAS… |
| PR #214 era | parallel design merge racy (Codex P2) | per-designer package files |

Three recurring classes: **(1) duplicate triggers** (at-least-once webhooks/streams/retries),
**(2) read-modify-write clobbers** (full-row/full-map/full-object writes over scoped state),
**(3) dual-actor conflicts** (WM/human retry vs. a live agent).

## 2. Concrete findings (current code)

### P1 — full-map `agentTasks` clobber, wrong keying
`src/app/api/workflow/webhook/route.ts:166` (`updateWorkflowTaskMetadata`) reads the workflow,
mutates `tasks[agentId]`, and **writes the entire `agentTasks` map back**. This is precisely the
clobber the orchestrator's own comments outlaw (`lambda/orchestrator/index.mjs:348`, `:807`,
`:1013` all say "a full-row put here races the concurrent invocation claims"). Worse, it keys by
**agentId** while the orchestrator keys by **ticketId** — two keying schemes in one map.
`findTicketForAgent` (`webhook/route.ts:156`, `agent-invoker.mjs:422`) resolves by agentId and
returns *a* ticket, which is wrong the moment one agent has two tickets (fix-ticket fan-out —
the exact scenario PR #84 was about).

### P1 — "find the running task by agentId" ambiguity
`lambda/orchestrator/index.mjs:1466` (and :1427, :1510, :1517):
`Object.values(workflow.agentTasks).find(t => t.agentId === X && t.status === "running")`.
With two concurrent tickets for the same agent, the wrong ticketId gets attached to the session
ID, manifest, error events, and claim release. Silent cross-wiring under fan-out.

### P1 — completion check is non-atomic
`isWorkflowComplete` (`index.mjs:1280`) = query children, `every(done)`; then
`completeWorkflow` (`index.mjs:1363`) guards only on the **stale in-memory** `workflow.phase`
and persists via `saveWorkflow` — a blind full-row `PutCommand` (`index.mjs:1791`) that also
clobbers any concurrent scoped writes (claims, resumeContexts, notifications). The API route
version (`workflow/[id]/complete/route.ts:190`) got a proper `ConditionExpression`; the
orchestrator path never did. Two last tickets closing simultaneously → double completion path
(PR creation survives only thanks to GitHub 422 idempotency), and a full-row clobber either way.
`saveWorkflow` is also called from `handleHumanReviewGate:546`, `createQaVerificationTicket:1313`,
and `consumeResumeContext`'s fallback (`:692`).

### P2 — S3 manifest read-modify-write, two writers, no precondition
`updateManifestSession` (`index.mjs:2143`) and workflow-output `updateManifest`
(`lambda/workflow-output/index.mjs:162`) both do GET → mutate → PUT on
`shared/manifest.json`. Concurrent agent completions lose entries (QA then can't see a dev
agent's PR entry → "nothing to review" churn). No ETag/If-Match precondition.

### P2 — WM intervention vs. live agent
WATCH fires every 5 min, "stale" = 10 min of no significant events
(`lambda/workflow-analyzer/index.mjs:32`). A healthy coding turn can be silent >10 min
(submit+poll turns). `retry` (`workflow/[id]/retry/route.ts:58`) **releases the invocation
claim and re-Readies the ticket with no proof the old session is dead** — if the original agent
is alive, two agents now work the same ticket → duplicate PRs/commits. Same for `dispatch`
(`nudge/route.ts:105` releases the claim unconditionally). The stale-claim escape hatch inside
`claimTicketInvocation` (`index.mjs:459`, 60 min) has the same flaw for any legitimately-long
session. There is **no liveness signal (lease/heartbeat) anywhere** — every actor infers
"dead" from event silence.

### P2 — Jira as state-machine substrate
Transitions are not CAS; reopen is a 2-hop `Done → To Do → Ready` with sleep-retry loops
(`index.mjs:890`), each hop firing a webhook that re-enters the orchestrator; webhook ordering
is unguaranteed; `reconcileBlockersAndStatus` (jira-tools) can race the orchestrator's own todo
handling (already worked around at `index.mjs:260` by *waiting* for the other Lambda). The claim
on the DDB workflow row is the only real lock — everything Jira-side is best-effort.

### P3 — assorted
- `handleReviewRejection` (`index.mjs:567`) mutates `humanNotifications` in memory
  (acknowledged=true) but never persists that mutation on this path.
- Duplicate-webhook dedup for `handleTicketDoneUnified` is a read-check (`index.mjs:343`),
  not a claim — two concurrent "done" webhooks both cascade (unblock writes are idempotent-ish,
  events double).
- Dual provider modes (`TICKET_PROVIDER` jira|dynamodb) mean every handler exists twice
  (`handleTicketDone` + `handleTicketDoneUnified`, two ready paths, two nudge paths, two retry
  paths). Prod is Jira; the DDB mode doubles the surface that must be race-audited and is where
  the P1 webhook clobber lives.
- Event dedup couples writers: `publishEvent` (`index.mjs:2379`) must reuse one timestamp so
  the anomaly-watcher can dedup EventBridge vs DDB copies by tuple equality — fragile contract.

## 3. Root causes (ranked)

1. **No serialization point.** Concurrency between handlers of the *same workflow* is the enemy;
   nothing prevents it, so every write must be individually atomic — an unwinnable whack-a-mole.
2. **State scattered across four stores** (Jira status, workflows row, tickets table, S3 manifest)
   with no version numbers. Scoped-update discipline is by convention (comments), and full-row
   `PutCommand`s keep sneaking back in.
3. **No ownership/liveness protocol between actors.** Orchestrator, WM, humans, and agents all
   write; "is the agent dead?" is guessed from silence in three different places with three
   different thresholds.
4. **Jira is the state machine driver** rather than a projection of it.

## 4. Recommendation

**Do not rewrite. Serialize, centralize, then lease.** Three structural moves, in order of
leverage-per-effort, each independently shippable:

### R1 — Single-writer per workflow: SQS FIFO in front of the orchestrator
All triggers (Jira webhook route, agent completion, nudge/retry/dispatch/cancel/complete, WM
interventions) stop invoking Lambdas / writing tickets directly and instead enqueue a **command**
(`{workflowId, type, payload, dedupId}`) on an SQS FIFO queue with
`MessageGroupId = workflowId`. One Lambda consumer processes each workflow's commands strictly
in order; different workflows still run in parallel. Content-based dedup absorbs Jira's
at-least-once redeliveries for free.

Effect: **concurrency within a workflow drops to zero.** The invocation claim, cancel guards,
stale-read races, double-cascade, and double-completion all become simple sequential code. The
existing orchestrator logic is preserved — only the entry path changes. This one change removes
the need for most of the guards rather than adding another.

### R2 — One data-access module + versioned workflow row
Create `lambda/shared/workflow-store.mjs` — the **only** code allowed to touch the workflows
table. It exposes intent-level ops (`claimInvocation`, `completeTask`, `advancePhase`,
`setResumeContext`, `completeWorkflow`…), each a scoped `UpdateCommand` with a
`version = version + 1` optimistic-lock condition. Delete `saveWorkflow` and every raw
`PutCommand`; add a lint/CI grep that fails on `PutCommand`/`UpdateCommand` against
`WORKFLOWS_TABLE` outside the store. Kill `updateWorkflowTaskMetadata`'s full-map write and the
agentId keying (ticketId everywhere; the invoke chain already carries ticketId end-to-end).
Move the manifest's `sessions` + phase-artifact index into the workflow row (per-key updates)
or S3 conditional writes (If-Match); the manifest stays as a rendered artifact, not a store.

**As shipped (TEAM-4099 F6):** R2 has TWO stores, one per runtime — the orchestrator's
`lambda/orchestrator/workflow-store.mjs` and the app tier's `src/lib/workflow/workflow-store.ts`
(Next.js route handlers + `src/lib`). Same rule in both: named intent-level ops, each a scoped
conditional write; no raw `Put`/`Update`/`Delete`/`TransactWrite` against the workflows table
anywhere else. `scripts/check-workflow-writes.sh` now scans both trees (tests excluded) and
allowlists exactly two files — `lease.mjs` and `lease.ts`, each holding only `stealClaim`'s CAS,
the R3 primitive that is deliberately never re-implemented in a store.

### R3 — Leases instead of silence-guessing
Agent invocation writes a lease: `agentTasks[ticketId] = {status: running, leaseUntil}`;
the runtime heartbeats (it already streams events — piggyback: any agent event extends the
lease). `retry`/`dispatch`/WM `mark-done` become **lease-aware CAS**: they may only steal a
ticket whose lease is expired, atomically, in the same conditional write that re-claims it.
This closes the last dual-actor hole (WM retry vs. live agent → duplicate PRs) and replaces
three inconsistent staleness heuristics (60-min escape hatch, 10-min WM stale, 15-min cooldown)
with one explicit contract.

### R4–R7 — added by the resilience epic (TEAM-3742, merged 2026-09-03)
The epic's code cites four further invariants by number:
- **R4 — fail-open diff-scope**: the diff-scoped ship-review gate must degrade to legacy
  behavior (byte-identical, gate inert) on any missing/unparseable PR context or GitHub error —
  review scoping may never block a run on plumbing failure (`index.mjs` `computeReviewChangeSet`).
- **R5 — cap reset**: an authorized `DECISION: continue` resets the review round count; the cap
  can never permanently wedge a gate a human explicitly re-opened (`review-cap.mjs`).
- **R6 — detection CAS**: the dead-session detector may only steal a claim via the same
  lease-guarded conditional write R3 defines — detection and steal are one atomic CAS, never a
  read-then-write (`dead-session-detector.mjs`).
- **R7 — no duplicate session**: the invoke-retry path never retries after a possibly-successful
  write with unknowable liveness — an ambiguous failure re-throws rather than risking two live
  sessions for one ticket (`agent-invoker.mjs`).

### Simplifications that fall out
- **Delete DynamoDB ticket-provider mode** (prod is Jira-only). Removes ~40% of the orchestrator's
  branchy surface, the entire legacy stream path, and the P1 webhook-route clobber with it.
- Deterministic session IDs — `(workflowId, ticketId, attemptN)` instead of `Date.now()` — so
  even a leaked duplicate invoke collapses to one runtime session.
- Demote Jira to projection: internal status transitions happen on the workflow row first
  (versioned), then mirrored to Jira best-effort; webhooks only matter for *human-initiated*
  moves. The 2-hop reopen dance stops being load-bearing.
- Write `docs/CONCURRENCY.md`: the invariants (single writer per workflow, store-only writes,
  lease rules) — so coding agents stop re-deriving the model per ticket and review gates can
  check diffs against a stated contract.

### Why not Step Functions?
A per-workflow Standard state machine with `waitForTaskToken` for agent runs + human gates would
solve this fully — but it's a rewrite of the orchestrator, the ticket-plan model is dynamic
(intake agent invents the DAG per run), and the WM/chat/nudge tooling would all need rework.
R1–R3 get ~90% of the safety for ~20% of the change. Re-evaluate Step Functions only if races
persist after R1–R3 (they shouldn't: single-writer + versioned store + leases is the same
guarantee set).

## 5. Plan

| Phase | Work | Size | Risk |
|---|---|---|---|
| 0. Quick wins | Fix/delete `updateWorkflowTaskMetadata` clobber + agentId keying; conditional completeWorkflow; persist rejection acks; deterministic session IDs | 1 PR | low |
| 1. Serialize | SQS FIFO + command envelope; convert jira-webhook route, workflow-output completion, nudge/retry/dispatch, WM intervene.py to enqueue; orchestrator consumes | 2–3 PRs | medium (queue infra, DLQ, idempotent replay) |
| 2. Centralize | `workflow-store.mjs`, versioned row, ban raw writes (CI grep), manifest sessions → DDB | 2 PRs | low-medium |
| 3. Lease | lease field + heartbeat-on-event, lease-aware retry/dispatch/mark-done, delete 60-min escape hatch + WM staleness special cases | 1–2 PRs | medium (tune lease TTL vs long coding turns) |
| 4. Prune | remove DDB ticket provider + legacy stream path + legacy harness invoke; CONCURRENCY.md | 1–2 PRs | low |

Sequencing note: Phase 1 first is deliberate — once writes are serialized per workflow, Phases
2–4 are refactors under a safety net instead of live-fire surgery.

**Success metrics** (all already observable): duplicate-invocation skips in orchestrator logs
(should → 0 legitimate hits), WM interventions per run (should collapse), duplicate PR/ticket
incidents (0), and — the real one — coding-loop churn on race tickets.

## Addendum (2026-09-01/02): intake dedup fence

The start path itself grew the same treatment (TEAM-3699/3703/3705/3708, all in
`src/app/api/workflow/start/route.ts`). A redelivered start for the same (sourceTicket,
workflowDefId) is deduped by a `wfdedup_<sha256(sourceTicket:defId)>` marker row in the
workflows table, claimed with `attribute_not_exists` before any epic/workflow is created, with
a terminal-run re-point CAS guarded on the exact canonical id just read. Because the marker is
claimed before the row exists, a marker-without-row is disambiguated by age: within a 120s
in-flight grace window the loser coalesces onto the presumed-live winner instead of forking a
second run. Correctness no longer rests on that heuristic — `putWorkflowRowFenced` writes the
canonical row inside a `TransactWriteCommand` whose ConditionCheck proves the marker STILL
points at this workflowId, so a slow owner re-pointed away mid-flight loses the fence and
coalesces rather than double-creating. Fence losers run compensating cleanup on the orphan epic
they already created (Jira: delete; DynamoDB: cancel via terminal transition with an audit
comment).

## Addendum (2026-09-05): two R3 states that are neither live nor free — `parkClaim` and `gateBypassFlaggedAt`

R3 said a claim is either LIVE (its lease is fresh — hands off) or STALE (stealable). TEAM-3991
found two situations where that binary lies, both in `lambda/orchestrator/workflow-store.mjs` and
both expressed as attributes on the claim rather than as new liveness rules — `lease.mjs` +
`cascade.mjs reconcileDependent` remain the only implementations of liveness itself.

**`parkClaim` — parked is not live, and that is the point.** When an agent files a fix ticket and
its origin ticket goes `blocked`, the origin's claim is still sitting there with a fresh
`startedAt`. Read as live, it froze the origin until the lease aged out (wf 1pl3h1: 30 minutes of
nothing, then a human dispatched it by hand). Read as simply stale, a sweep would steal it and
re-run an agent whose work is *waiting on a fix*, not dead. `parkClaim(workflowId, ticketId,
expectedStartedAt)` moves the claim to a third state: the task is stamped parked (and its lease
is no longer treated as fresh) with a CAS on the exact `startedAt` it read, so a claim that has
since been re-issued to a different generation is never parked out from under its owner. A parked
claim then passes the ordinary claim CAS — when the fix closes, `cascadeUnblock` readies the
origin and the next dispatch takes it cleanly, with no steal and no human.

**`gateBypassFlaggedAt` — a claim that must NOT be re-issued.** The merge-without-approval
detector (D1.1) flags the offending task when it proves a PR merged before the gate that owed it
an approval. That flag has to survive a re-dispatch, or the recovery machinery cheerfully hands
the ticket to a fresh agent and the bypass is laundered into a normal-looking second attempt.
So `claimInvocation` carries `attribute_not_exists(agentTasks.#tid.gateBypassFlaggedAt)` in its
condition expression: the claim CAS itself REFUSES a flagged task. There is no separate check to
forget to call, and it composes with the rest of R3 for free — every dispatch path already goes
through that one CAS.

TEAM-4099 closed the two holes that left in the FLAGGING path itself. First, the flag is now
claimed, not merely written: `claimGateBypassFlag(workflowId, ticketId, {mergeCommit, flaggedAt,
shadow})` stamps it under `attribute_exists(agentTasks.#tid) AND
attribute_not_exists(agentTasks.#tid.gateBypassFlaggedAt)` and is the FIRST write on the path, so
the detector's announcement (`workflow.gate_bypass`), the `in_review` flip and the escalation all
hang off ONE winner. They previously ran before any conditional write, so a re-Done of the flagged
ticket — which the flip itself invites, since the task is no longer `complete` and the done-cascade
dedup guard therefore lets it through — re-announced a bypass a human was already handling. Shadow
mode claims a shadow-scoped attribute instead, because writing the real one would trip the veto
above and quietly turn "measure only" into enforcement.

Second, the flag is never cleared, and acking the escalation does not clear it: the authority a
human exercises by acking is "yes, I accept that this merged unapproved", not "pretend it didn't".
So the run does not resume and does not close green — `completeWorkflow` closes it `deploy-blocked`
with a blockReason naming the PR and merge commit. Before that third state existed, an acked bypass
either deadlocked the run forever (the escalation carried `kind` instead of `type`, so no surface
could list it and no route could ack it) or, once ackable, would have closed it `complete` over a
merge nobody approved.

The shape generalizes: when a claim needs a state other than live/stale, add an attribute and
teach the ONE CAS about it — never a second liveness predicate.

## Addendum (2026-09-05): a claim must not be borrowed from a scan it is filtered on — `epicRollupClaimedAt`

TEAM-4099 F5. The epic roll-up debt (`epicRollupPending`, created atomically with the terminal
claim — D1.4) is retried by the reconcile sweep, which finds it with a narrowly-filtered scan:
`#p = :complete AND attribute_exists(epicRollupPending) AND attribute_not_exists(finalizedAt)`
(`sweep-scan.mjs createPendingRollupScan`). The retry path reused `claimFinalization` to take the
debt — and `claimFinalization` SETs `finalizedAt`, the exact attribute that scan excludes on. So a
single failed retry removed the run from every future sweep while `epicRollupPending` was still
true: the epic sat open on the board forever with nobody left responsible for it, which is the
same wf 7ef4fp symptom D1.4 existed to fix, now with a claim on top of it.

`claimEpicRollupRetry(workflowId, {now, leaseMs})` is a lease on an attribute NO scan filter reads:
`SET epicRollupClaimedAt = :now` under `attribute_exists(epicRollupPending) AND
attribute_not_exists(finalizedAt) AND (attribute_not_exists(epicRollupClaimedAt) OR
epicRollupClaimedAt < :staleBefore)`. Nothing on the retry path touches `finalizedAt` until the
roll-up has actually landed, so a failed attempt leaves the row exactly as the debt scan wants to
find it. The lease is deliberately NOT released on failure: `rollUpEpic` already burns three
attempts with backoff internally, so one retry per ~10-minute window is the back-pressure we want,
and the lease expiring on its own is what makes the next sweep window retry. `rollUpEpic` is
idempotent (Done → Done is a success), so a live completer racing a sweep costs a duplicate event,
never corruption.

Generalized: a claim attribute is part of the query surface. Before reusing an existing claim for
a new obligation, check what SCANS filter on it — a claim that writes an attribute its own
discovery query excludes on makes failure permanent rather than retryable.

## Addendum (2026-09-05): a board status is not an authorization — the gate-ledger epoch

TEAM-4099 F3, adjacent to the claim work above rather than a race. The bypass detector compared
each merge against the gate LEDGER (`reviewGateHistory[gate].decisions`), but fell back to
synthesizing an APPROVE (`approvalSource: "legacy_status"`) whenever the ledger was empty and the
gate ticket merely sat in `done`. `Tickets___transition_ticket` is an ordinary agent tool, the tool
path carries no caller identity, and `in_review → done` was a legal transition on it — so a dev or
fix agent could move its own Merge Approval gate to `done` and have the detector then certify the
merge it had just performed as `clean`. A forgeable approval is worse than no approval, because it
reads as evidence.

Both halves are now closed. In the two ticket Lambdas, a human-review gate (`human:*` assignee /
`reviewer:*` label) can only be moved out of review, or to a terminal `done`, by a caller carrying
an explicit `_caller` marker read from the invocation ENVELOPE — `console` | `telegram` |
`orchestrator`, set by the console transition route (which is also what Telegram's gate buttons
drive, and the only writer of ledger rows) and the orchestrator's own tool invokes. An agent owns
the arguments object, never the envelope, so the marker cannot be forged from inside `parameters`.
In `gate-bypass.mjs`, `legacy_status` is fenced to runs that provably predate the ledger: no
`reviewGateHistory` attribute at all AND `createdAt < GATE_LEDGER_EPOCH` (default
`2026-09-05T02:10:25Z`, the commit that first wrote a human decision to the ledger; env-overridable
for a later deploy). For any current run a `done` gate with no APPROVE row is simply no approval —
verdict `bypass`, `approvalSource: "none"`, reason `gate_done_without_ledger`. A defence that lives
in only one Lambda is not an authz floor: the fence also covers a status set before the guard
shipped, or set by a future writer that forgets it.

## Addendum (2026-09-05): synthesized evidence must never outrank real evidence — the synthesis claim

TEAM-4099 F4. The D1.2 salvage path (`evidence.mjs synthesizeCompletion`) harvests GitHub for an
agent that pushed a branch and died before `report_completion`. It read "no evidence" — no
`completions/<tid>.json`, no `agentTasks[tid].output` — and then wrote both records
UNCONDITIONALLY. Four independent triggers reach it: the dead-session detector's stall branch and
its dead-session branch, the invoke-failure catch, and the prGuard's merged-PR salvage. None of
them coordinated, and the GitHub probe between the read and the writes takes seconds.

Two failure modes fell out of that. Two triggers firing in the same window both passed the read and
both synthesized — two S3 records, two row writes, two `done` transitions, two done-cascades. And a
trigger that read "no evidence" before the agent's own `report_completion` landed then overwrote the
real record with `source: "synthesized"` and the real row with the `[synthesized] N commit(s)`
summary. D1.2's rule is never fabricate evidence; clobbering real evidence with a guess is strictly
worse, because a fabricated summary is at least honest about being one.

The synthesis is now a claimed, conditionally-written operation, and the whole ordering is chosen so
that every race resolves toward real evidence:

1. precondition read (cheap; keeps the common "already reported" case at zero writes)
2. `store.claimCompletionSynthesis` — `SET agentTasks.#tid.synthesisClaimedAt` under
   `attribute_exists(entry) AND attribute_not_exists(output) AND attribute_not_exists(claim)`. First
   write on the path, before any GitHub call, so a loser spends nothing. Untracked legacy rows are
   handled the `claimGateBypassFlag` way: seed via `trackTicket`, retry the stamp only if this call
   created the entry.
3. GitHub harvest — winner only.
4. `IfNoneMatch: "*"` create of `completions/<tid>.json`. The durable record goes FIRST because it is
   what every reader trusts; a real `report_completion` that landed after the claim owns the key and
   the 412 aborts the synthesis (`record_exists`).
5. `store.setSynthesizedEvidence` — per-field SETs under `attribute_not_exists(output) AND
   synthesisClaimedAt = :claimed`. Losing it means real evidence arrived in the gap
   (`real_evidence_won`); the row is left alone.
6. only then the provider `done` transition and `agent.completion_synthesized`.

The claim's disposition on abort is the part worth spelling out, because "hold the claim forever" is
its own bug. It is RELEASED (generation-scoped REMOVE, refused once `output` exists) when the abort
left nothing durable behind — `no_evidence`, or a throw before the record write — because a sticky
claim would make the ticket permanently un-synthesizable and a branch that appears ten minutes later
could never be salvaged, which is the stranded-run bug D1.2 exists to fix. It is KEPT on success and
on the two terminal aborts (`record_exists`, `real_evidence_won`), where evidence now exists and
re-synthesis must never happen: there the stamp doubles as a "synthesis is settled here" marker.

The reverse direction is deliberately left unconditional. `lambda/workflow-output`'s real
`report_completion` still overwrites `completions/<tid>.json` outright — real beats synthesized, and
an existing `source: "agent"` record means the same agent is re-reporting. The orchestrator's
`harvestCompletionEvidence` needed the matching fix: a synthesized row carries both `output` and
`commitSha`, so it satisfied the `hasEvidence && hasShipSignal` short-circuit and permanently blocked
a later real record from ever reaching the row — the run kept `evidenceSource: "synthesized"` and the
agent's own summary was never promoted. A synthesized row now counts as NOT having evidence there,
and a real record overwrites it, carrying its own provenance (`agent`, or `manager` from the
mark-done override).

`@aws-sdk/client-s3` is now pinned in `lambda/orchestrator/package.json`. `IfNoneMatch` on PutObject
needs SDK >= 3.6xx (Aug 2024) and an older client drops the unknown parameter SILENTLY — the
conditional create would degrade into exactly the unconditional overwrite it replaces. A correctness
guarantee cannot rest on whichever SDK version the managed runtime happens to bundle.

Generalized, alongside R2's "scoped conditional write": a write that INFERS state must be
conditional on the state it inferred still holding, and the conditional writes must be ordered so
that the authoritative record is the first thing contended for. Every actor that can perform the
same inference needs one claim between them, and that claim needs an explicit release policy —
released while the obligation is still outstanding, kept once it is discharged.

## Addendum (2026-09-05): a backstop needs a budget — bounding the sibling recompute

TEAM-4099 F7. D2.1's `recomputeRun` re-asks the dispatch invariant of EVERY sibling of a run
whenever something terminal happens (`agent.complete`, `review.approved`, an escalation decision).
That is the right question to ask; the cost of asking it was unbounded in three separate dimensions,
inside an invocation that is not free to spend.

The budget it spends against: `template.yaml`'s `OrchestratorFunction` has `Timeout: 60` (the
`Globals` 900 is overridden) and `MemorySize: 256`, and the DDB-stream trigger has `BatchSize: 10`.
So one invocation can carry ten terminal records, and each of them already owns a done-cascade, a
completion check, fix verification and the gate-bypass check *before* the recompute runs. The
recompute is the last thing in that chain and the only part with no natural ceiling.

What was unbounded, and what bounds it now:

1. **Reads.** Every still-open sibling with blockers cost one serial `getTicket` PER BLOCKER
   (`checkAllBlockersResolved`), for information the sibling rows already carried. Measured on a
   100-sibling epic with 5 blockers each: **500 single-ticket reads** before, **0** after. Blockers
   now resolve against a `Map` built once from the single `getChildTickets` query; only a blocker
   MISSING from that snapshot (cross-epic, or deleted) falls back to a `getTicket`, memoized per id,
   so the read count is at most the number of DISTINCT foreign blockers.
   Note what was *not* done: putting a `Limit` on the child query. That query is shared with the
   cascade and the sweep, and a `Limit` would silently shorten *their* view of the run — a
   correctness change dressed as a bound. (Its real latent gap is the missing `LastEvaluatedKey`
   pagination past 1 MB, which is a separate issue.) The bound belongs at the candidate level.
2. **Candidates.** `RECOMPUTE_MAX_CANDIDATES` (default 50) reconciles at most that many siblings.
3. **Wall clock.** `RECOMPUTE_BUDGET_MS` (default 20000 — a third of the timeout) is checked before
   each `reconcileDependent`.

Both bounds are per INVOCATION, not per call: they live in module scope (the Node Lambda runtime
runs one invocation at a time per container, so module scope *is* invocation scope) and are reset at
the top of `handler`. A per-call budget would have been useless here — ten records would stack ten
budgets and run 200 seconds inside a 60-second function. For the same reason a `(workflow, trigger)`
pair recomputes once per invocation: a batch carrying two terminal records for the same run used to
run the identical whole-run backstop twice, and the second record's own cascade still fans out
normally.

Hitting either bound is not silent — `orchestrator.recompute` carries `truncated: true` / `cap`, or
`budgetExceeded: true` / `budgetMs`, and the event is published even when nothing was reconciled,
because "part of this run was left to the sweep" is exactly what an operator needs to see. Leaving
the remainder to the reconcile sweep is safe by construction: the sweep asks the same question
through the same `cascade.reconcileDependent` (R3), on a 5-minute schedule, which is what it is for.

Generalized: a backstop that runs on every signal is a load amplifier. It needs a per-invocation
budget stated against the function's actual timeout, a bound on work rather than on the shared query
it borrows, and an event that admits when it stopped early — a backstop that silently does less than
it claims is worse than one that is honest about its ceiling.
