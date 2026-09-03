"""Regression tests for deploy/pipeline/ecs-primary-container.py (TEAM-3814).

The helper must FAIL CLOSED: when the describe JSON yields no live
primaryContainer (e.g. `{}` during degraded ECS conditions), it must print
NOTHING to stdout and exit non-zero — never a synthesized fallback spec with an
empty `environment`, which a rollback would apply and wipe every runtime env
var (JIRA_*, GITHUB_PAT, TELEGRAM_*, ...).

Hermetic: no AWS, no network. The script filename has hyphens, so we invoke it
as a subprocess rather than importing it.
"""
import json
import os
import subprocess
import sys
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ecs-primary-container.py")
TARGET = "123456789012.dkr.ecr.us-east-1.amazonaws.com/agentcore-hub@sha256:deadbeef"


def run(*args):
    """Invoke the helper with the given argv; return the CompletedProcess."""
    return subprocess.run(
        [sys.executable, SCRIPT, *args],
        capture_output=True,
        text=True,
    )


class ZeroCandidateFailsClosed(unittest.TestCase):
    """(a)(b)(g) No live primaryContainer → non-zero exit, EMPTY stdout, never a fallback."""

    def _assert_fail_closed(self, describe_json):
        r = run(describe_json, TARGET)
        self.assertNotEqual(r.returncode, 0, f"expected non-zero exit for {describe_json!r}")
        self.assertEqual(r.stdout, "", f"stdout must be empty for {describe_json!r}, got {r.stdout!r}")
        # (g) never emit the env-wiping fallback spec
        self.assertNotIn('"environment": []', r.stdout)
        self.assertNotIn("environment", r.stdout)

    def test_empty_object(self):
        self._assert_fail_closed("{}")

    def test_empty_service(self):
        self._assert_fail_closed('{"service": {}}')

    def test_service_empty_active_configurations(self):
        self._assert_fail_closed('{"service": {"activeConfigurations": []}}')

    def test_service_active_configuration_without_primary(self):
        self._assert_fail_closed('{"service": {"activeConfigurations": [{"foo": "bar"}]}}')


class ValidPassthrough(unittest.TestCase):
    """(c)(d) A live primaryContainer → exit 0, image swapped, port+env preserved verbatim."""

    def test_active_configurations_shape(self):
        # (c) non-default containerPort (9090) + non-empty environment
        env = [
            {"name": "JIRA_API_TOKEN", "value": "secret-jira"},
            {"name": "GITHUB_PAT", "value": "ghp_xxx"},
            {"name": "TELEGRAM_BOT_TOKEN", "value": "tg-token"},
        ]
        describe = {
            "service": {
                "activeConfigurations": [
                    {"primaryContainer": {"image": "old-image", "containerPort": 9090, "environment": env}}
                ]
            }
        }
        r = run(json.dumps(describe), TARGET)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(out["image"], TARGET)
        self.assertEqual(out["containerPort"], 9090)
        self.assertEqual(out["environment"], env)

    def test_top_level_primary_container_shape(self):
        # (d) top-level service.primaryContainer
        env = [{"name": "GITHUB_PAT", "value": "ghp_yyy"}]
        describe = {"service": {"primaryContainer": {"image": "old", "containerPort": 7070, "environment": env}}}
        r = run(json.dumps(describe), TARGET)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(out["image"], TARGET)
        self.assertEqual(out["containerPort"], 7070)
        self.assertEqual(out["environment"], env)


class MalformedInput(unittest.TestCase):
    """(e) Non-JSON input → non-zero exit, EMPTY stdout."""

    def test_not_json(self):
        r = run("not-json{", TARGET)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(r.stdout, "")


class ArgCount(unittest.TestCase):
    """(f) Wrong arg count → exit 2, EMPTY stdout."""

    def test_missing_image_arg(self):
        r = run("{}")
        self.assertEqual(r.returncode, 2)
        self.assertEqual(r.stdout, "")

    def test_no_args(self):
        r = run()
        self.assertEqual(r.returncode, 2)
        self.assertEqual(r.stdout, "")


if __name__ == "__main__":
    unittest.main()
