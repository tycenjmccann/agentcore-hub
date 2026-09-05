#!/usr/bin/env python3
"""Unit tests for compute_metrics — pure fixtures, no AWS.

Run: python3 -m unittest deploy/workflow-manager/toolkit/test_metrics.py
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from compute_metrics import compute_metrics  # noqa: E402
from events import dedupe_events  # noqa: E402

T0 = "2026-07-01T10:00:00Z"
FIXTURES = Path(__file__).parent / "fixtures"


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


def happy_path_dossier():
    return dossier(
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
    )


class HappyPath(unittest.TestCase):
    def setUp(self):
        self.metrics = compute_metrics(happy_path_dossier())

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


def rejection_rework_dossier():
    return dossier(
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
    )


class RejectionRework(unittest.TestCase):
    def setUp(self):
        self.metrics = compute_metrics(rejection_rework_dossier())

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


class ParkedAdvisory(unittest.TestCase):
    """TEAM-3966 F6: review.parked_advisory (TEAM-3790 — a human's request-changes
    the orchestrator parked because every finding was out-of-diff) is a change
    request with no reopened tickets, and is NOT a review resolution."""

    def setUp(self):
        self.metrics = compute_metrics(dossier(
            tickets=[
                ticket("TEAM-2", "design_agent", "done", updatedAt=ts(20)),
                # The gate stays where the rejection left it: blocked, not done.
                ticket("TEAM-9", "human:alice@example.com", "blocked", title="Design review",
                       updatedAt=ts(45), blockedBy=["TEAM-2"]),
            ],
            events=[
                ev(0, "workflow.phase_change", {"phase": "design", "workflowId": "wf-1"}),
                ev(1, "agent.invoked", {"ticketId": "TEAM-2", "agentId": "design_agent",
                                        "phase": "design", "workflowId": "wf-1"}),
                ev(20, "agent.complete", {"ticketId": "TEAM-2", "agentId": "design_agent",
                                          "workflowId": "wf-1"}),
                ev(21, "review.needed", {"ticketId": "TEAM-9", "reviewer": "human:alice@example.com",
                                         "workflowId": "wf-1"}),
                ev(45, "review.parked_advisory", {"ticketId": "TEAM-9", "reason": "human_origin_rejection",
                                                  "advisoryFindings": [], "workflowId": "wf-1"}),
            ],
        ))

    def test_counted_as_change_request_without_rework(self):
        cr = self.metrics["changeRequests"]
        self.assertEqual(cr["count"], 1)
        cycle = cr["cycles"][0]
        self.assertEqual(cycle["gateTicketId"], "TEAM-9")
        self.assertEqual(cycle["reopenedTickets"], [])
        self.assertIsNone(cycle["reworkDurationMs"])

    def test_not_a_review_resolution(self):
        reviews = self.metrics["humanReviews"]
        self.assertEqual(len(reviews), 1)
        # Parked is not rejected and not approved — the gate is still waiting.
        self.assertEqual(reviews[0]["outcome"], "unresolved")


def reordered(detail):
    """The duplicate copy's detail as EventBridge hands it back: same content,
    different key order (JSON.stringify → JSON.parse does not preserve it). The
    dedupe key must be blind to this, which is why stable_json sorts keys."""
    return {k: detail[k] for k in reversed(list(detail))}


def doubled(events):
    """Every event as the events table actually holds it: the publisher's direct
    PutItem AND the EventBridge fan-out copy written by events-writer.mjs under a
    fresh base36 eventId and its own `source`. Same PK, same content, two rows."""
    out = []
    for i, e in enumerate(events):
        out.append(e)
        copy = dict(e)
        copy["eventId"] = f"0lq7k2x00-{i:04d}"  # events-writer.mjs nextEventId() shape
        copy["source"] = "agentcore-hub.orchestrator"
        copy["detail"] = reordered(e.get("detail") or {})
        out.append(copy)
    return out


class DuplicatedWriters(unittest.TestCase):
    """TEAM-4120 FR-2 — the double-write must not change a single number.

    Every event reaches the events table twice under two different eventIds, so
    the old (workflowId, eventId) dedupe never saw them as one: a 24-minute
    review was counted as two reviews totalling 49 minutes, one rework round as
    two. compute_metrics now content-dedupes first, so a doubled dossier and a
    single-copy dossier must produce identical metrics."""

    def assert_same_as_single(self, build):
        single = compute_metrics(build())
        doubled_dossier = build()
        doubled_dossier["events"] = doubled(doubled_dossier["events"])
        self.assertEqual(len(doubled_dossier["events"]), 2 * len(build()["events"]))
        double = compute_metrics(doubled_dossier)

        # The named numbers that were visibly wrong, called out individually so a
        # regression says which one broke…
        self.assertEqual(double["humanWaitTotalMs"], single["humanWaitTotalMs"])
        self.assertEqual(double["humanReviews"], single["humanReviews"])
        self.assertEqual(double["changeRequests"]["count"], single["changeRequests"]["count"])
        self.assertEqual(
            {t["ticketId"]: t["reworkCount"] for t in double["agentTasks"]},
            {t["ticketId"]: t["reworkCount"] for t in single["agentTasks"]},
        )
        self.assertEqual(double["counts"]["events"], single["counts"]["events"])
        # …and the whole metrics object, because first-occurrence-wins keeps the
        # original rows, so nothing downstream may differ either.
        self.assertEqual(double, single)
        return single

    def test_happy_path_unaffected_by_doubling(self):
        single = self.assert_same_as_single(happy_path_dossier)
        self.assertEqual(single["counts"]["events"], 8)

    def test_rejection_rework_unaffected_by_doubling(self):
        single = self.assert_same_as_single(rejection_rework_dossier)
        # The numbers RejectionRework pins: one change request, one rework round,
        # two review cycles, 43 minutes of human wait — unchanged when doubled.
        self.assertEqual(single["changeRequests"]["count"], 1)
        self.assertEqual(len(single["humanReviews"]), 2)
        self.assertEqual(single["humanWaitTotalMs"], (24 + 19) * 60 * 1000)
        self.assertEqual(
            {t["ticketId"]: t["reworkCount"] for t in single["agentTasks"]}, {"TEAM-2": 1}
        )


class RealDossierFixtures(unittest.TestCase):
    """The same thing on two REAL reduced dossiers, where the duplicates are the
    ones the live table actually produced (not synthesized here). These pin the
    exact numbers the fix changes — the yteqfl run's "7-hour" merge-approval wait
    was one 7-hour wait counted twice, reported as 15 hours."""

    def load(self, name):
        with open(FIXTURES / f"{name}-dossier.json") as f:
            return json.load(f)

    def test_yteqfl(self):
        d = self.load("yteqfl")
        raw = d["events"]
        # What the table holds: 332 rows for 194 distinct events. 138 of the 332
        # carry `source: agentcore-hub.orchestrator` (the EventBridge copy), and
        # 332 - 138 = 194 — so every bus copy pairs with exactly one direct row.
        self.assertEqual(len(raw), 332)
        self.assertEqual(sum(1 for e in raw if e.get("source")), 138)

        m = compute_metrics(d)
        self.assertEqual(m["counts"]["events"], 194)
        # Was 53947448 (14h59m) — two copies of ONE 7-hour wait, plus a phantom
        # "unresolved" first cycle whose resolvedAt was the run end.
        self.assertEqual(m["humanWaitTotalMs"], 25255120)
        self.assertEqual(m["changeRequests"]["count"], 1)  # was 2
        self.assertEqual(len(m["humanReviews"]), 1)  # was 2 cycles for one gate
        review = m["humanReviews"][0]
        self.assertEqual(review["gateTicketId"], "TEAM-4067")
        self.assertEqual(review["outcome"], "approved")
        self.assertEqual(review["cycle"], 1)
        self.assertEqual(review["waitMs"], 25255120)
        tasks = {t["ticketId"]: t["reworkCount"] for t in m["agentTasks"]}
        self.assertEqual(tasks["TEAM-4066"], 2)  # was 5
        # Every other task was reworked zero times; doubling made 19 of them
        # look like they had been reworked once.
        self.assertEqual([t for t, n in tasks.items() if n], ["TEAM-4066"])

    def test_sffzti(self):
        d = self.load("sffzti")
        raw = d["events"]
        self.assertEqual(len(raw), 255)
        self.assertEqual(sum(1 for e in raw if e.get("source")), 94)

        m = compute_metrics(d)
        self.assertEqual(m["counts"]["events"], 161)
        # Was 9297033 — two gates, each counted twice.
        self.assertEqual(m["humanWaitTotalMs"], 2165405)
        self.assertEqual(m["changeRequests"]["count"], 1)  # was 2
        # Two DIFFERENT gates survive (a merge approval and an escalation); one
        # cycle each, where before each had a phantom "unresolved" cycle too.
        self.assertEqual(
            sorted((r["gateTicketId"], r["outcome"], r["cycle"]) for r in m["humanReviews"]),
            [("TEAM-3800", "approved", 1), ("TEAM-3972", "approved", 1)],
        )
        self.assertEqual(sum(r["waitMs"] for r in m["humanReviews"]), 2165405)
        tasks = {t["ticketId"]: t["reworkCount"] for t in m["agentTasks"]}
        self.assertEqual({t: n for t, n in tasks.items() if n}, {"TEAM-3790": 2, "TEAM-3799": 2})

    def test_idempotent(self):
        """Deduping an already-deduped dossier changes nothing — pull_dossier now
        collapses at collection time, so compute_metrics usually sees clean
        input, and must give the same answer either way."""
        for name in ("yteqfl", "sffzti"):
            with self.subTest(name):
                d = self.load(name)
                once = compute_metrics(d)
                clean = self.load(name)
                clean["events"] = dedupe_events(clean["events"])
                self.assertEqual(compute_metrics(clean), once)


if __name__ == "__main__":
    unittest.main()
