#!/usr/bin/env python3
"""SI recommendation ledger — the Python twin of lambda/workflow-analyzer/si-ledger.mjs.

WHY THIS EXISTS AT ALL. The self-improvement loop reads a finished run, writes
recommendations into an analysis row, synthesises a PRD and re-enters the
pipeline — and until now it remembered nothing across runs. The same finding
could be recommended by three consecutive analyses, batched into three PRDs, and
because nobody ever went back to ask whether the first PRD moved the number, the
loop could not tell "not fixed yet" from "fixed, and the metric still looks like
that". The ledger is the one place that memory lives: one row per PATTERN (not
per run, not per analysis) in DynamoDB table agentcore-hub-si-ledger, PK
`patternKey` = `<area>.<slug>`, carrying every occurrence, every attempt to fix
it, the numbers a fix was expected to move, and the verdicts that judged it.

WHY THERE ARE TWO OF IT. The writers live in runtimes that cannot share code: the
workflow-analyzer and prd-submitter Lambdas (JS, and si-ledger.mjs is itself
byte-copied between those two because each Lambda ships as a zip built from its
own directory) and the Workflow Manager harness toolkit (this file — the
run-analysis, si-synthesis and si-verify skills call it, and the CLI at the bottom
is what those skills actually run). Same rows, same semantics, different
language, so the two halves are pinned by ONE fixture:
fixtures/si-ledger-contract.json. test_si_ledger.py and
lambda/workflow-analyzer/si-ledger.test.mjs iterate its `transitions` array and
assert the same expectations, so a change on either side fails on the other —
exactly how fix-lineage.json keeps the fix-ticket predicate identical in
compute_metrics.py and lambda/cost-report.

The canonical JS file is lambda/workflow-analyzer/si-ledger.mjs. Read its header
for the packaging constraint behind the byte copy; read this one for what the
Python side does differently and why:

  * Function names are snake_case, but ROW AND PAYLOAD KEYS STAY camelCase
    (workflowId, prdKey, observeRuns …) — they are DynamoDB attribute names
    shared with the JS writers and the UI, not Python identifiers.
  * Errors are ValueError (the JS side throws Error); the message text is kept
    identical so a fixture case can pin a substring in both languages.
  * delete() exists only here. Pruning a row is an operator action taken through
    this CLI, so the Lambdas never need dynamodb:DeleteItem at all.
  * boto3 is imported LAZILY, inside the one place that needs a real table, for
    the same reason compute_metrics.request_card does it: the CI toolkit job
    installs no boto3 and the tests import this module.

The reducers are PURE — they take a row and return a NEW row, never mutating the
input — so the fixture can drive them with no AWS in the room and a caller can
reduce twice before writing once.

Row schema (CLOSED — nothing outside these fields is ever written):

  { patternKey: "harness.silent-death.exit-without-report",   # <area>.<slug>
    title:      "one line a human recognises",
    status:     "open|batched|in-run|landed|deployed|verified|no-effect|regressed|wont-fix",
    firstSeen:  iso, lastSeen: iso,
    occurrences: [{ workflowId, analysisId, workflowDefId, severity, at }],
    attempts:    [{ prdKey, workflowId, epicId, prNumbers: [], mergedAt, deployedAt,
                    outcome: "in-run|landed|deployed|cancelled|error|handoff", note }],
    expected:    [{ metric, baseline: { value, runs, window }, target, observeRuns, setAt, prdKey }],
    verdicts:    [{ at, prdKey, verdict: "verified|no-effect|regressed|insufficient",
                    before, after, note }],
    source?:     "backfill" }            # optional provenance, e.g. a backfill

CLI (what the skills run):
  python3 si_ledger.py keys [--def software-delivery]   # patternKey<TAB>status<TAB>title
  python3 si_ledger.py render --def software-delivery   # the knowledge-file markdown table
  python3 si_ledger.py get <patternKey>                 # one row as JSON
  python3 si_ledger.py upsert --key K --title T --workflow WF --analysis AN [--def D] [--severity S] [--at ISO]
  python3 si_ledger.py delete <patternKey>
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
from datetime import datetime, timezone
from decimal import Decimal

SI_LEDGER_TABLE_DEFAULT = "agentcore-hub-si-ledger"

# The lifecycle of an ask. open → batched (a PRD is being written) → in-run (a
# pipeline run carries it) → landed (merged) → deployed → verified (a verdict says
# the number moved). no-effect / regressed are verdict-driven dead ends that go
# back to open (see apply_verdict), and wont-fix is the human's off-switch —
# only an operator sets it, nothing here transitions INTO it.
STATUSES = (
    "open", "batched", "in-run", "landed", "deployed",
    "verified", "no-effect", "regressed", "wont-fix",
)

# How an attempt ended. handoff = the PR was opened for another team to merge.
ATTEMPT_OUTCOMES = ("in-run", "landed", "deployed", "cancelled", "error", "handoff")

VERDICT_VALUES = ("verified", "no-effect", "regressed", "insufficient")

# The metrics a recommendation is allowed to promise to move. A closed list on
# purpose: "expected impact" as free prose is what made the old loop
# unfalsifiable — every PRD claimed an improvement and none named a number anyone
# could measure afterwards. Every name here is something the toolkit already
# computes per run, so si_verify can read a before/after without inventing a
# measurement. ORDER IS PART OF THE CONTRACT: the fixture's metricNames array is
# compared element-wise, in both languages, and scripts/check-si-ledger-parity.sh
# pins the JS literal to the same list.
METRIC_NAMES = (
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
)

# How many terminal runs an expectation waits for before a verdict is fair.
DEFAULT_OBSERVE_RUNS = 5

# How long a landed/deployed attempt suppresses a re-file (dedupe_blocked).
DEFAULT_FRESH_DAYS = 14

_KEY_RE = re.compile(r"[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+")
KEY_MAX = 120
DAY_MS = 86400000
_HISTORY_FIELDS = ("occurrences", "attempts", "expected", "verdicts")


# ── small helpers ────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _ms(iso) -> int:
    """ISO-8601 → epoch milliseconds. Raises rather than returning a sentinel:
    every timestamp here either orders a row's history or decides whether an ask
    is fresh, and a silently unparsed one would quietly answer "not fresh, file
    it again". Deliberately NOT compute_metrics.parse_ts — that one is tolerant of
    shapes by design, and this module's whole job is to agree with Date.parse on
    the JS side to the millisecond."""
    raw = "" if iso is None else str(iso)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"si-ledger: not an ISO-8601 timestamp: {json.dumps(raw)}") from None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def _max_iso(a, b):
    if not a:
        return b
    if not b:
        return a
    return b if _ms(b) > _ms(a) else a


def _min_iso(a, b):
    if not a:
        return b
    if not b:
        return a
    return b if _ms(b) < _ms(a) else a


def _text(value):
    return None if value is None else str(value)


def _pr_list(values):
    """Sorted, unique, numeric PR list. Attempts are stamped more than once (a run
    opens a PR, then merges it), and a number that arrives as the string "1234"
    from a tool payload must not become a second, different PR."""
    out = set()
    for v in values or []:
        try:
            n = float(v)
        except (TypeError, ValueError):
            continue
        out.add(int(n) if float(n).is_integer() else n)
    return sorted(out)


def _clone_row(row):
    """Deep copy so every reducer returns a new row without touching its input."""
    if not isinstance(row, dict):
        raise ValueError("si-ledger: reducer needs a ledger row")
    nxt = copy.deepcopy(row)
    for field in _HISTORY_FIELDS:
        if not isinstance(nxt.get(field), list):
            nxt[field] = []
    return nxt


# ── keys ─────────────────────────────────────────────────────────────────────

def is_valid_key(value) -> bool:
    """Is this exactly a stable pattern key? `<area>.<slug>` with at least two
    dot-separated segments, each starting alphanumeric, lower-case, hyphens
    inside. The two-segment floor is the whole point: `silent-death` alone is not
    a key anyone can reuse, `harness.silent-death` is — the area is what makes two
    analyses of different runs land on the SAME row instead of a near duplicate."""
    s = "" if value is None else str(value)
    return 0 < len(s) <= KEY_MAX and _KEY_RE.fullmatch(s) is not None


def normalize_key(raw) -> str:
    """Coerce an agent-authored string into a valid key, or raise.

    Agents mint keys from prose ("Harness silent death: exit without report"), so
    normalisation is the difference between one row and five. Lower-case,
    everything outside [a-z0-9._-] becomes a hyphen, repeated hyphens and dots
    collapse, and each dot-separated segment loses leading/trailing hyphens. What
    survives must still satisfy is_valid_key — a single-segment key is NOT
    silently expanded, because guessing an area is worse than making the caller
    name one. Note `_` survives that charset and is then REJECTED: a pattern key
    is hyphen-separated, and folding `_` to `-` would make a_b and a-b the same
    key for a writer and different keys for the human reading the table."""
    lowered = re.sub(r"[^a-z0-9._-]+", "-", ("" if raw is None else str(raw)).lower())
    segments = [
        re.sub(r"-{2,}", "-", seg).strip("-")
        for seg in lowered.split(".")
    ]
    key = ".".join(seg for seg in segments if seg)
    if not is_valid_key(key):
        raise ValueError(
            f"si-ledger: invalid patternKey {json.dumps('' if raw is None else str(raw))} "
            f"(normalised to {json.dumps(key)}) — needs at least two dot-separated segments "
            f"<area>.<slug>, lower-case, <={KEY_MAX} chars"
        )
    return key


# ── row construction + pure reducers ─────────────────────────────────────────

def new_row(pattern_key=None, title=None, at=None, source=None) -> dict:
    """A brand-new ledger row: open, both timestamps at `at`, all four histories
    empty. `source` is written only when given (e.g. "backfill" for rows minted
    from analyses that predate the ledger) so a normal row carries no extra
    field."""
    when = at or _now_iso()
    _ms(when)
    row = {
        "patternKey": normalize_key(pattern_key),
        "title": ("" if title is None else str(title)).strip(),
        "status": "open",
        "firstSeen": when,
        "lastSeen": when,
        "occurrences": [],
        "attempts": [],
        "expected": [],
        "verdicts": [],
    }
    if source:
        row["source"] = str(source)
    return row


def apply_occurrence(row, occ=None) -> dict:
    """Record that this pattern showed up in a run's analysis.

    Deduped on workflowId + analysisId: re-running ANALYZE over the same run
    re-files the same findings, and a double-counted occurrence would inflate
    `recommendation_recurrence` — the very metric the loop uses to decide a
    pattern is chronic. A duplicate still bumps lastSeen (we DID just look at it),
    and the first-recorded severity/defId are kept rather than overwritten.

    Status is deliberately NOT touched. An occurrence on a `verified` row is
    evidence of a REGRESSION, which only si_verify may rule on (with before/after
    numbers); auto-reopening here would erase the verified verdict on the strength
    of one analysis's prose."""
    occ = occ or {}
    nxt = _clone_row(row)
    at = occ.get("at") or _now_iso()
    _ms(at)
    workflow_id = _text(occ.get("workflowId"))
    analysis_id = _text(occ.get("analysisId"))
    already = any(
        _text(o.get("workflowId")) == workflow_id and _text(o.get("analysisId")) == analysis_id
        for o in nxt["occurrences"]
    )
    if not already:
        nxt["occurrences"].append({
            "workflowId": workflow_id,
            "analysisId": analysis_id,
            "workflowDefId": _text(occ.get("workflowDefId")),
            "severity": _text(occ.get("severity")),
            "at": at,
        })
    nxt["firstSeen"] = _min_iso(nxt.get("firstSeen"), at)
    nxt["lastSeen"] = _max_iso(nxt.get("lastSeen"), at)
    return nxt


def apply_status(row, status, note=None, at=None) -> dict:
    """Set the lifecycle status.

    `note` and `at` are accepted for call-site symmetry with the other reducers
    and are NOT persisted: the row schema is closed, and the durable audit trail
    of WHY a status moved is attempts[] and verdicts[] — a free-text status log
    would be a second, unreviewed narrative. Callers log the note themselves."""
    if status not in STATUSES:
        raise ValueError(
            f"si-ledger: invalid status {json.dumps(status)} (expected one of {'|'.join(STATUSES)})"
        )
    del note, at
    nxt = _clone_row(row)
    nxt["status"] = status
    return nxt


def apply_attempt(row, attempt=None) -> dict:
    """Upsert an attempt, keyed on prdKey + workflowId.

    One SI run is one attempt, stamped repeatedly as it progresses (in-run → PR
    opened → merged → deployed), so the same prdKey+workflowId must land on the
    same entry. Only non-null fields are merged, so a later stamp that knows only
    `deployedAt` cannot blank the mergedAt an earlier one recorded; prNumbers are
    UNIONed rather than replaced, because a run that opens a second PR must not
    erase the first link.

    When the stamp carries an `outcome`, the row's status follows it through
    status_after_outcome — that is how a cancelled or errored SI run returns its
    keys to `open` instead of parking them in `in-run` forever."""
    attempt = attempt or {}
    nxt = _clone_row(row)
    prd_key = _text(attempt.get("prdKey"))
    workflow_id = _text(attempt.get("workflowId"))
    outcome = attempt.get("outcome")
    outcome = None if outcome is None else str(outcome)
    if outcome is not None and outcome not in ATTEMPT_OUTCOMES:
        raise ValueError(
            f"si-ledger: invalid attempt outcome {json.dumps(attempt.get('outcome'))} "
            f"(expected one of {'|'.join(ATTEMPT_OUTCOMES)})"
        )

    existing = next(
        (
            a for a in nxt["attempts"]
            if _text(a.get("prdKey")) == prd_key and _text(a.get("workflowId")) == workflow_id
        ),
        None,
    )
    if existing is not None:
        if attempt.get("epicId") is not None:
            existing["epicId"] = _text(attempt.get("epicId"))
        if attempt.get("mergedAt") is not None:
            existing["mergedAt"] = _text(attempt.get("mergedAt"))
        if attempt.get("deployedAt") is not None:
            existing["deployedAt"] = _text(attempt.get("deployedAt"))
        if attempt.get("note") is not None:
            existing["note"] = str(attempt.get("note"))
        if outcome is not None:
            existing["outcome"] = outcome
        if attempt.get("prNumbers") is not None:
            existing["prNumbers"] = _pr_list(list(existing.get("prNumbers") or []) + list(attempt["prNumbers"]))
        else:
            existing["prNumbers"] = _pr_list(existing.get("prNumbers"))
    else:
        nxt["attempts"].append({
            "prdKey": prd_key,
            "workflowId": workflow_id,
            "epicId": _text(attempt.get("epicId")),
            "prNumbers": _pr_list(attempt.get("prNumbers")),
            "mergedAt": _text(attempt.get("mergedAt")),
            "deployedAt": _text(attempt.get("deployedAt")),
            "outcome": outcome or "in-run",
            "note": "" if attempt.get("note") is None else str(attempt.get("note")),
        })

    if outcome is not None:
        nxt["status"] = status_after_outcome(outcome)
    return nxt


def apply_expected(row, expected_list, prd_key=None, at=None) -> dict:
    """The numbers this attempt promised to move — the falsifiable half of a
    recommendation. Each entry is validated against METRIC_NAMES (an unnamed
    metric is a promise nobody can check, so it is rejected loudly), gets
    observeRuns=5 and setAt=at by default, and is stamped with the prdKey that
    made the promise. An entry for the same metric + prdKey REPLACES the earlier
    one: re-synthesising the same PRD restates its expectation, it does not add a
    second one. Expectations from a DIFFERENT prdKey are kept — that history is
    how "we tried twice and neither attempt moved it" becomes visible."""
    nxt = _clone_row(row)
    when = at or _now_iso()
    _ms(when)
    stamped = _text(prd_key)
    if isinstance(expected_list, dict) or expected_list is None:
        expected_list = [expected_list]
    incoming = []
    for raw in expected_list:
        entry = raw or {}
        metric = _text(entry.get("metric"))
        if metric not in METRIC_NAMES:
            raise ValueError(
                f"si-ledger: unknown expected metric {json.dumps(entry.get('metric'))} "
                f"(expected one of {'|'.join(METRIC_NAMES)})"
            )
        baseline = entry.get("baseline")
        baseline = {
            "value": baseline.get("value"),
            "runs": baseline.get("runs"),
            "window": baseline.get("window"),
        } if isinstance(baseline, dict) else None
        set_at = entry.get("setAt") or when
        _ms(set_at)
        observe_runs = entry.get("observeRuns")
        try:
            observe_runs = DEFAULT_OBSERVE_RUNS if observe_runs is None else int(observe_runs)
        except (TypeError, ValueError):
            observe_runs = DEFAULT_OBSERVE_RUNS
        incoming.append({
            "metric": metric,
            "baseline": baseline,
            "target": entry.get("target"),
            "observeRuns": observe_runs,
            "setAt": set_at,
            "prdKey": stamped if entry.get("prdKey") is None else _text(entry.get("prdKey")),
        })
    replaced = {f"{e['metric']}|{e['prdKey']}" for e in incoming}
    nxt["expected"] = [
        e for e in nxt["expected"]
        if f"{_text(e.get('metric'))}|{_text(e.get('prdKey'))}" not in replaced
    ] + incoming
    return nxt


def apply_verdict(row, verdict=None) -> dict:
    """Record si_verify's ruling and move the row accordingly:
         verified              → "verified" (the number moved; stop re-filing it)
         no-effect | regressed → "open"     (the ask is STILL OWED)
         insufficient          → unchanged  (not enough runs yet; ask again later)

    The attempt is always KEPT. Dropping it on a failed verdict is precisely the
    bug this feature exists to prevent: the pattern would look untouched, be
    re-batched into an identical PRD, and the fact that we already tried that fix
    and it did nothing would be gone."""
    verdict = verdict or {}
    value = _text(verdict.get("verdict"))
    if value not in VERDICT_VALUES:
        raise ValueError(
            f"si-ledger: invalid verdict {json.dumps(verdict.get('verdict'))} "
            f"(expected one of {'|'.join(VERDICT_VALUES)})"
        )
    nxt = _clone_row(row)
    at = verdict.get("at") or _now_iso()
    _ms(at)
    nxt["verdicts"].append({
        "at": at,
        "prdKey": _text(verdict.get("prdKey")),
        "verdict": value,
        "before": verdict["before"] if isinstance(verdict.get("before"), dict) else {},
        "after": verdict["after"] if isinstance(verdict.get("after"), dict) else {},
        "note": "" if verdict.get("note") is None else str(verdict.get("note")),
    })
    if value == "verified":
        nxt["status"] = "verified"
    elif value in ("no-effect", "regressed"):
        nxt["status"] = "open"
    return nxt


def status_after_outcome(outcome) -> str:
    """Where an attempt's outcome leaves the pattern. `cancelled` and `error`
    return it to `open` — an SI run that died fixed nothing, and a key left in
    `in-run` is a recommendation that can never be filed again (dedupe_blocked
    would suppress it forever). `handoff` counts as `landed`: the PR exists and is
    out of our hands, so the ask is not still owed to the backlog."""
    mapping = {
        "landed": "landed",
        "deployed": "deployed",
        "in-run": "in-run",
        "cancelled": "open",
        "error": "open",
        "handoff": "landed",
    }
    if outcome not in mapping:
        raise ValueError(
            f"si-ledger: invalid attempt outcome {json.dumps(outcome)} "
            f"(expected one of {'|'.join(ATTEMPT_OUTCOMES)})"
        )
    return mapping[outcome]


def dedupe_blocked(row, now=None, fresh_days=DEFAULT_FRESH_DAYS) -> dict:
    """May this pattern be filed into a new PRD right now? → {blocked, reason}.

    The two ways a duplicate ask gets made are "it is already in a run" and "it
    shipped last week and nobody has measured it yet", so those are the two
    blocks. A fix that has been out for longer than fresh_days with no verdict is
    NOT blocked — at that point the silence is its own signal and re-filing is the
    right move. A no-effect/regressed verdict recorded after the attempt shipped
    unblocks immediately: we know that attempt failed, so the ask is owed again.

    `reason` is a human sentence, surfaced verbatim by prd-submitter's log line
    and by the run-analysis skill when it declines to mint a key, so both
    languages produce the SAME sentence (the fixture pins it)."""
    row = row or {}
    now_ms = _ms(now or _now_iso())
    key = _text(row.get("patternKey")) or "(unkeyed)"
    status = _text(row.get("status")) or "open"
    attempts = row.get("attempts") if isinstance(row.get("attempts"), list) else []
    verdicts = row.get("verdicts") if isinstance(row.get("verdicts"), list) else []
    newest = attempts[-1] if attempts else None

    if status == "in-run":
        run = (_text(newest.get("workflowId")) if newest else None) or "unknown"
        prd = (_text(newest.get("prdKey")) if newest else None) or "unknown"
        return {
            "blocked": True,
            "reason": (
                f"{key} is already in flight: run {run} (PRD {prd}) is carrying it. "
                f"File nothing new; let that run land."
            ),
        }

    if status in ("landed", "deployed"):
        shipped_at = None
        if newest:
            shipped_at = _text(newest.get("deployedAt")) or _text(newest.get("mergedAt"))
        if shipped_at and now_ms - _ms(shipped_at) <= fresh_days * DAY_MS:
            refuted = any(
                v.get("verdict") in ("no-effect", "regressed") and _ms(v.get("at")) > _ms(shipped_at)
                for v in verdicts
            )
            if not refuted:
                days = (now_ms - _ms(shipped_at)) // DAY_MS
                prd = _text(newest.get("prdKey")) or "unknown"
                return {
                    "blocked": True,
                    "reason": (
                        f"{key} already {status} {days}d ago ({shipped_at}, PRD {prd}) and has no "
                        f"no-effect/regressed verdict since. Let si_verify judge that attempt "
                        f"before filing it again."
                    ),
                }

    return {"blocked": False, "reason": f"{key} is clear to file (status {status})."}


# ── DynamoDB wrapper ─────────────────────────────────────────────────────────

def _to_ddb(obj):
    """floats → Decimal, recursively: the boto3 resource API refuses float, and a
    baseline value / target is exactly that. Same converter and same reason as
    save_analysis.to_ddb."""
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: _to_ddb(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_to_ddb(v) for v in obj]
    return obj


def _plain(obj):
    """Decimal → int/float, recursively, so a row read back through the resource
    API prints as ordinary JSON for the skills that parse this CLI's output."""
    if isinstance(obj, Decimal):
        return int(obj) if obj == obj.to_integral_value() else float(obj)
    if isinstance(obj, dict):
        return {k: _plain(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_plain(v) for v in obj]
    return obj


class SiLedger:
    """Thin DynamoDB front for the reducers above.

    The table is INJECTABLE (`SiLedger(table=fake)`), so the unit suite drives the
    whole class with a fake and never touches AWS — and boto3 is only imported
    when it is NOT injected, which is what keeps this module importable in the CI
    toolkit job (no boto3 installed there; cf. compute_metrics.request_card).

    Every write is read-modify-write: get the row, run a pure reducer, put the
    WHOLE reduced row. No UpdateExpressions — the row is four append-only arrays
    and a status, so an item-level put is both simpler and atomic in the only way
    that matters here. That is safe because each key has one writer in practice
    (the analyzer files occurrences, prd-submitter stamps the run it submitted,
    this toolkit records verdicts one at a time); if that ever stops being true
    the fix is a conditional put on a version attribute, not partial updates — the
    reducers would not change."""

    def __init__(self, table=None, table_name=None, region=None):
        self.table_name = table_name or os.environ.get("SI_LEDGER_TABLE") or SI_LEDGER_TABLE_DEFAULT
        if table is not None:
            self._table = table
            return
        import boto3  # noqa: PLC0415 — see the class docstring
        region = region or os.environ.get("AWS_REGION", "us-east-1")
        self._table = boto3.resource("dynamodb", region_name=region).Table(self.table_name)

    def get(self, key):
        """→ the row, or None. Normalises the key so a caller's prose key hits."""
        item = self._table.get_item(Key={"patternKey": normalize_key(key)}).get("Item")
        return item or None

    def list(self):
        """Every row, paged. A Scan is right here and will stay right: the ledger
        is one row per distinct recommendation pattern — tens, maybe low hundreds
        — and every consumer (the reuse listing, the markdown render, si_verify's
        sweep) genuinely wants all of them."""
        rows, start_key = [], None
        while True:
            page = self._table.scan(**({"ExclusiveStartKey": start_key} if start_key else {}))
            rows.extend(page.get("Items") or [])
            start_key = page.get("LastEvaluatedKey")
            if not start_key:
                return rows

    def put(self, row):
        """Full put of an already-reduced row."""
        self._table.put_item(Item=_to_ddb(row))
        return row

    def delete(self, key):
        """Operator-only pruning (the CLI's `delete`). No Lambda does this, which
        is why the JS twin has no equivalent."""
        pattern_key = normalize_key(key)
        self._table.delete_item(Key={"patternKey": pattern_key})
        return pattern_key

    def upsert_occurrence(self, key, title, occ=None):
        """The create-if-absent entry point — the ONLY method that mints a row,
        since a pattern exists exactly because some analysis saw it."""
        occ = occ or {}
        pattern_key = normalize_key(key)
        current = self.get(pattern_key)
        base = current or new_row(
            pattern_key=pattern_key, title=title, at=occ.get("at"), source=occ.get("source")
        )
        # A later analysis usually has the better-worded title; keep the existing
        # one when the caller passes nothing rather than blanking it.
        if current and title and str(title).strip():
            base["title"] = str(title).strip()
        return self.put(apply_occurrence(base, occ))

    def mark_batched(self, keys, prd_key):
        """"These keys are going into a PRD." No attempt is written yet: an attempt
        needs the run that carries it, and a PRD that is never submitted must not
        leave a phantom attempt behind. mark_in_run writes the durable prdKey link.
        Missing keys are skipped, not fatal — an operator may have deleted a row
        between synthesis and submission, and that must not fail the submission."""
        updated = []
        for key in keys if isinstance(keys, (list, tuple)) else [keys]:
            row = self.get(key)
            if not row:
                print(f"[si-ledger] mark_batched: no row for {key} — skipped", file=sys.stderr)
                continue
            updated.append(self.put(apply_status(row, "batched", note=f"batched into {prd_key}")))
        return updated

    def mark_in_run(self, keys, prd_key=None, workflow_id=None, epic_id=None):
        """"A run is carrying these keys" — stamps the in-run attempt on each."""
        updated = []
        for key in keys if isinstance(keys, (list, tuple)) else [keys]:
            row = self.get(key)
            if not row:
                print(f"[si-ledger] mark_in_run: no row for {key} — skipped", file=sys.stderr)
                continue
            updated.append(self.put(apply_attempt(row, {
                "prdKey": prd_key, "workflowId": workflow_id, "epicId": epic_id, "outcome": "in-run",
            })))
        return updated

    def stamp_attempt(self, key, attempt):
        """Progress (or end) the attempt for one key — see apply_attempt."""
        return self.put(apply_attempt(self.require_row(key, "stamp_attempt"), attempt))

    def record_verdict(self, key, verdict):
        return self.put(apply_verdict(self.require_row(key, "record_verdict"), verdict))

    def put_expected(self, key, expected_list, prd_key=None, at=None):
        return self.put(apply_expected(
            self.require_row(key, "put_expected"), expected_list, prd_key=prd_key, at=at
        ))

    def require_row(self, key, op):
        """Single-key writers raise on a missing row instead of creating one: a
        verdict or an attempt with no occurrence behind it means the caller
        invented a key, and inventing keys is how a ledger stops being
        reusable."""
        row = self.get(key)
        if not row:
            raise ValueError(f"si-ledger: {op}: no row for patternKey {normalize_key(key)}")
        return row


# ── CLI renderers (pure, so they are unit-tested without a table) ────────────

def touches_def(row, workflow_def_id) -> bool:
    """Did this pattern ever occur in runs of that workflow def? `--def` filtering
    is by OCCURRENCE, not by a field on the row: the same pattern can show up in
    more than one def, and a row is not owned by the first def that saw it."""
    if not workflow_def_id:
        return True
    return any(
        _text(o.get("workflowDefId")) == workflow_def_id
        for o in (row.get("occurrences") or [])
    )


def _ms_safe(iso) -> int:
    """Ordering must not be able to take the render down: a hand-edited row with a
    broken lastSeen sorts last instead of raising in the middle of a skill."""
    try:
        return _ms(iso)
    except ValueError:
        return 0


def sort_rows(rows):
    """Newest sighting first, patternKey ascending as the tiebreak —
    deterministic, because this output is diffed into a knowledge file. Two
    passes, relying on a stable sort, so the tiebreak stays ASCENDING while the
    primary key is reversed."""
    by_key = sorted(rows, key=lambda r: _text(r.get("patternKey")) or "")
    return sorted(by_key, key=lambda r: _ms_safe(r.get("lastSeen")), reverse=True)


def keys_lines(rows, workflow_def_id=None):
    """`patternKey<TAB>status<TAB>title` — what the run-analysis skill reads BEFORE
    minting a key, so it reuses an existing one instead of inventing a synonym.
    Tab-separated on purpose: titles contain commas and the skill splits on \\t."""
    return [
        f"{r.get('patternKey')}\t{r.get('status')}\t{(r.get('title') or '').strip()}"
        for r in sort_rows([r for r in rows if touches_def(r, workflow_def_id)])
    ]


def render_markdown(rows, workflow_def_id=None) -> str:
    """The "Recommendations filed and status" section of the knowledge file — the
    one place a human (or the next analysis) can see that an ask was already made,
    already shipped, and what measuring it concluded."""
    selected = sort_rows([r for r in rows if touches_def(r, workflow_def_id)])
    scope = f" ({workflow_def_id})" if workflow_def_id else ""
    lines = [
        f"## Recommendations filed and status{scope}",
        "",
        "| Pattern | Status | Seen | Last seen | Attempts | Latest verdict | Title |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    if not selected:
        lines.append("| _(none yet)_ | | | | | | |")
        return "\n".join(lines) + "\n"
    for r in selected:
        attempts = r.get("attempts") or []
        verdicts = r.get("verdicts") or []
        newest = attempts[-1] if attempts else None
        attempt_cell = "-"
        if newest:
            prs = ", ".join(f"#{n}" for n in (newest.get("prNumbers") or [])) or "no PR"
            attempt_cell = f"{len(attempts)} ({newest.get('outcome')}, {newest.get('prdKey') or 'no PRD'}, {prs})"
        verdict_cell = "-"
        if verdicts:
            last = verdicts[-1]
            verdict_cell = f"{last.get('verdict')} @ {last.get('at')}"
        title = (r.get("title") or "").replace("|", "\\|").strip()
        lines.append(
            f"| `{r.get('patternKey')}` | {r.get('status')} | {len(r.get('occurrences') or [])} "
            f"| {r.get('lastSeen')} | {attempt_cell} | {verdict_cell} | {title} |"
        )
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="SI recommendation ledger (agentcore-hub-si-ledger)")
    sub = parser.add_subparsers(dest="command", required=True)

    p_keys = sub.add_parser("keys", help="patternKey<TAB>status<TAB>title for reuse decisions")
    p_keys.add_argument("--def", dest="workflow_def_id", default=None)

    p_render = sub.add_parser("render", help="markdown status table for the knowledge file")
    p_render.add_argument("--def", dest="workflow_def_id", default=None)

    p_get = sub.add_parser("get", help="one row as JSON")
    p_get.add_argument("key")

    p_upsert = sub.add_parser("upsert", help="record an occurrence (creates the row if absent)")
    p_upsert.add_argument("--key", required=True)
    p_upsert.add_argument("--title", required=True)
    p_upsert.add_argument("--workflow", required=True)
    p_upsert.add_argument("--analysis", required=True)
    p_upsert.add_argument("--def", dest="workflow_def_id", default=None)
    p_upsert.add_argument("--severity", default=None)
    p_upsert.add_argument("--at", default=None)

    p_delete = sub.add_parser("delete", help="prune a row (operator action)")
    p_delete.add_argument("key")

    args = parser.parse_args(argv)
    ledger = SiLedger()

    if args.command == "keys":
        for line in keys_lines(_plain(ledger.list()), args.workflow_def_id):
            print(line)
        return 0
    if args.command == "render":
        print(render_markdown(_plain(ledger.list()), args.workflow_def_id), end="")
        return 0
    if args.command == "get":
        row = ledger.get(args.key)
        if not row:
            print(f"si-ledger: no row for patternKey {normalize_key(args.key)}", file=sys.stderr)
            return 1
        print(json.dumps(_plain(row), indent=2, sort_keys=True))
        return 0
    if args.command == "upsert":
        row = ledger.upsert_occurrence(args.key, args.title, {
            "workflowId": args.workflow,
            "analysisId": args.analysis,
            "workflowDefId": args.workflow_def_id,
            "severity": args.severity,
            "at": args.at,
        })
        print(json.dumps(_plain(row), indent=2, sort_keys=True))
        return 0
    if args.command == "delete":
        print(json.dumps({"deleted": ledger.delete(args.key)}))
        return 0
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ValueError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
