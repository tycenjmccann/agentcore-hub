#!/usr/bin/env python3
"""Unit tests for pull_dossier.get_events — hermetic, no AWS.

TEAM-4120 FR-2: get_events is where the double-write does the most damage that
compute_metrics can NEVER undo — streaming chunks are folded into per-agent
counters and a text tail and then thrown away, so a doubled chunk means a doubled
count and a tail that reads "hello hello world world" forever after. The dossier
is the record; this has to be right at collection time.

boto3 (and boto3.dynamodb.conditions) are stubbed in sys.modules BEFORE importing
pull_dossier — it imports boto3 and reads ARTIFACT_BUCKET at module load, and the
CI toolkit job installs no boto3 — and dynamodb.Table is replaced with a fake
that replays canned pages. No production code is modified, no AWS call is made.

Run: python3 -m unittest deploy/workflow-manager/toolkit/test_pull_dossier.py
     pytest -q deploy/workflow-manager/toolkit/test_pull_dossier.py
"""

import os
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

sys.modules["boto3"] = mock.MagicMock()
sys.modules["boto3.dynamodb"] = mock.MagicMock()
sys.modules["boto3.dynamodb.conditions"] = mock.MagicMock()
os.environ.setdefault("ARTIFACT_BUCKET", "test-bucket")

import pull_dossier  # noqa: E402


class FakeTable:
    """Replays {pk: [page, page, …]} as a FIFO of query responses — get_events
    walks the PKs in order and pages within each, so call order is enough (the
    stubbed Key().eq() is a MagicMock, so the PK cannot be read back off the
    condition). Every page but its PK's last carries a LastEvaluatedKey, which is
    what drives the pagination loop."""

    def __init__(self, pages_by_pk):
        self.queue = []
        for pk, pages in pages_by_pk.items():
            for i, items in enumerate(pages):
                response = {"Items": items}
                if i + 1 < len(pages):
                    response["LastEvaluatedKey"] = {"workflowId": pk, "page": i}
                self.queue.append(response)

    def query(self, **kwargs):
        assert self.queue, "query called more times than there are pages"
        return self.queue.pop(0)


def row(event_id, etype, detail, timestamp=None, pk="wf-1", **kw):
    return {
        "workflowId": pk,
        "eventId": event_id,
        "type": etype,
        "timestamp": timestamp if timestamp is not None else detail.get("timestamp", ""),
        "detail": detail,
        **kw,
    }


def bus_copy(direct, event_id):
    """The events-writer.mjs copy: fresh base36 eventId, its own `source`, and
    detail key order reshuffled by the EventBridge JSON round-trip."""
    d = direct["detail"]
    copy = dict(direct)
    copy["eventId"] = event_id
    copy["source"] = "agentcore-hub.orchestrator"
    copy["detail"] = {k: d[k] for k in reversed(list(d))}
    return copy


def chunk(event_id, ms, content=None, sub="text", agent="dev_agent", tool=None):
    detail = {"agentId": agent, "type": sub, "timestamp": f"2026-09-05T12:00:{ms}Z"}
    if content is not None:
        detail["content"] = content
    if tool is not None:
        detail["toolName"] = tool
    return row(event_id, "agent.streaming", detail)


def get_events(pages_by_pk, *args):
    table = FakeTable(pages_by_pk)
    with mock.patch.object(pull_dossier, "dynamodb") as ddb:
        ddb.Table.return_value = table
        return pull_dossier.get_events(*args)


INVOKED = row("1757040001000-ab12", "agent.invoked",
              {"ticketId": "TEAM-1", "agentId": "dev_agent",
               "attempt": Decimal("1"), "timestamp": "2026-09-05T12:00:01.000Z"})
STARTED = row("1757040002000-cd34", "agent.started",
              {"ticketId": "TEAM-1", "agentId": "dev_agent",
               "timestamp": "2026-09-05T12:00:02.000Z"}, pk="TEAM-1")


class StreamCounts(unittest.TestCase):
    def test_doubled_chunks_are_counted_once(self):
        a, b, t = chunk("a-1", "00.100", "hello "), chunk("a-2", "00.200", "world"), \
            chunk("a-3", "00.300", sub="trace", tool="Read")
        events, counts = get_events(
            {"wf-1": [[a, b, t, bus_copy(a, "0lq7k2x00-0001"),
                       bus_copy(b, "0lq7k2x00-0002"), bus_copy(t, "0lq7k2x00-0003")]]},
            "wf-1", None, [],
        )
        self.assertEqual(events, [])  # streaming rows never enter the events list
        self.assertEqual(counts["dev_agent"]["text"], 2)  # was 4
        self.assertEqual(counts["dev_agent"]["trace"], 1)  # was 2
        # …and the verdict tail is the agent's words ONCE, in order.
        self.assertEqual(counts["dev_agent"]["lastText"], "hello world")
        self.assertEqual(counts["dev_agent"]["lastStreamAt"], "2026-09-05T12:00:00.300Z")

    def test_repeated_token_at_a_different_instant_is_still_two_chunks(self):
        a, b = chunk("a-1", "00.100", "ok"), chunk("a-2", "00.300", "ok")
        _, counts = get_events({"wf-1": [[a, b]]}, "wf-1", None, [])
        self.assertEqual(counts["dev_agent"]["text"], 2)
        self.assertEqual(counts["dev_agent"]["lastText"], "okok")

    def test_per_agent_and_per_subtype(self):
        rows = [chunk("a-1", "00.100", "x"), chunk("a-2", "00.100", "x", sub="reasoning"),
                chunk("a-3", "00.100", "y", agent="qa_agent")]
        _, counts = get_events({"wf-1": [rows + [bus_copy(r, f"0lq-{i}") for i, r in enumerate(rows)]]},
                               "wf-1", None, [])
        self.assertEqual(counts["dev_agent"], {"text": 1, "trace": 0, "reasoning": 1,
                                               "lastText": "xx", "lastStreamAt": "2026-09-05T12:00:00.100Z"})
        self.assertEqual(counts["qa_agent"]["text"], 1)


class SignificantEvents(unittest.TestCase):
    def test_doubled_events_collapse_and_the_direct_copy_wins(self):
        events, _ = get_events(
            {"wf-1": [[INVOKED, bus_copy(INVOKED, "0lq7k2x00-0001")]]}, "wf-1", None, [],
        )
        self.assertEqual([e["eventId"] for e in events], ["1757040001000-ab12"])
        self.assertNotIn("source", events[0])
        # undecimal still runs: no Decimal survives into the dossier.
        self.assertEqual(events[0]["detail"]["attempt"], 1)
        self.assertIsInstance(events[0]["detail"]["attempt"], int)

    def test_collapse_spans_pages_and_partition_keys(self):
        # The direct row sits under the wf PK on page 1; its bus copy comes back on
        # page 2, and the ticket-keyed agent.started is doubled under its own PK.
        events, _ = get_events(
            {
                "wf-1": [[INVOKED], [bus_copy(INVOKED, "0lq7k2x00-0001")]],
                "TEAM-1": [[STARTED, bus_copy(STARTED, "0lq7k2x00-0002")]],
            },
            "wf-1", None, ["TEAM-1"],
        )
        self.assertEqual([e["type"] for e in events], ["agent.invoked", "agent.started"])
        # Ticket-keyed agent.started is still flagged for the manager.
        self.assertEqual(events[1]["_pkNote"], "ticket-keyed")

    def test_a_real_rework_round_survives(self):
        rework = row("1757043601000-ef56", "agent.invoked",
                     {"ticketId": "TEAM-1", "agentId": "dev_agent",
                      "timestamp": "2026-09-05T13:00:01.000Z"})
        events, _ = get_events(
            {"wf-1": [[INVOKED, bus_copy(INVOKED, "0lq7k2x00-0001"),
                       rework, bus_copy(rework, "0lq7k2x00-0002")]]},
            "wf-1", None, [],
        )
        self.assertEqual([e["eventId"] for e in events],
                         ["1757040001000-ab12", "1757043601000-ef56"])

    def test_insignificant_types_are_dropped_and_output_is_sorted(self):
        late = row("1757040009000-zz99", "workflow.complete",
                   {"workflowId": "wf-1", "timestamp": "2026-09-05T12:00:09.000Z"})
        noise = row("1757040003000-xx11", "token_usage",
                    {"agentId": "dev_agent", "inputTokens": Decimal("10"),
                     "timestamp": "2026-09-05T12:00:03.000Z"})
        events, _ = get_events({"wf-1": [[late, noise, INVOKED]]}, "wf-1", None, [])
        self.assertEqual([e["type"] for e in events], ["agent.invoked", "workflow.complete"])


class EmptyRun(unittest.TestCase):
    def test_no_events(self):
        self.assertEqual(get_events({"wf-1": [[]]}, "wf-1", None, []), ([], {}))


if __name__ == "__main__":
    unittest.main()
