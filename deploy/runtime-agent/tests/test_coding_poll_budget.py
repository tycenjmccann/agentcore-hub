"""The polled coding turn is bounded by ONE budget, and says which bound fired
(TEAM-4389) — hermetic, no AWS, no network.

The failure mode: a coding runner that wedges but keeps writing heartbeats
reports "running" on every poll. Each live poll extended `_poll_coding_turn`'s
deadline, and the old hard stop was `2 * budget` — so a wedged-yet-heartbeating
runner pinned the persona for TWICE the budget (9600s against a 3600s turn cap)
and then blamed the 1x budget in its give-up string, which sent postmortems
chasing the wrong timeout. The fix clamps the extension to a hard stop of ONE
budget and names the true elapsed seconds plus the bound that fired
("budget bound" vs "outer deadline bound").

Covered here, one test per acceptance criterion:
  1. A runner reporting "running" forever is cut off at ~1x budget (never 2x),
     and the error quotes the real elapsed time, the budget bound, the
     no_retry_hint flag and the verify-first advice.
  2. An already-expired outer_deadline exits naming the OUTER bound with an
     elapsed figure — while `_deadline_expired_error()` called bare (the
     pre-submit guard's call site, which has no turn clock) keeps returning the
     un-annotated message.

main.py cannot be imported plainly (module top-level installs Node.js, reads S3,
chdirs), so this reuses the loader that ../test_remote_coding.py already ships
(import stubs for strands / bedrock_agentcore / httpx + cwd restore) instead of
duplicating it. That loader's stubs are then REMOVED from sys.modules again: CI
runs all of tests/ in one pytest process, this file sorts first, and the stub
`strands` module is not a package — leaving it installed makes
test_prompt_cache / test_telemetry* (which need the REAL strands) fail to
import, taking the whole job down with a collection error.

Run: cd deploy/runtime-agent && python3 -m pytest tests/test_coding_poll_budget.py -v
(also runs under: python3 -m unittest tests.test_coding_poll_budget -v, which is
how it is exercised where pytest is unavailable)
"""

import re
import sys
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

# ../test_remote_coding.py owns the main.py import shim; its module-level
# `main = _import_main()` runs the loader on import. Both the sys.path entry and
# the loader's third-party stubs are transient — see the docstring: anything left
# behind here lands in every other test module in this pytest process.
_PARENT = str(Path(__file__).resolve().parent.parent)
_STUBBED = ("strands", "strands.models", "bedrock_agentcore",
            "bedrock_agentcore.runtime", "httpx")
_PRE_IMPORTED = {name for name in _STUBBED if name in sys.modules}

sys.path.insert(0, _PARENT)
try:
    from test_remote_coding import main  # noqa: E402
finally:
    if _PARENT in sys.path:
        sys.path.remove(_PARENT)
    for _name in _STUBBED:
        _mod = sys.modules.get(_name)
        # A synthetic stub has no __file__; a real installed module does. Only
        # drop stubs this import introduced.
        if (_name not in _PRE_IMPORTED and _mod is not None
                and getattr(_mod, "__file__", None) is None):
            del sys.modules[_name]

BUDGET_S = 2
POLL_S = 0.05
VERIFY_FIRST = ("Do NOT re-run", "check the branch on GitHub")


class CodingPollBudgetTestCase(unittest.TestCase):
    """Plain-assert tests (pytest collects TestCase classes too); the base class
    only exists so this file also runs under `python3 -m unittest`."""

    def setUp(self):
        # The prove-alive heartbeat path stamps events with these persona
        # globals, same as RemoteCodingTestCase.setUp.
        main._CURRENT_WORKFLOW_ID = "wf-test"
        main._CURRENT_AGENT_ID = "backend_dev"
        main._CURRENT_TICKET_ID = "TEAM-4389"

    def _wedged_runner(self):
        """Always-"running" runner, quiet events table, tiny poll interval."""
        stack = ExitStack()
        stack.enter_context(mock.patch.object(main, "_poll_once",
                                             return_value={"status": "running"}))
        # The prove-alive heartbeat writes to the events table.
        stack.enter_context(mock.patch.object(main, "_ddb_events_client",
                                             mock.MagicMock()))
        stack.enter_context(mock.patch.object(main, "REMOTE_CODING_POLL_S", POLL_S))
        # 9999 keeps the heartbeat writer out of this test entirely.
        stack.enter_context(mock.patch.object(main, "REMOTE_CODING_HEARTBEAT_S", 9999))
        return stack

    def test_running_forever_stops_at_budget(self):
        with self._wedged_runner():
            started = time.monotonic()
            result = main._poll_coding_turn(mock.MagicMock(), "turn-x",
                                            budget_s=BUDGET_S, cli="claude")
            wall_s = time.monotonic() - started

        # ONE budget plus at most one poll sleep. The generous slack is for a
        # loaded CI box; what must never pass is ~2x budget (the old hard stop),
        # which at production numbers was 9600s instead of 4800s.
        assert wall_s < BUDGET_S + POLL_S + 2.5, (
            f"poll ran {wall_s:.2f}s on a {BUDGET_S}s budget — the hard stop "
            f"regressed toward 2x budget (TEAM-4389)")
        assert wall_s < 2 * BUDGET_S, (
            f"poll ran {wall_s:.2f}s, i.e. to the old 2 * budget hard stop")

        error = result.get("error", "")
        match = re.search(r"gave up after (\d+)s", error)
        assert match, f"give-up error does not name the elapsed seconds: {error!r}"
        assert "budget bound" in error, (
            f"give-up error does not name WHICH bound fired: {error!r}")
        elapsed = int(match.group(1))
        assert elapsed >= BUDGET_S - 1, (
            f"reported elapsed {elapsed}s is below the {BUDGET_S}s budget it ran")
        assert elapsed < 2 * BUDGET_S, (
            f"reported elapsed {elapsed}s reaches 2 * budget — the poll loop is "
            f"still extending past one budget")

        assert result.get("no_retry_hint") is True, (
            "budget give-up must keep no_retry_hint: a blind re-run races a "
            "still-live runner in the same workspace")
        for advice in VERIFY_FIRST:
            assert advice in error, (
                f"verify-first advice {advice!r} missing from: {error!r}")

    def test_outer_deadline_bound_is_named(self):
        with self._wedged_runner():
            result = main._poll_coding_turn(mock.MagicMock(), "turn-y",
                                            outer_deadline=time.monotonic() - 1,
                                            budget_s=BUDGET_S, cli="claude")

        error = result.get("error", "")
        assert result.get("deadline_exceeded") is True, (
            f"outer-deadline exit must flag deadline_exceeded: {result!r}")
        assert "outer deadline bound" in error, (
            f"outer-deadline exit does not name its bound: {error!r}")
        assert re.search(r"\d+s elapsed", error), (
            f"outer-deadline exit does not carry an elapsed figure: {error!r}")
        for advice in VERIFY_FIRST:
            assert advice in error, (
                f"verify-first advice {advice!r} missing from: {error!r}")

        # The pre-submit guard has no turn clock and calls this bare — it must
        # not start claiming an elapsed time it does not know.
        bare = main._deadline_expired_error()["error"]
        assert "outer deadline bound" not in bare, (
            f"bare call annotated a bound it was not given: {bare!r}")
        assert "elapsed" not in bare, (
            f"bare call invented an elapsed figure: {bare!r}")


if __name__ == "__main__":
    unittest.main()
