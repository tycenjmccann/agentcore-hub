"""TEAM-4739 FR-6 — a ConverseStream that breaks mid-turn is re-opened, not lost.

`agent.stream_async(prompt)` is a long-lived event stream. botocore's
`retries={"max_attempts": 2}` in `_build_bedrock_model` governs only the request
that OPENS it: once ConverseStream has answered 200, a member of the
`ConverseStreamOutput` union arriving as an error (`internalServerException`,
`modelStreamErrorException`, `throttlingException`, `serviceUnavailableException`)
or a read timeout on the open socket is delivered to us, and botocore will never
re-send. Before this change any of them ended the turn: the persona's work was
discarded, the ticket stayed claimed until the lease expired, and the run paid a
full sweep cycle for a hiccup that a second attempt would have survived.

What is pinned here:
  1. The classifier is a PURE function with a table — transient retries,
     deterministic fails, and anything unrecognised fails (a transient we fail to
     retry costs one turn the sweep recovers; a deterministic error we retry burns
     a full turn's tokens three times and ends where it started).
  2. A retry re-enters `stream_async` on the SAME Agent object with the SAME
     prompt, and everything the turn had already produced survives: text is
     APPENDED, never replayed, so the caller sees no duplicate delta and Memory
     records one continuous reply.
  3. `agent.error` is published exactly once, only after the retries are
     exhausted (or immediately for a deterministic error), and never on a turn
     that recovered. `agent.died` is never published on this path — the two are
     disjoint by construction (FR-7).

Hermetic: the Agent is a scripted fake and the shipped `_run_agent_invocation`
source is exec'd from main.py by the loader in test_telemetry_spans.py (main.py
cannot be imported — its module top-level installs Node.js, fetches from S3 and
chdirs).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from test_telemetry_spans import _load_production_entrypoints


# ─── Error doubles ───────────────────────────────────────────────────────────
#
# Matched by lowercased TYPE NAME + message, not by imported class, because these
# reach us wrapped: Strands raises its own EventStreamError and the mid-stream
# union members surface as whatever the SDK mapped them to. So a name-shaped
# stand-in is the honest double — a real botocore class would test less.


class EventStreamError(Exception):
    pass


class ThrottlingException(Exception):
    pass


class InternalServerException(Exception):
    pass


class ModelStreamErrorException(Exception):
    pass


class ServiceUnavailableException(Exception):
    pass


class ReadTimeoutError(Exception):
    pass


class ValidationException(Exception):
    pass


class MaxTokensReachedException(Exception):
    pass


class AccessDeniedException(Exception):
    pass


class SomethingNobodyClassified(Exception):
    pass


# ─── Test doubles ────────────────────────────────────────────────────────────


def _flaky_agent_class(scripts: list[list[Any]]) -> type:
    """An ``Agent`` stand-in with one script PER ``stream_async`` call.

    Each script is a list of stream events; an exception instance is raised at
    that point (a stream that produced some text and then broke) and a callable
    runs with the agent between yields, which is when a real hook fires. The last
    script repeats if the code re-enters more times than there are scripts, so an
    over-retry shows up as an attempt count, not an IndexError.
    """

    class _FlakyAgent:
        instances: list[Any] = []

        def __init__(self, **kwargs: Any) -> None:
            self.attempts = 0
            self.prompts: list[str] = []
            self.hooks = list(kwargs.get("hooks") or [])
            type(self).instances.append(self)

        async def stream_async(self, prompt: str):
            index = self.attempts
            self.attempts += 1
            self.prompts.append(prompt)
            for step in scripts[index] if index < len(scripts) else scripts[-1]:
                if isinstance(step, BaseException):
                    raise step
                if callable(step):
                    step(self)
                else:
                    yield step

    return _FlakyAgent


def _engage_completion(agent: Any) -> None:
    """Fire the real `_CompletionGate` hook, as a successful report_completion does.

    A recovered turn still has to ACCOUNT for itself: FR-7 publishes `agent.died`
    for a turn that ended with neither a completion nor a park, and "the stream
    was retried" is not an outcome. So the retry tests that assert no death drive
    the same gate a real persona would.
    """
    gate = next(h for h in agent.hooks if getattr(h, "TOOL", "").endswith("report_completion"))
    gate._on_tool_result(
        SimpleNamespace(
            tool_use={"name": gate.TOOL},
            result={"status": "success", "content": [{"text": "recorded"}]},
        )
    )


CTX = SimpleNamespace(session_id="test-session-stream-retry")
# Bound to a run AND a ticket: that is the shape where a stream break has
# consequences (a claimed ticket, a journey to publish onto), and it is also the
# shape where agent.died would fire if the disjointness broke.
PAYLOAD = {
    "prompt": "do the work",
    "workflow_id": "wf_retry",
    "ticket_id": "TEAM-4739",
    "agent_id": "agentcore_hub_backend_dev",
}


def _load(scripts: list[list[Any]], **overrides: Any) -> tuple[dict, list, list, list]:
    """(namespace, agent_class, published_errors, published_deaths).

    ``_STREAM_RETRY_BASE_S = 0`` collapses the full-jitter ceiling to zero, so the
    retries run without sleeping — the delay function's own bounds are asserted
    directly below rather than waited out here.
    """
    errors: list[tuple] = []
    deaths: list[tuple] = []
    agent_cls = _flaky_agent_class(scripts)
    agent_cls.instances = []
    saved: list[tuple] = []
    ns = _load_production_entrypoints(
        overrides={
            "Agent": agent_cls,
            "_publish_agent_error": lambda *a, **k: errors.append((a, k)),
            "_publish_agent_died": lambda *a, **k: deaths.append((a, k)),
            "_save_memory_event": lambda *a: saved.append(a),
            **overrides,
        }
    )
    ns["_STREAM_RETRY_BASE_S"] = 0.0
    ns["_test_agent_class"] = agent_cls
    ns["_test_saved"] = saved
    return ns, agent_cls, errors, deaths


def _deltas(frames: list[dict]) -> list[str]:
    return [
        f["event"]["contentBlockDelta"]["delta"]["text"]
        for f in frames
        if "contentBlockDelta" in f.get("event", {})
    ]


# ─── 1. the classifier table ─────────────────────────────────────────────────

RETRYABLE = [
    InternalServerException("the model service failed mid-stream"),
    ThrottlingException("Too many requests"),
    ModelStreamErrorException("stream member reported an error"),
    ServiceUnavailableException("temporarily unavailable"),
    EventStreamError("An error occurred while reading the event stream"),
    ReadTimeoutError("Read timeout on endpoint URL"),
    TimeoutError("read timed out"),
]
NON_RETRYABLE = [
    ValidationException("messages.1: content must not be empty"),
    MaxTokensReachedException("max output tokens reached"),
    AccessDeniedException("not authorized to invoke bedrock"),
    SomethingNobodyClassified("no idea what this is"),
    ValueError("a plain bug in our own code"),
]


@pytest.mark.parametrize("exc", RETRYABLE, ids=lambda e: type(e).__name__)
def test_transient_errors_classify_as_retry(exc: BaseException) -> None:
    ns = _load_production_entrypoints()
    assert ns["_classify_stream_error"](exc) == "retry", (
        f"{type(exc).__name__} is transient — a second attempt can succeed"
    )


@pytest.mark.parametrize("exc", NON_RETRYABLE, ids=lambda e: type(e).__name__)
def test_deterministic_and_unknown_errors_classify_as_fail(exc: BaseException) -> None:
    ns = _load_production_entrypoints()
    assert ns["_classify_stream_error"](exc) == "fail", (
        f"{type(exc).__name__} would fail the same way again — retrying only burns tokens"
    )


def test_asyncio_timeout_is_retryable_through_its_builtin_name() -> None:
    """`asyncio.TimeoutError` IS `TimeoutError` on 3.11+; the marker has to be the
    builtin's name, or the read-timeout case silently stops retrying."""
    import asyncio

    ns = _load_production_entrypoints()
    assert ns["_classify_stream_error"](asyncio.TimeoutError()) == "retry"


def test_fail_markers_win_when_a_wrapper_quotes_both() -> None:
    """A wrapper whose message names both is reporting the deterministic cause —
    e.g. an EventStreamError carrying a ValidationException. Retrying that one
    three times is three wasted turns with a guaranteed identical ending."""
    ns = _load_production_entrypoints()
    both = EventStreamError("ValidationException: messages.1 content must not be empty")
    assert ns["_classify_stream_error"](both) == "fail"


def test_classifier_is_pure() -> None:
    """No module state, no logging, no I/O — that is what makes the retry policy
    testable as a table instead of only through a driven turn."""
    ns = _load_production_entrypoints()
    fn = ns["_classify_stream_error"]
    exc = ThrottlingException("Too many requests")
    assert fn(exc) == fn(exc) == "retry"
    assert set(fn.__code__.co_names) <= {
        "_STREAM_FAIL_MARKERS",
        "_STREAM_RETRY_MARKERS",
        "any",
        "type",
        "__name__",
        "lower",
    }, f"the classifier reached for something impure: {sorted(fn.__code__.co_names)}"


# ─── 2. the backoff ──────────────────────────────────────────────────────────


def test_backoff_is_exponential_with_full_jitter() -> None:
    ns = _load_production_entrypoints()
    delay = ns["_stream_retry_delay"]
    for attempt, ceiling in ((1, 1.0), (2, 2.0), (3, 4.0)):
        samples = [delay(attempt, 60.0) for _ in range(200)]
        assert all(0.0 <= s <= ceiling for s in samples), (
            f"attempt {attempt} must jitter within [0, {ceiling}]; got "
            f"[{min(samples)}, {max(samples)}]"
        )
        # Full jitter, not a fixed ramp: one Bedrock hiccup hits every persona in
        # the fleet at once, and a deterministic delay sends them all back together.
        assert len(set(samples)) > 1, f"attempt {attempt} produced a constant delay"


def test_backoff_never_exceeds_the_remaining_budget() -> None:
    ns = _load_production_entrypoints()
    delay = ns["_stream_retry_delay"]
    assert all(delay(3, 0.25) <= 0.25 for _ in range(200))
    assert delay(3, 0.0) == 0.0
    assert delay(3, -5.0) == 0.0, "a blown budget must never sleep"


def test_the_wall_budget_and_attempt_cap_are_the_documented_ones() -> None:
    ns = _load_production_entrypoints()
    assert ns["_STREAM_RETRY_MAX_ATTEMPTS"] >= 3
    assert ns["_STREAM_RETRY_BUDGET_S"] <= 60.0


# ─── 3. driven turns ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_two_transient_breaks_then_success() -> None:
    """3 attempts, one Agent, one prompt, text appended — never replayed."""
    ns, agent_cls, errors, deaths = _load([
        [{"data": "part-"}, EventStreamError("stream closed")],
        [ThrottlingException("Too many requests")],
        [{"data": "rest"}, _engage_completion],
    ])

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]
    (agent,) = agent_cls.instances

    assert agent.attempts == 3, f"expected 3 stream_async attempts, got {agent.attempts}"
    assert len(agent_cls.instances) == 1, "the retry rebuilt the Agent — the conversation is gone"
    assert len(set(agent.prompts)) == 1, "the retry re-derived the prompt instead of re-sending it"
    # The partial the first attempt produced is kept and the retry appends to it.
    # A replay would show up here as ["part-", "part-", "rest"].
    assert _deltas(frames) == ["part-", "rest"], f"got {_deltas(frames)}"
    assert ns["_test_saved"][-1][-1] == "part-rest", (
        f"Memory must hold one continuous reply; got {ns['_test_saved'][-1][-1]!r}"
    )
    assert errors == [], "a turn that RECOVERED must not publish agent.error"
    assert deaths == [], "a recovered turn that reported completion is not a death"


@pytest.mark.asyncio
async def test_a_deterministic_error_is_not_retried() -> None:
    """One attempt, one agent.error carrying the ticket, and the raise propagates."""
    ns, agent_cls, errors, deaths = _load([
        [{"data": "half "}, ValidationException("messages.1: content must not be empty")],
        [{"data": "never reached"}],
    ])

    with pytest.raises(ValidationException):
        async for _ in ns["_run_agent_invocation"](PAYLOAD, CTX):
            pass

    (agent,) = agent_cls.instances
    assert agent.attempts == 1, f"a deterministic error must not be retried; got {agent.attempts}"
    assert len(errors) == 1, f"expected exactly one agent.error, got {errors}"
    args, kwargs = errors[0]
    assert args[0] == "wf_retry" and args[1] == "agentcore_hub_backend_dev"
    assert kwargs.get("ticket_id") == "TEAM-4739", (
        "agent.error must name the ticket, or the reaper cannot scope the failure "
        f"to the claim; got {kwargs}"
    )
    assert "ValidationException" in args[2]
    # FR-7 disjointness: a turn that published agent.error is NOT also a death.
    assert deaths == [], "agent.error and agent.died must be disjoint"


@pytest.mark.asyncio
async def test_the_attempt_cap_stops_an_endlessly_broken_stream() -> None:
    ns, agent_cls, errors, deaths = _load([[EventStreamError("stream closed")]])

    with pytest.raises(EventStreamError):
        async for _ in ns["_run_agent_invocation"](PAYLOAD, CTX):
            pass

    (agent,) = agent_cls.instances
    assert agent.attempts == ns["_STREAM_RETRY_MAX_ATTEMPTS"], (
        f"expected {ns['_STREAM_RETRY_MAX_ATTEMPTS']} attempts, got {agent.attempts}"
    )
    assert len(errors) == 1, f"agent.error must be published once, on exhaustion; got {errors}"
    assert "3 attempt" in errors[0][0][2], f"the error must say how many attempts it took: {errors}"
    assert deaths == []


@pytest.mark.asyncio
async def test_an_exhausted_wall_budget_stops_before_the_attempt_cap() -> None:
    """The budget is the real bound: 3 attempts against a 30-second stall would
    hold the claim for 90 seconds, so a blown budget gives up on attempt 1."""
    ns, agent_cls, errors, deaths = _load([[EventStreamError("stream closed")]])
    ns["_STREAM_RETRY_BUDGET_S"] = 0.0

    with pytest.raises(EventStreamError):
        async for _ in ns["_run_agent_invocation"](PAYLOAD, CTX):
            pass

    (agent,) = agent_cls.instances
    assert agent.attempts == 1, f"a spent budget must not be attempted against; got {agent.attempts}"
    assert len(errors) == 1, f"exactly one agent.error, even from the budget branch; got {errors}"
    assert deaths == []


@pytest.mark.asyncio
async def test_a_break_after_the_completion_gate_engaged_still_retries() -> None:
    """The gate suppresses post-completion TEXT; it does not end the stream. A
    break after it engaged is still a broken stream, and the retry must not
    resurrect the suppressed text into the reply."""

    def engage(agent: Any) -> None:
        gate = next(h for h in agent.hooks if getattr(h, "TOOL", "").endswith("report_completion"))
        gate._on_tool_result(
            SimpleNamespace(
                tool_use={"name": gate.TOOL},
                result={"status": "success", "content": [{"text": "recorded"}]},
            )
        )

    ns, agent_cls, errors, deaths = _load([
        [{"data": "the answer"}, engage, EventStreamError("closed after report_completion")],
        [{"data": "trailing"}],
    ])

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]

    assert _deltas(frames) == ["the answer"], (
        f"post-completion text must stay suppressed across a retry; got {_deltas(frames)}"
    )
    assert agent_cls.instances[0].attempts == 2
    assert errors == [] and deaths == []
