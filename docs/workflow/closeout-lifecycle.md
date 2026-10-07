# Close-out lifecycle (TEAM-5358)

How a run's close-out is judged, refused and, by a human, overridden. Phase 4 adds the full state-item table, the operator handoff and the frontend contract. This page starts with the contract backend_dev (TEAM-5359, `lambda/orchestrator/completion.mjs`) and the hub must agree on.

## Contract: the close-out override record

**Who this is for:** the orchestrator, cost-report and `src/lib/workflow/performance.ts` read the override. The hub writes it. If the two sides disagree on any line below, a run either completes over gates nobody waived or stays refused after a human waived them.

### Key and writer

- **Key.** `s3://$ARTIFACT_BUCKET/workflows/<workflowId>/shared/closeout-override.json`. This is the key the TEAM-5359 readers already parse, and `CLOSEOUT_OVERRIDE_KEY()` in `src/lib/workflow/closeout-override.ts` builds it.
- **The one writer is `POST /api/workflow/[id]/closeout-override`.**
  - It requires `requireHumanIdentity`: a signed-in SSO human, never `default` and never `svc:*`.
  - It returns 403 `human_identity_required` otherwise, and writes nothing.
  - **Operator note:** under `AUTH_MODE=none`, or with it unset, nobody can write an override. ECS needs `AUTH_MODE=cloudflare-access` and `CF_ACCESS_*`.
- **Agents are refused.** workflow-output refuses that exact key, `^workflows/[^/]+/shared/closeout-override\.json$`, in three tools:
  - `S3Storage___write_object`;
  - `S3Storage___presign_url` (put);
  - `save_design_doc`, both its private and its `shared/` copy.

  This is an agent-readable refusal, not the boundary. The role can still put the key, which is why the reader rule below exists.

### Request and responses

**Request:** `{ "reason": string }`.
- `reason` is required. Control characters are stripped, then it is trimmed, then it must be 1 to 1000 characters.
- Otherwise the route returns 400 `reason_required` or `reason_too_long`. A long reason is refused, never clamped.
- Any other body field is ignored. In particular `offenders` and `by` are ignored: offenders are computed server-side by `closeoutState()` (`src/lib/workflow/closeout-offenders.ts`), the same function `POST /complete` acts on.

**Responses:**

| Status | `error` | When |
|---|---|---|
| 201 | none | Body: `{status:"created", record, offenders:[{ticketId,title,phase,assignee,why}], missingEvidence, replacedUnverifiable}` |
| 400 | `reason_required`, `reason_too_long` | The reason is missing, blank, or over 1000 characters. |
| 403 | `human_identity_required` | The caller is not a provable human. |
| 404 | none | The workflow row does not exist. |
| 409 | `nothing_to_override` | The row has no `notif_completion_*` notice and there are no offenders. Open gates *without* a notice can be overridden, because that is the set `/complete` would refuse. |
| 409 | `workflow_terminal` | `cancelledAt` is set, or the phase is complete, error, cancelled or a ship-blocked outcome. |
| 409 | `override_exists` | A **verified** override is already at the key. The record is create-once. |
| 409 | `override_contended` | The key kept changing under bounded retries (3 attempts). |
| 503 | `decision_key_unavailable` | The gate-decision key cannot be read. |

A non-fatal events-table row `workflow.closeout_override` carries `{by, reason, offenders, offenderSetHash, replacedUnverifiable}`.

### Record shape

```json
{
  "by": "alice@example.com",
  "reason": "CI ran out of band on the release branch; see PR #12",
  "offenders": ["C-1", "Q-1"],
  "at": "2026-10-06T12:00:00.000Z",
  "v": 1,
  "kind": "closeout-override",
  "workflowId": "wf_1791311636588_rfq233",
  "offenderSetHash": "<hex sha256>",
  "sig": "<base64url HMAC-SHA256>"
}
```

- **The shared fields.** `by`, `reason`, `offenders` and `at` are what `parseCloseoutOverride` reads, unchanged.
  - `by` is the server-verified identity.
  - `offenders` are ticket ids: strings, de-duplicated, sorted. They are missing-evidence ids ∪ gate-class offender ids, with no `@phase` suffix.
- **The extras.** `v`, `kind`, `workflowId`, `offenderSetHash` and `sig` are ignored by the shared parser.
- **canonicalJson.** This is `JSON.stringify` with keys sorted at every depth and `undefined` members dropped. It is `canonicalJson` in `decision-contract.mjs` (all four byte-identical copies) and in `decision-contract.ts`.
- **`offenderSetHash`** = hex sha256 of `canonicalJson(sorted unique offenders)`.
- **`sig`** = `signVerifyRecord([canonicalJson(record minus sig)], key)`, which is base64url HMAC-SHA256 under the gate-decision key: Secrets Manager `GATE_DECISION_SECRET_ID`, default `agentcore-hub-gate-decision-key`.
  - The record is signed with AWSCURRENT.
  - Verify with `verifyRecordSig([canonicalJson(rest)], sig, [AWSCURRENT, AWSPREVIOUS])`.

### Reader rule: unverifiable = absent

A record is an override only if all of the following hold:
- it parses;
- `v === 1`;
- `kind === "closeout-override"`;
- `workflowId` equals the run's id;
- `offenderSetHash` matches its `offenders`;
- `sig` verifies under a current or previous key.

Anything else means **no override**: unsigned, a wrong key, edited after signing, or written for another run. `verifyCloseoutOverride()` is the hub's implementation. The override covers a refusal when every current offender id (`@phase` stripped) is in `offenders` (`closeoutOverrideCovers`, a port of `completion.mjs`).

### Squatter rule (F1)

An agent can still put the key through IAM before the human does. The route therefore treats an existing object it cannot verify as absent:

1. `PutObject` with `IfNoneMatch:"*"`. Success → 201.
2. On 412, GET the object. If it verifies → 409 `override_exists`.
3. If it does not verify, log `[closeout-override] <wf>: unverifiable object squatting <key> (etag …)` with the first 300 characters, then `PutObject` with `IfMatch:<that etag>` → 201 `replacedUnverifiable:true`.
4. If that put returns 412 (someone wrote in between), or the GET returns 404, go back to step 1. At most 3 rounds, then 409 `override_contended`. A verified record that lands in between wins.

### Asks for backend_dev (orchestrator)

- **Verify `sig` before honouring the override.** Today `completion.mjs` accepts the unsigned `{by,reason,offenders,at}` shape, so an agent-written object at the key waives the gates for the orchestrator, though not for `/complete`. This needs:
  - `GATE_DECISION_SECRET_ID` in the orchestrator env;
  - `secretsmanager:GetSecretValue` on that secret;
  - a copy of `decision-contract.mjs` in the zip (or the three functions above).

  The env name is a new entry in `scripts/orchestrator-env.allow`: your DL-036 call. The hub side is done and pinned by `closeout-override.test.ts`.
- **Name the same offender set.** Offenders = missing-evidence ids ∪ gate-class offender ids. The hub's set comes from `closeoutState()`. If the orchestrator computes a narrower set, a hub-signed override still covers it, because covering is a superset check.

## Contract: legacy completion records (deploy-time)

`reportCompletion` on main writes no agent identity field into `completions/<ticket>.json`. `agent_id` reaches only the events table, as `agentId`. From Turn 3f the record carries `agent_id` as its last key (see "report_completion: the assignee owns the record" below). Records written before that deploys must not strand in-flight runs. `gateClassRecordSatisfies()` therefore applies these rules, in order:

| Record | Verdict |
|---|---|
| none | offender `no_record` |
| `source === "workflow-manager"` (the console's mark-done) | offender `console_record`, legacy or not |
| `skipped`/`evidence_kind:"skipped"` without a same-parent sweeper | offender `unproven_skip` |
| no evidence | offender `no_evidence` |
| carries any of `agent_id`, `agentId`, `agent` (non-empty) | every carried field must equal the assignee, else offender `agent_mismatch` |
| carries none of them | **accepted** with warning `legacy_no_agent_id` |

Warnings never block. `/complete` returns them as `warnings:[{ticketId,title,phase,assignee,why}]` on the 200 response, on every 409 and on the terminal event's detail (green and blocked close), and logs `[complete] <wf>: accepted with warnings: <id>:legacy_no_agent_id`. Once every live run's records carry `agent_id`, the legacy row can be removed.

## Contract: cancel a run

`POST /api/workflow/[id]/cancel` parses the request and identifies the caller, then calls `cancelRun()` (`src/lib/workflow/cancel-run.ts`). The stop route (Turn 3f) calls `cancelRun()` directly.

### Request and responses

Body: `{ reason: string, decision?: "stopped" }`. The reason has control characters stripped and is trimmed. It is required, and at most 1000 characters (never clamped).

| Status | Body | When |
|---|---|---|
| 200 | `{ status:"cancelled", cancelledAt, cancelledBy, reason, decision?, decisionDropped?, tickets:{cancelled,skipped,failed,incomplete?,error?}, humanGatesLeftOpen[], ticketsLeftRunning[], cancelStatusMissing?, ticketsIncomplete?, error?, followUpsMoved, followUpsError?, postRunEpicKey? }` | The phase write committed. Tickets the sweep did not close are listed, never an error. |
| 400 | `reason_required` / `reason_too_long {max}` / `decision_invalid {allowed}` | Before any read or write. |
| 404 | `Workflow not found` | |
| 409 | `Workflow already in terminal state {phase}` | `cancelledAt` is set, or the phase is complete, error, cancelled or a ship-blocked outcome (the CAS checks both). |

**Flag for frontend_dev (TEAM-5360):** `WorkflowBoard.tsx:349` POSTs with no body, so it gets 400 `reason_required` until it asks for a reason.

### Row write

`SET phase=cancelled, cancelledAt, previousPhase, cancelReason, cancelledBy [, cancelDecision][, claimedCaller]`, conditioned on not terminal AND `attribute_not_exists(cancelledAt)`. `completeReason` is never written.

- `cancelledBy` = `verifiedActor(req, "cancel")`: the human's email or userId, a `svc:*` identity as-is, else `unauthenticated:cancel`. `claimedCaller` = the `x-hub-caller` header, for audit only (F8).
- `cancelDecision:"stopped"` (F9) is written only for a human caller, or when the run has at least one human gate not closed done and every such gate has a verified v3 gate decision record with status `cancelled` for that ticket and workflow. A run with no human gate gives a non-human caller nothing to prove, so the decision is dropped (`decisionDropped:true`). The plan's `stoppedGateIds` input is not taken: the stop route is human-only, so the identity already decides.

### Sweep

Tickets are listed before the write (DynamoDB `parentId-index`; Jira one JQL `parent = <epic> OR key = <epic>`, all statuses, fields `summary,status,labels,issuelinks,created,description`). CD-blocked follow-ups (below) are taken out of this list first: the F9 check and the sweep never see them.

- done / cancelled: skipped.
- Human gate (`human:*` assignee, `human-review` label; Jira `reviewer:*` label) without a verified stopped record: left open, `humanGatesLeftOpen[]` (F2).
- `in_progress` with `agentTasks[id].status` in running / in_progress / pending / waiting_response / complete, or a `completions/<id>.json`: keeps its status, `ticketsLeftRunning[]`.
- Everything else is cancelled. DynamoDB conditions each write on the status it read (a race counts as skipped). Jira uses only a Won't Do / Cancelled / Cancel transition, never a Done-category one. With none, the issue stays open and is listed in `cancelStatusMissing[]`.
- The epic is closed the same way, unless a gate or agent ticket stays open under it.

### Follow-ups (FR-5)

`report_completion` materializes an agent's `follow_ups[]` as tickets titled `<title> [fu:<hash>]`, labelled `followup-<hash>`, blocked by the run's CD ticket. A cancelled run never deploys, so they would stay blocked under a cancelled epic. `moveFollowUpsOnCancel` moves them instead.

- **CD ticket:** `findCdTicket` (port of `lambda/workflow-output/index.mjs`): the newest non-human child whose assignee's roster phase is `ship`.
- **Follow-up:** not done or cancelled, a `[fu:<8hex>]` title suffix or a `followup-<8hex>` label, and its blockers, minus done and cancelled tickets, are exactly the CD ticket. A follow-up also blocked by a live ticket is not moved; the sweep cancels it like any child.
- **Post-run epic:** `postRunEpicKey` on the workflow row, reused when set. Otherwise `Tickets___create_ticket {summary:"Post-run follow-ups <wf>", issue_type:"epic", workflow_id}`, then `SET postRunEpicKey` conditioned on `attribute_not_exists(postRunEpicKey)`. A writer that loses that condition re-reads the row (ConsistentRead), uses the winner, and cancels its own epic with `Tickets___transition_ticket {transition_id:"cancelled"}`. If the Jira twin's create deduplicated to the winner, there is nothing to cancel.
- **Move:** `Tickets___update_ticket {ticket_id, parent:<postRunEpicKey>, blocked_by:[], description}`. The description starts `MOVED on cancel of <wf>: was blocked by CD <cd> (origin <origin>)`, followed by the existing description. The origin is parsed from the follow-up banner; when `completions/<origin>.json` has a `followUps[]` entry with the same hash whose `detail` is not already in the description, the detail is appended.
- **Status:** a moved follow-up that was `blocked` is then transitioned with `Tickets___transition_ticket {transition_id:"ready"}`: a `to` on the tickets twin, and `Ready` through the Jira twin's `INTERNAL_TO_JIRA`. A `todo`/`ready`/`in_progress` follow-up keeps its status. A follow-up is never transitioned to done. If the unblock is refused, the move still counts and the refusal goes into `followUpsError` (`moved but still blocked`).
- **Security:** a follow-up with any label matching `security` (case-insensitive) also gets `assignee:"human:engineer"`. One `manager_escalation` is appended to `humanNotifications` (`list_append`, id `notif_followup_security_<ticket>`, reviewer `close-out`), skipped if that id is already on the row.
- **Failure:** never fails the cancel. A failed epic create gives `followUpsMoved:0` and `followUpsError`. A refused move is counted into `followUpsError` and the rest still move. A follow-up that did not move keeps its status under the cancelled epic.
- The moves run whatever the sweep reported, `cancelStatusMissing` included.
- **Paging:** the Telegram bridge is the only path that pages a human for a `manager_escalation`, and `scanManagerEscalations` (`deploy/telegram-bug-intake/index.mjs`) skips terminal runs so stale escalations stay quiet. The one exemption is an unacknowledged notification whose id starts with `notif_followup_security_`: it is paged on a terminal run too, with its own wording (no "run parked"), and the same `esc#<id>` claim and Resolved button. The cancel writes it after the phase flips, and the scan is periodic, so ordering the write first would not help.

### Event

`workflow.cancelled` goes to EventBridge (`Source: agentcore-hub.orchestrator`, bus `EVENT_BUS`) and to the events table with the same `detail`: `{ workflowId, cancelledAt, previousPhase, cancelledBy, claimedCaller?, reason, decision?, decisionDropped?, ticketsCancelled, ticketsSkipped, ticketsFailed, humanGatesLeftOpen, ticketsLeftRunning, cancelStatusMissing?, ticketsIncomplete?, ticketsError?, followUpsMoved, followUpsError?, postRunEpicKey? }`. The EventBridge copy also carries `timestamp` (= `cancelledAt`). Both writes are non-fatal. No EventBridge rule consumes `workflow.cancelled` today: the Workflow Manager rule (`deploy/workflow-manager/deploy.sh`) lists its detail types explicitly.

## Contract: stop a run

`POST /api/workflow/[id]/stop` (`src/app/api/workflow/[id]/stop/route.ts`) is a cancel that also closes every open human gate with a signed `stopped` decision. The run then ends with a recorded decision on each gate instead of `humanGatesLeftOpen`.

Body: `{ reason: string }`, sanitized and capped as for cancel.

1. `requireHumanIdentity`. The hub mints the stop tokens with the gate-decision key, and it does that only for a provably human caller. The Workflow Manager and agents use `/cancel`; the toolkit's `stop` command refuses.
2. `loadRunForCancel()` is the same read and ticket list the cancel uses. `openHumanGates()` returns the human gates that are not done or cancelled, excluding CD-blocked follow-ups.
3. For each gate, the hub mints a token `{ticketId, option:"stopped", channel:"hub", by:<human>, workflowId}`, scope-bound to the gate's description (`s`). It then calls `Tickets___transition_ticket {ticket_id, transition_id:"cancelled", reason:"<reason>\nDECISION: override:stopped", decision:"stopped", decision_token, note:<reason>}`. The twin verifies the token and writes the v3 gate decision record (status `cancelled`) before the ticket moves.
4. `cancelRun({decision:"stopped", cancelledBy:<human>, humanIdentity:true})`.

| Status | Body | When |
|---|---|---|
| 200 | `{ ...cancel body, gatesStopped[], gatesNotStopped:[{ticketId, error}] }` | The cancel committed. A gate the twin refused is listed in `gatesNotStopped` and stays in `humanGatesLeftOpen`. |
| 400 | `reason_required` / `reason_too_long {max}` | Nothing read. |
| 403 | `human_identity_required` | No ticket touched. |
| 404 / 409 | as `/cancel` | |
| 502 | `ticket_list_failed {detail}` | Nothing written: a stop that cannot see its gates would not stop them. |
| 503 | `decision_channel_unavailable {detail}` | There are open gates and the gate-decision key is unreadable. Nothing written. |

**Flag for frontend_dev (TEAM-5360):** a Stop button POSTs `/api/workflow/[id]/stop {reason}` and renders `gatesNotStopped`. Like cancel, it needs `AUTH_MODE=cloudflare-access` on ECS, or every call is 403.

## Contract: report_completion — the assignee owns the record (F4)

`WorkflowOutput___report_completion` (`lambda/workflow-output/index.mjs`) checks two things before anything durable is written (record, events, follow-up tickets, sweep skips, transition):

- **Assignee.** If the call carries `agent_id` (main.py injects `_CURRENT_AGENT_ID`) and the ticket's `assignee` (from `get_issue`) is set and differs, the call is refused with `{ok:false, reason:"assignee_mismatch", ticketId, assignee, agentId}`. If the ticket cannot be read, the check fails open, as the base_branch check does.
- **Record owner.** The existing `completions/<ticket>.json` is read. If it carries an `agent_id` that is not the caller's, the call is refused with `{ok:false, reason:"completion_record_owned_by_other", owner, agentId}`. A record with no `agent_id` (written before F4, a skip record, or a hub record) may be replaced by the assignee.

The write is conditional:

- `IfNoneMatch:"*"` when no record existed or it could not be read.
- `IfMatch:<etag>` on the record the caller was shown to own.
- The status rewrite after a failed Done keeps the ETag from the first write.
- A 412 re-reads and applies the owner rule once. If another agent won the race, the call is refused after its (idempotent) follow-ups were filed, and the ticket is not transitioned. If the re-read is still unreadable, the call is refused with `completion_record_unreadable` and `next_action:"retry_report_completion"`.

The record gains `agent_id` (null when the caller sent none) as its last key.

**Flag for backend_dev (TEAM-5359):** `lambda/orchestrator/replay-followups.test.mjs` ("REGRESSION hirhfw") pins the record's ordered key list and needs `"agent_id"` appended after `"status"`. That is the only change it needs.

Not changed: `skipSibling` (empty-sweep skip records) still writes `completions/<id>.json` unconditionally and without `agent_id`.
