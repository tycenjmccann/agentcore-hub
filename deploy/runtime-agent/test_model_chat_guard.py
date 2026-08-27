#!/usr/bin/env python3
"""Unit tests for the model-chat stream guard (TEAM-3252) — pure fixtures,
no AWS.

Run: cd deploy/runtime-agent && python3 -m unittest test_model_chat_guard.py

The persona's own model call (agent.stream_async → strands BedrockModel →
bedrock converse_stream) is the SECOND streamed handoff of the TEAM-3168
defect class: the botocore per-read socket timeout does not reliably fire on
a wedged stream read, so a stream that stops yielding blocked the persona
forever — `chat` span left status=UNSET, no agent.error, silent hang until
the external watchdog killed it (the qa_verifier hang, TEAM-3252).

Covers:
  A. A wedged chat stream (the read blocks and never yields an event) must
     trip the idle watchdog — not hang.
  B. A stream that keeps yielding but never finishes must trip the
     wall-clock deadline — a per-event idle timeout alone resets forever.
  C. Both trips must publish an agent.error event AND mark the active OTEL
     span status=ERROR (same surfacing contract as the coding-path guard).
  D. A healthy stream passes through unchanged: all events delivered, no
     agent.error, no span error.

Reuses test_remote_coding's import stubs, hermetic main.py import, OTEL span
stub, and daemon-thread + join(timeout) hang detection."""

import asyncio
import threading
import time
import unittest
from unittest import mock

import test_remote_coding  # installs stubs and imports main.py hermetically

main = test_remote_coding.main
_OTEL_SPAN = test_remote_coding._OTEL_SPAN


def _guard(agen, **kwargs):
    """Route the stream through the guard when it exists. PRE-FIX main.py has
    no _guarded_stream_events, so the raw stream is consumed directly — which
    is exactly the unguarded silent-hang behavior these tests must catch."""
    fn = getattr(main, "_guarded_stream_events", None)
    if fn is None:
        return agen
    return fn(agen, **kwargs)


async def _collect(agen):
    events = []
    async for event in agen:
        events.append(event)
    return events


# Fixture streams are time-bounded at MAX_SECONDS so a missing guard shows up
# as a live worker thread at join(JOIN_TIMEOUT) — a detected hang — instead of
# blocking the suite forever. The daemon thread dies with the process.
MAX_SECONDS = 15.0
JOIN_TIMEOUT = 6.0


def _wedged_stream(box):
    """Chat stream whose read blocks and never yields an event — the
    wedged-socket variant of the hang (converse_stream sends no bytes)."""

    async def gen():
        try:
            await asyncio.sleep(MAX_SECONDS)
        finally:
            box["closed"] = True
        if False:  # pragma: no cover — makes this function an async generator
            yield

    return gen()


def _never_done_stream(box):
    """Chat stream that keeps yielding data events but never finishes — the
    per-event idle timeout resets on every event, so only a wall-clock
    deadline stops it."""

    async def gen():
        stop_at = time.monotonic() + MAX_SECONDS
        try:
            while time.monotonic() < stop_at:
                yield {"data": "still thinking..."}
                await asyncio.sleep(0.01)
        finally:
            box["closed"] = True

    return gen()


class TestModelChatStreamGuard(unittest.TestCase):
    def setUp(self):
        main._CURRENT_WORKFLOW_ID = "wf-test"
        main._CURRENT_AGENT_ID = "qa_verifier"
        main._CURRENT_TICKET_ID = "TEAM-3252"
        _OTEL_SPAN.reset_mock()

    def _consume_in_thread(self, stream_factory, **guard_kwargs):
        box = {"closed": False}
        events_client = mock.MagicMock()

        def run():
            try:
                box["events"] = asyncio.run(
                    _collect(_guard(stream_factory(box), **guard_kwargs)))
            except Exception as e:  # noqa: BLE001 — surfaced to assertions
                box["error"] = e

        with mock.patch.object(main, "_ddb_events_client", events_client):
            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            worker.join(timeout=JOIN_TIMEOUT)
        return worker, box, events_client

    def _assert_agent_error_published(self, events_client, expected_fragment):
        self.assertTrue(
            events_client.put_item.called,
            "no agent.error event was published for a stalled chat stream",
        )
        item = events_client.put_item.call_args.kwargs["Item"]
        self.assertEqual(item["type"]["S"], "agent.error")
        detail = item["detail"]["M"]
        self.assertEqual(detail["agentId"]["S"], "qa_verifier")
        self.assertEqual(detail["workflowId"]["S"], "wf-test")
        self.assertEqual(detail["ticketId"]["S"], "TEAM-3252")
        self.assertIn(expected_fragment, detail["error"]["S"])

    def _assert_span_marked_error(self, expected_fragment):
        self.assertTrue(
            _OTEL_SPAN.set_status.called,
            "active OTEL span was not marked failed — the chat trace "
            "stays status=UNSET",
        )
        status = _OTEL_SPAN.set_status.call_args.args[0]
        self.assertEqual(status.status_code, "ERROR")
        self.assertIn(expected_fragment, status.description)

    def test_wedged_stream_trips_idle_timeout(self):
        worker, box, events_client = self._consume_in_thread(
            _wedged_stream, deadline_s=5, idle_timeout_s=0.3)

        self.assertFalse(
            worker.is_alive(),
            "chat stream consumer is still blocked on a wedged stream — "
            "no idle watchdog (TEAM-3252 silent hang)",
        )
        err = box.get("error")
        self.assertIsNotNone(
            err, "guard did not trip on a wedged chat stream — no error surfaced")
        self.assertEqual(
            str(err), "model chat stream sent no event for 0.3s (idle timeout)")
        self.assertTrue(box["closed"], "chat stream generator was not closed on stall")
        self._assert_agent_error_published(events_client, "(idle timeout)")
        self._assert_span_marked_error("(idle timeout)")

    def test_never_finishing_stream_trips_deadline(self):
        worker, box, events_client = self._consume_in_thread(
            _never_done_stream, deadline_s=0.5, idle_timeout_s=5)

        self.assertFalse(
            worker.is_alive(),
            "chat stream consumer is still blocked on a never-finishing "
            "stream — no wall-clock deadline (TEAM-3252 silent hang)",
        )
        err = box.get("error")
        self.assertIsNotNone(
            err, "guard did not trip on a never-finishing chat stream")
        self.assertEqual(
            str(err),
            "model chat turn exceeded 0.5s without completion (deadline)")
        self.assertTrue(box["closed"], "chat stream generator was not closed on stall")
        self._assert_agent_error_published(events_client, "(deadline)")
        self._assert_span_marked_error("(deadline)")

    def test_happy_path_stream_passes_through(self):
        result_sentinel = object()

        def factory(box):
            async def gen():
                try:
                    yield {"data": "hello "}
                    yield {"data": "world"}
                    yield {"result": result_sentinel}
                finally:
                    box["closed"] = True

            return gen()

        worker, box, events_client = self._consume_in_thread(
            factory, deadline_s=30, idle_timeout_s=30)

        self.assertFalse(worker.is_alive())
        self.assertNotIn("error", box, f"healthy stream raised: {box.get('error')!r}")
        self.assertEqual(
            box["events"],
            [{"data": "hello "}, {"data": "world"}, {"result": result_sentinel}],
        )
        self.assertFalse(
            events_client.put_item.called,
            "a false agent.error was published for a healthy stream",
        )
        self.assertFalse(
            _OTEL_SPAN.set_status.called,
            "span was marked failed for a healthy stream",
        )


if __name__ == "__main__":
    unittest.main()
