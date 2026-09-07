"""Plan-first coding delegation — the fleet side (hermetic, no AWS).

The pattern: a coding persona makes claude_code PLAN first (plan mode — reads
the repo, returns a plan, cannot edit), reviews/approves the plan, then
executes it in the SAME conversation. Validated 20/20 locally with the real
backend_dev prompt + blueprint before shipping (docs/plan-first-coding.md).

Three things must hold on this side:
  1. `claude_code(plan_only=True)` reaches the coding runtime as
     `permission_mode: "plan"` (claude only) — and is absent otherwise, so a
     legacy far side sees today's payload.
  2. The plan-first protocol is appended to a coding persona's blueprint ONLY
     when PLAN_FIRST_CODING is on AND the blueprint is in PLAN_FIRST_BLUEPRINTS;
     source of truth is the S3 fragment, embedded copy is the fallback. Flag
     off = blueprint text byte-identical to before.
  3. The LOCAL fallback path (no coding runtime) honors plan_only too: plan
     turn = `--permission-mode plan`, and the execute turn `--resume`s the plan
     turn's conversation. A task that never passes plan_only keeps today's argv
     EXACTLY.

main.py cannot be imported (module top-level installs Node.js, reads S3), so
each function under test is AST-extracted and exec'd with stubbed globals —
the real body, not a copy that could drift.
"""

import ast
import json
import textwrap
import types
from pathlib import Path
from unittest import mock

import pytest

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"
_SRC = MAIN_PY.read_text()
_TREE = ast.parse(_SRC)


def _segment(pred):
    node = next((n for n in _TREE.body if pred(n)), None)
    assert node is not None, "top-level definition not found in main.py"
    # get_source_segment on a FunctionDef starts at `def` — decorators (@tool)
    # are excluded, which is what we want (strands would wrap the callable).
    return textwrap.dedent(ast.get_source_segment(_SRC, node))


def _is_assign(n, name):
    return isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in n.targets)


def _is_def(n, name):
    return isinstance(n, ast.FunctionDef) and n.name == name


def _exec(ns, *preds):
    for p in preds:
        exec(compile(_segment(p), str(MAIN_PY), "exec"), ns)
    return ns


def _fresh_session():
    return {"session_id": None, "conversation_ids": {}, "repo": None, "recorded": False,
            "resume_transcript": None, "resume_session_id": None, "branch": None,
            "git_mode": None, "clone_url": None}


# ─── 1. remote turn payload ──────────────────────────────────────────────────

class _Client:
    def __init__(self, *a, **k):
        pass


def _remote_ns(captured):
    def _submit_and_poll(client, payload, outer_deadline=None, budget=None):
        captured.append(payload)
        return {"response": "PLAN: 1) add apply_discount 2) tests", "claude_session_id": "conv-1"}

    ns = {
        "uuid": __import__("uuid"), "time": __import__("time"), "logger": mock.Mock(),
        "boto3": types.SimpleNamespace(client=lambda *a, **k: _Client()),
        "BotocoreConfig": lambda **k: None, "REGION": "us-east-1",
        "_CODING_SESSION": _fresh_session(),
        "_WATCHDOG": {"turnTimeoutSecs": 1500}, "_WATCHDOG_LEGACY": {"turnTimeoutSecs": 1500},
        "REMOTE_CODING_READ_TIMEOUT": 600, "REMOTE_CODING_TURN_BUDGET_S": 2700,
        "REMOTE_CODING_TURN_DEADLINE_S": 6000,
        "_submit_and_poll": _submit_and_poll, "_publish_agent_error": mock.Mock(),
        "_record_coding_session": mock.Mock(),
        "_CURRENT_WORKFLOW_ID": "wf", "_CURRENT_AGENT_ID": "agentcore_hub_backend_dev",
        "_CURRENT_TICKET_ID": "T-1",
    }
    return _exec(ns, lambda n: _is_assign(n, "CODING_MODEL_TIERS"),
                 lambda n: _is_def(n, "_remote_coding_turn"))


def test_plan_only_reaches_coding_runtime_as_permission_mode_plan():
    captured = []
    ns = _remote_ns(captured)
    out = ns["_remote_coding_turn"]("plan the discount fn", "claude", repo="o/r",
                                    model="opus", plan_only=True)
    assert captured[0]["permission_mode"] == "plan"
    assert captured[0]["model"] == ns["CODING_MODEL_TIERS"]["opus"]  # plan on a strong tier
    assert "PLAN:" in out and "conversation=conv-1" in out  # footer carries the conversation


def test_default_turn_sends_no_permission_mode():
    # Legacy far sides must see today's payload exactly — the key is absent, not null.
    captured = []
    ns = _remote_ns(captured)
    ns["_remote_coding_turn"]("implement it", "claude", model="sonnet")
    assert "permission_mode" not in captured[0]


def test_plan_only_is_ignored_for_codex():
    captured = []
    ns = _remote_ns(captured)
    ns["_remote_coding_turn"]("plan", "codex", plan_only=True)
    assert "permission_mode" not in captured[0]


def test_execute_turn_resumes_the_plan_turns_conversation():
    captured = []
    ns = _remote_ns(captured)
    ns["_remote_coding_turn"]("plan", "claude", plan_only=True)
    ns["_remote_coding_turn"]("Plan approved. Implement it.", "claude")
    assert "claude_session_id" not in captured[0]  # first turn: fresh conversation
    assert captured[1]["claude_session_id"] == "conv-1"  # execute: same conversation
    assert "permission_mode" not in captured[1]


# ─── 2. blueprint fragment injection ─────────────────────────────────────────

class _NoSuchKey(Exception):
    pass


class _FakeS3:
    def __init__(self, objects, fail_keys=()):
        self.objects, self.fail_keys = objects, set(fail_keys)
        self.exceptions = types.SimpleNamespace(NoSuchKey=_NoSuchKey)

    def get_object(self, Bucket, Key):
        if Key in self.fail_keys:
            raise RuntimeError("s3 down")
        if Key not in self.objects:
            raise _NoSuchKey(Key)
        return {"Body": types.SimpleNamespace(read=lambda: self.objects[Key].encode())}

    def list_objects_v2(self, **kw):
        return {"Contents": [{"Key": k} for k in self.objects]}


BLUEPRINT = "# Blueprint: Backend Dev Lead\n\n## Process\nStep 2: delegate to claude_code.\n"
FRAGMENT = "## Plan-First Delegation (MANDATORY)\n\n(from S3)\n"


def _bp_ns(flag, s3, blueprints="backend-dev,frontend-dev,bug-fixer"):
    ns = {
        "boto3": types.SimpleNamespace(client=lambda *a, **k: s3),
        "REGION": "us-east-1", "ARTIFACT_BUCKET": "bkt", "logger": mock.Mock(),
        "PLAN_FIRST_CODING": flag,
        "PLAN_FIRST_BLUEPRINTS": {b for b in blueprints.split(",") if b},
    }
    return _exec(ns, lambda n: _is_assign(n, "PLAN_FIRST_FRAGMENT_KEY"),
                 lambda n: _is_assign(n, "_PLAN_FIRST_FALLBACK"),
                 lambda n: _is_def(n, "load_blueprint"),
                 lambda n: _is_def(n, "_plan_first_addendum"))


def _s3(extra=None, **kw):
    objs = {"blueprints/backend-dev.md": BLUEPRINT, "blueprints/qa-verifier.md": "# QA\n",
            "blueprints/_plan-first-coding.md": FRAGMENT}
    objs.update(extra or {})
    return _FakeS3(objs, **kw)


def test_flag_off_blueprint_is_byte_identical():
    ns = _bp_ns(False, _s3())
    assert ns["load_blueprint"]("backend-dev") == BLUEPRINT


def test_flag_on_appends_s3_fragment_to_coding_blueprint():
    ns = _bp_ns(True, _s3())
    out = ns["load_blueprint"]("backend-dev")
    assert out.startswith(BLUEPRINT)
    assert out.rstrip().endswith("(from S3)")
    assert "Plan-First Delegation (MANDATORY)" in out


def test_flag_on_leaves_non_coding_blueprints_alone():
    ns = _bp_ns(True, _s3())
    assert ns["load_blueprint"]("qa-verifier") == "# QA\n"


def test_flag_on_respects_blueprint_allow_list_override():
    ns = _bp_ns(True, _s3(), blueprints="frontend-dev")
    assert ns["load_blueprint"]("backend-dev") == BLUEPRINT


def test_fragment_read_failure_falls_back_to_embedded_copy_never_drops_gate():
    ns = _bp_ns(True, _s3(fail_keys={"blueprints/_plan-first-coding.md"}))
    out = ns["load_blueprint"]("backend-dev")
    assert out.startswith(BLUEPRINT)
    assert "(from S3)" not in out
    assert "Plan-First Delegation (MANDATORY)" in out  # embedded copy
    assert 'plan_only=True, model="opus"' in out
    ns["logger"].warning.assert_called()


def test_embedded_fallback_matches_shipped_fragment_file():
    # blueprints/_plan-first-coding.md is what the deploy stage syncs to S3; the
    # embedded copy is its fallback. They must not drift.
    ns = _bp_ns(True, _s3())
    shipped = (MAIN_PY.parent.parent.parent / "blueprints" / "_plan-first-coding.md").read_text()
    assert shipped.strip() == ns["_PLAN_FIRST_FALLBACK"].strip()


def test_available_listing_hides_fragment_files():
    ns = _bp_ns(True, _s3())
    out = ns["load_blueprint"]("nope")
    assert "not found" in out
    assert "backend-dev" in out and "qa-verifier" in out
    assert "_plan-first-coding" not in out


# ─── 3. local fallback path honors plan_only + chains the conversation ───────

FABLE = "us.anthropic.claude-fable-5-1"


def _local_ns():
    ns = {
        "os": __import__("os"), "json": json, "threading": __import__("threading"),
        "signal": __import__("signal"), "logger": mock.Mock(),
        "_remote_coding_enabled": lambda: False,
        "_maybe_resume_session": lambda s: None,
        "_remote_coding_turn": mock.Mock(),
        "_localize_repo_task": lambda task, repo, wd: task,
        "_WATCHDOG": {"toolDeadlineSecs": 600, "enabled": True},
        "_CODING_SESSION": _fresh_session(),
    }
    return _exec(ns, lambda n: _is_assign(n, "CODING_MODEL_TIERS"),
                 lambda n: _is_def(n, "claude_code"))


def _proc(stdout, rc=0):
    p = mock.Mock()
    p.pid = 4242
    p.returncode = rc
    p.communicate.return_value = (stdout, "")
    return p


def _run(ns, stdout, **kwargs):
    seen = {}

    def popen(argv, **kw):
        seen["argv"] = argv
        return _proc(stdout)

    env = {k: v for k, v in __import__("os").environ.items()
           if k not in ("ANTHROPIC_MODEL", "CLAUDE_MODEL")}
    with mock.patch("subprocess.Popen", side_effect=popen), \
         mock.patch("shutil.which", return_value="/usr/local/bin/claude"), \
         mock.patch.dict("os.environ", env, clear=True):
        out = ns["claude_code"]("do the thing", working_directory="/tmp", **kwargs)
    return seen["argv"], out


def test_local_default_argv_is_byte_identical_to_before():
    ns = _local_ns()
    argv, out = _run(ns, "implemented.")
    assert argv == ["/usr/local/bin/claude", "--print", "--dangerously-skip-permissions",
                    "--output-format", "text", "--model", FABLE, "--max-turns", "100", "do the thing"]
    assert out == "implemented."
    assert ns["_CODING_SESSION"]["conversation_ids"] == {}


def test_local_plan_turn_uses_plan_mode_json_and_stashes_conversation():
    ns = _local_ns()
    plan_json = json.dumps({"result": "PLAN:\n1. add fn\n2. add tests", "session_id": "sess-plan"})
    argv, out = _run(ns, plan_json, plan_only=True, model="opus")
    assert "--permission-mode" in argv and argv[argv.index("--permission-mode") + 1] == "plan"
    assert "--dangerously-skip-permissions" not in argv
    assert argv[argv.index("--output-format") + 1] == "json"
    assert argv[argv.index("--model") + 1] == ns["CODING_MODEL_TIERS"]["opus"]
    assert "--resume" not in argv
    assert out.startswith("PLAN:")
    assert "[coding-session: local cli=claude conversation=sess-plan]" in out
    assert ns["_CODING_SESSION"]["conversation_ids"]["claude"] == "sess-plan"


def test_local_execute_turn_resumes_the_plan_conversation_with_full_autonomy():
    ns = _local_ns()
    _run(ns, json.dumps({"result": "plan", "session_id": "sess-plan"}), plan_only=True)
    argv, out = _run(ns, json.dumps({"result": "done, tests pass", "session_id": "sess-plan"}),
                     model="sonnet")
    assert "--dangerously-skip-permissions" in argv
    assert "--permission-mode" not in argv
    assert argv[argv.index("--resume") + 1] == "sess-plan"
    assert argv[argv.index("--output-format") + 1] == "json"
    assert argv[argv.index("--model") + 1] == ns["CODING_MODEL_TIERS"]["sonnet"]
    assert out.startswith("done, tests pass")


def test_local_non_json_output_in_chain_mode_is_surfaced_not_swallowed():
    ns = _local_ns()
    argv, out = _run(ns, "Error: something not JSON", plan_only=True)
    assert out.startswith("Error: something not JSON")
    assert "conversation=n/a" in out
