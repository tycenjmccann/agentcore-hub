#!/usr/bin/env python3
"""Validate and persist a workflow analysis. The ONLY write path for analyses —
the Workflow Manager cannot malform the DDB row because validation happens here.

Usage:
  python3 save_analysis.py <workflowId> [--workspace DIR] [--trigger auto|manual|watch]

Reads {workspace}/analysis.json (the LLM-authored fields), {workspace}/metrics.json,
{workspace}/dossier.json. Writes:
  - DDB ANALYSES_TABLE item {workflowId, analysisId, ...}
  - s3://$ARTIFACT_BUCKET/workflows/{wfId}/analysis/{analysisId}/{analysis,metrics,dossier}.json
  - DDB SI_LEDGER_TABLE: one occurrence per patternKey named by this analysis

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


def fail(msg):
    raise SystemExit(f"VALIDATION FAILED: {msg}")


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


def to_ddb(obj):
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: to_ddb(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [to_ddb(v) for v in obj]
    return obj


def build_item(workflow_id, analysis_id, analysis, metrics, dossier, trigger):
    """The analyses-table row. Pure (no AWS, no clock beyond analyzedAt) so the
    mapping decisions in it — the runOutcome fallback and the kpiVersion
    provenance — are unit-testable without a workspace."""
    phase = (dossier.get("workflow") or {}).get("phase", "complete")
    return {
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
        "metrics": metrics,
        "scores": analysis["scores"],
        "verdict": analysis["verdict"],
        "findings": analysis["findings"],
        "recommendations": analysis["recommendations"],
        "trend": analysis["trend"],
        "summaryMarkdown": analysis["summaryMarkdown"],
    }


def sightings(analysis, item):
    """The ledger occurrences this analysis records — pure, so the mapping is
    unit-testable without a table.

    One occurrence PER KEY, not per mention: a key named by both a finding and a
    recommendation is a single sighting in a single run, and counting it twice
    would inflate exactly the number the panel exists to report. The finding wins
    on severity (it has a real one) and the recommendation wins on title (it names
    the ask, not the symptom).
    """
    by_key = {}
    for f in analysis.get("findings") or []:
        key = f.get("patternKey")
        if not isinstance(key, str) or not key:
            continue
        by_key.setdefault(key, {"title": f.get("title"), "severity": f.get("severity")})
    for r in analysis.get("recommendations") or []:
        key = r.get("patternKey")
        if not isinstance(key, str) or not key:
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

    with open(os.path.join(workspace, "analysis.json")) as f:
        analysis = json.load(f)
    with open(os.path.join(workspace, "metrics.json")) as f:
        metrics = json.load(f)
    with open(os.path.join(workspace, "dossier.json")) as f:
        dossier = json.load(f)

    validate(analysis)

    analysis_id = f"{int(time.time() * 1000)}-{''.join(random.choices(string.ascii_lowercase + string.digits, k=4))}"
    item = build_item(args.workflow_id, analysis_id, analysis, metrics, dossier, args.trigger)
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
        Item=to_ddb(item)
    )

    ledger = record_sightings(analysis, item)

    print(json.dumps({
        "saved": True,
        "workflowId": args.workflow_id,
        "analysisId": analysis_id,
        "s3Prefix": f"s3://{ARTIFACT_BUCKET}/{s3_prefix}",
        "patternKeys": ledger["keys"],
        "ledgerErrors": ledger["errors"],
    }, indent=2))


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        raise
