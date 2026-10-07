# Close-out acceptance #1: production counts vs the targets (TEAM-5370)

**Production's "Stop the run" cancels 5 / 5 / 7 / 3 children on TEAM-5259 / TEAM-5226 / znl7a4 / o1l3to and moves 5 / 6 / 10 / 0 follow-ups. Acceptance #1's 9 / 12 / 16 cancelled with 5 / 5 / 10 follow-ups cannot be met by any rule while the follow-ups stay open, because in every run target cancelled + target follow-ups exceeds the tickets still open at the stop.** This note asks the owner of `shared/requirements.md` to amend acceptance #1 to the wording in the last section. The README was not edited to change any target.

Source: `lambda/orchestrator/replay-closeout.test.mjs`. It seeds each run's at-stop board (`fixtures/closeout-board.mjs`) into a mocked tickets table and POSTs the real `POST /api/workflow/[id]/stop`, which runs the real `cancelRun` (`src/lib/workflow/cancel-run.ts`). Every id below is asserted exactly by that test.

## Per run: target vs production

"Cancelled" counts child tickets only. The **Epic** column says whether the run epic is cancelled as well. The old cancel's `ticketsCancelled` counted the epic, so add 1 where it says yes to compare with that number. Gate rows (*) are human gates that `/stop` closes with a signed `stopped` decision before the sweep.

| Run | Target cancelled | Production cancelled (children) | Epic | Kept running | Target follow-ups | Production moved follow-ups | Security → `human:engineer` |
|---|---|---|---|---|---|---|---|
| TEAM-5259 | 9 | **5**: 5264, 5265, 5266*, 5267, 5279* | TEAM-5259 cancelled (5 + 1 = 6) | — | 5 | **5**: 5268, 5270, 5275, 5276, 5277 | — |
| TEAM-5226 | 12 | **5**: 5231, 5232, 5233*, 5234, 5258* | TEAM-5226 cancelled (5 + 1 = 6) | — | 5 | **6**: 5236, 5237, 5241, 5253, 5256, 5257 | TEAM-5256 (paged `notif_followup_security_TEAM-5256`) |
| znl7a4 | 16 | **7**: 5326, 5327, 5328, 5329*, 5330, 5331, 5352* | TEAM-5315 left open (5325 running) | TEAM-5325 | 10 | **10**: 5333, 5334, 5335, 5341, 5342, 5343, 5344, 5349, 5350, 5351 | — |
| o1l3to | ≥2 | **3**: 5306*, 5307, 5314* | TEAM-5299 left open (5305 running) | TEAM-5305 | n/a | **0** | — |

Every moved follow-up has parent `Post-run follow-ups <workflowId>`, `blocked_by: []`, an open status (todo or ready) and a MOVED banner. No ticket is left blocked by the CD ticket (TEAM-5267 / 5234 / 5330 / 5307). None of the four runs emits `workflow.complete`, either from `/stop` or from the real orchestrator replayed over the board production leaves.

## Why the targets cannot be met

A moved follow-up stays open, so it cannot also be cancelled. The cancelled tickets and the follow-ups therefore have to fit, together, inside the tickets that were not done at the stop, plus the epic.

| Run | Target cancelled + target follow-ups | Not done at the stop (manifest `nonDoneAtStop`) + epic | Over by |
|---|---|---|---|
| TEAM-5259 | 9 + 5 = **14** | 10 + 1 = **11** | 3 |
| TEAM-5226 | 12 + 5 = **17** | 11 + 1 = **12** | 5 |
| znl7a4 | 16 + 10 = **26** | 18 + 1 = **19** | 7 |

The targets look like counts of what the old cancel *closed*, moved follow-ups included. TEAM-5226's 12 is exactly that cancel's own `ticketsCancelled`: all 11 non-done children plus the epic. That is the number FR-3 sets out to change, not one it should reproduce.

## The two tickets the old replay kept as "live"

`cancelRun` keeps a ticket's real status only when the ticket is `in_progress` **and** its agent session is live or complete (`agentTasks` status running / in_progress / pending / waiting_response / complete), **or** a completion record exists (`ticketsWithAgentSession`). Under FR-3 ("never-invoked and no-completion tickets → cancelled"), a ticket that is `blocked` with no record is cancelled. The old test-only model treated any session event before the stop as live; that rule is gone.

**TEAM-5231 (run TEAM-5226): blocked at the stop, so it is cancelled.**
- Stop: `workflow.cancelled` at 2026-10-02T19:41:56.279Z.
- Last session event before the stop: `orchestrator.claim_released` reason `agent_self_park` at 2026-09-29T18:47:14.369Z. Its blockedBy list ends with TEAM-5255 and TEAM-5258, and escalation TEAM-5258 was still open (`ready`) at the stop.
- After that park there is no `agent.invoked` or `orchestrator.agent_invoked` for TEAM-5231 in the three days before the stop.
- Self-park is the agent moving `in_progress → blocked`. The orchestrator then releases the claim and sets the task `ready` (`lambda/orchestrator/index.mjs`, the `agent_self_park` release).
- No `completions/TEAM-5231.json`. Its only `agent.complete` (2026-10-02T19:42:19.899Z) is the force-Done burst, after the stop.

**TEAM-5264 (run TEAM-5259): blocked at the stop, so it is cancelled.** This one rests on `lambda/orchestrator/fixtures/at-stop-evidence.json`, because no `claim_released` row was exported for this park.
- 18:00:10.969Z: `orchestrator.agent_invoked`, a re-dispatch after human gate TEAM-5278 closed.
- 18:05:35.013Z: `ticket.created` TEAM-5279, "Escalation: QA live verification unavailable — Juno account access (attempt 2)", assignee `human:engineer`, filed by this session.
- 18:05:42: `agent.streaming` trace `Tickets___transition_ticket` from TEAM-5264.
- 18:06:02: TEAM-5264's text: "I filed a new escalation, TEAM-5279, and parked TEAM-5264 as blocked on it. I did not call `report_completion`, so Ship (TEAM-5265) stays held."
- 18:06:05: its last output, "...I'll treat it as no decision and stay blocked." Nothing more from TEAM-5264 until the force-Done `agent.complete` at 19:42:06.769Z, after the 19:41:52.720Z stop.
- No `completions/TEAM-5264.json`.
- `cancelRun` reads the ticket status, and the agent's own transition set that status.

**Sensitivity:** if TEAM-5264 were instead taken as live (`in_progress`, task running), TEAM-5259 would be 4 cancelled with 5264 kept and the epic left open. The arithmetic above holds either way.

**Genuinely live, so kept:**
- TEAM-5325 (znl7a4): `agent.invoked` at 18:11:25.697Z, 253 ms before the 18:11:25.950Z stop; `agent.died` followed at 18:12:29.
- TEAM-5305 (o1l3to): `orchestrator.agent_invoked` at 13:24:11.010Z, with no park after it before the 17:13:47.249Z stop.

Because something under each of these runs is still running, their epic is left open.

## Two further deltas

- **TEAM-5226 has 6 follow-ups, not 5.** The sixth is TEAM-5237, a `console_handoff` assigned `human:engineer` whose only blocker is CD TEAM-5234. FR-5 ("every open follow-up whose only open blocker is the run's CD ticket") moves it. Excluding human follow-ups would also break znl7a4's 10, which includes four human handoffs (5333, 5335, 5343, 5350).
- **"Done with no completion record" is not a force-Done.**
  - The only tickets done at the stop without a record are TEAM-5273 and TEAM-5278 (TEAM-5259), and TEAM-5243 and TEAM-5249 (TEAM-5226). All four are `human:engineer` escalations that a human answered before the stop (`gate.requested`, then a human `agent.complete`). TEAM-5278's answer is what re-dispatched TEAM-5264 at 18:00:10.
  - Every force-Done of the old cancel falls after the stop, so those tickets are non-done on the at-stop board and already appear above.
  - Counting the four answered escalations would reopen human decisions, and would still not reach the targets: znl7a4 has none and is short 9.

## Security follow-ups

workflow-output materializes a follow-up with the label `followup-<hash>` only, and its follow-up kinds have no security kind. The fixtures carry no labels at all. A labels-only check therefore never matched a real security follow-up.

`isSecurityFollowUp` (`cancel-run.ts`) now matches a title starting `Security` **or** any label naming security. So TEAM-5256 ("Security: CodeBlock.tsx:78 dangerouslySetInnerHTML ... (likely XSS) [fu:708081ec]", assignee `bug_fixer`) is reassigned to `human:engineer` and paged once through the existing `manager_escalation` path. No other follow-up changes owner.

## Proposed amended acceptance #1 (for the requirements owner)

> Replaying "Stop the run" (POST /stop: signed gate stops, then the FR-3 sweep and FR-5 moves) over the four exported runs gives exactly:
> - **TEAM-5259:** 5 children cancelled (5264, 5265, 5266, 5267, 5279) and the epic cancelled; 5 follow-ups moved (5268, 5270, 5275, 5276, 5277).
> - **TEAM-5226:** 5 children cancelled (5231, 5232, 5233, 5234, 5258) and the epic cancelled; 6 follow-ups moved (5236, 5237, 5241, 5253, 5256, 5257).
> - **znl7a4:** 7 children cancelled (5326–5331, 5352); TEAM-5325 kept running and the epic left open; 10 follow-ups moved (5333, 5334, 5335, 5341, 5342, 5343, 5344, 5349, 5350, 5351).
> - **o1l3to:** at least 2 children cancelled (3: 5306, 5307, 5314); TEAM-5305 kept running and the epic left open.
>
> Every moved follow-up is open under a "Post-run follow-ups <workflowId>" epic with no CD blocker. TEAM-5256 is assigned `human:engineer` and paged. No ticket done before the stop changes status, and nothing emits `workflow.complete`.
