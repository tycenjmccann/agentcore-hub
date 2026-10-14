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
     turn had already COMMITTED survives: completed messages and their tool
     results. TEAM-5976 F5: the INCOMPLETE assistant message is not in history
     (strands appends it only once its stream finishes), so the retry regenerates
     it from scratch — its partial text is rolled back out of the reply, Memory and
     the resume object, and the caller, which already saw it, gets one notice
     line instead of a silent duplicate. The
     prompt is never re-derived and — TEAM-4749 A2 — never re-SENT: strands
     `_convert_prompt_to_messages` appends a fresh user message for any str, so
     re-sending it left two adjacent user messages in history and Bedrock answered
     ValidationException, which the classifier correctly calls `fail`. A retry
     therefore passes `[]`, which appends nothing and still runs the vendored
     dangling-toolUse repair (`None` skips that repair; truncating history would
     discard the tool results already produced). Asserted as history SHAPE below,
     because "one copy of the prompt, roles alternating, a user message last" is
     what Bedrock actually requires.
  2b. TEAM-4749 A3 — the retry window bounds RETRY time, armed at the FIRST
     failure. Armed at the top of the turn it was already spent by the time a long
     turn broke, so every break past minute 1 gave up on attempt 1 and FR-6 never
     fired on the only turns long enough to need it. TEAM-5976 F3: it is a
     WALL-CLOCK deadline on one contiguous outage (attempt time counts, not only
     sleep), re-armed when an attempt completes a message, and strands' own
     retry layer is off so this is the only one.
  3. `agent.error` is published exactly once, only after the retries are
     exhausted (or immediately for a deterministic error), and never on a turn
     that recovered. A DETERMINISTIC failure is a crash: agent.error only, no
     `agent.died` — the two stay disjoint (FR-7). TEAM-5963: a TRANSIENT failure
     that ran out of retries is the one exception — it publishes its agent.error
     AND ends as a death (`reason="transient_exhaustion"`, resume object written,
     a `[transient-exhaustion]` comment on the ticket), because a crash leaves the
     ticket in_progress behind a running claim and only a death lets the
     dead-session detector re-dispatch it.
  4. TEAM-5963: the window is sized for a Bedrock brownout (10 attempts, ceilings
     capped at 60s; TEAM-5976: a 600s wall-clock deadline), and a long backoff
     renews the lease with `agent.streaming` heartbeats so the wait never reads as
     silence. TEAM-5976 F1: so does a model call that has gone quiet in flight.

Hermetic: the Agent is a scripted fake and the shipped `_run_agent_invocation`
source is exec'd from main.py by the loader in test_telemetry_spans.py (main.py
cannot be imported — its module top-level installs Node.js, fetches from S3 and
chdirs).
"""

from __future__ import annotations

import inspect
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
            # TEAM-5976: the constructor kwargs, so a test can pin how the Agent
            # was built (retry_strategy=None — one retry layer, not two).
            self.kwargs = kwargs
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
                if inspect.iscoroutinefunction(step):
                    # TEAM-5976: an awaited step is time passing inside the attempt
                    # (a model call that has gone quiet, or a tool running).
                    await step(self)
                elif callable(step):
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


# TEAM-5976 F5: the one line a caller sees where a regenerated partial restarts.
# Pinned as a literal (and against the shipped constant below) so a base-code run
# fails on the duplicated text, not on a missing name.
NOTICE = "\n\n[stream interrupted - the reply restarts below]\n\n"


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
        # TEAM-5976 F2: the chain walk, itself pure (pinned below).
        "_exc_chain",
        "join",
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
    is "survive a brownout, and stay bounded": enough attempts to use the window,
    a per-retry cap that fits inside it — and TEAM-5976 F3, a WALL-CLOCK deadline
    that still fits the whole 10-attempt ceiling schedule (2+4+…+60 ≈ 360s) once
    attempt time is charged too, and an in-flight heartbeat that lands several
    times inside the 30-minute lease."""
    ns = _load_production_entrypoints()
    assert ns["_STREAM_RETRY_MAX_ATTEMPTS"] >= 6
    assert ns["_STREAM_RETRY_DEADLINE_S"] == 600.0
    ceilings = sum(
        min(ns["_STREAM_RETRY_CAP_S"], ns["_STREAM_RETRY_BASE_S"] * 2 ** (n - 1))
        for n in range(1, ns["_STREAM_RETRY_MAX_ATTEMPTS"])
    )
    assert ceilings < ns["_STREAM_RETRY_DEADLINE_S"], ceilings
    assert 0 < ns["_STREAM_RETRY_CAP_S"] <= ns["_STREAM_RETRY_DEADLINE_S"]
    assert ns["_STREAM_RETRY_HEARTBEAT_S"] < 15 * 60, (
        "a backoff slice must renew the lease well inside the platform's 15-min idle kill"
    )
    assert ns["_STREAM_RETRY_INFLIGHT_HEARTBEAT_S"] == 60.0
    assert ns["_STREAM_RETRY_INFLIGHT_HEARTBEAT_S"] <= 300.0, "TTL/6 of the 30-min lease"


_ENV_KNOB_CASES = [
    (None, None), ("", None), ("abc", None), ("0", None), ("-3", None), ("4", 4),
    # TEAM-5976 F4: `int(float("inf"))` is an OverflowError, which `_wd_num` did
    # not catch — so `STREAM_RETRY_CAP_S=inf` crashed the runtime at IMPORT. nan
    # was always a ValueError. Fractions truncate, deterministically.
    ("inf", None), ("-inf", None), ("1e309", None), ("nan", None), ("2.9", 2), ("0.5", None),
]
_ENV_KNOB_IDS = [
    "unset", "empty", "garbage", "zero", "negative", "valid",
    "inf", "neg-inf", "overflow", "nan", "fraction-truncates", "fraction-to-zero",
]


def _assert_env_knobs(monkeypatch, defaults: dict, raw, expected) -> None:
    for env, (name, default) in defaults.items():
        if raw is None:
            monkeypatch.delenv(env, raising=False)
        else:
            monkeypatch.setenv(env, raw)
        ns = _load_production_entrypoints()
        want = default if expected is None else expected
        assert ns[name] == want, f"{env}={raw!r} -> {ns[name]!r}, expected {want!r}"
        monkeypatch.delenv(env, raising=False)


@pytest.mark.parametrize("raw, expected", _ENV_KNOB_CASES, ids=_ENV_KNOB_IDS)
def test_stream_retry_env_knobs_fall_back_on_garbage(monkeypatch, raw, expected) -> None:
    """The STREAM_RETRY_* knobs parse through `_wd_num`: a typo in the runtime env
    must fall back to the default, never disable retrying (0) or crash the module
    at import."""
    _assert_env_knobs(monkeypatch, {
        "STREAM_RETRY_MAX_ATTEMPTS": ("_STREAM_RETRY_MAX_ATTEMPTS", 10),
        "STREAM_RETRY_BASE_S": ("_STREAM_RETRY_BASE_S", 2.0),
        "STREAM_RETRY_CAP_S": ("_STREAM_RETRY_CAP_S", 60.0),
    }, raw, expected)


@pytest.mark.parametrize("raw, expected", _ENV_KNOB_CASES, ids=_ENV_KNOB_IDS)
def test_team5976_deadline_and_inflight_knobs_fall_back_on_garbage(
    monkeypatch, raw, expected
) -> None:
    """TEAM-5976 F1/F3: the two new knobs, through the same parser and table."""
    _assert_env_knobs(monkeypatch, {
        "STREAM_RETRY_DEADLINE_S": ("_STREAM_RETRY_DEADLINE_S", 600.0),
        "STREAM_RETRY_INFLIGHT_HEARTBEAT_S": ("_STREAM_RETRY_INFLIGHT_HEARTBEAT_S", 60.0),
    }, raw, expected)


def test_team5976_inflight_heartbeat_is_clamped_inside_the_lease(monkeypatch) -> None:
    """A beat every 15 minutes would let a 30-minute lease lapse on one late
    write; the knob is clamped to TTL/6."""
    monkeypatch.setenv("STREAM_RETRY_INFLIGHT_HEARTBEAT_S", "900")
    ns = _load_production_entrypoints()
    assert ns["_STREAM_RETRY_INFLIGHT_HEARTBEAT_S"] == 300.0


def test_team5976_watchdog_payload_inf_falls_back_to_legacy() -> None:
    """F4, the per-invocation caller: JSON `1e309` parses to inf, and
    `_resolve_watchdog` ran it through the same `int(float())` — an OverflowError
    out of a payload field killed the turn before it started."""
    ns = _load_production_entrypoints()
    resolved = ns["_resolve_watchdog"](
        {"watchdog": {"turnTimeoutSecs": float("inf"), "toolDeadlineSecs": "-inf"}}
    )
    assert resolved["turnTimeoutSecs"] == 1500
    assert resolved["toolDeadlineSecs"] == 600
    assert ns["_wd_num"](float("inf"), "nan", "7") == 7


# ─── 3. driven turns ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_two_transient_breaks_then_success() -> None:
    """3 attempts, one Agent, one prompt. TEAM-5976 F5: the partial of the broken
    attempt is REGENERATED by the retry (it was never committed to history), so
    it is rolled back out of the reply and a notice marks the restart."""
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
    # The caller already saw "part-" and cannot un-see it; the notice says the
    # reply restarts. The throttle that broke attempt 2 produced no text, so no
    # second notice.
    assert _deltas(frames) == ["part-", NOTICE, "rest"], f"got {_deltas(frames)}"
    assert ns["_test_saved"][-1][-1] == "rest", (
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
    instance, no replayed prompt, and (TEAM-5976 F5) the regenerated first half
    rolled back out of the reply."""
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
    assert _deltas(frames) == ["the first half ", NOTICE, "and the second"], (
        f"got {_deltas(frames)}"
    )
    assert ns["_test_saved"][-1][-1] == "and the second", (
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
    changed is `test_the_deadline_exhausts_before_the_attempt_cap` below."""
    ns, agent_cls, errors, deaths = _load([[EventStreamError("stream closed")]])
    ns["_STREAM_RETRY_DEADLINE_S"] = 0.0

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
    assert _deltas(frames) == ["part-", NOTICE, "rest"]
    assert errors == [] and deaths == []


@pytest.mark.asyncio
async def test_retry_after_a_tool_cycle_leaves_a_valid_alternating_tail() -> None:
    """The second failure shape, and the reason the retry passes `[]` rather than
    `None`: a stream that died after asking for a tool but before the result landed
    leaves an assistant(toolUse) tail, which Bedrock rejects. Strands' own repair
    appends the synthetic user(toolResult) for any prompt that is not None — `[]`
    gets the repair, `None` skips it."""
    # TEAM-5976: strands yields the `message` event once the assistant(toolUse)
    # message is committed — the text in it is history now, and survives.
    ns, agent_cls, errors, deaths = _load([
        [
            {"data": "calling "},
            _tool_cycle,
            {"message": {"role": "assistant", "content": [{"text": "calling "}]}},
            EventStreamError("stream closed mid-cycle"),
        ],
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
    assert _deltas(frames) == ["a", NOTICE, "b"]
    assert errors == [], "a turn that recovered on the third attempt is not an error"
    assert deaths == []


class _CeilingRandom(__import__("random").Random):
    """`random` whose `uniform` returns the top of the range: the full-jitter
    delay becomes its deterministic ceiling, so backoff arithmetic is testable."""

    def uniform(self, a: float, b: float) -> float:
        return b


@pytest.mark.asyncio
async def test_the_deadline_exhausts_before_the_attempt_cap() -> None:
    """The other half of A3, restated for TEAM-5976 F3: arming later must not make
    the window unbounded, and the window is WALL-CLOCK from the first failure.
    Failures at t=0, 4.5 and 5.0 against a 5s deadline: ceiling 4s, then 8s
    clipped to the 0.5s left, then nothing left — well before the 10-attempt cap."""
    ns, agent_cls, errors, deaths = _load(
        [[EventStreamError("stream closed")]],
        random=_CeilingRandom(),
        time=_scripted_clock([0.0, 4.5, 5.0]),
    )
    ns["_STREAM_RETRY_BASE_S"] = 4.0
    ns["_STREAM_RETRY_DEADLINE_S"] = 5.0

    with pytest.raises(EventStreamError):
        async for _ in ns["_run_agent_invocation"](PAYLOAD, CTX):
            pass

    (agent,) = agent_cls.instances
    assert agent.attempts == 3, f"expected the deadline to stop attempt 3; got {agent.attempts}"
    assert agent.attempts < ns["_STREAM_RETRY_MAX_ATTEMPTS"]
    assert ns["_test_sleeps"] == [4.0, 0.5], f"got {ns['_test_sleeps']}"
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
    written while the turn is still alive, the resume and death in its teardown —
    TEAM-5976 F6: the resume object FIRST, because the death is what triggers the
    re-dispatch, and a re-dispatched turn that reads before the write lands starts
    from nothing."""
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
    assert ns["_test_log"] == ["comment", "error", "resume", "died"], ns["_test_log"]


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


# ─── 7. TEAM-5976: the review findings on the TEAM-5963 retry ─────────────────


def _model_call_starts(agent: Any) -> None:
    """Fire strands' BeforeModelCallEvent through the double's real registry."""
    from strands.hooks import BeforeModelCallEvent

    agent.registry.invoke_callbacks(BeforeModelCallEvent(agent=agent))


def _model_call_ends(agent: Any) -> None:
    from strands.hooks import AfterModelCallEvent

    agent.registry.invoke_callbacks(AfterModelCallEvent(agent=agent))


def _ticker() -> tuple[Any, Any, list[float]]:
    """(wait seam, tick step, waits). The in-flight heartbeat's wait blocks until a
    `tick` step releases it, so "the interval elapsed" happens exactly where the
    script says, with no real time and no scheduling luck."""
    import asyncio

    gate: asyncio.Queue = asyncio.Queue()
    waits: list[float] = []

    async def wait(seconds: float) -> None:
        waits.append(seconds)
        await gate.get()

    async def tick(agent: Any) -> None:
        gate.put_nowait(1)
        for _ in range(3):
            await asyncio.sleep(0)

    return wait, tick, waits


def _detail_rows(puts: list[dict], detail_type: str) -> list[dict]:
    return [
        {k: v["S"] for k, v in p["Item"]["detail"]["M"].items()}
        for p in puts
        if p["Item"]["type"]["S"] == "agent.streaming"
        and p["Item"]["detail"]["M"].get("type", {}).get("S") == detail_type
    ]


def _inflight_hook(agent: Any) -> Any:
    hooks = [h for h in agent.hooks if hasattr(h, "inflight")]
    assert len(hooks) == 1, f"expected one in-flight hook on the Agent; got {agent.hooks}"
    return hooks[0]


def _pending_tasks() -> list[Any]:
    import asyncio

    me = asyncio.current_task()
    return [t for t in asyncio.all_tasks() if t is not me and not t.done()]


def _load_with_ticker(scripts: list[list[Any]], **overrides: Any):
    puts: list[dict] = []
    wait, tick, waits = _ticker()
    ns, agent_cls, errors, deaths = _load(
        scripts(tick) if callable(scripts) else scripts,
        _ddb_events_client=SimpleNamespace(put_item=lambda **kw: puts.append(kw)),
        **overrides,
    )
    ns["_stream_heartbeat_wait"] = wait
    return ns, agent_cls, errors, deaths, puts, waits


# F1 — a model call that has gone quiet still renews the lease.


@pytest.mark.asyncio
async def test_team5976_a_quiet_inflight_model_call_heartbeats() -> None:
    """The defect: a model call that went silent (botocore read_timeout is 1200s,
    x3 attempts) published nothing, so the lease aged out behind a LIVE turn and
    the ticket could be re-dispatched under it. Each quiet interval now publishes
    one lease-renewing agent.streaming row — `detail.type="heartbeat"`, no content,
    so nothing renders it — stamped with agent and ticket."""
    ns, agent_cls, errors, deaths, puts, waits = _load_with_ticker(lambda tick: [
        [_model_call_starts, tick, tick, _model_call_ends, {"data": "ok"}, _engage_completion],
    ])

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]
    (agent,) = agent_cls.instances

    beats = _detail_rows(puts, "heartbeat")
    assert len(beats) == 2, f"one beat per quiet interval; got {beats}"
    for beat in beats:
        assert beat["agentId"] == "agentcore_hub_backend_dev"
        assert beat["ticketId"] == "TEAM-4739", "an unstamped beat does not renew the claim"
        assert "content" not in beat, f"a heartbeat must carry nothing to render: {beat}"
    assert waits and set(waits) == {60.0}, f"the interval is the 60s default; got {waits}"
    assert _deltas(frames) == ["ok"]
    assert _inflight_hook(agent).inflight is False
    assert _pending_tasks() == [], "the heartbeat task outlived the turn"
    assert errors == [] and deaths == []


@pytest.mark.asyncio
async def test_team5976_no_heartbeat_while_streaming_or_outside_a_model_call() -> None:
    """Scoped on purpose: a beat while events are flowing is noise (the deltas
    already renew), and a beat outside a model call would keep the lease alive
    behind a tool thread hung forever — the stranding leases exist to prevent.
    Only the final quiet in-flight interval beats."""
    ns, agent_cls, errors, deaths, puts, waits = _load_with_ticker(lambda tick: [
        [
            _model_call_starts, {"data": "a"}, tick, {"data": "b"}, tick,
            _model_call_ends, tick, tick,  # a tool running: not a model call
            _model_call_starts, tick, {"data": "c"}, _model_call_ends,
            _engage_completion,
        ],
    ])

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]

    beats = _detail_rows(puts, "heartbeat")
    assert len(beats) == 1, f"only the quiet in-flight interval may beat; got {beats}"
    assert _deltas(frames) == ["a", "b", "c"]
    assert errors == [] and deaths == []


@pytest.mark.asyncio
async def test_team5976_a_model_call_that_raised_clears_the_inflight_flag() -> None:
    """strands fires AfterModelCallEvent on `except Exception` but NOT on a
    BaseException / CancelledError, so the hook alone can leave the flag set. The
    attempt's own `finally` clears it: a retry that is between model calls must
    not beat on the dead attempt's behalf, and its heartbeat task must be gone."""
    ns, agent_cls, errors, deaths, puts, waits = _load_with_ticker(lambda tick: [
        [_model_call_starts, tick, EventStreamError("stream closed in flight")],
        [tick, tick, {"data": "ok"}, _engage_completion],
    ])

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]
    (agent,) = agent_cls.instances

    beats = _detail_rows(puts, "heartbeat")
    assert len(beats) == 1, f"only attempt 1's quiet call may beat; got {beats}"
    assert _inflight_hook(agent).inflight is False
    assert _pending_tasks() == []
    assert agent.attempts == 2 and _deltas(frames) == ["ok"]
    assert errors == [] and deaths == []


@pytest.mark.asyncio
async def test_team5976_a_cancelled_turn_cancels_the_heartbeat_and_resumes_before_dying() -> None:
    """The platform reaping the turn mid-call: the heartbeat task is cancelled and
    awaited (a beat after the death would renew a lease the detector is about to
    recover), and F6 — the resume object is written BEFORE agent.died."""
    import asyncio

    ns, agent_cls, errors, deaths, puts, waits = _load_with_ticker(lambda tick: [
        [_model_call_starts, tick, {"data": "half"}, asyncio.CancelledError()],
    ])

    with pytest.raises(asyncio.CancelledError):
        async for _ in ns["_run_agent_invocation"](PAYLOAD, CTX):
            pass
    (agent,) = agent_cls.instances

    assert len(_detail_rows(puts, "heartbeat")) == 1
    assert _inflight_hook(agent).inflight is False
    assert _pending_tasks() == [], "a cancelled turn left its heartbeat task running"
    assert ns["_test_log"] == ["resume", "died"], ns["_test_log"]
    assert errors == []


# F2 — the classifier reads the whole exception chain.


def _strands_wrapped(original: BaseException) -> BaseException:
    """Exactly what strands' event loop does to a model error it does not own
    (event_loop.py: `raise EventLoopException(e) from e`)."""
    from strands.types.exceptions import EventLoopException

    try:
        try:
            raise original
        except Exception as e:
            raise EventLoopException(e) from e
    except EventLoopException as wrapped:
        return wrapped


def _real_transients() -> list[BaseException]:
    from botocore.exceptions import (
        ConnectionClosedError,
        ConnectTimeoutError,
        EndpointConnectionError,
        ReadTimeoutError as BotoReadTimeoutError,
    )
    from strands.types.exceptions import ModelThrottledException

    url = "https://bedrock-runtime.us-east-1.amazonaws.com"
    return [
        BotoReadTimeoutError(endpoint_url=url),
        TimeoutError(),
        EndpointConnectionError(endpoint_url=url),
        ConnectionClosedError(endpoint_url=url),
        ConnectTimeoutError(endpoint_url=url),
        ModelThrottledException("Too many requests"),
    ]


_REAL_TRANSIENT_IDS = [
    "botocore-ReadTimeoutError", "bare-TimeoutError", "EndpointConnectionError",
    "ConnectionClosedError", "ConnectTimeoutError", "ModelThrottledException",
]


@pytest.mark.parametrize("index", range(6), ids=_REAL_TRANSIENT_IDS)
def test_team5976_real_strands_wrapping_classifies_retry(index: int) -> None:
    """The defect: strands re-raises as EventLoopException, whose type name is
    its own and whose message is the original's MESSAGE — botocore's
    ReadTimeoutError reads "Read timeout on endpoint URL", a bare TimeoutError
    reads "", so neither matched a marker and both were `fail`. The real classes,
    wrapped the real way."""
    ns = _load_production_entrypoints()
    wrapped = _strands_wrapped(_real_transients()[index])
    assert type(wrapped).__name__ == "EventLoopException"
    assert ns["_classify_stream_error"](wrapped) == "retry", (
        f"{type(wrapped.__cause__).__name__} under EventLoopException must retry"
    )


def test_team5976_wrapped_validation_still_fails() -> None:
    """Walking the chain must not weaken fail-first: a deterministic cause
    anywhere in the chain still wins."""
    ns = _load_production_entrypoints()
    wrapped = _strands_wrapped(ValidationException("messages.1: content must not be empty"))
    assert ns["_classify_stream_error"](wrapped) == "fail"


def test_team5976_implicit_context_is_followed() -> None:
    """`raise Wrapper(...)` inside an `except` (no `from`) still displays the
    original as "During handling…" — so the classifier reads it too."""
    from botocore.exceptions import EndpointConnectionError

    ns = _load_production_entrypoints()
    try:
        try:
            raise EndpointConnectionError(endpoint_url="https://bedrock")
        except Exception:
            raise RuntimeError("model call failed")
    except RuntimeError as outer:
        assert ns["_classify_stream_error"](outer) == "retry"


def test_team5976_suppressed_context_is_not_followed() -> None:
    """Python's own display rule: `raise X from None` suppresses the context. An
    incidental, already-handled ValidationException must not turn a transient into
    a `fail`."""
    ns = _load_production_entrypoints()
    try:
        try:
            raise ValidationException("an earlier, handled probe")
        except ValidationException:
            raise ServiceUnavailableException("Bedrock is unable to process") from None
    except ServiceUnavailableException as outer:
        assert ns["_classify_stream_error"](outer) == "retry"


def test_team5976_chain_walk_is_bounded_and_cycle_safe() -> None:
    ns = _load_production_entrypoints()
    a, b = RuntimeError("a"), RuntimeError("b")
    a.__context__, b.__context__ = b, a
    assert ns["_classify_stream_error"](a) == "fail"
    assert ns["_exc_chain"](a) == [a, b]

    head = RuntimeError("0")
    link = head
    for i in range(1, 20):
        nxt = RuntimeError(str(i))
        link.__cause__ = nxt
        link = nxt
    assert len(ns["_exc_chain"](head)) == 8


# F2/F3 — end to end through a REAL strands Agent.


def _scripted_model(steps: list[Any]) -> Any:
    from test_telemetry_spans import MockModel

    usage = {
        "metadata": {
            "usage": {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5},
            "metrics": {"latencyMs": 1, "timeToFirstByteMs": 1},
        }
    }

    class _ScriptedModel(MockModel):
        def __init__(self) -> None:
            super().__init__()
            self.calls = 0
            # TEAM-5999 F3: the history each call was handed, so a test can prove
            # the retried call saw the toolResult rather than trusting the script.
            self.seen: list[list[dict]] = []

        async def stream(self, messages: Any = None, *args: Any, **kwargs: Any):
            import copy

            step = steps[min(self.calls, len(steps) - 1)]
            self.calls += 1
            self.seen.append(copy.deepcopy(messages) if messages is not None else [])
            if isinstance(step, BaseException):
                raise step
            if inspect.iscoroutinefunction(step):
                # TEAM-5999 F1: a model call that never answers — cancelled from
                # outside, or it never returns at all.
                await step()
                return
            yield {"messageStart": {"role": "assistant"}}
            if step == "tool":
                yield {"contentBlockStart": {"start": {"toolUse": {
                    "toolUseId": "tu-e2e", "name": "claude_code"}}}}
                yield {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"task": "look"}'}}}}
                yield {"contentBlockStop": {}}
                yield {"messageStop": {"stopReason": "tool_use"}}
            else:
                yield {"contentBlockDelta": {"delta": {"text": step}}}
                yield {"contentBlockStop": {}}
                yield {"messageStop": {"stopReason": "end_turn"}}
            yield usage

    return _ScriptedModel()


UNBOUND = {"prompt": "do the work", "agent_id": "agentcore_hub_backend_dev"}


@pytest.mark.asyncio
async def test_team5976_real_agent_tool_cycle_then_read_timeout_is_retried() -> None:
    """The incident shape on the real stack: a tool cycle completes, then the
    next model call dies on botocore's ReadTimeoutError, which strands wraps.
    One harness retry (the backoff seam slept once), the tool is not re-run, and
    the reply is the regenerated text once."""
    import json

    from botocore.exceptions import ReadTimeoutError as BotoReadTimeoutError
    import strands

    model = _scripted_model(
        ["tool", BotoReadTimeoutError(endpoint_url="https://bedrock-runtime"), "done"]
    )
    ns, _unused, errors, deaths = _load(
        [[]], Agent=strands.Agent, json=json, random=_CeilingRandom(),
        _build_bedrock_model=lambda model_id: model,
    )
    ns["_STREAM_RETRY_BASE_S"] = 1.0

    frames = [f async for f in ns["_run_agent_invocation"](UNBOUND, CTX)]

    assert model.calls == 3, f"expected tool, timeout, done; got {model.calls} model call(s)"
    assert ns["_test_sleeps"] == [1.0], "the HARNESS backoff must have handled the timeout"
    assert _deltas(frames) == ["done"], _deltas(frames)
    assert errors == []


@pytest.mark.asyncio
async def test_team5976_throttling_is_retried_by_the_harness_not_by_strands(monkeypatch) -> None:
    """F3, one retry layer: strands' default ModelRetryStrategy retried
    ModelThrottledException itself — up to ~124s of silent sleep outside the
    deadline, no heartbeat, and the partial replayed. With `retry_strategy=None`
    the throttle reaches the harness, which owns the deadline and the lease."""
    import json

    import strands
    import strands.event_loop._retry as strands_retry
    from strands.types.exceptions import ModelThrottledException

    strands_sleeps: list[float] = []

    async def _record(seconds: float) -> None:
        strands_sleeps.append(seconds)

    monkeypatch.setattr(strands_retry, "asyncio", SimpleNamespace(sleep=_record))
    model = _scripted_model(["tool", ModelThrottledException("Too many requests"), "done"])
    ns, _unused, errors, deaths = _load(
        [[]], Agent=strands.Agent, json=json, random=_CeilingRandom(),
        _build_bedrock_model=lambda model_id: model,
    )
    ns["_STREAM_RETRY_BASE_S"] = 1.0

    frames = [f async for f in ns["_run_agent_invocation"](UNBOUND, CTX)]

    assert strands_sleeps == [], f"strands retried on its own: {strands_sleeps}"
    assert ns["_test_sleeps"] == [1.0]
    assert model.calls == 3 and _deltas(frames) == ["done"]
    assert errors == []


# F3 — a wall-clock deadline, re-armed by progress, and one retry layer.


@pytest.mark.asyncio
async def test_team5976_agent_is_built_with_strands_retry_disabled() -> None:
    ns, agent_cls, errors, deaths = _load([[{"data": "ok"}, _engage_completion]])
    [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]
    (agent,) = agent_cls.instances
    assert "retry_strategy" in agent.kwargs and agent.kwargs["retry_strategy"] is None, (
        f"strands' own retry layer must be off; Agent built with {sorted(agent.kwargs)}"
    )


@pytest.mark.asyncio
async def test_team5976_attempt_time_counts_against_the_deadline() -> None:
    """The defect: only SLEEP counted, so attempts that each hung for minutes
    retried ten times — hours on one outage. Failure 1 at t=0, failure 2 at
    t=700: the 600s deadline is past, give up on attempt 2."""
    ns, agent_cls, errors, deaths = _load(
        [[EventStreamError("stream closed")]], time=_scripted_clock([0.0, 700.0])
    )

    with pytest.raises(EventStreamError):
        async for _ in ns["_run_agent_invocation"](PAYLOAD, CTX):
            pass

    (agent,) = agent_cls.instances
    assert agent.attempts == 2, f"a spent deadline must stop the retry; got {agent.attempts}"
    assert len(errors) == 1 and len(deaths) == 1
    (comment,) = ns["_test_comments"]
    assert "retry deadline 600s" in comment["comment"], comment["comment"]


@pytest.mark.asyncio
async def test_team5976_progress_rearms_the_outage_window() -> None:
    """Regression guard for the deadline: it measures ONE contiguous outage. An
    attempt that completes a message is progress, so a break 2000s later is a new
    outage with a fresh window (and a fresh attempt count) — not "deadline spent"."""
    message = {"message": {"role": "assistant", "content": [{"text": "x"}]}}
    ns, agent_cls, errors, deaths = _load(
        [
            [EventStreamError("stream closed")],
            [message, EventStreamError("stream closed much later")],
            [{"data": "ok"}, _engage_completion],
        ],
        time=_scripted_clock([0.0, 2000.0, 2000.5]),
    )

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]

    assert agent_cls.instances[0].attempts == 3
    assert _deltas(frames) == ["ok"]
    assert errors == [] and deaths == []


# F5 — the regenerated partial is rolled back, not duplicated.


def test_team5976_the_notice_is_the_shipped_one() -> None:
    assert _load_production_entrypoints()["_STREAM_RETRY_NOTICE"] == NOTICE


@pytest.mark.asyncio
async def test_team5976_a_regenerated_partial_is_rolled_back() -> None:
    """strands commits an assistant message only once its stream completes, so a
    retry regenerates the broken one from scratch. The old code appended: the
    reply, Memory and the run's DDB text all read "The answer is The answer is
    42.". The caller keeps what it already saw plus one notice; everything the
    runtime still owns — Memory, and the DDB text not yet flushed — has one copy."""
    puts: list[dict] = []
    ns, agent_cls, errors, deaths = _load(
        [
            [{"data": "The answer is "}, EventStreamError("stream closed")],
            [{"data": "The answer is 42."}, _engage_completion],
        ],
        _ddb_events_client=SimpleNamespace(put_item=lambda **kw: puts.append(kw)),
    )

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]

    assert _deltas(frames) == ["The answer is ", NOTICE, "The answer is 42."], _deltas(frames)
    assert ns["_test_saved"][-1][-1] == "The answer is 42."
    published = "".join(
        row["content"] for row in _detail_rows(puts, "text") if row.get("retryBackoff") != "true"
    )
    assert published == "The answer is 42.", f"DDB text duplicated the partial: {published!r}"
    assert errors == [] and deaths == []


@pytest.mark.asyncio
async def test_team5976_the_rollback_reaches_the_resume_object_and_the_death() -> None:
    """The next turn on the ticket starts from the resume object's last_text: a
    duplicated partial there is a confused restart."""
    ns, agent_cls, errors, deaths = _load([
        [{"data": "The answer is "}, EventStreamError("stream closed")],
        [{"data": "The answer is 4"}, EventStreamError("closed again")],
    ])
    ns["_STREAM_RETRY_MAX_ATTEMPTS"] = 2

    with pytest.raises(EventStreamError):
        async for _ in ns["_run_agent_invocation"](PAYLOAD, CTX):
            pass

    assert len(deaths) == 1 and deaths[0][1]["last_text"] == "The answer is 4", deaths
    (resume,) = ns["_test_resumes"]
    assert resume[1]["last_text"] == "The answer is 4", resume


@pytest.mark.asyncio
async def test_team5976_completed_message_text_before_a_tool_cycle_is_kept() -> None:
    """The rollback reaches back only to the last COMPLETED message: text strands
    already committed (here, before a tool call) is history the retry continues
    from, so it stays, and no notice is needed."""
    ns, agent_cls, errors, deaths = _load([
        [
            {"data": "Let me check. "},
            {"message": {"role": "assistant", "content": [{"text": "Let me check. "}]}},
            _tool_cycle_closed,
            EventStreamError("stream closed after the cycle"),
        ],
        [{"data": "Done."}, _engage_completion],
    ])

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]

    assert _deltas(frames) == ["Let me check. ", "Done."]
    assert ns["_test_saved"][-1][-1] == "Let me check. Done."
    assert errors == [] and deaths == []


# F7 — the comment helper reads the tool's error STRING.


@pytest.mark.asyncio
async def test_team5976_a_comment_error_string_is_logged(caplog) -> None:
    """The ticket tools report failure by RETURNING "Error: …", never by raising,
    so `except Exception` alone saw every failed comment as a success."""
    import logging

    ns, agent_cls, errors, deaths = _load(
        [[ServiceUnavailableException("unavailable")]],
        Tickets___add_comment=lambda **kwargs: "Error: 'body' is required",
    )

    with caplog.at_level(logging.WARNING):
        with pytest.raises(ServiceUnavailableException):
            async for _ in ns["_run_agent_invocation"](PAYLOAD, CTX):
                pass

    assert any(
        "transient-exhaustion comment" in r.getMessage() and "'body' is required" in r.getMessage()
        for r in caplog.records
    ), [r.getMessage() for r in caplog.records]
    assert len(deaths) == 1 and len(ns["_test_resumes"]) == 1


# ─── 8. TEAM-5999: the round-2 review findings on the TEAM-5976 retry ─────────
#
# F1 — once the outage clock is armed, an attempt that HANGS is cut at the
# deadline (not at botocore's 1200s read_timeout, times the attempt cap), the
# heartbeat stops with it, and the cut ends the turn on the transient-exhaustion
# path. F2 — the death path hands its claim generation to the resume write. F3 —
# the real-agent retry test proves the retried model call saw the toolResult.
# F4 — a partial already flushed to DDB is DELETED by the rollback.


async def _drain(agen: Any) -> list[dict]:
    return [f async for f in agen]


async def _run_or_fail(agen: Any, timeout: float = 5.0) -> Any:
    """The turn as a task under a hard guard. A turn still running after `timeout`
    is the base-branch defect (a hung attempt nobody cuts), so it is cancelled and
    reported as a failure instead of hanging the suite. Returns the finished task;
    read `.result()` / `.exception()`."""
    import asyncio

    task = asyncio.ensure_future(_drain(agen))
    done, _ = await asyncio.wait({task}, timeout=timeout)
    if not done:
        task.cancel()
        try:
            await task
        except BaseException:  # noqa: BLE001 — the cancel is the point
            pass
        pytest.fail(f"the turn was still running after {timeout}s — the hung attempt was never cut")
    return task


GEN = "2026-10-14T10:00:00.000Z"


@pytest.mark.asyncio
async def test_team5999_a_hung_retry_attempt_is_cut_at_the_outage_deadline() -> None:
    """The defect: `remaining` was computed only in the except block, so a retry
    attempt that never yielded was bounded by botocore's 1200s read_timeout alone,
    and the in-flight heartbeat renewed the lease for the whole hang. Once the
    outage clock is armed each attempt is cut at the deadline, the heartbeat stops
    with it, and the cut is exhaustion: one agent.error, one death with
    reason=transient_exhaustion, the resume object written first."""
    import asyncio

    hang = asyncio.Event()

    async def _hang_forever(agent: Any) -> None:
        await hang.wait()

    puts: list[dict] = []
    ns, agent_cls, errors, deaths = _load(
        [
            [EventStreamError("stream closed")],  # failure 1 arms the clock
            [_model_call_starts, _hang_forever],  # the retry never yields
        ],
        _ddb_events_client=SimpleNamespace(put_item=lambda **kw: puts.append(kw)),
    )
    ns["_STREAM_RETRY_DEADLINE_S"] = 0.3
    ns["_STREAM_RETRY_INFLIGHT_HEARTBEAT_S"] = 0.02
    ns["_stream_heartbeat_wait"] = asyncio.sleep  # real, tiny: beats accumulate during the hang
    loop = asyncio.get_running_loop()
    started = loop.time()

    task = await _run_or_fail(ns["_run_agent_invocation"](PAYLOAD, CTX))

    elapsed = loop.time() - started
    exc = task.exception()
    assert isinstance(exc, ns["StreamRetryDeadlineExceeded"]), repr(exc)
    assert isinstance(exc, TimeoutError), "the cut must read as a timeout to every classifier"
    assert elapsed < 2.0, f"the cut must land near the 0.3s deadline; took {elapsed:.2f}s"
    (agent,) = agent_cls.instances
    assert agent.attempts == 2, f"the hung attempt is the last; got {agent.attempts}"
    beats = len(_detail_rows(puts, "heartbeat"))
    assert beats >= 1, "the quiet in-flight call must have beaten before the cut"
    await asyncio.sleep(0.1)
    assert len(_detail_rows(puts, "heartbeat")) == beats, "the heartbeat kept beating after the cut"
    assert _pending_tasks() == [], "the heartbeat task outlived the turn"
    assert _inflight_hook(agent).inflight is False
    assert len(errors) == 1 and "StreamRetryDeadlineExceeded" in errors[0][0][2], errors
    assert len(deaths) == 1 and deaths[0][1].get("reason") == "transient_exhaustion", deaths
    assert ns["_test_log"] == ["comment", "error", "resume", "died"], ns["_test_log"]
    (comment,) = ns["_test_comments"]
    assert "StreamRetryDeadlineExceeded" in comment["comment"], comment["comment"]


@pytest.mark.asyncio
async def test_team5999_progress_inside_a_bounded_attempt_lifts_the_bound() -> None:
    """Regression guard for the re-arm: a bounded attempt that COMPLETES a message
    is progress, so the rest of that attempt is no longer under the outage
    deadline — a slow but healthy continuation must not be cut."""
    import asyncio

    message = {"message": {"role": "assistant", "content": [{"text": "x"}]}}

    async def _slow(agent: Any) -> None:
        await asyncio.sleep(0.5)  # longer than the whole deadline

    ns, agent_cls, errors, deaths = _load([
        [EventStreamError("stream closed")],
        [message, _slow, {"data": "ok"}, _engage_completion],
    ])
    ns["_STREAM_RETRY_DEADLINE_S"] = 0.3

    task = await _run_or_fail(ns["_run_agent_invocation"](PAYLOAD, CTX))

    assert _deltas(task.result()) == ["ok"]
    assert agent_cls.instances[0].attempts == 2
    assert errors == [] and deaths == []


@pytest.mark.asyncio
async def test_team5999_real_agent_deadline_cut_leaves_history_consistent() -> None:
    """Through a REAL strands Agent: a tool cycle completes, the next model call
    hangs, the deadline cuts it. strands commits an assistant message only after
    the stream's stop, and `_run_loop`'s finally runs conversation management on
    any unwind, so the cut must leave history exactly as a botocore ReadTimeout
    does today — toolResult last, no partial — with the task's cancellation
    consumed by the timeout (strands must not swallow the CancelledError) and the
    Agent still usable afterwards."""
    import asyncio
    import json

    import strands

    hang = asyncio.Event()

    async def _hang_forever() -> None:
        await hang.wait()

    class _RecordingAgent(strands.Agent):
        instances: list[Any] = []

        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            type(self).instances.append(self)

    _RecordingAgent.instances = []
    # Call 1 asks for the tool, call 2 breaks (arms the outage clock), call 3 —
    # the retry — hangs and is cut; call 4 is the manual re-entry below.
    model = _scripted_model(
        ["tool", EventStreamError("stream closed after the tool"), _hang_forever, "done"]
    )
    ns, _unused, errors, deaths = _load(
        [[]], Agent=_RecordingAgent, json=json, _build_bedrock_model=lambda model_id: model,
    )
    ns["_STREAM_RETRY_DEADLINE_S"] = 0.3

    task = await _run_or_fail(ns["_run_agent_invocation"](UNBOUND, CTX))

    exc = task.exception()
    assert isinstance(exc, ns["StreamRetryDeadlineExceeded"]), repr(exc)
    assert asyncio.current_task().cancelling() == 0, (
        "the timeout did not consume its own cancel — strands swallowed the CancelledError"
    )
    assert _pending_tasks() == []
    (agent,) = _RecordingAgent.instances
    roles = [m["role"] for m in agent.messages]
    assert roles == ["user", "assistant", "user"], f"a partial leaked into history: {roles}"
    assert any(
        c.get("toolResult", {}).get("toolUseId") == "tu-e2e"
        for c in agent.messages[-1]["content"] if isinstance(c, dict)
    ), agent.messages[-1]
    assert model.calls == 3, f"tool, break, hung retry; got {model.calls}"
    assert model.seen[2] == model.seen[1], "the hung retry was handed a different history"
    assert len(errors) == 1

    # Still usable: the same Agent, re-entered with [], completes on that history.
    frames = [e async for e in agent.stream_async([])]
    assert frames and model.calls == 4
    assert model.seen[3] == model.seen[2], "the re-entry must see the same history again"
    assert [m["role"] for m in agent.messages] == ["user", "assistant", "user", "assistant"]
    assert agent.messages[-1]["content"][0]["text"] == "done"


@pytest.mark.asyncio
async def test_team5999_the_death_path_hands_the_claim_generation_to_the_resume_write() -> None:
    """F2: the resume write is fenced on the claim generation, which only the
    turn's `finally` knows (`_CURRENT_CLAIM_STARTED_AT` from the dispatch
    payload) — so the write site must pass it, as the death publish already does."""
    ns, agent_cls, errors, deaths = _load([[ServiceUnavailableException("unavailable")]])
    ns["_STREAM_RETRY_MAX_ATTEMPTS"] = 1

    with pytest.raises(ServiceUnavailableException):
        async for _ in ns["_run_agent_invocation"]({**PAYLOAD, "claim_started_at": GEN}, CTX):
            pass

    (resume,) = ns["_test_resumes"]
    assert resume[1]["claim_started_at"] == GEN, resume
    assert deaths[0][1]["claim_started_at"] == GEN


@pytest.mark.asyncio
async def test_team5999_the_retried_model_call_sees_the_tool_result() -> None:
    """F3: the scripted model ignores history, so the TEAM-5976 real-agent test
    could not tell a retry that re-sent the prompt (or dropped the toolResult)
    from a correct one. Pin it on the real stack: the tool ran exactly once, the
    retried call was handed the identical history ending in that toolResult, and
    the Agent's own history is one prompt, one tool cycle, one reply."""
    import json

    from botocore.exceptions import ReadTimeoutError as BotoReadTimeoutError
    import strands
    from strands import tool

    tool_calls: list[str] = []

    @tool
    def claude_code(task: str) -> str:
        """Counting stub of the claude_code delegation tool."""
        tool_calls.append(task)
        return "stub-result"

    class _RecordingAgent(strands.Agent):
        instances: list[Any] = []

        def __init__(self, **kwargs: Any) -> None:
            super().__init__(**kwargs)
            type(self).instances.append(self)

    _RecordingAgent.instances = []
    model = _scripted_model(
        ["tool", BotoReadTimeoutError(endpoint_url="https://bedrock-runtime"), "done"]
    )
    ns, _unused, errors, deaths = _load(
        [[]], Agent=_RecordingAgent, json=json, random=_CeilingRandom(),
        _build_bedrock_model=lambda model_id: model, claude_code=claude_code,
    )
    ns["_STREAM_RETRY_BASE_S"] = 1.0

    frames = [f async for f in ns["_run_agent_invocation"](UNBOUND, CTX)]

    assert tool_calls == ["look"], f"the tool must run exactly once; got {tool_calls}"
    assert model.calls == 3 and _deltas(frames) == ["done"]
    assert model.seen[2] == model.seen[1], (
        "the retried model call must be handed the SAME history as the call that broke"
    )
    last = model.seen[2][-1]
    assert last["role"] == "user" and any(
        c.get("toolResult", {}).get("toolUseId") == "tu-e2e" for c in last["content"] if isinstance(c, dict)
    ), f"the retried call did not see the toolResult: {last}"
    (agent,) = _RecordingAgent.instances
    assert [m["role"] for m in agent.messages] == ["user", "assistant", "user", "assistant"]
    assert any(
        c.get("toolResult", {}).get("toolUseId") == "tu-e2e"
        for c in agent.messages[2]["content"] if isinstance(c, dict)
    )
    assert _prompt_copies(agent, UNBOUND["prompt"]) == 1
    assert errors == []


# F4 — the rollback reaches the rows already flushed to DDB.


def _ddb_recorder() -> tuple[Any, list[dict], list[dict]]:
    puts: list[dict] = []
    deletes: list[dict] = []
    client = SimpleNamespace(
        put_item=lambda **kw: puts.append(kw),
        delete_item=lambda **kw: deletes.append(kw),
    )
    return client, puts, deletes


def _row_key(put: dict) -> tuple[str, str]:
    return put["Item"]["workflowId"]["S"], put["Item"]["eventId"]["S"]


def _surviving_text(puts: list[dict], deletes: list[dict]) -> str:
    """What every stored-stream reader (agent-output route, lastStreamedText, the
    dossier) sees: the text rows that still exist, concatenated in order."""
    gone = {(d["Key"]["workflowId"]["S"], d["Key"]["eventId"]["S"]) for d in deletes}
    return "".join(
        p["Item"]["detail"]["M"]["content"]["S"]
        for p in puts
        if p["Item"]["type"]["S"] == "agent.streaming"
        and p["Item"]["detail"]["M"].get("type", {}).get("S") == "text"
        and p["Item"]["detail"]["M"].get("retryBackoff", {}).get("S") != "true"
        and _row_key(p) not in gone
    )


@pytest.mark.asyncio
async def test_team5999_a_flushed_partial_is_deleted_from_ddb_on_rollback() -> None:
    """The defect: TEAM-5976 F5 rolled the partial out of final_text and the
    UNFLUSHED buffer, but a partial past the 200-char flush threshold was already
    a DDB row, so every stored-stream reader showed it twice. The rollback now
    deletes the rows it flushed since the last completed message."""
    client, puts, deletes = _ddb_recorder()
    ns, agent_cls, errors, deaths = _load(
        [
            [{"data": "A" * 250}, EventStreamError("stream closed")],
            [{"data": "B" * 250}, _engage_completion],
        ],
        _ddb_events_client=client,
    )

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]

    assert _deltas(frames) == ["A" * 250, NOTICE, "B" * 250]
    assert _surviving_text(puts, deletes) == "B" * 250, (
        f"the stored stream still holds the partial: {len(_surviving_text(puts, deletes))} chars"
    )
    [a_row] = [p for p in puts if p["Item"]["detail"]["M"].get("content", {}).get("S") == "A" * 250]
    assert len(deletes) == 1, deletes
    assert deletes[0]["TableName"] == "test-events"
    assert (deletes[0]["Key"]["workflowId"]["S"], deletes[0]["Key"]["eventId"]["S"]) == _row_key(a_row)
    assert ns["_test_saved"][-1][-1] == "B" * 250
    assert errors == [] and deaths == []


@pytest.mark.asyncio
async def test_team5999_rows_of_a_completed_message_survive_the_rollback() -> None:
    """Only the broken attempt's rows go: text strands already committed (here,
    before a tool cycle) stays in DDB exactly as it stays in the reply."""
    client, puts, deletes = _ddb_recorder()
    ns, agent_cls, errors, deaths = _load(
        [
            [
                {"data": "X" * 250},
                {"message": {"role": "assistant", "content": [{"text": "X" * 250}]}},
                _tool_cycle_closed,
                {"data": "Y" * 250},
                EventStreamError("stream closed after the cycle"),
            ],
            [{"data": "Z"}, _engage_completion],
        ],
        _ddb_events_client=client,
    )

    frames = [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]

    assert _deltas(frames) == ["X" * 250, "Y" * 250, NOTICE, "Z"]
    assert _surviving_text(puts, deletes) == "X" * 250 + "Z"
    [y_row] = [p for p in puts if p["Item"]["detail"]["M"].get("content", {}).get("S") == "Y" * 250]
    assert [(d["Key"]["workflowId"]["S"], d["Key"]["eventId"]["S"]) for d in deletes] == [_row_key(y_row)]
    assert errors == [] and deaths == []


@pytest.mark.asyncio
async def test_team5999_a_row_never_straddles_a_completed_message() -> None:
    """A message boundary flushes the buffer, so no DDB row can hold the tail of a
    committed message AND the head of the next one — otherwise the rollback could
    neither delete that row (it would lose committed text) nor keep it (it holds
    a partial). Here nothing past the boundary ever reached DDB, so nothing is
    deleted and the stored stream is still exact."""
    client, puts, deletes = _ddb_recorder()
    ns, agent_cls, errors, deaths = _load(
        [
            [
                {"data": "X" * 150},
                {"message": {"role": "assistant", "content": [{"text": "X" * 150}]}},
                {"data": "Y" * 100},
                EventStreamError("stream closed"),
            ],
            [{"data": "Z"}, _engage_completion],
        ],
        _ddb_events_client=client,
    )

    [f async for f in ns["_run_agent_invocation"](PAYLOAD, CTX)]

    assert _surviving_text(puts, deletes) == "X" * 150 + "Z"
    assert deletes == [], "the partial never reached DDB, so there was nothing to delete"
    assert errors == [] and deaths == []


@pytest.mark.asyncio
async def test_team6000_a_second_invocation_overwriting_the_globals_does_not_restamp_the_first_turns_death() -> None:
    """TEAM-6000: `_CURRENT_TICKET_ID` / `_CURRENT_CLAIM_STARTED_AT` /
    `_CURRENT_WORKFLOW_ID` are module globals, rewritten by every invocation that
    lands in this process. A turn mid-outage that read them at death time stamped
    its agent.died, its resume fence, its agent.error and its exhaustion comment
    with the NEWER invocation's ticket and generation — a strict match for a LIVE
    claim, which the detector (DL-038) now acts on within one sweep. The turn
    snapshots its own identity at start and every teardown reader uses it."""
    holder: dict[str, Any] = {}

    def _second_invocation_lands(agent: Any) -> None:
        # What `_run_agent_invocation` does first for a different ticket.
        holder["ns"]["_CURRENT_WORKFLOW_ID"] = "wf_other"
        holder["ns"]["_CURRENT_TICKET_ID"] = "TEAM-OTHER"
        holder["ns"]["_CURRENT_CLAIM_STARTED_AT"] = "2026-10-14T13:00:00.000Z"

    ns, agent_cls, errors, deaths = _load(
        [[_second_invocation_lands, ServiceUnavailableException("Bedrock is unable to process your request")]]
    )
    holder["ns"] = ns
    payload = {**PAYLOAD, "claim_started_at": "2026-10-14T12:00:00.000Z"}

    with pytest.raises(ServiceUnavailableException):
        async for _ in ns["_run_agent_invocation"](payload, CTX):
            pass

    assert len(deaths) == 1, deaths
    args, kwargs = deaths[0]
    assert args[:3] == ("wf_retry", "agentcore_hub_backend_dev", "TEAM-4739"), args
    assert kwargs["claim_started_at"] == "2026-10-14T12:00:00.000Z", kwargs
    assert kwargs["reason"] == "transient_exhaustion"
    (resume,) = ns["_test_resumes"]
    assert resume[0][:3] == ("wf_retry", "agentcore_hub_backend_dev", "TEAM-4739"), resume
    assert resume[1]["claim_started_at"] == "2026-10-14T12:00:00.000Z", resume
    (comment,) = ns["_test_comments"]
    assert comment["ticket_id"] == "TEAM-4739", comment
    (err_args, err_kwargs) = errors[0]
    assert err_args[0] == "wf_retry" and err_kwargs.get("ticket_id") == "TEAM-4739", (err_args, err_kwargs)


# ─── 9. TEAM-6045: the outage deadline is absolute, not re-derived per attempt ──
#
# The defect: the except block saved what was left of the deadline as a RELATIVE
# budget, and the next attempt turned it into a deadline only when it opened. The
# backoff's heartbeat writes, the sentinel's consumer-side rollback (synchronous
# delete_item) and the notice yield all ran in between and were never charged, so
# a retry could open after the outage deadline had already passed.


def _assert_exhausted_without_a_new_attempt(ns: dict, task: Any, agent_cls: Any,
                                            errors: list, deaths: list) -> None:
    exc = task.exception()
    assert isinstance(exc, ns["StreamRetryDeadlineExceeded"]), repr(exc)
    (agent,) = agent_cls.instances
    assert agent.attempts == 1, (
        f"a retry opened after the outage deadline had passed; got {agent.attempts} attempt(s)"
    )
    assert len(errors) == 1 and "StreamRetryDeadlineExceeded" in errors[0][0][2], errors
    assert len(deaths) == 1 and deaths[0][1].get("reason") == "transient_exhaustion", deaths
    assert ns["_test_log"] == ["comment", "error", "resume", "died"], ns["_test_log"]
    assert _pending_tasks() == [], "the heartbeat task outlived the turn"


@pytest.mark.asyncio
async def test_team6045_a_slow_rollback_does_not_open_an_attempt_past_the_deadline() -> None:
    """A flushed partial is rolled back with a synchronous delete_item that takes
    longer than the whole outage deadline. The time is the outage's: the retry
    must not open afterwards, and the turn ends on the exhaustion path."""
    import time as _time

    puts: list[dict] = []
    deletes: list[dict] = []

    def _slow_delete(**kw: Any) -> None:
        _time.sleep(0.15)  # boto3 is synchronous: this blocks the loop, as in prod
        deletes.append(kw)

    ns, agent_cls, errors, deaths = _load(
        [
            [{"data": "A" * 250}, EventStreamError("stream closed")],
            [{"data": "B"}, _engage_completion],
        ],
        _ddb_events_client=SimpleNamespace(put_item=lambda **kw: puts.append(kw),
                                           delete_item=_slow_delete),
    )
    ns["_STREAM_RETRY_DEADLINE_S"] = 0.05

    task = await _run_or_fail(ns["_run_agent_invocation"](PAYLOAD, CTX))

    assert len(deletes) == 1, "the flushed partial must still be rolled back"
    _assert_exhausted_without_a_new_attempt(ns, task, agent_cls, errors, deaths)


@pytest.mark.asyncio
async def test_team6045_slow_backoff_heartbeats_are_charged_to_the_deadline() -> None:
    """The backoff's lease-renewing publish is a synchronous put_item. When it
    takes longer than the deadline, the next attempt must not open on a budget
    computed before the publish."""
    import time as _time

    puts: list[dict] = []

    def _slow_put(**kw: Any) -> None:
        if kw["Item"]["detail"]["M"].get("retryBackoff", {}).get("S") == "true":
            _time.sleep(0.15)
        puts.append(kw)

    ns, agent_cls, errors, deaths = _load(
        [
            [EventStreamError("stream closed")],
            [{"data": "B"}, _engage_completion],
        ],
        random=_CeilingRandom(),
        _ddb_events_client=SimpleNamespace(put_item=_slow_put, delete_item=lambda **kw: None),
    )
    ns["_STREAM_RETRY_BASE_S"] = 0.01  # a real (if tiny) backoff, so one beat publishes
    ns["_STREAM_RETRY_DEADLINE_S"] = 0.05

    task = await _run_or_fail(ns["_run_agent_invocation"](PAYLOAD, CTX))

    assert ns["_test_sleeps"] == [0.01], ns["_test_sleeps"]
    assert any(p["Item"]["detail"]["M"].get("retryBackoff", {}).get("S") == "true" for p in puts)
    _assert_exhausted_without_a_new_attempt(ns, task, agent_cls, errors, deaths)
