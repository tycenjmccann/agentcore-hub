#!/usr/bin/env python3
"""Terminal run outcomes — the ONE Python source of truth (TEAM-4247 D2).

"Which phases mean a run is finished, and which of those mean it did no delivery
work" is asserted in TypeScript, mirrored in four hand-written .mjs literals, and
was mirrored a second time inside this toolkit: save_analysis.py owned the accept
set, compute_metrics.py had no notion of terminality at all, and pull_dossier.py
built the trend baseline without asking what those prior runs were. Three readers,
one question, so this module holds the answer and they import it.

Deliberately DEPENDENCY-FREE — no boto3, no os.environ, no sibling imports.
save_analysis.py and pull_dossier.py read AWS config at module load; compute_metrics.py
and its unit tests must stay importable with neither, so the shared constants
cannot live in either of the first two.

PARITY: src/lib/workflow/types.ts TERMINAL_PHASES / SHIP_BLOCKED_OUTCOMES /
NO_OP_OUTCOMES, and lambda/orchestrator/completion.mjs.
src/lib/workflow/run-outcome-parity.test.ts reads the literals below as text and
fails if this file drifts from types.ts.
"""

# TEAM-3747 D2 added the ship-blocked pair so a run closed as deploy-blocked /
# static-ci-only is recorded HONESTLY instead of masquerading as "complete".
# TEAM-4247 D2 adds "nothing-to-remove" on the same terms: a dead-code sweep that
# verified its candidates and found none removable really did finish.
RUN_OUTCOMES = {"complete", "cancelled", "error", "deploy-blocked", "static-ci-only", "nothing-to-remove"}

# Terminal, but no delivery work happened: no branch, no PR, nothing for a
# reviewer/QA/CI gate to act on. Such a run is worth READING (it is why the sweep
# cost what it cost) and worthless as a COMPARABLE — one detection agent and a few
# cents next to a full sweep drags every median down and then makes the next real
# run look like the anomaly.
#
# NOT the same list as the ship-blocked outcomes: a deploy-blocked run did the
# work and then failed to ship, so it stays in the baseline.
NO_OP_OUTCOMES = ("nothing-to-remove",)


def is_terminal_phase(phase):
    """Is this workflow phase a finished run? Unknown/absent → False."""
    return phase in RUN_OUTCOMES


def is_no_op_outcome(outcome):
    """Did this run end without doing any delivery work?"""
    return outcome in NO_OP_OUTCOMES


def baseline_analyses(analyses):
    """The prior analyses that may be compared against — no-op runs removed.

    Used for the trend baseline the Workflow Manager cites. Order is preserved,
    and a non-dict / outcome-less entry is KEPT: the caller's own data (an older
    analysis written before runOutcome existed) must not be silently dropped by a
    filter whose job is to remove one named outcome.
    """
    return [
        a for a in (analyses or [])
        if not (isinstance(a, dict) and is_no_op_outcome(a.get("runOutcome")))
    ]
