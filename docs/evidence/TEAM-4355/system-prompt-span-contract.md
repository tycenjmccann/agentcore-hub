# TEAM-4355 — the `system_prompt` span contract

## The product answer

**The system prompt IS a real telemetry contract, and it is retained.**
**`system_prompt`-as-a-span-attribute was never a contract** — it was a `**kwargs`
passthrough accident with exactly one reader in the world, this test. The contract is
*"the system prompt is exported on the `invoke_agent` span"*, and `strands-agents` 1.55.1
honours it at the semconv carrier. Nothing to restore, nothing lost.

## The bug

`deploy/runtime-agent/tests/requirements-test.txt` carried a bare `strands-agents>=1.53.0`
with no ceiling. Pip resolved 1.55.1 (published 2026-09-09), and
`test_stream_async_emits_invoke_agent_span` reddened overnight:

```
assert attrs["system_prompt"] == "You are a test agent."
E   KeyError: 'system_prompt'
```

## Version-by-version span shape (empirical)

Verified by unzipping the `strands-agents` wheels for 1.54.0 / 1.55.0 / 1.55.1 from PyPI
and, separately, by constructing a real `strands.Agent` against a stubbed `Model`, driving
`agent.stream_async("hello")` to completion, and dumping every attribute and event off the
resulting `invoke_agent` span from an in-memory `InMemorySpanExporter` — in fresh venvs for
each version.

| | 1.54.0 / 1.55.0 | 1.55.1 |
|---|---|---|
| `system_prompt` span attribute | `'You are a test agent.'` | **absent** |
| `gen_ai.system.message` event | **absent** | present, `content='[{"text": "You are a test agent."}]'` |
| `gen_ai.system_instructions` | n/a | span attribute + on the `gen_ai.client.inference.operation.details` event, **only** under `use_latest_genai_conventions` (this suite runs the default legacy conventions, so it does not apply here) |
| `gen_ai.user.message` / `gen_ai.choice` events | unchanged | unchanged |

Raw dump, 1.55.1 (`pip show strands-agents` confirms `Version: 1.55.1`):

```
SPAN NAME: invoke_agent test_agent
SCOPE: strands.telemetry.tracer
--- ATTRIBUTES ---
  'gen_ai.agent.name' = test_agent
  'gen_ai.operation.name' = invoke_agent
  'gen_ai.system' = strands-agents
  'gen_ai.usage.cache_creation.input_tokens' = 0
  ...
--- EVENTS ---
  EVENT 'gen_ai.system.message'
      'content' = '[{"text": "You are a test agent."}]'
  EVENT 'gen_ai.user.message'
      'content' = '[{"text": "hello"}]'
  EVENT 'gen_ai.choice'
      'message' = 'hello back\n'
      'finish_reason' = 'end_turn'
```

Raw dump, 1.55.0 (`pip show strands-agents` confirms `Version: 1.55.0`) — same script:

```
SPAN NAME: invoke_agent test_agent
  'system_prompt' = You are a test agent.
--- EVENTS ---
  EVENT 'gen_ai.user.message'
      'content' = '[{"text": "hello"}]'
  EVENT 'gen_ai.choice'
      ...
```

1.54.0 (installed and driven through the actual hermetic pytest suite, not the standalone
dump script) produces the identical `system_prompt`-attribute shape as 1.55.0.

## Wheel-source citations (`strands_agents-1.55.1-py3-none-any.whl`)

- `strands/telemetry/tracer.py:733-744` — `Tracer.start_agent_span` gained explicit
  `system_prompt: str | None = None` and `system_prompt_content: list | None = None`
  parameters (previously absent; they fell into `**kwargs`).
- `strands/telemetry/tracer.py:786` — `attributes.update({k: v for k, v in kwargs.items()
  if isinstance(v, (str, int, float, bool))})`: the exact kwargs-scalar copy that used to
  put `system_prompt` on the span as a side effect, before it became a named parameter.
- `strands/telemetry/tracer.py:798-799` — `if not self.use_latest_genai_conventions:
  self._add_system_prompt_event(span, system_prompt, system_prompt_content)`.
- `strands/telemetry/tracer.py:1298-1342` — `_add_system_prompt_event`: under legacy
  conventions, emits the `gen_ai.system.message` event; under latest conventions, emits
  `gen_ai.system_instructions` on the `gen_ai.client.inference.operation.details` event.
- `strands/telemetry/tracer.py:1344-1348` — `_system_prompt_content_blocks` returns
  `[{"text": system_prompt or ""}]` when no structured content is given — this is why the
  event's `content` is JSON of a content-block list, not a bare string.
- `strands/agent/agent.py:1894-1902` — `Agent._start_agent_trace_span` now passes
  `system_prompt=self.system_prompt` and `system_prompt_content=self.system_prompt_content`
  as named arguments to `start_agent_span`, not as bare kwargs.

## No-consumer grep (repo-wide, excluding `node_modules`/`.git`)

Searched for `system_prompt`, `gen_ai.system.message`, `gen_ai.system_instructions`.

| Hit | What it actually is |
|---|---|
| `src/lib/agentcore-sdk.ts:491,497`, `src/app/api/agentcore/builder/route.ts:61`, `src/app/api/agentcore/deploy/route.ts:48`, `src/lib/agentcore-stream.ts:40,56`, `lambda/builder-tools/index.mjs:157,164,195,237` | Builder **harness-creation config** (`HarnessConfig.system_prompt`, the `CreateAgentRuntime` payload). Agent *definition*, never span telemetry. |
| `lambda/eval-packager/` | Reads only `gen_ai.evaluation.score.value` / `.score.label` / `.explanation` / `.name`, `gen_ai.response.id`, `aws.request_id`, `session.id`, `gen_ai.operation.name`. Zero system-prompt reads. |
| `deploy/evaluations/*.json` (the AgentCore online evaluators, e.g. `dependency_chain_evaluator.json`) | `llmAsAJudge` config with a `{context}` template string. Never names a span attribute. |
| `deploy/runtime-agent/main.py`, `tests/test_telemetry.py`, `tests/test_prompt_cache.py`, `local-ab-test.py`, `test-streaming/main.py`, `deploy/pipeline/test_plan_surfaces.py` | `Agent(system_prompt=…)` constructor kwarg / prompt plumbing at agent-construction time. Not span reads. |
| `docs/workflow-pipeline-architecture.md:717-740` | Historical DL-009 note about removing `system_prompt` from the invocation *payload* (a routing decision), unrelated to span telemetry. |
| `gen_ai.system.message` / `gen_ai.system_instructions` | **One** hit in the entire repo before this change, and it is neither key: `test_telemetry_spans.py:190` asserts `gen_ai.system` (the framework-name attribute, unaffected by any of this). |

**Conclusion: nothing downstream ever read the `system_prompt` span attribute.** The
assertion was a shape-pin only, not a live production contract.

## Is `system_prompt` still a telemetry contract?

No — it never was one, in the sense of having a consumer. What *is* a contract, and what
this test now protects, is the weaker and more durable claim: **the system prompt text is
exported somewhere on the `invoke_agent` span.** Before 1.55.1 that "somewhere" was an
attribute; from 1.55.1 it is a `gen_ai.system.message` event (or, under
`use_latest_genai_conventions`, a `gen_ai.system_instructions` attribute). The assertion is
now version-aware so it tracks the carrier rather than the accident.

## Correcting `main`'s #468 commit-message reasoning

`main` commit `07b55ff` (PR #468, merged 2026-09-10T00:35Z) pinned both
`deploy/runtime-agent/requirements.txt` and `deploy/runtime-agent/tests/requirements-test.txt`
to `strands-agents>=1.53.0,<1.55`. The **ceiling** is correct and this change adopts it
verbatim. Its **stated rationale**, however, contains two claims disproved above:

- *"the system_prompt span attribute the UI evaluator … assert[s]"* — **false.** See the
  no-consumer grep table. No evaluator, dashboard, or Lambda in this repo reads
  `system_prompt` off a span.
- *"1.55 dropped the system_prompt span attribute … silently degrading span quality in
  prod"* — **false.** 1.55.1 **relocated** it. Span quality is equal or better: the prompt
  is still exported, and the event carrier preserves content-block structure
  (`[{"text": …}]`) instead of flattening it to a bare string attribute.

The corrected reasoning is what ships in both requirements files' comments in this change:
a minor SDK bump can move span *shape*, so it warrants a ceiling and a deliberate, reviewed
edit — not because 1.55 is worse, but because an unreviewed shape change (in either
direction) is the risk being managed.

## Pin rationale

- **Floor** `>=1.53.0` (unchanged, preserved verbatim in both files): `main.py` passes
  `cache_tools="default"` (a string) and relies on the tools cachePoint inheriting `ttl`
  from `cache_config.ttl`. That inheritance (`_build_tools_cache_point` in
  `strands/models/bedrock.py`) only exists from 1.53.0; on 1.52.0 the tools cachePoint
  ships without `ttl` (defaults to 5m), breaking `test_prompt_cache`'s `ttl=="1h"`
  assertion and yielding a mixed-TTL request Bedrock extended-TTL validation can reject
  (TEAM-3961, F1).
- **Ceiling** `<1.55` (adopted from `main`'s #468, corrected rationale as above): both
  `requirements.txt` and `tests/requirements-test.txt` now carry the identical range, so
  prod and CI always resolve the same minor and can never assert a different span shape
  than the deployed image emits. Resolves today to **1.54.0** (the only 1.54.x release on
  the PyPI index).
- **Rejected alternative — floor `>=1.55.1`:** an earlier draft of this ticket's plan
  proposed raising the *floor* to 1.55.1 instead of adopting `main`'s ceiling. Withdrawn: it
  would have reverted an already-merged decision (#468), produced a guaranteed conflict on
  both requirements files at the orchestrator's unified PR, and risked leaving prod pinned
  at `<1.55` while the tests demanded `>=1.55.1` — the exact prod/test version inversion
  this ticket exists to prevent.

## Verification

Hermetic gate (`scripts/run-python-tests.sh`, TEAM-4354's shared target list), Python 3.13:

| Run | strands-agents | Result |
|---|---|---|
| **BEFORE** (base branch as-is, unbounded `>=1.53.0`) | 1.55.1 | `1 failed, 413 passed, 42 subtests passed` — `KeyError: 'system_prompt'` |
| **AFTER** (this change; `<1.55` resolves) | **1.54.0** | `414 passed, 42 subtests passed`, exit 0 |
| **AFTER, forward-compat proof** (same tree, 1.55.1 installed instead) | 1.55.1 | `414 passed, 42 subtests passed`, exit 0 |

**Both branches of the version-aware assertion were exercised, not just written:**

```
1.54.0  -> _strands_version() == (1, 54, 0)  -> branch taken: ATTRIBUTE (system_prompt)
1.55.1  -> _strands_version() == (1, 55, 1)  -> branch taken: EVENT (gen_ai.system.message)
```

**Mutation differential (non-vacuity proof)** — replacing the expected text with `"MUTANT"`
fails loudly on both installed versions:

```
1.54.0  FAILED test_stream_async_emits_invoke_agent_span  (AssertionError on the attribute branch)
1.55.1  FAILED test_stream_async_emits_invoke_agent_span  (AssertionError on the event branch)
```

No other hermetic test regressed under either version: `414 passed` on both 1.54.0 and
1.55.1, including `test_prompt_cache.py`, `tests/test_telemetry.py`, and
`test_telemetry_init.py`.

## Recommended follow-up (not this PR)

Lift the `<1.55` ceiling to a `<1.56` (or wider) ceiling as its own deliberate, reviewed
change. The version-aware assertion in `test_telemetry_spans.py` is already green against
1.55.1 (proven above), so the lift is a one-line pin edit plus a fleet-image rebuild — not
a test fix. 1.55.1's span shape is a relocation to prefer (better-structured content, on
the standards-track carrier), not a version to avoid indefinitely.
