# Close-out integrity: cherry-pick log (TEAM-5358)

Running log of the filtered picks from branch B
(`feature/TEAM-5315--si-system-gates-that-gate-nothing-skip` @ `546bf7d7`) onto
`feature/TEAM-5358-api-dev`, which was cut from the integration branch
`feature/TEAM-5353--si-system-close-out-integrity-stopped-r` (= `origin/main` `596f1a96`).
Each pick is one commit, made with `git cherry-pick -m 1 --no-commit <sha>`, then
restoring the dropped paths and resolving conflicts.

Excluded B merges, never picked: #772 bce81db5, #773 b599fe21, #776 e82aeacc,
#777 53c16f88, #779 4fb6b3eb, #782 8cf618fc, #784 24a72dc0.

These paths are dropped on every pick:
- `lambda/orchestrator/**`
- `src/app/api/workflow/[id]/{nudge,retry}/**`
- `src/lib/workflow/claim-release.ts`, `src/lib/workflow/park*.ts`
- `deploy/runtime-agent/**`, `blueprints/**`, `docs/architecture.md`, `deploy/workflow-manager/**`
- `lambda/workflow-output/index*.mjs`, except named hunks
- `deploy/setup-runtime-role.sh`, `deploy/ecs-express/deploy.sh`
- `deploy/telegram-bug-intake/update-config.sh`
- `src/lib/models/orchestrator-model-override.test.ts`, `deploy/pipeline/harness-model.test.mjs`
- IAM and policy hunks in any setup script (see the operator handoff below)

## Turn 1a

### #774 405f3fcc (TEAM-5322 decision contract)

**Kept.** 50 files:
- **Twins:** `lambda/agentcore-hub-{tickets,jira}/` `index.mjs`, `index.test.mjs` and `gate-contract.mjs`.
- **New `decision-contract.mjs`:** the tickets twin, the jira twin and the telegram bridge each get a copy.
- **`fix-contract.mjs` in both twins, +10 lines.** These add the `gate:verifying`, `gate-verifying`, `gate:approved-unverified`, `gate-approved-unverified`, `gateverify:` and `gateverify-` system label prefixes.
- **New files in the tickets twin:** `replay-decision-contract.test.mjs` and `fixtures/*`.
- **Pipeline tools:** `lambda/agentcore-hub-pipeline-tools/` `index.mjs`, `index.test.mjs` and `fixtures/*`.
- **Telegram bridge:** `deploy/telegram-bug-intake/`:
  - `index.mjs`, with the SNS ops-alarm branch;
  - `README.md`;
  - the `__tests__` files: `approval-builder-guardrail`, `gate-decision-options`, `ops-alarm-sns`.
- **Hub routes:** `src/app/api/jira/webhook/route{,.test}.ts` and `src/app/api/workflow/[id]/tickets/transition/route{,.test}.ts`.
- **New hub libs:** `src/lib/workflow/decision-contract.ts`, `decision-keys.ts` and `decision-contract-parity.test.ts`.
- **Hub lib edits:**
  - `gate-contract-parity.test.ts`, `gate-guard-parity.test.ts`, `gate-label-readers.test.ts`;
  - `jira-client.ts` (`myself()`);
  - `jira-read.ts` (exports `adfToPlainText`).
- **Deleted:** `src/lib/workflow/gate-decision.ts` and its test. A grep found no importers on the branch.
- **Deploy and docs:** `deploy/pipeline/surfaces.json`, `scripts/check-fix-kinds-parity.sh` (§1c decision-contract ×3), `docs/MODULES.md`, `docs/pipeline/design.md`.
- **`vitest.config.ts`:** only the `replay-decision-contract.test.mjs` include.
- **`deploy/setup-tickets-lambda.mjs`:** only the zip-line hunk, which adds `decision-contract.mjs`.

**Dropped:**
- The global list:
  - `blueprints/*` (5 files), `docs/architecture.md`, `deploy/ecs-express/deploy.sh`, `deploy/setup-runtime-role.sh`;
  - `deploy/runtime-agent/main.py` and 4 runtime tests, including the new `test_label_gate_head_tool.py`;
  - `deploy/pipeline/harness-model.test.mjs`;
  - `lambda/orchestrator/fix-contract.mjs` (+10) and `review-cap.mjs`, which are backend_dev's;
  - `src/lib/models/orchestrator-model-override.test.ts` (the INDEX_BUDGET bump).
- `deploy/telegram-bug-intake/update-config.sh`, an IAM/config script.
- `deploy/setup-tickets-lambda.mjs`, every hunk except the zip line:
  - the `GATE_DECISION_SECRET_ID` and `GATE_HUMAN_ACCOUNT_IDS` constants;
  - the SecretsManager and EventBridge imports and clients;
  - the `ensureGateDecisionSecret` call and body;
  - the `GateDecisionKeyRead` and `GateDecisionRecordWrite` policy statements;
  - the env hunks;
  - the `ensureReprobeRule` call and body.
- **`deploy/setup-pipeline-tools-lambda.mjs`.** This was not named in the plan. Its `buildInlinePolicy` hunk is IAM: it adds `CfnStackRead`, `LambdaConfigRead` and `GateDecisionRecordRead`. The same rule as `update-config.sh` applies, so I dropped it and its `.test.mjs` hunks.
- **`src/lib/workflow/tool-signature-parity.test.ts` hunks.** These pin `Pipeline___verify_postcondition`, `decision` forwarding and the `post_condition` param in `main.py`. They were dropped with `main.py`. See the fix-up commit below.

**Conflicts and resolutions:**

| File | Conflict | Resolution |
|---|---|---|
| `deploy/telegram-bug-intake/index.mjs` | The SNS branch at handler entry | Took B. The result is byte-identical to B, and `handleOpsAlarm` is defined in #774. |
| `deploy/telegram-bug-intake/__tests__/ops-alarm-sns.test.mjs` | Modify/delete | Took B. The file came from TEAM-5322's own branch, not from #773. |
| `docs/architecture.md`, `vitest.config.ts` | Auto-merged | `docs/architecture.md` was restored. `vitest.config.ts` was kept as listed above. |

### #775 0ec3e3c9 (decision-grammar split and console picker)

**Kept, all 6 files:**
- `src/components/workflow/TicketDetailModal.tsx`
- `src/lib/workflow/decision-grammar.ts` (new)
- `src/lib/workflow/decision-contract.ts`
- `src/lib/workflow/decision-keys.ts`
- `src/lib/workflow/decision-contract-parity.test.ts`
- `tests/ticket-decision-picker.spec.ts`

**Dropped:** none. **Conflicts:** none, the pick applied cleanly.

### #778 cac4d5ac (TEAM-5338 review round 1)

**Kept:**
- `src/lib/auth/human.ts` and `human.test.ts` (new).
- The transition route and its test, and the jira webhook route and its test.
- Both twins: `index.mjs`, `index.test.mjs`, `gate-contract.mjs` and `decision-contract.mjs`, plus the tickets twin's `replay-decision-contract.test.mjs`.
- `lambda/agentcore-hub-pipeline-tools/index{,.test}.mjs`.
- `deploy/telegram-bug-intake/decision-contract.mjs`.
- `lambda/builder-tools/index.mjs` (F10 log redaction).
- From `lambda/workflow-output/index.mjs`, only the F10 handler log line. The pick's diff was that hunk alone, so it was kept as is.
- `docs/workflow/gate-verify-lifecycle.md` (new).
- `src/lib/workflow/` `decision-contract.ts`, `decision-grammar.ts` and the `{decision,gate}-contract-parity`/`gate-guard-parity` tests.

**Dropped:**
- The `nudge` and `retry` routes, with `route.test.ts` for each.
- `deploy/workflow-manager/system-prompt.md`, `toolkit/intervene.py` and `toolkit/test_intervene.py`.
- `docs/architecture.md`.
- `deploy/setup-pipeline-tools-lambda.test.mjs` (+12, the qualified-ARN policy test). The policy it tests was dropped in #774.

**Conflicts and resolutions:**
- `deploy/setup-pipeline-tools-lambda.test.mjs`, `intervene.py`, `docs/architecture.md`, the nudge/retry `route.ts` files, and the modify/delete on the nudge/retry `route.test.ts` files: all are dropped paths, restored to HEAD or removed.
- The `lambda/agentcore-hub-tickets/index.mjs` conflict the plan expected, from #776 context, did not happen. The file auto-merged, so none of #776's lines came in.

### Fix-up after the picks: `tool-signature-parity.test.ts`

- I restored the file to main.
- Both twins now read `post_condition` (#774), but `main.py`'s `Tickets___create_ticket` cannot send it on this branch. I recorded that in a new `AWAITING_RUNTIME_PARAM` exception. A self-expiring test fails once `main.py` sends the key or a twin stops reading it.
- I did not use `NOT_AGENT_FACING`, because the key is agent-facing by design and the twin-symmetry check reads that list.

### 1a exit gate

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` on the decision-contract and gate-contract parity tests, transition, jira webhook, and `lambda/agentcore-hub-tickets` | 8 files, 486 tests, all pass |
| `node --test lambda/agentcore-hub-jira` | 154 of 154 pass |
| Extra check: `tool-signature-parity`, `gate-guard-parity`, `gate-label-readers`, `src/lib/auth`, telegram bridge, pipeline-tools, setup-pipeline-tools | all pass after the fix-up |
| `scripts/check-fix-kinds-parity.sh` | **red, expected.** The twin `fix-contract.mjs` copies carry #774's +10 and `lambda/orchestrator/fix-contract.mjs` does not. Clears when TEAM-5359 lands the orchestrator +10. |

## Operator handoff: dropped IAM, config and env hunks

| Source | Item | Effect until applied |
|---|---|---|
| #774 `deploy/setup-tickets-lambda.mjs` | `ensureGateDecisionSecret`: the `agentcore-hub-gate-decision-key` secret | No key, so every human decision fails closed |
| #774 `deploy/setup-tickets-lambda.mjs` | `GateDecisionKeyRead` and `GateDecisionRecordWrite` on the twin role | Twins cannot verify tokens or write decision records |
| #774 `deploy/setup-tickets-lambda.mjs` | Twin env `GATE_DECISION_SECRET_ID` and `GATE_HUMAN_ACCOUNT_IDS` | Twins use the default secret id. Jira-comment decisions are disabled. |
| #774 `deploy/setup-tickets-lambda.mjs` | `ensureReprobeRule`: the 2-minute EventBridge reprobe | `gate:verifying` holds are re-probed only on the next ticket event |
| #774 `deploy/telegram-bug-intake/update-config.sh` | Bridge `GATE_DECISION_SECRET_ID` and key grant | The bridge cannot mint stop or approve decisions |
| #774 `deploy/setup-pipeline-tools-lambda.mjs` | `CfnStackRead`, `LambdaConfigRead` and `GateDecisionRecordRead` | `Pipeline___verify_postcondition` probes come back indeterminate. The Merge Approval record read is denied. |
| #774 `deploy/ecs-express/deploy.sh` | ECS key grant and `GATE_DECISION_SECRET_ID` env | The hub cannot mint decision tokens |

## Turn 1b

### #780 455774fb (held/verifying modal and transition-result contract)

**Kept, all 8 files:**
- `docs/workflow/gate-verify-lifecycle.md`
- the transition route and its test
- `src/components/workflow/TicketDetailModal.tsx`
- `src/lib/workflow/decision-grammar.ts`
- `src/lib/workflow/transition-result.ts` and its test (new)
- `tests/ticket-decision-picker.spec.ts`

**Dropped:** none. **Conflicts:** none, the pick applied cleanly.

### #781 e6073a91 (gate decision record in both twins)

**Kept, 15 files:**
- Both twins: `index.mjs`, `index.test.mjs`, `gate-contract.mjs` and `decision-contract.mjs`.
- `lambda/agentcore-hub-tickets/replay-decision-contract.test.mjs`.
- `deploy/telegram-bug-intake/decision-contract.mjs`.
- New `lambda/workflow-output/gate-contract.mjs` and `decision-contract.mjs`.
- `src/lib/workflow/decision-contract-parity.test.ts` and `gate-contract-parity.test.ts`.
- `docs/workflow/gate-verify-lifecycle.md`.

**Added by hand in the same commit:**
- `lambda/workflow-output/fix-contract.mjs`: `cp` of the twins' copy (main plus #774's +10).
- `lambda/workflow-output/deploy.sh`: the zip line gains `fix-contract.mjs gate-contract.mjs decision-contract.mjs`.
- `deploy/pipeline/surfaces.json`: the workflow-output `files` list gains the same three.
- `index.mjs` imports none of these three files, so their presence in the zip changes nothing at runtime.

**Dropped, 33 paths:**
- `blueprints/{code-reviewer,operator,release-manager}.md`.
- `deploy/runtime-agent/main.py` and `tests/test_report_completion_evidence.py`.
- `deploy/workflow-manager/toolkit/{compute_metrics,test_metrics}.py`.
- `docs/architecture.md`.
- All four `fix-contract.mjs` hunks, which add the +19 follow-up predicates.
- `lambda/orchestrator/{completion,fix-contract,index}.mjs`, `gate-classifier-parity.test.mjs` and `replay-empty-sweep.test.mjs`.
- From `lambda/workflow-output/`:
  - `index.mjs`, `index.test.mjs`, `deploy.sh` and `replay-empty-sweep.test.mjs`;
  - the four `fixtures/round3-*`;
  - #781's `fix-contract.mjs`.
- The `deploy/pipeline/surfaces.json` hunk (re-added by hand above).
- `scripts/check-fix-kinds-parity.sh`.
- From `src/lib/workflow/`: the `accepted-residuals`, `cap-resolved-event`, `fix-contract`, `follow-ups` and `tool-signature` parity tests, plus `blocked-record-lifecycle.test.ts` and `park.test.ts`.

**Conflicts and resolutions:** 28 conflicts, all in dropped paths. Each was restored to HEAD or removed.

### #783 91010758 (TEAM-5347 review round 2; squash commit, picked without `-m`)

**Kept:**
- **Both twins:**
  - `index.mjs`, `index.test.mjs`, `gate-contract.mjs` and `decision-contract.mjs`;
  - the tickets twin's `replay-decision-contract.test.mjs`;
  - the new `lambda/agentcore-hub-jira/s3-conditional.mjs`.
- `lambda/workflow-output/{gate,decision}-contract.mjs` and `deploy/telegram-bug-intake/decision-contract.mjs`.
- `src/app/api/jira/webhook/route{,.test}.ts`.
- `src/app/api/cloud-code/github/{route,install/route,manifest/route}.ts`, plus the new `manifest/route.test.ts`.
- `src/app/api/models/{catalog,probe,registry,registry/reapply,registry/rollback}/*`.
- `src/app/api/workflow/cd-registry/route{,.test}.ts`.
- `src/lib/auth/human{,.test}.ts` and the new `src/lib/auth/admin-test-headers.ts`.
- `src/lib/workflow/decision-contract.ts` and the new `gate-labels.ts`.
- The `decision-contract`, `gate-contract` and `gate-guard` parity tests.
- `deploy/pipeline/surfaces.json`: the jira row gains `s3-conditional.mjs`.
- `docs/MODULES.md` and `docs/workflow/gate-verify-lifecycle.md`.
- `deploy/setup-tickets-lambda.mjs`: only the `existsSync` import and the `s3-conditional.mjs` zip line, with its comment.

**Dropped:**
- `src/app/api/workflow/[id]/{nudge,retry}/route.ts` and `nudge/route.test.ts`.
- `src/lib/workflow/claim-release.ts`.
- `scripts/check-fix-kinds-parity.sh`.
- `src/lib/workflow/fix-contract-parity.test.ts`.
- The two IAM policy-comment conflict regions in `deploy/setup-tickets-lambda.mjs`. These amend `GateDecisionKeyRead`/`GateDecisionRecordWrite`, which were never picked.

**Conflicts and resolutions:**

| File | Resolution |
|---|---|
| `deploy/setup-tickets-lambda.mjs` | HEAD, for both IAM regions |
| `scripts/check-fix-kinds-parity.sh`, `fix-contract-parity.test.ts`, nudge/retry routes | Dropped |
| nudge `route.test.ts` (modify/delete) | Removed |

**Edits to `gate-verify-lifecycle.md`:**
- Removed:
  - the retry and nudge rows in "Who may decide";
  - the `releaseClaimGated` "Lease ordering" paragraph;
  - the WM un-park sentence;
  - the "clears a DL-035 park" clause.
- Kept the admin-gate test pins and the `AUTH_MODE=none` consequence.
- Removed the "See also" DL-035 link, which points at a `docs/architecture.md` section that is not on this branch.

### #785 546bf7d7 (gate decision record v2)

**Kept:**
- Both twins: `index.mjs`, `index.test.mjs` and `gate-contract.mjs`.
- `lambda/workflow-output/gate-contract.mjs`, for byte parity.
- `src/lib/workflow/gate-contract-parity.test.ts`, +151.
- `docs/workflow/gate-verify-lifecycle.md`, +1.

**Dropped:**
- `blueprints/{code-reviewer,operator,release-manager}.md`.
- `deploy/runtime-agent/main.py` and `tests/test_completion_gate.py`.
- `docs/architecture.md`.
- `lambda/workflow-output/index{,.test}.mjs`.
- `src/lib/workflow/tool-signature-parity.test.ts`.
- `src/lib/workflow/accepted-residuals-parity.test.ts` (modify/delete).
- The comment hunk in `deploy/setup-tickets-lambda.mjs`.

**Conflicts and resolutions:**

| File | Resolution |
|---|---|
| `lambda/agentcore-hub-tickets/index.mjs`, `get_issue` | Toward B. This brings `gateCycle` (#785) and the adjacent `labels:` line (#776). The file now differs from B only in #776's untouched `formatSearchResults` `labels` line and a comment, neither of which was in conflict. |
| `docs/workflow/gate-verify-lifecycle.md` | HEAD (the dead DL-035 link) |
| The other 8 conflicts | All in dropped paths |

### Fix-up after the picks
`src/lib/auth/admin-test-headers.ts`: the doc comment no longer cites `src/lib/workflow/park-test-ddb.ts`, which is not on this branch.

### Phase-1 exit gate

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean. No `@/lib/workflow/park`, `park-test-ddb` or `PARK_CLEAR_WRITES` imports. |
| `gate-contract.mjs` ×3 | `3c0b2b6f…`, matches B |
| `decision-contract.mjs` ×4 | `3117ddca…`, matches B |
| `s3-conditional.mjs` ×2 | identical |
| `fix-contract.mjs` in tickets, jira and workflow-output | identical (`3f7d8e80…`, main plus #774's +10) |
| `fix-contract.mjs` in the orchestrator | still main's (`a4d840cc`), expected |
| `npx vitest run`, all files | 5631 of 5632 pass. The one failure is `fix-contract-parity.test.ts` "every copy matches the first", caused by the orchestrator drift. |
| `node --test lambda/agentcore-hub-jira` | 173 of 173 pass |
| `check-lambda-zip-manifest.sh`: the default run, `--surfaces`, and `--dir` for tickets, jira and workflow-output | all OK |
| `scripts/check-fix-kinds-parity.sh` | red. Same orchestrator drift. |

Both red items clear only when TEAM-5359 lands #774's `lambda/orchestrator/fix-contract.mjs` +10. `origin/feature/TEAM-5359-backend-dev` @ `89697e14` does not carry it yet.

## Turn 2a (not a pick): FR-3 cancelled, F2 signed stop, FR-5 update_ticket

Recorded here because it departs from the plan in a few places:
- **No contract copy was edited.** Each twin computes the cancel options locally as declared ∪ `stopped`. `UNIVERSAL_DECISION_OPTIONS` lands in Turn 2b.
- **The stopped cancel still writes a v2 gate-decision record.** v2 hard-codes `status: "done"`, so the record says `done` with `decision.option: "stopped"` until record v3 (Turn 2b) derives `cancelled`.
- **Jira twin: the refusals come before any write.** It checks for a Won't Do transition and refuses `cancel_status_missing` before any comment or token spend. It accepts a match only if the target status itself maps to `cancelled`, so a transition named "Won't Do" that lands on Done is refused. A non-stopped token is refused before the ledger spend.
- **`tool-signature-parity.test.ts`:** the `Tickets___update_ticket` entry is removed from `DDB_ROUTING_GAPS` now, not in Phase 4, because the routing-gap test demands it as soon as the case exists.
- **`todo` gets a `cancel` row too** (correction after review): never-invoked tickets sit in `todo`, and FR-3 needs them to end `cancelled`. The same F2 rule applies there. The tickets twin has no separate backlog status.
