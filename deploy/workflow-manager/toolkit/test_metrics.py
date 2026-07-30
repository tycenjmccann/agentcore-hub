#!/usr/bin/env python3
"""Unit tests for compute_metrics — pure fixtures, no AWS.

Run: python3 -m unittest deploy/workflow-manager/toolkit/test_metrics.py
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from compute_metrics import compute_metrics  # noqa: E402

T0 = "2026-07-01T10:00:00Z"


def ts(minutes):
    hh, mm = divmod(minutes, 60)
    return f"2026-07-01T{10 + hh:02d}:{mm:02d}:00Z"


def ev(minutes, etype, detail, pk="wf-1"):
    return {
        "workflowId": pk,
        "eventId": f"{minutes:06d}-test",
        "type": etype,
        "timestamp": ts(minutes),
        "detail": detail,
    }


def ticket(tid, assignee, status, title="Task", **kw):
    return {
        "ticketId": tid, "assignee": assignee, "status": status, "title": title,
        "type": kw.pop("type", "task"), "createdAt": kw.pop("createdAt", T0),
        "updatedAt": kw.pop("updatedAt", T0), "blockedBy": kw.pop("blockedBy", []),
        **kw,
    }


def dossier(**overrides):
    base = {
        "workflowId": "wf-1",
        "workflowDefId": "software-delivery",
        "epicId": "TEAM-1",
        "ticketProvider": "dynamodb",
        "workflow": {"startedAt": T0, "completedAt": ts(120), "humanNotifications": []},
        "tickets": [],
        "events": [],
        "completions": {},
        "artifacts": [],
        "evalSummaries": [],
        "missingSignals": [],
    }
    base.update(overrides)
    return base


class HappyPath(unittest.TestCase):
    def setUp(self):
        self.metrics = compute_metrics(dossier(
            tickets=[
                ticket("TEAM-1", None, "done", type="epic"),
                ticket("TEAM-2", "dev_agent", "done", updatedAt=ts(60)),
                ticket("TEAM-3", "qa_agent", "done", updatedAt=ts(110)),
            ],
            events=[
                ev(0, "workflow.phase_change", {"phase": "development", "workflowId": "wf-1"}),
                ev(1, "agent.invoked", {"ticketId": "TEAM-2", "agentId": "dev_agent",
                                        "phase": "development", "workflowId": "wf-1"}),
                ev(2, "agent.started", {"ticketId": "TEAM-2", "agentId": "dev_agent"}, pk="TEAM-2"),
                ev(55, "agent.complete", {"ticketId": "TEAM-2", "agentId": "dev_agent",
                                          "workflowId": "wf-1"}),
                ev(56, "workflow.phase_change", {"phase": "verification", "workflowId": "wf-1"}),
                ev(57, "agent.invoked", {"ticketId": "TEAM-3", "agentId": "qa_agent",
                                         "phase": "verification", "workflowId": "wf-1"}),
                ev(110, "agent.complete", {"ticketId": "TEAM-3", "agentId": "qa_agent",
                                           "workflowId": "wf-1"}),
                ev(115, "workflow.complete", {"workflowId": "wf-1"}),
            ],
        ))

    def test_total_duration(self):
        self.assertEqual(self.metrics["totalDurationMs"], 120 * 60 * 1000)

    def test_phase_durations(self):
        phases = self.metrics["phases"]
        self.assertEqual([p["phase"] for p in phases], ["development", "verification"])
        self.assertEqual(phases[0]["durationMs"], 56 * 60 * 1000)
        self.assertEqual(phases[0]["taskCount"], 1)
        # last phase runs to completedAt
        self.assertEqual(phases[1]["durationMs"], (120 - 56) * 60 * 1000)

    def test_task_durations_and_ticket_keyed_events(self):
        tasks = {t["ticketId"]: t for t in self.metrics["agentTasks"]}
        # invokedAt is the agent.invoked at minute 1 (agent.started sits under
        # the TEAM-2 PK and must still be merged in without breaking anything)
        self.assertEqual(tasks["TEAM-2"]["durationMs"], 54 * 60 * 1000)
        self.assertEqual(tasks["TEAM-2"]["reworkCount"], 0)
        self.assertEqual(tasks["TEAM-2"]["phase"], "development")
        self.assertNotIn("TEAM-1", tasks)  # epic excluded

    def test_no_reviews_no_changes(self):
        self.assertEqual(self.metrics["humanReviews"], [])
        self.assertEqual(self.metrics["humanWaitTotalMs"], 0)
        self.assertEqual(self.metrics["changeRequests"]["count"], 0)
        self.assertEqual(self.metrics["fixTickets"]["count"], 0)

    def test_tokens_missing_signal(self):
        self.assertIsNone(self.metrics["tokens"])
        self.assertTrue(any("token_usage" in s
                            for s in self.metrics["dataQuality"]["missingSignals"]))


class RejectionRework(unittest.TestCase):
    def setUp(self):
        self.metrics = compute_metrics(dossier(
            tickets=[
                ticket("TEAM-2", "design_agent", "done", updatedAt=ts(80)),
                ticket("TEAM-9", "human:alice@example.com", "done", title="Design review",
                       updatedAt=ts(100), blockedBy=["TEAM-2"]),
            ],
            events=[
                ev(0, "workflow.phase_change", {"phase": "design", "workflowId": "wf-1"}),
                ev(1, "agent.invoked", {"ticketId": "TEAM-2", "agentId": "design_agent",
                                        "phase": "design", "workflowId": "wf-1"}),
                ev(20, "agent.complete", {"ticketId": "TEAM-2", "agentId": "design_agent",
                                          "workflowId": "wf-1"}),
                ev(21, "review.needed", {"ticketId": "TEAM-9", "reviewer": "human:alice@example.com",
                                         "workflowId": "wf-1"}),
                ev(45, "review.rejected", {"ticketId": "TEAM-9", "onReject": "rework",
                                           "reopened": ["TEAM-2"], "workflowId": "wf-1"}),
                ev(46, "agent.invoked", {"ticketId": "TEAM-2", "agentId": "design_agent",
                                         "phase": "design", "workflowId": "wf-1"}),
                ev(80, "agent.complete", {"ticketId": "TEAM-2", "agentId": "design_agent",
                                          "workflowId": "wf-1"}),
                ev(81, "review.needed", {"ticketId": "TEAM-9", "reviewer": "human:alice@example.com",
                                         "workflowId": "wf-1"}),
            ],
        ))

    def test_change_request_cycle(self):
        cr = self.metrics["changeRequests"]
        self.assertEqual(cr["count"], 1)
        cycle = cr["cycles"][0]
        self.assertEqual(cycle["gateTicketId"], "TEAM-9")
        self.assertEqual(cycle["reopenedTickets"], ["TEAM-2"])
        self.assertEqual(cycle["reworkDurationMs"], 35 * 60 * 1000)  # 45 → 80

    def test_review_cycles(self):
        reviews = self.metrics["humanReviews"]
        self.assertEqual(len(reviews), 2)
        first, second = sorted(reviews, key=lambda r: r["cycle"])
        self.assertEqual(first["outcome"], "rejected")
        self.assertEqual(first["waitMs"], 24 * 60 * 1000)  # 21 → 45
        self.assertEqual(second["outcome"], "approved")
        self.assertEqual(second["waitMs"], 19 * 60 * 1000)  # 81 → 100 (ticket done)

    def test_rework_count(self):
        tasks = {t["ticketId"]: t for t in self.metrics["agentTasks"]}
        self.assertEqual(tasks["TEAM-2"]["reworkCount"], 1)
        # human gate ticket is not an agent task
        self.assertNotIn("TEAM-9", tasks)

    def test_human_wait_total(self):
        self.assertEqual(self.metrics["humanWaitTotalMs"], (24 + 19) * 60 * 1000)


class MissingPhaseEvents(unittest.TestCase):
    def test_falls_back_gracefully(self):
        metrics = compute_metrics(dossier(
            tickets=[ticket("TEAM-2", "dev_agent", "done", updatedAt=ts(30))],
            events=[],
        ))
        self.assertEqual(metrics["phases"], [])
        self.assertTrue(any("phase_change" in s
                            for s in metrics["dataQuality"]["missingSignals"]))
        # task falls back to ticket timestamps: createdAt T0 → updatedAt(done)
        task = metrics["agentTasks"][0]
        self.assertEqual(task["durationMs"], 30 * 60 * 1000)


class CancelledRun(unittest.TestCase):
    def test_uses_cancelled_at_and_marks_unresolved_review(self):
        metrics = compute_metrics(dossier(
            workflow={"startedAt": T0, "cancelledAt": ts(50), "humanNotifications": []},
            tickets=[
                ticket("TEAM-9", "human:bob", "in_review", title="Gate"),
                ticket("TEAM-5", "dev_agent", "in_progress", title="Fix: broken build"),
            ],
            events=[
                ev(10, "review.needed", {"ticketId": "TEAM-9", "reviewer": "human:bob",
                                         "workflowId": "wf-1"}),
                ev(40, "agent.error", {"agentId": "dev_agent", "error": "boom",
                                       "workflowId": "wf-1"}),
            ],
        ))
        self.assertEqual(metrics["totalDurationMs"], 50 * 60 * 1000)
        review = metrics["humanReviews"][0]
        self.assertEqual(review["outcome"], "unresolved")
        self.assertEqual(review["waitMs"], 40 * 60 * 1000)  # 10 → run end
        self.assertEqual(metrics["fixTickets"], {"count": 1, "ticketIds": ["TEAM-5"]})
        self.assertEqual(len(metrics["errors"]), 1)


class TokensAndInterventions(unittest.TestCase):
    def test_token_usage_and_manager_events(self):
        metrics = compute_metrics(dossier(
            events=[
                ev(1, "token_usage", {"agentId": "dev_agent", "inputTokens": 1000,
                                      "outputTokens": 200, "workflowId": "wf-1"}),
                ev(2, "token_usage", {"agentId": "dev_agent", "inputTokens": 500,
                                      "outputTokens": 100, "workflowId": "wf-1"}),
                ev(3, "manager.intervention", {"action": "unstick", "by": "workflow-manager",
                                               "note": "stuck todo", "workflowId": "wf-1"}),
                ev(4, "workflow.nudge", {"nudged": ["TEAM-2 (todo→ready)"],
                                         "ticketsScanned": 4}),
            ],
        ))
        self.assertEqual(metrics["tokens"]["totalInput"], 1500)
        self.assertEqual(metrics["tokens"]["byAgent"]["dev_agent"]["output"], 300)
        self.assertEqual(len(metrics["managerInterventions"]), 1)
        self.assertEqual(metrics["managerInterventions"][0]["action"], "unstick")
        self.assertEqual(metrics["nudgeCount"], 1)


if __name__ == "__main__":
    unittest.main()
