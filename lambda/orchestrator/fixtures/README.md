# Orchestrator close-out fixtures (TEAM-5359, wf_1791311636588_rfq233)

Real, redacted exports of four runs that were stopped or force-closed by an operator. They feed `replay-closeout.test.mjs` (FR-2 completion predicate, FR-8 blocker rule) and the FR-4 card checks.

| Run | workflowId | How it ended | Files |
|---|---|---|---|
| TEAM-5259 | `wf_bug_TEAM-5259` | `workflow.cancelled`, then the cancel's Jira Done fallback, then `workflow.complete` | `workflow-`, `events-`, `-completions.json`, `-code-reviewer-resume-TEAM-5262.json`. Copied verbatim from the TEAM-5317 staging export (`s3://$ARTIFACT_BUCKET/workflows/wf_1791220686225_znl7a4/shared/fixtures/`); its events file is raw (not de-duplicated, streaming kept) |
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

These are the measured numbers. The design's targets (9/12/16/>=2 cancelled, 5/5/10 follow-ups) differ for TEAM-5259, TEAM-5226 and znl7a4. The replay asserts the measured numbers. It does not tune the projection to hit the targets.
