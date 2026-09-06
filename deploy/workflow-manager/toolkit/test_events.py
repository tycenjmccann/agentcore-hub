#!/usr/bin/env python3
"""Unit tests for events.py — the content dedupe (TEAM-4120 FR-2, consumer side).

The two directions that matter are asymmetric. Failing to collapse a duplicate
inflates a number; collapsing two GENUINELY different events destroys one, and
nothing downstream can tell. So the distinctness cases below are the important
half of this file.

Run: python3 -m unittest deploy/workflow-manager/toolkit/test_events.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from events import content_key, dedupe_events, stable_json  # noqa: E402


def row(event_id, etype, detail, timestamp=None, pk="wf-1", **kw):
    return {
        "workflowId": pk,
        "eventId": event_id,
        "type": etype,
        "timestamp": timestamp if timestamp is not None else detail.get("timestamp", ""),
        "detail": detail,
        **kw,
    }


def bus_copy(direct, event_id="0lq7k2x00-0001", timestamp=None):
    """The events-writer.mjs copy of a direct-write row: fresh base36 eventId, a
    `source`, detail key order reshuffled by the EventBridge JSON round-trip, and
    (in older runs) a second-granularity row timestamp from `event.time`."""
    d = direct["detail"]
    copy = dict(direct)
    copy["eventId"] = event_id
    copy["source"] = "agentcore-hub.orchestrator"
    copy["detail"] = {k: d[k] for k in reversed(list(d))}
    if timestamp is not None:
        copy["timestamp"] = timestamp
    return copy


TICKET_DETAIL = {
    "ticketId": "TEAM-4120",
    "agentId": "agentcore_hub_api_dev",
    "assignee": "agentcore_hub_api_dev",
    "workflowId": "wf-1",
    "timestamp": "2026-09-05T12:00:00.000Z",
}


class CollapsesTheDoubleWrite(unittest.TestCase):
    def test_direct_and_bus_copy_are_one_event(self):
        direct = row("1757040000000-ab12", "agent.complete", TICKET_DETAIL)
        out = dedupe_events([direct, bus_copy(direct)])
        self.assertEqual(len(out), 1)
        # First occurrence wins: the direct row survives, keeping its eventId.
        self.assertIs(out[0], direct)

    def test_second_granularity_row_timestamp_still_collapses(self):
        """Older runs' bus copies carry EventBridge's `event.time`, which is
        truncated to the second. The key uses detail.timestamp precisely so that
        difference cannot defeat the collapse."""
        direct = row("1757040000000-ab12", "agent.complete", TICKET_DETAIL)
        stale = bus_copy(direct, timestamp="2026-09-05T12:00:00Z")
        self.assertNotEqual(stale["timestamp"], direct["timestamp"])
        self.assertEqual(len(dedupe_events([direct, stale])), 1)

    def test_nested_ticket_id_is_the_ticket_identity(self):
        detail = {"ticket": {"id": "TEAM-9", "status": "todo"},
                  "ticketId": None, "timestamp": "2026-09-05T12:00:00.000Z"}
        direct = row("1757040000000-ab12", "ticket.created", detail)
        self.assertEqual(content_key(direct), "ticket.created|2026-09-05T12:00:00.000Z|TEAM-9|")
        self.assertEqual(len(dedupe_events([direct, bus_copy(direct)])), 1)

    def test_no_ticket_branch_is_blind_to_detail_key_order(self):
        detail = {"phase": "development", "workflowId": "wf-1",
                  "timestamp": "2026-09-05T12:00:00.000Z"}
        direct = row("1757040000000-ab12", "workflow.phase_change", detail)
        self.assertEqual(len(dedupe_events([direct, bus_copy(direct)])), 1)
        self.assertEqual(
            content_key(direct),
            'workflow.phase_change|2026-09-05T12:00:00.000Z|'
            '{"phase":"development","timestamp":"2026-09-05T12:00:00.000Z","workflowId":"wf-1"}',
        )


class KeepsDifferentEventsDistinct(unittest.TestCase):
    def test_same_millisecond_different_ticket(self):
        a = row("a-1", "agent.invoked", {**TICKET_DETAIL, "ticketId": "TEAM-4120"})
        b = row("b-2", "agent.invoked", {**TICKET_DETAIL, "ticketId": "TEAM-4121"})
        self.assertEqual(len(dedupe_events([a, b])), 2)

    def test_same_ticket_different_type_agent_or_millisecond(self):
        base = row("a-1", "agent.invoked", TICKET_DETAIL)
        others = [
            row("b-2", "agent.complete", TICKET_DETAIL),
            row("c-3", "agent.invoked", {**TICKET_DETAIL, "agentId": "agentcore_hub_qa"}),
            row("d-4", "agent.invoked", {**TICKET_DETAIL, "timestamp": "2026-09-05T12:00:00.001Z"}),
        ]
        self.assertEqual(len(dedupe_events([base] + others)), 4)

    def test_a_real_rework_round_survives(self):
        """The same agent invoked twice on the same ticket — one rework round — is
        two events, not one. Collapsing these would erase the rework."""
        first = row("a-1", "agent.invoked", {**TICKET_DETAIL, "timestamp": "2026-09-05T12:00:00.000Z"})
        rework = row("b-2", "agent.invoked", {**TICKET_DETAIL, "timestamp": "2026-09-05T13:30:00.000Z"})
        self.assertEqual(len(dedupe_events([first, bus_copy(first), rework, bus_copy(rework, "0lq7k2x00-0002")])), 2)

    def test_no_ticket_branch_distinguishes_by_detail(self):
        ts = "2026-09-05T12:00:00.000Z"
        a = row("a-1", "workflow.phase_change", {"phase": "design", "timestamp": ts})
        b = row("b-2", "workflow.phase_change", {"phase": "development", "timestamp": ts})
        self.assertEqual(len(dedupe_events([a, b])), 2)


class TimestampFallback(unittest.TestCase):
    """Events from writers other than publishEvent (workflow.report_completion,
    manager.intervention, agent.error/agent.retry, ticket-keyed agent.started)
    carry no detail.timestamp. Falling back to "" for all of them would collapse
    every one of them onto a single key."""

    def test_falls_back_to_the_row_timestamp(self):
        a = row("a-1", "workflow.report_completion", {"ticketId": "TEAM-1"},
                timestamp="2026-09-05T12:00:00.000Z")
        self.assertEqual(
            content_key(a), "workflow.report_completion|2026-09-05T12:00:00.000Z|TEAM-1|"
        )

    def test_two_completions_for_one_ticket_stay_distinct(self):
        a = row("a-1", "workflow.report_completion", {"ticketId": "TEAM-1"},
                timestamp="2026-09-05T12:00:00.000Z")
        b = row("b-2", "workflow.report_completion", {"ticketId": "TEAM-1"},
                timestamp="2026-09-05T13:00:00.000Z")
        self.assertEqual(len(dedupe_events([a, b])), 2)

    def test_identical_rows_with_no_timestamp_at_all_still_collapse(self):
        a = {"workflowId": "wf-1", "eventId": "a-1", "type": "agent.error",
             "detail": {"ticketId": "TEAM-1", "error": "boom"}}
        b = dict(a, eventId="b-2", source="agentcore-hub.orchestrator")
        self.assertEqual(content_key(a), "agent.error||TEAM-1|")
        self.assertEqual(len(dedupe_events([a, b])), 1)

    def test_missing_or_non_dict_detail_does_not_raise(self):
        self.assertEqual(content_key({"type": "agent.error"}), "agent.error||{}")
        self.assertEqual(content_key({"type": "agent.error", "detail": None}), "agent.error||{}")
        self.assertEqual(content_key({"type": "agent.error", "detail": "oops"}), "agent.error||{}")
        self.assertEqual(content_key({}), "||{}")


class Streaming(unittest.TestCase):
    """agent.streaming rows are KEPT (pull_dossier builds per-agent counts and the
    verdict tail from them) but keyed, so the doubled copies collapse and the
    counts come out right. cost-report drops them entirely instead."""

    def chunk(self, event_id, ms, content, sub="text", agent="dev_agent"):
        return row(event_id, "agent.streaming",
                   {"agentId": agent, "type": sub, "content": content,
                    "timestamp": f"2026-09-05T12:00:{ms}Z"})

    def test_doubled_chunks_collapse(self):
        a = self.chunk("a-1", "00.100", "hello ")
        b = self.chunk("b-2", "00.200", "world")
        rows = [a, bus_copy(a), b, bus_copy(b, "0lq7k2x00-0002")]
        out = dedupe_events(rows)
        self.assertEqual(len(out), 2)
        self.assertEqual([e["detail"]["content"] for e in out], ["hello ", "world"])

    def test_repeated_content_at_different_times_is_two_chunks(self):
        # An agent legitimately streams the same short token twice.
        a = self.chunk("a-1", "00.100", "ok")
        b = self.chunk("b-2", "00.300", "ok")
        self.assertEqual(len(dedupe_events([a, b])), 2)

    def test_subtype_and_agent_are_part_of_the_key(self):
        text = self.chunk("a-1", "00.100", "x", sub="text")
        reasoning = self.chunk("b-2", "00.100", "x", sub="reasoning")
        other_agent = self.chunk("c-3", "00.100", "x", agent="qa_agent")
        self.assertEqual(len(dedupe_events([text, reasoning, other_agent])), 3)

    def test_trace_chunks_key_on_tool_name(self):
        # A trace subtype has no content — toolName is what distinguishes it.
        a = row("a-1", "agent.streaming", {"agentId": "dev_agent", "type": "trace",
                                           "toolName": "Read", "timestamp": "2026-09-05T12:00:00.100Z"})
        b = row("b-2", "agent.streaming", {"agentId": "dev_agent", "type": "trace",
                                           "toolName": "Edit", "timestamp": "2026-09-05T12:00:00.100Z"})
        self.assertEqual(len(dedupe_events([a, bus_copy(a), b])), 2)


class OrderAndShape(unittest.TestCase):
    def test_input_order_is_preserved(self):
        rows = [row(f"{i}-x", "agent.invoked", {**TICKET_DETAIL, "ticketId": f"TEAM-{i}"})
                for i in range(5)]
        shuffled = [rows[3], rows[0], rows[4], rows[1], rows[2]]
        out = dedupe_events(shuffled + [bus_copy(r, f"0lq7k2x00-{i:04d}") for i, r in enumerate(shuffled)])
        self.assertEqual([e["eventId"] for e in out], [e["eventId"] for e in shuffled])

    def test_empty_and_none(self):
        self.assertEqual(dedupe_events([]), [])
        self.assertEqual(dedupe_events(None), [])

    def test_does_not_mutate_its_input(self):
        direct = row("a-1", "agent.complete", TICKET_DETAIL)
        rows = [direct, bus_copy(direct)]
        before = [dict(r) for r in rows]
        dedupe_events(rows)
        self.assertEqual(rows, before)
        self.assertEqual(len(rows), 2)


class StableJson(unittest.TestCase):
    """Same output as the JS stableJson in lambda/cost-report/index.mjs and
    lambda/orchestrator/event-id.mjs — the three must agree on the key so a
    producer-side collapse and a consumer-side collapse never disagree."""

    def test_sorts_keys_recursively(self):
        self.assertEqual(
            stable_json({"b": 1, "a": {"d": 2, "c": [3, {"f": 4, "e": 5}]}}),
            '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
        )

    def test_primitives_render_like_json_stringify(self):
        self.assertEqual(stable_json(None), "null")
        self.assertEqual(stable_json(True), "true")
        self.assertEqual(stable_json("x"), '"x"')
        self.assertEqual(stable_json(7), "7")
        self.assertEqual(stable_json([1, "a"]), '[1,"a"]')
        self.assertEqual(stable_json({}), "{}")

    def test_non_ascii_is_not_escaped(self):
        # JSON.stringify does not \u-escape, so neither does this.
        self.assertEqual(stable_json({"k": "café"}), '{"k":"café"}')

    def test_unserializable_values_do_not_raise(self):
        from decimal import Decimal
        # A raw DynamoDB number would arrive as Decimal if undecimal were ever
        # skipped; the key must degrade, not explode.
        self.assertEqual(stable_json({"n": Decimal("3")}), '{"n":"3"}')


if __name__ == "__main__":
    unittest.main()
