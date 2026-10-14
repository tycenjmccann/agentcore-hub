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

TEAM-6069 extends the invariant to the tool-Lambda names (TICKET_TOOLS_LAMBDA,
PIPELINE_TOOLS_LAMBDA, WORKFLOW_OUTPUT_LAMBDA) and moves the defaults' home to
deploy/lib/runtime-env-defaults.sh — the side-effect-free file config.sh and
deploy-one.sh both source, because deploy-fleet.sh / deploy-topology.sh never
source config.sh. Both twins must forward the identical *_TABLE/*_LAMBDA set,
and their fallbacks must equal that file's defaults.

Run: pytest -q deploy/runtime-agent/tests/test_table_env_parity.py
"""

import importlib.util
import os
import re
import subprocess
import unittest
from pathlib import Path
from unittest import mock

_RUNTIME_DIR = Path(__file__).parent.parent
_MAIN_PY = _RUNTIME_DIR / "main.py"
_CONFIG_SH = _RUNTIME_DIR.parent / "config.sh"
_DEPLOY_ONE_SH = _RUNTIME_DIR / "deploy-one.sh"
_DEPLOY_ONE_ROBUST_PY = _RUNTIME_DIR / "deploy-one-robust.py"
_RUNTIME_ENV_SH = _RUNTIME_DIR.parent / "lib" / "runtime-env-defaults.sh"

# Every os.getenv("FOO_LAMBDA"...) read in main.py — default or not, since
# TICKET_TOOLS_LAMBDA's fallback is derived from TICKET_PROVIDER.
_LAMBDA_READ_RE = re.compile(r'os\.(?:getenv|environ\.get)\(\s*"([A-Z0-9_]+_LAMBDA)"')
# Read by main.py but never invoked, and no such function is deployed
# (lambda/builder-tools has no deploy.sh) — so nothing to forward.
_UNFORWARDED_LAMBDAS = {"BUILDER_TOOLS_LAMBDA"}
_FORWARDED_RE = re.compile(r"^[A-Z0-9_]+_(?:TABLE|LAMBDA)$")

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


def _discover_lambda_names(source: str) -> list[str]:
    seen: list[str] = []
    for name in _LAMBDA_READ_RE.findall(source):
        if name not in seen and name not in _UNFORWARDED_LAMBDAS:
            seen.append(name)
    return seen


def _helper_resolved(names, env: dict[str, str]) -> dict[str, str]:
    """Source the helper in a clean bash and print what it resolves."""
    assert _RUNTIME_ENV_SH.is_file(), f"missing {_RUNTIME_ENV_SH} (TEAM-6069 defaults home)"
    script = (
        'source "$1"; resolve_runtime_lambda_names; shift; '
        'for n in "$@"; do printf "%s=%s\\n" "$n" "${!n}"; done'
    )
    out = subprocess.run(
        ["bash", "-c", script, "bash", str(_RUNTIME_ENV_SH), *names],
        env={"PATH": "/usr/bin:/bin", **env},
        capture_output=True, text=True, check=True,
    ).stdout
    return dict(line.split("=", 1) for line in out.splitlines())


def _main_py_ticket_tools_lambda(source: str, env: dict[str, str]) -> str:
    """Evaluate main.py's TICKET_TOOLS_LAMBDA assignment alone (no import)."""
    m = re.search(r"^TICKET_TOOLS_LAMBDA = .*?(?=^[A-Z_]+ = )", source, re.DOTALL | re.MULTILINE)
    assert m, "TICKET_TOOLS_LAMBDA assignment not found in main.py"
    ns: dict = {"os": os}
    with mock.patch.dict(os.environ, env, clear=True):
        exec(m.group(0), ns)  # noqa: S102 - our own source, one assignment
    return ns["TICKET_TOOLS_LAMBDA"]


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
        cls.lambda_names = _discover_lambda_names(cls.main_source)
        # Read leniently so a missing helper fails the assertions below with a
        # readable message instead of erroring the whole class.
        cls.helper_source = _RUNTIME_ENV_SH.read_text() if _RUNTIME_ENV_SH.is_file() else ""
        cls.robust = _load_robust_module()

    def test_discovery_found_table_reads(self):
        # Guard against the regex silently finding nothing (e.g. main.py
        # changes to read tables some other way) — a vacuous pass would hide
        # every check below.
        self.assertGreaterEqual(len(self.table_defaults), 2)
        self.assertIn("EVENTS_TABLE", self.table_defaults)
        self.assertIn("WORKFLOWS_TABLE", self.table_defaults)

    def test_config_sh_exports_each_table_with_matching_default(self):
        # TEAM-6069: the defaults' one home is runtime-env-defaults.sh, which
        # config.sh sources — so config.sh still exports every table, and a
        # rename made there reaches deploy-one.sh without config.sh's side effects.
        self.assertRegex(
            self.config_source,
            r'(?m)^\. ".*/lib/runtime-env-defaults\.sh"$',
            "config.sh must source lib/runtime-env-defaults.sh",
        )
        for name, default in self.table_defaults.items():
            with self.subTest(table=name):
                pattern = re.compile(
                    r'export %s="\$\{%s:-%s\}"' % (name, name, re.escape(default))
                )
                self.assertRegex(
                    self.helper_source,
                    pattern,
                    f"runtime-env-defaults.sh must export {name} defaulting to {default!r}",
                )
                self.assertNotRegex(
                    self.config_source,
                    r"(?m)^export %s=" % name,
                    f"config.sh must not redefine {name} (one home: runtime-env-defaults.sh)",
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

    # ─── TEAM-6069: tool-Lambda names + twin parity ───────────────────────────

    def test_discovery_found_lambda_reads(self):
        for name in ("TICKET_TOOLS_LAMBDA", "PIPELINE_TOOLS_LAMBDA", "WORKFLOW_OUTPUT_LAMBDA"):
            self.assertIn(name, self.lambda_names)

    def test_twins_forward_the_identical_table_and_lambda_set(self):
        block = re.search(
            r"agentcore deploy \\(.*?)2>&1", self.deploy_one_source, re.DOTALL
        ).group(1)
        lightweight = {
            n for n in re.findall(r'--env "([A-Z0-9_]+)=', block) if _FORWARDED_RE.match(n)
        }
        with mock.patch.dict(os.environ, {"ARTIFACT_BUCKET": "b"}, clear=True):
            robust = {
                n for n in self.robust.build_env_vars("a", "p").keys() if _FORWARDED_RE.match(n)
            }
        expected = set(self.table_defaults) | set(self.lambda_names)
        self.assertEqual(lightweight, robust, "deploy-one.sh and deploy-one-robust.py disagree")
        self.assertEqual(lightweight, expected, "forwarded set != what main.py reads")

    def test_defaults_agree_across_helper_robust_and_main_py(self):
        # Clean env: helper defaults == robust fallbacks == main.py defaults.
        names = list(self.table_defaults) + self.lambda_names
        helper = _helper_resolved(names, {})
        with mock.patch.dict(os.environ, {"ARTIFACT_BUCKET": "b"}, clear=True):
            robust = self.robust.build_env_vars("a", "p")
        main_defaults = dict(
            re.findall(r'os\.getenv\(\s*"([A-Z0-9_]+_LAMBDA)"\s*,\s*"([^"]*)"\s*\)', self.main_source)
        )
        main_defaults.update(self.table_defaults)
        main_defaults["TICKET_TOOLS_LAMBDA"] = _main_py_ticket_tools_lambda(self.main_source, {})
        for name in names:
            with self.subTest(name=name):
                self.assertEqual(helper[name], robust[name])
                self.assertEqual(helper[name], main_defaults[name])

    def test_ticket_tools_lambda_follows_ticket_provider(self):
        # The function setup-tickets-lambda.mjs deploys per provider; an explicit
        # TICKET_TOOLS_LAMBDA always wins.
        cases = [
            ({}, "agentcore-hub-jira"),
            ({"TICKET_PROVIDER": "jira"}, "agentcore-hub-jira"),
            ({"TICKET_PROVIDER": "dynamodb"}, "agentcore-hub-tickets"),
            ({"TICKET_PROVIDER": "dynamodb", "TICKET_TOOLS_LAMBDA": "custom"}, "custom"),
        ]
        for env, want in cases:
            with self.subTest(env=env):
                self.assertEqual(_helper_resolved(["TICKET_TOOLS_LAMBDA"], env)["TICKET_TOOLS_LAMBDA"], want)
                with mock.patch.dict(os.environ, {"ARTIFACT_BUCKET": "b", **env}, clear=True):
                    self.assertEqual(self.robust.build_env_vars("a", "p")["TICKET_TOOLS_LAMBDA"], want)
                self.assertEqual(_main_py_ticket_tools_lambda(self.main_source, env), want)

    def test_explicit_env_beats_every_default(self):
        names = list(self.table_defaults) + self.lambda_names
        env = {n: f"explicit-{n.lower()}" for n in names}
        helper = _helper_resolved(names, env)
        with mock.patch.dict(os.environ, {"ARTIFACT_BUCKET": "b", **env}, clear=True):
            robust = self.robust.build_env_vars("a", "p")
        for name in names:
            with self.subTest(name=name):
                self.assertEqual(helper[name], env[name])
                self.assertEqual(robust[name], env[name])


if __name__ == "__main__":
    unittest.main()
