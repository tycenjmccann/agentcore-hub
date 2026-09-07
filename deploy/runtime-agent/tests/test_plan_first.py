"""Plan-first coding delegation — the fleet side (hermetic, no AWS).

The pattern: a coding persona makes claude_code PLAN first (plan mode — reads
the repo, returns a plan, cannot edit), reviews/approves the plan, then
executes it in the SAME conversation. Plan on opus, execute on sonnet.
Validated 20/20 locally with the real backend_dev prompt + blueprint before
shipping (docs/plan-first-coding.md). Always on — the protocol is written into
the coding blueprints, the tool side is `claude_code(plan_only=)`.

Three things must hold on this side:
  1. `claude_code(plan_only=True)` reaches the coding runtime as
     `permission_mode: "plan"` (claude only) — and is absent otherwise, so a
     legacy far side sees today's payload.
  2. The three coding blueprints carry the protocol: plan turn with
     plan_only=True on opus, review/revise instruction, execute on sonnet in the
     same conversation.
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
import re
import textwrap
import types
from pathlib import Path
from unittest import mock

import pytest

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"
REPO_ROOT = MAIN_PY.parent.parent.parent
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


# ─── 2. the coding blueprints carry the protocol ─────────────────────────────

CODING_BLUEPRINTS = ["backend-dev", "frontend-dev", "bug-fixer"]


def _blueprint(name):
    return (REPO_ROOT / "blueprints" / f"{name}.md").read_text()


@pytest.mark.parametrize("name", CODING_BLUEPRINTS)
def test_blueprint_requires_a_plan_turn_before_code(name):
    text = _blueprint(name)
    assert "PLAN FIRST" in text
    assert re.search(r"must NOT (write|change) code until you have approved", text), name
    # the plan turn: plan_only on a strong tier
    assert "plan_only=True" in text
    assert re.search(r'plan_only=True,\s*model="opus"|model="opus",\s*.*plan_only=True|plan_only=True[^\n]*model="opus"',
                     text, re.S), f"{name}: plan turn must run on opus"
    assert "Never plan on" in text  # never on haiku


@pytest.mark.parametrize("name", CODING_BLUEPRINTS)
def test_blueprint_has_review_revise_and_execute_steps(name):
    text = _blueprint(name)
    assert "Revise the plan" in text  # the revise path (exercised 2/20 in validation)
    assert "Never approve a plan you did not read" in text
    assert "Cap at 2 revision rounds" in text
    assert "Plan approved." in text  # the execute turn
    assert 'model="sonnet"' in text  # ...on the cheaper tier
    # execute is the SAME conversation — no plan_only, no resume_session
    assert re.search(r"NO `plan_only`, NO `resume_session`", text), name


@pytest.mark.parametrize("name", CODING_BLUEPRINTS)
def test_blueprint_rules_pin_the_model_split(name):
    text = _blueprint(name)
    assert re.search(r'PLAN turns on `"opus"`', text), name
    assert re.search(r'EXECUTE turns on `"sonnet"`', text), name
    assert re.search(r"Never let `claude_code` (write|change) code before you have read and approved", text), name


def test_load_blueprint_has_no_injection_or_flag():
    # The protocol lives IN the blueprint files (synced to S3 as-is). There is no
    # runtime fragment injection and no env flag — flag-off/flag-on drift is impossible.
    assert "PLAN_FIRST" not in _SRC
    assert "_plan_first_addendum" not in _SRC
    src = _segment(lambda n: _is_def(n, "load_blueprint"))
    assert 'return resp["Body"].read().decode("utf-8")' in src
    assert not (REPO_ROOT / "blueprints" / "_plan-first-coding.md").exists()


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
