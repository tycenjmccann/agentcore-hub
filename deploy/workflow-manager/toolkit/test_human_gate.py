"""TEAM-5371 — the one Python human-gate rule (compute_metrics.is_human_gate), mirror of
fix-contract.mjs isHumanGate / completion-evidence.ts isHumanGateTicket, and the
toolkit sites that classify through it. Hermetic: compute_metrics is stdlib-pure;
pull_dossier gets a boto3 stub like test_pull_dossier.

Run: python3 -m pytest deploy/workflow-manager/toolkit/test_human_gate.py -v
"""

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
sys.modules.setdefault("boto3", mock.MagicMock())
sys.modules.setdefault("boto3.dynamodb", mock.MagicMock())
sys.modules.setdefault("boto3.dynamodb.conditions", mock.MagicMock())

from compute_metrics import compute_agent_tasks, compute_human_reviews, gate_reviewer, is_human_gate  # noqa: E402

AGENT = "agentcore_hub_release_manager"

CASES = [
    ("human: assignee", {"assignee": "human:engineer"}, True),
    ("human-review label on an agent", {"assignee": AGENT, "labels": ["human-review"]}, True),
    ("reviewer: label only", {"assignee": AGENT, "labels": ["reviewer:engineer"]}, True),
    ("case + whitespace", {"labels": [" Human-Review "]}, True),
    ("comma-string labels", {"labels": "phase:ship, reviewer:alice"}, True),
    ("a set (boto3 SS)", {"labels": {"reviewer:alice"}}, True),
    ("plain agent", {"assignee": AGENT, "labels": ["phase:ship"]}, False),
    ("near miss", {"assignee": AGENT, "labels": ["human-reviewer"]}, False),
    ("null assignee/labels", {"assignee": None, "labels": None}, False),
    ("empty", {}, False),
    ("not a dict", None, False),
]


# The fixture every JS/TS site runs (src/lib/workflow/human-gate-parity.test.ts).
SHARED = json.loads((Path(__file__).resolve().parents[3] / "src/lib/workflow/human-gate-cases.json").read_text())["cases"]


class IsHumanGate(unittest.TestCase):
    def test_cases(self):
        for name, ticket, expected in CASES:
            with self.subTest(name):
                self.assertIs(is_human_gate(ticket), expected)

    def test_shared_fixture(self):
        self.assertGreater(len(SHARED), 10)
        for case in SHARED:
            with self.subTest(case["name"]):
                self.assertIs(is_human_gate(case["ticket"]), case["isHumanGate"])

    def test_shared_fixture_with_set_labels(self):
        # boto3 deserialises a DynamoDB SS as a Python set; the rule must not care.
        rows = [c for c in SHARED if c.get("pythonSet")]
        self.assertTrue(rows)
        for case in rows:
            with self.subTest(case["name"]):
                ticket = {**case["ticket"], "labels": set(case["ticket"]["labels"])}
                self.assertIs(is_human_gate(ticket), case["isHumanGate"])


class GateReviewer(unittest.TestCase):
    def test_names_who_the_gate_waits_on(self):
        self.assertEqual(gate_reviewer({"assignee": "human:bob", "labels": ["reviewer:alice"]}), "human:bob")
        self.assertEqual(gate_reviewer({"assignee": AGENT, "labels": ["human-review", "reviewer:alice"]}), "human:alice")
        self.assertEqual(gate_reviewer({"assignee": AGENT, "labels": "phase:ship, reviewer:alice"}), "human:alice")
        self.assertEqual(gate_reviewer({"assignee": AGENT, "labels": ["human-review"]}), AGENT)


class Sites(unittest.TestCase):
    def test_a_label_only_gate_is_not_agent_work(self):
        tickets = [
            {"ticketId": "T-1", "assignee": AGENT, "labels": ["human-review"], "status": "done"},
            {"ticketId": "T-2", "assignee": AGENT, "labels": [], "status": "done"},
        ]
        ids = [t["ticketId"] for t in compute_agent_tasks(tickets, [])]
        self.assertEqual(ids, ["T-2"])

    def test_a_label_only_gate_counts_as_a_human_review(self):
        tickets = [{"ticketId": "T-1", "assignee": AGENT, "labels": ["reviewer:alice"], "status": "done", "type": "task"}]
        needed = [{"type": "review.needed", "timestamp": "2026-07-01T10:00:00Z", "detail": {"ticketId": "T-1"}}]
        reviews, _ = compute_human_reviews(tickets, needed, {}, None, [], gate_decisions={})
        self.assertEqual([r["gateTicketId"] for r in reviews], ["T-1"])
        # The reviewer is the human the label names, not the agent assignee.
        self.assertEqual([r["reviewer"] for r in reviews], ["human:alice"])
        # The same ticket without the marker is agent work, never a review.
        plain = [{**tickets[0], "labels": []}]
        self.assertEqual(compute_human_reviews(plain, needed, {}, None, [], gate_decisions={})[0], [])

    def test_pull_dossier_and_intervene_use_this_helper(self):
        import pull_dossier  # noqa: E402
        self.assertIs(pull_dossier.is_human_gate, is_human_gate)
        src = Path(__file__).with_name("pull_dossier.py").read_text()
        self.assertNotIn('startswith("human:")', src)
        isrc = Path(__file__).with_name("intervene.py").read_text()
        self.assertNotIn('startswith("human:")', isrc)
        self.assertIn("from compute_metrics import is_human_gate", isrc)


if __name__ == "__main__":
    unittest.main()
