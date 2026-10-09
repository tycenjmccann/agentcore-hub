#!/usr/bin/env python3
"""Validate and persist a workflow analysis. The ONLY write path for analyses —
the Workflow Manager cannot malform the DDB row because validation happens here.

Usage:
  python3 save_analysis.py <workflowId> [--workspace DIR] [--trigger auto|manual|watch]

Reads the LLM-authored fields from {workspace}/analysis.d/ (one file per
top-level key, TEAM-5226; the parts named by analysis.d/manifest.json, TEAM-5239
— see merge_sections) or, when that directory is absent, {workspace}/analysis.json;
plus {workspace}/metrics.json and {workspace}/dossier.json. Writes:
  - DDB ANALYSES_TABLE item {workflowId, analysisId, ...} (bounded, see fit_row)
  - s3://$ARTIFACT_BUCKET/workflows/{wfId}/analysis/{analysisId}/{analysis,metrics,dossier}.json
  - DDB SI_LEDGER_TABLE: one occurrence per patternKey named by this analysis
and then retires analysis.d/ (renamed to analysis.d.saved-<analysisId>) so a later
write in the same session cannot merge with what was already saved.

TEAM-4760: every P0/P1 recommendation must carry a `patternKey`, and saving the
analysis is what records the sighting. Before this, a recommendation existed only
as prose inside one analysis row, so "we have asked for this 8 times" was
unanswerable and the WM re-synthesized the same ask for weeks. The key is the
identity that makes an ask countable, and this is the only place it is minted, so
an analysis cannot be saved without one.
"""

import argparse
import json
import os
import random
import string
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal

import boto3

import si_ledger

REGION = os.environ.get("AWS_REGION", "us-east-1")
ARTIFACT_BUCKET = os.environ["ARTIFACT_BUCKET"]
ANALYSES_TABLE = os.environ.get("ANALYSES_TABLE", "agentcore-hub-workflow-analyses")
SI_LEDGER_TABLE = os.environ.get("SI_LEDGER_TABLE", "agentcore-hub-si-ledger")
MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-opus-5")

SCHEMA_VERSION = 1
FINDING_KINDS = {"bottleneck", "failure", "success", "risk"}
SEVERITIES = {"critical", "high", "medium", "low"}
PRIORITIES = {"P0", "P1", "P2"}
REC_TYPES = {"workflow-def", "prompt", "gate-config", "process", "tooling"}
SCORE_KEYS = {"overall", "planning", "execution", "reviewEfficiency", "reworkDiscipline"}
# TEAM-3747 D2 — includes the lifecycle-integrity terminal outcomes so a run
# closed as deploy-blocked / static-ci-only is recorded HONESTLY (mapping the
# phase straight through below) instead of masquerading as "complete". PARITY:
# src/lib/workflow/types.ts SHIP_BLOCKED_OUTCOMES + analysis-types.ts RunOutcome.
RUN_OUTCOMES = {"complete", "cancelled", "error", "deploy-blocked", "static-ci-only"}

# TEAM-4760 — a patternKey is MANDATORY at these priorities. P0/P1 are the asks
# that become SI PRDs, so they are the ones that must be countable across runs;
# requiring a key on every P2 nicety would only push the WM into minting
# throwaway keys, which is worse than no key at all. A key on a P2 or a finding is
# accepted and tracked, it is just not demanded.
KEY_REQUIRED_PRIORITIES = {"P0", "P1"}

# A recommendation has a priority, not a severity, and the ledger records a
# severity per sighting. When the key is not also named by a finding (which does
# have one), the priority is the honest stand-in.
PRIORITY_SEVERITY = {"P0": "critical", "P1": "high", "P2": "medium"}

# TEAM-5226 — the analysis was written in ONE heredoc tool call, the largest
# single output of the session, and the model's output cap cut it off mid-call
# (MaxTokensReachedException, nothing persisted). The skill now writes one file
# per top-level key into analysis.d/; long lists may be split into numbered
# parts (findings.1.json, findings.2.json, ...), concatenated in order here.
SECTIONS_DIR = "analysis.d"
JSON_SECTIONS = ("scores", "verdict", "findings", "recommendations", "trend", "kpiVersion")
LIST_SECTIONS = {"findings", "recommendations"}
# TEAM-5239 — the generation marker. A continuation after a max-tokens stop
# rewrites a key as fewer or different parts and leaves the old numbered parts
# behind; merging every file in the directory appended them (lists), let them
# win (scalars) or aborted the save (a malformed leftover). The agent writes
# manifest.json LAST, naming exactly the JSON parts of THIS analysis; only those
# are merged, and when it is present the analysis.json baseline is ignored (the
# manifest IS the complete generation). Without a manifest the legacy merge
# runs, so a session still holding the old skill text keeps saving.
MANIFEST = "manifest.json"
# Names a manifest may list that are not JSON parts: tolerated, not merged here.
MANIFEST_TOLERATED = {MANIFEST, "summaryMarkdown.md"}

# Caps on what one analysis carries. Over the cap is TRUNCATED with a warning,
# not rejected: this runs at the very end of a long session, and failing here
# would throw the whole analysis away over its least important entries.
MAX_FINDINGS = 12
MAX_RECOMMENDATIONS = 12
# The row copy of metrics.fixTickets carries at most this many ids/entries; the
# count stays exact and the full list stays in S3 metrics.json.
MAX_ROW_FIX_TICKETS = 50
SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}
PRIORITY_ORDER = {"P0": 0, "P1": 1, "P2": 2}
# How many patternKeys that were named ONLY by dropped entries the row records
# (truncated.droppedPatternKeys); the ledger sighting itself is never dropped.
MAX_DROPPED_KEYS = 20

# TEAM-5239 — the count caps above do not bound the row: 24 text fields of 20 KB
# each pass validation and blow DynamoDB's 400 KB item limit at put_item, after
# the S3 objects already landed. The row is measured as compact-JSON UTF-8 bytes,
# which bounds DynamoDB's own accounting for strings (+2 quotes), bool/null
# (4-5 bytes vs 1), map entries (quoted name + colon vs 1 byte + 3 per
# container) and numbers of 3+ digits; the one case where JSON under-counts is
# a list of tiny integers (`[1,2,3]` is 7 bytes here, 12 for DynamoDB), which
# only matters at ~10^5 elements — the margin below the hard limit covers it.
MAX_ROW_BYTES = 350 * 1024
# (text cap, summaryMarkdown cap) in characters, tried in order until the row
# fits; the floor is far above any id, ARN, ISO date or patternKey (<= 120), so
# nothing that identifies anything is ever cut.
SHRINK_LADDER = ((8192, 131072), (4096, 65536), (2048, 32768), (1024, 16384))
TRUNC_MARK = "…[truncated]"


def fail(msg):
    raise SystemExit(f"VALIDATION FAILED: {msg}")


def warn(msg):
    print(f"WARNING: {msg}", file=sys.stderr)


def _check_key(where, value):
    """One definition of the grammar: si_ledger.is_valid_key, shared with the JS
    twin via fixtures/si-ledger-contract.json. Never re-implement it here."""
    if not isinstance(value, str) or not si_ledger.is_valid_key(value):
        fail(
            f"{where} must be a patternKey of the form <area>.<slug> "
            f"(lowercase, dot-separated, hyphens inside a segment); got {value!r}"
        )


def validate(analysis):
    scores = analysis.get("scores")
    if not isinstance(scores, dict) or set(scores) != SCORE_KEYS:
        fail(f"scores must have exactly keys {sorted(SCORE_KEYS)}")
    for k, v in scores.items():
        if not isinstance(v, (int, float)) or not 0 <= v <= 100:
            fail(f"scores.{k} must be a number 0-100")
    if not isinstance(analysis.get("verdict"), str) or not analysis["verdict"].strip():
        fail("verdict must be a non-empty string")
    findings = analysis.get("findings")
    if not isinstance(findings, list) or not findings:
        fail("findings must be a non-empty list")
    for i, f in enumerate(findings):
        if f.get("kind") not in FINDING_KINDS:
            fail(f"findings[{i}].kind must be one of {sorted(FINDING_KINDS)}")
        if f.get("severity") not in SEVERITIES:
            fail(f"findings[{i}].severity must be one of {sorted(SEVERITIES)}")
        for key in ("title", "evidence"):
            if not isinstance(f.get(key), str) or not f[key].strip():
                fail(f"findings[{i}].{key} must be a non-empty string")
        # Optional on findings, but a present key must still be a real one — a
        # typo'd key is worse than none, because it silently starts a second
        # lineage for a defect that is already tracked.
        if f.get("patternKey") is not None:
            _check_key(f"findings[{i}].patternKey", f["patternKey"])
    if not any(f["kind"] == "success" for f in findings):
        fail('findings must include at least one kind:"success" (what worked)')
    recs = analysis.get("recommendations")
    if not isinstance(recs, list):
        fail("recommendations must be a list")
    for i, r in enumerate(recs):
        if r.get("priority") not in PRIORITIES:
            fail(f"recommendations[{i}].priority must be one of {sorted(PRIORITIES)}")
        if r.get("type") not in REC_TYPES:
            fail(f"recommendations[{i}].type must be one of {sorted(REC_TYPES)}")
        for key in ("title", "description", "expectedImpact"):
            if not isinstance(r.get(key), str) or not r[key].strip():
                fail(f"recommendations[{i}].{key} must be a non-empty string")
        if r["priority"] in KEY_REQUIRED_PRIORITIES:
            if not isinstance(r.get("patternKey"), str) or not r["patternKey"].strip():
                fail(
                    f"recommendations[{i}].patternKey is required on {r['priority']} "
                    "(reuse an existing key from `si_ledger.py keys` when this is the "
                    "same defect class as one already tracked; mint <area>.<slug> only "
                    "when none of them is)"
                )
            _check_key(f"recommendations[{i}].patternKey", r["patternKey"])
        elif r.get("patternKey") is not None:
            _check_key(f"recommendations[{i}].patternKey", r["patternKey"])
    trend = analysis.get("trend")
    if not isinstance(trend, dict) or "priorRunsCompared" not in trend:
        fail("trend must be an object with priorRunsCompared")
    if not isinstance(analysis.get("summaryMarkdown"), str) or len(analysis["summaryMarkdown"]) < 200:
        fail("summaryMarkdown must be a markdown report (>=200 chars)")


def _part_index(name, key):
    """findings.json -> 0, findings.3.json -> 3, anything else -> None."""
    if name == f"{key}.json":
        return 0
    mid = name[len(key) + 1:-len(".json")] if name.startswith(key + ".") and name.endswith(".json") else ""
    return int(mid) if mid.isdigit() else None


def _is_section_part(name):
    return any(_part_index(name, key) is not None for key in JSON_SECTIONS)


def _load_manifest(sdir):
    """The part names listed by analysis.d/manifest.json (basenames, so a
    path-prefixed entry still matches), or None when there is no manifest."""
    path = os.path.join(sdir, MANIFEST)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        try:
            doc = json.load(f)
        except ValueError as e:
            fail(f"{SECTIONS_DIR}/{MANIFEST} is not valid JSON ({e})")
    parts = doc.get("parts") if isinstance(doc, dict) else None
    if not isinstance(parts, list) or not all(isinstance(p, str) for p in parts):
        fail(f'{SECTIONS_DIR}/{MANIFEST} must be {{"parts": ["scores.json", "verdict.json", ...]}}')
    return [os.path.basename(p) for p in parts]


def merge_sections(workspace):
    """(analysis, meta) assembled from {workspace}/analysis.d/, or None when that
    directory does not exist (the single-file analysis.json path, unchanged).
    meta = {"manifest": bool, "ignoredParts": [names]} is echoed in the output so
    the agent can see what was NOT merged.

    Precedence, stated once: while analysis.d/ exists it governs.
      - With a manifest, ONLY the listed JSON parts are merged and analysis.json
        is ignored entirely — the manifest is the complete generation, and the
        analysis.json in the workspace is normally this script's own write-back
        of an EARLIER merge (written before validation), so it is the stalest
        thing in the workspace, not the freshest. Unlisted *.json files are
        superseded parts: ignored with a warning, even when malformed. A listed
        part that does not exist fails the save (the agent believes it wrote it).
      - Without a manifest (a session still on the old skill text), every part
        is merged over the analysis.json baseline exactly as before, with a
        warning asking for the manifest.
    summaryMarkdown comes from analysis.d/summaryMarkdown.md (outside the
    manifest — it is built by appends), else the chunked {workspace}/summary.md.
    """
    sdir = os.path.join(workspace, SECTIONS_DIR)
    if not os.path.isdir(sdir):
        return None
    on_disk = os.listdir(sdir)
    manifest = _load_manifest(sdir)
    meta = {"manifest": manifest is not None, "ignoredParts": []}
    analysis = {}
    if manifest is None:
        warn(
            f"{SECTIONS_DIR}/{MANIFEST} missing — merged every part in {SECTIONS_DIR}/; "
            f"write the manifest (see the run-analysis skill) so superseded parts are ignored"
        )
        single = os.path.join(workspace, "analysis.json")
        if os.path.exists(single):
            try:
                with open(single) as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    analysis.update(loaded)
            except ValueError:
                pass  # a truncated single file is exactly what sections replace
        names = on_disk
    else:
        listed = set(manifest)
        for name in sorted(listed - MANIFEST_TOLERATED):
            if not _is_section_part(name):
                warn(f"{SECTIONS_DIR}/{MANIFEST} lists {name!r}, which is not a section part — ignored")
        names = sorted(n for n in listed if _is_section_part(n))
        missing = [n for n in names if n not in on_disk]
        if missing:
            fail(
                f"{SECTIONS_DIR}/{MANIFEST} lists {missing} but the file(s) do not exist — "
                f"write the part or remove it from {MANIFEST}"
            )
        meta["ignoredParts"] = sorted(
            n for n in on_disk if n.endswith(".json") and n != MANIFEST and n not in listed
        )
        for name in meta["ignoredParts"]:
            warn(f"{SECTIONS_DIR}/{name} is not listed in {MANIFEST} — ignored as a superseded part")
    for key in JSON_SECTIONS:
        parts = sorted((i, n) for n in names if (i := _part_index(n, key)) is not None)
        if not parts:
            continue
        values = []
        for _, name in parts:
            with open(os.path.join(sdir, name)) as f:
                try:
                    values.append(json.load(f))
                except ValueError as e:
                    fail(f"{SECTIONS_DIR}/{name} is not valid JSON ({e})")
        if key in LIST_SECTIONS:
            merged = []
            for v in values:
                merged.extend(v if isinstance(v, list) else [v])
            analysis[key] = merged
        else:
            analysis[key] = values[-1]
    for path in (os.path.join(sdir, "summaryMarkdown.md"), os.path.join(workspace, "summary.md")):
        if os.path.exists(path):
            with open(path) as f:
                analysis["summaryMarkdown"] = f.read()
            break
    return analysis, meta


def retire_sections(workspace, analysis_id):
    """Rename analysis.d/ to analysis.d.saved-<analysisId> after the row is
    persisted, so a later write in this session starts from nothing (the merged
    analysis.json write-back is then the single-file record). A rename is
    atomic — a half-finished delete would leave a manifest-less directory that
    the legacy merge would happily read — and keeps the parts for forensics.
    Never fatal: the row is already saved, and failing now would make the agent
    re-save a second row."""
    sdir = os.path.join(workspace, SECTIONS_DIR)
    if not os.path.isdir(sdir):
        return None
    dest = f"{sdir}.saved-{analysis_id}"
    try:
        os.rename(sdir, dest)
    except OSError as e:
        warn(f"could not retire {SECTIONS_DIR}/ ({e}) — delete it before writing another analysis in this session")
        return None
    return dest


def _rank(entry, order, field):
    """Sort rank of a finding/recommendation; anything unrankable (a non-dict, an
    unknown value) sorts last, so it is what the cap drops."""
    return order.get(entry.get(field), 9) if isinstance(entry, dict) else 9


def _valid_keys(entries):
    """The well-formed patternKeys named by a list of findings/recommendations.
    Entries that are not dicts, or keys that are not valid, are skipped: the
    caller may be looking at entries that were dropped before validation."""
    return {
        e["patternKey"]
        for e in (entries if isinstance(entries, list) else [])
        if isinstance(e, dict) and isinstance(e.get("patternKey"), str) and si_ledger.is_valid_key(e["patternKey"])
    }


def dropped_pattern_keys(full, capped):
    """Keys named only by entries the cap dropped — recorded on the row so the
    truncation is explainable (the ledger sighting itself is taken from `full`)."""
    named = _valid_keys(full.get("findings")) | _valid_keys(full.get("recommendations"))
    kept = _valid_keys(capped.get("findings")) | _valid_keys(capped.get("recommendations"))
    return sorted(named - kept)[:MAX_DROPPED_KEYS]


def cap_analysis(analysis):
    """(analysis, truncated) with findings/recommendations cut to their caps —
    most severe findings and highest-priority recommendations kept, original
    order preserved within a rank. A success finding always survives (validate
    requires one). truncated is {} when nothing was dropped; when something was,
    it also lists the patternKeys that only the dropped entries named."""
    out = dict(analysis)
    truncated = {}
    findings = analysis.get("findings")
    if isinstance(findings, list) and len(findings) > MAX_FINDINGS:
        ranked = sorted(enumerate(findings), key=lambda p: (_rank(p[1], SEVERITY_ORDER, "severity"), p[0]))
        keep = [i for i, _ in ranked[:MAX_FINDINGS]]
        if not any(isinstance(findings[i], dict) and findings[i].get("kind") == "success" for i in keep):
            success = next(
                (i for i, _ in ranked if isinstance(findings[i], dict) and findings[i].get("kind") == "success"),
                None,
            )
            if success is not None:
                keep[-1] = success
        out["findings"] = [findings[i] for i in sorted(keep)]
        truncated["findings"] = len(findings) - MAX_FINDINGS
    recs = analysis.get("recommendations")
    if isinstance(recs, list) and len(recs) > MAX_RECOMMENDATIONS:
        ranked = sorted(enumerate(recs), key=lambda p: (_rank(p[1], PRIORITY_ORDER, "priority"), p[0]))
        out["recommendations"] = [recs[i] for i in sorted(i for i, _ in ranked[:MAX_RECOMMENDATIONS])]
        truncated["recommendations"] = len(recs) - MAX_RECOMMENDATIONS
    for key, n in truncated.items():
        warn(f"{key} over the cap — dropped the {n} lowest-ranked")
    if truncated:
        dropped = dropped_pattern_keys(analysis, out)
        if dropped:
            truncated["droppedPatternKeys"] = dropped
    return out, truncated


def row_metrics(metrics):
    """metrics for the analyses-table row: fixTickets' id/entry lists bounded
    (a runaway loop run grows them without limit; the row has a 400 KB ceiling).
    count is untouched and S3 metrics.json keeps the full lists."""
    fix = metrics.get("fixTickets") if isinstance(metrics, dict) else None
    if not isinstance(fix, dict):
        return metrics
    over = [k for k in ("ticketIds", "entries") if isinstance(fix.get(k), list) and len(fix[k]) > MAX_ROW_FIX_TICKETS]
    if not over:
        return metrics
    capped = dict(fix)
    for k in over:
        capped[k] = fix[k][:MAX_ROW_FIX_TICKETS]
    capped["truncated"] = True
    return {**metrics, "fixTickets": capped}


def item_bytes(item):
    """The row's size as compact JSON UTF-8 — see MAX_ROW_BYTES for why this
    bounds DynamoDB's own accounting."""
    return len(json.dumps(item, default=str, separators=(",", ":")).encode())


def shrink_strings(obj, cap):
    """(copy, cut) with every string VALUE longer than `cap` characters cut to
    the cap and marked. Dict keys are never touched — attribute names carry
    meaning. Slicing is by code point, so the result is always valid UTF-8."""
    if isinstance(obj, str):
        if len(obj) > cap:
            return obj[: max(0, cap - len(TRUNC_MARK))] + TRUNC_MARK, 1
        return obj, 0
    if isinstance(obj, dict):
        out, cut = {}, 0
        for k, v in obj.items():
            out[k], n = shrink_strings(v, cap)
            cut += n
        return out, cut
    if isinstance(obj, list):
        out, cut = [], 0
        for v in obj:
            s, n = shrink_strings(v, cap)
            out.append(s)
            cut += n
        return out, cut
    return obj, 0


def stub_metric_lists(metrics):
    """(copy, cut): every top-level list in the row's metrics replaced by
    {count, truncated} — the last resort when the run's metrics alone (phases,
    agentTasks, humanReviews, errors, ... are unbounded per run) do not fit.
    S3 metrics.json keeps the lists."""
    if not isinstance(metrics, dict):
        return metrics, 0
    out, cut = dict(metrics), 0
    for k, v in metrics.items():
        if isinstance(v, list):
            out[k] = {"count": len(v), "truncated": True}
            cut += 1
    return out, cut


def fit_row(item):
    """(row, info) — the item as it will be written to the analyses table,
    under MAX_ROW_BYTES. Nothing changes when it already fits (info None).
    Otherwise text values are cut down SHRINK_LADDER (summaryMarkdown on its own
    cap, every other string on the text cap; each rung starts from the original
    so `fields` counts fields, not cuts) until the row fits; if no rung does,
    the metrics lists are stubbed; if it STILL does not fit the save fails —
    before anything is written, so there is never an S3 object without a row.
    info = {"bytes": original size, "fields": fields cut} is merged into
    row["truncated"]."""
    original = item_bytes(item)
    if original <= MAX_ROW_BYTES:
        return item, None
    body = {k: v for k, v in item.items() if k != "summaryMarkdown"}
    summary = item.get("summaryMarkdown", "")
    row, cut = None, 0
    for text_cap, summary_cap in SHRINK_LADDER:
        shrunk_body, cut_body = shrink_strings(body, text_cap)
        shrunk_summary, cut_summary = shrink_strings(summary, summary_cap)
        row, cut = {**shrunk_body, "summaryMarkdown": shrunk_summary}, cut_body + cut_summary
        if item_bytes(row) <= MAX_ROW_BYTES:
            break
    else:
        row["metrics"], stubbed = stub_metric_lists(row.get("metrics"))
        cut += stubbed
        size = item_bytes(row)
        if size > MAX_ROW_BYTES:
            fail(f"analyses row is {size} bytes after truncation, limit {MAX_ROW_BYTES} — nothing was written")
    info = {"bytes": original, "fields": cut}
    row["truncated"] = {**(row.get("truncated") or {}), **info}
    warn(f"row was {original} bytes, over the {MAX_ROW_BYTES} limit — cut {cut} field(s); S3 analysis.json keeps the full text")
    return row, info


def to_ddb(obj):
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: to_ddb(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [to_ddb(v) for v in obj]
    return obj


def build_item(workflow_id, analysis_id, analysis, metrics, dossier, trigger, truncated=None):
    """The analyses-table row. Pure (no AWS, no clock beyond analyzedAt) so the
    mapping decisions in it — the runOutcome fallback and the kpiVersion
    provenance — are unit-testable without a workspace."""
    phase = (dossier.get("workflow") or {}).get("phase", "complete")
    item = {
        "workflowId": workflow_id,
        "analysisId": analysis_id,
        "schemaVersion": SCHEMA_VERSION,
        # Which version of src/config/kpi.json produced metrics.kpi (TEAM-4484).
        # A weights change bumps it, so a row scored under v1 is never compared
        # against a v2 row as though the two numbers meant the same thing. None
        # when the run had no v5 card and the scores are the LLM's alone.
        "kpiVersion": metrics.get("kpiVersion") or analysis.get("kpiVersion") or None,
        "workflowDefId": dossier.get("workflowDefId") or "software-delivery",
        "epicId": dossier.get("epicId"),
        "analyzedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "trigger": trigger,
        "runOutcome": phase if phase in RUN_OUTCOMES else "complete",
        "model": MODEL_ID,
        "s3Prefix": f"workflows/{workflow_id}/analysis/{analysis_id}/",
        "metrics": row_metrics(metrics),
        "scores": analysis["scores"],
        "verdict": analysis["verdict"],
        "findings": analysis["findings"],
        "recommendations": analysis["recommendations"],
        "trend": analysis["trend"],
        "summaryMarkdown": analysis["summaryMarkdown"],
    }
    if truncated:
        item["truncated"] = truncated
    return item


def sightings(analysis, item):
    """The ledger occurrences this analysis records — pure, so the mapping is
    unit-testable without a table.

    One occurrence PER KEY, not per mention: a key named by both a finding and a
    recommendation is a single sighting in a single run, and counting it twice
    would inflate exactly the number the panel exists to report. The finding wins
    on severity (it has a real one) and the recommendation wins on title (it names
    the ask, not the symptom).

    `analysis` is the analysis as AUTHORED, before cap_analysis: a recommendation
    dropped over the count cap still names a defect that was seen in this run,
    and losing its sighting was the silent half of the cap (TEAM-5239). Dropped
    entries were never validated, so non-dicts and malformed keys are skipped
    here rather than trusted.
    """
    by_key = {}
    for f in analysis.get("findings") or []:
        if not isinstance(f, dict):
            continue
        key = f.get("patternKey")
        if not isinstance(key, str) or not si_ledger.is_valid_key(key):
            continue
        by_key.setdefault(key, {"title": f.get("title"), "severity": f.get("severity")})
    for r in analysis.get("recommendations") or []:
        if not isinstance(r, dict):
            continue
        key = r.get("patternKey")
        if not isinstance(key, str) or not si_ledger.is_valid_key(key):
            continue
        entry = by_key.setdefault(key, {"title": None, "severity": None})
        entry["title"] = r.get("title") or entry["title"]
        entry["severity"] = entry["severity"] or PRIORITY_SEVERITY.get(r.get("priority"))

    return [
        {
            "patternKey": key,
            "title": entry["title"],
            "occurrence": {
                "workflowId": item["workflowId"],
                # The analysisId makes the upsert idempotent: re-running ANALYZE
                # for the same run must not add a second sighting.
                "analysisId": item["analysisId"],
                "workflowDefId": item["workflowDefId"],
                "severity": entry["severity"],
                "at": item["analyzedAt"],
            },
        }
        for key, entry in by_key.items()
    ]


def record_sightings(analysis, item):
    """Upsert one occurrence per key. Runs AFTER the analysis is persisted and
    never raises: the analysis is the expensive artifact (a failed ANALYZE costs a
    full harness invocation) and the ledger is a mirror that the next analysis or
    the daily verify re-converges. Failures are returned so the WM reports them
    instead of discovering the gap weeks later."""
    plan = sightings(analysis, item)
    if not plan:
        return {"keys": [], "errors": []}
    ledger = si_ledger.SiLedger(table_name=SI_LEDGER_TABLE, region=REGION)
    keys, errors = [], []
    for entry in plan:
        try:
            ledger.upsert_occurrence(entry["patternKey"], entry["title"], entry["occurrence"])
            keys.append(entry["patternKey"])
        except Exception as e:  # noqa: BLE001 - reported, never fatal (see above)
            errors.append({"patternKey": entry["patternKey"], "error": str(e)})
    return {"keys": keys, "errors": errors}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workflow_id")
    parser.add_argument("--workspace", default=None)
    parser.add_argument("--trigger", default="auto", choices=["auto", "manual", "watch"])
    args = parser.parse_args()
    workspace = args.workspace or f"/mnt/workspace/{args.workflow_id}"

    merged = merge_sections(workspace)
    meta = None
    if merged is None:
        with open(os.path.join(workspace, "analysis.json")) as f:
            analysis = json.load(f)
    else:
        analysis, meta = merged
        # The assembled analysis, so the workspace holds what was saved. (Before
        # validation on purpose: a failed save still leaves the merge to inspect.)
        with open(os.path.join(workspace, "analysis.json"), "w") as f:
            json.dump(analysis, f, indent=1)
    with open(os.path.join(workspace, "metrics.json")) as f:
        metrics = json.load(f)
    with open(os.path.join(workspace, "dossier.json")) as f:
        dossier = json.load(f)

    authored = analysis
    analysis, truncated = cap_analysis(analysis)
    validate(analysis)

    analysis_id = f"{int(time.time() * 1000)}-{''.join(random.choices(string.ascii_lowercase + string.digits, k=4))}"
    item = build_item(args.workflow_id, analysis_id, analysis, metrics, dossier, args.trigger, truncated)
    # Bound the row BEFORE the first write: a row DynamoDB rejects must not leave
    # S3 objects behind. S3 analysis.json keeps the un-shrunk item.
    row, _ = fit_row(item)
    s3_prefix = item["s3Prefix"]

    s3 = boto3.client("s3", region_name=REGION)
    for name, payload in (
        ("analysis.json", item),
        ("metrics.json", metrics),
        ("dossier.json", dossier),
    ):
        s3.put_object(
            Bucket=ARTIFACT_BUCKET,
            Key=s3_prefix + name,
            Body=json.dumps(payload, indent=1, default=str).encode(),
            ContentType="application/json",
        )

    boto3.resource("dynamodb", region_name=REGION).Table(ANALYSES_TABLE).put_item(
        Item=to_ddb(row)
    )

    retire_sections(workspace, analysis_id)
    # From the AUTHORED analysis: an entry the count cap dropped still records
    # its sighting (see sightings).
    ledger = record_sightings(authored, row)

    print(json.dumps({
        "saved": True,
        "workflowId": args.workflow_id,
        "analysisId": analysis_id,
        "s3Prefix": f"s3://{ARTIFACT_BUCKET}/{s3_prefix}",
        "patternKeys": ledger["keys"],
        "truncated": row.get("truncated") or {},
        "manifest": meta["manifest"] if meta else None,
        "ignoredParts": meta["ignoredParts"] if meta else [],
        "ledgerErrors": ledger["errors"],
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        raise
