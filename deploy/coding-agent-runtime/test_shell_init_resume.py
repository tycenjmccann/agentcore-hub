#!/usr/bin/env python3
"""The Terminal resumes a codex thread under the model that created it (TEAM-5083).

shell-init.sh used to write today's default model into config.toml and then run
`codex resume <id>`, which the TUI resumes under config.model — so a default or
tier change between the cloud turn and opening the Terminal replayed the
thread's encrypted reasoning under another model. The hint now carries
CC_RESUME_MODEL and shell-init:

  1. resolves that model through the registry exporter BEFORE writing
     config.toml, so model, endpoint and region follow the thread, and runs
     `codex resume -m <model> <id>` — even over a deploy-env CODEX_MODEL;
  2. starts a new thread, with a notice, when the model no longer resolves
     (retired / quarantined / the "<ambiguous>" sentinel);
  3. resumes a hint without CC_RESUME_MODEL unpinned, as before;
  4. leaves claude / kiro launches alone, and launches nothing off a tty.

Hermetic: the REAL shell-init.sh runs under bash on a pty, copied with its
/tmp hint path, /app dir and runtime-env paths pointed at a temp dir. The
exporter, the config merger and the CLIs are stubs that record what they got.

Run: python3 -m pytest deploy/coding-agent-runtime/test_shell_init_resume.py -v
"""

import json
import os
import pty
import shlex
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent

SOL = "us.openai.gpt-6-sol"
TERRA = "us.openai.gpt-6-terra"   # the stub registry's current default
REGIONS = {SOL: "us-west-2", TERRA: "us-east-2"}

# Stand-in for `models_registry.py --export <cli…> [tier_or_id]`: a known id
# resolves to itself, anything else (retired, "<ambiguous>") falls back to the
# default — the real exporter's contract.
_EXPORTER = textwrap.dedent(f"""\
    import shlex, sys
    REGIONS = {REGIONS!r}
    args = sys.argv[2:]
    clis = [a for a in args if a in ("claude", "codex")]
    rest = [a for a in args if a not in ("claude", "codex")]
    want = rest[0] if rest else ""
    model = want if want in REGIONS else {TERRA!r}
    for cli in clis:
        if cli == "claude":
            print("export CLAUDE_RESOLVED_MODEL=us.anthropic.claude-test")
            continue
        for k, v in (("CODEX_RESOLVED_MODEL", model), ("CODEX_ENDPOINT", "bedrock-runtime"),
                     ("CODEX_REGION", REGIONS[model]),
                     ("CODEX_BASE_URL", "https://bedrock-runtime." + REGIONS[model] + ".example/openai/v1"),
                     ("CODEX_CONTEXT_WINDOW", "272000")):
            print("export " + k + "=" + shlex.quote(v))
    """)

_MERGER = textwrap.dedent("""\
    import json, os, sys
    with open(os.environ["TEST_MERGE_LOG"], "a") as f:
        f.write(json.dumps(sys.argv[1:]) + "\\n")
    """)

# Every CLI stub records its name, argv and the codex env it was launched with.
_CLI_STUB = textwrap.dedent("""\
    #!/usr/bin/env python3
    import json, os, sys
    with open(os.environ["TEST_CLI_LOG"], "w") as f:
        json.dump({"cli": os.path.basename(sys.argv[0]), "argv": sys.argv[1:],
                   "cwd": os.getcwd(),
                   "CODEX_MODEL": os.environ.get("CODEX_MODEL"),
                   "CODEX_REGION": os.environ.get("CODEX_REGION")}, f)
    """)


class _ShellInit(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="shell-init-resume-"))
        self.app = self.tmp / "app"
        self.home = self.tmp / "home"
        self.ws = self.tmp / "ws"
        self.workdir = self.ws / "sessions" / "s-1" / "repo"
        bindir = self.home / ".local" / "bin"
        for d in (self.app, bindir, self.workdir):
            d.mkdir(parents=True)
        (self.app / "models_registry.py").write_text(_EXPORTER)
        (self.app / "merge-codex-config.py").write_text(_MERGER)
        for name in ("codex", "claude", "kiro-cli"):
            stub = bindir / name
            stub.write_text(_CLI_STUB)
            stub.chmod(0o755)
        self.hint_path = self.tmp / "resume-launch.sh"
        self.cli_log = self.tmp / "cli.json"
        self.merge_log = self.tmp / "merge.log"

        src = (_HERE / "shell-init.sh").read_text()
        for real, fake in (("/tmp/.resume-launch.sh", str(self.hint_path)),
                           ("/app/", f"{self.app}/"),
                           ("/mnt/efs/.runtime-env.sh", str(self.tmp / "none-1.sh")),
                           ("/mnt/workspace/.runtime-env.sh", str(self.tmp / "none-2.sh"))):
            self.assertIn(real, src, f"shell-init.sh no longer mentions {real}")
            src = src.replace(real, fake)
        self.script = self.tmp / "shell-init.sh"
        self.script.write_text(src)

    def write_hint(self, **fields):
        with open(self.hint_path, "w") as f:
            for k, v in fields.items():
                f.write(f"{k}={shlex.quote(v)}\n")

    def codex_hint(self, sid="thread-1", **extra):
        self.write_hint(CC_RESUME_DIR=str(self.workdir), CC_RESUME_SID=sid,
                        CC_RESUME_CLI="codex", **extra)

    def run_shell(self, tty=True, env_extra=None) -> subprocess.CompletedProcess:
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(self.home),
               "WORKSPACE_ROOT": str(self.ws), "TEST_CLI_LOG": str(self.cli_log),
               "TEST_MERGE_LOG": str(self.merge_log), **(env_extra or {})}
        cmd = ["bash", "--norc", "--noprofile", "-c", f". {shlex.quote(str(self.script))}"]
        if not tty:
            return subprocess.run(cmd, env=env, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True, timeout=60)
        master, slave = pty.openpty()
        try:
            return subprocess.run(cmd, env=env, stdin=slave, stdout=slave,
                                  stderr=subprocess.PIPE, text=True, timeout=60)
        finally:
            os.close(slave)
            os.close(master)

    def launched(self) -> dict | None:
        if not self.cli_log.exists():
            return None
        return json.loads(self.cli_log.read_text())

    def merged_model(self) -> str:
        lines = self.merge_log.read_text().splitlines()
        self.assertEqual(len(lines), 1, "config.toml is merged exactly once per shell")
        return json.loads(lines[0])[1]


class TestCodexResume(_ShellInit):
    def test_resumes_pinned_to_the_thread_model(self):
        self.codex_hint(CC_RESUME_MODEL=SOL)
        self.run_shell()
        got = self.launched()
        self.assertEqual(got["cli"], "codex")
        self.assertEqual(got["argv"], ["resume", "-m", SOL, "thread-1"])
        self.assertEqual(got["cwd"], str(self.workdir))
        self.assertEqual(got["CODEX_REGION"], REGIONS[SOL], "endpoint/region follow the thread")
        self.assertEqual(self.merged_model(), SOL, "config.toml holds the thread's model")

    def test_thread_model_beats_a_deploy_env_codex_model(self):
        self.codex_hint(CC_RESUME_MODEL=SOL)
        self.run_shell(env_extra={"CODEX_MODEL": TERRA})
        self.assertEqual(self.launched()["argv"], ["resume", "-m", SOL, "thread-1"])
        self.assertEqual(self.merged_model(), SOL)

    def test_unresolvable_model_starts_a_new_thread_with_a_notice(self):
        for bound in ("<ambiguous>", "us.openai.gpt-5-retired"):
            with self.subTest(bound=bound):
                self.merge_log.unlink(missing_ok=True)
                self.cli_log.unlink(missing_ok=True)
                self.codex_hint(CC_RESUME_MODEL=bound)
                proc = self.run_shell()
                got = self.launched()
                self.assertEqual(got["cli"], "codex")
                self.assertEqual(got["argv"], [], "must not resume under another model")
                self.assertEqual(got["cwd"], str(self.workdir))
                self.assertIn("thread-1", proc.stderr)
                self.assertIn(bound, proc.stderr)
                self.assertIn("new thread", proc.stderr)
                self.assertEqual(self.merged_model(), TERRA)

    def test_legacy_hint_without_a_model_resumes_unpinned(self):
        self.codex_hint()
        self.run_shell()
        self.assertEqual(self.launched()["argv"], ["resume", "thread-1"])
        self.assertEqual(self.merged_model(), TERRA)


class TestOtherClis(_ShellInit):
    def test_claude_is_unchanged(self):
        self.write_hint(CC_RESUME_DIR=str(self.workdir), CC_RESUME_SID="c-1",
                        CC_RESUME_CLI="claude")
        self.run_shell()
        got = self.launched()
        self.assertEqual((got["cli"], got["argv"]), ("claude", ["--resume", "c-1"]))
        self.assertEqual(self.merged_model(), TERRA)

    def test_kiro_is_unchanged(self):
        self.write_hint(CC_RESUME_DIR=str(self.workdir), CC_RESUME_SID="k-1",
                        CC_RESUME_CLI="kiro", CC_RESUME_KIRO_HOME=str(self.tmp / "kiro"))
        self.run_shell()
        got = self.launched()
        self.assertEqual((got["cli"], got["argv"]), ("kiro-cli", ["chat", "--resume-id", "k-1"]))

    def test_a_model_on_a_non_codex_hint_is_ignored(self):
        self.write_hint(CC_RESUME_DIR=str(self.workdir), CC_RESUME_SID="c-2",
                        CC_RESUME_CLI="claude", CC_RESUME_MODEL=SOL)
        self.run_shell()
        self.assertEqual(self.launched()["argv"], ["--resume", "c-2"])
        self.assertEqual(self.merged_model(), TERRA)


class TestNoTty(_ShellInit):
    def test_nothing_is_launched_off_a_tty(self):
        self.codex_hint(CC_RESUME_MODEL=SOL)
        self.run_shell(tty=False)
        self.assertIsNone(self.launched())
        self.assertEqual(self.merged_model(), TERRA, "the hint is not even read off a tty")


if __name__ == "__main__":
    unittest.main()
