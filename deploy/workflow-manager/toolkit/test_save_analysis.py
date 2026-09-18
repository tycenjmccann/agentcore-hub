#!/usr/bin/env python3
"""Unit tests for save_analysis outcome handling — hermetic, no AWS.

TEAM-3758 / AC-D2.5: save_analysis.py is the ONLY write path for analyses, so it
is where the analyzer must accept the TEAM-3747 D2 ship-blocked terminal outcomes
("deploy-blocked" / "static-ci-only") as run outcomes, keep accepting the legacy
ones ("complete" / "cancelled" / "error"), and map an unknown / absent phase to
the "complete" fallback. This drives the REAL main() over a temp workspace and
reads back the runOutcome written to the analyses table — the actual mapping
(`phase if phase in RUN_OUTCOMES else "complete"`), not the constant in
isolation.

boto3 is stubbed in sys.modules BEFORE importing save_analysis (it imports boto3
at module load, and the CI toolkit job installs no boto3), and ARTIFACT_BUCKET is
set before import (read at module load). No production code is modified and no
AWS call is made.

Run: python3 -m unittest deploy/workflow-manager/toolkit/test_save_analysis.py
     pytest -q deploy/workflow-manager/toolkit/test_save_analysis.py
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

# save_analysis imports boto3 at module load and reads ARTIFACT_BUCKET from the
# environment at import time — satisfy both before importing so the test needs
# neither the boto3 wheel nor any AWS credentials/network.
sys.modules["boto3"] = mock.MagicMock()
os.environ.setdefault("ARTIFACT_BUCKET", "test-bucket")

import save_analysis  # noqa: E402


def _valid_analysis():
    """The LLM-authored analysis.json — the minimal shape save_analysis.validate
    accepts (exact score keys, a kind:"success" finding, a >=200-char report)."""
    return {
        "scores": {
            "overall": 82, "planning": 80, "execution": 85,
            "reviewEfficiency": 78, "reworkDiscipline": 90,
        },
        "verdict": "Solid run.",
        "findings": [{
            "title": "Tests passed", "kind": "success",
            "severity": "low", "evidence": "CI was green.",
        }],
        "recommendations": [],
        "trend": {"priorRunsCompared": 0},
        "summaryMarkdown": "# Report\n" + "x" * 220,
    }


def _persisted_item(test, workflow, metrics=None, analysis=None):
    """Drive the REAL save_analysis.main() over a temp workspace whose dossier
    carries `workflow` (or omits it when None), boto3 mocked, and return the item
    persisted to the analyses table."""
    save_analysis.boto3.reset_mock()
    with tempfile.TemporaryDirectory() as ws:
        with open(os.path.join(ws, "analysis.json"), "w") as f:
            json.dump(analysis or _valid_analysis(), f)
        with open(os.path.join(ws, "metrics.json"), "w") as f:
            json.dump(metrics if metrics is not None else {"totalDurationMs": 1000}, f)
        dossier = {"workflowDefId": "software-delivery", "epicId": "TEAM-1"}
        if workflow is not None:
            dossier["workflow"] = workflow
        with open(os.path.join(ws, "dossier.json"), "w") as f:
            json.dump(dossier, f)
        argv = ["save_analysis.py", "wf_1", "--workspace", ws]
        with mock.patch.object(sys, "argv", argv):
            save_analysis.main()
    put_item = save_analysis.boto3.resource.return_value.Table.return_value.put_item
    test.assertEqual(put_item.call_count, 1, "expected exactly one analyses-table put_item")
    return put_item.call_args.kwargs["Item"]


class OutcomeMapping(unittest.TestCase):
    def _run_outcome(self, workflow):
        return _persisted_item(self, workflow)["runOutcome"]

    def test_new_ship_blocked_outcomes_map_through(self):
        # The TEAM-3747 D2 additions: a run closed on a ship-blocked phase is
        # recorded HONESTLY, not coerced to "complete".
        self.assertEqual(self._run_outcome({"phase": "deploy-blocked"}), "deploy-blocked")
        self.assertEqual(self._run_outcome({"phase": "static-ci-only"}), "static-ci-only")

    def test_legacy_outcomes_still_map_through(self):
        for phase in ("complete", "cancelled", "error"):
            self.assertEqual(self._run_outcome({"phase": phase}), phase)

    def test_unknown_phase_falls_back_to_complete(self):
        # A non-terminal / unrecognized phase is not a valid run outcome, so the
        # mapping coerces it to "complete" (the documented fallback).
        for phase in ("development", "ship", "review", "totally-made-up"):
            self.assertEqual(self._run_outcome({"phase": phase}), "complete")

    def test_absent_phase_defaults_to_complete(self):
        # dossier with a workflow block but no phase, and with no workflow block
        # at all — both take the "complete" default without error.
        self.assertEqual(self._run_outcome({}), "complete")
        self.assertEqual(self._run_outcome(None), "complete")


class RunOutcomesConstant(unittest.TestCase):
    def test_constant_covers_new_and_legacy_values(self):
        # Parity guard for the phase->outcome mapping's accept-set. PARITY:
        # src/lib/workflow/types.ts SHIP_BLOCKED_OUTCOMES + analysis-types.ts.
        self.assertEqual(
            save_analysis.RUN_OUTCOMES,
            {"complete", "cancelled", "error", "deploy-blocked", "static-ci-only"},
        )


class KpiVersion(unittest.TestCase):
    """TEAM-4484 — the row records WHICH version of src/config/kpi.json scored the
    run, so a v1 score is never silently compared against a v2 one. It is
    provenance, not a required field: an analysis of a run with no v5 card is
    still valid and persists kpiVersion None."""

    def _item(self, metrics, **analysis_extra):
        analysis = _valid_analysis()
        analysis.update(analysis_extra)
        return save_analysis.build_item(
            "wf_1", "1750000000000-abcd", analysis, metrics,
            {"workflow": {"phase": "complete"}}, "auto",
        )

    def test_comes_from_metrics_kpi_version(self):
        self.assertEqual(self._item({"kpiVersion": 1, "source": "performance-card@v5"})["kpiVersion"], 1)

    def test_falls_back_to_the_analysis(self):
        # A WM that copied metrics.kpiVersion into analysis.json but ran against
        # a metrics.json written by an older toolkit.
        self.assertEqual(self._item({"source": "computed"}, kpiVersion=2)["kpiVersion"], 2)

    def test_metrics_wins_over_the_analysis(self):
        self.assertEqual(self._item({"kpiVersion": 1}, kpiVersion=99)["kpiVersion"], 1)

    def test_none_when_neither_has_one(self):
        # The "computed" path: no card, so no deterministic score and no version.
        self.assertIsNone(self._item({"kpiVersion": None, "source": "computed"})["kpiVersion"])
        self.assertIsNone(self._item({"totalDurationMs": 1000})["kpiVersion"])

    def test_it_sits_next_to_schema_version_and_changes_nothing_else(self):
        item = self._item({"kpiVersion": 1})
        self.assertEqual(item["schemaVersion"], save_analysis.SCHEMA_VERSION)
        self.assertEqual(save_analysis.SCHEMA_VERSION, 1, "kpiVersion is additive — no schema bump")
        self.assertEqual(item["runOutcome"], "complete")
        self.assertEqual(item["s3Prefix"], "workflows/wf_1/analysis/1750000000000-abcd/")
        self.assertEqual(item["scores"], _valid_analysis()["scores"])

    def test_it_is_persisted_end_to_end(self):
        item = _persisted_item(self, {"phase": "complete"}, metrics={"kpiVersion": 1})
        self.assertEqual(item["kpiVersion"], 1)

    def test_validate_accepts_an_analysis_with_or_without_kpi_version(self):
        # validate() is UNCHANGED: kpiVersion is optional and unvalidated, and an
        # analysis that omits it must not be rejected.
        save_analysis.validate(_valid_analysis())
        with_version = _valid_analysis()
        with_version["kpiVersion"] = 1
        save_analysis.validate(with_version)

    def test_a_sixth_scores_key_is_still_rejected(self):
        # The guard that keeps kpiVersion from leaking INTO scores: the score set
        # is exact, and the deterministic score is not a sixth LLM score.
        bad = _valid_analysis()
        bad["scores"]["kpiQuality"] = 74
        with self.assertRaises(SystemExit):
            save_analysis.validate(bad)


class PatternKeys(unittest.TestCase):
    """TEAM-4760 — a P0/P1 recommendation must name the defect class it is about.

    The defect this pins: recommendations used to be prose inside one analysis row,
    so "the WM has asked for this 8 times and 6 fixes did nothing" was
    unanswerable, and the loop re-synthesized the same ask for weeks. The key is
    what makes an ask countable. save_analysis is the only write path for analyses,
    so it is the only place the rule can be enforced — a missing key fails the save
    rather than being fixed up, because a silently keyless P0 is invisible again.
    """

    def _with_recs(self, *recs):
        analysis = _valid_analysis()
        analysis["recommendations"] = list(recs)
        return analysis

    def _rec(self, priority="P0", **extra):
        rec = {
            "priority": priority,
            "type": "prompt",
            "title": "Make the harness report completion before exiting",
            "description": "The agent exits without calling report_completion.",
            "expectedImpact": "Silent deaths go to zero.",
        }
        rec.update(extra)
        return rec

    def test_p0_without_patternkey_rejected(self):
        with self.assertRaises(SystemExit) as ctx:
            save_analysis.validate(self._with_recs(self._rec("P0")))
        self.assertIn("patternKey is required on P0", str(ctx.exception))

    def test_p1_without_patternkey_rejected(self):
        with self.assertRaises(SystemExit) as ctx:
            save_analysis.validate(self._with_recs(self._rec("P1")))
        self.assertIn("patternKey is required on P1", str(ctx.exception))

    def test_p2_may_omit_it(self):
        # Requiring a key on every nicety would only produce throwaway keys.
        save_analysis.validate(self._with_recs(self._rec("P2")))

    def test_malformed_keys_are_rejected_at_every_priority(self):
        bad = [
            "Harness.Silent-Death",          # uppercase
            "harness",                       # no area/slug split
            "harness.",                      # empty segment
            "harness..silent",               # empty middle segment
            "harness silent.death",          # space
            "harness_silent.death",          # underscore
            "#metrics",                      # reserved bookkeeping namespace
            "",
            42,
        ]
        for value in bad:
            with self.subTest(value=value):
                with self.assertRaises(SystemExit):
                    save_analysis.validate(self._with_recs(self._rec("P0", patternKey=value)))
            with self.subTest(value=value, priority="P2"):
                # A key that IS present must be valid even where it is optional: a
                # typo starts a second lineage for an already-tracked defect.
                with self.assertRaises(SystemExit):
                    save_analysis.validate(self._with_recs(self._rec("P2", patternKey=value)))

    def test_a_valid_key_passes(self):
        save_analysis.validate(
            self._with_recs(self._rec("P0", patternKey="harness.silent-death.exit-without-report"))
        )

    def test_a_finding_key_must_be_valid_but_is_not_required(self):
        analysis = _valid_analysis()
        save_analysis.validate(analysis)  # no key on the finding: fine
        analysis["findings"][0]["patternKey"] = "NOPE"
        with self.assertRaises(SystemExit):
            save_analysis.validate(analysis)
        analysis["findings"][0]["patternKey"] = "ci.flake.timeout"
        save_analysis.validate(analysis)


class Sightings(unittest.TestCase):
    """The occurrence rows this analysis contributes to the ledger — pure mapping,
    no table."""

    KEY = "harness.silent-death.exit-without-report"

    def _item(self):
        return {
            "workflowId": "wf_1",
            "analysisId": "1750000000000-abcd",
            "workflowDefId": "software-delivery",
            "analyzedAt": "2026-09-18T12:00:00Z",
        }

    def test_one_occurrence_per_key_even_when_named_twice(self):
        # The same defect named by a finding AND its recommendation is ONE sighting
        # in ONE run. Counting it twice would inflate the number the SI impact
        # panel exists to report.
        analysis = _valid_analysis()
        analysis["findings"] = [
            {"title": "Agent exited silently", "kind": "failure", "severity": "critical",
             "evidence": "TEAM-1 ended with no completion event.", "patternKey": self.KEY},
            {"title": "Tests passed", "kind": "success", "severity": "low", "evidence": "CI green."},
        ]
        analysis["recommendations"] = [{
            "priority": "P0", "type": "prompt", "patternKey": self.KEY,
            "title": "Require report_completion before exit",
            "description": "…", "expectedImpact": "…",
        }]
        out = save_analysis.sightings(analysis, self._item())
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["patternKey"], self.KEY)
        # Recommendation wins the title (it names the ask), finding wins the
        # severity (it is the only one that has a real severity).
        self.assertEqual(out[0]["title"], "Require report_completion before exit")
        self.assertEqual(out[0]["occurrence"]["severity"], "critical")

    def test_severity_falls_back_to_the_priority(self):
        analysis = _valid_analysis()
        analysis["recommendations"] = [
            {"priority": "P0", "type": "prompt", "patternKey": "a.b", "title": "t",
             "description": "d", "expectedImpact": "e"},
            {"priority": "P2", "type": "process", "patternKey": "c.d", "title": "t",
             "description": "d", "expectedImpact": "e"},
        ]
        got = {s["patternKey"]: s["occurrence"]["severity"] for s in save_analysis.sightings(analysis, self._item())}
        self.assertEqual(got, {"a.b": "critical", "c.d": "medium"})

    def test_occurrence_carries_the_run_and_the_analysis_id(self):
        analysis = _valid_analysis()
        analysis["recommendations"] = [{
            "priority": "P1", "type": "tooling", "patternKey": self.KEY, "title": "t",
            "description": "d", "expectedImpact": "e",
        }]
        occ = save_analysis.sightings(analysis, self._item())[0]["occurrence"]
        self.assertEqual(occ["workflowId"], "wf_1")
        # analysisId is what makes the upsert idempotent — a re-run of ANALYZE for
        # the same run must not add a second sighting.
        self.assertEqual(occ["analysisId"], "1750000000000-abcd")
        self.assertEqual(occ["workflowDefId"], "software-delivery")
        self.assertEqual(occ["at"], "2026-09-18T12:00:00Z")

    def test_no_keys_means_no_ledger_client_is_even_built(self):
        # An analysis with no keys must not construct SiLedger at all: doing so
        # would import boto3 and resolve credentials for a write that has nothing
        # to write, and would fail an ANALYZE on a role without ledger access.
        with mock.patch.object(save_analysis.si_ledger, "SiLedger") as ctor:
            out = save_analysis.record_sightings(_valid_analysis(), self._item())
        ctor.assert_not_called()
        self.assertEqual(out, {"keys": [], "errors": []})


class LedgerWriteIsNotFatal(unittest.TestCase):
    """The analysis is the expensive artifact; the ledger is a mirror the next
    analysis re-converges. A ledger failure must therefore be REPORTED, not
    allowed to discard a completed analysis."""

    def _analysis_with_two_keys(self):
        analysis = _valid_analysis()
        analysis["recommendations"] = [
            {"priority": "P0", "type": "prompt", "patternKey": "a.one", "title": "t",
             "description": "d", "expectedImpact": "e"},
            {"priority": "P1", "type": "process", "patternKey": "b.two", "title": "t",
             "description": "d", "expectedImpact": "e"},
        ]
        return analysis

    def test_both_keys_are_upserted_and_reported(self):
        fake = mock.MagicMock()
        with mock.patch.object(save_analysis.si_ledger, "SiLedger", return_value=fake):
            item = _persisted_item(self, {"phase": "complete"}, analysis=self._analysis_with_two_keys())
        self.assertEqual(item["recommendations"][0]["patternKey"], "a.one")
        self.assertEqual(
            sorted(c.args[0] for c in fake.upsert_occurrence.call_args_list),
            ["a.one", "b.two"],
        )

    def test_a_failing_upsert_does_not_lose_the_analysis(self):
        fake = mock.MagicMock()
        fake.upsert_occurrence.side_effect = [RuntimeError("ProvisionedThroughputExceeded"), None]
        with mock.patch.object(save_analysis.si_ledger, "SiLedger", return_value=fake):
            out = save_analysis.record_sightings(
                self._analysis_with_two_keys(),
                {"workflowId": "wf_1", "analysisId": "a1", "workflowDefId": "software-delivery",
                 "analyzedAt": "2026-09-18T12:00:00Z"},
            )
        # One key through, one reported — and no exception, so main() still printed
        # the saved analysis.
        self.assertEqual(out["keys"], ["b.two"])
        self.assertEqual(len(out["errors"]), 1)
        self.assertEqual(out["errors"][0]["patternKey"], "a.one")
        self.assertIn("ProvisionedThroughputExceeded", out["errors"][0]["error"])


if __name__ == "__main__":
    unittest.main()
