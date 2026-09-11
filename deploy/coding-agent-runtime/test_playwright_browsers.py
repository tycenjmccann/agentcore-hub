"""Playwright's Chromium is baked at /opt/pw-browsers (Dockerfile ENV). The
runtime env used to override PLAYWRIGHT_BROWSERS_PATH to "0" (hermetic: look
inside node_modules), which defeated the bake — every verify turn on a fresh
microVM paid a failed `playwright test` + a 35 s browser download. These tests
pin the three surfaces that must agree (deploy.py env, Dockerfile, shell-init)."""
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def _read(name: str) -> str:
    with open(os.path.join(HERE, name), encoding="utf-8") as fh:
        return fh.read()


class PlaywrightBrowsersPathTest(unittest.TestCase):
    def test_deploy_env_does_not_override_baked_browser_path(self):
        src = _read("deploy.py")
        self.assertNotRegex(src, r'"PLAYWRIGHT_BROWSERS_PATH"\s*:\s*"0"')
        self.assertNotRegex(src, r'"PLAYWRIGHT_BROWSERS_PATH"\s*:')

    def test_dockerfile_bakes_browsers_at_opt_pw_browsers(self):
        src = _read("Dockerfile")
        self.assertRegex(src, re.compile(r"^\s*PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers", re.M))
        self.assertIn("playwright@1.60.0 install chromium", src)

    def test_dockerfile_browser_dir_owned_by_runtime_user(self):
        # A repo pinned to another Playwright version downloads its own revision
        # into this dir once per VM; read-only (a+rx) meant EACCES and a stuck turn.
        src = _read("Dockerfile")
        self.assertIn("chown -R bedrock_agentcore:bedrock_agentcore /opt/pw-browsers", src)
        self.assertNotIn("chmod -R a+rx /opt/pw-browsers", src)

    def test_shell_init_defaults_to_baked_path(self):
        src = _read("shell-init.sh")
        self.assertIn('export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"', src)


if __name__ == "__main__":
    unittest.main()
