#!/usr/bin/env python3
"""The performance card's version has one writer and two readers that cannot
import each other, and they must agree (TEAM-5186, r6-F1):

  lambda/cost-report/index.mjs            REPORT_VERSION           (writer)
  src/lib/workflow/performance.ts         CURRENT_REPORT_VERSION   (web reader)
  compute_metrics.py                      CARD_MIN_REPORT_VERSION  (this toolkit)

TEAM-5159 bumped the first two to 10 and left the floor at 9, so a v9 card —
written before claude_code cache read/write tokens were billed — was accepted
and its cost cited as performance-card@v5. Nothing shares the number at runtime:
this toolkit is `aws s3 sync`ed to the harness without the repo, the Lambda zip
is index.mjs + kpi.json, and Next bundles its own const. So the three stay
literals and THIS test (pytest, deploy/workflow-manager/toolkit in CI) plus the
mirror in lambda/cost-report/index.test.mjs (node --test) are what keep them
equal. The JS/TS values are read as TEXT — Python cannot import an .mjs, and
index.mjs pulls in @aws-sdk — the same grep lambda/cost-report/deploy.sh runs
to size a --backfill.

Run: python3 -m unittest deploy/workflow-manager/toolkit/test_report_version_parity.py
"""

import copy
import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from compute_metrics import CARD_MIN_REPORT_VERSION, compute_metrics  # noqa: E402
from test_metrics import FIXTURES, v5_card  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
WRITER = REPO / "lambda" / "cost-report" / "index.mjs"
WEB_READER = REPO / "src" / "lib" / "workflow" / "performance.ts"
WRITER_RE = re.compile(r"^export const REPORT_VERSION = (\d+);", re.M)
WEB_READER_RE = re.compile(r"^export const CURRENT_REPORT_VERSION = (\d+);", re.M)


def declared_version(path, pattern):
    """The one integer literal `pattern` declares in `path`. Exactly one match:
    zero means the declaration moved and this guard would otherwise pass
    vacuously; two means the file now says two different things."""
    if not path.is_file():
        raise AssertionError(f"{path.relative_to(REPO)} is missing — the parity guard "
                             f"needs the real file, not a stub")
    found = pattern.findall(path.read_text())
    if len(found) != 1:
        raise AssertionError(
            f"expected exactly one `{pattern.pattern}` declaration in "
            f"{path.relative_to(REPO)}, found {len(found)}; keep the literal on one "
            f"line in that shape so the WM floor can be checked against it")
    return int(found[0])


class ReportVersionParity(unittest.TestCase):
    def test_three_report_version_sites_agree(self):
        writer = declared_version(WRITER, WRITER_RE)
        web = declared_version(WEB_READER, WEB_READER_RE)
        sites = {
            "lambda/cost-report/index.mjs REPORT_VERSION": writer,
            "src/lib/workflow/performance.ts CURRENT_REPORT_VERSION": web,
            "deploy/workflow-manager/toolkit/compute_metrics.py CARD_MIN_REPORT_VERSION":
                CARD_MIN_REPORT_VERSION,
        }
        self.assertEqual(
            len(set(sites.values())), 1,
            "the card version is declared in three places that must agree:\n"
            + "\n".join(f"  {k} = {v}" for k, v in sites.items())
            + "\nBump all three together, then run lambda/cost-report/deploy.sh --backfill "
              "(the WM rejects every card below its floor until it runs).")

    def test_the_floor_is_the_version_that_bills_claude_code_cache_tokens(self):
        # The ticket's number, stated once: v10 is the first card that counts
        # claude_code cache read/write tokens (TEAM-5159). Anything below it
        # under-bills and must not be cited.
        self.assertEqual(CARD_MIN_REPORT_VERSION, 10)


class V9RejectedV10Accepted(unittest.TestCase):
    """r6-F1's repro, against the real compute_metrics(): the same v5-shaped card
    is rejected at reportVersion 9 and card-first at 10. Literal 9/10 on purpose
    (test_metrics uses CARD_MIN_REPORT_VERSION - 1); the parity test above is
    what makes these numbers move with the writer."""

    @classmethod
    def setUpClass(cls):
        with open(FIXTURES / "fix-lineage.json") as f:
            cls.dossier = json.load(f)

    def metrics(self, **kwargs):
        return compute_metrics(copy.deepcopy(self.dossier), **kwargs)

    def test_a_v9_card_is_not_card_first(self):
        m = self.metrics(card=v5_card(reportVersion=9))
        self.assertEqual(m["source"], "computed")
        self.assertIsNone(m["kpi"])
        self.assertIsNone(m["kpiVersion"])
        self.assertNotIn("quality", m, "no card-shaped quality block may leak from a rejected card")
        self.assertNotIn("cost", m, "the v9 card's cost block must not be cited")
        notes = m["dataQuality"]["notes"]
        self.assertTrue(any("reportVersion 9 < 10" in n for n in notes), notes)

    def test_a_v10_card_is_card_first(self):
        card = v5_card(reportVersion=10)
        m = self.metrics(card=card)
        self.assertEqual(m["source"], "performance-card@v5")
        self.assertEqual(m["cost"]["totalUsd"], 12.3456)
        self.assertEqual(m["kpi"], card["kpi"])
        self.assertEqual(m["kpiVersion"], card["kpi"]["version"])

    def test_the_dossiers_own_v9_card_is_refetched_not_used(self):
        # compute_metrics reads the dossier's card when none is passed; a v9 one
        # there is rejected the same way.
        d = copy.deepcopy(self.dossier)
        d["performanceCard"] = v5_card(reportVersion=9)
        m = compute_metrics(d)
        self.assertEqual(m["source"], "computed")
        self.assertTrue(any("reportVersion 9 < 10" in n for n in m["dataQuality"]["notes"]))


if __name__ == "__main__":
    unittest.main()
