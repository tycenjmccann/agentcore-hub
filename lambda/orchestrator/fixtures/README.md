# Orchestrator close-out fixtures (TEAM-5359, wf_1791311636588_rfq233)

Real, redacted exports of four runs that were stopped or force-closed by an operator. They feed `replay-closeout.test.mjs` (FR-2 completion predicate, FR-8 blocker rule) and the FR-4 card checks.

| Run | workflowId | How it ended | Files |
|---|---|---|---|
| TEAM-5259 | `wf_bug_TEAM-5259` | `workflow.cancelled`, then the cancel's Jira Done fallback (since removed: a Jira cancel uses only a Won't Do / Cancelled transition), then `workflow.complete` | `workflow-`, `events-`, `-completions.json`, `-code-reviewer-resume-TEAM-5262.json`. Copied verbatim from the TEAM-5317 staging export (`s3://$ARTIFACT_BUCKET/workflows/wf_1791220686225_znl7a4/shared/fixtures/`); its events file is raw (not de-duplicated, streaming kept) |
| TEAM-5226 | `wf_bug_TEAM-5226` | same as TEAM-5259 | `workflow-`, `events-`, `-completions.json` |
| znl7a4 | `wf_1791220686225_znl7a4` | `workflow.completion_blocked` (`notif_completion_evidence_*` on the row), then an operator force-close: a Done burst and `workflow.complete` | same |
| o1l3to | `wf_1791197897608_o1l3to` | operator force-close (`workflow.complete` written first, Done burst after) | same |

`closeout-manifest.json` is the derived board-at-stop summary per run. It is regenerated from the files here by `node export-closeout.cjs --summary-only`, which makes no AWS calls.

## How the files were made

`export-closeout.cjs` is read-only. It modifies no AWS resource; it only issues:
- DynamoDB `GetItem` on `agentcore-hub-workflows`
- DynamoDB `Query` on `agentcore-hub-events`
- S3 `GetObject` on bucket-root `completions/<ticketId>.json` (for the epic and every agentTasks key)
- S3 `GetObject` on `workflows/<id>/shared/closeout-override.json` (absent for all three runs)

It ran under the coding-runtime role through the Node AWS SDK (the container has no `aws` CLI). The script has the run ids hard-coded, so it does not need the projected Scan that export3.cjs used to resolve them. To re-run: `ARTIFACT_BUCKET=<bucket> node lambda/orchestrator/fixtures/export-closeout.cjs`. Every run is appended to `EXPORT-LOG.txt`.

- **Events:** de-duplicated on `type + detail.timestamp + ticketId`. Lifecycle events are stored twice under two `eventId` shapes. `agent.streaming` rows are dropped because no assertion reads them.
- **Redaction:** identical to export3.cjs. It covers emails, 12-digit account ids, GitHub/AWS/Telegram tokens, Bearer headers, presigned URLs, phone numbers and Telegram chat/user ids, and replaces chat/phone keys wholesale. A residue scan found only `000000000000` placeholders.

## Board-at-stop rule (manifest)

There are no ticket rows (`TICKET_PROVIDER=jira`), so the board is projected from events:
- A ticket counts as **done at stop** only if its first `agent.complete` precedes the stop.
- **Stop time, cancelled runs:** the first `workflow.cancelled`.
- **Stop time, force-closed runs:** the start of the Done burst within 60 s of `workflow.complete`, on either side. A burst is consecutive `agent.complete` events no more than 15 s apart.
- **Follow-ups:** read from each completion record's `followUpsMaterialized.created`.

| Run | tickets | non-done at stop | of which `human:*` | follow-ups (all `blockedBy` = the CD ticket) | `workflow.cancelled.ticketsCancelled` |
|---|---|---|---|---|---|
| TEAM-5259 | 20 | 10 | 2 | 5 (blocked by TEAM-5267) | 11 |
| TEAM-5226 | 31 | 11 | 3 | 6 (blocked by TEAM-5234) | 12 |
| znl7a4 | 35 | 18 | 6 | 10 (blocked by TEAM-5330) | n/a |
| o1l3to | 14 | 4 | 2 | 0 | n/a |

These are the measured numbers. The replay asserts them; it does not tune the projection to the design's targets.

## Board at stop (`closeout-board.mjs`) and the replay

`closeout-board.mjs` only projects each run's board at the stop: inputs, no cancel logic. `replay-closeout.test.mjs` seeds that board into a mocked tickets table and POSTs the **real** hub stop route (`src/app/api/workflow/[id]/stop/route.ts` → `cancelRun` in `src/lib/workflow/cancel-run.ts`). What is cancelled, kept running or moved, and who owns a security follow-up, is production's decision; the test asserts the exact ids. The real orchestrator is then replayed over the board production left.
- **done:** the ticket's first `agent.complete` precedes the stop. A ticket Done only by the stop burst was force-Done, not done.
- **blocked (task `ready`):** the last session event before the stop is `orchestrator.claim_released` reason `agent_self_park`. The agent moved the ticket `in_progress → blocked`, and the orchestrator released the claim (`index.mjs`). blockedBy is the park's list.
- **in_progress (task `running`):** any other `agent.invoked`, `orchestrator.agent_invoked` or `agent.started` before the stop.
- **otherwise:** the status from `ticket.created`.
- **`at-stop-evidence.json`:** a status the exported lifecycle events do not carry, with the events it rests on. Today the only entry is TEAM-5264: it re-parked itself on TEAM-5279 (18:05:35–18:06:05, `agent.streaming` is kept in that export), but no `claim_released` row was exported. `export-closeout.cjs` never writes this file.
- **Follow-ups:** `blockedBy` is taken from `followUpsMaterialized.created`.

## Production result vs acceptance #1

`docs/workflow/closeout-acceptance-evidence-TEAM-5370.md` has the full per-run tables with ids. It also covers the TEAM-5231 / TEAM-5264 event citations and the arithmetic showing target cancelled + follow-ups exceeds the tickets open at the stop, and it proposes an amended acceptance #1. Cancelled counts children; the epic is noted separately.

| Run | Cancelled (target) | Epic | Kept running | Moved follow-ups (target) | Security |
|---|---|---|---|---|---|
| TEAM-5259 | 5 (9): 5264, 5265, 5266, 5267, 5279 | cancelled | — | 5 (5) | — |
| TEAM-5226 | 5 (12): 5231, 5232, 5233, 5234, 5258 | cancelled | — | 6 (5): incl. human handoff 5237 | 5256 → human:engineer |
| znl7a4 | 7 (16): 5326–5331, 5352 | open | 5325 | 10 (10) | — |
| o1l3to | 3 (>=2): 5306, 5307, 5314 | open | 5305 | 0 | — |

The targets are not changed here. Changing them is an amendment to `shared/requirements.md` by its owner.

**What the replay does and does not prove.** All four runs were closed `complete` by an operator path (`closedBy: operator` / `completeReason` on the row), not by the orchestrator.
- **Closing the operator lever:** it is the hub routes' job (FR-1/FR-3), and the replay drives them.
- **No completion from the orchestrator:** the orchestrator, fed every status change the stop made as a stream MODIFY, adds no completion of its own. This holds both with the row `cancelled` and while it is still in flight.
- **R2:** case (a) (approve, then stop) holds even without the FR-8 rule. Case (b) (stop, then approve) is the one the rule decides, and it fails if the rule is reverted.
