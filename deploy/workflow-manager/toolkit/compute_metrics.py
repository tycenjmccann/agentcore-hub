#!/usr/bin/env python3
"""Deterministic run metrics from a dossier. The Workflow Manager cites these
numbers — it never recomputes them.

Usage: python3 compute_metrics.py <workflowId> [--workspace DIR]
Reads {workspace}/dossier.json, writes {workspace}/metrics.json.

All functions are pure (no AWS calls) so they can be unit-tested locally:
  python3 -m unittest deploy/workflow-manager/toolkit/test_metrics.py
"""

import argparse
import json
import os
from datetime import datetime, timezone

HUMAN_PREFIX = "human:"
FIX_PREFIX = "Fix:"
TERMINAL_TASK_EVENTS = ("agent.complete", "workflow.report_completion")
INVOKE_EVENTS = ("agent.invoked", "agent.started")


def parse_ts(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if dt else None


def ms_between(start, end):
    if start is None or end is None:
        return None
    return max(0, int((end - start).total_seconds() * 1000))


def events_of(events, *types):
    return [e for e in events if e.get("type") in types]


def detail(event):
    return event.get("detail") or {}


def event_ticket(event):
    return detail(event).get("ticketId") or event.get("workflowId")


def run_bounds(workflow, events):
    started = parse_ts(workflow.get("startedAt"))
    ended = parse_ts(workflow.get("completedAt")) or parse_ts(workflow.get("cancelledAt"))
    if ended is None and events:
        ended = parse_ts(events[-1].get("timestamp"))
    return started, ended


def compute_phases(events, started, ended, missing):
    changes = events_of(events, "workflow.phase_change")
    if not changes:
        missing.append("no phase_change events — phase durations unavailable")
        return []
    invoked_by_phase = {}
    for e in events_of(events, "agent.invoked"):
        phase = detail(e).get("phase")
        if phase:
            invoked_by_phase[phase] = invoked_by_phase.get(phase, 0) + 1
    phases = []
    for i, e in enumerate(changes):
        entered = parse_ts(e.get("timestamp"))
        exited = parse_ts(changes[i + 1].get("timestamp")) if i + 1 < len(changes) else ended
        phase = detail(e).get("phase")
        phases.append({
            "phase": phase,
            "enteredAt": iso(entered),
            "exitedAt": iso(exited),
            "durationMs": ms_between(entered, exited),
            "taskCount": invoked_by_phase.get(phase, 0),
        })
    return phases


def compute_agent_tasks(tickets, events):
    tasks = []
    for ticket in tickets:
        assignee = ticket.get("assignee") or ""
        if not assignee or assignee.startswith(HUMAN_PREFIX) or ticket.get("type") == "epic":
            continue
        tid = ticket["ticketId"]
        invokes = [e for e in events_of(events, *INVOKE_EVENTS) if event_ticket(e) == tid]
        dones = [e for e in events_of(events, *TERMINAL_TASK_EVENTS) if event_ticket(e) == tid]
        invoked_at = parse_ts(invokes[0].get("timestamp")) if invokes else None
        completed_at = parse_ts(dones[-1].get("timestamp")) if dones else None
        if completed_at is None and ticket.get("status") == "done":
            completed_at = parse_ts(ticket.get("updatedAt"))
        if invoked_at is None:
            invoked_at = parse_ts(ticket.get("createdAt"))
        phase = next(
            (detail(e).get("phase") for e in invokes if detail(e).get("phase")), None
        )
        invoke_count = len([e for e in invokes if e.get("type") == "agent.invoked"])
        tasks.append({
            "ticketId": tid,
            "agentId": assignee,
            "phase": phase,
            "invokedAt": iso(invoked_at),
            "completedAt": iso(completed_at),
            "durationMs": ms_between(invoked_at, completed_at),
            "status": ticket.get("status"),
            "reworkCount": max(0, invoke_count - 1),
        })
    return tasks


def compute_human_reviews(tickets, events, workflow, ended, missing):
    reviews, total_wait = [], 0
    notif_ts = {}
    for n in workflow.get("humanNotifications") or []:
        if n.get("type") == "review_needed" and n.get("ticketId"):
            notif_ts.setdefault(n["ticketId"], parse_ts(n.get("timestamp")))
    gate_tickets = [
        t for t in tickets if str(t.get("assignee") or "").startswith(HUMAN_PREFIX)
    ]
    if not gate_tickets:
        return reviews, 0
    needed = events_of(events, "review.needed")
    rejected = events_of(events, "review.rejected")
    for ticket in gate_tickets:
        tid = ticket["ticketId"]
        requests = [parse_ts(e.get("timestamp")) for e in needed if event_ticket(e) == tid]
        if not requests:
            fallback = notif_ts.get(tid)
            if fallback:
                requests = [fallback]
                missing.append(f"{tid}: review.needed missing — used humanNotifications timestamp")
        rejections = [parse_ts(e.get("timestamp")) for e in rejected if event_ticket(e) == tid]
        done_at = parse_ts(ticket.get("updatedAt")) if ticket.get("status") == "done" else None
        for cycle, requested in enumerate(sorted(filter(None, requests)), start=1):
            rejection = next((r for r in sorted(filter(None, rejections)) if r and r > requested), None)
            if rejection:
                resolved, outcome = rejection, "rejected"
            elif done_at and done_at > requested and cycle == len(requests):
                resolved, outcome = done_at, "approved"
            else:
                resolved, outcome = ended, "unresolved"
            wait = ms_between(requested, resolved)
            if wait:
                total_wait += wait
            reviews.append({
                "gateTicketId": tid,
                "reviewer": ticket.get("assignee"),
                "gateName": ticket.get("title"),
                "requestedAt": iso(requested),
                "resolvedAt": iso(resolved),
                "waitMs": wait,
                "outcome": outcome,
                "cycle": cycle,
            })
    return reviews, total_wait


def compute_change_requests(events):
    cycles = []
    # TEAM-3966 F6: review.parked_advisory is a human's request-changes the
    # orchestrator parked (all findings out-of-diff) instead of reopening — a
    # change request with no reopened tickets. NOT a review resolution: the
    # humanReviews outcome logic above deliberately reads review.rejected only.
    rejections = events_of(events, "review.rejected", "review.parked_advisory")
    completions = events_of(events, "agent.complete", "workflow.report_completion")
    for e in rejections:
        rejected_at = parse_ts(e.get("timestamp"))
        reopened = detail(e).get("reopened") or []
        rework_end = None
        for tid in reopened:
            redone = [
                parse_ts(c.get("timestamp")) for c in completions
                if event_ticket(c) == tid
                and parse_ts(c.get("timestamp")) and rejected_at
                and parse_ts(c.get("timestamp")) > rejected_at
            ]
            if redone:
                last = max(redone)
                rework_end = max(rework_end, last) if rework_end else last
        cycles.append({
            "gateTicketId": detail(e).get("ticketId"),
            "rejectedAt": iso(rejected_at),
            "reopenedTickets": reopened,
            "reworkDurationMs": ms_between(rejected_at, rework_end),
        })
    return {"count": len(cycles), "cycles": cycles}


def compute_tokens(events, missing):
    usage = events_of(events, "token_usage")
    if not usage:
        missing.append(
            "no token_usage events — per-run tokens unavailable "
            "(eval-config token totals are fleet-lifetime, not per-run)"
        )
        return None
    by_agent, total_in, total_out = {}, 0, 0
    for e in usage:
        d = detail(e)
        agent = d.get("agentId", "unknown")
        i, o = int(d.get("inputTokens") or 0), int(d.get("outputTokens") or 0)
        agg = by_agent.setdefault(agent, {"input": 0, "output": 0})
        agg["input"] += i
        agg["output"] += o
        total_in += i
        total_out += o
    return {"totalInput": total_in, "totalOutput": total_out, "byAgent": by_agent}


def compute_metrics(dossier):
    workflow = dossier.get("workflow") or {}
    tickets = dossier.get("tickets") or []
    events = sorted(
        dossier.get("events") or [],
        key=lambda e: (e.get("timestamp", ""), e.get("eventId", "")),
    )
    missing = list(dossier.get("missingSignals") or [])

    started, ended = run_bounds(workflow, events)
    reviews, human_wait = compute_human_reviews(tickets, events, workflow, ended, missing)
    fix_ids = [t["ticketId"] for t in tickets if str(t.get("title", "")).startswith(FIX_PREFIX)]
    interventions = [
        {"action": detail(e).get("action"), "ticketId": detail(e).get("ticketId"),
         "at": e.get("timestamp"), "note": detail(e).get("note")}
        for e in events_of(events, "manager.intervention")
    ]
    return {
        "startedAt": iso(started),
        "completedAt": iso(ended),
        "totalDurationMs": ms_between(started, ended),
        "phases": compute_phases(events, started, ended, missing),
        "agentTasks": compute_agent_tasks(tickets, events),
        "humanReviews": reviews,
        "humanWaitTotalMs": human_wait,
        "changeRequests": compute_change_requests(events),
        "fixTickets": {"count": len(fix_ids), "ticketIds": fix_ids},
        "nudgeCount": len(events_of(events, "workflow.nudge", "nudge")),
        "managerInterventions": interventions,
        "errors": [
            {"agentId": detail(e).get("agentId"), "error": detail(e).get("error"),
             "at": e.get("timestamp")}
            for e in events_of(events, "agent.error", "error")
        ],
        "tokens": compute_tokens(events, missing),
        "evalSummaries": dossier.get("evalSummaries") or [],
        "counts": {
            "tickets": len(tickets),
            "events": len(events),
            "artifacts": len(dossier.get("artifacts") or []),
            "completions": len(dossier.get("completions") or {}),
        },
        "dataQuality": {
            "ticketProvider": dossier.get("ticketProvider", "dynamodb"),
            "missingSignals": missing,
            "notes": [
                "evalSummaries are fleet-lifetime rolling averages, not per-run scores",
            ],
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workflow_id")
    parser.add_argument("--workspace", default=None)
    args = parser.parse_args()
    workspace = args.workspace or f"/mnt/workspace/{args.workflow_id}"
    with open(os.path.join(workspace, "dossier.json")) as f:
        dossier = json.load(f)
    metrics = compute_metrics(dossier)
    out = os.path.join(workspace, "metrics.json")
    with open(out, "w") as f:
        json.dump(metrics, f, indent=1)
    print(json.dumps({
        "metrics": out,
        "totalDurationMs": metrics["totalDurationMs"],
        "humanWaitTotalMs": metrics["humanWaitTotalMs"],
        "changeRequests": metrics["changeRequests"]["count"],
        "fixTickets": metrics["fixTickets"]["count"],
        "missingSignals": metrics["dataQuality"]["missingSignals"],
    }, indent=2))


if __name__ == "__main__":
    main()
