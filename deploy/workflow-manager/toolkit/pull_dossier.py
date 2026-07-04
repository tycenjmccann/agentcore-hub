#!/usr/bin/env python3
"""Pull the complete run dossier for a workflow into the workspace.

Usage: python3 pull_dossier.py <workflowId> [--workspace DIR]

Reads (table/bucket names from env, agentcore-hub defaults):
  - workflow row       WORKFLOWS_TABLE
  - workflow def       s3://$ARTIFACT_BUCKET/config/workflows.json
  - tickets            TICKETS_TABLE (workflowId scan + epic GetItem)
  - events             EVENTS_TABLE — PK=workflowId AND PK=each ticketId AND
                       PK=epicId. publishEvent keys rows by
                       `detail.workflowId || ticketId`, so events like
                       agent.started land under the ticket's PK, not the run's.
  - completions        s3://$ARTIFACT_BUCKET/completions/{ticketId}.json
  - artifact listing   s3://$ARTIFACT_BUCKET/workflows/{workflowId}/
  - eval summaries     EVAL_CONFIG_TABLE rows for participating agents
                       (fleet-lifetime rolling scores — NOT per-run)
  - prior analyses     ANALYSES_TABLE workflowDefId-index (last 5, compact)

Writes {workspace}/dossier.json. Streaming chunk events (agent.streaming) are
not stored in the dossier — they are reduced to per-agent counters.
"""

import argparse
import json
import os
import sys
import urllib.request
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

REGION = os.environ.get("AWS_REGION", "us-east-1")
ARTIFACT_BUCKET = os.environ["ARTIFACT_BUCKET"]
WORKFLOWS_TABLE = os.environ.get("WORKFLOWS_TABLE", "agentcore-hub-workflows")
TICKETS_TABLE = os.environ.get("TICKETS_TABLE", "agentcore-hub-tickets")
EVENTS_TABLE = os.environ.get("EVENTS_TABLE", "agentcore-hub-events")
EVAL_CONFIG_TABLE = os.environ.get("EVAL_CONFIG_TABLE", "agentcore-hub-eval-config")
ANALYSES_TABLE = os.environ.get("ANALYSES_TABLE", "agentcore-hub-workflow-analyses")
TICKET_PROVIDER = os.environ.get("TICKET_PROVIDER", "dynamodb")
WORKFLOW_API_URL = (os.environ.get("WORKFLOW_API_URL") or "").rstrip("/")

COMPLETION_SUMMARY_CAP = 4000
ARTIFACT_LISTING_CAP = 200
PRIOR_ANALYSES_LIMIT = 5

dynamodb = boto3.resource("dynamodb", region_name=REGION)
s3 = boto3.client("s3", region_name=REGION)


def undecimal(obj):
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    if isinstance(obj, dict):
        return {k: undecimal(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [undecimal(v) for v in obj]
    return obj


def get_workflow(workflow_id):
    item = dynamodb.Table(WORKFLOWS_TABLE).get_item(Key={"workflowId": workflow_id}).get("Item")
    if not item:
        raise SystemExit(f"Workflow {workflow_id} not found in {WORKFLOWS_TABLE}")
    return undecimal(item)


def get_workflow_def(def_id):
    try:
        body = s3.get_object(Bucket=ARTIFACT_BUCKET, Key="config/workflows.json")["Body"].read()
        parsed = json.loads(body) if body else []
        # workflows.json may be a bare list or {"workflows": [...]}.
        defs = parsed.get("workflows", []) if isinstance(parsed, dict) else parsed
        for d in defs:
            if d.get("id") == def_id:
                return d
        for d in defs:
            if d.get("id") == "software-delivery":
                return d
    except Exception as e:
        print(f"warn: could not load workflow def: {e}", file=sys.stderr)
    return None


def normalize_blocked_by(val):
    """The app's Jira reader returns blockedBy as a comma-joined string; DDB
    stores a list. Normalize to a list so metrics treats both identically."""
    if isinstance(val, str):
        return [v for v in (s.strip() for s in val.split(",")) if v]
    if isinstance(val, list):
        return val
    return []


def get_tickets_via_api(workflow_id):
    """Provider-aware path: the app's /tickets endpoint reads Jira OR DynamoDB
    per TICKET_PROVIDER and returns identically-shaped tickets (full fidelity —
    real blockedBy, status, assignee, description). Single source of truth.
    Returns None if the API URL is unset or the call fails."""
    if not WORKFLOW_API_URL:
        return None
    url = f"{WORKFLOW_API_URL}/api/workflow/{workflow_id}/tickets"
    try:
        with urllib.request.urlopen(url, timeout=45) as resp:
            payload = json.loads(resp.read().decode() or "{}")
    except Exception as e:
        print(f"warn: /tickets API failed ({e}) — falling back to direct DynamoDB", file=sys.stderr)
        return None
    tickets = payload.get("tickets", [])
    for t in tickets:
        t["blockedBy"] = normalize_blocked_by(t.get("blockedBy"))
    return [t for t in tickets if t.get("ticketId") != "__COUNTER__"]


def get_tickets_ddb(workflow_id, epic_id):
    """Direct-DynamoDB fallback (dynamodb provider, no API URL). Returns None if
    the table doesn't exist (jira mode with no API URL — unrecoverable)."""
    table = dynamodb.Table(TICKETS_TABLE)
    tickets, kwargs = [], {
        "FilterExpression": "workflowId = :wid",
        "ExpressionAttributeValues": {":wid": workflow_id},
    }
    try:
        while True:
            page = table.scan(**kwargs)
            tickets.extend(page.get("Items", []))
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
        seen = {t["ticketId"] for t in tickets}
        if epic_id and epic_id not in seen:
            epic = table.get_item(Key={"ticketId": epic_id}).get("Item")
            if epic:
                tickets.append(epic)
    except table.meta.client.exceptions.ResourceNotFoundException:
        return None
    out = []
    for t in tickets:
        if t.get("ticketId") == "__COUNTER__":
            continue
        t = undecimal(t)
        t["blockedBy"] = normalize_blocked_by(t.get("blockedBy"))
        out.append(t)
    return out


def get_tickets(workflow_id, epic_id, missing):
    """Provider-aware ticket load: prefer the app API (handles Jira + DynamoDB
    identically), fall back to direct DynamoDB scan."""
    tickets = get_tickets_via_api(workflow_id)
    if tickets is not None:
        return tickets
    tickets = get_tickets_ddb(workflow_id, epic_id)
    if tickets is None:
        missing.append(
            f"tickets unavailable: provider={TICKET_PROVIDER}, no WORKFLOW_API_URL and "
            f"no {TICKETS_TABLE} table — ticket-derived metrics degraded"
        )
        return []
    return tickets


# Event types worth keeping verbatim; agent.streaming is reduced to counters.
SIGNIFICANT_PREFIXES = (
    "agent.", "workflow.", "review.", "orchestrator.", "ticket.", "manager.",
)


def get_events(workflow_id, epic_id, ticket_ids):
    table = dynamodb.Table(EVENTS_TABLE)
    events, stream_counts = [], {}
    pks = [workflow_id] + ([epic_id] if epic_id else []) + list(ticket_ids)
    for pk in dict.fromkeys(pks):
        kwargs = {"KeyConditionExpression": Key("workflowId").eq(pk)}
        while True:
            page = table.query(**kwargs)
            for item in page.get("Items", []):
                etype = item.get("type", "")
                if etype == "agent.streaming":
                    detail = item.get("detail", {}) or {}
                    agent = detail.get("agentId", "unknown")
                    sub = detail.get("type", "text")
                    counts = stream_counts.setdefault(agent, {"text": 0, "trace": 0, "reasoning": 0})
                    counts[sub] = counts.get(sub, 0) + 1
                    continue
                if etype == "agent.started" and not (item.get("detail") or {}).get("workflowId"):
                    item["_pkNote"] = "ticket-keyed"
                if etype.startswith(SIGNIFICANT_PREFIXES):
                    events.append(undecimal(item))
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    dedup = {(e.get("workflowId"), e.get("eventId")): e for e in events}
    events = sorted(dedup.values(), key=lambda e: (e.get("timestamp", ""), e.get("eventId", "")))
    return events, stream_counts


def get_completions(ticket_ids):
    completions = {}
    for tid in ticket_ids:
        try:
            body = s3.get_object(Bucket=ARTIFACT_BUCKET, Key=f"completions/{tid}.json")["Body"].read()
            c = json.loads(body)
            summary = c.get("summary")
            if isinstance(summary, str) and len(summary) > COMPLETION_SUMMARY_CAP:
                c["summary"] = summary[:COMPLETION_SUMMARY_CAP] + "\n…[truncated]"
                c["summaryTruncated"] = True
            completions[tid] = c
        except s3.exceptions.NoSuchKey:
            continue
        except Exception as e:
            print(f"warn: completion {tid}: {e}", file=sys.stderr)
    return completions


def get_artifacts(workflow_id):
    keys, kwargs = [], {"Bucket": ARTIFACT_BUCKET, "Prefix": f"workflows/{workflow_id}/"}
    truncated = False
    while True:
        page = s3.list_objects_v2(**kwargs)
        for obj in page.get("Contents", []):
            if len(keys) >= ARTIFACT_LISTING_CAP:
                truncated = True
                break
            keys.append({"key": obj["Key"], "size": obj["Size"]})
        if truncated or not page.get("IsTruncated"):
            break
        kwargs["ContinuationToken"] = page["NextContinuationToken"]
    return keys, truncated


def get_eval_summaries(agent_ids):
    table = dynamodb.Table(EVAL_CONFIG_TABLE)
    summaries = []
    for agent_id in sorted(agent_ids):
        try:
            item = table.get_item(Key={"agentId": agent_id}).get("Item")
        except Exception:
            item = None
        if not item:
            continue
        scores = undecimal(item.get("evalScores") or {})
        avg = {
            name: round(v["sum"] / v["count"], 4)
            for name, v in scores.items()
            if isinstance(v, dict) and v.get("count")
        }
        summaries.append({
            "agentId": agent_id,
            "sessionCount": undecimal(item.get("evalSessionCount", 0)),
            "avgScores": avg,
        })
    return summaries


def get_prior_analyses(workflow_def_id, workflow_id, missing):
    try:
        page = dynamodb.Table(ANALYSES_TABLE).query(
            IndexName="workflowDefId-index",
            KeyConditionExpression=Key("workflowDefId").eq(workflow_def_id),
            ScanIndexForward=False,
            Limit=PRIOR_ANALYSES_LIMIT + 1,
        )
    except Exception as e:
        missing.append(f"prior analyses unavailable: {e}")
        return []
    prior = []
    for item in page.get("Items", []):
        item = undecimal(item)
        if item.get("workflowId") == workflow_id:
            continue
        m = item.get("metrics") or {}
        prior.append({
            "analysisId": item.get("analysisId"),
            "workflowId": item.get("workflowId"),
            "analyzedAt": item.get("analyzedAt"),
            "runOutcome": item.get("runOutcome"),
            "scores": item.get("scores"),
            "verdict": item.get("verdict"),
            "totalDurationMs": m.get("totalDurationMs"),
            "humanWaitTotalMs": m.get("humanWaitTotalMs"),
            "changeRequestCount": (m.get("changeRequests") or {}).get("count"),
        })
    return prior[:PRIOR_ANALYSES_LIMIT]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workflow_id")
    parser.add_argument("--workspace", default=None)
    args = parser.parse_args()

    workspace = args.workspace or f"/mnt/workspace/{args.workflow_id}"
    os.makedirs(workspace, exist_ok=True)

    missing = []
    workflow = get_workflow(args.workflow_id)
    epic_id = workflow.get("epicId")
    def_id = workflow.get("workflowDefId") or "software-delivery"
    workflow_def = get_workflow_def(def_id)
    if workflow_def is None:
        missing.append("workflow def not found in config/workflows.json")

    tickets = get_tickets(args.workflow_id, epic_id, missing)
    ticket_ids = [t["ticketId"] for t in tickets]
    events, stream_counts = get_events(args.workflow_id, epic_id, ticket_ids)
    if not any(e.get("type") == "workflow.phase_change" for e in events):
        missing.append("no phase_change events")

    completions = get_completions(ticket_ids)
    artifacts, artifacts_truncated = get_artifacts(args.workflow_id)
    if artifacts_truncated:
        missing.append(f"artifact listing capped at {ARTIFACT_LISTING_CAP}")

    agent_ids = {
        t.get("assignee") for t in tickets
        if t.get("assignee") and not str(t.get("assignee")).startswith("human:")
        and t.get("type") != "epic"
    }
    eval_summaries = get_eval_summaries(agent_ids)
    prior = get_prior_analyses(def_id, args.workflow_id, missing)

    dossier = {
        "workflowId": args.workflow_id,
        "workflowDefId": def_id,
        "epicId": epic_id,
        "ticketProvider": os.environ.get("TICKET_PROVIDER", "dynamodb"),
        "workflow": workflow,
        "workflowDef": workflow_def,
        "tickets": tickets,
        "events": events,
        "streamCounts": stream_counts,
        "completions": completions,
        "artifacts": artifacts,
        "evalSummaries": eval_summaries,
        "priorAnalyses": prior,
        "missingSignals": missing,
    }

    out = os.path.join(workspace, "dossier.json")
    with open(out, "w") as f:
        json.dump(dossier, f, indent=1, default=str)
    print(json.dumps({
        "dossier": out,
        "tickets": len(tickets),
        "events": len(events),
        "completions": len(completions),
        "artifacts": len(artifacts),
        "priorAnalyses": len(prior),
        "missingSignals": missing,
    }, indent=2))


if __name__ == "__main__":
    main()
