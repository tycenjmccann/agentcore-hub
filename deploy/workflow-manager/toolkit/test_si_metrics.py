#!/usr/bin/env python3
"""Unit tests for si_metrics — pure fixtures, no AWS.

Run: python3 -m pytest deploy/workflow-manager/toolkit/test_si_metrics.py -q
 or: python3 -m unittest deploy/workflow-manager/toolkit/test_si_metrics.py

Every test goes through FakeSource, which implements the DataSource method
surface out of fixtures/si-metrics-cards.json (hand-built: cards, cd-ledgers,
analyses, workflows, si-ledger rows, one synthetic gap run) plus the two REAL
reduced dossiers (sffzti / yteqfl) for the events-based metric. Nothing here
imports boto3.
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from si_metrics import (  # noqa: E402
    CARD_V5,
    CARD_V6,
    METRIC_FUNCS,
    METRIC_NAMES,
    REWAKE_GAP_MS,
    compute,
    compute_all,
    count_duplicate_executions,
    count_rewake_gaps,
)
from events import dedupe_events  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"

# The four windows the fixture is built around (fixture `_fixture.windows`).
W_ALL = {"defIds": ["software-delivery"], "since": "2026-09-01T00:00:00Z", "until": "2026-09-14T00:00:00Z"}
W_V6 = {"defIds": ["software-delivery"], "since": "2026-09-09T00:00:00Z"}
W_V5 = {"defIds": ["software-delivery"], "since": "2026-09-07T00:00:00Z", "until": "2026-09-09T00:00:00Z"}
W_BUGFIX = {"defIds": ["bug-fix"], "since": "2026-09-01T00:00:00Z"}

TERMINAL_PHASES = {"complete", "cancelled", "error", "deploy-blocked", "static-ci-only"}


def load_fixture():
    with open(FIXTURES / "si-metrics-cards.json") as f:
        return json.load(f)


def load_dossier(name):
    with open(FIXTURES / f"{name}-dossier.json") as f:
        return json.load(f)


class FakeSource:
    """The DataSource seam, served from fixtures.

    It mirrors the real source's *filtering* (def id, ISO window, run cap,
    terminal-phase + deleted exclusion, definite-404 → None) because that
    filtering is part of the contract each metric is written against; what it does
    not mirror is the two-hop S3 read — cards_for_def hands back whole cards in
    one step, since the index is only ever a run enumerator.
    """

    def __init__(self, fixture=None, dossiers=("sffzti", "yteqfl")):
        fixture = load_fixture() if fixture is None else fixture
        self.cards = list((fixture.get("cards") or {}).values())
        self.events = dict(fixture.get("events") or {})
        self.ledgers = dict(fixture.get("cdLedgers") or {})
        self.analyses = list(fixture.get("analyses") or [])
        self.workflows = list(fixture.get("workflows") or [])
        self.ledger_rows = dict(fixture.get("ledgerRows") or {})
        for name in dossiers:
            dossier = load_dossier(name)
            self.events[dossier["workflow"]["workflowId"]] = dossier["events"]

    @staticmethod
    def _within(value, since, until):
        return bool(value) and not (since and value < since) and not (until and value > until)

    def cards_for_def(self, def_id, *, since=None, until=None, limit=None):
        out = [
            c for c in self.cards
            if c.get("workflowDefId") == def_id
            and self._within((c.get("run") or {}).get("completedAt"), since, until)
        ]
        out.sort(key=lambda c: (c.get("run") or {}).get("completedAt") or "")
        return out[-int(limit):] if limit else out

    def events_for_workflow(self, workflow_id):
        return list(self.events.get(workflow_id) or [])

    def cd_ledger(self, workflow_id):
        return self.ledgers.get(workflow_id)  # missing == definite 404 == None

    def analyses_since(self, since_iso, *, def_ids=None, until=None):
        return [
            a for a in self.analyses
            if self._within(a.get("analyzedAt"), since_iso, until)
            and (not def_ids or a.get("workflowDefId") in def_ids)
        ]

    def completed_runs_since(self, since_iso, *, def_ids=None, until=None):
        return [
            w for w in self.workflows
            if self._within(w.get("completedAt"), since_iso, until)
            and (not def_ids or w.get("workflowDefId") in def_ids)
            and w.get("deleted") is not True
            and w.get("phase") in TERMINAL_PHASES
        ]

    def ledger_row(self, pattern_key):
        return self.ledger_rows.get(pattern_key)


class EmptySource(FakeSource):
    """Every read comes back empty — an account with no cards, no events, no
    ledgers, no analyses. The window is fine; the DATA is missing."""

    def __init__(self):
        super().__init__(fixture={}, dossiers=())


class Registry(unittest.TestCase):
    def test_metric_names_and_funcs_agree(self):
        """Keys of METRIC_FUNCS == METRIC_NAMES, same order. Another SI unit pins
        this same list in a shared fixture, so a rename here is a cross-unit
        break, not a refactor."""
        self.assertEqual(list(METRIC_FUNCS), METRIC_NAMES)
        self.assertEqual(len(METRIC_NAMES), 10)
        self.assertEqual(len(set(METRIC_NAMES)), 10)

    def test_unknown_metric_raises(self):
        """A typo'd metric name is a caller bug. It must not come back as a
        polite `unavailable` that a verdict could then ignore."""
        with self.assertRaises(ValueError):
            compute("rewakes_per_run_v2", EmptySource(), W_ALL)

    def test_result_shape(self):
        for result in compute_all(FakeSource(), {**W_ALL, "patternKey": "rewake-gap-after-unblock"}):
            with self.subTest(result["metric"]):
                self.assertEqual(set(result), {"metric", "value", "runs", "window", "reason"})
                # The invariant: value is None if and only if reason is set.
                self.assertEqual(result["value"] is None, result["reason"] is not None)


class HappyPath(unittest.TestCase):
    """One test per metric, on the window the fixture was built for."""

    def setUp(self):
        self.source = FakeSource()

    def test_dead_sessions_per_run(self):
        # v6 cards only: (agent.retry 2 + agent.died 1) and (1 + 0) → 2.0
        got = compute("dead_sessions_per_run", self.source, W_V6)
        self.assertEqual((got["value"], got["runs"], got["reason"]), (2.0, 2, None))

    def test_missed_rewake_gaps(self):
        # The synthetic run: 360 s + 90 s + 120 s over the 60 s threshold; the
        # 10 s gap, the 5 s gap, the same-dispatch skew pair and the human gate
        # are all correctly not gaps. Only 1 of the window's 4 runs has unblocks.
        got = compute("missed_rewake_gaps", self.source, W_ALL)
        self.assertEqual((got["value"], got["runs"], got["reason"]), (3.0, 1, None))

    def test_missed_rewake_gaps_on_the_real_runs(self):
        """Both REAL runs score zero — a provable zero, not a missing one. Every
        one of their unblocks was paired with a dispatch inside the skew window
        (or is the human merge-approval gate, which is deliberately not a gap)."""
        got = compute("missed_rewake_gaps", self.source, W_BUGFIX)
        self.assertEqual((got["value"], got["runs"], got["reason"]), (0.0, 2, None))

    def test_rework_rounds_v2(self):
        # v5 field: all three cards contribute (4 + 2 + 6) / 3 = 4.0 — readable
        # today, which is the point of including the v5 card in this window.
        got = compute("rework_rounds_v2", self.source, W_ALL)
        self.assertEqual((got["value"], got["runs"], got["reason"]), (4.0, 3, None))

    def test_rewakes_per_run(self):
        got = compute("rewakes_per_run", self.source, W_V6)
        self.assertEqual((got["value"], got["runs"], got["reason"]), (4.0, 2, None))

    def test_ci_recerts_per_run(self):
        got = compute("ci_recerts_per_run", self.source, W_V6)
        self.assertEqual((got["value"], got["runs"], got["reason"]), (3.0, 2, None))

    def test_human_wait_out_of_hours_ms(self):
        # wf_si_a's LATEST analysis (5400000, not the superseded 7200000) and
        # wf_si_b's 3600000; wf_si_v5's pre-TEAM-4453 row has no such key.
        got = compute("human_wait_out_of_hours_ms", self.source, W_ALL)
        self.assertEqual((got["value"], got["runs"], got["reason"]), (4500000, 2, None))

    def test_wm_interventions_per_run(self):
        got = compute("wm_interventions_per_run", self.source, W_ALL)
        self.assertEqual((got["value"], got["runs"], got["reason"]), (2.6667, 3, None))

    def test_cd_duplicate_executions(self):
        # wf_si_a: one merge commit with two executions → 1 extra. wf_si_b: one
        # execution → 0. The other two runs never deployed and contribute nothing.
        got = compute("cd_duplicate_executions", self.source, W_ALL)
        self.assertEqual((got["value"], got["runs"], got["reason"]), (0.5, 2, None))

    def test_analysis_coverage(self):
        # 4 terminal runs (wf_si_running and wf_si_deleted excluded by the
        # source), 3 of them analysed → 0.75. wf_si_a's two analyses count once.
        got = compute("analysis_coverage", self.source, W_ALL)
        self.assertEqual((got["value"], got["runs"], got["reason"]), (0.75, 4, None))

    def test_recommendation_recurrence(self):
        # 3 dated occurrences over 4 analyses in the window → 7.5 per 10.
        got = compute("recommendation_recurrence", self.source,
                      {**W_ALL, "patternKey": "rewake-gap-after-unblock"})
        self.assertEqual((got["value"], got["runs"], got["reason"]), (7.5, 4, None))


class MixedWindow(unittest.TestCase):
    """A window straddling #635. The v6-only metrics average only the runs that
    carry the field and say so in `runs`; they do not quietly count the v5 run as
    a zero, and they do not refuse just because one card is old."""

    def test_v6_metric_reports_the_contributing_runs_only(self):
        source = FakeSource()
        rewakes = compute("rewakes_per_run", source, W_ALL)
        rework = compute("rework_rounds_v2", source, W_ALL)
        self.assertEqual((rewakes["value"], rewakes["runs"]), (4.0, 2))
        self.assertEqual(rework["runs"], 3)


class V6OnlyUnavailable(unittest.TestCase):
    """The v5-card window: the three #635 metrics must return (None, reason), and
    the reason has to name the field, the version seen and the version needed —
    that string is what a downstream `insufficient` verdict cites."""

    def setUp(self):
        self.source = FakeSource()

    def assert_needs_635(self, metric, field):
        got = compute(metric, self.source, W_V5)
        self.assertIsNone(got["value"])
        self.assertEqual(got["runs"], 0)
        self.assertIn(field, got["reason"])
        self.assertIn(f"reportVersion {CARD_V5}", got["reason"])
        self.assertIn(f"needs {CARD_V6}", got["reason"])
        self.assertIn("#635", got["reason"])

    def test_dead_sessions_needs_635(self):
        self.assert_needs_635("dead_sessions_per_run", "quality.errors")

    def test_rewakes_needs_635(self):
        self.assert_needs_635("rewakes_per_run", "quality.rewakes")

    def test_ci_recerts_needs_635(self):
        self.assert_needs_635("ci_recerts_per_run", "quality.reinvocations.byKind.ci_recert")

    def test_v5_fields_still_read_on_the_same_window(self):
        """The other two card metrics are readable TODAY — the pre-#635 split is
        3 blocked, not 5."""
        rework = compute("rework_rounds_v2", self.source, W_V5)
        interventions = compute("wm_interventions_per_run", self.source, W_V5)
        self.assertEqual((rework["value"], rework["runs"]), (6.0, 1))
        self.assertEqual((interventions["value"], interventions["runs"]), (4.0, 1))


class NeverZeroForUnknown(unittest.TestCase):
    """The rule the whole module exists for: unknown is None + a reason, never 0."""

    def test_empty_source_never_answers_zero(self):
        source = EmptySource()
        window = {**W_ALL, "patternKey": "rewake-gap-after-unblock"}
        for name in METRIC_NAMES:
            with self.subTest(name):
                got = compute(name, source, window)
                self.assertIsNone(got["value"], f"{name} invented a value from no data")
                self.assertTrue(got["reason"] and got["reason"].strip())
                self.assertEqual(got["runs"], 0)

    def test_missing_window_keys_name_the_key(self):
        source = FakeSource()
        for name, key in (
            ("dead_sessions_per_run", "defIds"),
            ("rework_rounds_v2", "defIds"),
            ("rewakes_per_run", "defIds"),
            ("ci_recerts_per_run", "defIds"),
            ("wm_interventions_per_run", "defIds"),
            ("missed_rewake_gaps", "since"),
            ("cd_duplicate_executions", "since"),
            ("human_wait_out_of_hours_ms", "since"),
            ("recommendation_recurrence", "patternKey"),
        ):
            with self.subTest(name):
                got = compute(name, source, {})
                self.assertIsNone(got["value"])
                self.assertIn(f"window.{key}", got["reason"])

    def test_analysis_coverage_defaults_to_a_rolling_14_days(self):
        """The one metric whose window is part of its definition. With no `since`
        it measures the 14 days before `until` and ECHOES the bounds it used, so
        the reader never has to guess which window produced the ratio."""
        got = compute("analysis_coverage", FakeSource(), {"defIds": ["software-delivery"],
                                                         "until": "2026-09-14T00:00:00Z"})
        self.assertEqual(got["window"]["since"], "2026-08-31T00:00:00Z")
        self.assertEqual((got["value"], got["runs"], got["reason"]), (0.75, 4, None))

    def test_scalar_ledger_occurrences_refuse_a_windowed_rate(self):
        got = compute("recommendation_recurrence", FakeSource(),
                      {**W_ALL, "patternKey": "ci-recert-storm"})
        self.assertIsNone(got["value"])
        self.assertIn("scalar occurrence count", got["reason"])

    def test_undated_ledger_occurrence_refuses_a_windowed_rate(self):
        got = compute("recommendation_recurrence", FakeSource(),
                      {**W_ALL, "patternKey": "undated-occurrence"})
        self.assertIsNone(got["value"])
        self.assertIn("no timestamp", got["reason"])

    def test_unknown_pattern_key_says_so(self):
        got = compute("recommendation_recurrence", FakeSource(),
                      {**W_ALL, "patternKey": "no-such-pattern"})
        self.assertIsNone(got["value"])
        self.assertIn("no si-ledger row", got["reason"])


class RewakeGapArithmetic(unittest.TestCase):
    """count_rewake_gaps in isolation — the pairing rules that decide what a
    "missed rewake" is."""

    def setUp(self):
        self.raw = load_fixture()["events"]["wf_si_gaps"]

    def test_dedupe_is_load_bearing(self):
        """The events table holds every orchestrator event twice. Counting the raw
        rows turns TEAM-9001's single 6-minute gap into two."""
        self.assertEqual(count_rewake_gaps(self.raw), 4)
        self.assertEqual(count_rewake_gaps(dedupe_events(self.raw)), 3)

    def test_same_dispatch_skew_is_not_a_gap(self):
        """The invoke is published BEFORE the unblock in one dispatch (observed
        lead: 2.8 s on the yteqfl fixture). TEAM-9004 is that pair alone."""
        events = [e for e in dedupe_events(self.raw) if (e.get("detail") or {}).get("ticketId") == "TEAM-9004"]
        self.assertEqual(len(events), 2)
        self.assertEqual(count_rewake_gaps(events), 0)

    def test_unblock_with_no_invocation_is_not_counted(self):
        """A human gate (TEAM-9005) is never invoked by an agent. Counting it
        would make every human-gated run look like a dropped rewake."""
        events = [e for e in dedupe_events(self.raw) if (e.get("detail") or {}).get("ticketId") == "TEAM-9005"]
        self.assertEqual(count_rewake_gaps(events), 0)

    def test_second_round_is_paired_with_its_own_invocation(self):
        """TEAM-9006 is unblocked twice: 5 s (fine) then 120 s (a gap). Greedy
        per-ticket pairing means the first dispatch cannot also settle the
        second unblock."""
        events = [e for e in dedupe_events(self.raw) if (e.get("detail") or {}).get("ticketId") == "TEAM-9006"]
        self.assertEqual(count_rewake_gaps(events), 1)

    def test_no_unblocks_is_none_not_zero(self):
        """A run that cascaded nothing has no denominator, so it contributes
        nothing rather than a clean zero (which is how a run whose events expired
        would otherwise flatter the window)."""
        self.assertIsNone(count_rewake_gaps([]))
        invokes = [e for e in self.raw if e["type"] == "orchestrator.agent_invoked"]
        self.assertIsNone(count_rewake_gaps(invokes))

    def test_threshold_is_sixty_seconds(self):
        self.assertEqual(REWAKE_GAP_MS, 60_000)

    def test_real_dossiers_have_no_missed_rewakes(self):
        for name in ("sffzti", "yteqfl"):
            with self.subTest(name):
                self.assertEqual(count_rewake_gaps(dedupe_events(load_dossier(name)["events"])), 0)


class CdLedgerArithmetic(unittest.TestCase):
    """count_duplicate_executions in isolation — both ledger shapes."""

    def setUp(self):
        self.ledgers = load_fixture()["cdLedgers"]

    def test_executions_list_counts_extras_per_merge_commit(self):
        self.assertEqual(count_duplicate_executions(self.ledgers["wf_si_a"]), 1)

    def test_single_object_ledger_is_a_provable_zero(self):
        self.assertEqual(count_duplicate_executions(self.ledgers["wf_si_b"]), 0)

    def test_superseded_predecessor_counts(self):
        self.assertEqual(count_duplicate_executions(self.ledgers["wf_si_superseded"]), 1)

    def test_ledger_with_no_execution_id_is_none(self):
        self.assertIsNone(count_duplicate_executions(self.ledgers["wf_si_noexec"]))

    def test_repeated_id_is_not_a_duplicate_deploy(self):
        """One execution recorded twice is a sloppy ledger, not a double deploy."""
        ledger = {"mergeCommit": "aaa", "executions": [
            {"executionId": "exec-1", "mergeCommit": "aaa"},
            {"executionId": "exec-1", "mergeCommit": "aaa"},
        ]}
        self.assertEqual(count_duplicate_executions(ledger), 0)


if __name__ == "__main__":
    unittest.main()
