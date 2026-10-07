## Verdict

**REQUEST CHANGES — Round 2, reviewed product HEAD `f19de12602dc7ac624e6e6dd6f20264592abf061`.** The ten Done tickets do not establish release readiness. Three additional adversarial tests fail, two deployment-planner tests fail, the surfaces zip guard fails, and the standalone B2 probe no longer loads. No product code was edited during this review.

## Round 2

### Scope and provenance

- Reviewed `fd31ace816f75a2db150b380e188a50e1c1df134..f19de12602dc7ac624e6e6dd6f20264592abf061`: 34 commits, including merges. Ran the requested fetch/checkout/reset. `git rev-list --count HEAD..origin/main` returned `0`; no main merge or sync commit was needed.
- Neither the requested Round 1 findings file nor a shared `findings.md` exists in this checkout, the searched workspace, or the available path history. This document therefore creates the requested path rather than pretending to append to recovered text. The ten-ticket ledger below is reconstructed from the fix commits and prior review context; its row numbers are not claimed to reproduce unavailable historical finding numbers.
- Tests use real application handlers with mocked I/O. Three additional adversarial cases were injected into existing test modules in memory through a temporary Vitest transform, not edits to repository tests. Configs and full outputs are retained in `/tmp/agentcore-review-round2/`.

### Ten-ticket verification ledger

| # | Ticket / scope | Round 2 status and evidence |
|---|---|---|
| 1 | TEAM-5367 — signed proof readers, binding, protected prefixes | **Targeted fix verified; not end-to-end clean.** `lambda/orchestrator/proof-record-verify.mjs:77` verifies override HMAC/workflow/hash; `:89` requires exact-set equality; `:144` binds gate records to live cycle/scope. `lambda/workflow-output/index.mjs:3086` restores both proof-prefix refusals. Forged-override probe refuses unsigned, bad-signature, wrong-workflow, edited-offender and wrong-hash records. Normal-path enforcement still has R2-1 / TEAM-5380. IAM deployment remains a human follow-up, TEAM-5377. |
| 2 | TEAM-5368 — contract-copy drift / orchestrator budget | **Fixed.** All four `fix-contract.mjs` copies compare equal; gate x3, decision x4 and new verifier x3 also match. `scripts/check-orchestrator-surface.sh` passes at `12991/12991`; DL-036 at `docs/architecture.md:919` explicitly documents the added verifier, secret read and budget. `replay-followups.test.mjs`: 11 passed. |
| 3 | TEAM-5369 — completion-record ownership | **Fixed on the reviewed completion evidence paths.** `lambda/orchestrator/index.mjs:1305`, `lambda/orchestrator/completion.mjs:349`, and `src/lib/workflow/completion-evidence.ts:141` apply the shared ownership rule. The mismatch probe returns `agent_mismatch`; matching identity succeeds; absent identity deliberately retains `legacy_no_agent_id`. Ownership parity: 20 passed. This does not make unsigned completion bodies cryptographically authenticated or every display/metrics reader an ownership gate. |
| 4 | TEAM-5370 — real replay and security follow-ups | **Implementation fixed; numerical targets refuted, not achieved.** Replay imports the real `/stop` route at `lambda/orchestrator/replay-closeout.test.mjs:7` and invokes it at `:412`, exercising real `cancelRun`. 31 passed. `src/lib/workflow/cancel-run.ts:198` recognizes security titles as well as labels; TEAM-5256 reassignment/paging is asserted. Counts are 5/5/7/3 cancelled children and 5/6/10/0 moved. The disjoint-set arithmetic refutation holds for these fixtures; the original 9/12/16 targets and TEAM-5226 five-follow-up target are not asserted or met. Requirements-owner approval of an amendment was not found. |
| 5 | TEAM-5371 — divergent human-gate predicates | **Fixed in the swept predicate sites.** Canonical `isHumanGate` is `lambda/orchestrator/fix-contract.mjs:181`; TS wrapper `src/lib/workflow/completion-evidence.ts:209`. Shared fixtures cover assignee, human-review and reviewer labels; parity suite: 18 passed. Tickets and Jira label-only cancellation refusal tests pass. B2 handler tests pass, but the standalone harness has R2-6. |
| 6 | TEAM-5372 — record-before-status and failure handling | **Not fully fixed.** Record creation now precedes status writes and S3 failures refuse the close (`lambda/agentcore-hub-tickets/index.mjs:2908`, `lambda/agentcore-hub-jira/index.mjs:3147`); ordinary ordering/failure tests pass. A distinct-token concurrency case deletes the winner's proof: R2-2. The change also includes the unexpected IAM policy edit R2-7. |
| 7 | TEAM-5373 — resumable partial cancellation | **Not fully fixed.** Lease/pending state and retry paths exist at `src/lib/workflow/cancel-run.ts:911`, `:940`, `:987`; normal move/unblock retries pass. A completed move followed by failed security paging is never re-paged and is falsely finalized on retry: R2-3. |
| 8 | TEAM-5374 — caller contracts | **Cancel caller fixed; post_condition deferred, not fixed.** MCP requires reason at `mcp/hub/src/workflow/tools.ts:239` and sends it at `:493`; gateway update schema includes parent at `deploy/setup-tickets-lambda.mjs:547`. Runtime create still cannot send post_condition. `src/lib/workflow/tool-signature-parity.test.ts:310` explicitly exempts it under TEAM-5382, blocked by TEAM-5366. That is an accurately documented deferral, not proof that the capability is reachable. |
| 9 | TEAM-5375 — Jira cancellation vocabulary/destination | **Fixed.** `src/lib/workflow/jira-status-vocabulary.ts:89`: `return transitions.find((t) => isCancelledStatusName(t.to?.name)) ?? null;`. Cancel-run uses it at `:674`; client/provider use the shared vocabulary, Lambda has a parity-pinned copy. Cancel-name-to-Done and status-alias tests pass. |
| 10 | TEAM-5376 — lifecycle/documentation | **Requested stale statements corrected.** `docs/workflow/closeout-lifecycle.md:14` documents pending/lease lifecycle; `:20` documents claim/spend/compensation and distinguishes actual record readers. Real replay replaces the README's not-landed claim. Lifecycle-doc suite: 5 passed. The document itself lists remaining engineering follow-ups; documentation completion is not evidence that those defects are fixed. |

### Executed checks and real output

Suite commands/results (counts are per invocation; targeted reruns overlap):

| Command | Result |
|---|---|
| `npx tsc --noEmit --incremental false` | exit 0; no diagnostics |
| `npx vitest run src/lib/workflow src/app/api/workflow src/app/api/jira/webhook lambda/orchestrator lambda/workflow-output lambda/agentcore-hub-tickets mcp/hub` | `Test Files 140 passed (140)`; `Tests 3719 passed (3719)` |
| `npx vitest run lambda/agentcore-hub-pipeline-tools lambda/cost-report/__tests__ deploy/telegram-bug-intake` | `Test Files 28 passed (28)`; `Tests 562 passed (562)` |
| `node --test lambda/agentcore-hub-jira lambda/cost-report` | `# tests 469`, `# pass 469`, `# fail 0`, `# skipped 0` |
| `PYTHONPATH=/tmp/agentcore-review-round2/python-deps python3 -m pytest -q deploy/workflow-manager/toolkit` | `348 passed, 1655 subtests passed` |
| Same pytest invocation for `deploy/pipeline` | `2 failed, 284 passed` |
| Same pytest invocation for `deploy/pipeline/test_plan_surfaces.py` | `2 failed, 27 passed` |
| `npx vitest run lambda/orchestrator/cascade.test.mjs -t R2 --reporter=verbose` | `10 passed`, `55 skipped` |
| `npx vitest run lambda/agentcore-hub-tickets/index.test.mjs -t p4-scope` | `8 passed`, `230 skipped` |
| `node --test --test-name-pattern=p4-scope lambda/agentcore-hub-jira/index.test.mjs` | `4 passed`, `180 skipped` |
| `node lambda/agentcore-hub-tickets/probes/p4-scope.mjs` | exit 1 before executing assertions; R2-6 |
| `bash scripts/check-sibling-copies.sh`, `bash scripts/check-fix-kinds-parity.sh` | pass |
| `bash scripts/check-qa-checklist-parity.sh`, `bash scripts/check-deliverables-parity.sh`, `git diff --check` | pass |

Pytest was initially unavailable; it was installed only into `/tmp/agentcore-review-round2/python-deps`. An initial unittest discovery was the wrong runner for pytest-style tests; an initial node invocation also selected a Vitest test through a comment mentioning node:test. Those runner errors were replaced by the correct successful/failed suite invocations above, not counted as product failures.

Actual forged-override/ownership probe output, using HEAD's exported verifier:

```text
unsigned: REFUSED
badSignature: REFUSED
wrongWorkflow: REFUSED
editedOffenders: REFUSED
wrongHash: REFUSED
valid: VERIFIED
exactSet=true
superset=false
subset=false
mismatchedOwner={"ok":false,"why":"agent_mismatch"}
matchingOwner={"ok":true}
legacyOwner={"ok":true,"warning":"legacy_no_agent_id"}
```

`cmp -s` succeeded within each copy group. `sha256sum` values:

```text
fix-contract.mjs x4       7724eacd446dcb902c74af2914f3d738c8c538420674fabd9def55a0a26d97dd
gate-contract.mjs x3      9024ccadaa90a77ee9921ee0eed1eb4d31ed3d62de278c5edf2701102045da98
decision-contract.mjs x4  6857bc83cc229739b3376f2c938ea44a9db5e366e11077701004f88469cfb9f2
proof-record-verify x3    32faf137c6c69742f2d18777112554305bfc7243be8fd018fc8ff3ea2066814a
s3-conditional.mjs x3     498f0b2c1aa5f9ba401a37386fde8904594526cb1410c03b41c3f245936ab5e3
```

The TS mirror is not a byte-copy of JavaScript: raw source `cmp` returns 1, as expected. Signed-byte/cross-mint/semantic parity is the applicable check; `decision-contract-parity.test.ts` passes all 52 tests, including identical signed token bytes at line 241.

```text
orchestrator surface guard: OK
  modules   = 22 (all allow-listed)
  env reads = 42 (all allow-listed)
  lines     = 12991 / 12991   index.mjs 5153 / 5175
```

There is zero remaining total-line headroom, but no unapproved budget exceedance. The delta grep `git diff --unified=0 fd31ace8..HEAD -- lambda src deploy mcp | grep -nE '^\+[^+].*[A-Z_]+_MODE'` finds only replay-test `AUTH_MODE` / `SSO_AUTH_MODE` plumbing, not a new production routing/mode flag. No runtime-agent/main.py change. New persisted cancellation fields have a lifecycle row; no additional undocumented durable field was identified in this sweep.

Replay acceptance: the real cancel implementation now supplies the results, with mocked stores/ticket transport rather than a duplicate cancellation classifier. `replay-closeout.test.mjs:330`/`:339`/`:348`/`:357` pin exact cancelled IDs; `:333`/`:342`/`:351`/`:360` pin moved IDs. Assertions cover preserved done work, moved follow-ups staying open, TEAM-5256 assigned human:engineer, and no workflow.complete for the cancelled runs. TEAM-5226 includes the sixth handoff TEAM-5237. The arithmetic in `docs/workflow/closeout-acceptance-evidence-TEAM-5370.md:22` is sound: target cancelled plus moved exceeds all non-done children plus epic (14>11, 17>12, 26>19). This supports a requirements correction, not a claim of passing the original numerical acceptance.

### New findings

#### R2-1 — High — normal completion bypasses gate-class proof checks (TEAM-5380)

Owner: **backend_dev**. Present in the integration diff; the new verifier call remains conditional on an already-verified override.

`lambda/orchestrator/index.mjs:3419`:
```js
  if (offenderIds.length || hasCompletionBlockedNotice(liveWf || workflow)) {
```
`lambda/orchestrator/index.mjs:3425`:
```js
    const set = override && await closeoutOffenderIds(children, { workflowId: workflow.id, missingIds: offenderIds, keys: keys.keys, readJson: readArtifactJson,
```

Failure: a cold run has done review/verification tickets and task metadata containing output/artifactKey, but no required completion/gate proof records and no historical refusal notification. The outer branch is skipped and completion is claimed. The hub's `closeoutState` rejects the corresponding gate-class evidence. The adversarial test changes the existing all-task-output happy-path expectation to require no completion; actual output is `AssertionError: expected 1 to be +0`.

Sibling sweep: `git grep -nE 'closeoutOffenderIds\(|closeoutState\(' -- lambda src ':!*.test.*'` finds the sole orchestrator call at `index.mjs:3425`, verifier definitions in three copies, and hub calls at `/complete/route.ts:553` and `/closeout-override/route.ts:206`. The hub calls are not conditioned on an existing override. Run the authoritative proof judgment before every completion claim, not only override comparison.

#### R2-2 — High — losing close deletes a concurrent winner's signed proof

Owner: **api_dev**. Introduced by TEAM-5372.

`lambda/agentcore-hub-tickets/index.mjs:812`:
```js
      if (verdict === "same") return { ok: true, outcome: "same", key };
```
`lambda/agentcore-hub-tickets/index.mjs:647`:
```js
  const keep = outcome?.detail === DECISION_TOKEN_CONSUMED && CLOSED_STATUSES.has(outcome?.status);
```
`lambda/agentcore-hub-tickets/index.mjs:844`:
```js
    await s3.send(new DeleteObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: claim.key, IfMatch: claim.etag }));
```

Failure: two legitimate requests carry different JTIs for the same actor/decision/cycle. A creates the record; B reuses it as `same` and closes the ticket. A loses its status CAS, sees `ticket_moved` rather than its own token consumed, and deletes the very record B used. ETag fencing does not help because B reused those same bytes. The real-handler probe adapts the existing one-token race to a distinct winner JTI and preserves the expected no-delete assertion: `expected ... to have a length of +0 but got 1`. The gate is closed without its proof. The failure reread at `index.mjs:616` is also not strongly consistent, making the same-token protection dependent on seeing the winner.

Sibling sweep: `git grep -nE 'judgeGateDecisionClaim|DECISION_TOKEN_CONSUMED.*CLOSED_STATUSES|releaseOnFailure' -- lambda ':!*.test.*'` finds the classifier in all three gate-contract copies (`:1915`), reuse in Jira `index.mjs:1033`, and Jira unconditional release-on-failure at `:1076`. Jira also deletes by ETag at `:1065`; it needs the same shared-record ownership audit. The distinct-JTI failure was reproduced on the DDB twin, not claimed as a separately executed Jira race. Preserve a proof adopted by another successful close; establish durable ownership/finalization before compensation.

#### R2-3 — High — resumed cancel silently drops a failed security escalation

Owner: **api_dev**. Introduced in TEAM-5373's reconciliation path.

`src/lib/workflow/cancel-run.ts:438`:
```ts
        if (blockers.length === 0 && c.status !== "blocked") continue; // fully moved already
```
`src/lib/workflow/cancel-run.ts:454`:
```ts
        await escalate(c);
```

Failure: moving/reparenting a Security follow-up succeeds; the notification append fails; unblocking succeeds. The first cancel correctly records closeout pending. On retry the child is ready/unlinked under the post-run epic, so it takes the early continue before retrying escalation. No error remains and the pending marker is removed. Real-route fault-injection output:

```text
ROUND2 security retry {"attempts":1,"second":{"status":"cancelled","cancelledAt":"2026-10-07T05:53:38.617Z","cancelledBy":"unauthenticated:cancel","reason":"superseded by wf-2","resumed":true,"tickets":{"cancelled":1,"skipped":1,"failed":0},"humanGatesLeftOpen":[],"ticketsLeftRunning":[],"followUpsMoved":0,"postRunEpicKey":"T-EPIC","closeoutComplete":true}}
AssertionError: expected 1 to be 2
```

Sibling sweep: `git grep -nE 'fully moved already|await escalate\(' -- src/lib/workflow/cancel-run.ts` finds original-move escalation at `:402`, the early continue at `:438`, and retry escalation at `:454`. Both Jira and DDB use this shared code. Reconcile notification delivery independently from whether the ticket move is already complete.

#### R2-4 — High — DDB ticket Lambda's deployment zip omits an imported module (TEAM-5379)

Owner: **backend_dev**. TEAM-5372 added the import/module without adding it to this deploy surface.

`deploy/pipeline/surfaces.json:81`:
```json
      "files": [
        "index.mjs",
        "fix-contract.mjs",
        "gate-contract.mjs",
        "decision-contract.mjs"
      ],
```

`lambda/agentcore-hub-tickets/index.mjs` now imports `./s3-conditional.mjs`. In installations where this optional Lambda exists, the manifest-built artifact cannot resolve that import. Real `bash scripts/check-lambda-zip-manifest.sh --surfaces` output:

```text
FAIL: local-import closure not covered by the `files` list in deploy/pipeline/surfaces.json:
agentcore-hub-tickets (lambda/agentcore-hub-tickets):
  - s3-conditional.mjs
```

`test_manifest_covers_repo` at `deploy/pipeline/test_plan_surfaces.py:255` also fails: `assert ['lambda/agentcore-hub-tickets/s3-conditional.mjs (imported, not in files[] of agentcore-hub-tickets)'] == []`.

Sibling sweep: `git grep -n 's3-conditional' -- deploy/pipeline/surfaces.json lambda deploy/setup-tickets-lambda.mjs` finds Jira and workflow-output manifest entries at lines 73 and 134; the new tickets copy is the missing surface member. Add it to the actual deployment file list, not just sibling-copy parity.

#### R2-5 — Medium — stale deployment-plan assertion leaves CI red (TEAM-5378)

Owner: **backend_dev**. Caused by the Round 2 cost-report surface change.

`deploy/pipeline/test_plan_surfaces.py:26`:
```py
    assert d == "lambda/cost-report" and npm == "0" and optional == "0" and files == "index.mjs kpi.json"
```

Actual `test_lambda_dir_change_deploys_that_function_only` failure:
```text
- index.mjs kpi.json
+ index.mjs kpi.json proof-record-verify.mjs
```

The verifier belongs in the zip; the test expectation is stale. Sibling sweep: `git grep -n 'index.mjs kpi.json\|proof-record-verify.mjs' -- deploy lambda/cost-report` finds the correct manifest at `surfaces.json:25` and updated `lambda/cost-report/deploy.sh`, versus this old exact-list pin. Full planner suite: two failures, including R2-4; this is not excused by a follow-up ticket being open.

#### R2-6 — Medium — standalone B2 scope probe no longer imports

Owner: **backend_dev**. Caused by the new ticket-Lambda DeleteObject import, not a demonstrated gate-freeze bypass.

`lambda/agentcore-hub-tickets/index.mjs:35`:
```js
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
```

`lambda/agentcore-hub-tickets/probes/aws-sdk-stub.mjs:210`:
```js
export class GetObjectCommand extends Command {}
export class PutObjectCommand extends Command {}
```

The probe redirects SDK imports to that stub, which has no DeleteObjectCommand. Real output:
```text
SyntaxError: The requested module '@aws-sdk/client-s3' does not provide an export named 'DeleteObjectCommand'
```

Sibling sweep: `git grep -n 'DeleteObjectCommand\|p4-scope' -- lambda/agentcore-hub-tickets/probes lambda/agentcore-hub-jira/index.test.mjs lambda/agentcore-hub-tickets/index.test.mjs` distinguishes the broken standalone stub from the maintained test mocks. Tickets' eight scope tests and Jira's four scope tests pass. Restore the standalone emulator's actual conditional-delete behaviour, not merely a no-op export.

#### R2-7 — Medium — IAM policy edits crossed the explicit no-IAM review boundary

Owner: **api_dev**, with the human IAM operator under TEAM-5377. Scope finding, not a claim that these narrowly scoped permissions are intrinsically excessive.

`deploy/setup-tickets-lambda.mjs:271`:
```js
  policyStatements.push({
    Effect: "Allow",
    Action: ["s3:PutObject"],
    Resource: `arn:aws:s3:::${ARTIFACT_BUCKET}/pipeline-artifacts/gate-decisions/*`,
  });
  policyStatements.push({
    Effect: "Allow",
    Action: ["s3:DeleteObject"],
    Resource: `arn:aws:s3:::${ARTIFACT_BUCKET}/pipeline-artifacts/gate-decisions/*/gates/*`,
  });
```

Both statements are additions in `git diff fd31ace8..HEAD -- deploy/setup-tickets-lambda.mjs`. Running that setup now modifies IAM; this contradicts the stated code-only/no-IAM integration boundary. No IAM operation was run by this review, and deployed policies were not inspected. Either obtain explicit scope approval or move these changes to the human handoff.

Sibling sweep: `git diff --unified=0 fd31ace8..HEAD -- deploy/ | grep -nE 'iam:|PolicyDocument|Effect|GetSecretValue'` finds these two new Allow statements. `deploy/setup-pipeline-tools-lambda.mjs` changes packaging only. Runtime-role, workflow-manager-role and preapproved role-script paths remain unchanged; checking only filenames containing “role” would miss this edit.

### Dev-filed follow-up disposition

- **TEAM-5378:** real delta defect, reproduced; R2-5.
- **TEAM-5379:** real delta defect, reproduced by both zip guard and planner test; R2-4.
- **TEAM-5380:** real integration proof-enforcement gap, reproduced against completeWorkflow; R2-1.
- **TEAM-5383:** real notification lost-update risk, but the unsafe writer is pre-existing on main and unchanged in both reviewed diffs. `src/app/api/workflow/[id]/escalations/route.ts:80` writes `SET humanNotifications = :n` with only `attribute_exists(workflowId)`, neither checking nor bumping notifVersion. It can overwrite a concurrent append. `lambda/orchestrator/workflow-store.mjs:954` is the versioned sibling. The cited orchestrator `index.mjs:3258` reads/deduplicates a list; it does not rewrite it. This remains an inherited follow-up, not a newly introduced Round 2 product finding.
- **TEAM-5384:** real broad-ack behaviour, also pre-existing on main. `deploy/telegram-bug-intake/index.mjs:3822` sends `body: "{}"`; the escalation route then resolves every open escalation. It can acknowledge a security page while resolving another page. The affected callback/route statements are unchanged by the integration; no narrow-ID fix landed. Acknowledging the notification does not remove the orchestrator's historical-refusal check. Track as inherited, not a new delta finding.

The statement-level comparison for the last two matters: the integration does change other Telegram code and adds escalation tests, but neither establishes that these particular longstanding behaviours were introduced here.

### Additional adversarial run

Command:
```sh
npx vitest run --config /tmp/agentcore-review-round2/adversarial.config.mjs lambda/agentcore-hub-tickets/index.test.mjs lambda/orchestrator/completion-gates.test.mjs 'src/app/api/workflow/[id]/cancel/route.test.ts' -t ROUND2 --reporter=verbose
```

Real result: `Test Files 3 failed (3)`; `Tests 3 failed | 367 skipped (370)`.

Every failing test and assertion:
1. `ROUND2 cold gate-class records absent must block` — `expected 1 to be +0` (R2-1).
2. `ROUND2 distinct tokens same decision must retain winner proof` — `expected ... to have a length of +0 but got 1` (R2-2).
3. `ROUND2 retry must recover a failed security escalation after the move` — `expected 1 to be 2` (R2-3).

Reproduction details: the first changes only the existing all-task-metadata/no-record completion test's expected completion count from 1 to 0. The second changes the existing same-token race's winning row to contain a different JTI, expects ticket_moved, and retains the no-delete invariant. The third uses the existing stateful real-cancel harness, throws once on the security notification append after moving a Security follow-up, retries, and requires a second notification attempt. No product code or checked-in test was altered.

**Round 2 conclusion: REQUEST CHANGES.** Preserve the verified fixes, close the new integrity/retry/packaging failures, resolve the IAM scope deviation, and obtain an explicit decision on the numerical acceptance and deferred post_condition contract before calling all ten findings closed.
