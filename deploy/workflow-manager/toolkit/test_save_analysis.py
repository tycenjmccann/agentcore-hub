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

import contextlib
import io
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
    # A fresh mock, not reset_mock(): another suite in the same pytest process
    # (the session reaper's boto3.client patch) leaves reset_mock() unable to clear
    # the put_object call history these tests count.
    save_analysis.boto3 = mock.MagicMock()
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


def _finding(i, severity="medium", kind="risk"):
    return {"title": f"f{i}", "kind": kind, "severity": severity, "evidence": "e"}


def _rec(i, priority="P2"):
    r = {"priority": priority, "type": "process", "title": f"r{i}", "description": "d", "expectedImpact": "e"}
    if priority in ("P0", "P1"):
        r["patternKey"] = f"ops.key-{i}"
    return r


class _Raw(str):
    """A section body written byte-for-byte (e.g. a truncated JSON write)."""


def _save_sectioned(test, sections, *, summary_md=None, metrics=None, manifest=None,
                    analysis_json=None, ws=None, stderr=None, ledger=None, expect_puts=1):
    """Drive the REAL main() over a workspace that has analysis.d/ (and, by
    default, NO analysis.json). Returns (item persisted to the analyses table,
    merged analysis.json written back, parsed stdout JSON).

    manifest      list of part names -> analysis.d/manifest.json {"parts": [...]}
                  (a _Raw body is written verbatim, for malformed-manifest tests)
    analysis_json a baseline {workspace}/analysis.json to write first
    ws            caller-owned workspace dir (to inspect it or re-run main() after)
    stderr        a StringIO to capture the warnings (default: discarded)
    ledger        the SiLedger fake to install (default: a fresh MagicMock)
    """
    # A fresh mock, not reset_mock(): another suite in the same pytest process
    # (the session reaper's boto3.client patch) leaves reset_mock() unable to clear
    # the put_object call history these tests count.
    save_analysis.boto3 = mock.MagicMock()
    ledger = ledger if ledger is not None else mock.MagicMock()
    stderr = stderr if stderr is not None else io.StringIO()
    stdout = io.StringIO()
    ctx = tempfile.TemporaryDirectory() if ws is None else contextlib.nullcontext(ws)
    with ctx as ws:
        sdir = os.path.join(ws, "analysis.d")
        os.makedirs(sdir, exist_ok=True)
        for name, body in sections.items():
            with open(os.path.join(sdir, name), "w") as f:
                # .md sections and _Raw bodies are written verbatim, the rest as JSON
                f.write(str(body) if name.endswith(".md") or isinstance(body, _Raw) else json.dumps(body))
        if manifest is not None:
            with open(os.path.join(sdir, "manifest.json"), "w") as f:
                f.write(str(manifest) if isinstance(manifest, _Raw) else json.dumps({"parts": manifest}))
        if analysis_json is not None:
            with open(os.path.join(ws, "analysis.json"), "w") as f:
                json.dump(analysis_json, f)
        if summary_md is not None:
            with open(os.path.join(ws, "summary.md"), "w") as f:
                f.write(summary_md)
        with open(os.path.join(ws, "metrics.json"), "w") as f:
            json.dump(metrics or {"totalDurationMs": 1}, f)
        with open(os.path.join(ws, "dossier.json"), "w") as f:
            json.dump({"workflowDefId": "software-delivery", "workflow": {"phase": "complete"}}, f)
        with mock.patch.object(sys, "argv", ["save_analysis.py", "wf_1", "--workspace", ws]), \
                mock.patch.object(save_analysis.si_ledger, "SiLedger", return_value=ledger), \
                mock.patch("sys.stderr", stderr), mock.patch("sys.stdout", stdout):
            save_analysis.main()
        with open(os.path.join(ws, "analysis.json")) as f:
            written = json.load(f)
    put_item = save_analysis.boto3.resource.return_value.Table.return_value.put_item
    test.assertEqual(put_item.call_count, expect_puts)
    out = json.loads(stdout.getvalue()) if stdout.getvalue().strip() else None
    return put_item.call_args.kwargs["Item"], written, out


def _json_parts(sections):
    """The manifest for a sections dict: its JSON part names, in order."""
    return [n for n in sections if n.endswith(".json")]


class SectionedMerge(unittest.TestCase):
    """TEAM-5226: the analysis is written one top-level key per tool call into
    analysis.d/, so no single tool call is large enough to hit the output cap."""

    def _sections(self):
        a = _valid_analysis()
        return {
            "scores.json": a["scores"],
            "verdict.json": a["verdict"],
            "findings.1.json": [a["findings"][0], _finding(2, "high")],
            "findings.2.json": [_finding(3, "critical", "failure")],
            "recommendations.json": [_rec(1, "P1")],
            "trend.json": a["trend"],
            "summaryMarkdown.md": a["summaryMarkdown"],
        }

    def test_sections_merge_into_one_saved_analysis(self):
        item, written, _ = _save_sectioned(self, self._sections())
        self.assertEqual([f["title"] for f in item["findings"]], ["Tests passed", "f2", "f3"])
        self.assertEqual(item["recommendations"][0]["patternKey"], "ops.key-1")
        self.assertEqual(item["verdict"], "Solid run.")
        self.assertTrue(item["summaryMarkdown"].startswith("# Report"))
        self.assertNotIn("truncated", item)
        self.assertEqual(written["findings"], item["findings"], "merged analysis.json written back")

    def test_summary_falls_back_to_chunked_summary_md(self):
        sections = self._sections()
        del sections["summaryMarkdown.md"]
        item, _, _ = _save_sectioned(self, sections, summary_md="# From summary.md\n" + "y" * 220)
        self.assertTrue(item["summaryMarkdown"].startswith("# From summary.md"))

    def test_no_sections_dir_keeps_the_single_file_path(self):
        with tempfile.TemporaryDirectory() as ws:
            self.assertIsNone(save_analysis.merge_sections(ws))
        item = _persisted_item(self, {"phase": "complete"})
        self.assertEqual(item["verdict"], "Solid run.")

    def test_a_malformed_section_fails_validation_loudly(self):
        sections = self._sections()
        sections["trend.json"] = _Raw('{"priorRunsCompared": ')  # truncated write
        with self.assertRaises(SystemExit) as cm:
            _save_sectioned(self, sections)
        self.assertIn("analysis.d/trend.json", str(cm.exception))


class Caps(unittest.TestCase):
    def test_findings_and_recommendations_are_capped_by_rank(self):
        a = _valid_analysis()
        findings = [_finding(i, "low") for i in range(15)] + [_finding(99, "critical", "failure")]
        findings.append(a["findings"][0])  # the one success finding, low severity, last
        recs = [_rec(i, "P2") for i in range(18)] + [_rec(100, "P0")]
        capped, truncated = save_analysis.cap_analysis({**a, "findings": findings, "recommendations": recs})
        self.assertEqual(len(capped["findings"]), save_analysis.MAX_FINDINGS)
        self.assertEqual(len(capped["recommendations"]), save_analysis.MAX_RECOMMENDATIONS)
        self.assertIn("f99", [f["title"] for f in capped["findings"]], "critical finding kept")
        self.assertIn("success", [f["kind"] for f in capped["findings"]], "a success finding always survives")
        self.assertIn("r100", [r["title"] for r in capped["recommendations"]], "P0 kept")
        self.assertEqual(truncated, {"findings": 5, "recommendations": 7})
        save_analysis.validate(capped)

    def test_caps_are_applied_and_recorded_on_save(self):
        a = _valid_analysis()
        sections = {
            "scores.json": a["scores"], "verdict.json": a["verdict"], "trend.json": a["trend"],
            "findings.json": a["findings"] + [_finding(i) for i in range(20)],
            "recommendations.json": [_rec(i) for i in range(20)],
            "summaryMarkdown.md": a["summaryMarkdown"],
        }
        item, _, _ = _save_sectioned(self, sections)
        self.assertEqual(len(item["findings"]), 12)
        self.assertEqual(len(item["recommendations"]), 12)
        self.assertEqual(item["truncated"], {"findings": 9, "recommendations": 8})

    def test_under_the_cap_is_untouched(self):
        a = _valid_analysis()
        capped, truncated = save_analysis.cap_analysis(a)
        self.assertEqual(capped, a)
        self.assertEqual(truncated, {})

    def test_row_copy_of_fix_tickets_is_bounded_but_counts_stay_exact(self):
        metrics = {"fixTickets": {
            "count": 200,
            "ticketIds": [f"T-{i}" for i in range(200)],
            "entries": [{"id": f"T-{i}"} for i in range(200)],
        }}
        item, _, _ = _save_sectioned(self, SectionedMerge._sections(self), metrics=metrics)
        fix = item["metrics"]["fixTickets"]
        self.assertEqual(fix["count"], 200)
        self.assertEqual(len(fix["ticketIds"]), save_analysis.MAX_ROW_FIX_TICKETS)
        self.assertEqual(len(fix["entries"]), save_analysis.MAX_ROW_FIX_TICKETS)
        self.assertTrue(fix["truncated"])
        s3_metrics = [c for c in save_analysis.boto3.client.return_value.put_object.call_args_list
                      if c.kwargs["Key"].endswith("/metrics.json")]
        self.assertEqual(len(json.loads(s3_metrics[0].kwargs["Body"])["fixTickets"]["entries"]), 200,
                         "S3 metrics.json keeps the full list")


class Manifest(unittest.TestCase):
    """TEAM-5239: analysis.d/manifest.json is the generation marker. A same-session
    continuation after a max-tokens stop rewrites a key as fewer/different parts
    and leaves the old numbered parts behind; merging every file appended them,
    let them win, or aborted the save. Only the listed parts are merged now."""

    def _fresh(self):
        a = _valid_analysis()
        return {
            "scores.json": a["scores"],
            "verdict.json": a["verdict"],
            "findings.json": [a["findings"][0], _finding(1, "critical", "failure")],
            "recommendations.json": [],
            "trend.json": a["trend"],
            "summaryMarkdown.md": a["summaryMarkdown"],
        }

    def test_manifest_selects_parts_and_ignores_unlisted(self):
        # Attempt 1 wrote findings.1/2.json and a verdict, then died; the
        # continuation rewrote findings as ONE findings.json and a new verdict,
        # and listed exactly those. The leftovers are ignored, not appended.
        sections = self._fresh()
        sections["findings.1.json"] = [_finding(10, "high"), _finding(11, "high"), _finding(12, "high")]
        sections["findings.2.json"] = [_finding(20, "high"), _finding(21, "high"), _finding(22, "high")]
        stderr = io.StringIO()
        item, _, out = _save_sectioned(self, sections, manifest=_json_parts(self._fresh()), stderr=stderr)
        self.assertEqual([f["title"] for f in item["findings"]], ["Tests passed", "f1"])
        self.assertEqual(item["verdict"], "Solid run.")
        self.assertEqual(out["ignoredParts"], ["findings.1.json", "findings.2.json"])
        self.assertTrue(out["manifest"])
        self.assertIn("findings.2.json is not listed in manifest.json", stderr.getvalue())

    def test_manifest_ignores_baseline_analysis_json(self):
        # The workspace analysis.json is normally this script's OWN write-back of
        # an earlier (failed) merge, so it must never fill in a key the current
        # generation lacks: a missing key is reported, not papered over.
        sections = self._fresh()
        del sections["verdict.json"]
        stale = _valid_analysis()
        stale["verdict"] = "STALE verdict from an earlier merge"
        with self.assertRaises(SystemExit) as cm:
            _save_sectioned(self, sections, manifest=_json_parts(sections), analysis_json=stale)
        self.assertIn("verdict must be", str(cm.exception))

    def test_malformed_unlisted_part_does_not_abort_and_is_reported(self):
        sections = self._fresh()
        sections["recommendations.3.json"] = _Raw('[{"priority": "P2", "title": "cut off')
        item, _, out = _save_sectioned(self, sections, manifest=_json_parts(self._fresh()))
        self.assertEqual(item["recommendations"], [])
        self.assertEqual(out["ignoredParts"], ["recommendations.3.json"])

    def test_single_file_read_only_when_sections_dir_absent(self):
        # Precedence, stated once: while analysis.d/ exists it governs and a
        # hand-written analysis.json is ignored — even a fresher one. The
        # documented fallback is to remove analysis.d/ first.
        fresh = _valid_analysis()
        fresh["verdict"] = "FRESH single-file verdict"
        sections = self._fresh()
        item, _, _ = _save_sectioned(self, sections, manifest=_json_parts(sections), analysis_json=fresh)
        self.assertEqual(item["verdict"], "Solid run.", "sections govern while analysis.d/ exists")
        item = _persisted_item(self, {"phase": "complete"}, analysis=fresh)  # no analysis.d/
        self.assertEqual(item["verdict"], "FRESH single-file verdict")

    def test_missing_manifest_is_legacy_merge_with_warning(self):
        # A session still on the old skill text keeps saving: every part merged
        # over the baseline as before, plus a warning asking for the manifest.
        sections = self._fresh()
        sections["findings.2.json"] = [_finding(2, "high")]
        stderr = io.StringIO()
        item, _, out = _save_sectioned(self, sections, stderr=stderr)
        self.assertEqual([f["title"] for f in item["findings"]], ["Tests passed", "f1", "f2"])
        self.assertFalse(out["manifest"])
        self.assertEqual(out["ignoredParts"], [])
        self.assertIn("manifest.json missing", stderr.getvalue())

    def test_listed_missing_part_fails(self):
        sections = self._fresh()
        with self.assertRaises(SystemExit) as cm:
            _save_sectioned(self, sections, manifest=_json_parts(sections) + ["findings.2.json"])
        self.assertIn("findings.2.json", str(cm.exception))
        self.assertIn("remove it from manifest.json", str(cm.exception))

    def test_manifest_wrong_shape_fails(self):
        for body in (_Raw('{"parts": "scores.json"}'), _Raw('["scores.json"]'), _Raw('{"parts": [1]}'), _Raw('{"parts": ')):
            with self.subTest(body=str(body)):
                with self.assertRaises(SystemExit) as cm:
                    _save_sectioned(self, self._fresh(), manifest=body)
                self.assertIn("analysis.d/manifest.json", str(cm.exception))

    def test_manifest_tolerates_summary_md_and_paths(self):
        # Agents will list summaryMarkdown.md, the manifest itself, and
        # path-prefixed names; none of that may fail or ignore a real part.
        sections = self._fresh()
        manifest = ["analysis.d/" + n for n in _json_parts(sections)] + ["summaryMarkdown.md", "manifest.json"]
        stderr = io.StringIO()
        item, _, out = _save_sectioned(self, sections, manifest=manifest, stderr=stderr)
        self.assertEqual(item["verdict"], "Solid run.")
        self.assertTrue(item["summaryMarkdown"].startswith("# Report"))
        self.assertEqual(out["ignoredParts"], [])
        self.assertNotIn("WARNING", stderr.getvalue())


class RetireSections(unittest.TestCase):
    """After the row is persisted, analysis.d/ is renamed away so a later write
    in the same session cannot merge with what was already saved."""

    def test_sections_retired_after_save_and_rerun_uses_single_file(self):
        sections = Manifest._fresh(self)
        with tempfile.TemporaryDirectory() as ws:
            item, written, _ = _save_sectioned(self, sections, manifest=_json_parts(sections), ws=ws)
            self.assertFalse(os.path.exists(os.path.join(ws, "analysis.d")))
            saved = [n for n in os.listdir(ws) if n.startswith("analysis.d.saved-")]
            self.assertEqual(saved, [f"analysis.d.saved-{item['analysisId']}"])
            self.assertIn("manifest.json", os.listdir(os.path.join(ws, saved[0])), "parts kept for forensics")
            # A re-run in the same session takes the single-file path over the
            # written-back analysis.json and saves the same analysis again.
            save_analysis.boto3 = mock.MagicMock()
            with mock.patch.object(sys, "argv", ["save_analysis.py", "wf_1", "--workspace", ws]), \
                    mock.patch.object(save_analysis.si_ledger, "SiLedger", return_value=mock.MagicMock()), \
                    mock.patch("sys.stderr", io.StringIO()), mock.patch("sys.stdout", io.StringIO()):
                save_analysis.main()
        again = save_analysis.boto3.resource.return_value.Table.return_value.put_item.call_args.kwargs["Item"]
        volatile = {"analysisId", "analyzedAt", "s3Prefix"}
        self.assertEqual({k: v for k, v in again.items() if k not in volatile},
                         {k: v for k, v in item.items() if k not in volatile})

    def test_sections_kept_on_failed_save(self):
        sections = Manifest._fresh(self)
        sections["trend.json"] = _Raw('{"priorRunsCompared": ')  # a LISTED malformed part
        with tempfile.TemporaryDirectory() as ws:
            with self.assertRaises(SystemExit):
                _save_sectioned(self, sections, manifest=_json_parts(sections), ws=ws)
            self.assertTrue(os.path.isdir(os.path.join(ws, "analysis.d")))
            self.assertEqual([n for n in os.listdir(ws) if n.startswith("analysis.d.saved-")], [])
        self.assertEqual(save_analysis.boto3.client.return_value.put_object.call_count, 0)


class RowSize(unittest.TestCase):
    """TEAM-5239: the count caps do not bound the row. The row is measured and
    text is cut down a ladder until it fits DynamoDB's item limit; S3 keeps the
    full text; nothing is written when it cannot be made to fit."""

    def _big_sections(self, text=20_000, summary=300_000):
        a = _valid_analysis()
        findings = [dict(_finding(i, "high"), evidence="E" * text) for i in range(11)]
        findings.append(dict(a["findings"][0], evidence="E" * text))
        recs = [dict(_rec(i, "P2"), description="D" * text) for i in range(12)]
        return {
            "scores.json": a["scores"], "verdict.json": a["verdict"], "trend.json": a["trend"],
            "findings.json": findings, "recommendations.json": recs,
            "summaryMarkdown.md": "# R\n" + "S" * summary,
        }

    def test_oversized_row_is_shrunk_under_budget_and_s3_keeps_full_text(self):
        sections = self._big_sections()
        metrics = {"fixTickets": {"count": 50, "ticketIds": [f"T-{i}" for i in range(50)],
                                  "entries": [{"id": f"T-{i}", "summary": "Z" * 10_000} for i in range(50)]}}
        item, _, out = _save_sectioned(self, sections, manifest=_json_parts(sections), metrics=metrics)
        self.assertLessEqual(save_analysis.item_bytes(item), save_analysis.MAX_ROW_BYTES)
        self.assertEqual(len(item["findings"]), 12, "count caps untouched")
        self.assertGreater(item["truncated"]["bytes"], 400 * 1024)
        self.assertGreater(item["truncated"]["fields"], 0)
        self.assertNotIn("findings", item["truncated"], "nothing dropped by count")
        self.assertTrue(item["findings"][0]["evidence"].endswith(save_analysis.TRUNC_MARK))
        self.assertTrue(item["metrics"]["fixTickets"]["entries"][0]["summary"].endswith(save_analysis.TRUNC_MARK))
        self.assertEqual(item["metrics"]["fixTickets"]["count"], 50)
        self.assertEqual(out["truncated"], item["truncated"])
        s3 = {c.kwargs["Key"].rsplit("/", 1)[1]: json.loads(c.kwargs["Body"])
              for c in save_analysis.boto3.client.return_value.put_object.call_args_list}
        self.assertEqual(len(s3["analysis.json"]["findings"][0]["evidence"]), 20_000, "S3 keeps the full text")
        self.assertEqual(len(s3["analysis.json"]["summaryMarkdown"]), 300_004)
        self.assertNotIn("truncated", s3["analysis.json"])

    def test_list_heavy_metrics_are_stubbed_not_fatal(self):
        # A runaway run's metrics are lists of SHORT things: no rung of text
        # cutting helps, so the lists are stubbed rather than the analysis lost.
        sections = Manifest._fresh(self)
        metrics = {"totalDurationMs": 1, "phases": [{"x": i, "name": "p"} for i in range(60_000)],
                   "counts": {"tickets": 3}}
        item, _, _ = _save_sectioned(self, sections, manifest=_json_parts(sections), metrics=metrics)
        self.assertLessEqual(save_analysis.item_bytes(item), save_analysis.MAX_ROW_BYTES)
        self.assertEqual(item["metrics"]["phases"], {"count": 60_000, "truncated": True})
        self.assertEqual(item["metrics"]["counts"], {"tickets": 3}, "non-list metrics untouched")
        self.assertEqual(item["truncated"]["fields"], 1)

    def test_unfittable_row_fails_before_s3(self):
        sections = Manifest._fresh(self)
        with mock.patch.object(save_analysis, "MAX_ROW_BYTES", 100):
            with self.assertRaises(SystemExit) as cm:
                _save_sectioned(self, sections, manifest=_json_parts(sections))
        self.assertIn("nothing was written", str(cm.exception))
        self.assertEqual(save_analysis.boto3.client.return_value.put_object.call_count, 0)
        self.assertEqual(save_analysis.boto3.resource.return_value.Table.return_value.put_item.call_count, 0)

    def test_fit_row_is_a_no_op_under_budget(self):
        item = save_analysis.build_item("wf_1", "1-abcd", _valid_analysis(), {}, {}, "auto")
        row, info = save_analysis.fit_row(item)
        self.assertIs(row, item)
        self.assertIsNone(info)


class SightingsFromAuthored(unittest.TestCase):
    """The count cap must not drop a ledger sighting: the sightings come from
    the analysis as authored, and the row says which keys only dropped entries named."""

    def test_dropped_recommendation_patternkey_still_sighted_and_recorded(self):
        sections = Manifest._fresh(self)
        sections["recommendations.json"] = [_rec(i, "P0") for i in range(13)]  # cap is 12
        ledger = mock.MagicMock()
        item, _, out = _save_sectioned(self, sections, manifest=_json_parts(sections), ledger=ledger)
        self.assertEqual(len(item["recommendations"]), 12)
        self.assertEqual(sorted(c.args[0] for c in ledger.upsert_occurrence.call_args_list),
                         sorted(f"ops.key-{i}" for i in range(13)))
        self.assertEqual(item["truncated"], {"recommendations": 1, "droppedPatternKeys": ["ops.key-12"]})
        self.assertEqual(sorted(out["patternKeys"]), sorted(f"ops.key-{i}" for i in range(13)))

    def test_dropped_non_dict_or_bad_key_entry_is_skipped(self):
        # Dropped entries were never validated: a stray string or a malformed key
        # past the cap must neither crash the save nor reach the ledger.
        sections = Manifest._fresh(self)
        sections["findings.1.json"] = sections.pop("findings.json") + [_finding(i, "high") for i in range(10)]
        sections["findings.2.json"] = ["oops", {"patternKey": "BAD"}, {"patternKey": "ops.dropped-ok", "severity": "low"}]
        ledger = mock.MagicMock()
        item, _, _ = _save_sectioned(self, sections, manifest=_json_parts(sections), ledger=ledger)
        self.assertEqual(len(item["findings"]), 12)
        self.assertEqual([c.args[0] for c in ledger.upsert_occurrence.call_args_list], ["ops.dropped-ok"])
        self.assertEqual(item["truncated"], {"findings": 3, "droppedPatternKeys": ["ops.dropped-ok"]})


if __name__ == "__main__":
    unittest.main()
