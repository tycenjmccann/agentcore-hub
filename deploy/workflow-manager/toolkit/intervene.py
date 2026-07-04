#!/usr/bin/env python3
"""The ONLY write path for Workflow Manager watch-mode interventions.

Every action is validated in code before executing — the model cannot bypass
these rules by prompting differently:
  - human review gates (`human:*` assignees, `in_review` status) are untouchable
  - nothing is ever transitioned to done/cancelled
  - unstick/retry delegate to the app's provider-aware endpoints (nudge/retry),
    so DynamoDB and Jira modes behave identically to a human clicking the UI

Every executed action publishes a `manager.intervention` event to the events
table, so it shows on the board timeline and in the next run analysis.

Usage:
  python3 intervene.py unstick  <workflowId> [--note "..."]
  python3 intervene.py retry    <workflowId> <agentId> [--note "..."]
  python3 intervene.py comment  <workflowId> <ticketId> <text>
  python3 intervene.py escalate <workflowId> <message>

Env: WORKFLOW_API_URL (App Runner base URL), EVENTS_TABLE, TICKETS_TABLE,
     WORKFLOWS_TABLE, AWS_REGION.
"""

import argparse
import json
import os
import random
import string
import sys
import time
import urllib.request
from datetime import datetime, timezone

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
API_URL = (os.environ.get("WORKFLOW_API_URL") or "").rstrip("/")
EVENTS_TABLE = os.environ.get("EVENTS_TABLE", "agentcore-hub-events")
TICKETS_TABLE = os.environ.get("TICKETS_TABLE", "agentcore-hub-tickets")
WORKFLOWS_TABLE = os.environ.get("WORKFLOWS_TABLE", "agentcore-hub-workflows")

dynamodb = boto3.resource("dynamodb", region_name=REGION)


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def event_id(tag):
    rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=4))
    return f"{int(time.time() * 1000)}-{tag}-{rand}"


def publish_intervention(workflow_id, action, extra):
    dynamodb.Table(EVENTS_TABLE).put_item(Item={
        "workflowId": workflow_id,
        "eventId": event_id("wm"),
        "type": "manager.intervention",
        "timestamp": now_iso(),
        "detail": {"action": action, "by": "workflow-manager", **extra},
    })


def api_post(path, body=None):
    if not API_URL:
        raise SystemExit("WORKFLOW_API_URL not set — cannot call app API")
    req = urllib.request.Request(
        f"{API_URL}{path}",
        data=json.dumps(body or {}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.loads(res.read().decode() or "{}")


def get_ticket(ticket_id):
    return dynamodb.Table(TICKETS_TABLE).get_item(Key={"ticketId": ticket_id}).get("Item")


def refuse_if_protected(ticket):
    """Hard rules — never negotiable regardless of what the model asks for."""
    if not ticket:
        raise SystemExit("REFUSED: ticket not found")
    assignee = str(ticket.get("assignee") or "")
    if assignee.startswith("human:"):
        raise SystemExit(f"REFUSED: {ticket['ticketId']} is a human review gate — humans only")
    if ticket.get("status") == "in_review":
        raise SystemExit(f"REFUSED: {ticket['ticketId']} is in_review — humans only")


def cmd_unstick(args):
    # Provider-aware, idempotent, and identical to the UI nudge button:
    # todo+no-blockers → ready, blocked+all-blockers-done → ready. Nothing else.
    result = api_post(f"/api/workflow/{args.workflow_id}/nudge")
    nudged = result.get("nudged", [])
    publish_intervention(args.workflow_id, "unstick", {
        "nudged": nudged, "ticketsScanned": result.get("ticketsScanned"),
        "note": args.note,
    })
    print(json.dumps({"action": "unstick", **result}, indent=2))


def cmd_retry(args):
    wf = dynamodb.Table(WORKFLOWS_TABLE).get_item(
        Key={"workflowId": args.workflow_id}
    ).get("Item")
    if not wf:
        raise SystemExit("REFUSED: workflow not found")
    for tid, task in (wf.get("agentTasks") or {}).items():
        if task.get("agentId") == args.agent_id or task.get("assignee") == args.agent_id:
            refuse_if_protected(get_ticket(tid) or {"ticketId": tid})
    result = api_post(f"/api/workflow/{args.workflow_id}/retry", {"agentId": args.agent_id})
    publish_intervention(args.workflow_id, "retry", {
        "agentId": args.agent_id, "ticketId": result.get("ticketId"), "note": args.note,
    })
    print(json.dumps({"action": "retry", **result}, indent=2))


def cmd_comment(args):
    ticket = get_ticket(args.ticket_id)
    refuse_if_protected(ticket)
    comment = {
        "id": event_id("cmt"),
        "author": "workflow-manager",
        "content": args.text,
        "timestamp": now_iso(),
    }
    dynamodb.Table(TICKETS_TABLE).update_item(
        Key={"ticketId": args.ticket_id},
        UpdateExpression=(
            "SET comments = list_append(if_not_exists(comments, :empty), :c), updatedAt = :u"
        ),
        ExpressionAttributeValues={":c": [comment], ":empty": [], ":u": now_iso()},
    )
    publish_intervention(args.workflow_id, "comment", {
        "ticketId": args.ticket_id, "note": args.text[:500],
    })
    print(json.dumps({"action": "comment", "ticketId": args.ticket_id}, indent=2))


def cmd_escalate(args):
    notification = {
        "id": f"notif_wm_{now_iso()}",
        "type": "manager_escalation",
        "title": "Workflow Manager escalation",
        "details": args.message,
        "reviewer": "workflow-manager",
        "timestamp": now_iso(),
        "acknowledged": False,
    }
    dynamodb.Table(WORKFLOWS_TABLE).update_item(
        Key={"workflowId": args.workflow_id},
        UpdateExpression=(
            "SET humanNotifications = list_append(if_not_exists(humanNotifications, :empty), :n)"
        ),
        ExpressionAttributeValues={":n": [notification], ":empty": []},
    )
    dynamodb.Table(EVENTS_TABLE).put_item(Item={
        "workflowId": args.workflow_id,
        "eventId": event_id("wmesc"),
        "type": "manager.escalation",
        "timestamp": now_iso(),
        "detail": {"message": args.message, "by": "workflow-manager"},
    })
    publish_intervention(args.workflow_id, "escalate", {"note": args.message[:500]})
    print(json.dumps({"action": "escalate", "workflowId": args.workflow_id}, indent=2))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("unstick")
    p.add_argument("workflow_id")
    p.add_argument("--note", default="")
    p.set_defaults(func=cmd_unstick)

    p = sub.add_parser("retry")
    p.add_argument("workflow_id")
    p.add_argument("agent_id")
    p.add_argument("--note", default="")
    p.set_defaults(func=cmd_retry)

    p = sub.add_parser("comment")
    p.add_argument("workflow_id")
    p.add_argument("ticket_id")
    p.add_argument("text")
    p.set_defaults(func=cmd_comment)

    p = sub.add_parser("escalate")
    p.add_argument("workflow_id")
    p.add_argument("message")
    p.set_defaults(func=cmd_escalate)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        raise
