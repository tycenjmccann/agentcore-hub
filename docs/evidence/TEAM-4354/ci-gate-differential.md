# TEAM-4354 — CI pytest-gate differential (before/after)

**Ticket:** TEAM-4354 — unify the hermetic Python unit-test gate across the two CI
surfaces (`.github/workflows/ci.yml` job `python-telemetry-tests`, and
`deploy/pipeline/buildspec-ci.yml` build phase) behind one shared target list
(`deploy/pipeline/pytest-targets.txt`) + one runner
(`scripts/run-python-tests.sh`).

**Why this is a differential, not a "green" claim:** the gate is ALREADY RED on
the base branch (`feature/TEAM-4314--kiro-opus-workflow-tab-sidebar-dark-sle`)
because of a pre-existing, deliberately out-of-scope failure —
`deploy/runtime-agent/tests/test_telemetry_spans.py::test_stream_async_emits_invoke_agent_span`
(`KeyError: 'system_prompt'`, caused by `strands-agents>=1.53.0` resolving to
1.55.1). That test lives under `deploy/runtime-agent/tests`, which is in BOTH
lists today, so it already fails in both surfaces. This ticket does not touch it
and is routed to the owning tier separately. The honest evidence below is that
**the failure set is UNCHANGED and coverage STRICTLY GROWS.**

## Method

One clean virtualenv built only from
`deploy/runtime-agent/tests/requirements-test.txt` (no AWS, no network, no extra
pins). Environment: Python 3.13.15, `strands-agents` 1.55.1 (the version that
carries the pre-existing failure). Three runs in that same venv:

- **A** — the OLD `.github/workflows/ci.yml` list (15 targets, as on the base branch)
- **B** — the OLD `deploy/pipeline/buildspec-ci.yml` list (13 targets, as on the base branch)
- **C** — the NEW `./scripts/run-python-tests.sh` (16 targets = the union)

## Results (verbatim `short test summary info` + counts)

| Run | Targets | pytest result | Only failing test | Exit code |
|-----|---------|---------------|-------------------|-----------|
| A — old ci.yml | 15 | `1 failed, 390 passed, 2 warnings, 42 subtests passed` | `test_telemetry_spans.py::test_stream_async_emits_invoke_agent_span` | 1 |
| B — old buildspec | 13 | `1 failed, 376 passed, 2 warnings, 42 subtests passed` | `test_telemetry_spans.py::test_stream_async_emits_invoke_agent_span` | 1 |
| C — new runner | 16 | `1 failed, 413 passed, 2 warnings, 42 subtests passed` | `test_telemetry_spans.py::test_stream_async_emits_invoke_agent_span` | 1 |

The single `FAILED` line was byte-identical in all three runs:

```
FAILED deploy/runtime-agent/tests/test_telemetry_spans.py::test_stream_async_emits_invoke_agent_span
```

## Conclusions

1. **Failure set unchanged.** The ONLY failing test in A, B and C is the identical
   pre-existing `test_telemetry_spans.py::test_stream_async_emits_invoke_agent_span`.
   No new failure is introduced by unifying the lists.
2. **Coverage strictly grows, nothing regresses.** C's passing count (413) is
   greater than both A (390) and B (376): `413 >= 390 >= 376`. Every test that
   passed in A or B still passes in C, plus more.
3. **The 4 previously-single-surface targets are now gated on BOTH surfaces.**
   Union = 16 targets. Newly gated:
   - into CodeBuild (were ci.yml-only): `deploy/coding-agent-runtime/test_plan_mode_args.py`,
     `deploy/coding-agent-runtime/test_turn_timeout.py`,
     `deploy/coding-agent-runtime/test_codex_sqlite_home.py`
   - into GitHub Actions (was buildspec-only): `deploy/runtime-agent/test_remote_coding.py`
4. **Runner exit code for C is non-zero (1), by design.** It is non-zero *only*
   because of the pre-existing `test_telemetry_spans.py` failure — the runner
   correctly propagates pytest's exit status. This is **identical to the current
   inline `pytest -q` behaviour on both surfaces today** (A and B both exit 1 on
   the base branch): there is NO change in gate colour. Once the owning tier
   fixes `test_stream_async_emits_invoke_agent_span`, all three go green with no
   further change to this runner or list.

## Note on target order

`deploy/pipeline/pytest-targets.txt` preserves a specific, load-bearing order:
`deploy/runtime-agent/tests` first, the `deploy/coding-agent-runtime/` tests
grouped together. Sorting the list makes pytest fail to *collect* with
`ImportError: ... 'strands' is not a package`, because
`deploy/coding-agent-runtime/test_setup_failure_response.py` exec's the coding
runtime's `main.py` and stubs `sys.modules`; if it imports before
`deploy/runtime-agent/tests` it poisons `sys.modules['strands']`. The list header
and the runner comment both warn against sorting.
