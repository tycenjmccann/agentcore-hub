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

## Cancel model (`closeout-model.mjs`, used by `replay-closeout.test.mjs`)

api_dev's cancel route has not landed, so the replay applies a test-only model of "Stop the run" from requirements FR-3 and FR-5. The model is pure and lives here, so it is not zipped into the orchestrator and costs no DL-009 budget.
- **Done at stop:** the ticket's first `agent.complete` precedes the stop. A ticket Done only by the stop burst was force-Done, not done.
- **Agent session:** an `agent.invoked`, `orchestrator.agent_invoked` or `agent.started` event before the stop. A non-done ticket with a session is live and keeps its status (FR-3).
- **Follow-up move (FR-5):** an open follow-up (`followUpsMaterialized.created`) whose only open blocker on the at-stop board is the run's CD ticket. The CD ticket is the newest non-human ship-phase sibling, the same rule as `findCdTicket`. The follow-up gets parent `Post-run follow-ups <workflowId>` and `blockedBy: []`, keeps its open status, and is **not** counted as cancelled. "Only open blocker" is judged on the board before the sweep; after the sweep the CD ticket is itself cancelled.
- **Security:** a follow-up with a `security` label, or a title starting `Security:`, is reassigned to `human:engineer`. The Jira export carries no labels, and workflow-output only writes `followup-<hash>`, so the title prefix is the only signal in these fixtures. It matches TEAM-5256 alone.
- **Cancelled (FR-3):** not done at stop, no completion record, no agent session, and not moved. The epic is excluded from every count.

| Run | Live session (keeps status) | Cancelled | Moved follow-ups | Cancelled + moved | Target cancelled / follow-ups |
|---|---|---|---|---|---|
| TEAM-5259 | 5264 | 5265, 5266, 5267, 5279 (4) | 5268, 5270, 5275, 5276, 5277 (5) | 9 | 9 / 5 |
| TEAM-5226 | 5231 | 5232, 5233, 5234, 5258 (4) | 5236, **5237**, 5241, 5253, 5256, 5257 (6) | 10 | 12 / 5 |
| znl7a4 | 5325 | 5326, 5327, 5328, 5329, 5330, 5331, 5352 (7) | 5333, 5334, 5335, 5341, 5342, 5343, 5344, 5349, 5350, 5351 (10) | 17 | 16 / 10 |
| o1l3to | 5305 | 5306, 5307, 5314 (3) | none | 3 | >=2 / n/a |

In all four runs, no non-done ticket had a completion record, and every non-done ticket was later force-Done by the stop burst.

**Delta against the design targets.** The targets match "cancelled + moved", i.e. the unworked tickets the old cancel force-Done'd, for TEAM-5259 (9) and o1l3to. No single rule reproduces the other two, and the model is not tuned to them:
- **TEAM-5226, 10 vs 12:** 12 is the old cancel's own `ticketsCancelled`, which counted all 11 non-done children plus the epic. That count includes live TEAM-5231 and the epic, which FR-3 keeps out. By the same rule, TEAM-5259 would be 11, not its target of 9.
- **znl7a4, 17 vs 16:** no ticket separates out by session, record or blocker. The 17 are TEAM-5326 through 5331 (excluding 5325, which had a live session), TEAM-5352 and the 10 follow-ups.
- **TEAM-5226 follow-ups, 6 vs 5:** the sixth is TEAM-5237, a `console_handoff` assigned `human:engineer` whose only blocker is CD TEAM-5234. FR-5's rule moves it. The requirements list (5256/5253/5257/5241/5236) names only the agent-owned ones. znl7a4's 10 also include four `human:engineer` handoffs (5333, 5335, 5343, 5350), so excluding human follow-ups would give 5/5/6, not 5/5/10.

**What the replay does and does not prove.** All four runs were closed `complete` by an operator path (`closedBy: operator` / `completeReason` on the row), not by the orchestrator. The replay shows the orchestrator adds no completion of its own on the post-cancel board, both with the row `cancelled` and while it is still in flight. Swapping the model back to "force Done" does not flip it either, because the evidence gate and the live-session tickets already refuse that board. Closing the operator lever is api_dev's FR-1/FR-3 work. For R2, case (a) (approve, then stop) holds even without the FR-8 rule, because there is no `cancelled` route. Case (b) (stop, then approve) is the one the rule decides, and it fails if the rule is reverted.
