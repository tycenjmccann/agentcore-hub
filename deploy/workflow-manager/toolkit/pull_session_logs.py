#!/usr/bin/env python3
"""Pull the CloudWatch evidence for one (usually dead) agent session.

Used by the crash-rca skill: given a runtime session id
(<ticketId>_<wfId>-<agentId>-<timestamp>), collect what that session left
behind in CloudWatch — application log tail from the shared + coding runtime
log groups, and the session's last OTEL spans — so the manager can diagnose
WHY the agent died instead of inferring from silence.

Span coverage note: newer runtimes write spans to their OWN runtime log group,
older setups to aws/spans — both are queried (same lesson as PR #90).

Usage:
  python3 pull_session_logs.py <sessionId> [--wf <workflowId>] [--hours 24]

Output: /mnt/workspace/<wfId|adhoc>/session-<sessionId-tail>.json
  {
    "sessionId": ...,
    "queried": [log groups searched],
    "logTail": [last ~80 app-log events mentioning the session],
    "spans": [last ~40 span records for the session, newest last, each
              reduced to {time, operation, tool, status, error, durationMs}],
    "lastActivity": {...the newest thing found anywhere...},
    "summary": {counts + first/last timestamps}
  }

Env: AWS_REGION. Requires logs:StartQuery/GetQueryResults/DescribeLogGroups
(WorkflowManagerData policy, Sid SessionLogsRead).
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
logs = boto3.client("logs", region_name=REGION)

RUNTIME_PREFIX = "/aws/bedrock-agentcore/runtimes/"
SPAN_FALLBACK_GROUP = "aws/spans"
LOG_TAIL_LIMIT = 80
SPAN_LIMIT = 40


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z")


def discover_log_groups():
    """All runtime log groups + the legacy span destination (if present)."""
    groups = []
    paginator = logs.get_paginator("describe_log_groups")
    for page in paginator.paginate(logGroupNamePrefix=RUNTIME_PREFIX):
        groups.extend(g["logGroupName"] for g in page.get("logGroups", []))
    try:
        page = logs.describe_log_groups(logGroupNamePrefix=SPAN_FALLBACK_GROUP)
        groups.extend(g["logGroupName"] for g in page.get("logGroups", [])
                      if g["logGroupName"] == SPAN_FALLBACK_GROUP)
    except Exception:
        pass
    return groups


def run_query(group_names, query, start, end, timeout_s=60):
    """Insights query across groups; returns rows as list of {field: value}."""
    try:
        qid = logs.start_query(
            logGroupNames=group_names,
            startTime=start,
            endTime=end,
            queryString=query,
        )["queryId"]
    except logs.exceptions.ResourceNotFoundException:
        return []
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        res = logs.get_query_results(queryId=qid)
        if res["status"] in ("Complete", "Failed", "Cancelled", "Timeout"):
            if res["status"] != "Complete":
                print(f"  ! query {res['status']} on {group_names[0]}...", file=sys.stderr)
            return [{f["field"]: f["value"] for f in row} for row in res.get("results", [])]
        time.sleep(2)
    return []


def reduce_span(raw):
    """Boil a span record down to what a crash diagnosis needs."""
    try:
        m = json.loads(raw)
    except Exception:
        return None
    attrs = m.get("attributes", {}) or {}
    # OTEL span exports vary: attributes live at the top level or under
    # resource/attributes depending on exporter version. Merge shallowly.
    for extra in (m.get("resource", {}).get("attributes", {}) or {},):
        for k, v in extra.items():
            attrs.setdefault(k, v)
    end_ns = m.get("endTimeUnixNano") or m.get("timeUnixNano") or 0
    start_ns = m.get("startTimeUnixNano") or 0
    return {
        "time": iso(int(end_ns) // 1_000_000) if end_ns else None,
        "operation": attrs.get("gen_ai.operation.name") or m.get("name"),
        "tool": attrs.get("gen_ai.tool.name") or attrs.get("tool.name"),
        "status": (m.get("status", {}) or {}).get("code"),
        "error": attrs.get("error.message") or attrs.get("error.type"),
        "durationMs": int((int(end_ns) - int(start_ns)) / 1_000_000) if end_ns and start_ns else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session_id")
    ap.add_argument("--wf", default="adhoc")
    ap.add_argument("--hours", type=int, default=24)
    args = ap.parse_args()

    sid = args.session_id
    end = int(time.time())
    start = end - args.hours * 3600
    groups = discover_log_groups()
    if not groups:
        raise SystemExit("No runtime log groups found — check IAM (logs:DescribeLogGroups)")

    # Insights caps logGroupNames; chunk to stay under it.
    chunks = [groups[i:i + 20] for i in range(0, len(groups), 20)]
    escaped = re.escape(sid)

    log_tail, spans = [], []
    for chunk in chunks:
        # App logs: any event mentioning the session id, excluding span JSON
        # (span records also embed session.id — they're collected separately).
        log_tail += run_query(
            chunk,
            f'fields @timestamp, @message, @log | filter @message like /{escaped}/'
            f' | filter @message not like /"traceId"/ | sort @timestamp desc | limit {LOG_TAIL_LIMIT}',
            start, end,
        )
        spans += run_query(
            chunk,
            f'fields @timestamp, @message | filter @message like /"traceId"/'
            f' | filter @message like /{escaped}/ | sort @timestamp desc | limit {SPAN_LIMIT}',
            start, end,
        )

    log_tail = sorted(log_tail, key=lambda r: r.get("@timestamp", ""))[-LOG_TAIL_LIMIT:]
    reduced_spans = [s for s in (reduce_span(r.get("@message", "")) for r in spans) if s]
    reduced_spans.sort(key=lambda s: s.get("time") or "")
    reduced_spans = reduced_spans[-SPAN_LIMIT:]

    candidates = []
    if log_tail:
        candidates.append(("log", log_tail[-1].get("@timestamp", ""),
                           log_tail[-1].get("@message", "")[:500]))
    if reduced_spans:
        s = reduced_spans[-1]
        candidates.append(("span", s.get("time") or "",
                           f"{s.get('operation')} tool={s.get('tool')} error={s.get('error')}"))
    candidates.sort(key=lambda c: c[1])
    last_activity = (
        {"kind": candidates[-1][0], "at": candidates[-1][1], "detail": candidates[-1][2]}
        if candidates else None
    )

    out = {
        "sessionId": sid,
        "queried": groups,
        "logTail": [
            {"at": r.get("@timestamp"), "group": r.get("@log", "").split(":")[-1],
             "message": r.get("@message", "")[:1000]}
            for r in log_tail
        ],
        "spans": reduced_spans,
        "lastActivity": last_activity,
        "summary": {
            "logEvents": len(log_tail),
            "spans": len(reduced_spans),
            "firstSeen": (log_tail[0].get("@timestamp") if log_tail else None),
            "lastSeen": last_activity["at"] if last_activity else None,
        },
    }

    dest_dir = f"/mnt/workspace/{args.wf}"
    os.makedirs(dest_dir, exist_ok=True)
    tail = sid.rsplit("-", 1)[-1]
    dest = f"{dest_dir}/session-{tail}.json"
    with open(dest, "w") as f:
        json.dump(out, f, indent=2)

    print(json.dumps({"written": dest, **out["summary"],
                      "lastActivity": last_activity}, indent=2))


if __name__ == "__main__":
    main()
