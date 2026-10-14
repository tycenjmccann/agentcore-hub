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
     that recovered. A DETERMINISTIC failure is a crash: agent.error only, no
     `agent.died` — the two stay disjoint (FR-7). TEAM-5963: a TRANSIENT failure
     that ran out of retries is the one exception — it publishes its agent.error
     AND ends as a death (`reason="transient_exhaustion"`, resume object written,
     a `[transient-exhaustion]` comment on the ticket), because a crash leaves the
     ticket in_progress behind a running claim and only a death lets the
     dead-session detector re-dispatch it.
  4. TEAM-5963: the window is sized for a Bedrock brownout (10 attempts, 300s of
     backoff SLEEP, ceilings capped at 60s), and a long backoff renews the lease
     with `agent.streaming` heartbeats so the wait never reads as silence.

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


class ModelNotReadyException(Exception):
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
            # TEAM-5706: a real HookRegistry, wired exactly like strands' own
            # Agent constructor — main.py's _PromptDelivery hook (FR-6's delivery
            # check) listens on MessageAddedEvent, so a double that only stored
            # `self.hooks` without firing it would read every retry as
            # "never delivered" and re-send the prompt forever.
            from strands.hooks import HookRegistry, MessageAddedEvent
            self._message_added_event = MessageAddedEvent
            self.registry = HookRegistry()
            for hook in self.hooks:
                if hasattr(hook, "register_hooks"):
                    self.registry.add_hook(hook)
            type(self).instances.append(self)

        def _append(self, message: dict[str, Any]) -> None:
            self.messages.append(message)
            self.registry.invoke_callbacks(self._message_added_event(agent=self, message=message))

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
                    self._append({"role": "user", "content": [{"toolResult": {"status": "error"}}]})
                if isinstance(prompt, str):
                    self._append({"role": "user", "content": [{"text": prompt}]})
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
    # TEAM-5963: one ordered log of the teardown side effects, plus the sleeps the
    # backoff asked for (the seam records instead of waiting).
    log: list[str] = []
    sleeps: list[float] = []
    comments: list[dict] = []
    resumes: list[tuple] = []

    async def _no_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    def _comment(**kwargs: Any) -> str:
        log.append("comment")
        comments.append(kwargs)
        return "ok"

    def _error(*a: Any, **k: Any) -> None:
        log.append("error")
        errors.append((a, k))

    def _died(*a: Any, **k: Any) -> None:
        log.append("died")
        deaths.append((a, k))

    def _resume(*a: Any, **k: Any) -> None:
        log.append("resume")
        resumes.append((a, k))

    ns = _load_production_entrypoints(
        overrides={
            "Agent": agent_cls,
            "_publish_agent_error": _error,
            "_publish_agent_died": _died,
            "_write_resume_object": _resume,
            "Tickets___add_comment": _comment,
            "_save_memory_event": lambda *a: saved.append(a),
            **overrides,
        }
    )
    ns["_STREAM_RETRY_BASE_S"] = 0.0
    # After the exec, not in `overrides`: the shipped source defines the seam
    # itself, so an override passed in would be clobbered.
    ns["_stream_retry_sleep"] = _no_sleep
    ns["_test_agent_class"] = agent_cls
    ns["_test_saved"] = saved
    ns["_test_log"] = log
    ns["_test_sleeps"] = sleeps
    ns["_test_comments"] = comments
    ns["_test_resumes"] = resumes
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
    ModelNotReadyException("model is not ready to serve requests"),
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
    base = ns["_STREAM_RETRY_BASE_S"]
    for attempt, ceiling in ((1, base), (2, 2 * base), (3, 4 * base)):
        samples = [delay(attempt, 600.0) for _ in range(200)]
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


def test_backoff_ceiling_is_capped() -> None:
    """TEAM-5963: past the cap the ceiling stops doubling, so attempts 7-10 keep
    probing every <=60s instead of one 4-minute silence."""
    ns = _load_production_entrypoints()
    delay = ns["_stream_retry_delay"]
    cap = ns["_STREAM_RETRY_CAP_S"]
    assert all(delay(10, 10_000.0) <= cap for _ in range(200))


def test_the_wall_budget_and_attempt_cap_are_the_documented_ones() -> None:
    """TEAM-5961/5963: the old pin was `BUDGET_S <= 60` — it pinned the defect. A
    60s window cannot outlast a Bedrock brownout (ServiceUnavailableException for
    a minute or two), so every such outage cost the whole turn. The invariant now
    is "survive ~5 minutes of backoff, and stay bounded": enough attempts to use
    that window, and a per-retry cap that fits inside it."""
    ns = _load_production_entrypoints()
    assert ns["_STREAM_RETRY_MAX_ATTEMPTS"] >= 6
    assert ns["_STREAM_RETRY_BUDGET_S"] >= 300.0
    assert 0 < ns["_STREAM_RETRY_CAP_S"] <= ns["_STREAM_RETRY_BUDGET_S"]
    assert ns["_STREAM_RETRY_HEARTBEAT_S"] < 15 * 60, (
        "a backoff slice must renew the lease well inside the platform's 15-min idle kill"
    )


@pytest.mark.parametrize(
    "raw, expected",
    [(None, None), ("", None), ("abc", None), ("0", None), ("-3", None), ("4", 4)],
    ids=["unset", "empty", "garbage", "zero", "negative", "valid"],
)
def test_stream_retry_env_knobs_fall_back_on_garbage(monkeypatch, raw, expected) -> None:
    """The four STREAM_RETRY_* knobs parse through `_wd_num`: a typo in the
    runtime env must fall back to the default, never disable retrying (0) or
    crash the module at import."""
    defaults = {
        "STREAM_RETRY_MAX_ATTEMPTS": ("_STREAM_RETRY_MAX_ATTEMPTS", 10),
        "STREAM_RETRY_BUDGET_S": ("_STREAM_RETRY_BUDGET_S", 300.0),
        "STREAM_RETRY_BASE_S": ("_STREAM_RETRY_BASE_S", 2.0),
        "STREAM_RETRY_CAP_S": ("_STREAM_RETRY_CAP_S", 60.0),
    }
    for env, (name, default) in defaults.items():
        if raw is None:
            monkeypatch.delenv(env, raising=False)
        else:
            monkeypatch.setenv(env, raw)
        ns = _load_production_entrypoints()
        want = default if expected is None else expected
        assert ns[name] == want, f"{env}={raw!r} -> {ns[name]!r}, expected {want!r}"
        monkeypatch.delenv(env, raising=False)


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
@pytest.mark.parametrize(
    "exc",
    [
        InternalServerException("the model service failed mid-stream"),
        EventStreamError("An error occurred (InternalServerException) reading the event stream"),
    ],
    ids=["bare", "wrapped"],
)
async def test_internal_server_exception_midstream_recovers_in_turn(exc: BaseException) -> None:
    """The exact failure the fleet hit (TEAM-4764 P3): an ISE mid-stream, bare or
    wrapped as an EventStreamError, recovers on the SAME Agent — 2 attempts, one
    instance, no replayed prompt, no duplicate delta."""
    ns, agent_cls, errors, deaths = _load([
        [{"data": "the first half "}, exc],
        [{"data": "and the second"}, _engage_completion],
    ])

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]
    (agent,) = agent_cls.instances

    assert agent.attempts == 2, f"expected 2 stream_async attempts, got {agent.attempts}"
    assert len(agent_cls.instances) == 1, "the retry rebuilt the Agent — the conversation is gone"
    assert agent.prompts[0] == PAYLOAD["prompt"], "attempt 1 must deliver the derived prompt"
    assert agent.prompts[1:] == [[]], (
        f"the retry must re-enter with [], not the prompt; got {agent.prompts[1:]!r}"
    )
    assert _deltas(frames) == ["the first half ", "and the second"], f"got {_deltas(frames)}"
    assert ns["_test_saved"][-1][-1] == "the first half and the second", (
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
    cap = ns["_STREAM_RETRY_MAX_ATTEMPTS"]
    assert f"{cap} attempt" in errors[0][0][2], (
        f"the error must say how many attempts it took: {errors}"
    )
    # TEAM-5963: transient exhaustion ends as a recoverable death.
    assert len(deaths) == 1, f"transient exhaustion must publish one agent.died; got {deaths}"


@pytest.mark.asyncio
async def test_an_exhausted_wall_budget_stops_before_the_attempt_cap() -> None:
    """The budget is the real bound: 3 attempts against a 30-second stall would
    hold the claim for 90 seconds, so a spent budget gives up on attempt 1.

    Still true after TEAM-4749 A3 moved the arming point into the failure handler,
    but for a different reason: a 0.0 budget now means "no retry time is allowed at
    all" rather than "the turn already consumed it", and `remaining <= 0` fires on
    the first failure either way. The 60s-of-real-retrying case that A3 actually
    changed is `test_the_sleep_budget_exhausts_before_the_attempt_cap` below."""
    ns, agent_cls, errors, deaths = _load([[EventStreamError("stream closed")]])
    ns["_STREAM_RETRY_BUDGET_S"] = 0.0

    with pytest.raises(EventStreamError):
        async for _ in ns["_run_agent_invocation"](PAYLOAD, CTX):
            pass

    (agent,) = agent_cls.instances
    assert agent.attempts == 1, f"a spent budget must not be attempted against; got {agent.attempts}"
    assert len(errors) == 1, f"exactly one agent.error, even from the budget branch; got {errors}"
    assert len(deaths) == 1, "a transient error that hit the budget is still a recoverable death"


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


class _CeilingRandom(__import__("random").Random):
    """`random` whose `uniform` returns the top of the range: the full-jitter
    delay becomes its deterministic ceiling, so backoff arithmetic is testable."""

    def uniform(self, a: float, b: float) -> float:
        return b


@pytest.mark.asyncio
async def test_the_sleep_budget_exhausts_before_the_attempt_cap() -> None:
    """The other half of A3, restated for TEAM-5963: arming later must not make
    the budget unbounded, and the budget is cumulative BACKOFF SLEEP. Ceilings
    4s, then 8s clipped to the 1s left: 5s slept, budget spent, the third failure
    gives up — well before the 10-attempt cap."""
    ns, agent_cls, errors, deaths = _load(
        [[EventStreamError("stream closed")]], random=_CeilingRandom()
    )
    ns["_STREAM_RETRY_BASE_S"] = 4.0
    ns["_STREAM_RETRY_BUDGET_S"] = 5.0

    with pytest.raises(EventStreamError):
        async for _ in ns["_run_agent_invocation"](PAYLOAD, CTX):
            pass

    (agent,) = agent_cls.instances
    assert agent.attempts == 3, f"expected the budget to stop attempt 3; got {agent.attempts}"
    assert agent.attempts < ns["_STREAM_RETRY_MAX_ATTEMPTS"]
    assert ns["_test_sleeps"] == [4.0, 1.0], f"got {ns['_test_sleeps']}"
    assert sum(ns["_test_sleeps"]) == ns["_STREAM_RETRY_BUDGET_S"]
    assert len(errors) == 1, f"exactly one agent.error from the budget branch; got {errors}"
    assert len(deaths) == 1


# ─── 6. TEAM-5963: survive the brownout; exhaustion is a recoverable death ────


@pytest.mark.asyncio
async def test_four_service_unavailable_then_success_resumes_same_agent() -> None:
    """The TEAM-5961 incident: a closed tool cycle, then Bedrock answers
    ServiceUnavailableException four times running. Main gave up on attempt 3;
    the turn must now ride it out on the SAME Agent, keeping the tool result."""
    tool_runs: list[int] = []

    def tool_cycle_once(agent: Any) -> None:
        tool_runs.append(1)
        _tool_cycle_closed(agent)

    su = ServiceUnavailableException("Bedrock is unable to process your request")
    ns, agent_cls, errors, deaths = _load([
        [tool_cycle_once, su],
        [su],
        [su],
        [su],
        [{"data": "recovered"}, _engage_completion],
    ])

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]

    assert len(agent_cls.instances) == 1, "the retry rebuilt the Agent — the conversation is gone"
    (agent,) = agent_cls.instances
    assert agent.attempts == 5, f"expected 5 stream_async attempts, got {agent.attempts}"
    assert agent.prompts[0] == PAYLOAD["prompt"]
    assert agent.prompts[1:] == [[]] * 4, f"retries must re-enter with []; got {agent.prompts[1:]!r}"
    assert tool_runs == [1], "the completed tool must not run again"
    assert any("toolResult" in c for m in agent.messages for c in m["content"]), (
        "the tool result the turn already produced was discarded"
    )
    _assert_valid_history(agent)
    assert _prompt_copies(agent, PAYLOAD["prompt"]) == 1
    assert _deltas(frames) == ["recovered"]
    assert errors == [] and deaths == []
    assert ns["_test_comments"] == [] and ns["_test_resumes"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "exc",
    [
        ValidationException("messages.1: content must not be empty"),
        AccessDeniedException("not authorized to invoke bedrock"),
        MaxTokensReachedException("max output tokens reached"),
    ],
    ids=lambda e: type(e).__name__,
)
async def test_non_transient_fails_fast_without_death(exc: BaseException) -> None:
    """A deterministic error keeps today's semantics exactly: one attempt, no
    backoff, one agent.error, and NOT a death — re-dispatching it would fail the
    same way, three more times."""
    ns, agent_cls, errors, deaths = _load([[{"data": "half "}, exc]])

    with pytest.raises(type(exc)):
        async for _ in ns["_run_agent_invocation"](PAYLOAD, CTX):
            pass

    (agent,) = agent_cls.instances
    assert agent.attempts == 1
    assert ns["_test_sleeps"] == []
    assert len(errors) == 1
    assert deaths == [], "a deterministic crash must not be re-dispatched by the detector"
    assert ns["_test_comments"] == [], "no transient-exhaustion comment for a deterministic error"
    assert ns["_test_resumes"] == []


@pytest.mark.asyncio
async def test_transient_exhaustion_publishes_one_error_then_death_with_resume() -> None:
    """10x ServiceUnavailable: the turn gives up, and ends as a death the
    detector can recover — one agent.error, one agent.died stamped with the claim
    generation and `reason="transient_exhaustion"`, the resume object, and a
    reason comment on the ticket. In that order: the comment and the error are
    written while the turn is still alive, the death and resume in its teardown."""
    ns, agent_cls, errors, deaths = _load(
        [[ServiceUnavailableException("Bedrock is unable to process your request")]]
    )
    payload = {**PAYLOAD, "claim_started_at": "2026-10-14T12:00:00.000Z"}

    with pytest.raises(ServiceUnavailableException):
        async for _ in ns["_run_agent_invocation"](payload, CTX):
            pass

    (agent,) = agent_cls.instances
    assert agent.attempts == ns["_STREAM_RETRY_MAX_ATTEMPTS"] == 10
    assert len(errors) == 1, f"exactly one agent.error; got {errors}"
    assert "10 attempt" in errors[0][0][2]
    assert len(deaths) == 1, f"exactly one agent.died; got {deaths}"
    args, kwargs = deaths[0]
    assert args[:3] == ("wf_retry", "agentcore_hub_backend_dev", "TEAM-4739")
    assert kwargs["reason"] == "transient_exhaustion"
    assert kwargs["claim_started_at"] == "2026-10-14T12:00:00.000Z", (
        "the death must carry the claim generation, or the detector ignores it"
    )
    assert len(ns["_test_resumes"]) == 1, "the resume object must be written"
    (comment,) = ns["_test_comments"]
    assert comment["ticket_id"] == "TEAM-4739"
    assert "[transient-exhaustion]" in comment["comment"]
    assert "ServiceUnavailableException" in comment["comment"]
    assert ns["_test_log"] == ["comment", "error", "died", "resume"], ns["_test_log"]


@pytest.mark.asyncio
async def test_transient_exhaustion_survives_comment_failure() -> None:
    """The comment is best-effort: a broken ticket backend must not cost the
    death and the resume object, which are what actually recover the ticket."""

    def broken(**kwargs: Any) -> str:
        raise RuntimeError("tickets lambda is down too")

    ns, agent_cls, errors, deaths = _load(
        [[ServiceUnavailableException("unavailable")]], Tickets___add_comment=broken
    )

    with pytest.raises(ServiceUnavailableException):
        async for _ in ns["_run_agent_invocation"](PAYLOAD, CTX):
            pass

    assert len(errors) == 1
    assert len(deaths) == 1 and deaths[0][1]["reason"] == "transient_exhaustion"
    assert len(ns["_test_resumes"]) == 1


@pytest.mark.asyncio
async def test_a_70s_backoff_emits_heartbeats() -> None:
    """A long backoff sleeps in <=30s slices, publishing a lease-renewing
    agent.streaming event (stamped with agent and ticket, so lastAgentActivity
    counts it) before each — 70s of silence would otherwise age the lease."""
    puts: list[dict] = []
    ns, agent_cls, errors, deaths = _load(
        [
            [ServiceUnavailableException("unavailable")],
            [{"data": "ok"}, _engage_completion],
        ],
        random=_CeilingRandom(),
        _ddb_events_client=SimpleNamespace(put_item=lambda **kw: puts.append(kw)),
    )
    ns["_STREAM_RETRY_BASE_S"] = 70.0
    ns["_STREAM_RETRY_CAP_S"] = 120.0

    [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]

    assert ns["_test_sleeps"] == [30.0, 30.0, 10.0], f"got {ns['_test_sleeps']}"
    beats = [
        {k: v["S"] for k, v in p["Item"]["detail"]["M"].items()}
        for p in puts
        if p["Item"]["type"]["S"] == "agent.streaming"
        and p["Item"]["detail"]["M"].get("retryBackoff", {}).get("S") == "true"
    ]
    assert len(beats) >= 2, f"expected a heartbeat per backoff slice; got {beats}"
    for beat in beats:
        assert beat["agentId"] == "agentcore_hub_backend_dev"
        assert beat["ticketId"] == "TEAM-4739"
    assert errors == [] and deaths == []


@pytest.mark.asyncio
async def test_model_not_ready_is_retryable() -> None:
    """ModelNotReadyException is Bedrock's 'capacity is coming back' answer."""
    ns, agent_cls, errors, deaths = _load([
        [ModelNotReadyException("model is not ready")],
        [{"data": "ok"}, _engage_completion],
    ])

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]

    assert ns["_classify_stream_error"](ModelNotReadyException("x")) == "retry"
    assert agent_cls.instances[0].attempts == 2
    assert _deltas(frames) == ["ok"]
    assert errors == [] and deaths == []


@pytest.mark.asyncio
async def test_detached_exhaustion_publishes_agent_error_once() -> None:
    """The detached runner used to publish its own agent.error for any exception
    it caught, so an exhausted stream produced two errors for one failure."""
    import asyncio

    ns, agent_cls, errors, deaths = _load([[ServiceUnavailableException("unavailable")]])

    acks = [f async for f in ns["agent_invocation"]({**PAYLOAD, "detach": True}, CTX)]
    assert "accepted" in str(acks)
    await asyncio.gather(*list(ns["_DETACHED_TASKS"]))

    assert len(errors) == 1, f"one failure, one agent.error; got {errors}"
    assert len(deaths) == 1
