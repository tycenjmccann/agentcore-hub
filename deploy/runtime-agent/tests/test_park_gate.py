"""TEAM-4739 FR-7 — `_ParkGate`: a deliberate park is not a death.

A persona that transitions its OWN ticket to blocked/done/skip and exits without
`report_completion` has ended its turn on purpose — parked behind a fix, closed
the ticket, or skipped it. The cascade already understands all three. Without this
gate every one of them would look identical to a platform kill, so `agent.died`
would fire on healthy runs and the detector would escalate work that is
progressing.

The hard part is not the happy path, it is the four ways a park can be claimed
without having happened:
  * the transition FAILED (`Error: ...` back from the Lambda) — the ticket did not
    move, so the turn really did end with nothing;
  * it moved SOMEONE ELSE'S ticket — filing or unblocking a sibling accounts for
    nothing about this turn's own claim;
  * it was some other transition (`start`, `unblock`, `reopen`) — that is work
    continuing, not a turn ending;
  * the turn is unbound and has no "own ticket" at all.

`test_agent_died.py` drives the same rules through the shipped `finally`; this
file is the unit table for the class, including the never-raises contract, which
matters because the hook runs inside the agent loop.

Hermetic: the class is `ast`-located in main.py and exec'd in isolation (main.py
cannot be imported — its module top-level installs Node.js, fetches from S3 and
chdirs).
"""

from __future__ import annotations

import ast
import json
import logging
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from test_telemetry_spans import MAIN_PY, _module_scope_nodes

REPO = MAIN_PY.resolve().parent.parent.parent
TICKETS_LAMBDA = REPO / "lambda" / "agentcore-hub-tickets" / "index.mjs"
JIRA_LAMBDA = REPO / "lambda" / "agentcore-hub-jira" / "index.mjs"
TICKET = "TEAM-4739"

# The literal each twin returns ONLY on a successful transition. `_ParkGate` reads
# these to tell a park that happened from one the Lambda refused, so a reworded
# success payload silently turns every park into a death — the rail below is what
# turns that into a failing test on the twin that changed.
TWIN_SUCCESS_LITERALS = {
    TICKETS_LAMBDA: 'status: "transitioned"',
    JIRA_LAMBDA: "message: `Transitioned to ${finalStatus}`",
}


def _load_gates() -> dict[str, Any]:
    """The REAL `_CompletionGate` + `_ParkGate`, exec'd against a bare namespace.

    `_CompletionGate` comes along because `_ParkGate` reuses its `_succeeded`
    staticmethod rather than re-deriving what a successful tool result looks like —
    two answers to "did the tool work?" is how one of them drifts.
    """
    tree = ast.parse(MAIN_PY.read_text())
    nodes = _module_scope_nodes(tree, ["_CompletionGate", "_ParkGate"])
    ns: dict[str, Any] = {"logger": logging.getLogger("test-park-gate")}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(MAIN_PY), "exec"), ns)  # noqa: S102
    return ns


def _gate(ticket_id: str = TICKET, on_park: Any = None) -> Any:
    ns = _load_gates()
    return ns["_ParkGate"](ticket_id, on_park) if on_park else ns["_ParkGate"](ticket_id)


_UNSET = object()


def _ok(text: str | None = None) -> dict:
    """A successful `transition_ticket` result, in the shape the DynamoDB twin returns.

    The default deliberately carries the real success payload rather than a
    hand-waved "moved": what the gate reads is `status: "transitioned"`, and a
    double whose text does not contain it would pass a gate that trusted the
    attempt while failing the one that checks the outcome.
    """
    if text is None:
        text = json.dumps({"key": TICKET, "status": "transitioned", "to": "blocked"})
    return {"status": "success", "content": [{"text": text}]}


def _event(
    ticket_id: str = TICKET,
    transition_id: str = "blocked",
    result: Any = _UNSET,
    name: str | None = None,
    **extra_input: Any,
) -> SimpleNamespace:
    return SimpleNamespace(
        tool_use={
            "name": name if name is not None else "Tickets___transition_ticket",
            "toolUseId": "tu-1",
            "input": {"ticket_id": ticket_id, "transition_id": transition_id, **extra_input},
        },
        result=_ok() if result is _UNSET else result,
    )


# ─── the contract with the tool and the Lambda ───────────────────────────────


def test_the_watched_tool_is_the_shipped_tool_name() -> None:
    """A renamed tool would silently stop parking anything."""
    ns = _load_gates()
    assert ns["_ParkGate"].TOOL == "Tickets___transition_ticket"
    assert f"def {ns['_ParkGate'].TOOL}(" in MAIN_PY.read_text()


def test_every_spelling_that_reaches_blocked_or_done_is_watched() -> None:
    """The rail that matters most, and the one the obvious implementation fails.

    Both ticket Lambdas resolve a requested transition by id OR by target status
    OR by display name, so `block`, `blocked` and `Request Changes` are the SAME
    park. The tool's docstring teaches personas `blocked` while the table's id is
    `block`; a gate watching either one alone misreads the other as a death.
    """
    ns = _load_gates()
    watched = ns["_ParkGate"].PARK_TRANSITIONS
    source = TICKETS_LAMBDA.read_text()
    table = source[source.index("const TRANSITIONS"):]
    table = table[: table.index("\n};")]

    rows = re.findall(r'\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*to:\s*"([^"]+)"\s*\}', table)
    assert rows, "could not parse the TRANSITIONS table — the rail is not reading anything"
    parking = [(rid, name, to) for rid, name, to in rows if to in ("blocked", "done")]
    assert parking, "no park rows found in TRANSITIONS"

    for rid, name, to in parking:
        for spelling in (rid, name.lower(), to):
            assert spelling in watched, (
                f'transition_id="{spelling}" resolves to {to} in the tickets Lambda '
                f"but _ParkGate does not watch it — that park would be published as a death"
            )


@pytest.mark.parametrize("lambda_path", list(TWIN_SUCCESS_LITERALS), ids=["tickets", "jira"])
def test_both_twins_confirm_a_move_with_the_marker_the_gate_reads(lambda_path: Path) -> None:
    """A park is only a park if the ticket PROVABLY moved — and this is where that
    proof comes from.

    `_succeeded` alone is not enough: the DynamoDB twin returns its refusals as
    ordinary success-status tool text, so the gate also requires the word both
    twins say on success and only on success. That makes the gate's correctness
    depend on a string in someone else's Lambda, which is exactly why it is pinned
    here: reword either payload and this fails, instead of every park in the fleet
    quietly becoming an `agent.died`.
    """
    ns = _load_gates()
    marker = ns["_ParkGate"].MOVED_MARKER
    literal = TWIN_SUCCESS_LITERALS[lambda_path]
    assert literal in lambda_path.read_text(), (
        f"{lambda_path.name} no longer returns {literal!r} on a successful transition — "
        f"_ParkGate would stop recognising parks made through this twin"
    )
    assert marker in literal.lower(), (
        f"_ParkGate.MOVED_MARKER={marker!r} does not appear in {lambda_path.name}'s "
        f"success payload {literal!r}"
    )


def test_the_negative_marker_is_not_a_substring_trap() -> None:
    """The jira twin's own failure text says "ticket NOT transitioned", which
    contains the positive marker. Without the negative check the gate would read a
    failure as a park on the exact wording the Lambda chose to be unambiguous."""
    ns = _load_gates()
    park = ns["_ParkGate"]
    assert park.MOVED_MARKER in park.NOT_MOVED_MARKER
    assert "not transitioned" in JIRA_LAMBDA.read_text().lower()
    gate = _gate()
    gate._on_tool_result(_event(result=_ok("ticket NOT transitioned. Check the key(s) exist.")))
    assert gate.parked is False


def test_it_does_not_watch_transitions_that_continue_the_work() -> None:
    ns = _load_gates()
    watched = ns["_ParkGate"].PARK_TRANSITIONS
    for spelling in ("start", "ready", "unblock", "reopen", "in_review", "todo", "in_progress"):
        assert spelling not in watched, f"{spelling} is work continuing, not a turn ending"


# ─── engaging ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("transition_id", ["blocked", "block", "done", "skip", "approve"])
def test_it_parks_on_its_own_ticket(transition_id: str) -> None:
    gate = _gate()
    gate._on_tool_result(_event(transition_id=transition_id))
    assert gate.parked is True


@pytest.mark.parametrize("spelling", ["BLOCKED", "  Done  ", "Skip", "Request Changes"])
def test_the_transition_id_is_matched_case_and_space_insensitively(spelling: str) -> None:
    """The model types these; the Lambda itself lower-cases the name match."""
    gate = _gate()
    gate._on_tool_result(_event(transition_id=spelling))
    assert gate.parked is True


def test_a_blocked_by_is_irrelevant_either_way() -> None:
    """A park with no named blocker is still a park — requiring one would
    reclassify honest parks (a persona waiting on a human gate it cannot name) as
    deaths."""
    with_blocker = _gate()
    with_blocker._on_tool_result(_event(blocked_by="TEAM-1,TEAM-2"))
    without = _gate()
    without._on_tool_result(_event())
    assert with_blocker.parked is True
    assert without.parked is True


def test_surrounding_whitespace_on_the_ticket_id_still_matches() -> None:
    gate = _gate()
    gate._on_tool_result(_event(ticket_id=f"  {TICKET}  "))
    assert gate.parked is True


def test_a_park_stays_parked() -> None:
    """Deliberately unlike `_CompletionGate`, which disengages when a later
    report_completion fails: a park is a fact about what the turn DID, and a
    subsequent tool call cannot un-do it."""
    gate = _gate()
    gate._on_tool_result(_event())
    gate._on_tool_result(_event(ticket_id="TEAM-9999", transition_id="start"))
    gate._on_tool_result(_event(result={"status": "error"}))
    assert gate.parked is True


def test_the_on_park_callback_runs_once_per_engage() -> None:
    calls: list[int] = []
    gate = _gate(on_park=lambda: calls.append(1))
    gate._on_tool_result(_event(transition_id="start"))
    assert calls == []
    gate._on_tool_result(_event())
    assert calls == [1]


# ─── refusing to engage ──────────────────────────────────────────────────────


def test_another_tool_is_ignored() -> None:
    gate = _gate()
    gate._on_tool_result(_event(name="Tickets___create_ticket"))
    gate._on_tool_result(_event(name="WorkflowOutput___report_completion"))
    assert gate.parked is False


@pytest.mark.parametrize("transition_id", ["start", "unblock", "ready", "reopen", "in_review", ""])
def test_a_non_park_transition_does_not_engage(transition_id: str) -> None:
    gate = _gate()
    gate._on_tool_result(_event(transition_id=transition_id))
    assert gate.parked is False


def test_another_ticket_does_not_engage() -> None:
    """Filing a fix or unblocking a sibling is exactly this call — and it says
    nothing about whether THIS turn's claim was accounted for."""
    gate = _gate()
    gate._on_tool_result(_event(ticket_id="TEAM-9999", transition_id="done"))
    assert gate.parked is False


@pytest.mark.parametrize(
    "result",
    [
        {"status": "error", "content": [{"text": "transitioned"}]},
        {"status": "success", "content": [{"text": "Error: transition not allowed"}]},
        {"status": "success", "content": [{"text": "  error: ticket not found"}]},
        {"status": "success", "content": [{"text": 'Invalid transition "done" from status "todo". Available: start'}]},
        {"status": "success", "content": [{"text": f"Issue {TICKET} not found."}]},
        {"status": "success", "content": [{"text": f"Cannot move {TICKET} to in_review: no completion record"}]},
        {"status": "success", "content": [{"text": "Refused: gate_condition_unmet. Verify the gate, then retry."}]},
        {"status": "success", "content": [{"text": f"Ticket {TICKET} was NOT transitioned."}]},
        {"status": "success", "content": []},
        None,
        "just a string",
        RuntimeError("the tool raised"),
    ],
    ids=[
        "error-status",
        "error-text",
        "error-text-padded",
        "invalid-transition-message",
        "not-found-message",
        "gate-refusal-message",
        "typed-gate-refusal",
        "explicitly-not-transitioned",
        "no-content",
        "no-result",
        "non-dict-result",
        "exception-result",
    ],
)
def test_a_transition_that_did_not_happen_does_not_engage(result: Any) -> None:
    """The ticket did not move, so the turn really did end with nothing. Trusting
    the attempt instead of the result is how a wedged ticket looks like a healthy
    park forever.

    The rows that make this more than a `status` check: the DynamoDB twin returns
    its REFUSALS as ordinary tool text with a SUCCESS status — `Invalid transition
    "done" …`, `Issue X not found.`, `Cannot move X to in_review: …`, and WP2's
    typed-gate refusal — none of which start with "Error". A gate that stopped at
    `_succeeded` would read every one of them as a park, so a ticket the Lambda
    refused to move would look accounted-for while sitting in in_progress with no
    live session: exactly the silent stall this gate exists to end.
    """
    gate = _gate()
    gate._on_tool_result(_event(result=result))
    assert gate.parked is False


def test_an_unbound_turn_has_no_own_ticket_to_park() -> None:
    for ticket_id in ("", "   ", None):
        gate = _gate(ticket_id=ticket_id or "")
        gate._on_tool_result(_event(ticket_id="TEAM-9999"))
        gate._on_tool_result(_event(ticket_id=""))
        assert gate.parked is False


# ─── never raises (it runs inside the agent loop) ────────────────────────────


@pytest.mark.parametrize(
    "event",
    [
        SimpleNamespace(),
        SimpleNamespace(tool_use=None, result=None),
        SimpleNamespace(tool_use={"name": "Tickets___transition_ticket"}, result=_ok()),
        SimpleNamespace(
            tool_use={"name": "Tickets___transition_ticket", "input": "not a dict"},
            result=_ok(),
        ),
        SimpleNamespace(
            tool_use={"name": "Tickets___transition_ticket", "input": {"transition_id": None}},
            result=_ok(),
        ),
        SimpleNamespace(
            tool_use={"name": "Tickets___transition_ticket", "input": {"ticket_id": 4739}},
            result=_ok(),
        ),
        object(),
    ],
    ids=["empty", "nones", "no-input", "input-not-a-dict", "null-transition", "int-ticket", "opaque"],
)
def test_a_malformed_event_is_swallowed(event: Any) -> None:
    """A hook that raises takes the turn down with it — and this one runs on EVERY
    tool result, including ones from tools it knows nothing about."""
    gate = _gate()
    gate._on_tool_result(event)
    assert gate.parked is False


def test_a_raising_on_park_callback_does_not_propagate_or_unpark() -> None:
    def boom() -> None:
        raise RuntimeError("S3 is down")

    gate = _gate(on_park=boom)
    gate._on_tool_result(_event())
    assert gate.parked is True, "cleanup failing must not change what the turn DID"


def test_register_hooks_subscribes_to_after_tool_call() -> None:
    """Same registration shape as `_CompletionGate` — a gate registered on the
    wrong event never fires and every park becomes a death."""
    from strands.hooks import AfterToolCallEvent

    registered: list[tuple] = []
    gate = _gate()
    gate.register_hooks(SimpleNamespace(add_callback=lambda ev, cb: registered.append((ev, cb))))
    assert registered == [(AfterToolCallEvent, gate._on_tool_result)]


def test_it_shares_the_completion_gates_success_test() -> None:
    """One definition of "the tool worked", used by both gates. Two would drift,
    and the drift shows up as a park that was never made."""
    source = MAIN_PY.read_text()
    park = source[source.index("class _ParkGate"):]
    park = park[: park.index("\n\n\nasync def") if "\n\n\nasync def" in park else len(park)]
    assert "_CompletionGate._succeeded(" in park, (
        "_ParkGate re-derived the success test instead of reusing _CompletionGate._succeeded"
    )


def test_the_gate_is_registered_on_the_shipped_agent() -> None:
    """A class nobody constructs is a class that parks nothing. Pinned as source
    text because the construction site is inside `_run_agent_invocation`'s
    `hooks=[...]`, next to the completion gate it must sit after."""
    source = MAIN_PY.read_text()
    assert "_ParkGate(" in source.split("class _ParkGate", 1)[1], "_ParkGate is never constructed"
    hooks_line = next(
        (line for line in source.splitlines() if "hooks=[" in line and "_CompletionGate" not in line),
        None,
    )
    assert hooks_line is not None
    block = source[source.index(hooks_line):][:400]
    assert "completion_gate" in block and "park_gate" in block, (
        f"both gates must be registered on the Agent; got {block.splitlines()[0]}"
    )
    assert block.index("completion_gate") < block.index("park_gate"), (
        "the park gate goes AFTER the completion gate on the same hook"
    )
