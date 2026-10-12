"""TEAM-5696 — a persona whose final turn is prose only.

Before this, a bound turn whose stream RETURNED with neither
WorkflowOutput___report_completion nor a park of its own ticket was filed as a
platform death (`agent.died`). The orchestrator only acts on that once the lease
is dead, and the persona's own prose had just renewed it, so the ticket sat
in_progress for the full 30-min TTL.

Now such a turn is re-prompted ONCE on the same Agent (`_FINAL_TURN_NUDGE`), and
if the re-prompt still does neither, the harness fails CLOSED: it files a
`human:engineer` escalation and parks the ticket `blocked` behind it — the shape
the orchestrator's releaseClaimOnSelfPark frees at once. It never reports
completion and never transitions to done.

Driven through the real `_run_agent_invocation` with a scripted Agent (one script
per `stream_async` call) and recording fakes for the three ticket tools.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest

from test_agent_died import _hook, _transition
from test_stream_retry import _flaky_agent_class
from test_telemetry_spans import _load_production_entrypoints

CTX = SimpleNamespace(session_id="test-session-final-turn")
TICKET = "TEAM-5696"
EPIC = "TEAM-5000"
ESCALATION = "TEAM-5697"
BOUND = {
    "prompt": "do the work",
    "workflow_id": "wf_final_turn",
    "ticket_id": TICKET,
    "agent_id": "agentcore_hub_backend_dev",
}
PROSE = [{"data": "I looked at the code "}, {"data": "and it seems fine."}]
SHIP_FIELDS = ("ci_status", "outcome", "merge_commit")


def _report_completion(agent: Any) -> None:
    """A successful report_completion, in the WorkflowOutput Lambda's own reply
    shape (`status: "complete"`) — this file runs the gate WITH `json`, so the
    real `_reports_done` parses the payload."""
    gate = _hook(agent, "engaged")
    gate._on_tool_result(SimpleNamespace(
        tool_use={"name": gate.TOOL},
        result={"status": "success",
                "content": [{"text": json.dumps({"ok": True, "status": "complete"})}]},
    ))


class _Tickets:
    """Recording fakes for the ticket tools, answering in the dynamodb twin's shapes."""

    def __init__(self, parent_type: str = "Epic", create_ok: bool = True,
                 transition_text: str = '{"key": "%s", "status": "transitioned"}' % TICKET) -> None:
        self.calls: list[tuple[str, dict]] = []
        self._parent_type = parent_type
        self._create_ok = create_ok
        self._transition_text = transition_text

    def get_issue(self, ticket_id: str) -> str:
        self.calls.append(("get_issue", {"ticket_id": ticket_id}))
        if ticket_id == TICKET:
            return json.dumps({"key": TICKET, "fields": {"issuetype": {"name": "Task"},
                                                         "parent": {"key": EPIC}}})
        return json.dumps({"key": ticket_id, "fields": {"issuetype": {"name": self._parent_type},
                                                        "parent": None}})

    def create_ticket(self, **kwargs: Any) -> str:
        self.calls.append(("create_ticket", kwargs))
        if not self._create_ok:
            return "Error: create refused"
        return json.dumps({"key": ESCALATION, "status": "created"})

    def transition_ticket(self, **kwargs: Any) -> str:
        self.calls.append(("transition_ticket", kwargs))
        return self._transition_text

    def of(self, name: str) -> list[dict]:
        return [kw for n, kw in self.calls if n == name]


async def _run(scripts: list[list[Any]], tickets: _Tickets | None = None,
               payload: dict | None = None) -> dict[str, Any]:
    tickets = tickets or _Tickets()
    agent_cls = _flaky_agent_class(scripts)
    agent_cls.instances = []
    out: dict[str, Any] = {"deaths": [], "errors": [], "resumes": [], "workflow_output": [],
                           "tickets": tickets, "agent_cls": agent_cls}
    ns = _load_production_entrypoints(
        overrides={
            "Agent": agent_cls,
            "json": json,
            "_publish_agent_died": lambda *a, **k: out["deaths"].append((a, k)),
            "_publish_agent_error": lambda *a, **k: out["errors"].append((a, k)),
            "_write_resume_object": lambda *a, **k: out["resumes"].append((a, k)),
            "Tickets___get_issue": tickets.get_issue,
            "Tickets___create_ticket": tickets.create_ticket,
            "Tickets___transition_ticket": tickets.transition_ticket,
            # The harness must never report completion: any call here is a failure.
            "WorkflowOutput___report_completion": lambda *a, **k: out["workflow_output"].append((a, k)),
            "_invoke_lambda": lambda *a, **k: out["workflow_output"].append((a, k)),
        }
    )
    ns["_STREAM_RETRY_BASE_S"] = 0.0
    out["ns"] = ns
    async for _ in ns["_run_agent_invocation"](payload if payload is not None else BOUND, CTX):
        pass
    out["agent"] = agent_cls.instances[0] if agent_cls.instances else None
    return out


# ─── (a) a prose-only turn is re-prompted exactly once ────────────────────────


@pytest.mark.asyncio
async def test_a_prose_only_turn_is_reprompted_once_and_a_completion_there_is_final() -> None:
    out = await _run([PROSE, [_report_completion]])
    agent = out["agent"]

    assert agent.attempts == 2, f"expected exactly one re-prompt, got {agent.attempts} passes"
    assert agent.prompts[0] == BOUND["prompt"]
    assert agent.prompts[1] == out["ns"]["_FINAL_TURN_NUDGE"]
    assert "WorkflowOutput___report_completion" in agent.prompts[1]
    assert "transition_id='blocked'" in agent.prompts[1]
    # No double completion: the re-prompt completed, so nothing is synthesised.
    assert out["tickets"].calls == [], f"no harness synthesis after a completion; got {out['tickets'].calls}"
    assert out["deaths"] == [] and out["errors"] == []
    assert out["resumes"] == [], "a completed turn writes no resume object"


@pytest.mark.asyncio
async def test_a_park_in_the_reprompt_is_final() -> None:
    out = await _run([PROSE, [_transition(TICKET, "blocked")]])

    assert out["agent"].attempts == 2
    assert out["tickets"].calls == [], "the persona parked itself; the harness must not park again"
    assert out["deaths"] == []


# ─── (b) still prose-only after the re-prompt → fail closed ──────────────────


@pytest.mark.asyncio
async def test_a_second_prose_only_pass_fails_closed_without_reporting_success() -> None:
    out = await _run([PROSE, PROSE])
    tickets = out["tickets"]

    assert out["agent"].attempts == 2, "exactly one re-prompt — the guard must not loop"

    [created] = tickets.of("create_ticket")
    assert created["assignee"] == "human:engineer"
    assert created["parent_id"] == EPIC
    assert created["ticket_type"] == "task", "parent is an Epic → task"
    assert created["blocked_by"] == "", "the escalation runs now — it waits on nothing"
    assert created["title"] == f"Harness: {TICKET} persona ended without report_completion"
    assert "harness-synthesised" in created["labels"]
    assert "harness-synthesised" in created["description"]
    assert "and it seems fine." in created["description"], "the final prose must reach the human"

    [parked] = tickets.of("transition_ticket")
    assert parked["ticket_id"] == TICKET
    assert parked["transition_id"] == "blocked"
    assert parked["blocked_by"] == ESCALATION, (
        "parking behind a never-completed blocker is what makes the orchestrator release the claim")
    assert parked["reason"].startswith(
        "harness-synthesised: persona ended without report_completion")

    # NOT success: never done, never a completion, never a ship field.
    assert all(kw["transition_id"] not in ("done", "approve", "skip")
               for kw in tickets.of("transition_ticket"))
    assert out["workflow_output"] == [], "the harness must never call WorkflowOutput"
    for _name, kw in tickets.calls:
        assert not any(f in kw for f in SHIP_FIELDS), kw

    assert out["deaths"] == [], "a harness park is not a death"
    assert out["errors"] == []
    assert len(out["resumes"]) == 1, "the next turn on this ticket resumes, as after a park"


@pytest.mark.asyncio
async def test_a_bug_parent_gets_a_subtask_escalation() -> None:
    out = await _run([PROSE, PROSE], tickets=_Tickets(parent_type="Bug"))
    [created] = out["tickets"].of("create_ticket")
    assert created["ticket_type"] == "subtask", "Jira rejects a Task under a Bug"


@pytest.mark.asyncio
async def test_a_failed_escalation_create_falls_back_to_a_death() -> None:
    out = await _run([PROSE, PROSE], tickets=_Tickets(create_ok=False))
    assert out["tickets"].of("transition_ticket") == [], "no park without a blocker to park on"
    assert len(out["deaths"]) == 1, f"the agent.died fallback must stay in charge; got {out['deaths']}"


@pytest.mark.asyncio
async def test_a_refused_park_falls_back_to_a_death() -> None:
    out = await _run([PROSE, PROSE], tickets=_Tickets(
        transition_text='Invalid transition "blocked" from status "todo". Available: ready'))
    assert len(out["deaths"]) == 1
    _args, kwargs = out["deaths"][0]
    assert "and it seems fine." in kwargs["last_text"]


# ─── (c) accounted-for turns are never re-prompted ───────────────────────────


@pytest.mark.asyncio
async def test_a_first_pass_completion_is_never_reprompted() -> None:
    out = await _run([PROSE + [_report_completion]])
    assert out["agent"].attempts == 1
    assert out["tickets"].calls == [] and out["deaths"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("transition_id", ["blocked", "block", "done", "skip"])
async def test_a_first_pass_park_is_never_reprompted(transition_id: str) -> None:
    out = await _run([PROSE + [_transition(TICKET, transition_id)]])
    assert out["agent"].attempts == 1
    assert out["tickets"].calls == [] and out["deaths"] == []


@pytest.mark.asyncio
async def test_a_crash_is_never_reprompted() -> None:
    with pytest.raises(ValueError):
        await _run([[{"data": "partial "}, ValueError("a plain bug in our own code")]])


@pytest.mark.asyncio
async def test_a_crash_publishes_error_and_no_synthesis() -> None:
    tickets = _Tickets()
    errors: list = []
    deaths: list = []
    agent_cls = _flaky_agent_class([[{"data": "partial "}, ValueError("boom")]])
    agent_cls.instances = []
    ns = _load_production_entrypoints(overrides={
        "Agent": agent_cls, "json": json,
        "_publish_agent_error": lambda *a, **k: errors.append(a),
        "_publish_agent_died": lambda *a, **k: deaths.append(a),
        "Tickets___get_issue": tickets.get_issue,
        "Tickets___create_ticket": tickets.create_ticket,
        "Tickets___transition_ticket": tickets.transition_ticket,
    })
    with pytest.raises(ValueError):
        async for _ in ns["_run_agent_invocation"](BOUND, CTX):
            pass
    assert agent_cls.instances[0].attempts == 1
    assert len(errors) == 1 and deaths == [] and tickets.calls == []


@pytest.mark.asyncio
async def test_an_unbound_turn_is_never_reprompted() -> None:
    out = await _run([PROSE], payload={"prompt": "hi", "agent_id": "agentcore_hub_backend_dev"})
    assert out["agent"].attempts == 1
    assert out["tickets"].calls == [] and out["deaths"] == []


# ─── (d) a turn taken away mid-stream still dies, unre-prompted ──────────────


def _cancel(agent: Any) -> None:
    raise asyncio.CancelledError()


@pytest.mark.asyncio
async def test_a_cancelled_turn_dies_without_a_reprompt() -> None:
    tickets = _Tickets()
    deaths: list = []
    agent_cls = _flaky_agent_class([PROSE + [_cancel]])
    agent_cls.instances = []
    ns = _load_production_entrypoints(overrides={
        "Agent": agent_cls, "json": json,
        "_publish_agent_died": lambda *a, **k: deaths.append(a),
        "Tickets___get_issue": tickets.get_issue,
        "Tickets___create_ticket": tickets.create_ticket,
        "Tickets___transition_ticket": tickets.transition_ticket,
    })
    with pytest.raises(asyncio.CancelledError):
        async for _ in ns["_run_agent_invocation"](BOUND, CTX):
            pass
    assert agent_cls.instances[0].attempts == 1
    assert len(deaths) == 1 and tickets.calls == []


@pytest.mark.asyncio
async def test_a_closed_stream_dies_without_a_reprompt() -> None:
    """The consumer walks away mid-turn (`aclose`) — the platform took the turn."""
    tickets = _Tickets()
    deaths: list = []
    agent_cls = _flaky_agent_class([PROSE])
    agent_cls.instances = []
    ns = _load_production_entrypoints(overrides={
        "Agent": agent_cls, "json": json,
        "_publish_agent_died": lambda *a, **k: deaths.append(a),
        "Tickets___get_issue": tickets.get_issue,
        "Tickets___create_ticket": tickets.create_ticket,
        "Tickets___transition_ticket": tickets.transition_ticket,
    })
    gen = ns["_run_agent_invocation"](BOUND, CTX)
    await gen.__anext__()
    await gen.aclose()
    assert agent_cls.instances[0].attempts == 1
    assert len(deaths) == 1 and tickets.calls == []
