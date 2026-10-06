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

## Turn 2b (not a pick): FR-6 `stopped`, record v3, scope-bound tokens

Canonical copies are the tickets twin's. They were then `cp`'d to the siblings:
- `decision-contract.mjs` ×4 = `2097ca9c…`
- `gate-contract.mjs` ×3 = `0e7c6ebd…`

`fix-contract.mjs` was not touched.

- **`UNIVERSAL_DECISION_OPTIONS = ["stopped"]`.** `admittedOptions(declared)` replaces every `options.includes` site: `parseDecisionAnswer`, the callback encode and decode, and `resolveDecision`. This replaces 2a's local declared ∪ `stopped`.
- **`stopped` only ever cancels.**
  - A `stopped` decision on a done close is refused with `stopped_cancels_not_closes`.
  - A non-stopped decision on a cancel is refused with `stop_requires_signed_decision`.
  - Both twins refuse before the jti is spent.
- **Gate scope moved into `decision-contract.mjs`.** `parseGateScope`, `FINDING_ID_RE` and `GATE_SCOPE_MAX_FINDINGS` now live there, and gate-contract re-exports them.
- **Scope binding.**
  - `scopeHash(description) = sha256(canonicalJson({scope, options}))`.
  - Every token carries `s`, and every minter now passes `description`: the hub transition route, the Telegram bridge, and the Jira comment re-mint.
  - `resolveDecision` refuses `decision_scope_changed` on a mismatch. It fails closed: a token without `s` is refused too.
  - **Deploy note:** held or reprobe tokens minted before this deploy will not verify afterwards. Those gates re-page as `approved-unverified` / `ignored_unbound`, and the human re-decides.
  - Comment-channel (Jira account-ID) decisions have no token and are unaffected.
- **Record v3.**
  - `status` is derived from the option: `stopped` gives `cancelled`, anything else gives `done`. 2a's interim v2 record (`status: done` for a stop) is gone.
  - `decision.note` is `sanitizeDecisionNote(args.note)`: at most 1000 chars, control characters stripped, and omitted when empty.
  - `by` comes from the verified decision, never from args.
  - `sig` is HMAC over `canonicalJson(record minus sig)`.
  - `verifyGateDecisionRecord` keeps the legacy v2 path (status `done` only) for existing records. Any other version is false.
- **The note in the decision comment.** It is appended to the comment with each line prefixed `> `, so it can never read as a second `DECISION:` line.
- **TS mirror.**
  - `decision-grammar.ts` gains `UNIVERSAL_DECISION_OPTIONS`, `admittedOptions` and `parseGateScope`, and stays import-free.
  - `decision-contract.ts` gains `s` on mint and verify, plus `canonicalJson`, `scopeHash`, `signVerifyRecord` and `verifyRecordSig`.
  - New `gate-decision-record.ts` verifies v3 only. It is for the Phase-3 routes.
- **Test fixtures changed.** Every helper that mints a token now mints it over the row's description: the tickets twin `token()`, `replay-decision-contract` `sign`, Jira `tokenFor`, and `gate-guard-parity` `token()`. Record-version assertions went from 2 to 3.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| tickets twin vitest (4 files) | 259 of 259 |
| `node --test lambda/agentcore-hub-jira` | 181 of 181 |
| decision/gate parity, telegram-bug-intake, workflow-output, transition route, jira webhook, tickets twin (vitest) | 37 files, 1131 of 1131 |
| `npx vitest run`, all files | 5653 of 5654. The one failure is `fix-contract-parity` (orchestrator drift, as before). |

## Turn 2c — B2/F3: gate-scope and DECISION OPTIONS frozen once declared

- **`gateFreezeRefusal(before, afterDescription)`** lives in `gate-contract.mjs` (canonical in tickets, copied to jira and workflow-output; md5 `068777096c763afea311242abe090ae9` for all 3).
  - It applies only to human gates (`human:*` assignee or `human-review` label). Agent tickets are never frozen.
  - **Before a decision:** a declared `gate-scope:` or `DECISION OPTIONS:` line cannot be changed or removed. An undeclared line can still be added; the view/click race is then caught at close by the token's `s`.
  - **After a decision** (`done`/`cancelled`): both lines are frozen, and adding a missing one is refused too, so a post-decision `update_ticket` cannot alter what was decided.
  - Lines are compared by their parsed form: options `|`-joined, scope `canonicalJson(parseGateScope)`, and a malformed scope line as `raw:<line>`. Rewording the rest of the brief and title or label edits stay allowed.
  - The refusal is `{ok:false, reason:"gate_frozen", field:"gate-scope"|"decision-options", decided}`. It replaces `decision_options_immutable`; `DECISION_OPTIONS_IMMUTABLE` was removed because nothing else referenced it, and the old tests now assert `gate_frozen` + `field: "decision-options"`.
- **DDB `editIssue`.** A description edit on a human gate is pinned to the pre-read description: `#d = :curD` is added to the ConditionExpression (`attribute_not_exists(#d)` when there was none). If a concurrent write loses that condition, the twin re-reads the row and returns `gate_frozen` with `detail: "description_changed"`; nothing is written.
- **Jira `updateTicket`.** It reads `labels,description,status` and checks the freeze before the PUT.
  - Jira has no conditional PUT. That read is already the last GET before the PUT, with nothing awaited between them, so a second "re-read + compare" would only move the same race window. It was not added (deviation from the plan, explained in a code comment).
  - The residual race (a write between that GET and the PUT) is caught at close: the decision token's `s` no longer matches, so the close is refused with `decision_scope_changed`.
- **Test harness changes.**
  - Tickets mock: an UpdateCommand branch for `:d` that applies the description, honours `#d = :curD`, and can inject a racer (`editRaceDescription`).
  - Jira `withDecisionJira` PUT stub: it now applies `fields.description`.
- **Tests added.** 8 in the tickets twin and 4 in the jira twin. They cover:
  - the round-3 repro after approval and before it;
  - an options edit;
  - a decided gate gaining a line;
  - title and reword edits;
  - undeclared-then-frozen;
  - an agent ticket never frozen;
  - view/click giving `decision_scope_changed`;
  - a DDB concurrent change (tickets twin only).
- **Probe.** `lambda/agentcore-hub-tickets/probes/p4-scope.mjs` runs the real tickets handler. A `module.register` resolve hook swaps `@aws-sdk/*` for `probes/aws-sdk-stub.mjs`, an in-memory DDB/S3/Lambda emulator that applies writes, evaluates Condition and Update expressions, and throws on anything it does not parse. It is not in any zip: the manifest guard covers only the `index.mjs` closure.
  - Against this commit: `unseen P0 CR-9:22222222 => REFUSED`, with row and record findingIds `["CR-9:11111111"]`, and `PROBE PASSED`.
  - Against HEAD before 2c: `unseen P0 CR-9:22222222 => ADMITTED`, with row findingIds `["CR-9:11111111","CR-9:22222222"]`, and `PROBE FAILED`.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| tickets twin vitest (4 files) | 267 of 267 |
| `node --test lambda/agentcore-hub-jira` | 185 of 185 |
| gate-contract / decision-contract / gate-guard / tool-signature parity | 4 files, 270 of 270 |
| `node lambda/agentcore-hub-tickets/probes/p4-scope.mjs` | PROBE PASSED, exit 0 |
| zip manifest (`--surfaces`, tickets `--dir`) | OK |
| `npx vitest run`, all files | 5780 of 5781. The one failure is `fix-contract-parity` (orchestrator drift, as before). |

## Turn 3a — `/complete`: open_gates, completion_blocked, verified closedBy

- **Override location: deviation from the plan.** TEAM-5359 (PR #786) shipped the readers first. The orchestrator `completion.mjs`, cost-report and `src/lib/workflow/performance.ts` all parse `workflows/<id>/shared/closeout-override.json` into `{by, reason, offenders, at}`.
  - The hub therefore writes the same key and fields, and adds signed extras: `v:1`, `kind:"closeout-override"`, `workflowId`, `offenderSetHash` and `sig` (HMAC of `canonicalJson(record minus sig)` under the gate-decision key). The shared parser ignores the extras.
  - The plan's `pipeline-artifacts/closeout-overrides/` path is dropped.
  - **3b must protect this exact key in workflow-output**: agents can write under `shared/` today.
  - Until the orchestrator verifies `sig` itself, it accepts the unsigned shape. The hub's `/complete` does not.
- **Helpers in `src/lib/workflow/completion-evidence.ts`.**
  - **Exact ports of `completion.mjs`:** `COMPLETION_BLOCKED_NOTIF_RE`, `hasCompletionBlockedNotice` and `closeoutOverrideCovers`. Offenders are compared with the `@phase` suffix stripped. `closeout-override-parity.test.ts` stays green.
  - **New:** `GATE_CLASS_PHASES` (review / verification / ship), `GATE_CLASS_EXTRA_AGENTS = ["agentcore_hub_security_reviewer"]` (F7), and `isHumanGateTicket`, which moved here from the route.
  - **New:** `isGateClassTicket`, and `sweepSkipSweeperOf`, a port of the twins' `judgeSkipRecord` field checks.
  - **New:** `gateClassRecordSatisfies`. The record must carry evidence, must not have `source: "workflow-manager"` (F4), and must have `agent_id === assignee`.
- **New module `src/lib/workflow/closeout-offenders.ts`.** It holds the one offender evaluator, shared with the 3b override route. A human gate needs a verified v3 decision record for this run and ticket with status `done`. An agent gate needs its assignee's own completions record. Either can instead be backed by a sweep skip proven by a same-parent sweeper. A read failure other than not-found makes the ticket an offender (`record_unreadable`).
- **New module `src/lib/workflow/closeout-override.ts`.** It holds `CLOSEOUT_OVERRIDE_KEY`, `buildCloseoutOverride` and `verifyCloseoutOverride`. An unsigned, wrong-key, edited or other-run record verifies to `null`, which is treated as absent.
- **The `/complete` predicate.** It is one predicate, the same as the orchestrator's.
  - Offenders = missing-evidence ticket ids ∪ gate-class offender ids.
  - If there are offenders, or the row already carries a `notif_completion_*` notice, the run completes only under a verified override that covers every offender.
  - Otherwise it returns 409. Precedence:
    1. `completion_blocked` when the notice is present;
    2. else `missing_evidence` (unchanged shape, now with `offenders` too);
    3. else `open_gates`.
  - Every 409 carries `overridePresent` / `overrideVerified`.
  - FR-1 is **not** behind `COMPLETION_EVIDENCE_REQUIRED`. The opt-out still shadows agent-work phases only. The shadow test was moved to a development ticket, and a new test pins that the opt-out does not shadow a gate offender.
- **F8: who closed the run.** `closedBy` is `verifiedActor(req, "complete")`: the human's identity, else a `svc:*` user id, else `unauthenticated:complete`. `x-hub-caller` is stored apart as `claimedCaller`. Both are stamped on both terminal writes (green, and `closeBlocked`) and on their events. No `"workflow-manager"` literal is left in the route (grep pin).
- **Fail-closed until 3f deploys.** Completions records do not carry `agent_id` yet: 3f adds it in `reportCompletion`. Until then, every done agent gate-class ticket is an `agent_mismatch` offender, so `/complete` refuses every run with an agent gate unless a human signs an override. The route that writes the override is 3b.
- **Tests.**
  - `complete/route.test.ts`, +19. The S3 mock gained `autoGateRecords`, which synthesizes an owner-written record per done ticket so the legacy tests keep their subject.
  - `closeout-override.test.ts`, 8.
  - `closeout-offenders.test.ts`, 10.
  - `human.test.ts`, +7.
  - Mutation checks: accepting an unverified override fails 1 test; dropping the gate offenders fails 8.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| complete route, closeout-override, closeout-offenders, human, closeout-override-parity, completion-evidence-parity | 6 files, 126 of 126 |
| `npx vitest run`, all files | 5824 of 5825. The one failure is `fix-contract-parity` (orchestrator drift, as before). |

## Turn 3b — closeout-override route, protected key, legacy records

- **Override key: deviation 1, accepted.** The key is `workflows/<id>/shared/closeout-override.json`, signed. Contract: `docs/workflow/closeout-lifecycle.md`.
- **Follow-up (a): legacy completion records (deploy-time).** `reportCompletion` on main writes no identity field (`agent_id` goes only to the events table, as `agentId`).
  - `gateClassRecordSatisfies` now compares every carried identity field (`agent_id` / `agentId` / `agent`) against the assignee.
  - A record carrying none of them is accepted with a non-blocking `legacy_no_agent_id` warning. `/complete` returns it as `warnings[]` on 200 and 409 responses, puts it on event details, and logs it.
  - Two exceptions are never legacy-accepted: console records (`source:"workflow-manager"`), and sweep skips without a proven sweeper (new offender `unproven_skip`, checked before evidence, because skip records carry no `agent_id` either).
  - This replaces 3a's "fail-closed until 3f deploys" note.
- **Refactor.** `closeoutState()` (missing evidence ∪ gate offenders, `blockedBefore`) moved from the `/complete` route into `src/lib/workflow/closeout-offenders.ts`, together with `missingEvidenceTickets`, `phaseOfTicket` and `completionEvidenceRequired`. The override route signs exactly the set `/complete` checks. `/complete` keeps its backfill. The override route runs read-only.
- **New route `POST /api/workflow/[id]/closeout-override`.**
  - It requires `requireHumanIdentity`.
  - The reason is required, at most 1000 characters, with control characters stripped. Over-long reasons return 400 and are never clamped.
  - Offenders are computed server-side, and body `offenders`/`by` are ignored.
  - It returns 409 `nothing_to_override` only when there is no notice **and** no offenders. Open gates without a notice can be overridden.
  - It returns 409 `workflow_terminal`, and 503 when the key is unavailable.
- **Follow-up (b): squatter rule (F1).** The route puts with `IfNoneMatch:"*"`.
  - On 412 it GETs the object. If the object verifies → 409 `override_exists`.
  - Otherwise it logs the squatter and puts with `IfMatch:<etag>` → 201 `replacedUnverifiable:true`.
  - On an IfMatch 412, or a GET 404, it re-judges, for at most 3 rounds, then returns 409 `override_contended`.
- **workflow-output `refuseProtectedKey`.** It gained the exact key pattern `^workflows/[^/]+/shared/closeout-override\.json$`. The rest of `shared/` stays writable.
  - The sweep of write tools that take an agent-supplied key found three: `S3Storage___write_object`, `S3Storage___presign_url` (put), and `save_design_doc`.
  - `save_design_doc` was a hit: `title:"closeout-override"` + `format:"json"` slugged onto the shared key, and `agent_id:"shared"` onto the private key. Both keys are now checked.
  - The other writers can't reach it: ticket-plan and manifest use fixed filenames, and completions and claim keys use other prefixes.
  - This is a fresh ~20-line edit in `lambda/workflow-output/index.mjs` (flagged in the plan).
- **Tests.**
  - `closeout-override/route.test.ts`: 23, against a stateful S3 mock with etag and IfNoneMatch/IfMatch semantics.
  - workflow-output `index.test.mjs`: +4.
  - `complete/route.test.ts`: +3 (legacy warning, legacy console record, `agentId` mismatch).
  - `closeout-offenders.test.ts`: +3.

| Check | Result |
|---|---|
| `npx tsc --noEmit`, `next lint` on the touched files | clean |
| closeout-override route, complete route, closeout-offenders, closeout-override, closeout-override-parity, completion-evidence-parity, human, `lambda/workflow-output` (vitest, its runner; there are no node:test files) | 10 files, 431 of 431 |
| `npx vitest run`, all files | 5857 of 5858. The one failure is `fix-contract-parity` (orchestrator drift, as before). |

## Turn 3c — transition route, hub Jira status maps, row types

- **Transition route (`src/app/api/workflow/[id]/tickets/transition/route.ts`).**
  - `cancelled` is a valid target from `todo`, `ready`, `in_review` and `blocked` (matching the twin, plus `todo`). `done` only reopens.
  - **Flag:** `in_progress → cancelled` is not offered from the console, although the twin allows it. A live agent is the run-level cancel's call.
  - A reason is required. A missing or blank `comment` returns 400 `reason_required`. The `"Manual override from console"` and `"Decision from console"` defaults are deleted. A decision's reason is also forwarded as `note`.
  - Cancelling a human gate needs a signed `stopped`. With no pick and no token, or with any other pick, it returns 409 `decision_required {options:["stopped"], detail:"stop_requires_signed_decision"}`. Picking `stopped` on a close returns `stopped_cancels_not_closes`.
  - The minted token carries `s` = scopeHash(description). Agent tickets cancel with no decision.
  - `admittedOptions()` replaces `gateOptions.includes`. The `decision_required` options on a close (local or from the twin) now always end in `stopped`.
  - **Gate-class mark-done writes no completion record** (`isGateClassTicket`). The ticket still moves, and the 200 or held answer carries `evidenceRecorded:false, reason:"gate_class"`. Agent-work mark-done is unchanged.
  - `TransitionHeldResponse`/`TransitionDoneResponse` gained the two optional fields.
- **Flag for frontend_dev (TEAM-5360):** `TicketDetailModal.tsx` sends `comment` only for request-changes. Plain status changes from the modal now return 400 `reason_required` until it asks for a reason. The Telegram bridge (`transitionGate`) and `intervene.py mark-done` already send one.
- **Hub Jira status maps.** Won't Do, Cancelled and Canceled read as `cancelled`, and `cancelled` writes as Won't Do. Sweep sites:
  - `src/lib/workflow/jira-read.ts`;
  - `jira-client.ts` (both maps);
  - `ticket-provider-jira.ts` (both maps, a site the plan missed);
  - `src/app/api/workflow/webhook/route.ts` `mapJiraStatus` (another site the plan missed).
- **Row types (`types.ts` WorkflowState).** Added `closedBy`, `cancelledBy`, `claimedCaller`, `cancelReason`, `cancelDecision: "stopped"`, `completeReason` and `postRunEpicKey`. `TicketStatus` already had `cancelled`.
- **Left alone (flags).**
  - `src/app/api/jira/metrics/route.ts` `activityAction` buckets a Won't Do as `queued`. It is an activity label, not a status map.
  - `src/app/api/workflow/start/route.ts:932` still closes an orphan dedup epic with `transition_id:"done"`. Moving it to `cancelled` would refuse on a Jira project without Won't Do.
  - The cancel route's optional reason is Turn 3d.
- **Tests.**
  - transition route: +17 (gate-class, agent-work, reason ×4, grep pin, cancel-from ×4, refused-from ×2, decision ×4). 5 existing expectations were updated for gate_class and `stopped`.
  - New `jira-status-cancelled.test.ts`: 9.

| Check | Result |
|---|---|
| `npx tsc --noEmit`, `next lint` on the touched files | clean |
| transition route, jira-status-cancelled | 2 files, 119 of 119 |
| `npx vitest run`, all files | 5883 of 5884. The one failure is `fix-contract-parity` (orchestrator drift, as before). |
