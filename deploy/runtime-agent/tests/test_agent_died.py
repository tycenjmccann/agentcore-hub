"""TEAM-4739 FR-7 — `agent.died`: the turn that ended without ending itself.

`agent.error` already meant two different things (the model failed / the
dead-session detector announced a reap), so nothing downstream could tell a
retryable death from an exhausted one and the detector's retry cap fired a round
early. `agent.died` is the third, distinct thing: no report_completion, no
deliberate park, and no exception either — the process simply stopped being given
time (platform kill, microVM reap, a cancelled detached task).

Two halves, because they fail independently:

  1. The PUBLISH shape. An event whose key collides is an event that silently
     replaces another persona's death in the same millisecond, and a
     non-numeric timestamp fraction poisons workflow-analyzer's
     `lastSignificantEventAge()` (it `Date.parse`es the string). It is retried,
     because a lost death event is an invisible failure, and it never raises,
     because it is called from a `finally`.

  2. The EMISSION matrix — the conditions under which the shipped `finally`
     publishes it at all. Every row here is a way for the run to be accounted
     for by something OTHER than a death; if any of them leaked a death event,
     the detector would count healthy parks as fatalities and escalate runs that
     are working exactly as designed. Conversely the negative rows matter just as
     much: a transition on someone ELSE'S ticket, or one that came back
     "Error: ...", accounts for nothing, and treating it as a park is how the
     29-hour silent stall happened.

Hermetic: `ast`+`exec` isolation via test_telemetry_spans.py's loaders (main.py
cannot be imported — its module top-level installs Node.js, fetches from S3 and
chdirs).
"""

from __future__ import annotations

import ast
import logging
import re
import uuid
from types import SimpleNamespace
from typing import Any

import pytest

from test_telemetry_spans import (
    MAIN_PY,
    _load_production_entrypoints,
    _module_scope_nodes,
)

EVENT_ID_RE = re.compile(r"^\d{13}-died-\d{6}$")
TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(\d+)Z$")


# ─── 1. the publish shape ────────────────────────────────────────────────────


class _FakeEvents:
    """A `_ddb_events_client` stand-in that can fail its first N put_item calls."""

    def __init__(self, fail_times: int = 0, forever: bool = False) -> None:
        self.items: list[dict] = []
        self.calls = 0
        self._fail_times = fail_times
        self._forever = forever

    def put_item(self, **kwargs: Any) -> dict:
        self.calls += 1
        if self._forever or self.calls <= self._fail_times:
            raise RuntimeError("ProvisionedThroughputExceededException")
        self.items.append(kwargs)
        return {}


def _load_publisher(fail_times: int = 0, forever: bool = False) -> tuple[Any, _FakeEvents, dict]:
    """The REAL `_publish_agent_died`, exec'd against a fake events client.

    The retry constants are extracted from main.py so a change to them fails a
    test here, then the BACKOFF is zeroed in the namespace — the sleep durations
    are asserted separately rather than waited out on every run.
    """
    tree = ast.parse(MAIN_PY.read_text())
    nodes = _module_scope_nodes(
        tree,
        [
            "_AGENT_ERROR_PUBLISH_ATTEMPTS",
            "_AGENT_ERROR_PUBLISH_BACKOFF_S",
            "_AGENT_DIED_TEXT_LIMIT",
            "_publish_agent_died",
        ],
    )
    events = _FakeEvents(fail_times=fail_times, forever=forever)
    ns: dict[str, Any] = {
        "uuid": uuid,
        "logger": logging.getLogger("test-agent-died"),
        "_ddb_events_client": events,
        "_EVENTS_TABLE": "test-events",
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(MAIN_PY), "exec"), ns)  # noqa: S102
    real_backoff = ns["_AGENT_ERROR_PUBLISH_BACKOFF_S"]
    ns["_AGENT_ERROR_PUBLISH_BACKOFF_S"] = tuple(0.0 for _ in real_backoff)
    return ns["_publish_agent_died"], events, ns


def test_published_event_shape() -> None:
    publish, events, ns = _load_publisher()

    publish(
        "wf_died",
        "agentcore_hub_backend_dev",
        "TEAM-4739",
        session_id="sess-abc",
        last_stream_at="2026-09-17T12:34:56+00:00",
        last_text="the last thing it said",
    )

    assert events.calls == 1
    (item,) = [call["Item"] for call in events.items]
    assert events.items[0]["TableName"] == "test-events"
    assert item["workflowId"]["S"] == "wf_died"
    assert item["type"]["S"] == "agent.died"
    assert EVENT_ID_RE.match(item["eventId"]["S"]), (
        f"eventId must be <epoch-ms>-died-<6 digits>; got {item['eventId']['S']!r}"
    )
    detail = {k: v["S"] for k, v in item["detail"]["M"].items()}
    assert detail == {
        "agentId": "agentcore_hub_backend_dev",
        "workflowId": "wf_died",
        "ticketId": "TEAM-4739",
        "sessionId": "sess-abc",
        "lastStreamAt": "2026-09-17T12:34:56+00:00",
        "lastText": "the last thing it said",
    }


def test_event_id_carries_died_not_err() -> None:
    """The marker in the key is how a human scanning the events table (and every
    reader keyed on the id) tells the two apart at a glance."""
    publish, events, _ = _load_publisher()
    publish("wf_died", "agentcore_hub_backend_dev", "TEAM-4739")
    event_id = events.items[0]["Item"]["eventId"]["S"]
    assert "-died-" in event_id and "-err-" not in event_id


def test_timestamp_fraction_stays_numeric() -> None:
    """workflow-analyzer `Date.parse`es this string; a hex suffix (the obvious way
    to make a key unique) silently turns every death into an unparseable date and
    `lastSignificantEventAge()` stops seeing the run at all."""
    publish, events, _ = _load_publisher()
    publish("wf_died", "agentcore_hub_backend_dev", "TEAM-4739")
    stamp = events.items[0]["Item"]["timestamp"]["S"]
    match = TIMESTAMP_RE.match(stamp)
    assert match, f"timestamp is not ISO-8601 with a numeric fraction: {stamp!r}"
    assert match.group(1).isdigit()


def test_two_deaths_in_the_same_millisecond_do_not_collide() -> None:
    """The shared-outage case IS most deaths: one Bedrock incident kills the whole
    fleet at once, and a colliding key means only the last one is recorded."""
    publish, events, _ = _load_publisher()
    for _ in range(50):
        publish("wf_died", "agentcore_hub_backend_dev", "TEAM-4739")
    ids = [call["Item"]["eventId"]["S"] for call in events.items]
    stamps = [call["Item"]["timestamp"]["S"] for call in events.items]
    assert len(set(ids)) == len(ids), "colliding eventId — a death overwrote another"
    assert len(set(stamps)) == len(stamps), "colliding sort key"


def test_last_text_is_clipped() -> None:
    publish, events, ns = _load_publisher()
    limit = ns["_AGENT_DIED_TEXT_LIMIT"]
    publish("wf_died", "a", "T-1", last_text="x" * (limit * 3))
    assert len(events.items[0]["Item"]["detail"]["M"]["lastText"]["S"]) == limit
    assert limit <= 2048, "the event must stay small — the resume object holds the payload"


def test_missing_workflow_id_is_recorded_as_unknown() -> None:
    """The table's partition key cannot be empty, and dropping the write would
    lose the death entirely."""
    publish, events, _ = _load_publisher()
    publish("", "agentcore_hub_backend_dev", "TEAM-4739")
    item = events.items[0]["Item"]
    assert item["workflowId"]["S"] == "unknown"
    assert item["detail"]["M"]["workflowId"]["S"] == "unknown"


def test_optional_fields_default_to_empty_strings() -> None:
    publish, events, _ = _load_publisher()
    publish("wf_died", "agentcore_hub_backend_dev")
    detail = {k: v["S"] for k, v in events.items[0]["Item"]["detail"]["M"].items()}
    assert detail["ticketId"] == detail["sessionId"] == detail["lastStreamAt"] == ""
    assert detail["lastText"] == ""


def test_a_transient_put_failure_is_retried() -> None:
    publish, events, _ = _load_publisher(fail_times=2)
    publish("wf_died", "agentcore_hub_backend_dev", "TEAM-4739")
    assert events.calls == 3, f"expected 3 attempts, got {events.calls}"
    assert len(events.items) == 1, "the death must be recorded exactly once"


def test_it_gives_up_after_three_attempts_and_never_raises() -> None:
    publish, events, ns = _load_publisher(forever=True)
    assert publish("wf_died", "agentcore_hub_backend_dev", "TEAM-4739") is None
    assert events.calls == ns["_AGENT_ERROR_PUBLISH_ATTEMPTS"] == 3
    assert events.items == []


def test_it_never_raises_even_when_the_client_is_unusable() -> None:
    """It is called from a `finally`. A raise there would replace the death with a
    second, unrelated failure and skip the telemetry flush behind it."""
    publish, _, ns = _load_publisher()
    ns["_ddb_events_client"] = None  # AttributeError inside the inner try
    assert publish("wf_died", "a", "T-1") is None
    ns["_ddb_events_client"] = object()
    assert publish("wf_died", "a", "T-1") is None


def test_the_real_backoff_is_short() -> None:
    """Long enough to outlast a throttle, short enough that a dying turn is not
    held open by its own obituary."""
    _, _, ns = _load_publisher()
    tree = ast.parse(MAIN_PY.read_text())
    real: dict[str, Any] = {}
    exec(  # noqa: S102
        compile(
            ast.Module(
                body=_module_scope_nodes(tree, ["_AGENT_ERROR_PUBLISH_BACKOFF_S"]),
                type_ignores=[],
            ),
            str(MAIN_PY),
            "exec",
        ),
        real,
    )
    backoff = real["_AGENT_ERROR_PUBLISH_BACKOFF_S"]
    assert all(0 < s <= 2.0 for s in backoff), backoff
    assert sum(backoff) <= 4.0


# ─── 2. the emission matrix ──────────────────────────────────────────────────


def _fake_agent_class(script: list[Any]) -> type:
    """An ``Agent`` stand-in replaying a script; callables run between yields,
    which is when a real hook fires."""

    class _FakeAgent:
        instances: list[Any] = []

        def __init__(self, **kwargs: Any) -> None:
            self.hooks = list(kwargs.get("hooks") or [])
            type(self).instances.append(self)

        async def stream_async(self, prompt: str):
            for step in script:
                if callable(step):
                    step(self)
                else:
                    yield step

    return _FakeAgent


def _hook(agent: Any, attr: str) -> Any:
    """The registered gate exposing ``attr`` — `engaged` for the completion gate,
    `parked` for the park gate. Located by behaviour, not by list position."""
    gate = next((h for h in agent.hooks if hasattr(h, attr)), None)
    assert gate is not None, f"main.py registered no hook exposing .{attr}"
    return gate


def _tool_result(ok: bool = True) -> Any:
    """A tool result in the shape the ticket Lambda really returns.

    The success text is the twin's own payload, not a hand-waved "moved": the park
    gate requires positive confirmation that the ticket MOVED, because the twin
    reports its refusals as success-status text (`Invalid transition …`). The
    failure row is `Error: …` — how `_invoke_lambda` renders a throw.
    """
    return (
        {"status": "success", "content": [{"text": '{"key": "T", "status": "transitioned"}'}]}
        if ok
        else {"status": "success", "content": [{"text": "Error: transition not allowed"}]}
    )


def _report_completion(agent: Any) -> None:
    gate = _hook(agent, "engaged")
    gate._on_tool_result(SimpleNamespace(tool_use={"name": gate.TOOL}, result=_tool_result()))


def _transition(ticket_id: str, transition_id: str, ok: bool = True):
    """A `Tickets___transition_ticket` result, delivered to every registered hook.

    Delivered to ALL of them on purpose: which hook cares is main.py's decision,
    and a test that hand-picked the park gate would keep passing if the shipped
    code stopped registering it.
    """

    def step(agent: Any) -> None:
        gate = _hook(agent, "parked")
        event = SimpleNamespace(
            tool_use={
                "name": gate.TOOL,
                "toolUseId": "tu-1",
                "input": {"ticket_id": ticket_id, "transition_id": transition_id},
            },
            result=_tool_result(ok),
        )
        for hook in agent.hooks:
            if hasattr(hook, "_on_tool_result"):
                hook._on_tool_result(event)

    return step


CTX = SimpleNamespace(session_id="test-session-agent-died")
TICKET = "TEAM-4739"
BOUND = {
    "prompt": "do the work",
    "workflow_id": "wf_died",
    "ticket_id": TICKET,
    "agent_id": "agentcore_hub_backend_dev",
}


async def _run(script: list[Any], payload: dict | None = None) -> tuple[list, list]:
    """(deaths, errors) published by one driven turn."""
    deaths: list[tuple] = []
    errors: list[tuple] = []
    ns = _load_production_entrypoints(
        overrides={
            "Agent": _fake_agent_class(script),
            "_publish_agent_died": lambda *a, **k: deaths.append((a, k)),
            "_publish_agent_error": lambda *a, **k: errors.append((a, k)),
        }
    )
    async for _ in ns["_run_agent_invocation"](payload if payload is not None else BOUND, CTX):
        pass
    return deaths, errors


@pytest.mark.asyncio
async def test_an_unaccounted_bound_turn_publishes_one_death() -> None:
    """The baseline the whole matrix is measured against: a turn that streamed
    text and then simply ended, with nothing claiming responsibility for it."""
    deaths, errors = await _run([{"data": "I was working on "}, {"data": "the thing"}])

    assert len(deaths) == 1, f"expected exactly one agent.died, got {deaths}"
    args, kwargs = deaths[0]
    assert args[0] == "wf_died"
    assert args[1] == "agentcore_hub_backend_dev"
    assert args[2] == TICKET
    assert kwargs["session_id"] == CTX.session_id
    assert kwargs["last_text"] == "I was working on the thing", (
        "the death must carry what the turn had produced, or the next attempt "
        f"resumes from nothing; got {kwargs}"
    )
    assert kwargs["last_stream_at"], "last_stream_at must be stamped on streamed text"
    assert errors == [], "a death is not an error — double-publishing double-counts it"


@pytest.mark.asyncio
async def test_a_reported_completion_suppresses_the_death() -> None:
    deaths, _ = await _run([{"data": "done"}, _report_completion])
    assert deaths == [], "a turn that reported completion accounted for itself"


@pytest.mark.parametrize("transition_id", ["blocked", "done", "skip"])
@pytest.mark.asyncio
async def test_a_park_on_its_own_ticket_suppresses_the_death(transition_id: str) -> None:
    """All three are outcomes the cascade already understands: parked behind a
    fix, closed, or skipped. Only the absence of an outcome is a death."""
    deaths, _ = await _run([{"data": "parking"}, _transition(TICKET, transition_id)])
    assert deaths == [], f"a {transition_id} transition on its own ticket is not a death"


@pytest.mark.asyncio
async def test_a_park_is_recognised_without_a_blocked_by() -> None:
    """`blocked_by` is deliberately irrelevant: a park with no named blocker is
    still a park, and requiring one would reclassify honest parks as deaths."""
    deaths, _ = await _run([_transition(TICKET, "blocked")])
    assert deaths == []


@pytest.mark.asyncio
async def test_a_transition_on_someone_elses_ticket_still_dies() -> None:
    """Moving another ticket accounts for nothing about THIS turn's claim — and it
    is exactly what a persona does when it files or unblocks a sibling."""
    deaths, _ = await _run([{"data": "moving a sibling"}, _transition("TEAM-9999", "done")])
    assert len(deaths) == 1, f"expected a death, got {deaths}"


@pytest.mark.asyncio
async def test_a_failed_transition_still_dies() -> None:
    """`Error: ...` means the ticket did NOT move, so the turn really did end with
    nothing. Trusting the attempt instead of the result is how a wedged ticket
    looks like a healthy park forever."""
    deaths, _ = await _run([_transition(TICKET, "blocked", ok=False)])
    assert len(deaths) == 1, f"a refused transition is not a park; got {deaths}"


@pytest.mark.parametrize(
    "payload",
    [
        {"prompt": "hi", "agent_id": "agentcore_hub_code_reviewer"},
        {"prompt": "hi", "agent_id": "agentcore_hub_code_reviewer", "ticket_id": TICKET},
        {"prompt": "hi", "agent_id": "agentcore_hub_code_reviewer", "workflow_id": "wf_died"},
    ],
    ids=["chat", "ticket-without-workflow", "workflow-without-ticket"],
)
@pytest.mark.asyncio
async def test_an_unbound_turn_never_dies(payload: dict) -> None:
    """A chat turn (or any half-bound invocation) has no run to attribute a death
    to; publishing there would poison cost-report's per-run error count with
    events nobody can trace back to a ticket."""
    deaths, _ = await _run([{"data": "hello"}], payload=payload)
    assert deaths == [], f"an unbound turn must not publish agent.died; got {deaths}"


@pytest.mark.asyncio
async def test_a_park_on_a_different_ticket_id_spelling_is_still_the_same_ticket() -> None:
    """Whitespace around a ticket id is a formatting accident, not a different
    ticket — and a persona that pasted one would otherwise be declared dead."""
    deaths, _ = await _run([_transition(f"  {TICKET}  ", "done")])
    assert deaths == []


@pytest.mark.asyncio
async def test_a_crashing_turn_publishes_error_not_death() -> None:
    """The disjointness rail. A turn that raised has already surfaced itself as
    `agent.error`; publishing a death too would make the detector count one
    failure twice and escalate a round early."""

    class EventStreamError(Exception):
        pass

    def explode(agent: Any) -> None:
        raise EventStreamError("stream closed")

    deaths: list[tuple] = []
    errors: list[tuple] = []
    ns = _load_production_entrypoints(
        overrides={
            "Agent": _fake_agent_class([{"data": "half"}, explode]),
            "_publish_agent_died": lambda *a, **k: deaths.append((a, k)),
            "_publish_agent_error": lambda *a, **k: errors.append((a, k)),
        }
    )
    ns["_STREAM_RETRY_BASE_S"] = 0.0

    with pytest.raises(EventStreamError):
        async for _ in ns["_run_agent_invocation"](BOUND, CTX):
            pass

    assert len(errors) == 1, f"the crash must surface as agent.error; got {errors}"
    assert deaths == [], "agent.error and agent.died are disjoint by construction"
