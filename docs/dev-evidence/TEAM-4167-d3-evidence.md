# TEAM-4167 Dev B (P1) — D3 acceptance evidence

Branch `feature/TEAM-4167-backend-dev`. All output below is **actual** command
output captured on this branch (node v20.19.2). It backs the D3 honest-gate +
lifecycle-event-contract work (FR-3.2 / FR-3.3 / FR-3.4 / FR-3.5 / FR-3.6).

> Fixture note (call-1 limitation): the runtime IAM role could not read the two
> production S3 dossiers directly, so the reduced fixtures under
> `deploy/workflow-manager/toolkit/fixtures/` were pushed by the lead from a
> reduction of those two dossiers. Each fixture carries a `_provenance` block
> naming its source key (`s3://$ARTIFACT_BUCKET/workflows/.../dossier.json`),
> the reduction rules, and the raw event count — so the numbers below are
> reproducible from the committed tree, not from a live account.

---

## 1. Gate — full definition-of-done

| # | Command | Result |
|---|---------|--------|
| 1 | `npx tsc --noEmit` | **PASS** (exit 0, after `npm run build` regenerated `.next/types`) |
| 2 | `npm run build` | **PASS** — `✓ Compiled successfully` (exit 0) |
| 3 | `npm run lint` | **PASS** (exit 0; warnings only — pre-existing exhaustive-deps / `<img>`) |
| 4 | `npx vitest run` | **PASS** — Test Files 156 passed (156), Tests 2902 passed (2902) |
| 5 | `node --test lambda/agentcore-hub-jira` | **PASS** — # tests 34, # pass 34, # fail 0 |
| 6 | `node --test lambda/cost-report` | **PASS** — # tests 27, # pass 27, # fail 0 |
| 7 | `node --test lambda/anomaly-watcher` | **PASS** — # tests 110, # pass 110, # fail 0 |
| 8 | `python3 -m unittest deploy/workflow-manager/toolkit/test_metrics.py` | **PASS** — Ran 67 tests, OK |
| 9 | `python3 -m unittest discover -s deploy/workflow-manager/toolkit -p "test_*.py"` | **PASS** — Ran 103 tests, OK |
| 10 | `bash scripts/check-workflow-writes.sh` | **PASS** — `workflow-write guard: OK` (exit 0) |
| 11 | `bash scripts/check-lambda-zip-manifest.sh` | **PASS** — `OK (32 modules in closure, all present in zip manifest)` (exit 0) |
| 12 | `bash scripts/check-fix-kinds-parity.sh` | **PASS** — origin-key map in 3 locations in agreement; fix-contract.mjs = 3 byte-identical copies (exit 0) |
| 13 | `python3 -m py_compile deploy/runtime-agent/main.py` | **PASS** (exit 0) |

The 3 `node --test` directories are exactly those wired into CI as standalone
steps (`.github/workflows/ci.yml:40-55`) — not in the vitest include list.

### Vitest flake note (transparency)

The first `npx vitest run` reported 3 failures, all in
`deploy/lib/__tests__/force-flag.test.ts` (`deploy-one.sh --force` end-to-end).
That file spawns real shell subprocesses; under full parallel CPU load it
flaked. Run in isolation it passes 27/27, and a clean re-run of the FULL suite
passed 156/156 files, 2902/2902 tests. Not one of this task's files and
unrelated to these changes.

```
# isolation
$ npx vitest run deploy/lib/__tests__/force-flag.test.ts
 ✓ deploy/lib/__tests__/force-flag.test.ts (27 tests) 861ms
 Test Files  1 passed (1)
      Tests  27 passed (27)

# clean full re-run
$ npx vitest run
 Test Files  156 passed (156)
      Tests  2902 passed (2902)
```

---

## 2. FR-3.3 / FR-3.4 / FR-3.5 — `ymo7dm` dossier re-run

`compute_metrics(fixtures/ymo7dm-dossier.json)` — reduced from
`s3://$ARTIFACT_BUCKET/workflows/wf_1788672380233_ymo7dm/analysis/1788677355678-v1gr/dossier.json`
(`_provenance.rawEventCount = 109`, `rawEventsWithSource = 47`).

```
totalDurationMs: 4600180
humanWaitTotalMs: 353371
humanWait <= total: True
counts.events: 62   (raw: 109)
startedAt:   2026-09-06T05:26:21.514000Z
completedAt: 2026-09-06T06:43:01.694000Z

--- phases (name / durationMs) ---
  requirements             1270506
  development              1877229
  verification             1452445
  phases sum durationMs:   4600180        <-- == totalDurationMs
```

- **`humanWaitTotalMs == 353371`** and **`totalDurationMs == 4600180`** — both exact.
- **phases rows + sum**: three phase rows whose `durationMs` sum to `4600180`,
  i.e. exactly `totalDurationMs` (the run is fully partitioned, no gaps/overlap).
- **`counts.events == 62`** derived from **109** raw events — the dedupe collapses
  the doubled (with-source / without-source) EventBridge twins to one content-key
  row each. 62 is the exact distinct-content-key count, not 55.

### humanReviews rows (each carries `resolvedBy`)

```json
{"gateTicketId": "TEAM-4139", "reviewer": "human:product-owner", "requestedAt": "2026-09-06T05:26:25.816000Z", "resolvedAt": "2026-09-06T05:29:27.953000Z", "waitMs": 182137, "outcome": "approved", "cycle": 1, "resolvedBy": "ticket", "outsideHours": true}
{"gateTicketId": "TEAM-4148", "reviewer": "human:product-owner", "requestedAt": "2026-09-06T05:45:51.489000Z", "resolvedAt": "2026-09-06T05:47:28.682000Z", "waitMs":  97193, "outcome": "approved", "cycle": 1, "resolvedBy": "ticket", "outsideHours": true}
{"gateTicketId": "TEAM-4150", "reviewer": "human:engineer",      "requestedAt": "2026-09-06T05:55:13.725000Z", "resolvedAt": "2026-09-06T05:56:27.766000Z", "waitMs":  74041, "outcome": "approved", "cycle": 1, "resolvedBy": "ticket", "outsideHours": true}
```

`182137 + 97193 + 74041 = 353371` = `humanWaitTotalMs`. Each row resolved by a
matched ticket signal (`resolvedBy: "ticket"`), keyed on `review.resolved` /
review approve with `resolvedAt >= requestedAt`. An open (unresolved) gate would
contribute nothing (not charged to run-end).

---

## 3. FR-3.5 — `f50ucz` fix-ticket lineage re-run

`compute_metrics(fixtures/f50ucz-dossier.json)` — reduced from
`s3://$ARTIFACT_BUCKET/workflows/wf_1788637257831_f50ucz/analysis/1788729954838-3ke1/dossier.json`.

```
fixTickets.count:            6
originTicketId non-null:     6/6
```

| ticketId | kind | originTicketId | round | originSource | roundSource |
|----------|------|----------------|-------|--------------|-------------|
| TEAM-4129 | codex_fix | TEAM-4123 | 1 | finder-in-flight | dispatch-count |
| TEAM-4130 | codex_fix | TEAM-4123 | 1 | finder-in-flight | dispatch-count |
| TEAM-4131 | codex_fix | TEAM-4123 | 1 | finder-in-flight | dispatch-count |
| TEAM-4155 | ship_fix  | TEAM-4126 | 1 | block            | block          |
| TEAM-4156 | ship_fix  | TEAM-4126 | 1 | block            | block          |
| TEAM-4157 | ci_fix    | TEAM-4125 | 1 | block            | block          |

- **6 entries**, each with `ticketId / kind / originTicketId / round /
  originSource / roundSource`.
- **4129 / 4130 / 4131 are round 1** (`round: 1`), origin `TEAM-4123`, derived
  `finder-in-flight` (origin) + `dispatch-count` (round).
- **`originTicketId` non-null 6/6** — every fix ticket's origin resolved.

---

## 4. FR-3.3 — `validateWorkflowDef` verdicts

Run against the real `.mjs` twin
(`lambda/orchestrator/workflow-def-validate.mjs`).

### 4a. Passing verdict on the bundled `src/config/workflows.json`

```
=== bundled workflows.json — validate each def (CD-registered) ===
  PASS  software-delivery  (warnings: 0)
  PASS  bug-fix            (warnings: 0)
  PASS  dead-code-sweep    (warnings: 0)
  PASS  marketing          (warnings: 0)
  PASS  sales              (warnings: 0)
  PASS  legal              (warnings: 0)
```

### 4b. Exact error — unconditioned Merge Approval (ship) gate on a NON-CD-registered def

`validateEffectiveDef({ …reviewGates:[{name:"Merge Approval", afterPhase:"ship", condition:"always"}] }, { cdRegistered: false })`:

```
THROWS: Workflow def "demo-repo" declares review gate "Merge Approval" (afterPhase="ship", condition="always") but the target repo is not CD-registered. A ship gate on a handoff run is unreachable — set condition:"cdRegistered" (auto-absent on handoff) or register the repo. See docs/agents-own-cd.md.
```

---

## 5. FR-3.6 — utilization clamp

`lambda/cost-report/metrics-time.test.mjs` (in `node --test lambda/cost-report`):

```
FR-3.6 utilization: busy ≫ active clamps to 1.0 and flags utilizationClamped
FR-3.6 utilization: busy < active is the unchanged ratio, unclamped
FR-3.6 utilization: a zero/absent active window is null (not a divide-by-zero)
FR-3.6 utilization: a sub-second active window uses the 1000 ms denominator floor
```

One-line eval of the exported `computeUtilization`:

```
computeUtilization(981.51*1000, 1000) => {"agentUtilization":1,"utilizationClamped":true}
computeUtilization(500, 2000)          => {"agentUtilization":0.25,"utilizationClamped":false}
computeUtilization(1234, 0)            => {"agentUtilization":null,"utilizationClamped":false}
computeUtilization(5, 10)              => {"agentUtilization":0.005,"utilizationClamped":false}
```

`computeUtilization(981.51*1000, 1000)` → `agentUtilization: 1`,
`utilizationClamped: true` — a busy window longer than the active window floors
the ratio at 1 and flags the clamp instead of reporting a >100% impossibility.
(`MIN_ACTIVE_MS = 1000` is module-private in `lambda/cost-report/index.mjs:1187`.)

---

## 6. FR-3.2 — review.resolved / human-wait keying

`lambda/cost-report/metrics-time.test.mjs`:

```
FR-3.2 humanWait: review.resolved (resolvedAt) wins over a later legacy review.approved
FR-3.2 humanWait: falls back to legacy review.approved when there is no review.resolved
FR-3.2 humanWait: an UNRESOLVED (open) gate contributes NO wait — not charged to run-end
```

`review.resolved` is emitted from the orchestrator at
`lambda/orchestrator/index.mjs:2038` (`buildReviewResolved` → `approved`) and
`:2059` (`rejected`); the handoff-skip resolution emits `skipped` (`:2328`).
Unit-tested by `lambda/orchestrator/review-resolved.test.mjs` (`buildReviewResolved`).

---

## 7. FR-3.3 — workflow.phase_change (intake + initial phase, exactly-once)

**CALL 6 F1 — one CAS-gated site covers EVERY creation path.** There are two
ways a run is created: the app start route (`src/app/api/workflow/start/
route.ts`, a direct `PutCommand` with NO event-publishing path) and bug
bootstrap. The earlier design emitted the opening `intake` row at a creation
site, so it only fired for bug-bootstrapped runs — app-started (ymo7dm-class)
runs never got an intake row. The single site common to BOTH paths is the first
agent dispatch, so the intake emit now lives there.

`announcePhaseTransition` (`lambda/orchestrator/index.mjs:477`, now exported)
emits, behind the ONE store CAS a run ever wins:

- `:495` — `workflow.phase_change {phase:"intake"}`, **anchored at
  `workflow.startedAt`** so the opening phase's duration measures from run start,
  not from whenever the first agent happened to dispatch;
- `:496` — `workflow.phase_change {phase:<initial agent phase>}` (stamped now);

both gated by `store.markInitialPhaseAnnounced(workflow.id, agentDef.phase)`
(`:490`). A genuine forward advance (`agentPhaseIdx > currentPhaseIdx`) emits a
single phase row + `advancePhase` at `:483`.

`publishEvent` (`:6166`) now honors a caller-supplied valid ISO
`detail.timestamp` (else stamps now); `deterministicEventId` keys off that SAME
stamped timestamp, so an anchored intake event still collapses both writers onto
one row under `EVENT_DEDUPE_MODE=enforce`.

The store method `markInitialPhaseAnnounced`
(`lambda/orchestrator/workflow-store.mjs:429`) claims the ONE initial-phase emit
with a top-level `attribute_not_exists(announcedInitialPhase)` CAS (same shape
as `markDeadSessionDetected`) — exactly-once across concurrent deliveries and
re-dispatches, since the run row is CREATED at its initial phase (there is no
ADVANCE to gate the emit on). The separate intake emit in `bootstrapBugWorkflow`
was REMOVED (`:5394` carries the explanatory comment).

Tests:
- `lambda/orchestrator/phase-change-lifecycle.test.mjs` drives the REAL exported
  `announcePhaseTransition` (AWS/store seams mocked): the intake→initial
  two-event sequence in order, intake `timestamp == workflow.startedAt`, a lost
  CAS emits nothing, once-only across a second dispatch, and a forward advance
  emits one row + calls `advancePhase`.
- `lambda/orchestrator/workflow-store.test.mjs` → `markInitialPhaseAnnounced`
  (top-level `attribute_not_exists(announcedInitialPhase)` CAS, win → true,
  CCFE → false, never throws).
- `deploy/workflow-manager/toolkit/test_metrics.py` → `IntakeAnchoredPhases`: a
  synthetic dossier with real intake+requirements phase_change rows produces NO
  `derived: "run-start"` reconstruction and its phases still sum to
  `totalDurationMs`.

**CALL 6 F2 — narrowed `bootstrapBugWorkflow` def-validate catch.** The def/
registry loads now sit OUTSIDE the try (a transient S3 blip propagates and is
retried, never laundered into a "your workflow is misconfigured" refusal); only
the validate is wrapped, via the pure `validateDefForCreation(framed,
cdRegistered)` helper (`lambda/orchestrator/workflow-def-validate.mjs:134`) that
returns `{ ok, message }` instead of throwing. Unit-tested in
`src/lib/workflow/workflow-def-validate-parity.test.ts` (`validateDefForCreation`
returns `{ok:true}` on a valid def and `{ok:false, message}` — the SAME message
`validateEffectiveDef` would throw — on an invalid one).

---

## 8. FR-3.4 — EVENT_DEDUPE_MODE default = enforce (garbage → enforce)

`normalizeEventDedupeMode(process.env.EVENT_DEDUPE_MODE, "enforce")` — only an
EXACT `"off"` disables; anything else (unset / `"shadow"` / `"on"` / garbage)
defaults to `enforce` and warns. Three producer default sites:

```
lambda/orchestrator/index.mjs:207          const EVENT_DEDUPE_MODE = normalizeEventDedupeMode(process.env.EVENT_DEDUPE_MODE, "enforce");
lambda/orchestrator/agent-invoker.mjs:46   const EVENT_DEDUPE_MODE = normalizeEventDedupeMode(process.env.EVENT_DEDUPE_MODE, "enforce");
lambda/orchestrator/events-writer.mjs:19   const EVENT_DEDUPE_MODE = normalizeEventDedupeMode(process.env.EVENT_DEDUPE_MODE, "enforce");
```

`lambda/orchestrator/events-writer.test.mjs`:

```
EVENT_DEDUPE_MODE — only an EXACT "off" keeps the pre-4120 base36 id
  mode "off" → the base36 monotonic id (rollback path)
  keeps the base36 ids monotonic within a warm container (the counter still advances)
EVENT_DEDUPE_MODE=enforce — the fan-out row collapses onto the publisher's
  uses exactly deterministicEventId(detail-type, detail) — the publisher's expression
  case/whitespace-insensitive: "  Enforce " still enforces
  agent.streaming keeps the base36 id even under enforce
  leaves every other attribute of the row exactly as off mode writes it
```

Consumer tolerance (dedupe over an already-collapsed table is a no-op):
`lambda/cost-report/metrics-time.test.mjs` →
`FR-3.4 tolerance: dedupeEvents leaves an already-collapsed table (one row per event) unchanged`.

---

## 9. FR-3.2 — provider parity contract tests

Both providers return a top-level `resolvedAt` ISO string on a Done transition;
each is pinned by a contract test that drives the REAL handler.

**Jira** (`lambda/agentcore-hub-jira/transition-resolution.test.mjs`, `node --test`):

```
FR-3.2 Jira: a Done transition sets resolution and returns a resolvedAt ISO string
FR-3.2 Jira: a 400 on the resolution body retries ONCE without it, logs, and still succeeds
FR-3.2 Jira: a non-400 error on the transition still throws (no silent swallow)
```

**DynamoDB** (`lambda/agentcore-hub-tickets/index.test.mjs`, vitest):

```
transition_ticket — resolvedAt on Done (TEAM-4167 D3 FR-3.2 contract)
  returns resolvedAt on the response AND writes it to the row on a real done transition
  does NOT stamp resolvedAt on a non-done transition
```

**Fake fidelity** (`lambda/workflow-output/index.test.mjs`, vitest) — the
tool-tools fake mirrors the real provider Done shape (carries `resolvedAt`):

```
report_completion — transition_ticket(done) invoke (TEAM-4167 D3 FR-3.2 contract)
  invokes Tickets___transition_ticket with transition_id done and completes
  the fake response mirrors the real provider Done shape (carries resolvedAt)
```
