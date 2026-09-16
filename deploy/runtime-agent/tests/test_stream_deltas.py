"""TEAM-4695 regression: the synchronous path streams deltas AS THEY ARRIVE.

The bug: Agent Chat showed nothing while a persona was thinking, then the whole
reply at once. ``_run_agent_invocation`` consumed the entire ``stream_async``
loop into ``final_text`` and only afterwards yielded the tool frames followed by
ONE ``contentBlockDelta`` carrying the complete reply. Incremental output existed
only as a DynamoDB side-channel — and ``_publish_event`` returns early when there
is no ``workflow_id``, which is exactly what a chat invocation sends, so a chat
run emitted precisely one frame, at the very end.

What is pinned here:
  1. Each text chunk becomes its own ``contentBlockDelta``, in order, and a tool
     call's ``contentBlockStart`` is INTERLEAVED at the moment the call happens
     (not replayed in a block at the end) — with no duplicate trailing blob.
  2. The completion gate's suppression semantics are byte-identical: the yield
     lives inside the existing ``if not completion_gate.engaged:`` branch, so a
     suppressed chunk is neither accumulated, nor written to DDB, nor yielded.
  3. The detach path is unaffected — it drains the generator in a background
     task, so per-delta yields are discarded and the caller still sees exactly
     one ``[accepted: …]`` frame.

Hermetic: no AWS, no network, no credentials. The Agent is a scripted fake and
the shipped ``_run_agent_invocation`` / ``agent_invocation`` source is exec'd
from main.py via the loader in test_telemetry_spans.py (main.py cannot be
imported — its module top-level installs Node.js, fetches from S3 and chdirs).
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest

from test_telemetry_spans import _load_production_entrypoints


# ─── Test doubles ────────────────────────────────────────────────────────────


def _fake_agent_class(script: list[Any]) -> type:
    """An ``Agent`` stand-in that replays a scripted ``stream_async``.

    A real ``MockModel`` cannot drive this test: the events under scrutiny are
    the ``current_tool_use`` frames Strands synthesises mid-stream, and the
    completion gate fires from a hook rather than from the stream. So the script
    is a list of either stream events (yielded as-is) or callables, which run
    BETWEEN yields — that is precisely when a real hook fires.
    """

    class _FakeAgent:
        instances: list[Any] = []

        def __init__(self, **kwargs: Any) -> None:
            self.hooks = list(kwargs.get("hooks") or [])
            type(self).instances.append(self)

        @property
        def gate(self) -> Any:
            """The _CompletionGate main.py registered — hooks[1] by construction."""
            return next((h for h in self.hooks if hasattr(h, "_on_tool_result")), None)

        async def stream_async(self, prompt: str):
            for step in script:
                if callable(step):
                    step(self)
                else:
                    yield step

    return _FakeAgent


def _tool_event(name: str) -> dict:
    """A stream event carrying a tool call, as strands emits it."""
    return {"current_tool_use": {"name": name, "toolUseId": f"tu-{name}", "input": {}}}


def _completion_hook_event(gate_cls: type) -> SimpleNamespace:
    """A successful report_completion AfterToolCallEvent — engages the gate.

    Same shape as tests/test_completion_gate.py's double: only ``tool_use`` and
    ``result`` are read.
    """
    return SimpleNamespace(
        tool_use={"name": gate_cls.TOOL},
        result={"status": "success", "content": [{"text": "recorded"}]},
    )


# ─── Frame helpers ───────────────────────────────────────────────────────────


def _delta_texts(frames: list[dict]) -> list[str]:
    out = []
    for frame in frames:
        delta = frame.get("event", {}).get("contentBlockDelta")
        if delta is not None:
            out.append(delta["delta"]["text"])
    return out


def _tool_names(frames: list[dict]) -> list[str]:
    out = []
    for frame in frames:
        start = frame.get("event", {}).get("contentBlockStart")
        if start is not None:
            out.append(start["start"]["toolUse"]["name"])
    return out


def _kinds(frames: list[dict]) -> list[str]:
    """Frame kinds in arrival order, for readable ordering assertions."""
    out = []
    for frame in frames:
        event = frame.get("event", {})
        if "contentBlockDelta" in event:
            out.append(f"delta:{event['contentBlockDelta']['delta']['text']}")
        elif "contentBlockStart" in event:
            out.append(f"tool:{event['contentBlockStart']['start']['toolUse']['name']}")
        else:
            out.append("other")
    return out


def _load(script: list[Any], **overrides: Any) -> dict[str, Any]:
    ns = _load_production_entrypoints(
        overrides={"Agent": _fake_agent_class(script), **overrides}
    )
    return ns


CTX = SimpleNamespace(session_id="test-session-stream-deltas")
# No workflow_id: the chat shape, where _publish_event's guard skips every DDB
# write, so the response stream is the ONLY channel the reply can travel on.
CHAT_PAYLOAD = {"prompt": "hi", "agent_id": "agentcore_hub_code_reviewer"}


# ─── Tests ───────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_deltas_stream_with_the_tool_frame_interleaved() -> None:
    """Three chunks → three deltas in order, tool frame before the second."""
    ns = _load([
        {"data": "one"},
        _tool_event("Tickets___create_ticket"),
        {"data": "two"},
        {"data": "three"},
    ])

    frames = [f async for f in ns["_run_agent_invocation"](CHAT_PAYLOAD, CTX)]
    kinds = _kinds(frames)

    assert _delta_texts(frames) == ["one", "two", "three"], (
        f"expected one delta per chunk, in order; got {kinds}"
    )
    assert _tool_names(frames) == ["Tickets___create_ticket"], (
        f"expected exactly one tool frame (previous_tool_use dedupe); got {kinds}"
    )
    # Interleaving is the point: the tool frame must land between the chunk that
    # preceded the call and the chunk that followed it.
    assert kinds.index("tool:Tickets___create_ticket") < kinds.index("delta:two"), (
        f"tool frame must precede the second delta, not be replayed at the end; got {kinds}"
    )
    # No trailing duplicate: the pre-TEAM-4695 code re-emitted the whole reply as
    # a fourth frame, which would render the answer twice.
    assert len(frames) == 4, f"expected 3 deltas + 1 tool frame and nothing else; got {kinds}"


@pytest.mark.asyncio
async def test_completion_gate_suppresses_deltas_after_it_engages() -> None:
    """Post-completion text is dropped, exactly as it was before streaming.

    The gate engages on a successful report_completion; anything the model says
    afterwards duplicates the summary it already filed (R3.2), so it must not be
    accumulated, published, or — now — yielded.
    """
    engaged: list[bool] = []

    def engage(agent: Any) -> None:
        gate = agent.gate
        assert gate is not None, "main.py must register the _CompletionGate hook"
        gate._on_tool_result(_completion_hook_event(type(gate)))
        engaged.append(gate.engaged)

    ns = _load([{"data": "before"}, engage, {"data": "after"}])
    frames = [f async for f in ns["_run_agent_invocation"](CHAT_PAYLOAD, CTX)]

    assert engaged == [True], "the real gate did not engage on a successful completion"
    assert _delta_texts(frames) == ["before"], (
        f"suppressed text leaked into the stream; got {_kinds(frames)}"
    )
    assert "after" not in json.dumps(frames), (
        f"post-completion text must not reach the caller in any frame; got {frames}"
    )
    assert len(frames) == 1, (
        f"the streamed prefix must not be re-emitted as a trailing blob; got {_kinds(frames)}"
    )


@pytest.mark.asyncio
async def test_detach_still_yields_exactly_one_accepted_frame() -> None:
    """Per-delta yields must not leak out of the detached path.

    A detached run drains the generator with ``async for _ in …: pass``, so the
    new deltas are discarded. The caller (the orchestrator's agent-invoker) must
    still see exactly the one immediate ack it has always seen.
    """
    ns = _load([{"data": "one"}, {"data": "two"}, {"data": "three"}])
    payload = {
        "prompt": "hi",
        "workflow_id": "wf_detached",
        "agent_id": "agentcore_hub_code_reviewer",
        "detach": True,
    }

    acks = [f async for f in ns["agent_invocation"](payload, CTX)]

    assert len(acks) == 1, f"detach must ack once and only once; got {acks}"
    text = acks[0]["event"]["contentBlockDelta"]["delta"]["text"]
    assert "accepted" in text and "wf_detached" in text, f"unexpected ack frame: {text}"

    # Let the background run finish so the task is not left pending, then confirm
    # its deltas never reached the caller.
    tasks = list(ns["_DETACHED_TASKS"])
    assert len(tasks) == 1, "detached path must register exactly one background task"
    await asyncio.gather(*tasks)
    assert len(acks) == 1, "the detached run's deltas leaked into the ack stream"


@pytest.mark.asyncio
async def test_result_fallback_still_emits_one_delta() -> None:
    """A turn whose text only exists on the result message keeps its one frame."""
    ns = _load([
        {"result": SimpleNamespace(message={"content": [{"text": "from result"}]})},
    ])

    frames = [f async for f in ns["_run_agent_invocation"](CHAT_PAYLOAD, CTX)]

    assert _delta_texts(frames) == ["from result"], (
        f"the result-message fallback must still yield exactly one delta; got {_kinds(frames)}"
    )


@pytest.mark.asyncio
async def test_memory_event_records_the_whole_reply() -> None:
    """Streaming per chunk must not shrink what is persisted to Memory."""
    saved: list[tuple] = []

    ns = _load(
        [{"data": "one"}, {"data": "two"}, {"data": "three"}],
        _save_memory_event=lambda *args: saved.append(args),
    )
    # Drain fully — the memory write happens after the stream loop.
    frames = [f async for f in ns["_run_agent_invocation"](CHAT_PAYLOAD, CTX)]

    assert frames, "the run produced no frames"
    assert saved, "_save_memory_event was never called"
    assert saved[-1][-1] == "onetwothree", (
        f"Memory must receive the full concatenated reply; got {saved[-1][-1]!r}"
    )
