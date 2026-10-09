#!/usr/bin/env python3
"""Did the fix work? — the arithmetic half of the self-improvement loop.

WHY THIS EXISTS. Before the ledger, the loop could synthesise a PRD, ship it, and
never once go back to ask whether the number it promised to move actually moved.
So the same ask was re-filed for weeks, and a fix that made things WORSE looked
exactly like a fix nobody had tried yet. si_verify closes that loop: for every
expectation a shipped attempt recorded (`expected[]` on the si-ledger row), it
recomputes the promised metric over an equal-sized window before and after the
ship, and rules `verified | no-effect | regressed | insufficient`.

THE RULING IS ARITHMETIC. There is no model call in this file and there must
never be one. The Workflow Manager's job is to RUN this script and reproduce its
table verbatim — its prose is not evidence, and a verdict an LLM can argue with is
a verdict the loop can talk itself past. Every number printed here is traceable to
si_metrics (cards, events, the analyses/workflows tables, the CD ledger) and every
threshold is a named constant below.

WHAT IT REFUSES TO DO. It never invents a number: an unreadable metric, a missing
baseline, or fewer than `observeRuns` runs since the ship all produce
`insufficient` WITH the reason, never a 0 and never a guess. `insufficient` is
also the only verdict that does not move the row's status, precisely because "we
could not tell yet" must not be recorded as "we checked and nothing happened".

Usage:
  python3 si_verify.py                      # sweep every judgeable row, print, write nothing
  python3 si_verify.py --apply              # ... and record the verdicts + today's coverage
  python3 si_verify.py --key ops.paging.out-of-hours [--dry-run]
  python3 si_verify.py --now 2026-09-18T00:00:00Z   # pin the clock (tests, reproducibility)
  python3 si_verify.py --json               # machine-readable instead of the markdown table

Reads:  si-ledger table, plus everything si_metrics.DataSource reads.
Writes (only with --apply): `verdicts[]`/`status` on pattern rows, and the reserved
`#metrics` row's daily `analysis_coverage` series.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compute_metrics import parse_ts  # noqa: E402
import si_ledger  # noqa: E402
import si_metrics  # noqa: E402

# ── Thresholds (every number a verdict rests on is here) ─────────────────────

# How big a relative move counts as a move at all. Below this the run-to-run
# noise in a 5-run window swamps the signal, so "it went from 2.1 to 1.9" is
# honestly reported as no-effect rather than as a fix that worked.
NOISE_BAND = 0.20

# How far back the BEFORE window may reach for its runs. It does not widen the
# comparison — both sides are capped to the same `observeRuns` count, so they are
# equal-sized in RUNS, which is the unit the promise was made in. This only bounds
# how stale a "before" run is allowed to be.
BEFORE_LOOKBACK_DAYS = 90

# Nine of the ten metrics are failures/waits, where DOWN is the improvement.
# analysis_coverage is a ratio of runs analysed, where UP is. Getting this wrong
# inverts every verdict, so it is a closed list checked against si_ledger's.
HIGHER_IS_BETTER = frozenset({"analysis_coverage"})

# Order in which per-metric verdicts are applied to a row, so a PRD that promised
# two metrics lands on the honest status: any failure must win over a success
# (verified means every promise held), and insufficient must never overwrite
# either, since apply_verdict leaves the status alone for it.
VERDICT_APPLY_ORDER = {"verified": 0, "insufficient": 1, "no-effect": 2, "regressed": 3}

# The reserved non-pattern ledger row carrying the daily analysis_coverage series
# the Evaluations panel reads. The pattern-key grammar cannot produce a leading
# "#" (si_ledger._KEY_RE), so this row can never collide with a real pattern —
# the same trick as the analyses table's "#si-synthesis" claim row. PARITY:
# SI_METRICS_KEY in src/lib/si-ledger.ts.
SI_METRICS_KEY = "#metrics"

# `ratio` on each day is the ROLLING si_metrics.COVERAGE_WINDOW_DAYS coverage as
# of that day, not that single day's ratio: coverage of one day is 3 runs wide and
# swings between 0 and 1 on noise, which would make the panel's tile useless.
# `day` is therefore the measurement date, not the measured period.
COVERAGE_KEEP_DAYS = 400

DAY_MS = 86_400_000


# ── plumbing ─────────────────────────────────────────────────────────────────

def undecimal(obj):
    """Decimal → int/float, recursively. si_ledger and si_metrics each have a
    private equivalent for their own outputs; this one is public so the next SI
    unit reads a ledger row through it instead of adding a fourth copy."""
    if isinstance(obj, Decimal):
        return int(obj) if obj == obj.to_integral_value() else float(obj)
    if isinstance(obj, dict):
        return {k: undecimal(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [undecimal(v) for v in obj]
    return obj


def to_ms(iso):
    """ISO-8601 → epoch ms, or None. Unlike si_ledger's, this one returns None
    instead of raising: a row written by an older backfill may carry a malformed
    timestamp, and one bad row must not abort the whole sweep."""
    dt = parse_ts(iso)
    return int(dt.timestamp() * 1000) if dt else None


def to_iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z")


def now_iso(now=None):
    return now or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _text(value):
    """None-preserving str(). Deliberately a local copy of si_ledger's private
    helper rather than an import of it: comparing a prdKey read from DynamoDB
    against one from an argument must coerce both the same way, and reaching into
    another module's underscore names to guarantee that is worse than four lines."""
    return None if value is None else str(value)


def _num(value):
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return None
    return float(value)


# ── what is judgeable ────────────────────────────────────────────────────────

def def_ids_for(row):
    """The workflow defs this pattern was seen in, from its occurrences.

    The comparison windows are per-def because the card index is per-def and
    because "rework rounds" in one workflow def is not comparable with another's.
    Taken from occurrences rather than from a field on the row for the same reason
    si_ledger.touches_def does: a pattern is not owned by the first def that saw
    it."""
    return sorted({
        str(o.get("workflowDefId"))
        for o in (row.get("occurrences") or [])
        if o.get("workflowDefId")
    })


def shipped_at(attempt):
    """When this attempt reached production (or main). Deployed beats merged: the
    metric can only move once the code is RUNNING, so measuring from the merge
    would count post-merge, pre-deploy runs as 'after'."""
    attempt = attempt or {}
    return attempt.get("deployedAt") or attempt.get("mergedAt") or None


def attempt_for(row, prd_key):
    """The newest SHIPPED attempt for this prdKey — the one whose ship date splits
    before from after. An attempt that is still in-run, cancelled or errored has
    nothing to measure, so it is not a candidate."""
    best, best_ms = None, None
    for attempt in row.get("attempts") or []:
        if prd_key and _text(attempt.get("prdKey")) != _text(prd_key):
            continue
        when = to_ms(shipped_at(attempt))
        if when is None:
            continue
        if best_ms is None or when > best_ms:
            best, best_ms = attempt, when
    return best


def already_judged(row, entry, attempt):
    """Has this (metric, prdKey) already been ruled on since the attempt shipped?

    A settled verdict is not re-litigated — re-running the sweep daily must not
    append the same ruling forever. An `insufficient` one IS revisited: that is the
    verdict that exists precisely because more runs were needed, so tomorrow it
    may become answerable. One insufficient is still recorded (so the row shows we
    looked), which is what `pending` uses `record_once` for."""
    ship_ms = to_ms(shipped_at(attempt))
    metric = entry.get("metric")
    settled, insufficient = False, False
    for verdict in row.get("verdicts") or []:
        at_ms = to_ms(verdict.get("at"))
        if at_ms is None or ship_ms is None or at_ms < ship_ms:
            continue
        if _text(verdict.get("prdKey")) != _text(entry.get("prdKey")):
            continue
        if ((verdict.get("before") or {}).get("metric") or metric) != metric:
            continue
        if verdict.get("verdict") == "insufficient":
            insufficient = True
        else:
            settled = True
    return {"settled": settled, "insufficientRecorded": insufficient}


def pending(row):
    """The expectations on this row that are ready to be judged, newest ship
    first: [{entry, attempt, recordOnce}].

    Skipped, with no verdict invented: a row an operator switched off
    (`wont-fix`), an expectation whose attempt has not shipped (nothing to
    measure — the row is `in-run` or the PRD was never submitted), and one already
    settled."""
    if row.get("status") == "wont-fix":
        return []
    out = []
    for entry in row.get("expected") or []:
        if entry.get("metric") not in si_ledger.METRIC_NAMES:
            continue
        attempt = attempt_for(row, entry.get("prdKey"))
        if not attempt:
            continue
        seen = already_judged(row, entry, attempt)
        if seen["settled"]:
            continue
        out.append({
            "entry": entry,
            "attempt": attempt,
            # An insufficient verdict is printed every sweep but written only the
            # first time, so verdicts[] does not grow by one row a day while a
            # window fills up.
            "recordOnce": not seen["insufficientRecorded"],
        })
    return sorted(out, key=lambda p: to_ms(shipped_at(p["attempt"])) or 0, reverse=True)


# ── the windows ──────────────────────────────────────────────────────────────

def windows_for(row, entry, attempt, now=None):
    """(before_window, after_window) for one expectation — equal-sized in runs.

    Both sides carry the same `runs` cap (`observeRuns`, default 5), and
    si_metrics._cap takes the most RECENT runs in each window: the after side is
    therefore the system as it stands now, and the before side the last runs
    before the ship. The 90-day lookback only bounds staleness; it does not widen
    the comparison."""
    ship = shipped_at(attempt)
    ship_ms = to_ms(ship)
    observe = entry.get("observeRuns") or si_ledger.DEFAULT_OBSERVE_RUNS
    try:
        observe = int(observe)
    except (TypeError, ValueError):
        observe = si_ledger.DEFAULT_OBSERVE_RUNS
    def_ids = def_ids_for(row)
    base = {"runs": observe, "patternKey": row.get("patternKey")}
    if def_ids:
        base["defIds"] = def_ids
    before = {**base, "until": ship}
    if ship_ms is not None:
        before["since"] = to_iso(ship_ms - BEFORE_LOOKBACK_DAYS * DAY_MS)
    after = {**base, "since": ship, "until": now_iso(now)}
    return before, after


def measure(entry, source, before_window, after_window):
    """(before, after) as si_metrics MetricValue dicts.

    The before side prefers a freshly recomputed window — a number recomputed
    today from the same arithmetic as the after side is the only fair comparison.
    It falls back to the baseline the PRD recorded when the recomputation cannot
    reach `observeRuns` runs (a def that simply had fewer runs before the fix),
    because the promise's own stated starting point is better evidence than no
    comparison at all. The fallback is always disclosed in the note."""
    metric = entry["metric"]
    observe = before_window.get("runs") or si_ledger.DEFAULT_OBSERVE_RUNS
    after = si_metrics.compute(metric, source, after_window)
    before = si_metrics.compute(metric, source, before_window)
    if before.get("value") is None or (before.get("runs") or 0) < observe:
        baseline = entry.get("baseline") if isinstance(entry.get("baseline"), dict) else None
        if baseline and _num(baseline.get("value")) is not None:
            before = {
                "metric": metric,
                "value": undecimal(baseline.get("value")),
                "runs": undecimal(baseline.get("runs")),
                "window": undecimal(baseline.get("window")) or {},
                "reason": None,
                # Provenance, so the printed table never implies this number was
                # recomputed today when it was read off the PRD's own baseline.
                "source": "recorded-baseline",
            }
    return before, after


# ── the ruling ───────────────────────────────────────────────────────────────

def target_met(metric, after, target):
    if target is None:
        return False
    return after >= target if metric in HIGHER_IS_BETTER else after <= target


def relative_move(metric, before, after):
    """How far the number moved toward its goal, as a fraction of where it started.
    Positive = improved. None is impossible: a zero baseline degrades to a signed
    unit move rather than dividing by zero, because "0 → 3 dead sessions" is a
    regression and reporting it as undefined would hide that."""
    good = (after - before) if metric in HIGHER_IS_BETTER else (before - after)
    if before == 0:
        return 0.0 if good == 0 else (1.0 if good > 0 else -1.0)
    return good / abs(before)


def judge(entry, before, after):
    """(verdict, note) — PURE. The whole decision, in one readable place.

    verified      target met (or, with no numeric target, a move of at least
                  NOISE_BAND in the promised direction)
    regressed     moved AWAY from the goal by at least NOISE_BAND
    no-effect     everything else that could be measured, including a real
                  improvement that fell short of an explicit target — the ask is
                  still owed, and the note says how far it got
    insufficient  could not be measured: unreadable metric, no baseline, or fewer
                  than observeRuns runs since the ship
    """
    metric = entry["metric"]
    observe = entry.get("observeRuns") or si_ledger.DEFAULT_OBSERVE_RUNS
    try:
        observe = int(observe)
    except (TypeError, ValueError):
        observe = si_ledger.DEFAULT_OBSERVE_RUNS

    after_value = _num((after or {}).get("value"))
    before_value = _num((before or {}).get("value"))

    if after_value is None:
        return "insufficient", f"after: {(after or {}).get('reason') or 'no value'}"
    after_runs = int((after or {}).get("runs") or 0)
    if after_runs < observe:
        return "insufficient", (
            f"only {after_runs} of {observe} observation runs since the fix shipped "
            f"— ask again after {observe - after_runs} more"
        )
    if before_value is None:
        return "insufficient", (
            f"before: {(before or {}).get('reason') or 'no value'} "
            f"(and no usable baseline was recorded with the expectation)"
        )

    target = _num(entry.get("target"))
    rel = relative_move(metric, before_value, after_value)
    where = (
        f"{fmt(metric, before_value)} → {fmt(metric, after_value)} "
        f"({rel * 100:+.0f}% toward goal over {after_runs} runs"
        + (f", target {fmt(metric, target)}" if target is not None else ", no numeric target")
        + ")"
    )
    if (before or {}).get("source") == "recorded-baseline":
        where += f"; before is the baseline recorded at synthesis ({(before or {}).get('runs')} runs)"

    if target is not None and target_met(metric, after_value, target):
        return "verified", f"target met: {where}"
    if rel <= -NOISE_BAND:
        return "regressed", f"moved away from the goal: {where}"
    if target is None and rel >= NOISE_BAND:
        return "verified", f"improved by more than the {NOISE_BAND:.0%} noise band: {where}"
    if rel >= NOISE_BAND:
        return "no-effect", f"improved but short of target, so the ask stands: {where}"
    return "no-effect", f"no move beyond the {NOISE_BAND:.0%} noise band: {where}"


def verify_row(row, source, now=None):
    """Every ruling this row has earned: [{patternKey, verdict, before, after,
    note, entry, attempt}]. Pure apart from `source`, which is the only thing that
    touches AWS."""
    results = []
    for item in pending(row):
        entry, attempt = item["entry"], item["attempt"]
        before_window, after_window = windows_for(row, entry, attempt, now=now)
        before, after = measure(entry, source, before_window, after_window)
        value, note = judge(entry, before, after)
        results.append({
            "patternKey": row.get("patternKey"),
            "metric": entry.get("metric"),
            "prdKey": entry.get("prdKey"),
            "verdict": value,
            "before": before,
            "after": after,
            "note": note,
            "shippedAt": shipped_at(attempt),
            "recordOnce": item["recordOnce"],
            "at": now_iso(now),
        })
    return results


def writable(results):
    """The rulings --apply persists, in the order they must be applied.

    An `insufficient` that has already been recorded once is printed but not
    re-written (see already_judged). The sort is what keeps a two-metric PRD
    honest: failures are applied last, so the row ends at `open` unless EVERY
    promise held."""
    keep = [r for r in results if r["verdict"] != "insufficient" or r["recordOnce"]]
    return sorted(keep, key=lambda r: VERDICT_APPLY_ORDER.get(r["verdict"], 9))


def to_verdict_record(result):
    """The closed `verdicts[]` entry. There is no `metric` field in the schema, so
    the metric identity travels inside before/after (both are MetricValue dicts
    carrying it) — which is also where the numbers a reader needs already are."""
    return {
        "at": result["at"],
        "prdKey": result.get("prdKey"),
        "verdict": result["verdict"],
        "before": result["before"],
        "after": result["after"],
        "note": result["note"],
    }


# ── the coverage series (reserved #metrics row) ───────────────────────────────

def coverage_day(result, day):
    """One entry of the `#metrics` row's series, from an analysis_coverage result.

    `analyses` is recovered as ratio × completedRuns — both are exact integers on
    the metric's own definition (runs covered ÷ runs), so this is arithmetic, not
    an estimate. An unreadable metric still writes the day, with ratio None and
    the reason: a gap in the series must be visible as a gap, and the panel
    renders that as "no readable metric" rather than 0."""
    value = _num((result or {}).get("value"))
    runs = int((result or {}).get("runs") or 0)
    entry = {"day": day, "completedRuns": runs, "ratio": None if value is None else round(value, 4)}
    if value is not None:
        entry["analyses"] = int(round(value * runs))
    else:
        entry["reason"] = (result or {}).get("reason") or "analysis_coverage unavailable"
    return entry


def apply_coverage_day(row, entry, keep_days=COVERAGE_KEEP_DAYS):
    """Pure reducer for the reserved row: replace the same day, keep the newest
    `keep_days`, sorted ascending. Re-running the sweep twice in one day is
    therefore idempotent."""
    row = dict(row or {})
    row["patternKey"] = SI_METRICS_KEY
    series = [d for d in (row.get("coverage") or []) if d.get("day") and d.get("day") != entry["day"]]
    series.append(entry)
    series.sort(key=lambda d: str(d.get("day")))
    row["coverage"] = series[-keep_days:]
    row["updatedAt"] = entry.get("day")
    return row


def coverage_row(rows):
    """The reserved row out of a full scan. Read from the SCAN, never through
    SiLedger.get: that normalises the key, and "#metrics" is deliberately not a
    legal pattern key."""
    for row in rows or []:
        if row.get("patternKey") == SI_METRICS_KEY:
            return undecimal(row)
    return {"patternKey": SI_METRICS_KEY, "coverage": []}


def measure_coverage(source, now=None):
    """Rolling analysis_coverage as of `now`, across every def."""
    return si_metrics.compute("analysis_coverage", source, {"until": now_iso(now)})


# ── rendering ────────────────────────────────────────────────────────────────

def fmt(metric, value):
    """A number a human can read, without losing what it is. Never returns "0" for
    an absent value — that conflation is the bug the whole MetricValue shape
    exists to prevent."""
    if value is None:
        return "—"
    if metric in HIGHER_IS_BETTER:
        return f"{value * 100:.1f}%"
    if metric.endswith("_ms"):
        if abs(value) >= 3_600_000:
            return f"{value / 3_600_000:.2f}h"
        return f"{value / 60_000:.1f}m"
    return f"{value:g}"


def render(results, rows, coverage=None, applied=False):
    """The report the Workflow Manager reproduces verbatim. Markdown, because it
    goes straight into a PRD and into the WM's reply."""
    lines = ["## Prior attempts", ""]
    if not results:
        judgeable = sum(len(pending(r)) for r in rows or [])
        lines.append(
            f"No expectation is ready to judge ({len(rows or [])} ledger rows, "
            f"{judgeable} pending). Nothing is ruled on until an attempt has shipped."
        )
    else:
        lines += [
            "| pattern | metric | before | after | target | runs | verdict | why |",
            "|---|---|---|---|---|---|---|---|",
        ]
        for r in results:
            metric = r["metric"]
            lines.append(
                f"| `{r['patternKey']}` | {metric} "
                f"| {fmt(metric, _num(r['before'].get('value')))} "
                f"| {fmt(metric, _num(r['after'].get('value')))} "
                f"| {fmt(metric, _num((r.get('entry') or {}).get('target')))} "
                f"| {r['after'].get('runs') or 0} | **{r['verdict']}** | {r['note']} |"
            )
        lines.append("")
        lines.append(
            f"{len(writable(results))} verdict(s) "
            + ("recorded." if applied else "WOULD be recorded (--apply to write them).")
        )
    if coverage is not None:
        value = _num(coverage.get("value"))
        lines += ["", "## analysis_coverage", ""]
        lines.append(
            f"{fmt('analysis_coverage', value)} of {coverage.get('runs') or 0} terminal runs "
            f"in the rolling {si_metrics.COVERAGE_WINDOW_DAYS}-day window."
            if value is not None
            else f"unavailable: {coverage.get('reason')}"
        )
    return "\n".join(lines) + "\n"


# ── CLI ──────────────────────────────────────────────────────────────────────

def sweep(ledger, source, key=None, now=None):
    """(results, rows) — every ruling across the ledger, or one pattern's."""
    if key:
        row = ledger.get(key)
        if not row:
            raise SystemExit(f"si_verify: no ledger row for patternKey {key}")
        rows = [undecimal(row)]
    else:
        rows = [
            undecimal(r) for r in ledger.list()
            if not str(r.get("patternKey") or "").startswith("#")
        ]
    results = []
    for row in rows:
        results.extend(verify_row(row, source, now=now))
    # Attach the expectation so the renderer can print its target without
    # re-deriving it, and keep the newest ship first.
    by_key = {}
    for row in rows:
        for entry in row.get("expected") or []:
            by_key[(row.get("patternKey"), entry.get("metric"), entry.get("prdKey"))] = entry
    for r in results:
        r["entry"] = by_key.get((r["patternKey"], r["metric"], r["prdKey"])) or {}
    return results, rows


def main():
    parser = argparse.ArgumentParser(description="Rule on shipped SI attempts — arithmetic only.")
    parser.add_argument("--key", help="one patternKey (default: sweep every row)")
    parser.add_argument("--apply", action="store_true", help="write the verdicts and today's coverage day")
    parser.add_argument("--dry-run", action="store_true", help="explicit default: print, write nothing")
    parser.add_argument("--now", help="ISO timestamp to treat as now (pins the windows)")
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()
    if args.apply and args.dry_run:
        raise SystemExit("si_verify: --apply and --dry-run are mutually exclusive")

    now = now_iso(args.now)
    table = os.environ.get("SI_LEDGER_TABLE") or si_ledger.SI_LEDGER_TABLE_DEFAULT
    ledger = si_ledger.SiLedger(table_name=table)
    source = si_metrics.DataSource(ledger_table=table)

    results, rows = sweep(ledger, source, key=args.key, now=now)
    coverage = measure_coverage(source, now=now) if not args.key else None

    if args.apply:
        for result in writable(results):
            ledger.record_verdict(result["patternKey"], to_verdict_record(result))
        if coverage is not None:
            day = now[:10]
            ledger.put(apply_coverage_day(coverage_row(ledger.list()), coverage_day(coverage, day)))

    if args.as_json:
        print(json.dumps({
            "now": now, "applied": bool(args.apply),
            "results": [{k: v for k, v in r.items() if k != "entry"} for r in results],
            "coverage": coverage,
        }, indent=2, default=str))
    else:
        print(render(results, rows, coverage=coverage, applied=bool(args.apply)), end="")


if __name__ == "__main__":
    main()
