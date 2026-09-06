#!/usr/bin/env python3
"""Unit tests for compute_metrics — pure fixtures, no AWS.

Run: python3 -m unittest deploy/workflow-manager/toolkit/test_metrics.py
"""

import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

from compute_metrics import (  # noqa: E402
    business_window,
    compute_metrics,
    intake_completed_at,
    is_outside_hours,
    jaccard,
    title_fix_kind,
    title_slot_tokens,
)
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
        # TEAM-4121 FR-10: count/ticketIds keep their old meaning (this dossier
        # has no intake events, so the legacy "Fix:" title still counts — see
        # FixLineage for the exclusion), with the lineage alongside them.
        self.assertEqual(metrics["fixTickets"]["count"], 1)
        self.assertEqual(metrics["fixTickets"]["ticketIds"], ["TEAM-5"])
        self.assertEqual(metrics["fixTickets"]["byTag"]["new"], 1)
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


class FixLineage(unittest.TestCase):
    """TEAM-4121 FR-10 — `fixTickets` stopped being a count and became lineage.

    The old number was `title.startswith("Fix:")`, wrong in both directions at
    once (which is why nobody noticed: the errors cancelled). The agents had
    settled on "Fix (review):" / "Fix (QA):" / "Fix (ship-review r2):" /
    "Fix (CI):", none of which starts with "Fix:", so real rework went uncounted
    — while a BUG-FIX run's intake-planned "Fix: <the feature>" ticket, the work
    the run exists to do, was counted as a rework loop.

    fixtures/fix-lineage.json is hand-built (its `_fixture.cases` says why each
    ticket is there) because no single real run exercises all six kinds, all four
    tags and the exclusion. The same fixture is read by
    lambda/cost-report/index.test.mjs, which asserts the JS predicate returns the
    SAME count and ids — the performance card and the WM show this number side by
    side for one run and must not disagree about what a fix ticket is."""

    @classmethod
    def setUpClass(cls):
        with open(FIXTURES / "fix-lineage.json") as f:
            cls.dossier = json.load(f)
        cls.fix = compute_metrics(cls.dossier)["fixTickets"]
        cls.entries = {e["ticketId"]: e for e in cls.fix["entries"]}

    def test_count_and_ids_in_creation_order(self):
        self.assertEqual(self.fix["count"], 11)
        self.assertEqual(self.fix["ticketIds"], [
            "LIN-10", "LIN-11", "LIN-12", "LIN-13", "LIN-14",
            "LIN-15", "LIN-16", "LIN-17", "LIN-18", "LIN-19", "LIN-21",
        ])

    def test_matches_the_fixture_expectation(self):
        """The fixture states what it is for; if the code and the fixture drift,
        one of the two is wrong and the reader deserves to be told which."""
        expected = self.dossier["_fixture"]["expected"]
        self.assertEqual(self.fix["count"], expected["count"])
        self.assertEqual(self.fix["byKind"], expected["byKind"])
        self.assertEqual(self.fix["byTag"], expected["byTag"])

    def test_intake_planned_fix_ticket_is_excluded(self):
        intake_at = intake_completed_at(
            self.dossier["events"], self.dossier["tickets"], self.dossier["epicId"])
        planned = next(t for t in self.dossier["tickets"] if t["ticketId"] == "LIN-3")
        # The fixture's own claim, restated as an assertion: LIN-3 IS titled
        # "Fix:" and WAS created before intake finished planning.
        self.assertTrue(planned["title"].startswith("Fix:"))
        self.assertEqual(iso_of(planned["createdAt"]), "2026-07-02T10:10:00Z")
        self.assertEqual(iso_of(intake_at), "2026-07-02T10:15:00Z")
        self.assertNotIn("LIN-3", self.fix["ticketIds"])

    def test_the_exclusion_also_prevents_a_false_fix_induced(self):
        """LIN-4 (the review ticket LIN-10/LIN-11 were spawned from) is blockedBy
        LIN-3. Had LIN-3 counted as a fix, its own follow-ups would read as
        "fix-induced" — the run's premise blamed on the run."""
        self.assertEqual(self.entries["LIN-10"]["originTicketId"], "LIN-4")
        self.assertIn("LIN-3", next(
            t for t in self.dossier["tickets"] if t["ticketId"] == "LIN-4")["blockedBy"])
        self.assertEqual(self.entries["LIN-10"]["tag"], "new")

    def test_legacy_fix_prefix_after_intake_still_counts(self):
        self.assertEqual(self.entries["LIN-21"]["kind"], "unknown")
        self.assertEqual(self.entries["LIN-21"]["tag"], "new")

    def test_kinds(self):
        self.assertEqual(
            {t: e["kind"] for t, e in self.entries.items()},
            {
                "LIN-10": "codex_fix", "LIN-11": "codex_fix", "LIN-12": "qa_fix",
                "LIN-13": "ci_fix", "LIN-14": "sync_fix", "LIN-15": "ship_fix",
                "LIN-16": "qa_fix", "LIN-17": "qa_fix", "LIN-18": "qa_fix",
                "LIN-19": "qa_fix", "LIN-21": "unknown",
            },
        )

    def test_origins_from_spawned_by_and_from_the_finder_agent(self):
        # LIN-10..LIN-16 carry spawnedBy: the origin is read off the contract's
        # own key (codexTicketId / qaTicketId / ciTicketId / shipTicketId).
        self.assertEqual(self.entries["LIN-12"]["originTicketId"], "LIN-5")
        self.assertEqual(self.entries["LIN-13"]["originTicketId"], "LIN-6")
        self.assertEqual(self.entries["LIN-14"]["originTicketId"], "LIN-6")
        self.assertEqual(self.entries["LIN-15"]["originTicketId"], "LIN-7")
        # LIN-17..LIN-19 are pre-contract, so the origin is the finder's ticket —
        # the QA verifier's last completion before the fix was filed. It agrees
        # with what spawnedBy says for the same run's later fixes.
        for tid in ("LIN-17", "LIN-18", "LIN-19"):
            self.assertEqual(self.entries[tid]["originTicketId"], "LIN-5", tid)
        # No kind → no finder → no origin invented.
        self.assertIsNone(self.entries["LIN-21"]["originTicketId"])

    def test_rounds_count_per_kind_and_origin(self):
        self.assertEqual([self.entries[t]["round"] for t in ("LIN-10", "LIN-11")], [1, 2])
        # (qa_fix, LIN-5) is the busy lineage: five fixes against one QA ticket.
        self.assertEqual(
            [self.entries[t]["round"] for t in ("LIN-12", "LIN-16", "LIN-17", "LIN-18", "LIN-19")],
            [1, 2, 3, 4, 5],
        )
        # sync_fix shares ciTicketId with ci_fix but is a different lineage, so
        # both are round 1 — a stale branch is not round two of a red build.
        self.assertEqual(self.entries["LIN-13"]["round"], 1)
        self.assertEqual(self.entries["LIN-14"]["round"], 1)

    def test_tags(self):
        self.assertEqual(
            {t: e["tag"] for t, e in self.entries.items()},
            {
                "LIN-10": "new",
                "LIN-11": "resurfacing",     # same cited PATH, different line
                "LIN-12": "resurfacing",     # same invariant, different file
                "LIN-13": "environmental",
                "LIN-14": "environmental",
                "LIN-15": "fix-induced",
                "LIN-16": "new",
                "LIN-17": "new",
                "LIN-18": "resurfacing",     # title-slot Jaccard 0.80
                "LIN-19": "new",
                "LIN-21": "new",
            },
        )
        self.assertEqual(self.fix["byTag"],
                         {"new": 5, "resurfacing": 3, "fix-induced": 1, "environmental": 2})

    def test_resurfacing_matches_on_path_not_on_line(self):
        """Line numbers move when the first fix lands, so the fingerprint is the
        path: intake.ts:120-140 and intake.ts:210 are the same place."""
        locs = {
            t: next(x for x in self.dossier["tickets"] if x["ticketId"] == t)["fixContract"]["citedLocation"]
            for t in ("LIN-10", "LIN-11")
        }
        self.assertEqual(locs["LIN-10"], ["src/lib/intake.ts:120-140"])
        self.assertEqual(locs["LIN-11"], ["src/lib/intake.ts:210"])
        self.assertEqual(self.entries["LIN-11"]["tag"], "resurfacing")

    def test_resurfacing_matches_a_reworded_invariant(self):
        """LIN-12 cites a different file than LIN-10 but claims the same
        invariant, spelled with different case and spacing. Normalizing catches
        it — the defect is the same, the location it surfaced at is not."""
        self.assertEqual(self.entries["LIN-12"]["tag"], "resurfacing")

    def test_environmental_wins_over_everything(self):
        """ci_fix/sync_fix are a red build and a drifted branch. Nobody disagreed
        with anybody, so they are never "resurfacing" however similar they look —
        same reasoning as REWORK_FIX_KINDS in fix-contract.mjs."""
        self.assertEqual(self.entries["LIN-13"]["tag"], "environmental")
        self.assertEqual(self.entries["LIN-14"]["tag"], "environmental")

    def test_fix_induced_wins_over_resurfacing(self):
        """LIN-15 is BOTH: its cited path repeats LIN-10's, and its origin LIN-7
        is blockedBy the earlier fix LIN-11. "A fix broke this" is the more
        actionable of the two statements, so it wins."""
        ship = next(t for t in self.dossier["tickets"] if t["ticketId"] == "LIN-7")
        self.assertIn("LIN-11", ship["blockedBy"])
        self.assertEqual(self.entries["LIN-15"]["tag"], "fix-induced")

    def test_reverify_is_flagged_and_is_not_a_rework_round_by_itself(self):
        entry = self.entries["LIN-16"]
        self.assertEqual(entry["kind"], "qa_fix")
        self.assertTrue(entry["reverify"])
        # Every other entry omits the key entirely.
        self.assertEqual([t for t, e in self.entries.items() if e.get("reverify")], ["LIN-16"])

    def test_title_kind_map(self):
        self.assertEqual(title_fix_kind("Fix (review): x"), ("codex_fix", False))
        self.assertEqual(title_fix_kind("Fix (QA): x"), ("qa_fix", False))
        self.assertEqual(title_fix_kind("Fix (ship-review r2): x"), ("ship_fix", False))
        self.assertEqual(title_fix_kind("Fix (CI): x"), ("ci_fix", False))
        self.assertEqual(title_fix_kind("Fix (sync-main): x"), ("sync_fix", False))
        self.assertEqual(title_fix_kind("Re-verify (QA): x @ abc1234"), ("qa_fix", True))
        # The real yteqfl run also used this one, and it is a QA re-verification.
        self.assertEqual(title_fix_kind("Fix (QA re-verify): x"), ("qa_fix", True))
        self.assertEqual(title_fix_kind("Fix: x"), ("unknown", False))

    def test_title_similarity_is_a_pre_contract_fallback_with_a_high_floor(self):
        near = title_slot_tokens(
            "Fix (QA): WorkflowBoard sources list renders undefined when input.sources is absent")
        rewrite = title_slot_tokens(
            "Fix (QA): WorkflowBoard sources list still renders undefined when input.sources absent")
        other = title_slot_tokens(
            "Fix (QA): telemetry dashboard token chart mislabels the cache column")
        self.assertAlmostEqual(jaccard(near, rewrite), 0.8, places=2)
        self.assertEqual(jaccard(near, other), 0.0)

    # ── The real run (yteqfl loop-2), TEAM-4121's motivating example ─────────
    #
    # ticketId   kind        origin     round  tag            title
    # TEAM-4078  codex_fix   None       1      new            Fix (review): WorkflowBoard sources list + start-route input shape — 2 findings
    # TEAM-4079  codex_fix   None       2      new            Fix (review): intake.ts source validator — 2 findings (unbounded STS probe, …)
    # TEAM-4089  qa_fix      None       1      new            Fix (QA): intake.ts — real SDK bodiless-403 message "Unknown" leaks into S3 …
    # TEAM-4090  ship_fix    None       1      new            Fix (ship-review r1): WorkflowBoard — Array.isArray guard on input.sources …
    # TEAM-4091  ship_fix    None       2      new            Fix (ship-review r1): intake.ts URL check SSRF hardening (redirect:manual …)
    # TEAM-4101  ship_fix    None       3      new            Fix (ship-review r2): intake.ts urlGate — trailing-dot host canonicalization …
    # TEAM-4102  ship_fix    None       4      new            Fix (ship-review r2): MCP tool JSON schemas — expose the 32-source cap …
    # TEAM-4105  qa_fix      TEAM-4064  1      new (reverify) Fix (QA re-verify): intake.ts checkS3Source — SDK placeholder name …
    # TEAM-4106  ci_fix      TEAM-4065  1      environmental  Fix (CI): merge origin/main (≥ 10955cd0) into feature/TEAM-4054-… — PR #371 …
    #
    # count 9 (PRD: 9 ✓). byTag {new: 8, resurfacing: 0, fix-induced: 0,
    # environmental: 1} — the PRD expected resurfacing 3, and it does NOT come
    # out. The three pairs the PRD was counting are visible in the table
    # (4089→4105 the same "Unknown" leak, 4091→4101 the same urlGate hardening,
    # 4078→4090 the same WorkflowBoard sources list), but this run predates the
    # fix contract, so the only fingerprint available is the TITLE — and their
    # title-slot Jaccard scores are 0.375 / 0.333 / 0.231, all far below the 0.60
    # floor. Those three scores are asserted below so the reason is checked, not
    # remembered: a resurfacing fix describes the SAME defect in NEW words
    # ("bodiless-403 message" → "placeholder name … via the rawName path"), which
    # is exactly what prose similarity cannot see. The floor is NOT lowered to
    # manufacture the 3: reaching them needs ≤0.23, which would tag almost any
    # two fixes in one file as the same defect, and a false "resurfacing" accuses
    # an agent of not fixing what it said it fixed. What WOULD catch all three is
    # the contract (every pair shares one file), which is why FR-8 exists — and
    # the follow-up worth filing is a path-shaped fallback for pre-contract runs
    # (pull "intake.ts"/"WorkflowBoard" out of the title), not a lower threshold.

    def test_yteqfl_count_and_kinds(self):
        with open(FIXTURES / "yteqfl-dossier.json") as f:
            fix = compute_metrics(json.load(f))["fixTickets"]
        self.assertEqual(fix["count"], 9)
        self.assertEqual(fix["ticketIds"], [
            "TEAM-4078", "TEAM-4079", "TEAM-4089", "TEAM-4090", "TEAM-4091",
            "TEAM-4101", "TEAM-4102", "TEAM-4105", "TEAM-4106",
        ])
        self.assertEqual(fix["byKind"],
                         {"codex_fix": 2, "qa_fix": 2, "ship_fix": 4, "ci_fix": 1})
        # TEAM-4061 "Fix: submit_workflow source validation (…)" is the run's own
        # intake-planned work — the whole reason the run exists — and is excluded.
        self.assertNotIn("TEAM-4061", fix["ticketIds"])

    def test_yteqfl_tags_are_the_computed_values_not_the_prd_guess(self):
        with open(FIXTURES / "yteqfl-dossier.json") as f:
            fix = compute_metrics(json.load(f))["fixTickets"]
        self.assertEqual(fix["byTag"],
                         {"new": 8, "resurfacing": 0, "fix-induced": 0, "environmental": 1})
        self.assertEqual([e["ticketId"] for e in fix["entries"]
                          if e["tag"] == "environmental"], ["TEAM-4106"])
        self.assertEqual([e["ticketId"] for e in fix["entries"]
                          if e.get("reverify")], ["TEAM-4105"])

    def test_yteqfl_the_three_prd_pairs_score_below_the_floor(self):
        with open(FIXTURES / "yteqfl-dossier.json") as f:
            titles = {t["ticketId"]: t["title"] for t in json.load(f)["tickets"]}
        slot = {t: title_slot_tokens(x) for t, x in titles.items()}
        pairs = {
            ("TEAM-4089", "TEAM-4105"): 0.375,  # the same "Unknown" leak
            ("TEAM-4091", "TEAM-4101"): 0.333,  # the same urlGate hardening
            ("TEAM-4078", "TEAM-4090"): 0.231,  # the same WorkflowBoard sources list
        }
        for (a, b), expected in pairs.items():
            with self.subTest(pair=f"{a}/{b}"):
                self.assertEqual(round(jaccard(slot[a], slot[b]), 3), expected)
                self.assertLess(jaccard(slot[a], slot[b]), 0.6)


def gate_dossier(requested_at, gate_ticket_updated=None):
    """One human gate, asked at `requested_at`. The only thing OutsideHours
    cares about is when the human was ASKED."""
    return dossier(
        workflow={"startedAt": requested_at, "completedAt": gate_ticket_updated or requested_at,
                  "humanNotifications": []},
        tickets=[ticket("TEAM-9", "human:alice@example.com", "done", title="Merge Approval",
                        createdAt=requested_at, updatedAt=gate_ticket_updated or requested_at)],
        events=[{"workflowId": "wf-1", "eventId": "e1", "type": "review.needed",
                 "timestamp": requested_at,
                 "detail": {"ticketId": "TEAM-9", "reviewer": "human:alice@example.com",
                            "workflowId": "wf-1"}}],
    )


def iso_of(value):
    """Normalize a fixture/computed timestamp to the compare-friendly Z form."""
    from compute_metrics import iso, parse_ts
    return iso(parse_ts(value)) if isinstance(value, str) else iso(value)


class OutsideHours(unittest.TestCase):
    """TEAM-4121 FR-10 — a 7-hour human wait is not one finding.

    The yteqfl run's merge approval was requested at 11:20 UTC on SATURDAY
    2026-09-05 (04:20 local for a US-Pacific reviewer) and waited 7 hours. The WM
    was reporting that as process latency, indistinguishable from a request that
    sat untouched through a Tuesday afternoon — and "the humans are slow" is the
    wrong finding when the truth is "we asked them at 4am on a weekend".

    Half-open [start, end) LOCAL hours, weekend always outside. WM_BUSINESS_TZ /
    WM_BUSINESS_HOURS carry the window; both are read in exactly one place
    (business_window) and both arrive as arguments, so these tests can pin a
    window without touching the process environment — except where the point IS
    the environment, which uses patch.dict."""

    WEEKDAY = "2026-07-01"          # a Wednesday
    SATURDAY = "2026-07-04"

    def test_the_fixture_dates_are_what_this_class_claims(self):
        from compute_metrics import parse_ts
        self.assertEqual(parse_ts(f"{self.WEEKDAY}T09:00:00Z").weekday(), 2)
        self.assertEqual(parse_ts(f"{self.SATURDAY}T09:00:00Z").weekday(), 5)

    def review(self, requested_at, **env):
        with mock.patch.dict(os.environ, env, clear=False):
            for key in ("WM_BUSINESS_TZ", "WM_BUSINESS_HOURS"):
                if key not in env:
                    os.environ.pop(key, None)
            return compute_metrics(gate_dossier(requested_at))

    def test_weekday_inside_business_hours(self):
        m = self.review(f"{self.WEEKDAY}T09:00:00Z")
        self.assertFalse(m["humanReviews"][0]["outsideHours"])
        self.assertEqual(m["humanReviewsOutsideHours"], 0)

    def test_saturday_inside_business_hours_is_still_outside(self):
        m = self.review(f"{self.SATURDAY}T09:00:00Z")
        self.assertTrue(m["humanReviews"][0]["outsideHours"])
        self.assertEqual(m["humanReviewsOutsideHours"], 1)

    def test_weekday_after_the_window_closes(self):
        # 18-19 is outside: the window is half-open, so 18:00 is already out.
        self.assertTrue(self.review(f"{self.WEEKDAY}T19:00:00Z")["humanReviews"][0]["outsideHours"])
        self.assertTrue(self.review(f"{self.WEEKDAY}T18:00:00Z")["humanReviews"][0]["outsideHours"])
        self.assertFalse(self.review(f"{self.WEEKDAY}T17:59:00Z")["humanReviews"][0]["outsideHours"])
        # …and 08:00 is already in.
        self.assertFalse(self.review(f"{self.WEEKDAY}T08:00:00Z")["humanReviews"][0]["outsideHours"])
        self.assertTrue(self.review(f"{self.WEEKDAY}T07:59:00Z")["humanReviews"][0]["outsideHours"])

    def test_the_window_is_local_to_wm_business_tz(self):
        """23:00 UTC is 08:00 the next morning in Tokyo — inside. The same
        instant is outside for a UTC team, which is the whole point of the var."""
        late_utc = f"{self.WEEKDAY}T23:00:00Z"
        self.assertTrue(self.review(late_utc)["humanReviews"][0]["outsideHours"])
        m = self.review(late_utc, WM_BUSINESS_TZ="Asia/Tokyo")
        self.assertFalse(m["humanReviews"][0]["outsideHours"])
        self.assertEqual(m["humanReviewsOutsideHours"], 0)

    def test_a_custom_window(self):
        m = self.review(f"{self.WEEKDAY}T07:30:00Z", WM_BUSINESS_HOURS="06-14")
        self.assertFalse(m["humanReviews"][0]["outsideHours"])
        m = self.review(f"{self.WEEKDAY}T15:00:00Z", WM_BUSINESS_HOURS="06-14")
        self.assertTrue(m["humanReviews"][0]["outsideHours"])

    def test_an_unknown_timezone_falls_back_to_utc_and_says_so(self):
        m = self.review(f"{self.WEEKDAY}T09:00:00Z", WM_BUSINESS_TZ="Mars/Olympus_Mons")
        self.assertFalse(m["humanReviews"][0]["outsideHours"])  # UTC default applied
        self.assertTrue(any("WM_BUSINESS_TZ" in s
                            for s in m["dataQuality"]["missingSignals"]))

    def test_a_malformed_window_falls_back_to_08_18_and_says_so(self):
        for bad in ("9am-5pm", "08:00-18:00", "18-08", "", "24-25"):
            with self.subTest(bad=bad):
                m = self.review(f"{self.WEEKDAY}T09:00:00Z", WM_BUSINESS_HOURS=bad)
                self.assertFalse(m["humanReviews"][0]["outsideHours"])
                self.assertTrue(any("WM_BUSINESS_HOURS" in s
                                    for s in m["dataQuality"]["missingSignals"]))

    def test_a_clean_env_leaves_no_note(self):
        m = self.review(f"{self.WEEKDAY}T09:00:00Z")
        self.assertEqual([s for s in m["dataQuality"]["missingSignals"]
                          if "WM_BUSINESS" in s], [])

    def test_window_and_predicate_are_callable_without_the_environment(self):
        window = business_window(tz_name="America/Los_Angeles", hours_spec="08-18")
        from compute_metrics import parse_ts
        # 2026-09-05T11:20Z — the real yteqfl merge-approval request: Saturday
        # 04:20 in Los Angeles, outside on both counts.
        self.assertTrue(is_outside_hours(parse_ts("2026-09-05T11:20:07.009Z"), window))
        self.assertIsNone(is_outside_hours(None, window))

    def test_the_real_yteqfl_gate_was_asked_on_a_saturday(self):
        with open(FIXTURES / "yteqfl-dossier.json") as f:
            m = compute_metrics(json.load(f))
        review = m["humanReviews"][0]
        self.assertEqual(review["gateTicketId"], "TEAM-4067")
        self.assertEqual(review["requestedAt"], "2026-09-05T11:20:07.009000Z")
        self.assertTrue(review["outsideHours"])
        self.assertEqual(m["humanReviewsOutsideHours"], 1)
        # The 7-hour wait RealDossierFixtures pins is unchanged — this only
        # explains it, it does not restate it.
        self.assertEqual(review["waitMs"], 25255120)


if __name__ == "__main__":
    unittest.main()
