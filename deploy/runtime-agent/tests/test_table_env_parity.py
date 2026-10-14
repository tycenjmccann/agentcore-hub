"""Parity test for *_TABLE env vars the fleet runtime reads (TEAM-6023).

Invariant: every DynamoDB table name the runtime (main.py) reads via
os.getenv/os.environ.get comes from deploy/config.sh via the deploy-one
twins (deploy-one.sh lightweight path, deploy-one-robust.py robust path) —
never a literal baked into either deploy script. If an operator renames a
table in config.sh, both twins must pick up the rename.

Root cause (TEAM-6023): deploy-one.sh hardcoded `EVENTS_TABLE=agentcore-hub-events`
and never passed WORKFLOWS_TABLE at all; deploy-one-robust.py had the same two
gaps in build_env_vars. This test discovers the *_TABLE reads straight out of
main.py (so it can't go stale) and checks all three files agree.

Run: pytest -q deploy/runtime-agent/tests/test_table_env_parity.py
"""

import importlib.util
import os
import re
import unittest
from pathlib import Path
from unittest import mock

_RUNTIME_DIR = Path(__file__).parent.parent
_MAIN_PY = _RUNTIME_DIR / "main.py"
_CONFIG_SH = _RUNTIME_DIR.parent / "config.sh"
_DEPLOY_ONE_SH = _RUNTIME_DIR / "deploy-one.sh"
_DEPLOY_ONE_ROBUST_PY = _RUNTIME_DIR / "deploy-one-robust.py"

# Matches: os.getenv("FOO_TABLE", "default-value") / os.environ.get("FOO_TABLE", "default-value")
_TABLE_READ_RE = re.compile(
    r'os\.(?:getenv|environ\.get)\(\s*"([A-Z0-9_]+_TABLE)"\s*,\s*"([^"]*)"\s*\)'
)


def _discover_table_defaults(source: str) -> dict[str, str]:
    """name -> default, in the order first seen."""
    found: dict[str, str] = {}
    for name, default in _TABLE_READ_RE.findall(source):
        found.setdefault(name, default)
    return found


def _load_robust_module():
    spec = importlib.util.spec_from_file_location(
        "deploy_one_robust", _DEPLOY_ONE_ROBUST_PY
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestTableEnvParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.main_source = _MAIN_PY.read_text()
        cls.config_source = _CONFIG_SH.read_text()
        cls.deploy_one_source = _DEPLOY_ONE_SH.read_text()
        cls.table_defaults = _discover_table_defaults(cls.main_source)
        cls.robust = _load_robust_module()

    def test_discovery_found_table_reads(self):
        # Guard against the regex silently finding nothing (e.g. main.py
        # changes to read tables some other way) — a vacuous pass would hide
        # every check below.
        self.assertGreaterEqual(len(self.table_defaults), 2)
        self.assertIn("EVENTS_TABLE", self.table_defaults)
        self.assertIn("WORKFLOWS_TABLE", self.table_defaults)

    def test_config_sh_exports_each_table_with_matching_default(self):
        for name, default in self.table_defaults.items():
            with self.subTest(table=name):
                pattern = re.compile(
                    r'export %s="\$\{%s:-%s\}"' % (name, name, re.escape(default))
                )
                self.assertRegex(
                    self.config_source,
                    pattern,
                    f"config.sh must export {name} defaulting to {default!r}",
                )

    def test_deploy_one_sh_passes_each_table_from_a_variable_not_a_literal(self):
        # Isolate the `agentcore deploy ... \` env block so a mention of a
        # table name elsewhere in the file (comments, other scripts) can't
        # satisfy the check.
        block_match = re.search(
            r"agentcore deploy \\(.*?)2>&1", self.deploy_one_source, re.DOTALL
        )
        self.assertIsNotNone(block_match, "could not find the agentcore deploy env block")
        block = block_match.group(1)

        for name in self.table_defaults:
            with self.subTest(table=name):
                # Accept either an always-set form (--env "NAME=${NAME:-default}")
                # or a conditional passthrough (${NAME:+--env "NAME=${NAME}"}).
                always_set = re.search(
                    r'--env\s+"%s=\$\{%s(:-[^}]*)?\}"' % (name, name), block
                )
                conditional = re.search(
                    r'\$\{%s:\+--env\s+"%s=\$\{%s\}"\}' % (name, name, name), block
                )
                self.assertTrue(
                    always_set or conditional,
                    f"deploy-one.sh must pass {name} from the ${name} variable, "
                    f"not a hardcoded literal",
                )
                literal = re.search(r'--env\s+"%s=(?!\$)[^"]*"' % name, block)
                self.assertIsNone(
                    literal,
                    f"deploy-one.sh passes {name} as a literal: {literal.group(0) if literal else ''}",
                )

    def test_deploy_one_robust_honours_renamed_tables(self):
        for name, default in self.table_defaults.items():
            with self.subTest(table=name):
                renamed = f"renamed-{name.lower()}"
                env = {"ARTIFACT_BUCKET": "test-bucket", name: renamed}
                with mock.patch.dict(os.environ, env, clear=True):
                    built = self.robust.build_env_vars(
                        "agentcore_hub_backend_dev", "prompts/x.txt"
                    )
                self.assertEqual(
                    built.get(name),
                    renamed,
                    f"deploy-one-robust.py must forward {name} from the environment "
                    f"instead of a baked-in default ({default!r})",
                )


if __name__ == "__main__":
    unittest.main()
