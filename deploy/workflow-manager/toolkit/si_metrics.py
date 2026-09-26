#!/usr/bin/env python3
"""The ten deterministic self-improvement (SI) metrics — one pure function each.

TEAM-4760 U4. These are the numbers a self-improvement claim is judged on: "the
rewake gap we shipped a fix for in TEAM-47xx — is it actually gone?". `si_verify.py`
(a separate unit) composes a BEFORE window and an AFTER window out of exactly
these functions and compares them; this module never compares anything, it only
reads and counts.

ARITHMETIC ONLY. Every value here is read from data and divided. There is no LLM,
no heuristic, no estimate, no "probably zero". A metric that cannot be read
returns `value: None` together with a `reason` string that names what was missing
— never 0, never a guess. That rule is the entire reason this module exists: a
verdict of "fixed" built on an invented 0 is worse than no verdict, because it
closes the loop on a defect that is still there. `unavailable()` is therefore a
first-class result, and `insufficient` downstream is a legitimate outcome.

Every function is pure with respect to AWS: the ONLY code that touches AWS is
`DataSource`, which every metric takes as its first argument, so the unit tests
pass a `FakeSource` built from fixtures and never import boto3. boto3 is imported
lazily inside the DataSource methods that need it (the CI toolkit job installs no
boto3 and it imports this module).

──────────────────────────────────────────────────────────────────────────────
WHAT IS READABLE TODAY (PR #635 has NOT landed)
──────────────────────────────────────────────────────────────────────────────
`lambda/cost-report/index.mjs` on main is REPORT_VERSION 5 (kpiVersion 1). A v5
card's `quality` block carries exactly: outcome, tasks, tasksCompleted,
reworkRounds, changeRequests, fixTickets, gateRounds, gateReworks, loops, nudges,
interventions, errors (a NUMBER), retries, unblocks, firstPassYield, ci, score,
prUrl.

PR #635 (REPORT_VERSION 6 / kpiVersion 2) adds `quality.reinvocations.byKind`,
`quality.rewakes`, `quality.interventionsDetail`, and re-shapes `quality.errors`
into a BY-KIND OBJECT that includes `agent.retry` and `agent.died`.

So the true split — verified against the v5 `card.quality` block in
lambda/cost-report/index.mjs and the v5 card fixture in test_metrics.py — is
SEVEN readable today, THREE blocked on #635:

  readable on a v5 card today (7)
    rework_rounds_v2            card quality.reworkRounds   (v5 field)
    wm_interventions_per_run    card quality.interventions  (v5 field)
    missed_rewake_gaps          events table  — no card at all
    human_wait_out_of_hours_ms  analyses rows — no card at all
    cd_duplicate_executions     cd-ledger     — no card at all
    analysis_coverage           analyses + workflows tables — no card at all
    recommendation_recurrence   si-ledger + analyses — no card at all

  needs #635 (3)
    dead_sessions_per_run       quality.errors must be the by-kind OBJECT
    rewakes_per_run             quality.rewakes
    ci_recerts_per_run          quality.reinvocations.byKind.ci_recert

Each of those three reads the v6 field when present and otherwise returns
(None, reason) naming the field, the version it saw and the version it needs,
e.g. "quality.rewakes absent: card is reportVersion 5, needs 6 (PR #635)". The
detection is SHAPE-based, not version-number-based (`quality.errors` being a
dict is what makes it readable), so a card written by a Lambda between versions
still answers honestly; the version number only goes into the reason text.

A window may legitimately straddle #635 — some cards v5, some v6. Those metrics
then average only the runs that carry the field and report `runs` = that count,
which is exactly what lets si_verify say "insufficient" instead of comparing two
windows that measured different populations.

──────────────────────────────────────────────────────────────────────────────
UNITS (what `value` means, per metric)
──────────────────────────────────────────────────────────────────────────────
Seven of the ten are a MEAN PER CONTRIBUTING RUN, because that is the only shape
in which a 3-run window and a 30-run window can be compared:
  dead_sessions_per_run      mean dead/retried sessions per run
  missed_rewake_gaps         mean unblock→invoke gaps over 60 s per run
  rework_rounds_v2           mean rework rounds per run
  rewakes_per_run            mean rewakes per run
  ci_recerts_per_run         mean CI re-certifications per run
  human_wait_out_of_hours_ms mean out-of-hours human wait per run, in ms
  wm_interventions_per_run   mean Workflow-Manager interventions per run
  cd_duplicate_executions    mean EXTRA pipeline executions per merge commit,
                             per run that has a cd-ledger
And three are rates:
  analysis_coverage          completed runs with >=1 analysis / completed runs
                             (0..1, rolling 14 d)
  recommendation_recurrence  occurrences of one patternKey per 10 analyses

`runs` is always how many runs (or, for recommendation_recurrence, how many
analyses) actually contributed a number. It is not the window size, and a metric
with runs=1 is not a trend.

Run the tests:
  python3 -m pytest deploy/workflow-manager/toolkit/test_si_metrics.py -q
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

# Sibling modules in this same toolkit dir. Running as a script already puts that
# dir on sys.path; the explicit insert keeps the imports working when this module
# is imported by name (the unit tests do exactly that).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compute_metrics import ms_between, parse_ts  # noqa: E402
from events import dedupe_events  # noqa: E402

# ── The registry ─────────────────────────────────────────────────────────────
# EXACT names, EXACT order. Another unit pins this same list in a shared fixture,
# and METRIC_FUNCS below is asserted to have the same keys in the same order, so
# renaming or reordering anything here is a two-repo-place change, not a tidy-up.
METRIC_NAMES = [
    "dead_sessions_per_run",
    "missed_rewake_gaps",
    "rework_rounds_v2",
    "rewakes_per_run",
    "ci_recerts_per_run",
    "human_wait_out_of_hours_ms",
    "wm_interventions_per_run",
    "cd_duplicate_executions",
    "analysis_coverage",
    "recommendation_recurrence",
]

# ── Card versions ────────────────────────────────────────────────────────────
# These two name WHICH VERSION FIRST CARRIED A FIELD, not the accept-minimum
# (that is compute_metrics.CARD_MIN_REPORT_VERSION, 10 since TEAM-5186): the cost
# fields below have been on every card since v5 and `quality.rewakes` since v6,
# so a later repricing must NOT move them or the reasons below would lie.
CARD_V5 = 5                    # the cost/time/quality counters every card carries
CARD_V6 = 6                    # what PR #635 added (quality.rewakes)
V6_PR = "PR #635"

# ── Thresholds and windows (all arithmetic constants live here) ──────────────
# "A rewake the orchestrator never delivered" is a gap between the unblock and
# the invocation, and 60 s is the spec's threshold.
REWAKE_GAP_MS = 60_000
# The orchestrator publishes `orchestrator.agent_invoked` BEFORE
# `orchestrator.unblocked` for the SAME dispatch — the invoke goes out and the
# unblock row is written after it. Measured on the two real dossier fixtures the
# lead is 0.1 s to 2.8 s (yteqfl TEAM-4090: invoke 06:21:05.408, unblock
# 06:21:08.203). Without a tolerance every one of those same-dispatch pairs looks
# like "unblocked, never invoked" and the next dispatch's invoke gets paired with
# this unblock, manufacturing gaps of tens of minutes. 5 s covers the observed
# worst case with margin and is far below the 60 s threshold, so it can never
# hide a real gap.
DISPATCH_SKEW_MS = 5_000
# analysis_coverage is defined as a ROLLING 14 DAYS. When the caller gives no
# `since` this is the window that gets used, and the effective bounds are echoed
# back in the result so the reader can see exactly what was measured.
COVERAGE_WINDOW_DAYS = 14
# recommendation_recurrence is "occurrences per N analyses".
RECURRENCE_PER_ANALYSES = 10

UNBLOCKED_EVENT = "orchestrator.unblocked"
INVOKED_EVENT = "orchestrator.agent_invoked"

# Terminal phases — PARITY with TERMINAL_PHASES in lambda/cost-report/index.mjs
# (the set that decides which workflows get a card) and with RUN_OUTCOMES in
# save_analysis.py. A run closed as deploy-blocked or static-ci-only is a
# completed run: excluding it would flatter analysis_coverage exactly on the runs
# most worth analysing.
TERMINAL_PHASES = frozenset({"complete", "cancelled", "error", "deploy-blocked", "static-ci-only"})


# ── MetricValue ──────────────────────────────────────────────────────────────
# One return shape for all ten, with the invariant: `value is None` if and only if
# `reason` is set. Nothing else is allowed to encode "unknown" — in particular not
# a 0, not an empty string, not a missing key.
def ok(metric, value, runs, window):
    """A computed value. `runs` is how many runs contributed the number."""
    return {"metric": metric, "value": value, "runs": runs, "window": dict(window or {}), "reason": None}


def unavailable(metric, reason, window, runs=0):
    """No value, and WHY. The reason is the whole point: it is what a downstream
    `insufficient` verdict cites, so it names the field/table/key that was
    missing rather than saying "no data"."""
    return {"metric": metric, "value": None, "runs": runs, "window": dict(window or {}), "reason": reason}


# ── Data source (the ONLY AWS-touching code in this file) ────────────────────
class DataSource:
    """Every read the ten metrics need, and nothing else.

    The seam exists so the metrics stay pure: tests pass a fake implementing this
    same method surface (see test_si_metrics.FakeSource) and never touch AWS.
    boto3 is imported lazily inside the accessors below, so importing this module
    costs nothing and works in a boto3-less CI job.

    Method surface (other SI units build on exactly this):
      cards_for_def(def_id, *, since=None, until=None, limit=None) -> [card]
      events_for_workflow(workflow_id)                            -> [event row]
      cd_ledger(workflow_id)                                      -> dict | None
      analyses_since(since_iso, *, def_ids=None, until=None)      -> [analysis row]
      completed_runs_since(since_iso, *, def_ids=None, until=None)-> [workflow row]
      ledger_row(pattern_key)                                     -> dict | None
    """

    def __init__(self, *, bucket=None, region=None, index_key=None,
                 analyses_table=None, workflows_table=None, events_table=None,
                 ledger_table=None):
        # Env read HERE and nowhere else in this module, and every value is
        # overridable by argument so a caller (or a test of the real DataSource)
        # can pin names without touching os.environ. Nothing is read at import
        # time — this module must import in a container with no env at all.
        self.bucket = bucket or os.environ.get("ARTIFACT_BUCKET")
        self.region = region or os.environ.get("AWS_REGION", "us-east-1")
        self.index_key = index_key or os.environ.get("PERFORMANCE_INDEX_KEY", "performance/index.json")
        self.analyses_table = analyses_table or os.environ.get("ANALYSES_TABLE", "agentcore-hub-workflow-analyses")
        self.workflows_table = workflows_table or os.environ.get("WORKFLOWS_TABLE", "agentcore-hub-workflows")
        self.events_table = events_table or os.environ.get("EVENTS_TABLE", "agentcore-hub-events")
        self.ledger_table = ledger_table or os.environ.get("SI_LEDGER_TABLE", "agentcore-hub-si-ledger")
        self._s3c = None
        self._ddbr = None

    # ── clients (lazy) ──
    def _s3(self):
        if self._s3c is None:
            import boto3  # lazy: see the class docstring
            self._s3c = boto3.client("s3", region_name=self.region)
        return self._s3c

    def _table(self, name):
        if self._ddbr is None:
            import boto3  # lazy
            self._ddbr = boto3.resource("dynamodb", region_name=self.region)
        return self._ddbr.Table(name)

    def _require_bucket(self):
        if not self.bucket:
            raise RuntimeError("ARTIFACT_BUCKET is not set — cards and the cd-ledger live in S3")
        return self.bucket

    def _get_json(self, key):
        body = self._s3().get_object(Bucket=self._require_bucket(), Key=key)["Body"].read()
        return json.loads(body) if body else None

    # ── reads ──
    def cards_for_def(self, def_id, *, since=None, until=None, limit=None):
        """Performance cards for one workflow def, newest-first-capped, oldest
        first in the result.

        Two hops on purpose: `performance/index.json` (PERFORMANCE_INDEX_KEY, see
        lambda/cost-report/index.mjs:65) is the only cheap way to know WHICH runs
        exist and when they completed, but its per-card summary is lossy — it
        carries no quality.errors by-kind and no rewakes — so the numbers are read
        from each run's FULL card at
        workflows/<id>/shared/performance-card.json (cardKeyOf, index.mjs:1112).
        A run in the index whose card object is definitively GONE is skipped: it
        cannot contribute a number, and inventing one is the thing this module
        exists not to do. Any other read failure (AccessDenied, throttling) is
        re-raised rather than silently shrinking the window — a metric computed
        over "the runs we happened to be allowed to read" is not a metric.
        """
        try:
            index = self._get_json(self.index_key) or {}
        except Exception as e:  # noqa: BLE001 - re-raised below unless it is a definite 404
            if not _is_definite_404(e):
                raise
            # No index at all is a fact (no cards have ever been published), and
            # the caller turns an empty list into an `unavailable` naming the def.
            index = {}
        summaries = [c for c in (index.get("cards") or []) if c.get("workflowDefId") == def_id]
        summaries = [c for c in summaries if _within(c.get("completedAt"), since, until)]
        summaries.sort(key=lambda c: c.get("completedAt") or "")
        if limit:
            summaries = summaries[-int(limit):]
        cards = []
        for s in summaries:
            wid = s.get("workflowId")
            if not wid:
                continue
            try:
                card = self._get_json(f"workflows/{wid}/shared/performance-card.json")
            except Exception as e:  # noqa: BLE001 - re-raised below unless it is a definite 404
                if not _is_definite_404(e):
                    raise
                continue
            if card:
                cards.append(card)
        return cards

    def events_for_workflow(self, workflow_id):
        """Raw event rows keyed by the RUN (PK = workflowId).

        Only the run PK, deliberately: both event types this module reads
        (orchestrator.unblocked, orchestrator.agent_invoked) always carry
        detail.workflowId and therefore land on the run's own partition —
        confirmed against both real dossier fixtures. pull_dossier.py also sweeps
        the ticket and epic PKs because ticket-keyed rows like agent.started live
        there; none of the SI metrics read those, so this stays one Query per run.
        Rows come back RAW (both the direct write and the EventBridge fan-out
        copy); the caller dedupes with events.dedupe_events.
        """
        from boto3.dynamodb.conditions import Key  # lazy, see the class docstring
        table = self._table(self.events_table)
        out, kwargs = [], {"KeyConditionExpression": Key("workflowId").eq(workflow_id)}
        while True:
            page = table.query(**kwargs)
            out.extend(_undecimal(i) for i in page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                return out
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    def cd_ledger(self, workflow_id):
        """The run's CD ledger, or None when it is DEFINITELY not there.

        `workflows/<id>/shared/cd-ledger.json` is written by the release manager
        the moment a deploy is triggered (blueprints/release-manager.md), so its
        absence is a fact: this run never triggered a pipeline deploy. That is why
        only a 404/NoSuchKey becomes None and every other error is re-raised —
        an AccessDenied read must not be laundered into "no duplicate deploys",
        the same positive-evidence orientation lambda/workflow-output uses for its
        own ledger probe (DL-030).
        """
        try:
            return self._get_json(f"workflows/{workflow_id}/shared/cd-ledger.json")
        except Exception as e:  # noqa: BLE001 - re-raised below unless it is a definite 404
            if _is_definite_404(e):
                return None
            raise

    def analyses_since(self, since_iso, *, def_ids=None, until=None):
        """Analysis rows (ANALYSES_TABLE) analysed in [since, until].

        A Scan with a filter, not the workflowDefId-index Query: the metrics that
        read analyses want "every def in the window" as often as one def, the
        table holds one row per analysed run (thousands, not millions), and a
        Scan cannot silently miss a row whose defId was written differently.
        `def_ids` filters in the expression when given.
        """
        expr = ["analyzedAt >= :since"]
        values = {":since": since_iso}
        if until:
            expr.append("analyzedAt <= :until")
            values[":until"] = until
        return self._scan(self.analyses_table, " AND ".join(expr), values, def_ids)

    def completed_runs_since(self, since_iso, *, def_ids=None, until=None):
        """Terminal workflow rows (WORKFLOWS_TABLE) completed in [since, until].

        This is the RUN ENUMERATOR for the metrics that read no card at all
        (missed_rewake_gaps, cd_duplicate_executions) and the DENOMINATOR for
        analysis_coverage. `deleted` rows are dropped and only TERMINAL_PHASES
        count, matching scanTerminalWorkflows in lambda/cost-report/index.mjs.
        """
        expr = ["completedAt >= :since"]
        values = {":since": since_iso}
        if until:
            expr.append("completedAt <= :until")
            values[":until"] = until
        rows = self._scan(self.workflows_table, " AND ".join(expr), values, def_ids)
        return [r for r in rows if r.get("deleted") is not True and r.get("phase") in TERMINAL_PHASES]

    def ledger_row(self, pattern_key):
        """One SI-ledger row (SI_LEDGER_TABLE, PK patternKey), or None."""
        item = self._table(self.ledger_table).get_item(Key={"patternKey": pattern_key}).get("Item")
        return _undecimal(item) if item else None

    def _scan(self, table_name, filter_expr, values, def_ids):
        if def_ids:
            names = {f":d{i}": d for i, d in enumerate(def_ids)}
            filter_expr += " AND workflowDefId IN (" + ", ".join(names) + ")"
            values = {**values, **names}
        table = self._table(table_name)
        out, kwargs = [], {"FilterExpression": filter_expr, "ExpressionAttributeValues": values}
        while True:
            page = table.scan(**kwargs)
            out.extend(_undecimal(i) for i in page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                return out
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _is_definite_404(err):
    """Only a genuine "the object is not there" — never a permissions, throttling
    or network failure, which say nothing about whether the object exists.

    Reads the botocore error envelope without importing botocore (this module must
    import with no AWS libraries at all), so it works for `s3.exceptions.NoSuchKey`,
    a bare `ClientError` and a hand-rolled test double alike.
    """
    response = getattr(err, "response", None)
    if not isinstance(response, dict):
        response = {}
    code = (response.get("Error") or {}).get("Code")
    status = (response.get("ResponseMetadata") or {}).get("HTTPStatusCode")
    return (
        code in ("NoSuchKey", "NotFound", "404")
        or status == 404
        # NoSuchBucket is deliberately NOT here: a missing bucket is a
        # misconfiguration, not evidence that this run never deployed.
        or type(err).__name__ == "NoSuchKey"
    )


def _undecimal(obj):
    """DynamoDB Decimals → int/float. Same helper as pull_dossier.undecimal; a
    Decimal that reaches the arithmetic below would poison a mean with a
    TypeError against a float."""
    from decimal import Decimal
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    if isinstance(obj, dict):
        return {k: _undecimal(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_undecimal(v) for v in obj]
    return obj


# ── Window helpers ───────────────────────────────────────────────────────────
# A window is a plain dict. Which keys each metric CONSUMES:
#
#   metric                      defIds  since  until  runs  patternKey
#   dead_sessions_per_run       req     opt    opt    opt   -
#   missed_rewake_gaps          opt     REQ    opt    opt   -
#   rework_rounds_v2            req     opt    opt    opt   -
#   rewakes_per_run             req     opt    opt    opt   -
#   ci_recerts_per_run          req     opt    opt    opt   -
#   human_wait_out_of_hours_ms  opt     REQ    opt    -     -
#   wm_interventions_per_run    req     opt    opt    opt   -
#   cd_duplicate_executions     opt     REQ    opt    opt   -
#   analysis_coverage           opt     opt*   opt    -     -
#   recommendation_recurrence   opt     opt    opt    -     REQ
#
# req = the metric cannot be computed without it and returns `unavailable`
# naming the key. opt = narrows the window. `runs` caps to the most recent N runs.
# (*) analysis_coverage defaults `since` to `until` − COVERAGE_WINDOW_DAYS,
# because "rolling 14 d" is part of its definition rather than a caller choice;
# the effective bounds are echoed in the returned `window`.
def _need(metric, window, key, what):
    if not (window or {}).get(key):
        return unavailable(metric, f"window.{key} is required: {what}", window)
    return None


def _within(value, since, until):
    """Inclusive ISO-8601 bounds. Plain string compare is correct here — every
    timestamp in these tables is a Z-normalised ISO-8601 instant of identical
    width, which is exactly why the index sorts by localeCompare too."""
    if not value:
        return False
    if since and value < since:
        return False
    if until and value > until:
        return False
    return True


def _iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _mean(values, *, digits=4):
    # digits=0 returns an int, not a 4500000.0 — a fractional millisecond is noise
    # in a number that is hours wide, and the JSON should not suggest otherwise.
    mean = sum(values) / len(values)
    return round(mean) if digits == 0 else round(mean, digits)


def _cap(rows, key, limit):
    """The most recent `limit` rows by `key`, back in ascending order."""
    rows = sorted(rows, key=lambda r: r.get(key) or "")
    return rows[-int(limit):] if limit else rows


# ── Card readers ─────────────────────────────────────────────────────────────
# Each returns the run's number, or None when this card does not carry the field.
# Shape-based, never version-based: a card whose quality.errors is a dict can be
# read whatever its reportVersion says, and a card whose field is missing cannot
# be read even if it claims to be v6.
def _quality(card):
    return (card or {}).get("quality") or {}


def read_dead_sessions(card):
    """v6: `quality.errors` is a by-kind object; the dead/retried share is
    `agent.retry` + `agent.died`.

    Counted, not expressed as a fraction of all errors: the metric is named
    dead_sessions_PER_RUN, and a ratio would move when unrelated error kinds move
    — a run that fixes a validation error would "regress" its dead sessions. On a
    v5 card `quality.errors` is a single NUMBER (agent.error + error) with no way
    to split off agent.died, so this returns None there.
    """
    errors = _quality(card).get("errors")
    if not isinstance(errors, dict):
        return None
    return sum(_num(errors.get(k)) for k in ("agent.retry", "agent.died"))


def read_rework_rounds(card):
    """v5 field — readable today."""
    return _int_or_none(_quality(card).get("reworkRounds"))


def read_rewakes(card):
    """v6 field (`quality.rewakes`)."""
    return _int_or_none(_quality(card).get("rewakes"))


def read_ci_recerts(card):
    """v6 field (`quality.reinvocations.byKind.ci_recert`).

    A v6 card with a `reinvocations.byKind` object that has no `ci_recert` key is
    a REAL ZERO (the run re-certified nothing) — the absence of the whole
    `reinvocations` block is the unreadable case.
    """
    reinvocations = _quality(card).get("reinvocations")
    if not isinstance(reinvocations, dict):
        return None
    by_kind = reinvocations.get("byKind")
    if not isinstance(by_kind, dict):
        return None
    return _num(by_kind.get("ci_recert"))


def read_interventions(card):
    """v5 field — readable today."""
    return _int_or_none(_quality(card).get("interventions"))


def _num(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def _int_or_none(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


# ── Card-metric plumbing ─────────────────────────────────────────────────────
def _cards_in_window(metric, source, window):
    """(cards, failure) — every card in the window across window.defIds."""
    missing = _need(metric, window, "defIds",
                    "cards are indexed per workflow def, so there is nothing to enumerate without one")
    if missing:
        return None, missing
    cards = []
    for def_id in window["defIds"]:
        cards.extend(source.cards_for_def(
            def_id, since=window.get("since"), until=window.get("until"), limit=window.get("runs"),
        ))
    if not cards:
        return None, unavailable(
            metric,
            f"no performance cards for {list(window['defIds'])} in "
            f"[{window.get('since') or '-'}, {window.get('until') or 'now'}]",
            window,
        )
    return cards, None


def _card_metric(metric, source, window, reader, field, *, needs_v6):
    """The shared body of the five card metrics: read `field` off every card in
    the window, mean the runs that carried it, and when NONE did, say so in the
    terms the reader needs — for a v6-only field, which version the cards
    actually are and which PR adds it."""
    cards, failure = _cards_in_window(metric, source, window)
    if failure:
        return failure
    values, versions = [], set()
    for card in cards:
        versions.add(card.get("reportVersion"))
        value = reader(card)
        if value is not None:
            values.append(value)
    if not values:
        seen = max((v for v in versions if isinstance(v, int)), default=None)
        if needs_v6:
            seen_text = f"card is reportVersion {seen}" if seen is not None else "card carries no reportVersion"
            reason = f"{field} absent: {seen_text}, needs {CARD_V6} ({V6_PR})"
            if len(cards) > 1:
                reason += f" — none of the {len(cards)} cards in this window carry it"
        else:
            reason = (f"{field} absent on all {len(cards)} card(s) in this window "
                      f"(reportVersion {sorted(str(v) for v in versions)}) — a v{CARD_V5} card should "
                      f"carry it, so these cards are malformed or older than v{CARD_V5}")
        return unavailable(metric, reason, window)
    return ok(metric, _mean(values), len(values), window)


# ── Run-enumerator plumbing (the metrics that read no card) ──────────────────
def _runs_in_window(metric, source, window, *, why_since):
    """(workflow rows, failure) — terminal runs in the window, capped to
    window.runs. Uses the workflows table rather than the card index so a metric
    that needs no card cannot be blocked by a missing one."""
    missing = _need(metric, window, "since", why_since)
    if missing:
        return None, missing
    runs = source.completed_runs_since(
        window["since"], def_ids=window.get("defIds"), until=window.get("until"),
    )
    if not runs:
        return None, unavailable(
            metric,
            f"no completed runs in [{window['since']}, {window.get('until') or 'now'}]"
            + (f" for {list(window['defIds'])}" if window.get("defIds") else ""),
            window,
        )
    return _cap(runs, "completedAt", window.get("runs")), None


# ═════════════════════════════════════════════════════════════════════════════
# The ten metrics
# ═════════════════════════════════════════════════════════════════════════════
def dead_sessions_per_run(source, window):
    """Mean sessions per run that died or had to be retried (card v6).

    `quality.errors` by-kind, `agent.retry` + `agent.died`. Blocked on #635: a v5
    card's `quality.errors` is one number and its `quality.retries` counts only
    retries, so there is no arithmetic that recovers the died half — and guessing
    it from `retries` alone would report a fall in dead sessions every time a
    retry succeeded.
    """
    return _card_metric(source=source, window=window, metric="dead_sessions_per_run",
                        reader=read_dead_sessions, field="quality.errors (by-kind)", needs_v6=True)


def missed_rewake_gaps(source, window):
    """Mean unblock→invoke gaps longer than 60 s, per run (events table).

    Reads no card. For each `orchestrator.unblocked{ticketId}` the matching
    `orchestrator.agent_invoked` for that same ticket is the next one in time,
    matched GREEDILY (two pointers per ticket) so one invocation can only ever
    settle one unblock — reusing an invocation would report the same delay twice
    for a ticket that was unblocked, invoked, reworked and unblocked again.

    Two decisions the shape of the real data forces, both of which suppress false
    positives rather than real gaps:
      * An invocation may PRECEDE its unblock by up to DISPATCH_SKEW_MS — the
        orchestrator dispatches first and writes the unblock row after (see that
        constant). Such a pair is a gap of 0, not a miss.
      * An unblock with NO later invocation for that ticket is NOT counted. On the
        real runs those are human gates (yteqfl TEAM-4067, a merge approval
        assigned to `human:engineer`) and terminal unblocks, which no agent is
        supposed to wake for. Counting them would make every human-gated run look
        like the orchestrator had dropped a rewake, and the ticket's assignee —
        the only field that separates the two cases — is not in this seam.

    A run with no `orchestrator.unblocked` rows at all does not contribute: it has
    no denominator, and treating "no unblocks found" as a clean zero would let a
    run whose events expired flatter the window.
    """
    metric = "missed_rewake_gaps"
    runs, failure = _runs_in_window(
        metric, source, window,
        why_since="gaps are counted per run and the runs are enumerated from the workflows table",
    )
    if failure:
        return failure
    counts = []
    for run in runs:
        events = dedupe_events(source.events_for_workflow(run.get("workflowId")))
        count = count_rewake_gaps(events)
        if count is not None:
            counts.append(count)
    if not counts:
        return unavailable(
            metric,
            f"none of the {len(runs)} runs in this window has an {UNBLOCKED_EVENT} event — "
            "no run cascaded a dependent, or the event rows are gone",
            window,
        )
    return ok(metric, _mean(counts), len(counts), window)


def count_rewake_gaps(events):
    """Gaps over REWAKE_GAP_MS in one run's DEDUPED events, or None when the run
    has no unblocks to measure. Pure — the unit tests call it directly."""
    unblocks, invokes = {}, {}
    for event in events or []:
        detail = event.get("detail") or {}
        ticket = detail.get("ticketId")
        if not ticket:
            continue
        # detail.timestamp is the publisher's own clock (the row timestamp of the
        # EventBridge copy is second-granularity on older runs — see events.py),
        # so prefer it and fall back to the row's.
        at = parse_ts(detail.get("timestamp") or event.get("timestamp"))
        if at is None:
            continue
        if event.get("type") == UNBLOCKED_EVENT:
            unblocks.setdefault(ticket, []).append(at)
        elif event.get("type") == INVOKED_EVENT:
            invokes.setdefault(ticket, []).append(at)
    if not unblocks:
        return None
    gaps = 0
    for ticket, times in unblocks.items():
        candidates = sorted(invokes.get(ticket, []))
        cursor = 0
        for unblocked_at in sorted(times):
            # Skip invocations that precede this unblock by more than the
            # dispatch skew: they belong to an earlier dispatch of this ticket.
            # ms_between clamps at 0, so lead > 0 means "invoke came first".
            while cursor < len(candidates) and ms_between(candidates[cursor], unblocked_at) > DISPATCH_SKEW_MS:
                cursor += 1
            if cursor >= len(candidates):
                break  # nothing left for this ticket — see the docstring
            if ms_between(unblocked_at, candidates[cursor]) > REWAKE_GAP_MS:
                gaps += 1
            cursor += 1
    return gaps


def rework_rounds_v2(source, window):
    """Mean `quality.reworkRounds` per run (card, v5 field — readable today)."""
    return _card_metric(source=source, window=window, metric="rework_rounds_v2",
                        reader=read_rework_rounds, field="quality.reworkRounds", needs_v6=False)


def rewakes_per_run(source, window):
    """Mean `quality.rewakes` per run (card v6). Blocked on #635 — a v5 card
    counts `unblocks`, which is every cascade, not the re-wakes among them."""
    return _card_metric(source=source, window=window, metric="rewakes_per_run",
                        reader=read_rewakes, field="quality.rewakes", needs_v6=True)


def ci_recerts_per_run(source, window):
    """Mean `quality.reinvocations.byKind.ci_recert` per run (card v6). Blocked on
    #635 — a v5 card has no reinvocation kinds at all, only a total rework count
    in which a CI re-certification is indistinguishable from a code fix."""
    return _card_metric(source=source, window=window, metric="ci_recerts_per_run",
                        reader=read_ci_recerts, field="quality.reinvocations.byKind.ci_recert", needs_v6=True)


def human_wait_out_of_hours_ms(source, window):
    """Mean out-of-hours human wait per run, in ms (analyses rows).

    REUSED, never re-derived: `humanWaitOutsideHoursMs` is computed by
    compute_metrics.py (see compute_metrics.py:887, summed from the per-review
    inHours/outsideHours split that split_wait_by_window produces) and persisted
    verbatim in the analyses row's `metrics` block by save_analysis.build_item.
    Recomputing it here would need the reviewer's business window and a second
    implementation of the DST-safe interval split — two answers for one number is
    exactly what the card-first rule forbids.

    A run analysed more than once contributes its LATEST analysis only (analyses
    are re-runnable and the newest is the one the WM stands behind). A row whose
    metrics predate TEAM-4453 has no such key and is skipped rather than read as
    0, since "the split was never computed" and "the reviewer was never woken at
    night" are opposite facts.
    """
    metric = "human_wait_out_of_hours_ms"
    missing = _need(metric, window, "since", "analyses are selected by analyzedAt")
    if missing:
        return missing
    rows = source.analyses_since(window["since"], def_ids=window.get("defIds"), until=window.get("until"))
    if not rows:
        return unavailable(
            metric, f"no analyses in [{window['since']}, {window.get('until') or 'now'}]", window,
        )
    latest = {}
    for row in rows:
        wid = row.get("workflowId")
        if not wid:
            continue
        current = latest.get(wid)
        if current is None or (row.get("analyzedAt") or "") >= (current.get("analyzedAt") or ""):
            latest[wid] = row
    waits = []
    for row in latest.values():
        value = (row.get("metrics") or {}).get("humanWaitOutsideHoursMs")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            waits.append(value)
    if not waits:
        return unavailable(
            metric,
            f"metrics.humanWaitOutsideHoursMs absent on all {len(latest)} analysed run(s) in this "
            "window — those analyses predate the in/out-of-hours wait split (TEAM-4453 D3)",
            window,
        )
    # Rounded to whole milliseconds: a fractional millisecond is noise in a
    # number that is hours wide.
    return ok(metric, _mean(waits, digits=0), len(waits), window)


def wm_interventions_per_run(source, window):
    """Mean `quality.interventions` per run (card, v5 field — readable today).
    The card counts `manager.intervention` events, i.e. the times the Workflow
    Manager had to reach into a run."""
    return _card_metric(source=source, window=window, metric="wm_interventions_per_run",
                        reader=read_interventions, field="quality.interventions", needs_v6=False)


def cd_duplicate_executions(source, window):
    """Mean EXTRA pipeline executions per merge commit, per run with a ledger.

    `workflows/<id>/shared/cd-ledger.json` is the deploy record. A merge commit
    with two execution ids is a double-deploy — the failure the ledger exists to
    prevent (a session that dies between `Pipeline___start_deploy` and the ledger
    write, then re-dispatches and triggers again).

    What counts as "the executions of this run": every execution id the ledger
    RECORDS, read from whichever shape it is in — an `executions` list, or the
    single `{pipeline, executionId, mergeCommit, ...}` object today's release
    manager writes, plus any superseded predecessors it kept
    (`priorExecutionIds` / `supersededBy` / `history`). Ids are de-duplicated
    before counting, so one execution recorded twice is not a double-deploy.

    LIMIT, stated plainly: a single-object ledger that was OVERWRITTEN in place
    can only ever show one execution, so this metric proves "the ledger records
    no duplicate", not "no duplicate ever ran". That is still the honest number
    available from the ledger, and it is exactly the number a before/after
    comparison of ledger hygiene needs. Runs with no ledger (nothing was
    deployed) do not contribute; a run whose ledger records no execution id at all
    does not contribute either.
    """
    metric = "cd_duplicate_executions"
    runs, failure = _runs_in_window(
        metric, source, window,
        why_since="a ledger is read per run and the runs are enumerated from the workflows table",
    )
    if failure:
        return failure
    counts, ledgers = [], 0
    for run in runs:
        ledger = source.cd_ledger(run.get("workflowId"))
        if not ledger:
            continue
        ledgers += 1
        extra = count_duplicate_executions(ledger)
        if extra is not None:
            counts.append(extra)
    if not counts:
        return unavailable(
            metric,
            f"no cd-ledger with a recorded execution id among the {len(runs)} runs in this window "
            f"({ledgers} ledger(s) found) — no run here deployed through a pipeline",
            window,
        )
    return ok(metric, _mean(counts), len(counts), window)


def count_duplicate_executions(ledger):
    """Extra executions beyond the first, summed over merge commits, or None when
    the ledger records no execution id. Pure — the unit tests call it directly."""
    entries = []
    listed = ledger.get("executions")
    if isinstance(listed, list):
        for item in listed:
            if isinstance(item, dict):
                entries.append((item.get("mergeCommit") or ledger.get("mergeCommit"), item.get("executionId")))
            elif item:
                entries.append((ledger.get("mergeCommit"), item))
    else:
        entries.append((ledger.get("mergeCommit"), ledger.get("executionId")))
        # Superseded predecessors, whatever the writer called them. They belong to
        # the same merge commit by construction: a superseded execution is a
        # re-trigger of the same commit.
        for key in ("priorExecutionIds", "supersededBy", "history"):
            extra = ledger.get(key)
            if isinstance(extra, str):
                entries.append((ledger.get("mergeCommit"), extra))
            elif isinstance(extra, list):
                for item in extra:
                    if isinstance(item, dict):
                        entries.append((item.get("mergeCommit") or ledger.get("mergeCommit"), item.get("executionId")))
                    elif item:
                        entries.append((ledger.get("mergeCommit"), item))
    by_commit = {}
    for commit, execution_id in entries:
        if not execution_id or not commit:
            continue  # an entry we cannot attribute is not evidence of anything
        by_commit.setdefault(commit, set()).add(execution_id)
    if not by_commit:
        return None
    return sum(max(0, len(ids) - 1) for ids in by_commit.values())


def analysis_coverage(source, window):
    """Completed runs that have at least one analysis / completed runs (0..1),
    rolling COVERAGE_WINDOW_DAYS by default.

    The numerator counts RUNS COVERED, not analyses: a run analysed three times is
    covered once, so the ratio cannot exceed 1 and a re-analysis spree cannot
    report 150% coverage. Analyses of runs that are not in the window's completed
    set (an older run analysed late) are ignored for the same reason — they are
    not coverage of this window.

    The denominator is the honest one: every terminal run, including cancelled /
    error / deploy-blocked, because an unanalysed failure is precisely the gap
    this metric is supposed to expose. With no completed runs there is no
    denominator and the answer is `unavailable`, never 1.0 and never 0.
    """
    metric = "analysis_coverage"
    until = (window or {}).get("until")
    since = (window or {}).get("since")
    if not since:
        end = parse_ts(until) or datetime.now(timezone.utc)
        since = _iso(end - timedelta(days=COVERAGE_WINDOW_DAYS))
    effective = {**(window or {}), "since": since, **({"until": until} if until else {})}
    runs = source.completed_runs_since(since, def_ids=effective.get("defIds"), until=until)
    if not runs:
        return unavailable(
            metric,
            f"no completed runs in [{since}, {until or 'now'}] — coverage has no denominator",
            effective,
        )
    analysed = {
        row.get("workflowId")
        for row in source.analyses_since(since, def_ids=effective.get("defIds"), until=until)
        if row.get("workflowId")
    }
    run_ids = {r.get("workflowId") for r in runs if r.get("workflowId")}
    return ok(metric, round(len(analysed & run_ids) / len(run_ids), 4), len(run_ids), effective)


def recommendation_recurrence(source, window):
    """Occurrences of ONE pattern per RECURRENCE_PER_ANALYSES analyses (si-ledger).

    "The same recommendation keeps coming back" is only meaningful against how
    much analysing happened, so the rate is occurrences ÷ analyses × 10. `runs`
    here is the number of ANALYSES examined (the denominator), not runs — the one
    metric where that is the right population.

    The ledger row's `occurrences` may be a list of dated occurrences or a bare
    count. A bare count cannot be restricted to a window, so asking for a windowed
    rate from one returns `unavailable` rather than silently answering with the
    all-time count over a 14-day denominator — that arithmetic would look like a
    catastrophic regression. Same for a dated list with an undated entry.
    """
    metric = "recommendation_recurrence"
    missing = _need(metric, window, "patternKey", "recurrence is per pattern, and the si-ledger is keyed by patternKey")
    if missing:
        return missing
    pattern_key = window["patternKey"]
    row = source.ledger_row(pattern_key)
    if not row:
        return unavailable(metric, f"no si-ledger row for patternKey {pattern_key!r}", window)
    since, until = window.get("since"), window.get("until")
    occurrences = row.get("occurrences")
    if isinstance(occurrences, list):
        count = 0
        for item in occurrences:
            # An occurrence may be a dict (the shape the ledger writes) or a bare
            # string id from an older row; only the dict form carries a date.
            at = None
            if isinstance(item, dict):
                at = item.get("at") or item.get("analyzedAt") or item.get("observedAt")
            if not at:
                if since or until:
                    return unavailable(
                        metric,
                        f"si-ledger row {pattern_key!r} has an occurrence with no timestamp — it cannot be "
                        "placed inside or outside the window",
                        window,
                    )
                count += 1
                continue
            if _within(at, since, until):
                count += 1
    elif isinstance(occurrences, (int, float)) and not isinstance(occurrences, bool):
        if since or until:
            return unavailable(
                metric,
                f"si-ledger row {pattern_key!r} carries a scalar occurrence count, not dated "
                "occurrences — it cannot be restricted to this window",
                window,
            )
        count = occurrences
    else:
        return unavailable(metric, f"si-ledger row {pattern_key!r} has no readable `occurrences`", window)
    analyses = source.analyses_since(
        since or _iso(datetime.now(timezone.utc) - timedelta(days=COVERAGE_WINDOW_DAYS)),
        def_ids=window.get("defIds"), until=until,
    )
    if not analyses:
        return unavailable(
            metric,
            f"no analyses in [{since or 'rolling ' + str(COVERAGE_WINDOW_DAYS) + 'd'}, {until or 'now'}] — "
            "a recurrence rate has no denominator",
            window,
        )
    return ok(metric, round(count / len(analyses) * RECURRENCE_PER_ANALYSES, 4), len(analyses), window)


# ── Dispatch ─────────────────────────────────────────────────────────────────
# Same keys, same ORDER as METRIC_NAMES (pinned by a unit test).
METRIC_FUNCS = {
    "dead_sessions_per_run": dead_sessions_per_run,
    "missed_rewake_gaps": missed_rewake_gaps,
    "rework_rounds_v2": rework_rounds_v2,
    "rewakes_per_run": rewakes_per_run,
    "ci_recerts_per_run": ci_recerts_per_run,
    "human_wait_out_of_hours_ms": human_wait_out_of_hours_ms,
    "wm_interventions_per_run": wm_interventions_per_run,
    "cd_duplicate_executions": cd_duplicate_executions,
    "analysis_coverage": analysis_coverage,
    "recommendation_recurrence": recommendation_recurrence,
}


def compute(name, source, window):
    """One metric by name. An unknown name RAISES: a typo'd metric is a caller
    bug, and returning `unavailable` for it would let a verdict quietly rest on a
    metric that was never computed."""
    if name not in METRIC_FUNCS:
        raise ValueError(f"unknown metric {name!r} — known: {', '.join(METRIC_NAMES)}")
    return METRIC_FUNCS[name](source, window)


def compute_all(source, window):
    """All ten, in METRIC_NAMES order. Each one's own `unavailable` is a result,
    not an error, so a partly-readable window still reports what it can."""
    return [compute(name, source, window) for name in METRIC_NAMES]


def main():
    parser = argparse.ArgumentParser(description="Compute the deterministic SI metrics.")
    parser.add_argument("metric", nargs="?", help=f"one of: {', '.join(METRIC_NAMES)} (default: all)")
    parser.add_argument("--def-id", action="append", dest="def_ids", default=[])
    parser.add_argument("--since")
    parser.add_argument("--until")
    parser.add_argument("--runs", type=int)
    parser.add_argument("--pattern-key")
    args = parser.parse_args()
    window = {k: v for k, v in {
        "defIds": args.def_ids or None, "since": args.since, "until": args.until,
        "runs": args.runs, "patternKey": args.pattern_key,
    }.items() if v}
    source = DataSource()
    result = compute(args.metric, source, window) if args.metric else compute_all(source, window)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
