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
An open escalation IS a human gate: the watch scheduler skips the run until a
human resolves it (Telegram "Resolved" button / escalations API), so escalating
both alerts the human and stops the watch loop from re-firing.

The two stuck-agent decisions (the common case) are `retry` and `mark-done`:
  - work is NOT done (no deliverable) → `retry` the agent
  - work IS done (deliverable shipped, agent died before report_completion) →
    `mark-done` the ticket with evidence, so the next phase starts

Usage:
  python3 intervene.py unstick   <workflowId> [--note "..."]
  python3 intervene.py retry     <workflowId> <agentId> [--note "..."] [--resume]
  python3 intervene.py mark-done <workflowId> <ticketId> --evidence "PR #87 / s3 key / streamed PASS" [--force]
                                 (--force overwrites evidence the ticket already carries; without it the
                                  server refuses with 409 EVIDENCE_EXISTS and keeps the agent's own report)
  python3 intervene.py dispatch  <workflowId> <ticketId> [--note "..."] [--resume]
  python3 intervene.py comment   <workflowId> <ticketId> <text>
  python3 intervene.py escalate  <workflowId> <message>
  python3 intervene.py complete  <workflowId> [--reason "..."]
  python3 intervene.py cancel    <workflowId> --reason "..."   (explicit user request ONLY)
  python3 intervene.py start     --title "..." [--description "..."] [--def <workflowDefId> | --type feature|bug] [--repo owner/name] [--branch main]
  python3 intervene.py file-bug  [<workflowId>] --title "..." --description "..." [--agent <agentId>] [--repo owner/name]
                                 (--agent selects crash mode; plain bugs omit it and may omit <workflowId>)
  python3 intervene.py bugs-off  [--note "..."]   (operator said stop → suppress ALL automated bug filing)
  python3 intervene.py bugs-on   [--note "..."]

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
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        # Refusals are TYPED by the API (`code`), so each one gets the operator
        # note that actually resolves it. An untyped 409 (e.g. completing an
        # already-terminal workflow) has no escape hatch and must not be dressed
        # up as one.
        payload = {}
        try:
            parsed = json.loads(detail)
            if isinstance(parsed, dict):
                payload = parsed
        except ValueError:
            pass
        code = payload.get("code")
        message = payload.get("message") or payload.get("error") or detail
        if e.code == 409 and code == "LEASE_LIVE":
            # Live invocation lease (R3): the agent is likely still working.
            raise SystemExit(
                f"REFUSED (lease live): {detail}\n"
                "Verify death first (pull_dossier lastText / session logs). "
                "If genuinely dead, re-run with --force."
            )
        if e.code == 409 and code == "PR_EXISTS":
            # TEAM-3991 D1.5 — the agent already has a PR for this ticket. A cold
            # re-dispatch makes it re-investigate work that is already on GitHub
            # (prod TEAM-3790). Exit 2 so a caller can branch on "resumable"
            # rather than parsing prose.
            print(
                f"REFUSED (PR exists): PR #{payload.get('number')} exists — resume, don't re-investigate.\n"
                f"{message}\n"
                f"  PR:   {payload.get('prUrl')} ({payload.get('state')}"
                f"{', merged' if payload.get('merged') else ''})\n"
                "  Next: read the PR (and its review comments) first. If the agent should carry on "
                "from it, re-run with --resume; the agent is then handed a resume context instead of "
                "a blank session. If the PR already contains the work, `mark-done` it instead.",
                file=sys.stderr,
            )
            raise SystemExit(2)
        if e.code == 409 and code == "EVIDENCE_EXISTS":
            # TEAM-4099 F6 — the ticket already carries evidence and a mark-done
            # never replaces it. The endpoint speaks JSON (`force: true`); the
            # operator's escape hatch is the flag.
            raise SystemExit(
                f"REFUSED (evidence exists): {message}\n"
                f"  Kept: evidenceSource={payload.get('evidenceSource') or 'unknown'}\n"
                "  Stale board only? Transition the ticket — the evidence is already there.\n"
                "  Recorded evidence actually wrong? Re-run with --force (the override is logged as yours)."
            )
        if e.code == 409 and code:
            raise SystemExit(f"REFUSED ({code}): {message}")
        raise SystemExit(f"API {e.code}: {detail}")


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
    body = {"agentId": args.agent_id}
    if getattr(args, "force", False):
        body["force"] = True
    # TEAM-3991 D1.5 — without --resume the endpoint refuses (409 PR_EXISTS) when
    # the agent already has a PR for this ticket, because a cold restart makes it
    # re-investigate work that is already on GitHub. With --resume it proceeds and
    # the agent is handed a resume context pointing at that PR.
    if getattr(args, "resume", False):
        body["resume"] = True
    result = api_post(f"/api/workflow/{args.workflow_id}/retry", body)
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


def cmd_dispatch(args):
    """Re-queue a ticket that was never picked up (in the roster but no agent
    ever ran it — no agent.started, no error). Distinct from `retry`, which
    only resets an actively-running task that appears dead. Routes through the
    same provider-aware nudge endpoint the UI uses, so it works in Jira mode."""
    if TICKET_PROVIDER != "jira":
        refuse_if_protected(get_ticket(args.ticket_id))
    body = {"ticketId": args.ticket_id}
    if getattr(args, "force", False):
        body["force"] = True
    # See cmd_retry — same PR-aware guard on the dispatch path (D1.5).
    if getattr(args, "resume", False):
        body["resume"] = True
    result = api_post(f"/api/workflow/{args.workflow_id}/nudge", body)
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


def cmd_mark_done(args):
    """Close ONE stuck ticket whose agent finished the work but died before
    calling report_completion — so the next phase can start.

    This is the "work IS done" branch of a stuck-agent decision (the other is
    `retry`, for "work is NOT done"). Use it ONLY with concrete evidence the
    deliverable shipped: the expected artifact is in S3, a PR exists on GitHub,
    or the agent's own streamed verdict (dossier streamCounts[agent].lastText)
    states it passed (which may itself cite a PR/URL). That evidence is REQUIRED
    and is recorded verbatim:

      1. Posts `--evidence` as a ticket comment (the audit trail: WHY this was
         safe to close), then
      2. Transitions the ticket to done, which cascades the next phase.

    The evidence is not optional — closing a ticket with no proof the work
    shipped is exactly the false-green this guards against. If you cannot cite
    the deliverable, the work is NOT done: `retry` instead.

    TEAM-3991 D1.3 — this is now ONE call to
    `POST /api/workflow/<id>/tickets/mark-done`, which owns the whole operation
    server-side: it harvests evidence in priority order (the agent's own
    `completions/<ticketId>.json` record → a GitHub branch/PR probe → the
    `--evidence` text as a last resort), writes it onto the task entry stamped
    `evidenceSource: "manager"`, then transitions. Two reasons the work moved
    there and not here:

      * the harvest can find REAL evidence (the record the agent wrote just
        before dying, or the branch it pushed) and prefer it over the operator's
        prose, so the run carries the agent's actual deliverable forward;
      * `markedDoneBy` is taken from the authenticated request identity, not from
        anything this client sends — an attribution the toolkit cannot forge.

    The client-side human-gate guard below is kept deliberately: the server
    refuses too (409 PROTECTED_TICKET), but refusing before the network call
    means an operator pointed at a human review gate is told so immediately.

    TEAM-4099 F6 — a mark-done FILLS gaps, it never clobbers. If the task entry
    already carries an `output` (the agent's real deliverable), the server
    refuses with 409 EVIDENCE_EXISTS and names the evidenceSource it kept.
    `--force` is the deliberate override for the rare case where the recorded
    evidence is known wrong; it overwrites the row and the completions record,
    and the `manager.intervention` event carries `forced: true`. Prefer no
    --force: if the evidence is right but the board is stale, transition the
    ticket instead of overwriting the proof."""
    if not (args.evidence or "").strip():
        raise SystemExit(
            "REFUSED: mark-done requires --evidence citing the shipped deliverable "
            "(S3 artifact key, PR URL, or the agent's streamed PASS verdict). "
            "No proof = not done → use `retry`."
        )
    if TICKET_PROVIDER != "jira":
        refuse_if_protected(get_ticket(args.ticket_id))
    force = bool(getattr(args, "force", False))
    result = api_post(f"/api/workflow/{args.workflow_id}/tickets/mark-done", {
        "ticketId": args.ticket_id,
        "evidence": args.evidence,
        **({"force": True} if force else {}),
    })
    publish_intervention(args.workflow_id, "mark_done", {
        "ticketId": args.ticket_id, "evidence": args.evidence[:500],
        "evidenceSource": result.get("evidenceSource"),
        **({"forced": True} if force else {}),
    })
    # Which evidence the server actually recorded matters to the operator: a
    # `manager` source means it fell back to the text they typed, while a branch /
    # PR / record source means the agent's real deliverable was found and carried
    # forward.
    print(json.dumps({
        "action": "mark_done", "ticketId": args.ticket_id,
        "evidenceSource": result.get("evidenceSource"),
        "branch": result.get("branch"),
        "commitSha": result.get("commitSha"),
        "prUrl": result.get("prUrl"),
        **result,
    }, indent=2))


def cmd_cancel(args):
    """Cancel a live run. This is destructive-ish (non-done tickets get
    cancelled; in-flight agents finish but their work is orphaned), so it is
    reserved for an EXPLICIT user instruction — never use it on your own
    judgment during WATCH. A mandatory --reason records who asked and why."""
    if not (args.reason or "").strip():
        raise SystemExit("REFUSED: cancel requires --reason quoting the user's explicit request")
    result = api_post(f"/api/workflow/{args.workflow_id}/cancel",
                      {"reason": args.reason})
    publish_intervention(args.workflow_id, "cancel", {"note": args.reason})
    print(json.dumps({"action": "cancel", "workflowId": args.workflow_id, **result}, indent=2))


def cmd_start(args):
    """Start a new workflow run — the same entry point the UI and Telegram
    feature intake use. Only on explicit user request (e.g. 'restart that with
    these instructions'). Returns workflowId + epicId.

    Pipeline selection (mutually exclusive, both optional):
      --def <workflowDefId>  run against a specific workflow definition
      --type feature|bug     pick the built-in feature or bug pipeline
    With neither flag the body is unchanged from the historical default
    (`workflowType: "feature"`). An explicitly empty/whitespace --def is
    refused rather than silently falling through to that default."""
    if not (args.title or "").strip():
        raise SystemExit("REFUSED: start requires --title")
    if args.workflow_def is not None and not args.workflow_def.strip():
        raise SystemExit(
            "REFUSED: --def was given but empty — omit --def entirely to use "
            "--type/the feature default, or pass a real workflowDefId"
        )
    body = {
        "title": args.title,
        "description": args.description or "",
    }
    if args.workflow_def is not None:
        body["workflowDefId"] = args.workflow_def
    else:
        body["workflowType"] = args.type or "feature"
    body["sources"] = []
    if args.repo:
        body["repoConfig"] = {
            "layout": "multi-repo",
            "repos": [{"url": f"https://github.com/{args.repo}",
                       "defaultBranch": args.branch or "main"}],
        }
    result = api_post("/api/workflow/start", body)
    wf_id = result.get("workflowId")
    if wf_id:
        publish_intervention(wf_id, "start", {
            "note": (args.description or args.title)[:500], "title": args.title,
        })
    print(json.dumps({"action": "start", **result}, indent=2))


def cmd_bugs_toggle(args):
    """Flip the auto-bug-filing kill switch (enforced server-side in /api/bugs).
    `bugs-off` = ALL automated workflow-manager filings are suppressed: both the
    crash path (any request with dedupeLabels) and the free-form path (a
    dedupeLabels-less request carrying origin:"workflow-manager"). Human-relayed
    bugs (Telegram/UI intake — neither field set) are unaffected. Config lives
    in the events table so no new IAM is needed. Use when the operator says
    "stop filing bugs"."""
    value = "off" if args.action == "bugs-off" else "on"
    dynamodb.Table(EVENTS_TABLE).put_item(Item={
        "workflowId": "wm-config",
        "eventId": "auto-file-bugs",
        "type": "wm.config",
        "timestamp": now_iso(),
        "detail": {"value": value, "by": "workflow-manager", "note": args.note or ""},
    })
    print(json.dumps({"action": args.action, "auto_file_bugs": value}, indent=2))


def cmd_file_bug(args):
    """File a top-level Bug that auto-fires the bug-fix pipeline (Jira webhook →
    bootstrapBugWorkflow). Two modes, selected by whether --agent is passed at
    all (not by whether its value is truthy — an explicitly empty/whitespace
    --agent is refused outright rather than silently falling back to free-form,
    so a caller who meant crash mode never files a bug that skips dedupe):

    CRASH MODE (--agent given) — the crash-rca skill's output path. The RCA
    becomes the bug description and the fix ships without a human relay.
      - <workflowId>, --title, --description (the RCA), and --agent are all
        REQUIRED. An RCA must cite evidence; a bare "agent X died" is refused
        by the skill, and an empty description is refused here.
      - Dedupe is signature-based: one OPEN bug per (crash-rca, agent:<id>)
        label pair. A second filing for the same agent lands as a comment on
        the existing bug — the pipeline never burns a run per crash.

    FREE-FORM MODE (--agent omitted) — file an ordinary bug the manager noticed
    (not tied to a crashed persona). No crash-rca/agent labels and no dedupe:
    the request carries an `origin: "workflow-manager"` marker so the server
    still honors the auto-filing kill switch. <workflowId> is OPTIONAL — pass it
    to link the intervention event to a run, omit it for a standalone bug.

    Common to both:
      - --title and --description are always REQUIRED.
      - --repo defaults server-side to the hub repo (GITHUB_OWNER/GITHUB_REPO):
        agent crashes are hub infrastructure, not the workload's repo."""
    for field, val in (("--title", args.title), ("--description", args.description)):
        if not (val or "").strip():
            raise SystemExit(f"REFUSED: file-bug requires {field}")
    if args.agent is not None and not args.agent.strip():
        raise SystemExit(
            "REFUSED: --agent was given but empty — omit --agent entirely for a "
            "free-form bug, or pass the crashed persona's id for crash mode"
        )
    crash_mode = args.agent is not None
    if crash_mode and not args.workflow_id:
        raise SystemExit("REFUSED: crash-mode file-bug (--agent) requires <workflowId>")

    if crash_mode:
        body = {
            "title": args.title,
            "description": args.description,
            "labels": ["crash-rca", f"agent:{args.agent}", f"crashed-in:{args.workflow_id}"],
            "dedupeLabels": ["crash-rca", f"agent:{args.agent}"],
        }
    else:
        body = {
            "title": args.title,
            "description": args.description,
            "origin": "workflow-manager",
        }
    if args.repo:
        body["repo"] = args.repo
    result = api_post("/api/bugs", body)
    # Link the intervention event to the run when we have one; otherwise publish
    # under the "wm-adhoc" sentinel partition (mirrors "wm-config" for toggles).
    event_workflow_id = args.workflow_id or "wm-adhoc"
    publish_intervention(event_workflow_id, "file_bug", {
        "ticketId": result.get("ticketId"), "deduped": result.get("deduped"),
        "agentId": args.agent, "note": args.title[:500],
    })
    print(json.dumps({"action": "file_bug", **result}, indent=2))


def cmd_escalate(args):
    # Idempotent: never append a second copy of an already-open (unacknowledged)
    # escalation with the same message. This stops the manager re-raising the
    # identical flag every pass — the source of the 400+ duplicate escalations
    # that bloated stuck records. An OPEN escalation is a human gate: the watch
    # scheduler skips this run until a human resolves it, and the Telegram bot
    # pings the human with a Resolved button — so one escalate both alerts and
    # quiets the loop.
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
    p.add_argument("--force", action="store_true",
                   help="steal a LIVE lease — only with evidence the session is dead")
    p.add_argument("--resume", action="store_true",
                   help="proceed even though a PR for the ticket exists; the agent is "
                        "handed a resume context pointing at it instead of starting cold")
    p.set_defaults(func=cmd_retry)

    p = sub.add_parser("dispatch")
    p.add_argument("workflow_id")
    p.add_argument("ticket_id")
    p.add_argument("--note", default="")
    p.add_argument("--force", action="store_true",
                   help="steal a LIVE lease — only with evidence the session is dead")
    p.add_argument("--resume", action="store_true",
                   help="proceed even though a PR for the ticket exists; the agent is "
                        "handed a resume context pointing at it instead of starting cold")
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

    p = sub.add_parser("mark-done")
    p.add_argument("workflow_id")
    p.add_argument("ticket_id")
    p.add_argument("--evidence", default="",
                   help="REQUIRED: the shipped deliverable (S3 key, PR URL, or streamed PASS verdict)")
    p.add_argument("--force", action="store_true",
                   help="Overwrite evidence the ticket ALREADY carries (the server otherwise "
                        "refuses with 409 EVIDENCE_EXISTS). Only when the recorded evidence is "
                        "known wrong - the override is stamped with your identity.")
    p.set_defaults(func=cmd_mark_done)

    p = sub.add_parser("cancel")
    p.add_argument("workflow_id")
    p.add_argument("--reason", default="")
    p.set_defaults(func=cmd_cancel)

    p = sub.add_parser("start")
    p.add_argument("--title", default="")
    p.add_argument("--description", default="")
    pipeline = p.add_mutually_exclusive_group()
    pipeline.add_argument("--def", dest="workflow_def", default=None,
                          help="run against a specific workflowDefId (omits workflowType). "
                               "An explicitly empty/whitespace value is refused rather than "
                               "silently falling back to the feature/type default")
    pipeline.add_argument("--type", choices=["feature", "bug"], default="",
                          help="built-in pipeline to run (default: feature)")
    p.add_argument("--repo", default="")
    p.add_argument("--branch", default="")
    p.set_defaults(func=cmd_start)

    for name in ("bugs-off", "bugs-on"):
        p = sub.add_parser(name)
        p.add_argument("--note", default="")
        p.set_defaults(func=cmd_bugs_toggle, action=name)

    p = sub.add_parser("file-bug")
    p.add_argument("workflow_id", nargs="?", default=None,
                   help="run to link the intervention event to; REQUIRED in crash mode, optional for a free-form bug")
    p.add_argument("--title", default="")
    p.add_argument("--description", default="",
                   help="REQUIRED: the bug description (in crash mode, the full RCA: symptom, occurrences, last activity, suspected cause)")
    p.add_argument("--agent", default=None,
                   help="optional; presence (non-empty) selects crash mode — the persona that "
                        "crashed, used as the dedupe key. An explicitly empty/whitespace value "
                        "is refused rather than silently falling back to free-form mode")
    p.add_argument("--repo", default="")
    p.set_defaults(func=cmd_file_bug)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        raise
