# TEAM-4251 — acceptance items 1–7 (D1) + probes P-A/P-B/P-C

- **HEAD:** `5fa37288b94f8887611b2b101f57f263cc96dc98` (verified)
- **Branch:** `feature/TEAM-4251-qa-verifier`
- **Method:** every item = (1) `npx vitest run <path> --reporter=verbose`, (2) open the test and quote the assertion that proves the property, (3) where feasible an independent probe importing the real module against the vendored fixtures.
- **All named tests PASS.** Every FAILED/PARTIAL below is an *acceptance-wording* defect or a coverage gap, **not** a failing test.

| # | Verdict | Proving tests | Assertion quote | Probe result | Notes |
|---|---------|---------------|-----------------|--------------|-------|
| 1 | **VERIFIED** (impl stricter than wording) | `replay-dowtdh-verdict-gate.test.mjs` → "(a) enforce: TEAM-4181 gets no orchestrator.unblocked until TEAM-4183 completes" | `L725 expect(detailsOfType("orchestrator.unblocked").map((u) => u.ticketId)).toEqual([rvKey]);` · `L727 expect(h.state.board.get(QA).status).toBe("blocked");` | n/a (replay is the probe) | Wording implies TEAM-4181 unblocks **when** TEAM-4183 lands. It does not: after the fix completes the only unblocked ticket is the **re-verify**, and TEAM-4181 stays `blocked` until the reviewer's second look closes. Criterion satisfied, but it understates the hold. |
| 2 | **PARTIAL** | same file → "files a QA re-verify and a CI re-verify tied to TEAM-4183" | `L799 expect(qaRv.blocked_by).toEqual([FIX]);` ✅ · `L815 expect(ciRv.blocked_by).toEqual([]);` ❌ · `L819 expect(ciFiled).toMatchObject({ kind: "gate", reason: "stale-head", blockedBy: [] });` | n/a | **"each blocked on TEAM-4183" is false as written.** Only the QA re-verify carries that edge. The test *asserts the CI one is blocked on nothing*, by design (L812-814: TEAM-4183 is already done when completion is attempted, so the edge would be inert). The two also have different provenance — QA's from the cascade hold, CI's from the completion gate's stale-head remediation — and a **third** re-verify the wording never mentions (the code_reviewer's, L800-802, `blocked_by [TEAM-4183]`). The test's own title says "tied to", not "blocked on"; the title is honest, the acceptance text overstates. |
| 3 | **VERIFIED** | same file → "(c) enforce: workflow.complete count 0 and exactly ONE orchestrator.completion_blocked with heads.qa 933ea6f, heads.pr 001259d, reason head-divergence" | count is an exact one: `L842 expect(blocked).toHaveLength(1);` · `L837 expect(detailsOfType("workflow.complete")).toHaveLength(0);` · heads by value: `L844 …heads.qa.startsWith("933ea6f")` `L845 …heads.ci.startsWith("12e9ac6")` `L846 …heads.pr.startsWith("001259d")` `L847 …heads.qa === CODE_HEAD` | P-B reproduces the same refusal from the real `completion.mjs` | Both requested checks confirmed: `toHaveLength(1)` is an equality on `.length`, so a second emit fails; `heads` carries all three slots. Refusal corroborated 4 ways (`storeCompletions` `[]`, `finalized` `[]`, `phase !== "complete"`). **Nuance:** the fixture predates `tested_head`, so the replay *seeds* it — `L370/L374 out[QA].tested_head = CODE_HEAD` — justified in-comment by reading QA's prose. So `heads.qa = 933ea6f` is a test-author interpretation, not a field the real run emitted; and 933ea6f is in fact the **reviewer's** `commit_sha` (QA's own is 12e9ac6). Worth knowing given D1's "structured fields only" premise. |
| 4 | **PARTIAL** | `replay-c2uqki-sweep-noop.test.mjs` → "QA does not start until TEAM-4241 completes, and CI not until TEAM-4242 does"; `fix-before-verify.test.mjs` (46 tests, all pass) | `:1007 expect(h.state.board.get(QA).blockedBy).toContain(REVIEW_FIX);` (=TEAM-4241) · `:1018 expect(h.state.board.get(CI).blockedBy).toContain(QA_FIX);` (=TEAM-4242) | `probes/item-04-fix-before-verify.mjs`: real `selectFixBeforeVerifyTargets` over the real c2uqki board, snapshotted at each fix's `createdAt` → both return `["TEAM-4232","TEAM-4233"]` | Clauses 1–2 **VERIFIED**, and *stricter* than the wording: each fix blocks **both** verifiers (`:1006`/`:1016-1017` assert `[QA, CI]`), not one each. **Clause 3 (no mid-run head move 16fc41d→73f0056) is NOT ASSERTED anywhere** — `grep -rIln '16fc41d\|73f0056'` hits only `c2uqki-analysis.json` / `c2uqki-dossier.json`, as prose *about* the historical run. The property is derivable (probe 4.3: TEAM-4242 was still open at the historical 12:55:09Z CI dispatch, so the edge defers CI past the 73f0056 merge) but derivation is not coverage. Also: the tests assert the blocker **edge**, never that the held verifier is not **invoked**, though the harness captures every dispatch (`h.state.invokes`). |
| 5 | **PARTIAL** | `replay-f50ucz-ship-review-regression.test.mjs` (9 tests, all pass) | no-regression: `:726 expect(enforce).toEqual(off);` + non-vacuity `:728-730` · provenance: `:665 for (const id of [FIX1, FIX2, RECERT]) expect(fixtureTicket(id).spawnedBy ?? null).toBeNull();` | `probes/item-05-recert-origin.mjs`: TEAM-4157 `spawnedBy = null`, **0 of 21** f50ucz tickets carry a stamp | Clause 1 **VERIFIED** by full trace-equality between modes. **Clause 2 ("TEAM-4157 CI re-cert is orchestrator-created") FAILED as worded**, three ways: (a) TEAM-4157 is agent-filed and stays so — the named test asserts this in its own title ("whose CI re-cert **the agent filed itself**"); (b) on the actual converging r1→r2 path the orchestrator files nothing — `:769 expect(reverifyTickets()).toEqual([]);` — a re-verify appears only in a **counterfactual** r1 close the test builds by rewinding TEAM-4155/4156 to `in_progress` (`:836-845`); (c) when it does file one it is a **release-manager `ship_fix`** (`:853-861`, `GATE_OWNER_FIX_KIND` keys on the gate owner), never a CI re-cert. That assertion also needs `LIVE_REVERIFY=enforce` (`:848`) — an **eighth** flag, pre-existing, **default off** (`index.mjs:238,1336`), absent from item 16's list. Capability exists and is tested; the sentence describes it wrongly. |
| 6 | **VERIFIED** (one gap) | `test_metrics.py::GateVerdicts::test_dowtdh_gate_rounds_and_first_pass_yield` (6 passed); `node --test lambda/cost-report` → 21/21, incl. ✔ "enriched events: dowtdh's three gate verdicts → 2 reworks, 3 rounds, no first-pass yield" | py `:984 assertGreaterEqual(q["reworkRounds"], 1)` `:985 assertGreaterEqual(q["gateRounds"], 2)` `:990 assertEqual((reworkRounds, gateRounds), (2,3))` `:993 assertEqual(q["firstPassYield"], 0)` · js `:214-217 assert.equal(gates.reworkRounds, 2) / gateRounds, 3 / firstPassYield, 0 / source, "verdict-events"` | `probes/item-06-performance-mirror.mjs`: `quality.reworkRounds` and `quality.firstPassYield` agree on floor/direction/label across `BAND_KPIS` and `FLEET_KPIS`; `quality.gateRounds` is banded on **neither** | All three thresholds asserted, over the **real** dossier (`:980`), with exact values and per-ticket verdicts (`:998-1005`). JS side is a true equivalent but over **synthesized** `verdictSource:"declared"` events — it does not read the dossier (test says so itself, `:191-196`), so no single test covers dossier-prose → JS card. **`performance.ts` "mirrors" it only weakly:** it computes none of the three (probe 6.3e: no `computeGateRounds`, no `reworkRounds =`, no `firstPassYield =`) — its D1 change is the `gateMetricSource` type field (`:55`) plus KPI help text. **No parity test guards it**, against a repo convention of 7 `*-parity.test.ts` files in that same directory. The 8 key-set diffs are not a defect (Lambda card uses `cost.totalUsd`/`time.wallMs`, UI card `cost.total`/`time.wall` — two deliberate shapes); all `quality.*` keys match. |
| 7 | **VERIFIED under `enforce`; wording is unconditional and wrong** | `verified-head-completion.test.mjs` (40 tests, all pass) → "enforce + divergence: one completion_blocked, no workflow.complete, one re-verify per stale persona" | `:586 expect(blocked).toHaveLength(1);` · `:597 expect(detailsOfType("workflow.complete")).toHaveLength(0);` · `:596/:598/:599 storeCompletions/finalized/terminalClaims all length 0` · `:600 expect(wf.phase).toBe("review");` · `:590 heads: { qa: VERIFIED, ci: VERIFIED, pr: SHIPPED }` | P-B: seeding only the two missing `tested_head` fields flips the real module from `ok:true` to `reason:"head-divergence"`, `stalePersonas:[qa_verifier, ci_agent]` — matching `:605` exactly | **Under the shipped default (`shadow`) "never `workflow.complete`" is FALSE.** `:704-708` assert the same mismatch emits `completion_blocked` **and** `expect(detailsOfType("workflow.complete")).toHaveLength(1)` — the run closes anyway. That is shadow's documented intent, but the acceptance sentence states an unconditional guarantee that holds only at `VERIFIED_HEAD_COMPLETION=enforce`. Under `off` the gate is never called (`:722`) and nothing is emitted (`:724`). |

## Probes — all three reviewer findings REPRODUCE at this HEAD

| Probe | Reproduces? | Finding |
|---|---|---|
| **P-A** verdict ladder / enforce fail-open | **YES** | The ladder matches only two *labelled* forms. 6 of 7 requested summaries → `null`, including `"QA FAIL: 191 PASS / 8 FAIL, live Chromium"`, bare `"PASS"`, and `"CHANGES NEEDED — see findings"`. A `null` verdict under `enforce` **fail-opens** at `cascade.mjs:248`. |
| **P-B** `heads.pr` derivation | **YES** | `heads.pr` is the **latest dev/fix task `commitSha`**, not the real PR/integration head. No production caller supplies `opts.prHeadSha`. |
| **P-C** `evidence_keys` type | **YES** | Producer always writes a **string**; consumer guards on **`Array.isArray`** → dead branch. Blast radius **nil** today. |

### P-A detail

`deriveVerdict` matches exactly two shapes (`verdict-contract.mjs:143-166`):

```js
const VERDICT_LADDER = [
  new RegExp(`verdict\\s*:\\s*\\*{0,2}\\s*${VERDICT_ALT}\\b`, "i"),
  new RegExp(`round\\s*\\d+\\s*[—–-]+\\s*\\*{0,2}\\s*${VERDICT_ALT}\\b`, "i"),
];
```

Results: only `"Verdict: CHANGES NEEDED"` resolves. `"QA FAIL: …"`, `"CHANGES NEEDED — see findings"`, `"PASS"`, `"BLOCKED: no gateway"`, `"All checks passed"`, `""` all → `null`.

The fail-open branch, `lambda/orchestrator/cascade.mjs:243-248`:

```js
async function resolveVerdictHold(ticketId, workflow, siblings) {
  if (verdictMode === "off" || typeof verdictGate !== "function") return null;
  const info = await verdictGate({ ticketId, workflow, siblings });
  if (!info || info.isGatePersona !== true) return null;
  const verdict = info.verdict || null;
  if (!verdict || verdict === "PASS") return null;   // <-- :248 FAIL-OPEN
```

`null` is the **same value returned for `VERDICT_GATE=off`**, so the successor is dispatched. `evaluateGate` agrees: `{reason:"no-verdict", suppress:false, blockOn:[], needsGateReverify:false}`. There is no "hold on unknown" branch. The design is deliberate and documented in-file (`:241-244`: "what the contract recognizes is not the persona failed, and holding there would stall every run whose reviewer writes a summary the ladder cannot read") — but the consequence is that **a QA verifier who writes an unlabelled FAIL is treated exactly like a PASS under `enforce`**. dowtdh does not expose it only because its real summaries happen to be labelled (`"VERDICT: FAIL — …"`), which `test_metrics.py:1003` confirms (`verdictSource == "inferred"` for all three).

### P-B detail

`completion.mjs:699-748`:

```js
export function evaluateVerifiedHeads(children, agentTasks, opts = {}) {
  const heads = { qa: null, ci: null, pr: normalizeHeadSha(opts.prHeadSha) };
  ...
  const prGiven = heads.pr !== null;
  ...
    if (!prGiven && !GATE_PERSONA_IDS.has(assignee) && !isHuman(assignee)) {
      take("pr", headFrom(entry, ["commitSha", "commit_sha"]), when);   // :747
    }
```

Against the real dowtdh dossier the probe shows `heads.pr = 001259d` = TEAM-4183's `commitSha`, the newest non-gate done task. **No production caller passes `prHeadSha`** — `index.mjs:5258-5261` says so in a comment ("No prHeadSha is passed: heads.pr is the run's own latest recorded dev/fix commit"), and `src/app/api/workflow/[id]/complete/route.ts:702` calls `evaluateVerifiedHeads(tickets, agentTasks)` with no opts. `mergeCommit` is deliberately excluded (`:670-673`). So the gate compares verifier heads against **the run's own latest commit**, not against what the PR actually points at — sound for the stale-verifier case it targets, but it cannot detect a PR/integration head the run never recorded.

### P-C detail

Producer, `lambda/workflow-output/index.mjs:238-239` — **always a string**:

```js
const keys = typeof evidence_keys === "string" ? evidence_keys.trim() : Array.isArray(evidence_keys) ? evidence_keys.join(",") : "";
if (keys) report.evidence_keys = keys;
```

Consumer, `lambda/orchestrator/index.mjs:2751-2752` — **requires an array**:

```js
if (Array.isArray(record.evidence_keys) && record.evidence_keys.length > 0 && !entry?.evidence_keys) {
  fields.evidence_keys = record.evidence_keys;
}
```

They do **not** agree: harvested in **0 of 5** input shapes, including the only shape the runtime agent can send (`main.py` types the tool param `evidence_keys: str = ""`). Even an array input is `.join(",")`-flattened first, so the guard can never be satisfied by a workflow-output record. **Blast radius nil:** only three non-test sites exist, and nothing reads the harvested `agentTasks[t].evidence_keys`; `live-reverify.mjs:116` reads the S3 record directly through a shape-tolerant `splitCsv` that handles string *and* array. Latent bug / dead branch, not a live functional break.

## Cross-item observations

1. **Three acceptance sentences are factually wrong about the implementation** (items 2, 5, and 7-under-default). In all three the code is defensible and the *text* is the defect. Item 4's third clause is unproven rather than wrong.
2. **The `shadow` default matters to how these read.** Items 3 and 7 describe refusals that only happen under `enforce`. On a default deploy the gates observe and the runs still close.
3. **Minor doc drift:** `fix-before-verify.test.mjs:27` says "No c2uqki dossier is vendored on this branch" — it is vendored at this HEAD. The test's literal board objects still model it correctly (verified in probe 4.1); only the comment is stale.

## Files

| File | Contents |
|------|----------|
| `item-01.log` … `item-07.log` | per-item vitest run + assertion audit + probe output, each ending `EXIT=<code>` |
| `probe-p-a.log`, `probe-p-b.log`, `probe-p-c.log` | the three standalone probe runs |
| `probes/p-a-verdict-ladder.mjs` | real `verdict-contract.mjs`: ladder + enforce/null gate |
| `probes/p-b-heads-pr.mjs` | real `completion.mjs` + real dowtdh dossier: `heads.pr` derivation |
| `probes/p-c-evidence-keys.mjs`, `probes/p-c-splitcsv-shim.mjs` | producer/consumer shape agreement |
| `probes/item-04-fix-before-verify.mjs` | real `selectFixBeforeVerifyTargets` over the real c2uqki board |
| `probes/item-05-recert-origin.mjs` | TEAM-4157 provenance + `GATE_OWNER_FIX_KIND` |
| `probes/item-06-performance-mirror.mjs` | `BAND_KPIS` vs `FLEET_KPIS` parity check |
| `item-08.log` | **checkpoint only** — vitest run for item 8; audit belongs to HALF 2 |
| `item-14.log` | complete (carried from the earlier session; HALF 2 item) |

**HALF 2 remaining:** items 8–13, 16, 17 (18/19 are references to log 10 / log 06), then `11-acceptance-matrix.md`.
