"""Plan-first coding — the coding runtime's per-turn `permission_mode`.

A PLAN turn (`permission_mode: "plan"` in the payload) must run Claude Code in
plan mode (`--permission-mode plan`: reads the repo, returns a plan, cannot
edit) INSTEAD of full autonomy; every other value — absent, unknown, a typo —
must fall back to today's `--dangerously-skip-permissions` so a malformed
field can never change how a turn runs. The execute turn that follows is a
normal turn on the same conversation (`--resume`), which is what carries the
approved plan over.

Hermetic: main.py imports FastAPI at module level, so instead of importing it
this exec's the real `_build_claude_args` / `_run_claude` source (AST-extracted
— not a copy that could drift) with stubbed globals.

Run: python3 -m pytest -q deploy/coding-agent-runtime/test_plan_mode_args.py
"""

import ast
import json
import textwrap
from pathlib import Path
from unittest import mock

import pytest

MAIN_PY = Path(__file__).resolve().parent / "main.py"
_SRC = MAIN_PY.read_text()
_TREE = ast.parse(_SRC)


def _segment(pred):
    node = next((n for n in _TREE.body if pred(n)), None)
    assert node is not None, "top-level definition not found in main.py"
    return textwrap.dedent(ast.get_source_segment(_SRC, node))


def _is_assign(n, name):
    return isinstance(n, ast.Assign) and any(
        isinstance(t, ast.Name) and t.id == name for t in n.targets
    )


def _is_def(n, name):
    return isinstance(n, ast.FunctionDef) and n.name == name


def _load():
    ns = {
        "os": __import__("os"),
        "json": json,
        "subprocess": __import__("subprocess"),
        "CLAUDE_MODEL": "us.anthropic.claude-fable-5-1",
        "WORKSPACE_ROOT": "/tmp/pf-test-ws",
        "TURN_TIMEOUT_S": 1500,
        "_otel_turn_env": lambda session_id: {},
    }
    for pred in (
        lambda n: _is_assign(n, "CLAUDE_PERMISSION_MODES"),
        lambda n: _is_def(n, "_build_claude_args"),
        lambda n: _is_def(n, "_run_claude"),
    ):
        exec(compile(_segment(pred), str(MAIN_PY), "exec"), ns)
    return ns


@pytest.fixture()
def rt(tmp_path):
    ns = _load()
    ns["WORKSPACE_ROOT"] = str(tmp_path)
    return ns


# ─── _build_claude_args ──────────────────────────────────────────────────────

def test_plan_mode_swaps_full_autonomy_for_permission_mode_plan(rt, tmp_path):
    args = rt["_build_claude_args"](str(tmp_path), None, stream=False, permission_mode="plan")
    assert "--permission-mode" in args
    assert args[args.index("--permission-mode") + 1] == "plan"
    assert "--dangerously-skip-permissions" not in args


def test_default_turn_is_unchanged_full_autonomy(rt, tmp_path):
    args = rt["_build_claude_args"](str(tmp_path), None, stream=False)
    assert "--dangerously-skip-permissions" in args
    assert "--permission-mode" not in args


@pytest.mark.parametrize("bad", [None, "", "bypass", "acceptEdits", "PLAN", "plan ", "default", "yolo"])
def test_unknown_permission_mode_fails_safe_to_full_autonomy(rt, tmp_path, bad):
    # Strict allow-list: only the exact lowercase "plan" is honored. The handler
    # lowercases/strips before calling, but the argv builder must ALSO refuse
    # anything else so no caller can smuggle an odd mode through.
    args = rt["_build_claude_args"](str(tmp_path), None, stream=False, permission_mode=bad)
    assert "--dangerously-skip-permissions" in args
    assert "--permission-mode" not in args


def test_plan_mode_keeps_resume_model_and_output_format(rt, tmp_path):
    # The execute turn resumes the plan turn's conversation; the plan turn
    # itself may also be a --resume (a revision round). Everything else about
    # the argv — model override, json output, max-turns — is untouched.
    args = rt["_build_claude_args"](str(tmp_path), "conv-123", stream=False,
                                    model="us.anthropic.claude-opus-5", permission_mode="plan")
    assert args[:2] == ["claude", "--print"]
    assert args[args.index("--resume") + 1] == "conv-123"
    assert args[args.index("--model") + 1] == "us.anthropic.claude-opus-5"
    assert args[args.index("--output-format") + 1] == "json"
    assert "--max-turns" in args


def test_plan_mode_stream_variant(rt, tmp_path):
    args = rt["_build_claude_args"](str(tmp_path), None, stream=True, permission_mode="plan")
    assert "--permission-mode" in args and "plan" in args
    assert "stream-json" in args


# ─── _run_claude threads permission_mode through to the subprocess ───────────

def test_run_claude_passes_permission_mode_to_argv(rt, tmp_path):
    captured = {}

    def fake_run(args, **kw):
        captured["args"] = args
        return mock.Mock(returncode=0,
                         stdout=json.dumps({"result": "PLAN: 1. add fn 2. add tests",
                                            "session_id": "conv-plan-1"}),
                         stderr="")

    with mock.patch.object(rt["subprocess"], "run", side_effect=fake_run):
        out = rt["_run_claude"]("make a plan", str(tmp_path), None, session_id="s1",
                                model=None, permission_mode="plan")
    assert "--permission-mode" in captured["args"]
    assert captured["args"][-1] == "make a plan"  # prompt stays positional-last
    assert out == {"response": "PLAN: 1. add fn 2. add tests", "claude_session_id": "conv-plan-1"}


def test_run_claude_default_has_no_permission_mode(rt, tmp_path):
    captured = {}

    def fake_run(args, **kw):
        captured["args"] = args
        return mock.Mock(returncode=0, stdout=json.dumps({"result": "done", "session_id": "c"}), stderr="")

    with mock.patch.object(rt["subprocess"], "run", side_effect=fake_run):
        rt["_run_claude"]("implement it", str(tmp_path), "conv-plan-1", session_id="s1")
    assert "--permission-mode" not in captured["args"]
    assert "--dangerously-skip-permissions" in captured["args"]
    assert captured["args"][captured["args"].index("--resume") + 1] == "conv-plan-1"
