#!/usr/bin/env python3
"""TEAM-4160 D2 advisory — regression guard against committed fixtures leaking
a real AWS account id or artifact-bucket name.

The legacy `sffzti-dossier.json` / `yteqfl-dossier.json` fixtures shipped with
the real 838829463875 account id (in every `runtimeArn`) and the real
`agentcore-hub-artifacts-838829463875-us-east-1` bucket (in `_fixture.source`)
until TEAM-4192 scrubbed them to `000000000000` / `$ARTIFACT_BUCKET`, matching
the convention the f50ucz/ymo7dm dossiers already used. This walks every
`**/fixtures/*.json` in the repo and fails the same way a re-introduced real
value would: an account id is only real when it isn't the all-zero
placeholder, and the check is scoped to the three shapes an id actually
appears in (ARN, colon-delimited, hyphenated bucket/account segment) so a
13-digit epoch-millis timestamp elsewhere in the fixture can never trip it.

Run: python3 -m unittest deploy/workflow-manager/toolkit/test_fixtures_scrubbed.py
 or: cd deploy/workflow-manager/toolkit && python3 -m unittest discover
 or: pytest -q deploy/workflow-manager/toolkit
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # toolkit -> workflow-manager -> deploy -> repo root

# 000000000000 is the reserved scrub placeholder; every real AWS account id is
# some other 12-digit run.
NONZERO_12 = r"(?!0{12})\d{12}"

# Scoped to the three shapes an account id actually rides in these fixtures,
# so a 13-digit epoch-millis timestamp (e.g. workflow ids like
# wf_1788416098262_sffzti) can never match a 12-digit run inside it.
VIOLATION_PATTERNS = {
    "ARN account id": re.compile(rf"arn:aws:[a-z0-9-]+:[a-z0-9-]*:({NONZERO_12}):"),
    "colon-delimited account id": re.compile(rf":({NONZERO_12}):"),
    "hyphenated bucket/account id": re.compile(rf"-({NONZERO_12})-"),
}

# The real bucket name outlives any single account-id scrub — catch it by name
# too, independent of whether the account id inside it happened to get zeroed.
REAL_BUCKET_RE = re.compile(r"agentcore-hub-artifacts-\d{12}-[a-z0-9-]+")


def fixture_files():
    return sorted(
        p for p in ROOT.rglob("*.json")
        if "fixtures" in p.parts and "node_modules" not in p.parts
    )


class TestFixturesScrubbed(unittest.TestCase):
    def test_sanity_finds_fixture_files(self):
        files = fixture_files()
        self.assertGreaterEqual(
            len(files), 8,
            f"expected at least 8 fixtures/*.json files, found {len(files)}: {files}",
        )

    def test_no_real_account_id_or_bucket_in_any_fixture(self):
        violations = []
        for path in fixture_files():
            text = path.read_text()
            rel = path.relative_to(ROOT)
            for label, pattern in VIOLATION_PATTERNS.items():
                for m in pattern.finditer(text):
                    line = text.count("\n", 0, m.start()) + 1
                    violations.append(f"{rel}:{line}: {label} — {m.group(0)!r}")
            for m in REAL_BUCKET_RE.finditer(text):
                line = text.count("\n", 0, m.start()) + 1
                violations.append(f"{rel}:{line}: real artifact-bucket name — {m.group(0)!r}")

        self.assertEqual(
            violations, [],
            "committed fixtures must never carry a real AWS account id or bucket "
            "name (scrub to 000000000000 / $ARTIFACT_BUCKET):\n" + "\n".join(violations),
        )


if __name__ == "__main__":
    unittest.main()
