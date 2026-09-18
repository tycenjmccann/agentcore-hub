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
  2. A retry re-enters `stream_async` on the SAME Agent object and everything the
     turn had already produced survives: text is APPENDED, never replayed, so the
     caller sees no duplicate delta and Memory records one continuous reply. The
     prompt is never re-derived and — TEAM-4749 A2 — never re-SENT: strands
     `_convert_prompt_to_messages` appends a fresh user message for any str, so
     re-sending it left two adjacent user messages in history and Bedrock answered
     ValidationException, which the classifier correctly calls `fail`. A retry
     therefore passes `[]`, which appends nothing and still runs the vendored
     dangling-toolUse repair (`None` skips that repair; truncating history would
     discard the tool results already produced). Asserted as history SHAPE below,
     because "one copy of the prompt, roles alternating, a user message last" is
     what Bedrock actually requires.
  2b. TEAM-4749 A3 — the wall budget bounds RETRY time, armed at the FIRST
     failure. Armed at the top of the turn it was already spent by the time a long
     turn broke, so every break past minute 1 gave up on attempt 1 and FR-6 never
     fired on the only turns long enough to need it.
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
            self.prompts: list[Any] = []
            # TEAM-4749 A2: a miniature of the real conversation manager. The retry
            # decision is about MESSAGE HISTORY, so an Agent double without history
            # cannot express the bug — the old double accepted a re-sent prompt
            # silently, which is exactly how this shipped.
            self.messages: list[dict[str, Any]] = []
            self.hooks = list(kwargs.get("hooks") or [])
            type(self).instances.append(self)

        async def stream_async(self, prompt: Any):
            index = self.attempts
            self.attempts += 1
            self.prompts.append(prompt)
            # strands 1.53/1.54 `_convert_prompt_to_messages`, in the order it
            # runs: for any prompt that is not None, a dangling assistant(toolUse)
            # tail first gets a synthetic user(toolResult) appended; THEN a str
            # becomes a fresh user message, while an empty list becomes nothing.
            # `None` skips the repair as well as the append, which is why the
            # production code passes `[]` and not `None`.
            if prompt is not None:
                if self.messages and any("toolUse" in c for c in self.messages[-1]["content"]):
                    self.messages.append(
                        {"role": "user", "content": [{"toolResult": {"status": "error"}}]}
                    )
                if isinstance(prompt, str):
                    self.messages.append({"role": "user", "content": [{"text": prompt}]})
            for step in scripts[index] if index < len(scripts) else scripts[-1]:
                if isinstance(step, BaseException):
                    raise step
                if callable(step):
                    step(self)
                else:
                    yield step

    return _FlakyAgent


def _tool_cycle(agent: Any) -> None:
    """Append an assistant(toolUse) with NO result yet — a stream that died between
    asking for a tool and recording its answer, which is the tail Bedrock rejects
    and the one shape a naive `None` re-entry would leave broken."""
    agent.messages.append(
        {"role": "assistant", "content": [{"toolUse": {"toolUseId": "tu-1", "name": "read"}}]}
    )


def _tool_cycle_closed(agent: Any) -> None:
    """A COMPLETED tool cycle: assistant(toolUse) then user(toolResult). History is
    already valid, so the retry must add nothing at all."""
    _tool_cycle(agent)
    agent.messages.append(
        {"role": "user", "content": [{"toolResult": {"toolUseId": "tu-1", "status": "success"}}]}
    )


def _roles(agent: Any) -> list[str]:
    return [m["role"] for m in agent.messages]


def _prompt_copies(agent: Any, text: str) -> int:
    return sum(
        1
        for m in agent.messages
        if any(c.get("text") == text for c in m["content"] if isinstance(c, dict))
    )


def _assert_valid_history(agent: Any) -> None:
    """What Bedrock's ConverseStream actually requires of the history it is handed:
    strictly alternating roles, and the last message is the user's — anything else
    is the ValidationException this fix exists to stop causing."""
    roles = _roles(agent)
    assert roles, "no history at all — the double never recorded a message"
    for i in range(1, len(roles)):
        assert roles[i] != roles[i - 1], f"two adjacent {roles[i]} messages: {roles}"
    assert roles[-1] == "user", f"history must end on the user's turn; got {roles}"


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
    # TEAM-4749 A2: stronger than the old `len(set(prompts)) == 1`, which could only
    # say "the prompt was never re-derived" and would now TypeError on an unhashable
    # []. This says that AND that the retries sent no prompt at all.
    assert agent.prompts[0] == PAYLOAD["prompt"], "attempt 1 must deliver the derived prompt"
    assert agent.prompts[1:] == [[], []], (
        f"each retry must re-enter with [], not the prompt; got {agent.prompts[1:]!r}"
    )
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
    hold the claim for 90 seconds, so a spent budget gives up on attempt 1.

    Still true after TEAM-4749 A3 moved the arming point into the failure handler,
    but for a different reason: a 0.0 budget now means "no retry time is allowed at
    all" rather than "the turn already consumed it", and `remaining <= 0` fires on
    the first failure either way. The 60s-of-real-retrying case that A3 actually
    changed is `test_the_budget_still_exhausts_after_60s_of_retrying` below."""
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


# ─── 4. TEAM-4749 A2: the retry leaves a history Bedrock will accept ──────────


@pytest.mark.asyncio
async def test_retry_sends_the_prompt_exactly_once() -> None:
    """The A2 defect, stated as the thing that broke: a re-sent str prompt put a
    SECOND user message next to the first, Bedrock answered ValidationException,
    and `_classify_stream_error` correctly called that `fail` — so the retry that
    exists to save the turn was guaranteed to destroy it."""
    ns, agent_cls, errors, deaths = _load([
        [{"data": "part-"}, EventStreamError("stream closed")],
        [{"data": "rest"}, _engage_completion],
    ])

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]
    (agent,) = agent_cls.instances

    assert agent.attempts == 2
    assert agent.prompts == [PAYLOAD["prompt"], []], f"got {agent.prompts!r}"
    assert _prompt_copies(agent, PAYLOAD["prompt"]) == 1, (
        f"the prompt is in history {_prompt_copies(agent, PAYLOAD['prompt'])} times: "
        f"{_roles(agent)}"
    )
    _assert_valid_history(agent)
    assert _deltas(frames) == ["part-", "rest"]
    assert errors == [] and deaths == []


@pytest.mark.asyncio
async def test_retry_after_a_tool_cycle_leaves_a_valid_alternating_tail() -> None:
    """The second failure shape, and the reason the retry passes `[]` rather than
    `None`: a stream that died after asking for a tool but before the result landed
    leaves an assistant(toolUse) tail, which Bedrock rejects. Strands' own repair
    appends the synthetic user(toolResult) for any prompt that is not None — `[]`
    gets the repair, `None` skips it."""
    ns, agent_cls, errors, deaths = _load([
        [{"data": "calling "}, _tool_cycle, EventStreamError("stream closed mid-cycle")],
        [{"data": "done"}, _engage_completion],
    ])

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]
    (agent,) = agent_cls.instances

    assert agent.prompts == [PAYLOAD["prompt"], []]
    assert _roles(agent) == ["user", "assistant", "user"], (
        f"the dangling toolUse was not repaired: {_roles(agent)}"
    )
    assert any("toolResult" in c for c in agent.messages[-1]["content"]), (
        "the repair must be a toolResult, not another copy of the prompt"
    )
    _assert_valid_history(agent)
    assert _prompt_copies(agent, PAYLOAD["prompt"]) == 1
    assert _deltas(frames) == ["calling ", "done"]
    assert errors == [] and deaths == []


@pytest.mark.asyncio
async def test_retry_after_a_completed_tool_cycle_adds_nothing() -> None:
    """A turn whose tool cycle CLOSED before the break already has valid history,
    and the tool results it produced are exactly what FR-6 promises to keep. The
    retry must not append, and must not truncate."""
    ns, agent_cls, errors, deaths = _load([
        [_tool_cycle_closed, EventStreamError("stream closed after the cycle")],
        [{"data": "carrying on"}, _engage_completion],
    ])

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]
    (agent,) = agent_cls.instances

    assert _roles(agent) == ["user", "assistant", "user"]
    assert any("toolResult" in c for c in agent.messages[-1]["content"]), (
        "the tool result the turn already produced was discarded"
    )
    _assert_valid_history(agent)
    assert _deltas(frames) == ["carrying on"]
    assert errors == [] and deaths == []


@pytest.mark.asyncio
async def test_retry_resends_the_prompt_if_it_never_reached_history() -> None:
    """The honest fallback. If attempt 1 broke before the prompt was delivered
    there is nothing in history to continue from, and re-entering with `[]` would
    ask the model to answer a conversation that does not exist. `[]` is only
    correct once the prompt is provably in history."""

    class _PreDeliveryFailure:
        """A double whose attempt 1 dies BEFORE recording anything, so `messages` is
        still at the baseline when the retry decides what to send. `_FlakyAgent`
        cannot express this: it records the prompt before running its script."""

        instances: list[Any] = []

        def __init__(self, **kwargs: Any) -> None:
            self.attempts = 0
            self.prompts: list[Any] = []
            self.messages: list[dict[str, Any]] = []
            self.hooks = list(kwargs.get("hooks") or [])
            type(self).instances.append(self)

        async def stream_async(self, prompt: Any):
            self.attempts += 1
            self.prompts.append(prompt)
            if self.attempts == 1:
                # Nothing appended: the socket died before the request was accepted.
                raise EventStreamError("closed before the request was accepted")
            if isinstance(prompt, str):
                self.messages.append({"role": "user", "content": [{"text": prompt}]})
            yield {"data": "second try"}
            _engage_completion(self)

    _PreDeliveryFailure.instances = []
    # The scripts are unused — _PreDeliveryFailure ignores them and drives itself.
    ns, _unused, errors, deaths = _load([[]], Agent=_PreDeliveryFailure)

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]
    (agent,) = _PreDeliveryFailure.instances

    assert agent.attempts == 2
    assert agent.prompts[1] == PAYLOAD["prompt"], (
        "an undelivered prompt must be RE-SENT, not swapped for []; "
        f"got {agent.prompts[1]!r}"
    )
    assert _prompt_copies(agent, PAYLOAD["prompt"]) == 1
    assert _deltas(frames) == ["second try"]
    assert errors == [] and deaths == []


# ─── 5. TEAM-4749 A3: the budget clocks from the first failure ────────────────
#
# A scripted `monotonic` rather than real sleeping: the behaviour under test is
# arithmetic on a clock, and waiting 400 real seconds to assert it would be a
# test nobody runs. `time.time`/`strftime`/`gmtime` stay REAL — the event-id
# stamper in the shipped source uses them and does not care about our fiction.


def _scripted_clock(readings: list[float]):
    """A `time` stand-in whose `monotonic` walks a script and then holds its last
    value, so an extra reading cannot make the test fail as an IndexError."""
    import time as _real_time

    state = {"i": 0}

    def monotonic() -> float:
        i = state["i"]
        state["i"] = min(i + 1, len(readings) - 1)
        return readings[i]

    return SimpleNamespace(
        monotonic=monotonic,
        time=_real_time.time,
        strftime=_real_time.strftime,
        gmtime=_real_time.gmtime,
        sleep=lambda *_a: None,
    )


@pytest.mark.asyncio
async def test_a_failure_after_five_minutes_is_still_retried() -> None:
    """The A3 defect. The budget was armed before the retry loop, so it measured
    STREAM duration: a persona turn that ran 400s and then hit one transient break
    arrived with `remaining` already negative and gave up on attempt 1. Since every
    persona turn is long, FR-6 effectively never retried in production."""
    # Readings: the deadline arm and the `remaining` read on each failure, all at
    # t=400s and later — a clock that has already run far past the old 60s budget.
    clock = _scripted_clock([400.0, 400.0, 400.1, 400.2, 400.3, 400.4, 400.5])
    ns, agent_cls, errors, deaths = _load(
        [
            [{"data": "a"}, EventStreamError("stream closed")],
            [ThrottlingException("Too many requests")],
            [{"data": "b"}, _engage_completion],
        ],
        time=clock,
    )

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]
    (agent,) = agent_cls.instances

    assert agent.attempts == 3, (
        "a break 400s into a turn must still get its retries — the budget bounds "
        f"RETRY time, not stream time; got {agent.attempts} attempt(s)"
    )
    assert agent.prompts == [PAYLOAD["prompt"], [], []]
    _assert_valid_history(agent)
    assert _deltas(frames) == ["a", "b"]
    assert errors == [], "a turn that recovered on the third attempt is not an error"
    assert deaths == []


@pytest.mark.asyncio
async def test_the_budget_still_exhausts_after_60s_of_retrying() -> None:
    """The other half of A3: arming later must not make the budget unbounded. 61
    seconds of ACTUAL retrying still stops before the attempt cap — which no
    existing test covered, because the old clock could never get there."""
    # Arm at t=1000, then the next failure reads a clock 61s later: past budget.
    clock = _scripted_clock([1000.0, 1000.0, 1061.0, 1061.0, 1062.0])
    ns, agent_cls, errors, deaths = _load(
        [[EventStreamError("stream closed")]], time=clock
    )

    with pytest.raises(EventStreamError):
        async for _ in ns["_run_agent_invocation"](PAYLOAD, CTX):
            pass

    (agent,) = agent_cls.instances
    assert agent.attempts == 2, (
        "60s of retrying is the bound; the cap of 3 must not be reached here — "
        f"got {agent.attempts}"
    )
    assert agent.attempts < ns["_STREAM_RETRY_MAX_ATTEMPTS"]
    assert len(errors) == 1, f"exactly one agent.error from the budget branch; got {errors}"
    assert deaths == []
