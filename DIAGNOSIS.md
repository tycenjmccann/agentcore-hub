# TEAM-3352 Diagnosis — config-evals battery runner

Branch: `feature/TEAM-3352-backend-dev` (from `feature/TEAM-3033-config-evals-gate-eval-suite-must-pass-b` @ 3707521).
Scope: diagnosis only; no fixes applied, no Bedrock calls made.

---

## Finding 1 — Full-battery hang (42.5 min, zero output, no results file)

There is no single hard deadlock. The observed behavior is the compound of **(A) a
runner that is silent by construction until a case fully finishes**, **(B) judge
scoring calls that are unbounded in elapsed time**, **(C) throttling amplification
with a whole-case-restart retry**, and **(D) a broken retry classifier**. Together
they make a throttled run look exactly like a hang.

### A. Output is emitted only at case *completion*; results only at suite end

- The **only** per-case line is printed after the agent loop AND all 5 judge calls
  finish: `run-battery.mjs:310` (`console.log(\`  ${def.id}: ${status}…\`)`), plus the
  skip path at `run-battery.mjs:270`. There is **no case-start line, no attempt/turn
  progress, no heartbeat**. Before the pool starts, only headers print
  (`run-battery.mjs:262` spend ceiling, `run-battery.mjs:386` "Running N case(s)…").
- `battery-results.json` / `check-summary.md` are written only after **every** case
  returns: `run-battery.mjs:413-416`. Nothing incremental. So a run that is slow (or
  stuck in one judge call) produces zero artifacts, matching QA's observation.
- Consequence: worst-case *bounded* latency to the first output line is already
  ~2×`timeoutSeconds` (up to 600 s of agent loop, `agent-runner.mjs:140-143`) plus 5
  sequential judge calls — per wave. Three waves of that is 30+ minutes of legal
  silence even before anything is actually stuck.

### B. Judge scoring has no timeout and no abort signal (the truly unbounded path)

- The agent Converse loop has a per-attempt watchdog: `agent-runner.mjs:142-143`
  (`setTimeout(() => watchdog.abort(...), caseDef.timeoutSeconds * 1000)`), and the
  signal is threaded through `ledger.meter` → transport → `client.send(cmd,
  {abortSignal})` (`spend.mjs:67-73`, `scoring.mjs:86`).
- Judge scoring runs **after** `runCase` returns, entirely **outside** that watchdog
  (`run-battery.mjs:296-302`), and each judge call passes an **empty options object —
  no signal**: `scoring.mjs:197` (`await transport(request, {})`).
- The shared Bedrock client is constructed with **no HTTP timeouts**:
  `scoring.mjs:85` (`new BedrockRuntimeClient({})`). `@smithy/node-http-handler`
  defaults `requestTimeout`/`socketTimeout` to 0 (disabled). A stalled judge
  connection therefore blocks its pool slot **forever**, silently (see A). The judge
  retry loop (`scoring.mjs:194-204`) is bounded to 2 *attempts* but each attempt is
  unbounded in *time*.
- Volume: 12 cases × 5 evaluators = **60 judge calls**, all to the single
  `us.anthropic.claude-opus-4-7` judge (`scoring.mjs:17`) — a bigger and more
  throttle-prone target than the case models themselves.
- Related robustness gap: `buildJudgeRequest` at
  `scoring.mjs:190` sits **outside** the per-attempt try; if its
  `readFileSync(dependency_chain_evaluator.json)` (`scoring.mjs:132-134`) ever threw,
  the worker's rejection would reject `runPool`'s `Promise.all`
  (`run-battery.mjs:140-152`) and kill the whole run via `main().catch`
  (`run-battery.mjs:431-434`) — no per-case isolation of unexpected exceptions.

### C. Throttling amplification and whole-case-restart retry

- At pool size 4 (`run-battery.mjs:30`), up to 4 concurrent Bedrock conversations run
  at once: agent turns (up to `MAX_TURNS = 24` per case, `agent-runner.mjs:27`,
  maxTokens 4096) interleaved with other cases' judge calls. There is **no pacing, no
  jitter, no shared rate limiter** across the agent + judge call streams.
- Every Converse call additionally carries the AWS SDK's own *internal* standard
  retry (3 attempts with exponential backoff) invisibly — so one "turn" under
  throttling can take ~40-60 s while the runner shows nothing.
- The case-level retry **restarts the entire case from turn 0**
  (`agent-runner.mjs:140`, `171` `continue` → fresh `converseLoop`), discarding all
  completed turns and immediately re-injecting a full case's worth of request volume
  under exactly the throttled condition — with **zero backoff** between attempts.
  Same for the judge retry (`scoring.mjs:194-204`): attempt 2 fires immediately.
- The pool itself (`runPool`, `run-battery.mjs:140-152`) does not deadlock on
  ordinary failures, but a never-settling worker (B) permanently occupies a slot;
  4 stalled/slow slots = total silence.

### D. Retry classifier bug — throttling is *not* retried mid-case (secondary)

`agent-runner.mjs:170`:

```js
const retryable = isRetryableTransportError(err) &&
  (!producedOutput || /Throttling|5\d\d/.test(String(err?.$metadata?.httpStatusCode || err?.name)));
```

`ThrottlingException` carries `httpStatusCode: 400`, which is truthy, so the tested
string is `"400"` — the regex never sees the error *name*, and the
`/Throttling|5\d\d/` test fails. Once the case has produced any output, a throttled
turn is classified **non-retryable** and the case errors out, contradicting the FR-10
comment at `agent-runner.mjs:34-35`. (Conversely it means throttling *shortens* runs
mid-case; the 42-minute wall is dominated by B + C + the SDK's internal retries, not
by this outer loop.) Still a defect to fix: the intended throttle-retry semantics are
broken.

### Why one case takes 44 s but `--all` ran 42+ min

A single `--case` run is 1 conversation + 5 serial judge calls — negligible request
rate, no throttling. `--all` multiplies that by 4 concurrent slots × (≤24 turns + 5
judge calls) ≈ hundreds of Bedrock requests against both a case-model quota and one
opus judge quota. Throttling engages; each turn absorbs SDK-internal backoff; some
slots park in un-timeout-ed judge calls; and because nothing prints until a case
*fully* completes (A), the operator sees a 42-minute void and kills it — which also
discards all results (they are only written at the very end).

### Fix plan (Finding 1)

1. **Progress output**: print a line when a case *starts* (`executeAndScore` entry)
   and when it transitions agent-loop → scoring; include elapsed time and attempt.
   Optionally append per-case results to an incremental JSONL as they finish so a
   killed run still leaves evidence.
2. **End-to-end per-case deadline**: create one deadline covering run + score;
   thread the abort signal into every judge call (`scoring.mjs:197` →
   `transport(request, { signal })`, plumbed through `scoreCase`), and treat a fired
   deadline during scoring as `unscored` (gate FAIL, but the suite finishes).
3. **HTTP-level backstop**: construct the Bedrock client with explicit
   `requestHandler` timeouts (e.g. `connectionTimeout` ~5 s, `requestTimeout` ~120 s)
   and an explicit `maxAttempts`, so no single call can ever hang a slot even if a
   signal is dropped.
4. **Fix the classifier**: test name and status independently —
   `/Throttling|TooManyRequests/.test(err?.name)` OR `status >= 500` — instead of
   `String(status || name)`.
5. **Backoff + turn-level retry**: add bounded, jittered sleep before the case-level
   retry and the judge retry; prefer retrying the *failed turn* (messages array is
   already in hand) over restarting the whole case, or at minimum back off before the
   restart.
6. **Rate control**: a small global semaphore over all Bedrock calls (agent + judge
   combined), or serialize judge scoring behind a dedicated single-flight lane, so 4
   case loops can't stampede the judge quota.
7. **Whole-run watchdog**: an overall deadline (e.g. 2× the sum of case timeouts)
   that aborts outstanding work, marks remaining cases `timed_out`, and still writes
   `battery-results.json` with a FAIL verdict.

---

## Finding 2 — Persona-degradation blindness (degraded qa_verifier scores 90-100)

### Mechanism 1 (dominant): the degraded config channel is behaviorally redundant

The battery loads the working-tree system prompt (`agent-runner.mjs:74` via
`systemPromptPath`, `agent-runner.mjs:47-51`) — QA verified that. But the qa-* cases
give the agent the **same contract rules through two other channels that the
degradation never touched**:

- **The case `taskPrompt` restates the persona contract verbatim** — e.g.
  `cases/qa-verifier-regression-001.json:5`: "*Load your blueprint first… Deliver
  PASS or FAIL with evidence via WorkflowOutput___report_completion — the
  orchestrator owns ticket status, so never transition tickets yourself*". Same in
  `qa-build-verification-002.json:5` and `qa-design-mismatch-003.json:5`.
- **The blueprint is served from the working tree but is a separate, un-degraded
  file**: `registry.mjs:157-164` (`load_blueprint` reads
  `blueprints/qa-verifier.md`), which prescribes the whole verification process,
  evidence rules, and FAIL discipline.

So an inverted "*always PASS, never file tickets*" **system prompt** is outvoted by
an intact task prompt and an intact blueprint that both say the opposite. That is
exactly why the judge explanations report the degraded agent "*still delivered a
FAIL verdict with per-criterion evidence*" — the degraded channel did not change the
trajectory on this task. The battery was structurally incapable of detecting the
degradation because the artifact under test is redundant with the test's own inputs.

### Mechanism 2: evaluators never see the reference persona contract

Judge context is built in `scoring.mjs:106-123` (`renderContext`): task prompt,
conversation, trajectory, `expectedOutcomes`, expected trajectory, forbidden tools.
Two things are notable:

- **No system prompt of any kind reaches the judge** — neither the stock (reference)
  one nor the degraded one. `renderConversation` (`scoring.mjs:91-104`) iterates
  `runResult.messages`, and the system prompt is passed to Converse separately as
  `system` (`agent-runner.mjs:74`, `84-92`), never entering `messages`. So QA's
  tautology hypothesis ("judge shown the degraded prompt as instructions") is *not*
  the literal mechanism — but the outcome is equivalent: `Builtin.InstructionFollowing`
  (`scoring.mjs:41-44`, "explicit instructions in its task") is judged against the
  **case taskPrompt**, which is authored by the battery and never degrades. Every
  builtin evaluator therefore measures *generic task success*, not compliance with
  the persona contract in `deploy/runtime-agent/prompts/agentcore_hub_qa_verifier.txt`
  (evidence discipline, zero-issue PASS, BLOCKED-not-PASS, verification ledger…).
  None of those contract rules appear anywhere in a judge prompt.
- **`dependency_chain_compliance-VyBv7H2bCi` is a rubric mismatch on qa-* cases**:
  its instruction text (`deploy/evaluations/dependency_chain_evaluator.json`) scores
  design→dev→QA→CI *ticket blocking chains*. A QA-verification session that creates
  no ticket chain has nothing to violate, so the judge hands back 1.0 — a free 100
  that dilutes the case's score vector (observed: dependency_chain=100).

### Mechanism 3: floors can't catch it anyway (context, not a defect of QA's run)

The checked-in baseline is still bootstrap (`evals/battery/baseline.json`:
`"bootstrap": true, "cases": {}`), so today no floor exists at all — the gate fails
for the *unrelated* B1 reason. And as QA notes, even a real baseline with
`floorDelta: 10` (`thresholds.json`) cannot flag scores of 90-100 against a ~95-100
baseline mean. Floors only work if some evaluator's score actually moves — which
Mechanisms 1-2 prevent.

### Fix plan (Finding 2)

1. **Make the system prompt load-bearing in qa-\* cases**: strip the contract
   restatements from the `taskPrompt`s (blueprint-first, report_completion channel,
   never-transition) so the persona prompt is the *only* source of those rules; keep
   `expectedOutcomes` as the reference. A degraded prompt then produces a different
   trajectory. (Evaluator/floor knobs are base-ref-pinned in gate mode
   (`cases.mjs:263-289`), but `taskPrompt` is PR-head by design, so this is a
   content-only case edit.)
2. **Give judges the reference contract**: add a `## Reference: persona contract`
   section to `renderContext` (`scoring.mjs:106`) sourced from curated
   contract-critical rules in `referenceInputs` (or from the base-ref copy of the
   prompt file in gate mode — never the working-tree copy, which is the artifact
   under test). Add a dedicated `persona_contract_compliance` evaluator that scores
   the trajectory **against that reference**, independent of whatever prompt the
   agent actually ran with.
3. **Mechanically enforce `expectedToolTrajectory`**: today non-optional entries are
   only shown to the judge as prose (`scoring.mjs:114-117`); `runCase` enforces only
   `forbiddenTools` (`agent-runner.mjs:159-161`). Fail the case mechanically when a
   non-optional expected tool never appears — binary contract behaviors (blueprint
   loaded, verdict via report_completion, fix tickets filed) shouldn't depend on an
   LLM judge's mood.
4. **Drop `dependency_chain_compliance` from cases with no dependency-chain
   content** (`qa-verifier-regression-001`) and replace it with the persona-contract
   evaluator; keep it only on ticket-planning cases where its rubric applies.
5. **Add a canary case for the degradation class**: a qa-* variant whose fixtures
   contain an unresolved defect where "always PASS" behavior and correct behavior
   *diverge observably* (dev-output claiming green tests with no evidence), scored by
   the contract evaluator — i.e., re-run QA's experiment as a permanent case once
   1-2 land.
