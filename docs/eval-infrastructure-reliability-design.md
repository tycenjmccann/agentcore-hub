# Eval Infrastructure Reliability — Design (TEAM-3366)

Status: PROPOSED (design only — no production code changes in this PR).
Evidence base: investigation of 2026-08-27 (`.cloud-code/artifacts/evidence.md`, session-local);
all code claims below carry file:line anchors into this repo @ 6ce7ca0.

Problem: the agent eval pipeline is 89.3% broken (12/112 attempts scored). Failure mix:

- **38.4% — ValidationException** `none of the spans contain the required agent invocation
  (gen_ai.operation.name=invoke_agent)` on sessions for frontend_dev, backend_designer (×3),
  bug_fixer — while backend_dev and ci_agent sessions DO carry the span. → **P0-A**
- **50.9% — ThrottlingException** on judge-model (Opus 4.7) calls, with the same request ID
  appearing 8–10× as separate result records. → **P0-B**
- Plus two latent defects found during investigation: the custom dependency-chain evaluator
  scoring roles it was never scoped to (**P1**) and throttled sessions being invisible to the
  only existing alarm (**P2**).

---

## 1. P0-A — Telemetry root cause and fix (invoke_agent span loss)

### 1.1 Root cause (evidence-backed)

**Verdict: hypothesis (c) — the invoke_agent span is CREATED but NEVER EXPORTED, because it
only ends when the whole agent loop ends, and long detached/remote-coding runs are
interrupted before the finally-flush.** The span-loss point, per failing role, is the same
mechanism with role-specific exposure:

Chain of evidence (all in-repo, confirmed):

1. The Strands SDK emits exactly one `invoke_agent {agent_name}` span **around the whole
   model loop**; main.py opens no wrapper span and relies on this contract
   (`deploy/runtime-agent/tests/test_telemetry.py:1-16`; `deploy/runtime-agent/main.py:2304-2306`).
   A span is only exportable once it has **ended** — BatchSpanProcessor never exports live
   spans.
2. Workflow personas run **detached**: the invocation acks in seconds and the real loop runs
   as a background asyncio task (`main.py:2044-2098`, commit c949b8b) — so the invoke_agent
   span now covers the entire persona run.
3. Remote coding turns keep that loop alive for up to **5400s each** (poll budget
   `REMOTE_CODING_TURN_BUDGET_S=2700` with heartbeat extension to a `2×` hard stop,
   `main.py:501-504`, `main.py:323-324`), and a persona chains several turns → the
   invoke_agent span stays **open for hours**.
4. Child spans (Bedrock model calls, botocore poll calls, tool spans from the
   `opentelemetry-instrument` wrapper, `deploy/runtime-agent/Dockerfile:25`) end continuously
   and export on the BatchSpanProcessor's ~5s cadence throughout the run. So an interrupted
   session **has spans — just not the required root**. That produces precisely
   `ValidationException: none of the spans contain the required agent invocation`, not
   "no data for session".
5. The existing `force_flush` in the handler's `finally` (`main.py:2403-2417`) only runs when
   the loop actually finishes. Any hard interruption — microVM recycle/freeze, fleet
   redeploy, crash, platform reap, or (for pre-detach sessions) the ~15-min idle kill
   documented at `main.py:2049-2059` — loses the un-ended span permanently.

**Per-role span-loss point.** frontend_dev, backend_designer and bug_fixer are
delegation-heavy roles whose runs sit for long stretches inside `_remote_coding_turn`'s
20s-cadence poll loop (`main.py:672-770`); their invoke_agent spans are open the longest and
are the ones lost when the microVM is interrupted mid-poll. backend_dev and ci_agent sessions
that scored had loops short enough to complete, so the SDK span ended and the finally-flush
delivered it. Remote-coding membership (`REMOTE_CODING_PERSONAS`) is a deploy-time env var,
empty in the repo (`deploy/config.sh:71`, `main.py:307-311`) — verify live membership per
V-1 below.

**Hypothesis (a) — `cc-{uuid}` delegation fragmentation: REAL but SECONDARY.** Each remote
coding session gets a NEW AgentCore runtimeSessionId `cc-{uuid4().hex}` (`main.py:679-680`),
and the coding runtime is itself OTel-instrumented — so all coding-work telemetry lands under
the `cc-…` session, invisible to the evaluated persona session. This degrades evaluator
context but **cannot remove the persona's own invoke_agent span**, so it does not explain the
ValidationException. No fix required for P0-A; noted for a future context-propagation ticket.

**Hypothesis (b) — instrumented-path bypass / missing session.id: REJECTED.** The init block
correctly attaches nothing under ADOT and only falls back to StrandsTelemetry bare-python
(`main.py:177-227`), the Agent carries `session.id` in `trace_attributes`
(`main.py:2307-2314`), baggage is stamped (`main.py:2152-2159`), and all of this is
test-pinned (`test_telemetry_init.py:52-72`, `tests/test_telemetry.py:82-93`). A bypass would
fail uniformly across every role on the shared image — it cannot select
frontend_dev/backend_designer/bug_fixer while sparing backend_dev/ci_agent.

### 1.2 VERIFICATION steps (IAM-blocked during investigation — run before implementation sign-off, not open questions)

The investigating session ran under the minimal `agentcore-hub-coding-runtime-role` (logs,
S3, DDB, X-Ray, service-quotas, agentcore-control all denied — see evidence.md §0). An
operator with hub-admin credentials confirms the verdict with:

- **V-1 — remote-coding membership per runtime:**
  ```bash
  for rt in $(aws bedrock-agentcore-control list-agent-runtimes \
        --query 'agentRuntimes[].agentRuntimeId' --output text); do
    aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$rt" \
      --query '{id:agentRuntimeId, env:agentRuntimeArtifact.containerConfiguration.environmentVariables}'
  done
  ```
  Expected: failing roles listed in `REMOTE_CODING_PERSONAS` (or `"all"`); ci_agent runs short.
- **V-2 — span inventory for one failing session per role** (CloudWatch Transaction Search /
  `aws/spans`; take session ids from the ValidationException result records):
  ```
  fields @timestamp, name, attributes.`gen_ai.operation.name` as op,
         attributes.`session.id` as sid, traceId, durationNano
  | filter sid = '<failing session id>'
  | sort @timestamp asc
  ```
  Expected signature for hypothesis (c): child spans present (model calls / botocore polls)
  under the session's trace, **no** `invoke_agent`; the runtime log stream
  (`/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT`) stops without the
  `"[<agent>] Invocation complete"` line (`main.py:2392`). Compare a healthy ci_agent
  session: full trace ending in `invoke_agent <agent_id>`.
- **V-3 — init-path sanity** (rules out (b) conclusively): the same runtime log group must
  show `"telemetry: ADOT-managed TracerProvider active"` (`main.py:203-207`), not the
  StrandsTelemetry fallback line.

### 1.3 Fix: session-anchor invoke_agent span (primary design)

**Chosen mechanism: emit a short-lived, spec-compliant `invoke_agent` "session anchor" span
at handler entry — ended immediately and force-flushed before the long loop starts.** This
guarantees every session carries ≥1 exported span with `gen_ai.operation.name=invoke_agent`
and the correct `session.id` within seconds of invocation start, regardless of how or when
the run later dies. When the run completes normally, the SDK's real invoke_agent span exports
too (sessions then have 2 — see Risks §7).

Why this and not the alternatives:

| Option | Verdict | Reason |
|---|---|---|
| **Anchor span at entry (chosen)** | ✅ | Only design that survives *any* interruption: the span is ended+flushed before the loop begins. Small (~30 lines), fail-open, no SDK changes. |
| Periodic `force_flush` during remote-coding polls | ❌ as primary | `force_flush` only exports **ended** spans; the SDK's invoke_agent span is still open during polls, so periodic flushing cannot deliver it. Child spans already export on the 5s batch cadence, so it adds nearly nothing. Rejected. |
| End/restart the SDK span per turn | ❌ | Requires forking strands' Tracer; violates the pinned contract in `tests/test_telemetry.py`. |
| Move long polls out of the agent loop (architectural) | ❌ for P0 | Correct long-term direction but a multi-week change to the delegation model; doesn't meet P0 urgency. |

**Code sketch** — new helper + one call site. Insertion point: define the helper next to
`_publish_agent_started` (i.e. above `main.py:1846`); call it inside `_run_agent_invocation`
immediately after the baggage stamping block (`main.py:2152-2159`), i.e. between current
lines 2159 and 2161 (`try:`):

```python
def _emit_session_anchor_span(agent_id: str, session_id: str | None,
                              workflow_id: str, ticket_id: str) -> None:
    """TEAM-3366 P0-A: guarantee >=1 EXPORTED invoke_agent span per session.

    The SDK's invoke_agent span only ends when the whole agent loop ends
    (tests/test_telemetry.py contract); detached runs with remote-coding turns
    keep that loop open for hours, and any microVM interruption loses the
    un-ended span -> online evals fail with "none of the spans contain the
    required agent invocation". This anchor span ends immediately and is
    flushed synchronously, so the session is evaluable even if the run dies.
    Fail-open per R1.4 — telemetry must never break the invocation.
    """
    try:
        from opentelemetry import trace as _t

        tracer = _t.get_tracer("agentcore-hub-pipeline-agent")
        attrs = {k: v for k, v in {
            "gen_ai.operation.name": "invoke_agent",
            "gen_ai.agent.name": agent_id,
            "gen_ai.agent.id": agent_id,
            "session.id": session_id,
            "workflow.id": workflow_id,
            "ticket.id": ticket_id,
            "agentcore.hub.anchor": True,   # marks it as the synthetic anchor
        }.items() if v}
        with tracer.start_as_current_span(f"invoke_agent {agent_id}",
                                          kind=_t.SpanKind.INTERNAL,
                                          attributes=attrs):
            pass  # ends immediately — exportable from this moment on

        provider = _t.get_tracer_provider()
        if hasattr(provider, "force_flush"):
            provider.force_flush(5000)  # deliver NOW, before the long loop
    except Exception:  # noqa: BLE001 — R1.4: fail-open, never break the run
        logger.warning("telemetry: session anchor span failed (non-fatal)",
                       exc_info=True)
```

Call site (after `main.py:2159`, before the `try:` at 2161):

```python
    _emit_session_anchor_span(agent_id, getattr(context, "session_id", None),
                              workflow_id, _CURRENT_TICKET_ID)
```

Design notes / constraints honored:

- **Fail-open:** the whole helper body is one `try/except Exception` that logs and returns —
  identical posture to the baggage block (`main.py:2158-2159`) and the finally-flush
  (`main.py:2416-2417`). A broken exporter can never abort the invocation.
- **No competing TracerProvider under ADOT:** the helper only calls
  `get_tracer()`/`get_tracer_provider()` on whatever provider is already global; it never
  constructs a provider or exporter, so
  `test_telemetry_init.py::test_adot_provider_attaches_nothing` remains green by
  construction. Under bare `python main.py` with no SDK provider, `get_tracer` returns a
  no-op tracer and the anchor is a silent no-op — acceptable (that path has no eval pipeline).
- **Blocking budget:** the direct `force_flush(5000)` call blocks the handler ≤5s **once, at
  session start** — before any model call, so there is nothing to starve. This is a
  deliberate difference from the end-of-run flush, which uses `asyncio.to_thread`
  (`main.py:2415`) because it runs after streaming. If review prefers uniformity, the call
  site (already `async`) may instead `await asyncio.to_thread(provider.force_flush, 5000)`;
  either satisfies the non-blocking constraint (5s cap, fail-open). The existing
  finally-flush at `main.py:2403-2417` stays unchanged — it still delivers the SDK's real
  span for runs that complete.
- The `agentcore.hub.anchor` attribute lets evaluators/dashboards (and the P1 role guard)
  distinguish the synthetic anchor from the SDK's full-content span later if needed.

### 1.4 Required regression tests (must FAIL before the fix, pass after)

In `deploy/runtime-agent/tests/test_telemetry.py` (uses the existing `span_exporter`
in-memory fixture from `tests/conftest.py`):

- `test_anchor_span_exported_without_agent_loop` — call
  `_emit_session_anchor_span("test_agent", "sess-123", "wf-1", "T-1")` with **no** Agent
  invocation at all; assert the exporter contains exactly one ENDED span with
  `gen_ai.operation.name == "invoke_agent"`, name `invoke_agent test_agent`,
  `session.id == "sess-123"`, and `agentcore.hub.anchor == True`. Pre-fix this fails at
  import (helper doesn't exist) — the executable statement of the bug: today nothing exports
  an invoke_agent span unless the loop finishes.
- `test_interrupted_agent_loop_still_yields_invoke_agent_span` — emit the anchor, then start
  an Agent run against a FakeModel whose `stream` blocks forever; cancel the task
  (simulated microVM death); assert the exporter still holds ≥1 invoke_agent span carrying
  the session.id. Fails pre-fix (zero invoke_agent spans after cancellation).
- `test_anchor_plus_completed_run_yields_both_spans` — anchor + a normal FakeModel run;
  assert two invoke_agent spans, distinguishable by `agentcore.hub.anchor` (documents the
  two-span session shape deliberately).

In `deploy/runtime-agent/test_telemetry_init.py` (exec-block style):

- `test_anchor_span_fail_open` — patch `opentelemetry.trace.get_tracer` to raise; assert
  `_emit_session_anchor_span(...)` returns normally and logs one warning (mirrors
  `test_init_failure_swallowed`, lines 86-101).
- `test_adot_provider_attaches_nothing` (existing, lines 52-61) — unchanged and must remain
  green: the constraint that the fix adds no provider under ADOT.

---

## 2. P0-B — Judge-model throttling + duplicate result records

### 2.1 CODE (ours) vs OPS (AWS) split

| # | Item | Side | What | Where |
|---|------|------|------|-------|
| 1 | Result-record dedup | **CODE** | Drop duplicate evaluator result records before classification/aggregation | `lambda/eval-packager/index.mjs` (§2.2) |
| 2 | Improver invoke retry | **CODE** | Exponential backoff, full jitter, deadline-aware | `lambda/eval-packager/index.mjs:579-683` (§2.3) |
| 3 | Judge-call volume reduction | **CODE (config)** | Fewer evaluators/config + tiered sampling | `deploy/evaluations/setup-evaluations.sh` (§2.4) |
| 4 | Quota increase | **OPS** | Bedrock on-demand InvokeModel RPM for Opus 4.7 | Runbook (§2.5) |
| 5 | Eval-config rate knob | **VERIFY** | `agentcore eval online create --help` — check for any concurrency/judge-throughput flag before assuming none exists; the repo passes only `--agent-id/--name/--sampling-rate/-e/--description` (`setup-evaluations.sh:161-167`) | Ops verification step |

### 2.2 CODE: dedup in eval-packager

Today `extractSessionData` (`index.mjs:196-246`) extracts **no request id** — each of the
8–10 retry records per throttled judge call becomes a separate row — and
`aggregateScoresToDdb` (`index.mjs:348-411`) then double-counts them into score weights
(lines 366-369) and session counts (line 401).

**Primary dedup key: the per-record request id.** Ranked candidates from evidence.md §B1
(the investigating role could not read a real record — confirm the attribute name first):

1. OTEL log-record envelope `traceId` + `spanId` (every record carries them; duplicates of
   one evaluation attempt share the evaluated span's ids),
2. `attributes['aws.request_id']`,
3. `attributes['gen_ai.response.id']`.

**VERIFICATION query** (Logs Insights over
`/aws/bedrock-agentcore/evaluations/results/*`, last 72h) — run once, then hard-code the
confirmed attribute name:

```
fields attributes.`session.id` as sid, attributes.`gen_ai.evaluation.name` as ev, @message
| filter ispresent(attributes.`error.type`)
| stats count(*) as n by sid, ev
| filter n > 1 | sort n desc
```
then inspect one duplicated group's raw `@message` for the shared id field (check both
`attributes.*` and the envelope).

**Fallback content key** (when the request-id attribute is absent on a record):
`` `${sessionId}|${evaluatorName}|${evaluationName ?? ''}|${score}|${timestamp}` ``.
Timestamp inclusion keeps two genuinely distinct same-score evaluations apart; identical
retry writes share all five fields.

**Placement: BEFORE `classifySessions` and BEFORE `aggregateScoresToDdb`.** Concretely:

- Add a `dedupeResults(records)` export next to `extractSessionData`; apply it to
  `sessionData.evaluatorResults` inside `extractSessionData` before returning
  (`index.mjs:239-245`), so the handler's `classifySessions(sessionData)` call
  (`index.mjs:129`) and the buffered batch both see deduped rows. Track the dropped count on
  the returned object (`sessionData.duplicatesDropped`) for the P2 metric.
- Refactor `aggregateScoresToDdb` to consume the already-deduped
  `sessionData.evaluatorResults` instead of re-parsing `parsed.logEvents` itself
  (today it independently re-reads raw events at `index.mjs:353-372` — that second parse is
  where duplicates re-enter; removing it is part of this fix).

**Cross-delivery dedup — decision rule and design.** Duplicates *within* one CloudWatch Logs
delivery are collapsed by the in-memory pass above. Whether duplicates also span deliveries
is unknown (IAM-blocked); the decision rule is:

> Ship the in-memory dedup + `EvalDuplicateResultCount` metric first. After 1 week, run the
> verification query grouped by delivery (`logStream`): if duplicate groups with the same
> request id appear across distinct deliveries at a non-trivial rate (>1% of records),
> enable the cross-delivery seen-set; otherwise skip it.

Seen-set design (specified now so the follow-up is mechanical): reuse-nothing table
`agentcore-hub-eval-seen` — PK `dedupKey` (S), attribute `expiresAt` (N, DynamoDB TTL,
now + 24h; eval retries never span a day). Writer does `PutItem` with
`ConditionExpression: attribute_not_exists(dedupKey)`;
`ConditionalCheckFailedException` ⇒ duplicate ⇒ drop the record. Cost: one conditional
write per surviving record; fail-open (DDB error ⇒ treat record as fresh — prefer
double-count over data loss, matching the non-fatal posture at `index.mjs:407-410`).

### 2.3 CODE: `invokeImprover` retry (index.mjs:579-683)

Today: single attempt, 240s timeout (`index.mjs:621`), failure loses the PRD
(`flushBuffer` catch, `index.mjs:470-477`). Add retry with **exponential backoff, full
jitter**:

```
sleep = random(0, min(cap, base * 2 ** attempt))    // base = 2s, cap = 60s, max 3 attempts
```

- Retry **only** retryable failures: throttle (`ThrottlingException` / HTTP 429), 5xx, and
  connection resets — never 4xx validation errors.
- **Deadline-aware, bounded under the Lambda's 600s timeout**
  (`deploy/continuous-improvement/deploy.sh:91` — 600s chosen there to clear one 240s invoke
  plus overflow work): keep a total budget `RETRY_DEADLINE = 520s` from handler-relative
  start of the first attempt; before each retry, if `elapsed + 240s > 520s`, stop and throw.
  Worst case: attempt 1 times out at 240s → sleep ≤2s → attempt 2 times out at ~482s →
  budget check blocks attempt 3 → total ≤ ~482s, leaving >100s for the rest of the flush.
  Fast throttle failures (the common case) allow all 3 attempts within ~10s of sleep total.

### 2.4 CODE (config): load reduction in setup-evaluations.sh

**Fan-out math.** Today (`setup-evaluations.sh:140-167`, `eval-config-ids.json:5-16`):
10 LLM-judge evaluators per config — 2 TOOL_CALL + 6 TRACE + 1 SESSION built-ins, plus 1
(custom SESSION or Conciseness TRACE) — at `--sampling-rate 100.0`, judge
`us.anthropic.claude-opus-4-7` (`dependency_chain_evaluator.json:5`).

Judge calls per evaluated session `F = 2·T + (6..7)·R + (1..2)` where `T` = tool calls, `R` =
traces in the session. With the working assumption `T = R = 20` (**verify** with
`stats count(*) by ev, role` per evidence.md §B1.4 before finalizing numbers):

```
Baseline:  F  = 2·20 + 6·20 + 2 ≈ 162 judge calls / session
Fleet:     15 repo agents (deploy-fleet.sh:97-113; live ≥16 with bug_fixer — reconcile §3.3)
Sessions:  ~2 workflow runs/hour × 15 personas = 30 sessions/hour
Volume:    30 × 162 ≈ 4,860 calls/hour ≈ 81 RPM sustained
Burst:     one session completing fires ~162 judge calls in <1 min ⇒ ≥162 RPM instantaneous
Quota:     Opus on-demand InvokeModel RPM default is commonly 50 in unraised accounts (VERIFY §2.5)
           ⇒ both sustained (81) and burst (162+) exceed it ⇒ observed mass throttling.
```

**Prescribed values:**

1. **Evaluator count 10 → 5 per config** (edit the `eval_args` block,
   `setup-evaluations.sh:140-155`):
   - Standard agents: `Builtin.ToolSelectionAccuracy` (TOOL_CALL),
     `Builtin.InstructionFollowing`, `Builtin.Correctness`, `Builtin.Helpfulness` (TRACE),
     `Builtin.GoalSuccessRate` (SESSION).
   - requirements_analyst (sole custom-evaluator agent post-P1): the same minus
     `Builtin.Helpfulness`, plus `dependency_chain_compliance_online-mbLh2kEFhw` (SESSION).
   - Dropped: ToolParameterAccuracy, Coherence, Faithfulness, ResponseRelevance,
     Conciseness — the most overlapping/judge-heavy of the ten.
2. **Tiered sampling** (replace the constant at `setup-evaluations.sh:164`): `100.0` for the
   pipeline gate roles (requirements_analyst, qa_verifier, ci_agent), `25.0` for all other
   agents.

**Post-fix arithmetic:**

```
F' = 1·20 + 3·20 + 1 ≈ 81 judge calls / session          (50% cut per session)
Evaluated sessions/hour ≈ 30 × (3·1.0 + 12·0.25)/15 = 30 × 0.40 = 12
Volume ≈ 12 × 81 ≈ 972 calls/hour ≈ 16 RPM sustained     (5× cut overall)
Worst burst ≈ 2 simultaneous session completions ≈ 162 RPM for <1 min
Target quota 200 RPM (§2.5) ⇒ 12× headroom sustained, ~1.25× on the worst burst —
with SDK retry-with-backoff absorbing residual burst spikes.
```

**Verification step (do not assume):** before implementation, run
`agentcore eval online create --help` and record whether ANY concurrency/rate/judge-throughput
knob exists; if one does, prefer it over (or in addition to) sampling cuts and update the
arithmetic.

### 2.5 OPS runbook: Bedrock quota increase

Documented, not coded. **Lives in `docs/orchestration-tracing-guide.md`** — add a section
"Eval judge throttling (quota)" after "Common Failure Patterns" (that doc's §"Log Locations
Summary"/§"Common Failure Patterns" is where operators already look).

- Identify the exact quota (names vary by model family/account — grep, don't guess):
  ```bash
  aws service-quotas list-service-quotas --service-code bedrock --output json \
   | jq -r '.Quotas[] | select(.QuotaName|test("Opus";"i"))
            | [.QuotaCode, .QuotaName, (.Value|tostring)] | @tsv'
  ```
  Expected name pattern: **"On-demand InvokeModel requests per minute for Anthropic Claude
  Opus 4.7"** (record the matching `QuotaCode` and current `Value`).
- Request increase to **200 requests/minute** (derived in §2.4: covers 16 RPM sustained and
  ~162 RPM worst-case burst with headroom):
  ```bash
  aws service-quotas request-service-quota-increase \
    --service-code bedrock --quota-code <QuotaCode from above> --desired-value 200
  ```
- Also check whether online evaluations draw from the same on-demand pool as fleet model
  calls (fleet overrides include opus-4-6/4-7, `main.py:2177-2183`); if shared, judge
  traffic competes with production and the target should be re-derived with fleet RPM added.

### 2.6 Required unit tests — `lambda/eval-packager/index.test.mjs`

- `duplicate records with same request id collapse to one` — feed `extractSessionData` a
  delivery with 9 identical records sharing the confirmed request-id attribute; assert
  `evaluatorResults.length === 1` and `duplicatesDropped === 8`.
- `distinct records are preserved` — same session, different evaluators/scores/request ids;
  assert nothing dropped.
- `missing request id falls back to content key` — two identical rows with no request-id
  attribute collapse; two rows differing only in `timestamp` do NOT collapse.
- `aggregation totals unchanged by injected duplicates` — run the (refactored)
  aggregation input path twice: once on a clean delivery, once with each record duplicated
  8×; assert identical `sum`/`count` deltas and session counts.
- `classifySessions sees deduped input` — a throttled session (all-null + errorType) with
  8 duplicate records still classifies as one `error` session, `total === 1`.

---

## 3. P1 — Evaluator role scoping (dependency_chain_compliance_online)

Live behavior shows the custom evaluator scoring backend_dev and bug_fixer. The repo has
**never** granted it to those roles — `TICKET_AGENTS` has been
`requirements_analyst qa_verifier ci_agent` since the initial commit
(`setup-evaluations.sh:77`, confirmed via `git log -S dependency_chain`). This is account
drift. Fix at both layers so config drift alone can never poison results again.

### 3.1 Config layer

- **Shrink `TICKET_AGENTS` (`setup-evaluations.sh:77`) to
  `agentcore_hub_requirements_analyst` only.** It is the one role whose core deliverable is
  creating the ticket dependency graph; qa_verifier/ci_agent reassign rather than construct
  chains and have produced rubric-mismatch noise.
- **Orchestrator scoping is NOT applicable** — stating explicitly because the evaluator
  rubric describes orchestration behavior: the orchestrator is a **Lambda**
  (`lambda/orchestrator/index.mjs`), not an AgentCore runtime; it has no online eval config
  and does not appear in `eval-config-ids.json`. There is nothing to scope there.
- Out-of-scope roles keep the existing `Builtin.Conciseness` fallback branch
  (`setup-evaluations.sh:151-155`) — no structural change, they just fall into the `else`
  (note: post-§2.4 the fallback slot shifts to the trimmed 5-evaluator list;
  requirements_analyst swaps one TRACE evaluator for the custom SESSION evaluator).
- **Update `deploy/evaluations/eval-config-ids.json`** `notes.dependency_chain_agents`
  (line 42) to name requirements_analyst only, and refresh the `configs` snapshot when
  re-applied (it currently also omits code_reviewer while `deploy-fleet.sh:97-113` deploys
  15 agents — normalize the 14-vs-15 inconsistency, incl. `DEPLOY.md:117`'s "14").

### 3.2 Processing guard in eval-packager (belt-and-suspenders)

Even with correct configs, drift can recur. Add a guard in `index.mjs` that excludes
`dependency_chain_compliance_online*` results for out-of-scope roles from **both**
classification input and aggregation.

**Role parser** — from the exact orchestrator session-id format
(`lambda/orchestrator/index.mjs:1466-1468`):

```js
const sessionId = `${ticketPrefix}${workflow.id}-${agentDef.agentId}-${Date.now()}`;
// ticketPrefix = `${task.ticketId}_` when a running task has a ticketId, else ""
// workflow.id  = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`  (index.mjs:1829)
```

```js
// Role = agent id anchored between the last '-'-delimited fields; agent ids
// contain '_' but never '-', and the id always precedes the trailing 13-digit ms
// timestamp, so this parse is unambiguous.
const ROLE_RE = /-(agentcore_hub_[a-z0-9_]+)-\d{13}$/;
// Optional leading parts (validation only, not needed for role extraction):
//   /^(?:([A-Z][A-Z0-9]+-\d+)_)?(wf_\d{13}_[a-z0-9]{6})-/   → ticketId?, workflowId
const DEP_CHAIN_ROLES = new Set(['agentcore_hub_requirements_analyst']);
const DEP_CHAIN_RE = /^dependency_chain_compliance/;

function roleFromSessionId(sid) {
  const m = typeof sid === 'string' ? sid.match(ROLE_RE) : null;
  return m ? m[1] : null;   // null: non-workflow session (si-…, cc-…) or malformed
}

function isOutOfScopeDepChain(row) {
  if (!DEP_CHAIN_RE.test(row.evaluatorName || '')) return false; // other evaluators: never touched
  const role = roleFromSessionId(row.sessionId);
  if (role === null) return false;  // FAIL-OPEN: unparseable session id → keep the record
  return !DEP_CHAIN_ROLES.has(role);
}
```

Placement: filter `evaluatorResults` with `isOutOfScopeDepChain` right after dedup (§2.2),
so `classifySessions` (`index.mjs:129`) and the aggregation input both see the filtered set;
count exclusions for logging. Fail-open rules: malformed/absent session ids never cause a
drop; records for **other** evaluators are never affected regardless of role parse outcome
(non-workflow formats that legitimately appear: `si-<agentId>-<ms>` padded to ≥33 chars,
`index.mjs:596`; coding sessions `cc-<32 hex>`, `main.py:680`).

### 3.3 Repo-vs-account reconciliation (ops step for the CD ticket)

`agentcore eval online list` is the authoritative live inventory. Reconciliation + re-apply:

1. `agentcore eval online list` — dump every config: name, agent id, evaluator list,
   sampling rate. Diff against expectation (15 configs `eval_<agentId>`, 5 evaluators each
   post-§2.4, custom evaluator on requirements_analyst only).
2. Any config on a non-fleet agent (e.g. bug_fixer) or with the custom evaluator on an
   out-of-scope role is drift: delete/recreate via the updated `setup-evaluations.sh` after
   `deploy/runtime-agent/refresh-agents-json.sh` regenerates `fleet-runtime-ids.json` from
   the live account.
3. Record the resulting config ids in `eval-config-ids.json` (truthful snapshot per its own
   `_configs_note`).

### 3.4 Required unit tests — `index.test.mjs`

- `role parser extracts role from full session id` — with ticket prefix
  (`TEAM-3200_wf_1756240000000_ab12cd-agentcore_hub_frontend_dev-1756240012345` →
  `agentcore_hub_frontend_dev`) and without.
- `role parser fail-open on malformed ids` — `si-agentcore_hub_backend_dev-123` (short ms),
  `cc-<hex>`, `null`, `''` → all return `null` and `isOutOfScopeDepChain` returns `false`.
- `dep-chain results for out-of-scope role are excluded` — backend_dev session with a
  `dependency_chain_compliance_online` row: row excluded; sibling `Builtin.Correctness` row
  for the same session retained; classification counts unaffected by the excluded row.
- `dep-chain results for requirements_analyst are retained`.

---

## 4. P2 — Monitoring

**Gap found during investigation:** `classifySessions` routes throttled sessions (all-null
scores + `error.type`) to `error`, NOT `span_missing` (`index.mjs:260-264`) — so the 50.9%
throttle failures are invisible to the only existing alarm
(`deploy/evaluations/span-missing-alarm.json` watches span_missing only). The fleet was
89.3% broken with zero alarms firing.

### 4.1 Extend `emitEvalMetrics` (index.mjs:277-294) — same single-EMF-record pattern

Three new metrics in the SAME record (no second `console.log`, no SDK call):

- `EvalSessionsError` — already computed by `classifySessions` (add it to that function's
  return alongside `spanMissing`).
- `EvalThrottleCount` — count of result records whose `errorType` matches the throttle
  string. **Chosen string: exact equality `errorType === 'ThrottlingException'`** (per OTel
  semconv `error.type` carries the exception class; matches the ticket's classification and
  the packager's read at `index.mjs:226`). **VERIFICATION:** confirm the exact literal from
  one real throttled record via the §2.2 query before hard-coding; if records show a
  namespaced form, widen to `/ThrottlingException$/`.
- `EvalDuplicateResultCount` — records dropped by dedup (§2.2's `duplicatesDropped`).

```js
Metrics: [
  { Name: 'EvalSessionsTotal', Unit: 'Count' },
  { Name: 'EvalSessionsSpanMissing', Unit: 'Count' },
  { Name: 'EvalSessionsError', Unit: 'Count' },
  { Name: 'EvalThrottleCount', Unit: 'Count' },
  { Name: 'EvalDuplicateResultCount', Unit: 'Count' },
],
```

### 4.2 `deploy/evaluations/eval-health-dashboard.json` (complete file)

```json
{
  "widgets": [
    {
      "type": "metric", "x": 0, "y": 0, "width": 12, "height": 6,
      "properties": {
        "title": "Eval success rate (fleet)",
        "region": "us-east-1", "view": "timeSeries", "period": 3600, "stat": "Sum",
        "metrics": [
          [ { "expression": "SUM(SEARCH('{AgentCoreHub/Evaluations,AgentName} MetricName=\"EvalSessionsTotal\"', 'Sum', 3600))", "id": "total", "visible": false } ],
          [ { "expression": "SUM(SEARCH('{AgentCoreHub/Evaluations,AgentName} MetricName=\"EvalSessionsSpanMissing\"', 'Sum', 3600))", "id": "missing", "visible": false } ],
          [ { "expression": "SUM(SEARCH('{AgentCoreHub/Evaluations,AgentName} MetricName=\"EvalSessionsError\"', 'Sum', 3600))", "id": "errors", "visible": false } ],
          [ { "expression": "(total - missing - errors) / total", "label": "success rate", "id": "success", "color": "#2ca02c" } ]
        ],
        "yAxis": { "left": { "min": 0, "max": 1 } },
        "annotations": { "horizontal": [ { "label": "alarm threshold", "value": 0.8 } ] }
      }
    },
    {
      "type": "metric", "x": 12, "y": 0, "width": 12, "height": 6,
      "properties": {
        "title": "Throttle rate (throttled records / sessions)",
        "region": "us-east-1", "view": "timeSeries", "period": 3600, "stat": "Sum",
        "metrics": [
          [ { "expression": "SUM(SEARCH('{AgentCoreHub/Evaluations,AgentName} MetricName=\"EvalThrottleCount\"', 'Sum', 3600))", "id": "throttled", "visible": false } ],
          [ { "expression": "SUM(SEARCH('{AgentCoreHub/Evaluations,AgentName} MetricName=\"EvalSessionsTotal\"', 'Sum', 3600))", "id": "total2", "visible": false } ],
          [ { "expression": "throttled / total2", "label": "throttle records per session", "id": "trate", "color": "#d62728" } ],
          [ { "expression": "throttled", "label": "throttled records (raw)", "id": "traw", "yAxis": "right" } ]
        ]
      }
    },
    {
      "type": "metric", "x": 0, "y": 6, "width": 12, "height": 6,
      "properties": {
        "title": "span_missing (ValidationException) ratio — mirrors span-missing alarm",
        "region": "us-east-1", "view": "timeSeries", "period": 3600, "stat": "Sum",
        "metrics": [
          [ { "expression": "SUM(SEARCH('{AgentCoreHub/Evaluations,AgentName} MetricName=\"EvalSessionsSpanMissing\"', 'Sum', 3600))", "id": "m2", "visible": false } ],
          [ { "expression": "SUM(SEARCH('{AgentCoreHub/Evaluations,AgentName} MetricName=\"EvalSessionsTotal\"', 'Sum', 3600))", "id": "t2", "visible": false } ],
          [ { "expression": "m2 / t2", "label": "span_missing ratio (fleet)", "id": "smr", "color": "#ff7f0e" } ]
        ],
        "yAxis": { "left": { "min": 0, "max": 1 } },
        "annotations": { "horizontal": [ { "label": "span-missing alarm threshold", "value": 0.5 } ] }
      }
    },
    {
      "type": "metric", "x": 12, "y": 6, "width": 12, "height": 6,
      "properties": {
        "title": "Duplicate result records dropped by dedup",
        "region": "us-east-1", "view": "timeSeries", "period": 3600, "stat": "Sum",
        "metrics": [
          [ { "expression": "SUM(SEARCH('{AgentCoreHub/Evaluations,AgentName} MetricName=\"EvalDuplicateResultCount\"', 'Sum', 3600))", "label": "duplicates dropped (fleet)", "id": "dup" } ]
        ]
      }
    },
    {
      "type": "metric", "x": 0, "y": 12, "width": 24, "height": 8,
      "properties": {
        "title": "Per-agent: sessions total vs span_missing vs error",
        "region": "us-east-1", "view": "timeSeries", "period": 3600, "stat": "Sum",
        "metrics": [
          [ { "expression": "SEARCH('{AgentCoreHub/Evaluations,AgentName} MetricName=\"EvalSessionsTotal\"', 'Sum', 3600)", "id": "pa_total" } ],
          [ { "expression": "SEARCH('{AgentCoreHub/Evaluations,AgentName} MetricName=\"EvalSessionsSpanMissing\"', 'Sum', 3600)", "id": "pa_missing" } ],
          [ { "expression": "SEARCH('{AgentCoreHub/Evaluations,AgentName} MetricName=\"EvalSessionsError\"', 'Sum', 3600)", "id": "pa_error" } ]
        ]
      }
    }
  ]
}
```

(Region is environment-specific — substitute at apply time if not us-east-1.)

### 4.3 `deploy/evaluations/eval-success-rate-alarm.json` (complete file)

Metric-math SEARCH pattern copied from `span-missing-alarm.json`; success rate < 80% per
batch window; `TreatMissingData: missing`; AlarmActions added at apply time (intentionally
omitted — environment-specific SNS topic, same convention as the existing alarm).

```json
{
  "AlarmName": "agentcore-hub-eval-success-rate",
  "AlarmDescription": "Eval session success rate ((total - span_missing - error) / total) below 80%. Counts BOTH failure modes: span_missing (ValidationException / no invoke_agent span) AND error (incl. judge ThrottlingException) — the latter was invisible to the span-missing alarm. Fires on 3 of 4 hourly datapoints. INSUFFICIENT_DATA when no eval sessions arrive.",
  "ActionsEnabled": true,
  "EvaluationPeriods": 4,
  "DatapointsToAlarm": 3,
  "Threshold": 0.8,
  "ComparisonOperator": "LessThanThreshold",
  "TreatMissingData": "missing",
  "Metrics": [
    {
      "Id": "total",
      "Expression": "SUM(SEARCH('{AgentCoreHub/Evaluations,AgentName} MetricName=\"EvalSessionsTotal\"', 'Sum', 3600))",
      "ReturnData": false
    },
    {
      "Id": "missing",
      "Expression": "SUM(SEARCH('{AgentCoreHub/Evaluations,AgentName} MetricName=\"EvalSessionsSpanMissing\"', 'Sum', 3600))",
      "ReturnData": false
    },
    {
      "Id": "errors",
      "Expression": "SUM(SEARCH('{AgentCoreHub/Evaluations,AgentName} MetricName=\"EvalSessionsError\"', 'Sum', 3600))",
      "ReturnData": false
    },
    {
      "Id": "success_rate",
      "Expression": "(total - missing - errors) / total",
      "Label": "eval success rate (fleet)",
      "ReturnData": true
    }
  ]
}
```

### 4.4 Apply instructions (mirror of setup-evaluations.sh:58-74)

```bash
# Dashboard:
aws cloudwatch put-dashboard --dashboard-name agentcore-hub-eval-health \
  --dashboard-body file://deploy/evaluations/eval-health-dashboard.json

# Alarm (add AlarmActions — the environment's SNS topic ARN — to the JSON at apply time):
aws cloudwatch put-metric-alarm --cli-input-json file://deploy/evaluations/eval-success-rate-alarm.json
```

Rollout constraint (same as the span-missing alarm, `setup-evaluations.sh:66-74`): apply the
alarm ONLY AFTER the P0-A runtime fix and the P0-B packager fix are deployed AND at least one
healthy batch with non-zero `EvalSessionsTotal` and the three NEW metrics has been observed
in CloudWatch — creating it against pre-fix data means it fires immediately on stale state.
The dashboard is safe to apply any time (empty widgets until the new metrics flow).

---

## 5. Rollout order (implementation-ticket shape)

Separate deploy targets per DEPLOY.md contracts — runtime-agent is an image redeploy, the
packager is a Lambda code deploy, eval configs are an out-of-band re-apply; do not couple.

| # | Ticket | Contents | Deploy mechanism | Gate to proceed |
|---|--------|----------|------------------|-----------------|
| 1 | TEAM-3366-A (P0-A) | `main.py` anchor span + tests (§1.3/§1.4). Prereq: V-1..V-3 verification queries. | `deploy/runtime-agent/build-and-push.sh` → `deploy-fleet.sh` (image rebuild + fleet rollout per `deploy/runtime-agent/DEPLOY.md`) | New sessions show an exported anchor invoke_agent span (V-2 query returns it within ~1 min of session start) |
| 2 | TEAM-3366-B (P0-B code) | Packager dedup (§2.2) + improver retry (§2.3) + P1 role guard (§3.2) + P2 metrics (§4.1) + all unit tests. One Lambda, one ticket. Prereq: request-id attribute confirmed (§2.2 query). | `deploy/continuous-improvement/deploy.sh` (redeploys eval-packager, 600s/512MB per its lines 91-93) | `EvalDuplicateResultCount` flowing; duplicate groups gone from batches |
| 3 | TEAM-3366-C (P0-B config + P1 config) | `setup-evaluations.sh` evaluator trim + tiered sampling (§2.4) + `TICKET_AGENTS` shrink (§3.1); `refresh-agents-json.sh`; reconcile via `agentcore eval online list` (§3.3); update `eval-config-ids.json`. Prereq: `agentcore eval online create --help` knob check. | Operator runs the script against the live account (config re-apply, not a code deploy) | Live config list matches repo expectation |
| 4 | TEAM-3366-D (P2 apply) | Dashboard + success-rate alarm JSONs (§4.2-4.4). | `aws cloudwatch put-dashboard` / `put-metric-alarm` | ≥1 healthy batch with the new metrics observed first |
| 5 | TEAM-3366-E (Ops) | Quota increase request per runbook (§2.5); add the runbook section to `docs/orchestration-tracing-guide.md`. Can run in parallel with 1-4. | AWS Support / service-quotas API | Quota granted (or interim: sampling values from §2.4 re-derived against the actual current quota) |

P0s (1-3) land before P1/P2 config niceties; step 2 deliberately bundles the P1 processing
guard and P2 metrics because they touch the same Lambda and ship as one artifact.

## 6. Success criteria

- Eval success rate (new metric) ≥ 80% sustained over 24h (baseline: 10.7%).
- Zero ValidationException "no invoke_agent span" results for sessions started post-step-1.
- Throttled judge calls produce ≤1 result record each (dedup) and
  `EvalThrottleCount / EvalSessionsTotal` trending to ~0 after steps 3+5.
- `dependency_chain_compliance_online` results appear only for requirements_analyst.
- Success-rate alarm live and OK; span-missing alarm remains as-is.

## 7. Risks / failure modes

- **Two invoke_agent spans per completed session** (anchor + SDK span). Evaluators may score
  the near-empty anchor trace, adding low-signal results. Mitigations: the
  `agentcore.hub.anchor` attribute makes them distinguishable; TRACE-level evaluator count is
  already being cut (§2.4); if post-deploy results show anchor traces being judged and
  skewing scores, follow-up: have the P3 processing guard drop rows whose evaluated trace is
  anchor-only. Accepted for P0 — a scoreable session with one noisy trace beats an
  unscoreable session.
- **Anchor flush adds up to 5s at session start** (bounded by `force_flush(5000)` timeout,
  fail-open). Detached-ack latency is unaffected for the caller (agent-invoker fires and
  forgets); worst case delays the first model call by 5s on a broken exporter.
- **Dedup false positives**: the content-key fallback could merge two genuinely identical
  same-timestamp results. Probability is negligible (timestamp is ms-resolution per record)
  and the failure mode is losing one duplicate-looking score, not a session.
- **Cross-delivery duplicates** would survive the in-memory pass until the seen-set
  follow-up ships; `EvalDuplicateResultCount` + the §2.2 decision rule bound how long that
  stays unknown.
- **Sampling cut reduces improver signal**: 25% sampling on non-gate roles slows
  batch accumulation toward `batchSize` (`index.mjs:148`) and thus PRD cadence. Acceptable —
  the current alternative is 89% garbage batches; revisit rates after the quota increase
  lands.
- **Retry pressure**: invokeImprover retries add load during incidents; bounded by max 3
  attempts + 520s deadline (§2.3), and the improver flush already runs behind a 60-min
  cooldown (`index.mjs:158`).
- **Alarm INSUFFICIENT_DATA** during quiet hours is expected (`TreatMissingData: missing`,
  same convention as the span-missing alarm) — do not page on it.
- **Assumption risk in the quota math**: `T = R = 20` and 2 workflows/hour are estimates;
  both are marked VERIFY (§2.4) and the arithmetic is laid out so re-derivation is
  mechanical once live counts are pulled.
- **Live drift recurrence**: nothing prevents a future out-of-band `agentcore eval online
  create`; the P1 processing guard (§3.2) contains the blast radius to config-level noise
  rather than scored-result corruption.
