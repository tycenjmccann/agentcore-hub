#!/usr/bin/env python3
"""Unit tests for si_verify — hermetic, no AWS, no model.

TEAM-4760. What these pin is the thing the whole feature rests on: that a verdict
is ARITHMETIC. So almost every case here drives `judge` (pure: an expectation, a
before and an after) or `verify_row` against a fake DataSource, and asserts the
verdict AND that both numbers travelled with it. A verdict without its numbers is
back to prose, which is what the loop already failed at.

The two cases the plan names by number:
  * test_dedupe_gate_excludes_in_run_key  — the synthesis gate (si_ledger.dedupe_blocked)
    refuses a key a run is already carrying, so the loop cannot re-file it.
  * OutOfHoursPaging (#551)               — a pinned before/after window rules
    no-effect or insufficient, never "verified", and reports both numbers.

Run: python3 -m pytest deploy/workflow-manager/toolkit/test_si_verify.py -q
"""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("ARTIFACT_BUCKET", "test-bucket")

import si_ledger  # noqa: E402
import si_metrics  # noqa: E402
import si_verify  # noqa: E402

SHIP = "2026-08-01T00:00:00Z"
NOW = "2026-09-18T00:00:00Z"


def expectation(metric="wm_interventions_per_run", target=1.0, baseline=None,
                observe_runs=5, prd_key="prd-1"):
    return {
        "metric": metric,
        "baseline": baseline,
        "target": target,
        "observeRuns": observe_runs,
        "setAt": "2026-07-20T00:00:00Z",
        "prdKey": prd_key,
    }


def value(metric, v, runs=5, reason=None):
    """A si_metrics MetricValue. Built through the real constructors so a change to
    that shape breaks here rather than silently diverging."""
    if v is None:
        return si_metrics.unavailable(metric, reason or "no data", {}, runs=runs)
    return si_metrics.ok(metric, v, runs, {})


def row(pattern_key="ops.paging.out-of-hours", status="deployed", expected=None,
        attempts=None, verdicts=None, occurrences=None):
    return {
        "patternKey": pattern_key,
        "title": "t",
        "status": status,
        "firstSeen": "2026-07-01T00:00:00Z",
        "lastSeen": NOW,
        "occurrences": occurrences if occurrences is not None else [
            {"workflowId": "wf_1", "analysisId": "a1", "workflowDefId": "software-delivery",
             "severity": "high", "at": "2026-07-02T00:00:00Z"},
        ],
        "attempts": attempts if attempts is not None else [
            {"prdKey": "prd-1", "workflowId": "wf_fix", "epicId": "TEAM-1", "prNumbers": [551],
             "mergedAt": SHIP, "deployedAt": SHIP, "outcome": "deployed", "note": ""},
        ],
        "expected": expected if expected is not None else [expectation()],
        "verdicts": verdicts or [],
    }


class FakeSource:
    """Returns a canned MetricValue per (metric, window-side). `side` is decided by
    whether the window has an `until` at the ship date (before) or a `since` at it
    (after) — exactly the split windows_for builds, so the test exercises the real
    window construction rather than asserting on it."""

    def __init__(self, before=None, after=None, coverage=None):
        self._before, self._after, self._coverage = before, after, coverage
        self.calls = []

    def _for(self, metric, window):
        if metric == "analysis_coverage" and self._coverage is not None and not window.get("since"):
            return self._coverage
        side = "after" if window.get("since") == SHIP else "before"
        self.calls.append((metric, side, window))
        canned = self._after if side == "after" else self._before
        if callable(canned):
            return canned(metric, window)
        return canned if canned is not None else value(metric, None, runs=0, reason="fake: nothing canned")


def patched(source):
    """si_metrics.compute, rerouted to the fake. Patching `compute` (not the ten
    metric functions) keeps the fake to one method and still exercises si_verify's
    real window construction, judging and rendering."""
    return mock.patch.object(si_metrics, "compute", side_effect=lambda name, src, window: source._for(name, window))


class Judge(unittest.TestCase):
    """The ruling itself — pure, no source, no table."""

    M = "wm_interventions_per_run"

    def test_target_met_is_verified(self):
        got, note = si_verify.judge(expectation(target=1.0), value(self.M, 3.0), value(self.M, 0.8))
        self.assertEqual(got, "verified")
        # Both numbers must be in the note: a verdict that says only "verified" is
        # the unfalsifiable prose this feature replaced.
        self.assertIn("3", note)
        self.assertIn("0.8", note)
        self.assertIn("target", note)

    def test_moving_away_is_regressed(self):
        got, note = si_verify.judge(expectation(target=1.0), value(self.M, 2.0), value(self.M, 3.0))
        self.assertEqual(got, "regressed")
        self.assertIn("moved away", note)

    def test_small_move_is_no_effect(self):
        # 2.0 → 1.8 is a 10% move: inside the noise band of a 5-run window.
        got, note = si_verify.judge(expectation(target=1.0), value(self.M, 2.0), value(self.M, 1.8))
        self.assertEqual(got, "no-effect")
        self.assertIn("noise band", note)

    def test_real_improvement_short_of_target_is_still_owed(self):
        # 4.0 → 2.0 halves it, but the PRD promised <= 1.0. The ask stands, and the
        # note has to say it got halfway — otherwise the next synthesis cannot tell
        # this apart from a fix that did nothing.
        got, note = si_verify.judge(expectation(target=1.0), value(self.M, 4.0), value(self.M, 2.0))
        self.assertEqual(got, "no-effect")
        self.assertIn("short of target", note)
        self.assertIn("+50%", note)

    def test_no_numeric_target_verifies_on_a_material_move(self):
        got, _ = si_verify.judge(expectation(target=None), value(self.M, 4.0), value(self.M, 2.0))
        self.assertEqual(got, "verified")
        got, _ = si_verify.judge(expectation(target=None), value(self.M, 4.0), value(self.M, 3.6))
        self.assertEqual(got, "no-effect")

    def test_coverage_is_the_one_metric_where_up_is_better(self):
        # The direction table is the single place an inverted verdict could come
        # from, so it is pinned from both sides.
        cov = expectation(metric="analysis_coverage", target=0.9)
        got, _ = si_verify.judge(cov, value("analysis_coverage", 0.5), value("analysis_coverage", 0.95))
        self.assertEqual(got, "verified")
        got, _ = si_verify.judge(cov, value("analysis_coverage", 0.8), value("analysis_coverage", 0.5))
        self.assertEqual(got, "regressed")

    def test_unreadable_after_is_insufficient_with_the_metrics_own_reason(self):
        got, note = si_verify.judge(
            expectation(metric="rewakes_per_run"),
            value("rewakes_per_run", 2.0),
            value("rewakes_per_run", None, runs=0, reason="quality.rewakes absent: card is reportVersion 5, needs 6 (PR #635)"),
        )
        self.assertEqual(got, "insufficient")
        # The reason is passed through verbatim — it names the field and the PR, and
        # that is what makes the gap actionable rather than "no data".
        self.assertIn("needs 6 (PR #635)", note)

    def test_too_few_runs_since_the_ship_is_insufficient_not_a_verdict(self):
        got, note = si_verify.judge(
            expectation(target=1.0, observe_runs=5),
            value(self.M, 3.0), value(self.M, 0.5, runs=2),
        )
        self.assertEqual(got, "insufficient")
        self.assertIn("2 of 5", note)

    def test_missing_before_is_insufficient_never_zero(self):
        got, note = si_verify.judge(
            expectation(target=1.0),
            value(self.M, None, runs=0, reason="no performance cards in window"),
            value(self.M, 0.5),
        )
        self.assertEqual(got, "insufficient")
        self.assertIn("no usable baseline", note)

    def test_a_zero_baseline_does_not_divide_by_zero(self):
        # 0 dead sessions → 3 is a regression, and reporting it as undefined would
        # hide exactly the fix that made things worse.
        got, _ = si_verify.judge(
            expectation(metric="dead_sessions_per_run", target=0),
            value("dead_sessions_per_run", 0.0), value("dead_sessions_per_run", 3.0),
        )
        self.assertEqual(got, "regressed")
        got, _ = si_verify.judge(
            expectation(metric="dead_sessions_per_run", target=0),
            value("dead_sessions_per_run", 0.0), value("dead_sessions_per_run", 0.0),
        )
        self.assertEqual(got, "verified")


class Windows(unittest.TestCase):
    def test_both_sides_are_capped_to_the_same_run_count(self):
        before, after = si_verify.windows_for(row(), expectation(observe_runs=7), row()["attempts"][0], now=NOW)
        self.assertEqual(before["runs"], 7)
        self.assertEqual(after["runs"], 7)

    def test_the_split_is_the_ship_date(self):
        before, after = si_verify.windows_for(row(), expectation(), row()["attempts"][0], now=NOW)
        self.assertEqual(before["until"], SHIP)
        self.assertEqual(after["since"], SHIP)
        self.assertEqual(after["until"], NOW)
        # The before side is bounded, not unbounded: a 2-year-old run is not
        # evidence about last month's system.
        self.assertLess(before["since"], SHIP)

    def test_deployed_wins_over_merged(self):
        attempt = {"prdKey": "prd-1", "mergedAt": "2026-08-01T00:00:00Z",
                   "deployedAt": "2026-08-05T00:00:00Z", "outcome": "deployed"}
        self.assertEqual(si_verify.shipped_at(attempt), "2026-08-05T00:00:00Z")

    def test_def_ids_come_from_the_occurrences(self):
        r = row(occurrences=[
            {"workflowId": "w1", "analysisId": "a", "workflowDefId": "software-delivery", "at": NOW},
            {"workflowId": "w2", "analysisId": "b", "workflowDefId": "docs-only", "at": NOW},
            {"workflowId": "w3", "analysisId": "c", "workflowDefId": "software-delivery", "at": NOW},
        ])
        self.assertEqual(si_verify.def_ids_for(r), ["docs-only", "software-delivery"])


class WhatIsJudgeable(unittest.TestCase):
    def test_an_unshipped_attempt_is_not_judged(self):
        # in-run: there is nothing to measure yet, and inventing an "after" window
        # from a run still in flight would rule on the fix before it exists.
        r = row(status="in-run", attempts=[
            {"prdKey": "prd-1", "workflowId": "wf_fix", "outcome": "in-run"},
        ])
        self.assertEqual(si_verify.pending(r), [])

    def test_wont_fix_is_left_alone(self):
        self.assertEqual(si_verify.pending(row(status="wont-fix")), [])

    def test_a_settled_verdict_is_not_relitigated(self):
        r = row(verdicts=[{
            "at": "2026-09-01T00:00:00Z", "prdKey": "prd-1", "verdict": "no-effect",
            "before": {"metric": "wm_interventions_per_run"}, "after": {}, "note": "",
        }])
        self.assertEqual(si_verify.pending(r), [])

    def test_an_insufficient_verdict_is_revisited_but_recorded_only_once(self):
        r = row(verdicts=[{
            "at": "2026-09-01T00:00:00Z", "prdKey": "prd-1", "verdict": "insufficient",
            "before": {"metric": "wm_interventions_per_run"}, "after": {}, "note": "",
        }])
        items = si_verify.pending(r)
        self.assertEqual(len(items), 1, "insufficient means 'ask again later', not 'settled'")
        self.assertFalse(items[0]["recordOnce"], "a second insufficient must not be appended")

    def test_a_verdict_from_before_the_ship_does_not_count_as_settled(self):
        # An earlier attempt's ruling says nothing about this one.
        r = row(verdicts=[{
            "at": "2026-07-05T00:00:00Z", "prdKey": "prd-1", "verdict": "no-effect",
            "before": {"metric": "wm_interventions_per_run"}, "after": {}, "note": "",
        }])
        self.assertEqual(len(si_verify.pending(r)), 1)


class BaselineFallback(unittest.TestCase):
    M = "wm_interventions_per_run"

    def test_a_short_before_window_falls_back_to_the_recorded_baseline(self):
        entry = expectation(baseline={"value": 3.0, "runs": 4, "window": {"defIds": ["software-delivery"]}})
        source = FakeSource(
            before=value(self.M, 2.9, runs=1),      # only 1 run: not an equal-sized window
            after=value(self.M, 0.5, runs=5),
        )
        with patched(source):
            before, after = si_verify.measure(entry, source, *si_verify.windows_for(row(), entry, row()["attempts"][0], now=NOW))
        self.assertEqual(before["value"], 3.0)
        self.assertEqual(before["source"], "recorded-baseline")
        # And the fallback is DISCLOSED in the verdict's note, never silent.
        got, note = si_verify.judge(entry, before, after)
        self.assertEqual(got, "verified")
        self.assertIn("baseline recorded at synthesis", note)

    def test_a_full_before_window_wins_over_the_baseline(self):
        entry = expectation(baseline={"value": 99.0, "runs": 5, "window": {}})
        source = FakeSource(before=value(self.M, 2.0, runs=5), after=value(self.M, 1.9, runs=5))
        with patched(source):
            before, _ = si_verify.measure(entry, source, *si_verify.windows_for(row(), entry, row()["attempts"][0], now=NOW))
        self.assertEqual(before["value"], 2.0, "a number recomputed today beats a stale promise")
        self.assertNotIn("source", before)

    def test_no_window_and_no_baseline_is_insufficient(self):
        entry = expectation(baseline=None)
        source = FakeSource(before=value(self.M, None, runs=0, reason="no cards"), after=value(self.M, 1.0))
        with patched(source):
            before, after = si_verify.measure(entry, source, *si_verify.windows_for(row(), entry, row()["attempts"][0], now=NOW))
        self.assertEqual(si_verify.judge(entry, before, after)[0], "insufficient")


class RowRollup(unittest.TestCase):
    M = "wm_interventions_per_run"

    def test_verify_row_reports_both_numbers_with_the_verdict(self):
        source = FakeSource(before=value(self.M, 4.0), after=value(self.M, 0.5))
        with patched(source):
            results = si_verify.verify_row(row(), source, now=NOW)
        self.assertEqual(len(results), 1)
        got = results[0]
        self.assertEqual(got["verdict"], "verified")
        self.assertEqual(got["before"]["value"], 4.0)
        self.assertEqual(got["after"]["value"], 0.5)
        self.assertEqual(got["patternKey"], "ops.paging.out-of-hours")
        self.assertEqual(got["shippedAt"], SHIP)

    def test_a_failure_wins_over_a_success_on_the_same_prd(self):
        # One PRD promising two metrics: one held, one did not. The row must end up
        # `open` (the ask is still owed), which is what the apply ORDER guarantees.
        expected = [
            expectation(metric="wm_interventions_per_run", target=1.0),
            expectation(metric="rework_rounds_v2", target=1.0),
        ]

        def canned(metric, window):
            good = metric == "wm_interventions_per_run"
            after = 0.5 if good else 3.0
            return value(metric, after if window.get("since") == SHIP else 3.0)

        source = FakeSource(before=lambda m, w: value(m, 3.0), after=canned)
        with patched(source):
            results = si_verify.verify_row(row(expected=expected), source, now=NOW)
        verdicts = {r["metric"]: r["verdict"] for r in results}
        self.assertEqual(verdicts, {"wm_interventions_per_run": "verified", "rework_rounds_v2": "no-effect"})
        ordered = [r["verdict"] for r in si_verify.writable(results)]
        self.assertEqual(ordered, ["verified", "no-effect"])
        # Drive the real reducer to prove the resulting status, not just the order.
        final = row(expected=expected)
        for result in si_verify.writable(results):
            final = si_ledger.apply_verdict(final, si_verify.to_verdict_record(result))
        self.assertEqual(final["status"], "open")
        self.assertEqual(len(final["verdicts"]), 2, "both rulings are kept — the history is the point")

    def test_an_insufficient_ruling_never_moves_the_status(self):
        source = FakeSource(before=value(self.M, 4.0), after=value(self.M, 0.5, runs=1))
        with patched(source):
            results = si_verify.verify_row(row(), source, now=NOW)
        self.assertEqual(results[0]["verdict"], "insufficient")
        after = si_ledger.apply_verdict(row(), si_verify.to_verdict_record(results[0]))
        self.assertEqual(after["status"], "deployed", "'we could not tell' is not 'we checked'")

    def test_the_verdict_record_matches_the_closed_schema(self):
        source = FakeSource(before=value(self.M, 4.0), after=value(self.M, 0.5))
        with patched(source):
            results = si_verify.verify_row(row(), source, now=NOW)
        record = si_verify.to_verdict_record(results[0])
        self.assertEqual(set(record), {"at", "prdKey", "verdict", "before", "after", "note"})
        # There is no `metric` field in the schema, so the metric identity has to
        # survive inside before/after or the row loses which promise was judged.
        self.assertEqual(record["before"]["metric"], self.M)
        si_ledger.apply_verdict(row(), record)  # must not raise


class OutOfHoursPaging(unittest.TestCase):
    """AC5, pinned: PR #551 was supposed to stop paging humans outside working
    hours. The window below is what the ledger holds for it. The verdict must be
    no-effect or insufficient — never verified — and both numbers must be on the
    record either way."""

    M = "human_wait_out_of_hours_ms"

    def _entry(self):
        return expectation(
            metric=self.M,
            target=0.0,
            baseline={"value": 11_675_000, "runs": 5, "window": {"defIds": ["software-delivery"]}},
            prd_key="prd-551",
        )

    def _row(self, expected=None, **kw):
        return row(
            pattern_key="ops.paging.out-of-hours",
            expected=expected or [self._entry()],
            attempts=[{"prdKey": "prd-551", "workflowId": "wf_551", "epicId": "TEAM-551",
                       "prNumbers": [551], "mergedAt": SHIP, "deployedAt": SHIP,
                       "outcome": "deployed", "note": ""}],
            **kw,
        )

    def test_the_number_did_not_move_so_the_ask_still_stands(self):
        source = FakeSource(
            before=value(self.M, 11_675_000, runs=5),
            after=value(self.M, 10_900_000, runs=5),   # a 6.6% move: noise
        )
        with patched(source):
            results = si_verify.verify_row(self._row(), source, now=NOW)
        got = results[0]
        self.assertIn(got["verdict"], {"no-effect", "insufficient"})
        self.assertEqual(got["verdict"], "no-effect")
        self.assertEqual(got["before"]["value"], 11_675_000)
        self.assertEqual(got["after"]["value"], 10_900_000)
        # Reported in hours, because milliseconds of human waiting is unreadable.
        self.assertIn("3.24h", got["note"])
        self.assertIn("3.03h", got["note"])

    def test_with_too_few_runs_it_is_insufficient_and_still_prints_both_numbers(self):
        source = FakeSource(
            before=value(self.M, 11_675_000, runs=5),
            after=value(self.M, 0, runs=2),
        )
        with patched(source):
            results = si_verify.verify_row(self._row(), source, now=NOW)
        self.assertEqual(results[0]["verdict"], "insufficient")
        self.assertEqual(results[0]["after"]["value"], 0)
        self.assertEqual(results[0]["before"]["value"], 11_675_000)
        rendered = si_verify.render([{**results[0], "entry": self._entry()}], [self._row()])
        # Both numbers are in the table even when the ruling is "cannot tell" — an
        # insufficient verdict with no numbers is indistinguishable from no check.
        self.assertIn("3.24h", rendered)
        self.assertIn("0.0m", rendered)
        self.assertIn("insufficient", rendered)

    def test_an_unreadable_before_window_is_never_verified_on_nothing(self):
        # The before side cannot be recomputed. With NO recorded baseline there is
        # no comparison to make, and "after = 0" must not be read as a win.
        entry = self._entry()
        entry["baseline"] = None
        source = FakeSource(
            before=value(self.M, None, runs=0, reason="humanWaitOutsideHoursMs absent on all 5 analyses"),
            after=value(self.M, 0, runs=5),
        )
        with patched(source):
            results = si_verify.verify_row(self._row(expected=[entry]), source, now=NOW)
        self.assertEqual(results[0]["verdict"], "insufficient")
        self.assertIn("humanWaitOutsideHoursMs absent", results[0]["note"])

    def test_with_a_baseline_it_may_verify_but_must_disclose_where_before_came_from(self):
        # Same unreadable window, but the PRD recorded its own starting number, so
        # a comparison IS possible. The verdict is then legitimate — provided the
        # table says the "before" was not recomputed today, because that is the
        # difference between measured evidence and a restated promise.
        source = FakeSource(
            before=value(self.M, None, runs=0, reason="humanWaitOutsideHoursMs absent on all 5 analyses"),
            after=value(self.M, 0, runs=5),
        )
        with patched(source):
            results = si_verify.verify_row(self._row(), source, now=NOW)
        self.assertEqual(results[0]["verdict"], "verified")
        self.assertEqual(results[0]["before"]["source"], "recorded-baseline")
        self.assertIn("baseline recorded at synthesis", results[0]["note"])


class DedupeGate(unittest.TestCase):
    """The other half of the loop: synthesis must not re-file an ask that is
    already in flight or shipped-but-unjudged. The rule lives in
    si_ledger.dedupe_blocked (one definition, both languages); these cases pin that
    si-synthesis's documented step 0 actually blocks."""

    def test_dedupe_gate_excludes_in_run_key(self):
        blocked = si_ledger.dedupe_blocked(row(status="in-run", attempts=[
            {"prdKey": "prd-9", "workflowId": "wf_live", "outcome": "in-run"},
        ]), now=NOW)
        self.assertTrue(blocked["blocked"])
        self.assertIn("already in flight", blocked["reason"])
        self.assertIn("wf_live", blocked["reason"])
        self.assertIn("prd-9", blocked["reason"])

    def test_a_fresh_deployed_key_is_blocked_until_si_verify_rules(self):
        blocked = si_ledger.dedupe_blocked(row(status="deployed"), now="2026-08-05T00:00:00Z")
        self.assertTrue(blocked["blocked"])
        self.assertIn("si_verify", blocked["reason"])

    def test_a_no_effect_verdict_unblocks_it_immediately(self):
        r = row(status="deployed", verdicts=[{
            "at": "2026-08-03T00:00:00Z", "prdKey": "prd-1", "verdict": "no-effect",
            "before": {}, "after": {}, "note": "",
        }])
        self.assertFalse(si_ledger.dedupe_blocked(r, now="2026-08-05T00:00:00Z")["blocked"])

    def test_an_open_key_is_always_filable(self):
        self.assertFalse(si_ledger.dedupe_blocked(row(status="open"), now=NOW)["blocked"])


class Coverage(unittest.TestCase):
    """The reserved `#metrics` row — the only non-pattern row in the table, and the
    source of the Evaluations panel's coverage tile."""

    def test_the_day_entry_matches_the_shape_the_panel_reads(self):
        entry = si_verify.coverage_day(si_metrics.ok("analysis_coverage", 0.75, 8, {}), "2026-09-18")
        self.assertEqual(entry, {"day": "2026-09-18", "completedRuns": 8, "ratio": 0.75, "analyses": 6})

    def test_an_unreadable_coverage_writes_a_gap_not_a_zero(self):
        result = si_metrics.unavailable("analysis_coverage", "no completed runs in window", {})
        entry = si_verify.coverage_day(result, "2026-09-18")
        self.assertIsNone(entry["ratio"])
        self.assertIn("no completed runs", entry["reason"])
        self.assertNotIn("analyses", entry)

    def test_rerunning_the_sweep_on_one_day_is_idempotent(self):
        base = {"patternKey": "#metrics", "coverage": [{"day": "2026-09-17", "ratio": 0.5}]}
        once = si_verify.apply_coverage_day(base, {"day": "2026-09-18", "ratio": 0.6})
        twice = si_verify.apply_coverage_day(once, {"day": "2026-09-18", "ratio": 0.7})
        self.assertEqual([d["day"] for d in twice["coverage"]], ["2026-09-17", "2026-09-18"])
        self.assertEqual(twice["coverage"][-1]["ratio"], 0.7)

    def test_the_series_is_capped_and_stays_sorted(self):
        row_in = {"patternKey": "#metrics", "coverage": [
            {"day": f"2026-01-{d:02d}", "ratio": 0.1} for d in range(1, 6)
        ]}
        out = si_verify.apply_coverage_day(row_in, {"day": "2026-02-01", "ratio": 0.9}, keep_days=3)
        self.assertEqual([d["day"] for d in out["coverage"]],
                         ["2026-01-04", "2026-01-05", "2026-02-01"])

    def test_the_reserved_key_cannot_be_a_pattern_key(self):
        # This is the whole reason the row is safe: the grammar cannot emit it, so
        # the two namespaces can never collide.
        self.assertFalse(si_ledger.is_valid_key(si_verify.SI_METRICS_KEY))
        self.assertEqual(si_verify.SI_METRICS_KEY, "#metrics")

    def test_it_is_found_in_a_scan_and_never_read_through_get(self):
        rows = [{"patternKey": "a.b", "coverage": []}, {"patternKey": "#metrics", "coverage": [{"day": "2026-09-18"}]}]
        self.assertEqual(si_verify.coverage_row(rows)["coverage"], [{"day": "2026-09-18"}])
        # Absent: an empty series, not a crash — the first sweep creates the row.
        self.assertEqual(si_verify.coverage_row([])["coverage"], [])


class Sweep(unittest.TestCase):
    M = "wm_interventions_per_run"

    class FakeLedger:
        def __init__(self, rows):
            self.rows = rows
            self.puts = []
            self.verdicts = []

        def list(self):
            return list(self.rows)

        def get(self, key):
            return next((r for r in self.rows if r.get("patternKey") == key), None)

        def put(self, r):
            self.puts.append(r)
            return r

        def record_verdict(self, key, verdict):
            self.verdicts.append((key, verdict))

    def test_the_reserved_row_is_never_judged_as_a_pattern(self):
        ledger = self.FakeLedger([row(), {"patternKey": "#metrics", "coverage": []}])
        source = FakeSource(before=value(self.M, 4.0), after=value(self.M, 0.5))
        with patched(source):
            results, rows = si_verify.sweep(ledger, source, now=NOW)
        self.assertEqual([r["patternKey"] for r in rows], ["ops.paging.out-of-hours"])
        self.assertEqual(len(results), 1)

    def test_an_unknown_key_fails_loudly(self):
        with self.assertRaises(SystemExit):
            si_verify.sweep(self.FakeLedger([]), FakeSource(), key="nope.nope")

    def test_the_entry_is_attached_so_the_table_can_print_the_target(self):
        ledger = self.FakeLedger([row()])
        source = FakeSource(before=value(self.M, 4.0), after=value(self.M, 0.5))
        with patched(source):
            results, rows = si_verify.sweep(ledger, source, now=NOW)
        rendered = si_verify.render(results, rows)
        self.assertIn("| 1 |", rendered)         # the target column
        self.assertIn("**verified**", rendered)


class Render(unittest.TestCase):
    def test_an_empty_sweep_says_so_instead_of_printing_an_empty_table(self):
        out = si_verify.render([], [row(status="in-run", attempts=[{"prdKey": "p", "outcome": "in-run"}])])
        self.assertIn("No expectation is ready to judge", out)
        self.assertIn("1 ledger rows", out)

    def test_a_dry_run_says_it_wrote_nothing(self):
        out = si_verify.render(
            [{"patternKey": "a.b", "metric": "rework_rounds_v2", "verdict": "no-effect",
              "before": {"value": 3}, "after": {"value": 3, "runs": 5}, "note": "n",
              "recordOnce": True, "entry": {}}],
            [], applied=False,
        )
        self.assertIn("--apply to write them", out)

    def test_never_renders_an_absent_number_as_zero(self):
        self.assertEqual(si_verify.fmt("rework_rounds_v2", None), "—")
        self.assertEqual(si_verify.fmt("analysis_coverage", None), "—")
        self.assertEqual(si_verify.fmt("analysis_coverage", 0.0), "0.0%")

    def test_ms_metrics_read_as_time(self):
        self.assertEqual(si_verify.fmt("human_wait_out_of_hours_ms", 11_675_000), "3.24h")
        self.assertEqual(si_verify.fmt("human_wait_out_of_hours_ms", 300_000), "5.0m")


class Contract(unittest.TestCase):
    def test_every_metric_has_a_direction(self):
        # A metric missing from the direction table would be judged as
        # lower-is-better by default, which silently inverts its verdict.
        self.assertTrue(si_verify.HIGHER_IS_BETTER.issubset(set(si_ledger.METRIC_NAMES)))
        self.assertEqual(set(si_ledger.METRIC_NAMES), set(si_metrics.METRIC_NAMES))

    def test_the_verdict_vocabulary_is_the_ledgers(self):
        self.assertEqual(set(si_verify.VERDICT_APPLY_ORDER), set(si_ledger.VERDICT_VALUES))

    def test_there_is_no_model_call_in_this_module(self):
        # The constraint that makes a verdict evidence. Asserted on the source text
        # because it is the only way to fail a future edit that adds one.
        source = Path(si_verify.__file__).read_text()
        for banned in ("bedrock", "invoke_model", "anthropic", "Converse", "strands"):
            self.assertNotIn(banned, source, f"si_verify must stay arithmetic: found {banned!r}")


if __name__ == "__main__":
    unittest.main()
