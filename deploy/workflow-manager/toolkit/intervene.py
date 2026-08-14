#!/usr/bin/env python3
"""The ONLY write path for Workflow Manager watch-mode interventions.

Every action is validated in code before executing — the model cannot bypass
these rules by prompting differently:
  - human review gates (`human:*` assignees, `in_review` status) are untouchable
  - `complete` refuses unless EVERY non-epic child ticket is done/cancelled
    (the API enforces this too) — the manager can close finished work, never
    fake it
  - unstick/retry/comment/dispatch/complete delegate to the app's
    provider-aware endpoints, so DynamoDB and Jira modes behave identically to
    a human clicking the UI

Every executed action publishes a `manager.intervention` event to the events
table, so it shows on the board timeline and in the next run analysis.

`escalate` is idempotent: an identical open (unacknowledged) escalation is
never appended twice, so the manager can't re-raise the same flag every pass.
When a run is dead and shouldn't keep paging, the manager decides to `mute` it —
that judgment is the agent's, not a coded cap.

Usage:
  python3 intervene.py unstick  <workflowId> [--note "..."]
  python3 intervene.py retry    <workflowId> <agentId> [--note "..."]
  python3 intervene.py dispatch <workflowId> <ticketId> [--note "..."]
  python3 intervene.py comment  <workflowId> <ticketId> <text>
  python3 intervene.py escalate <workflowId> <message>
  python3 intervene.py complete <workflowId> [--reason "..."]
  python3 intervene.py mute     <workflowId> [--note "..."]

Env: WORKFLOW_API_URL (app base URL), EVENTS_TABLE, TICKETS_TABLE,
     WORKFLOWS_TABLE, TICKET_PROVIDER (dynamodb|jira), AWS_REGION.
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
TICKET_PROVIDER = os.environ.get("TICKET_PROVIDER", "dynamodb")

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
    # Local guard only in DynamoDB mode — in Jira mode the DDB tickets table is
    # optional/absent and get_ticket() hard-fails (ResourceNotFoundException),
    # blocking every retry. Same pattern as cmd_comment: the retry endpoint
    # itself refuses done/in_review/cancelled work, so the guard is still
    # enforced server-side.
    if TICKET_PROVIDER != "jira":
        for tid, task in (wf.get("agentTasks") or {}).items():
            if task.get("agentId") == args.agent_id or task.get("assignee") == args.agent_id:
                refuse_if_protected(get_ticket(tid) or {"ticketId": tid})
    result = api_post(f"/api/workflow/{args.workflow_id}/retry", {"agentId": args.agent_id})
    publish_intervention(args.workflow_id, "retry", {
        "agentId": args.agent_id, "ticketId": result.get("ticketId"), "note": args.note,
    })
    print(json.dumps({"action": "retry", **result}, indent=2))


def cmd_comment(args):
    # Route through the app's provider-aware endpoint (same as unstick/retry) so
    # the comment lands in the canonical store: Jira when TICKET_PROVIDER=jira,
    # DynamoDB otherwise. Writing straight to TICKETS_TABLE here would miss Jira
    # entirely and, in Jira mode, touch an unused shadow row.
    #
    # In DynamoDB mode we can still enforce the human-gate guard locally from the
    # ticket row. In Jira mode the DDB tickets table is optional/absent, so the
    # guard is best-effort — the endpoint itself refuses to create shadow rows.
    if TICKET_PROVIDER != "jira":
        refuse_if_protected(get_ticket(args.ticket_id))

    result = api_post(f"/api/workflow/{args.workflow_id}/tickets/comment", {
        "ticketId": args.ticket_id,
        "author": "workflow-manager",
        "content": args.text,
    })
    publish_intervention(args.workflow_id, "comment", {
        "ticketId": args.ticket_id, "note": args.text[:500],
    })
    print(json.dumps({"action": "comment", "ticketId": args.ticket_id, **result}, indent=2))


def _set_manager_watch(workflow_id, on):
    dynamodb.Table(WORKFLOWS_TABLE).update_item(
        Key={"workflowId": workflow_id},
        UpdateExpression="SET managerWatch = :w",
        ExpressionAttributeValues={":w": on},
    )


def cmd_dispatch(args):
    """Re-queue a ticket that was never picked up (in the roster but no agent
    ever ran it — no agent.started, no error). Distinct from `retry`, which
    only resets an actively-running task that appears dead. Routes through the
    same provider-aware nudge endpoint the UI uses, so it works in Jira mode."""
    if TICKET_PROVIDER != "jira":
        refuse_if_protected(get_ticket(args.ticket_id))
    result = api_post(f"/api/workflow/{args.workflow_id}/nudge",
                      {"ticketId": args.ticket_id})
    publish_intervention(args.workflow_id, "dispatch", {
        "ticketId": args.ticket_id, "note": args.note,
        "nudged": result.get("nudged"),
    })
    print(json.dumps({"action": "dispatch", "ticketId": args.ticket_id, **result}, indent=2))


def cmd_complete(args):
    """Close out a run whose work is actually finished but whose bookkeeping
    never rolled up. The API refuses (409) unless every non-epic child is
    done/cancelled — this is an honest close with no bypass. If it refuses,
    the run genuinely has open work: `dispatch` it or `escalate`, don't force."""
    body = {"reason": args.reason or "Closed by Workflow Manager: work finished, bookkeeping rolled up."}
    result = api_post(f"/api/workflow/{args.workflow_id}/complete", body)
    publish_intervention(args.workflow_id, "complete", {"note": args.reason})
    print(json.dumps({"action": "complete", "workflowId": args.workflow_id, **result}, indent=2))


def cmd_mute(args):
    """Circuit breaker: stop watching a run that cannot be moved (no diagnosable
    cause, work not verifiably done). Sets managerWatch=false so the watch
    scheduler skips it and it stops paging — without touching any ticket or
    faking completion. A human can re-enable by clearing the flag."""
    _set_manager_watch(args.workflow_id, False)
    publish_intervention(args.workflow_id, "mute", {"note": args.note})
    print(json.dumps({"action": "mute", "workflowId": args.workflow_id, "managerWatch": False}, indent=2))


def cmd_escalate(args):
    # Idempotent: never append a second copy of an already-open (unacknowledged)
    # escalation with the same message. This stops the manager re-raising the
    # identical flag every pass — the source of the 400+ duplicate escalations
    # that bloated stuck records. Judgment about WHEN to stop escalating and mute
    # a dead run is the manager's (via the `mute` action), not a coded cap.
    wf = dynamodb.Table(WORKFLOWS_TABLE).get_item(
        Key={"workflowId": args.workflow_id}
    ).get("Item") or {}
    notifs = wf.get("humanNotifications") or []
    open_dupe = any(
        n.get("type") == "manager_escalation"
        and n.get("details") == args.message
        and not n.get("acknowledged")
        for n in notifs
    )
    if open_dupe:
        publish_intervention(args.workflow_id, "escalate_suppressed",
                             {"reason": "duplicate-open", "note": args.message[:500]})
        print(json.dumps({"action": "escalate", "suppressed": "duplicate open escalation already exists",
                          "workflowId": args.workflow_id}, indent=2))
        return

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

    p = sub.add_parser("dispatch")
    p.add_argument("workflow_id")
    p.add_argument("ticket_id")
    p.add_argument("--note", default="")
    p.set_defaults(func=cmd_dispatch)

    p = sub.add_parser("comment")
    p.add_argument("workflow_id")
    p.add_argument("ticket_id")
    p.add_argument("text")
    p.set_defaults(func=cmd_comment)

    p = sub.add_parser("escalate")
    p.add_argument("workflow_id")
    p.add_argument("message")
    p.set_defaults(func=cmd_escalate)

    p = sub.add_parser("complete")
    p.add_argument("workflow_id")
    p.add_argument("--reason", default="")
    p.set_defaults(func=cmd_complete)

    p = sub.add_parser("mute")
    p.add_argument("workflow_id")
    p.add_argument("--note", default="")
    p.set_defaults(func=cmd_mute)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        raise
