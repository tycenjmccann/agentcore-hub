#!/usr/bin/env python3
"""TEAM-4760 U1 — the SI recommendation ledger, pinned against the SAME fixture
the workflow-analyzer Lambda uses.

The ledger is written from two runtimes that cannot share a line of code: this
toolkit (si_ledger.py, on the WM harness) and the workflow-analyzer /
prd-submitter Lambdas (lambda/workflow-analyzer/si-ledger.mjs). Both write the
SAME DynamoDB rows, so a disagreement about what `open` means, whether a
cancelled attempt is kept, or which metrics a recommendation may promise is not a
style difference — it is a ledger that lies.

So the two implementations share a FIXTURE: fixtures/si-ledger-contract.json (its
`_fixture.cases` explains why each case exists). lambda/workflow-analyzer/
si-ledger.test.mjs iterates the very same `transitions` array from JS and asserts
the very same `expect` objects, so a change on either side fails on the other —
the mechanism fix-lineage.json already uses for the fix-ticket predicate.

Two rules keep that honest and are enforced below:
  1. an `op` the fixture names but this suite cannot dispatch FAILS (a renamed
     function cannot quietly stop being tested), and
  2. an `expect` key this suite does not implement FAILS (an assertion cannot be
     added to one language only).

Unlike test_pull_dossier.py / test_save_analysis.py this file stubs NO boto3:
si_ledger imports it lazily, inside SiLedger.__init__ and only when no table is
injected, so the module is importable in the CI toolkit job that installs no
boto3 (same reason compute_metrics.request_card defers its import).

Run: python3 -m unittest deploy/workflow-manager/toolkit/test_si_ledger.py
     pytest -q deploy/workflow-manager/toolkit/test_si_ledger.py
"""

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from si_ledger import (  # noqa: E402
    ATTEMPT_OUTCOMES,
    DEFAULT_FRESH_DAYS,
    DEFAULT_OBSERVE_RUNS,
    METRIC_NAMES,
    SI_LEDGER_TABLE_DEFAULT,
    STATUSES,
    VERDICT_VALUES,
    SiLedger,
    apply_attempt,
    apply_expected,
    apply_occurrence,
    apply_status,
    apply_verdict,
    dedupe_blocked,
    is_valid_key,
    keys_lines,
    new_row,
    normalize_key,
    render_markdown,
    status_after_outcome,
)

FIXTURE = Path(__file__).parent / "fixtures" / "si-ledger-contract.json"
CONTRACT = json.loads(FIXTURE.read_text())

# The fixture's `op` names are the CANONICAL (JS) export names; this table is the
# only place that maps them onto the snake_case twins, and it also unpacks the
# camelCase option objects the JSON carries into keyword arguments.
OPS = {
    "newRow": lambda row, args: new_row(
        pattern_key=args[0].get("patternKey"),
        title=args[0].get("title"),
        at=args[0].get("at"),
        source=args[0].get("source"),
    ),
    "applyOccurrence": lambda row, args: apply_occurrence(row, args[0]),
    "applyStatus": lambda row, args: apply_status(
        row, args[0], note=args[1].get("note"), at=args[1].get("at")
    ),
    "applyAttempt": lambda row, args: apply_attempt(row, args[0]),
    "applyExpected": lambda row, args: apply_expected(
        row, args[0], prd_key=args[1].get("prdKey"), at=args[1].get("at")
    ),
    "applyVerdict": lambda row, args: apply_verdict(row, args[0]),
    "dedupeBlocked": lambda row, args: dedupe_blocked(
        row, now=args[0].get("now"), fresh_days=args[0].get("freshDays", DEFAULT_FRESH_DAYS)
    ),
}

ROW_EXPECT_KEYS = {
    "row", "status", "firstSeen", "lastSeen", "counts",
    "occurrences", "attempts", "expected", "verdicts",
}


class Contract(unittest.TestCase):
    """The enums and key rules, straight off the fixture."""

    def test_metric_names_match_the_fixture_exactly_in_order(self):
        # scripts/check-si-ledger-parity.sh asserts the same thing textually
        # against the JS literal, so the list cannot drift in a change that never
        # runs either suite.
        self.assertEqual(list(METRIC_NAMES), CONTRACT["metricNames"])

    def test_enums_match_the_fixture(self):
        self.assertEqual(list(STATUSES), CONTRACT["statuses"])
        self.assertEqual(list(ATTEMPT_OUTCOMES), CONTRACT["attemptOutcomes"])
        self.assertEqual(list(VERDICT_VALUES), CONTRACT["verdictValues"])

    def test_status_after_outcome(self):
        for outcome, status in CONTRACT["statusAfterOutcome"].items():
            self.assertEqual(status_after_outcome(outcome), status, outcome)
        # Every outcome in the enum is covered, so a new outcome cannot be added
        # without deciding (in the fixture) where it leaves the row.
        self.assertEqual(sorted(CONTRACT["statusAfterOutcome"]), sorted(ATTEMPT_OUTCOMES))
        with self.assertRaises(ValueError):
            status_after_outcome("merged")

    def test_is_valid_key(self):
        for key in CONTRACT["keys"]["valid"]:
            self.assertTrue(is_valid_key(key), f"valid: {key!r}")
        for key in CONTRACT["keys"]["invalid"]:
            self.assertFalse(is_valid_key(key), f"invalid: {key!r}")

    def test_normalize_key(self):
        for raw, expected in CONTRACT["keys"]["normalize"]:
            self.assertEqual(normalize_key(raw), expected, f"normalize {raw!r}")
            # Normalisation is idempotent, or two writers could disagree about the
            # key for one pattern depending on how often it was normalised.
            self.assertEqual(normalize_key(expected), expected, f"idempotent {expected!r}")

    def test_normalize_key_raises(self):
        for raw in CONTRACT["keys"]["normalizeThrows"]:
            with self.assertRaises(ValueError, msg=f"should raise: {raw!r}"):
                normalize_key(raw)


class Transitions(unittest.TestCase):
    """Every `transitions` case in the fixture, run through the Python reducers."""

    def test_every_case_names_a_known_op(self):
        for case in CONTRACT["transitions"]:
            self.assertIn(
                case["op"], OPS,
                f"{case['name']}: fixture op {case['op']!r} has no Python binding — a renamed "
                f"function must not silently stop being tested",
            )

    def test_transitions(self):
        for case in CONTRACT["transitions"]:
            with self.subTest(case["name"]):
                self._run_case(case)

    def _run_case(self, case):
        run = OPS[case["op"]]
        name, expect = case["name"], case["expect"]
        row_in = None if case["row"] is None else copy.deepcopy(case["row"])
        before = None if case["row"] is None else copy.deepcopy(case["row"])

        if "throws" in expect:
            with self.assertRaises(ValueError) as ctx:
                run(row_in, case["args"])
            self.assertIn(expect["throws"], str(ctx.exception), name)
            if before is not None:
                self.assertEqual(row_in, before, f"{name}: a raising reducer must not mutate its input")
            return

        result = run(row_in, case["args"])

        # Purity is part of the contract: callers reduce twice before writing once.
        if before is not None:
            self.assertEqual(row_in, before, f"{name}: reducer mutated its input row")

        if "blocked" in expect or "reason" in expect:
            for key in expect:
                self.assertIn(key, {"blocked", "reason"}, f"{name}: unexpected expect key {key!r}")
            self.assertEqual(result["blocked"], expect["blocked"], f"{name}: blocked")
            # The reason is surfaced VERBATIM by prd-submitter and the run-analysis
            # skill, so both languages must produce the identical sentence.
            self.assertEqual(result["reason"], expect["reason"], f"{name}: reason")
            return

        self._assert_row(result, expect, name)

    def _assert_row(self, result, expect, name):
        for key in expect:
            self.assertIn(
                key, ROW_EXPECT_KEYS,
                f"{name}: fixture expects {key!r}, which this suite does not implement — add it "
                f"here AND in si-ledger.test.mjs, never in one language only",
            )
        if "row" in expect:
            self.assertEqual(result, expect["row"], f"{name}: whole row")
        for field in ("status", "firstSeen", "lastSeen"):
            if field in expect:
                self.assertEqual(result[field], expect[field], f"{name}: {field}")
        if "counts" in expect:
            self.assertEqual({
                "occurrences": len(result["occurrences"]),
                "attempts": len(result["attempts"]),
                "expected": len(result["expected"]),
                "verdicts": len(result["verdicts"]),
            }, expect["counts"], f"{name}: history lengths")
        for field in ("occurrences", "attempts", "expected", "verdicts"):
            if field in expect:
                self.assertEqual(result[field], expect[field], f"{name}: {field}")


class BeyondTheFixture(unittest.TestCase):
    """Behaviour the shared fixture cannot express."""

    def test_defaults(self):
        self.assertEqual(DEFAULT_OBSERVE_RUNS, 5)
        self.assertEqual(DEFAULT_FRESH_DAYS, 14)

    def test_new_row_defaults_its_timestamps_to_now(self):
        row = new_row(pattern_key="harness.silent-death", title="t")
        self.assertEqual(row["firstSeen"], row["lastSeen"])
        self.assertEqual(row["status"], "open")
        self.assertNotIn("source", row, "a normal row carries no source field")

    def test_non_iso_timestamp_raises(self):
        with self.assertRaises(ValueError) as ctx:
            new_row(pattern_key="harness.silent-death", title="t", at="last tuesday")
        self.assertIn("not an ISO-8601 timestamp", str(ctx.exception))


class FakeTable:
    """One in-memory table keyed on patternKey, recording what it was handed —
    enough to prove the read-modify-write path puts a WHOLE reduced row and that
    the Scan is paged, with no AWS and no boto3 in the room."""

    def __init__(self, items=None, page_size=2):
        self.items = dict(items or {})
        self.calls = []
        self.page_size = page_size

    def get_item(self, Key=None, **kwargs):  # noqa: N803 — boto3's own casing
        self.calls.append(("get_item", Key))
        item = self.items.get(Key["patternKey"])
        return {"Item": copy.deepcopy(item)} if item else {}

    def put_item(self, Item=None, **kwargs):  # noqa: N803
        self.calls.append(("put_item", Item))
        self.items[Item["patternKey"]] = copy.deepcopy(Item)
        return {}

    def delete_item(self, Key=None, **kwargs):  # noqa: N803
        self.calls.append(("delete_item", Key))
        self.items.pop(Key["patternKey"], None)
        return {}

    def scan(self, **kwargs):
        self.calls.append(("scan", kwargs))
        keys = sorted(self.items)
        start = keys.index(kwargs["ExclusiveStartKey"]["patternKey"]) + 1 if "ExclusiveStartKey" in kwargs else 0
        page = keys[start:start + self.page_size]
        out = {"Items": [copy.deepcopy(self.items[k]) for k in page]}
        if start + self.page_size < len(keys):
            out["LastEvaluatedKey"] = {"patternKey": page[-1]}
        return out


class Wrapper(unittest.TestCase):
    """The DynamoDB front, against FakeTable."""

    def setUp(self):
        self.table = FakeTable()
        self.ledger = SiLedger(table=self.table, table_name="t")

    def test_table_name_default(self):
        self.assertEqual(SiLedger(table=FakeTable()).table_name, SI_LEDGER_TABLE_DEFAULT)

    def test_upsert_occurrence_creates_then_reduces(self):
        created = self.ledger.upsert_occurrence(
            "Harness.Silent-Death.Exit Without Report", "Harness exits early",
            {"workflowId": "wf_1", "analysisId": "an_1", "workflowDefId": "software-delivery",
             "severity": "high", "at": "2026-09-01T10:00:00.000Z"},
        )
        self.assertEqual(created["patternKey"], "harness.silent-death.exit-without-report")
        self.assertEqual(created["status"], "open")
        self.assertEqual(len(created["occurrences"]), 1)

        # Second analysis, same run+analysis id: still one occurrence, later lastSeen.
        again = self.ledger.upsert_occurrence(
            "harness.silent-death.exit-without-report", "Harness exits early",
            {"workflowId": "wf_1", "analysisId": "an_1", "at": "2026-09-02T10:00:00.000Z"},
        )
        self.assertEqual(len(again["occurrences"]), 1)
        self.assertEqual(again["lastSeen"], "2026-09-02T10:00:00.000Z")
        self.assertEqual(again["firstSeen"], "2026-09-01T10:00:00.000Z")

        # Every write is a whole-row put — never a partial update.
        puts = [c for c in self.table.calls if c[0] == "put_item"]
        self.assertEqual(len(puts), 2)
        self.assertEqual(sorted(puts[0][1]), [
            "attempts", "expected", "firstSeen", "lastSeen", "occurrences",
            "patternKey", "status", "title", "verdicts",
        ])

    def test_full_path_batched_in_run_deployed_verified(self):
        key = "harness.silent-death.exit-without-report"
        self.ledger.upsert_occurrence(key, "Harness exits early", {
            "workflowId": "wf_1", "analysisId": "an_1", "at": "2026-09-01T10:00:00.000Z",
        })

        self.assertEqual(self.ledger.mark_batched([key], "prd_9")[0]["status"], "batched")

        row = self.ledger.put_expected(
            key,
            [{"metric": "dead_sessions_per_run",
              "baseline": {"value": 1.4, "runs": 6, "window": "30d"}, "target": 0.2}],
            prd_key="prd_9", at="2026-09-05T10:00:00.000Z",
        )
        self.assertEqual(row["expected"][0]["observeRuns"], DEFAULT_OBSERVE_RUNS)
        self.assertEqual(row["expected"][0]["prdKey"], "prd_9")
        # The float baseline round-trips as Decimal, which is exactly why put()
        # converts (the boto3 resource API rejects float outright).
        self.assertEqual(float(self.table.items[key]["expected"][0]["baseline"]["value"]), 1.4)

        in_run = self.ledger.mark_in_run([key], prd_key="prd_9", workflow_id="wf_si_9", epic_id="TEAM-9")
        self.assertEqual(in_run[0]["status"], "in-run")
        self.assertTrue(dedupe_blocked(in_run[0], now="2026-09-06T10:00:00.000Z")["blocked"])

        deployed = self.ledger.stamp_attempt(key, {
            "prdKey": "prd_9", "workflowId": "wf_si_9", "prNumbers": [430],
            "mergedAt": "2026-09-06T10:00:00.000Z", "deployedAt": "2026-09-06T12:00:00.000Z",
            "outcome": "deployed",
        })
        self.assertEqual(deployed["status"], "deployed")
        self.assertEqual(len(deployed["attempts"]), 1,
                         "the stamp updated the in-run attempt, it did not append a second")

        verified = self.ledger.record_verdict(key, {
            "at": "2026-09-25T10:00:00.000Z", "prdKey": "prd_9", "verdict": "verified",
            "before": {"dead_sessions_per_run": 1.4}, "after": {"dead_sessions_per_run": 0.1},
        })
        self.assertEqual(verified["status"], "verified")
        self.assertFalse(dedupe_blocked(verified, now="2026-09-26T10:00:00.000Z")["blocked"])

    def test_cancelled_run_returns_keys_to_open(self):
        key = "ci.recert-loop"
        self.ledger.upsert_occurrence(key, "CI re-certifies twice", {
            "workflowId": "wf_1", "analysisId": "an_1", "at": "2026-09-01T10:00:00.000Z",
        })
        self.ledger.mark_in_run([key], prd_key="prd_7", workflow_id="wf_si_7", epic_id="TEAM-7")
        row = self.ledger.stamp_attempt(key, {
            "prdKey": "prd_7", "workflowId": "wf_si_7", "outcome": "cancelled",
        })
        self.assertEqual(row["status"], "open")
        self.assertEqual(len(row["attempts"]), 1)
        self.assertEqual(row["attempts"][0]["outcome"], "cancelled")
        self.assertFalse(dedupe_blocked(row, now="2026-09-02T10:00:00.000Z")["blocked"])

    def test_batch_writers_skip_missing_single_key_writers_raise(self):
        self.ledger.upsert_occurrence("ci.recert-loop", "CI re-certifies twice", {
            "workflowId": "wf_1", "analysisId": "an_1", "at": "2026-09-01T10:00:00.000Z",
        })
        updated = self.ledger.mark_batched(["ci.recert-loop", "gone.missing"], "prd_7")
        self.assertEqual(len(updated), 1, "a deleted row must not fail the whole PRD submission")
        with self.assertRaises(ValueError) as ctx:
            self.ledger.record_verdict("gone.missing", {
                "at": "2026-09-02T10:00:00.000Z", "prdKey": "p", "verdict": "verified",
            })
        self.assertIn("no row for patternKey gone.missing", str(ctx.exception))

    def test_list_walks_every_scan_page(self):
        for key in ("a.one", "b.two", "c.three", "d.four", "e.five"):
            self.ledger.upsert_occurrence(key, key, {
                "workflowId": "wf", "analysisId": key, "at": "2026-09-01T10:00:00.000Z",
            })
        self.assertEqual(len(self.ledger.list()), 5)
        self.assertEqual(len([c for c in self.table.calls if c[0] == "scan"]), 3)

    def test_delete_normalises_the_key(self):
        self.ledger.upsert_occurrence("ci.recert-loop", "CI re-certifies twice", {
            "workflowId": "wf_1", "analysisId": "an_1", "at": "2026-09-01T10:00:00.000Z",
        })
        self.assertEqual(self.ledger.delete("CI.Recert Loop"), "ci.recert-loop")
        self.assertEqual(self.ledger.get("ci.recert-loop"), None)


class Renderers(unittest.TestCase):
    """The CLI's two read surfaces — pure, so they need no table."""

    def rows(self):
        return [
            {
                "patternKey": "harness.silent-death.exit-without-report",
                "title": "Harness exits without report_completion",
                "status": "deployed",
                "firstSeen": "2026-09-01T10:00:00.000Z",
                "lastSeen": "2026-09-04T09:00:00.000Z",
                "occurrences": [
                    {"workflowId": "wf_1", "analysisId": "an_1",
                     "workflowDefId": "software-delivery", "severity": "high",
                     "at": "2026-09-01T10:00:00.000Z"},
                    {"workflowId": "wf_2", "analysisId": "an_2",
                     "workflowDefId": "software-delivery", "severity": "high",
                     "at": "2026-09-04T09:00:00.000Z"},
                ],
                "attempts": [{
                    "prdKey": "prd_9", "workflowId": "wf_si_9", "epicId": "TEAM-9",
                    "prNumbers": [430, 431], "mergedAt": "2026-09-05T10:00:00.000Z",
                    "deployedAt": "2026-09-05T12:00:00.000Z", "outcome": "deployed", "note": "",
                }],
                "expected": [],
                "verdicts": [{
                    "at": "2026-09-20T10:00:00.000Z", "prdKey": "prd_9",
                    "verdict": "no-effect", "before": {}, "after": {}, "note": "",
                }],
            },
            {
                "patternKey": "ops.telegram.gate-timeout",
                "title": "deploy gate | times out",
                "status": "open",
                "firstSeen": "2026-08-01T10:00:00.000Z",
                "lastSeen": "2026-08-02T10:00:00.000Z",
                "occurrences": [
                    {"workflowId": "wf_x", "analysisId": "an_x",
                     "workflowDefId": "ops-runbook", "severity": "low",
                     "at": "2026-08-02T10:00:00.000Z"},
                ],
                "attempts": [],
                "expected": [],
                "verdicts": [],
            },
        ]

    def test_keys_lines_is_tab_separated_newest_first(self):
        lines = keys_lines(self.rows())
        self.assertEqual(lines, [
            "harness.silent-death.exit-without-report\tdeployed\tHarness exits without report_completion",
            "ops.telegram.gate-timeout\topen\tdeploy gate | times out",
        ])

    def test_def_filter_is_by_occurrence(self):
        # A row is not owned by the first def that saw it; filtering asks "did this
        # pattern ever occur in that def's runs".
        self.assertEqual(len(keys_lines(self.rows(), "software-delivery")), 1)
        self.assertEqual(len(keys_lines(self.rows(), "ops-runbook")), 1)
        self.assertEqual(len(keys_lines(self.rows(), "no-such-def")), 0)

    def test_render_markdown(self):
        out = render_markdown(self.rows(), "software-delivery")
        self.assertIn("## Recommendations filed and status (software-delivery)", out)
        self.assertIn("| `harness.silent-death.exit-without-report` | deployed | 2 ", out)
        self.assertIn("1 (deployed, prd_9, #430, #431)", out)
        self.assertIn("no-effect @ 2026-09-20T10:00:00.000Z", out)
        self.assertNotIn("ops.telegram", out)
        # A title containing a pipe must not break the table.
        self.assertIn("deploy gate \\| times out", render_markdown(self.rows()))

    def test_render_markdown_empty(self):
        self.assertIn("_(none yet)_", render_markdown([], "software-delivery"))


if __name__ == "__main__":
    unittest.main()
