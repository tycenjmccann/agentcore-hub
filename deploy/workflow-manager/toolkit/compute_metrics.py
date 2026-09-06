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
import re
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# Sibling module in this same toolkit dir. Running as a script already puts that
# dir on sys.path, but adding it explicitly keeps the import working when this
# module is imported by name (the unit tests do exactly that).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from events import dedupe_events  # noqa: E402

HUMAN_PREFIX = "human:"
FIX_PREFIX = "Fix:"
TERMINAL_TASK_EVENTS = ("agent.complete", "workflow.report_completion")
INVOKE_EVENTS = ("agent.invoked", "agent.started")

# ── Fix-ticket lineage (TEAM-4121 FR-10) ────────────────────────────────────
# "How many fix tickets" was `title.startswith("Fix:")`, which by mid-2026 was
# wrong in both directions: the agents settled on "Fix (review):" / "Fix (QA):" /
# "Fix (ship-review r2):" / "Fix (CI):" so nearly every real fix went uncounted,
# while a BUG-FIX run's own intake-planned "Fix: <the feature>" ticket — the
# work the run exists to do — was counted as a rework loop. Both halves have to
# change together, because they cancel out in the total and hid each other.
#
# The predicate is, in order of trust:
#   1. `spawnedBy.kind` — the machine-stamped provenance (FR-8's contract). Any
#      of the six FIX_KINDS makes it a fix, whatever the title says.
#   2. the title shape below — for every ticket minted before FR-8 shipped.
#   3. legacy "Fix:" MINUS the intake-planned primary (see intake_completed_at).
FIX_TITLE = re.compile(
    r"^(Fix \((review|QA|qa|ship-review r\d+|CI|sync-main|[^)]+)\)|Re-verify \()",
    re.I,
)

# Kept in lockstep with lambda/orchestrator/fix-contract.mjs (FIX_KINDS and
# KIND_TO_ORIGIN_KEY). This module cannot import it — different language, and the
# toolkit ships to a container that has no lambda/ dir — so the parity is by
# review, and the names are spelled identically to make a diff obvious.
FIX_KINDS = ("review_fix", "qa_fix", "codex_fix", "ship_fix", "ci_fix", "sync_fix")
KIND_TO_ORIGIN_KEY = {
    "review_fix": "gateTicketId",
    "qa_fix": "qaTicketId",
    "codex_fix": "codexTicketId",
    "ship_fix": "shipTicketId",
    "ci_fix": "ciTicketId",
    "sync_fix": "ciTicketId",  # both are filed by the CI agent off the build ticket
}
# Who FINDS each kind of defect. Used only when spawnedBy is absent: the origin
# is then the finder's own ticket, the last one that completed before the fix was
# filed. (review_fix and codex_fix are both the code reviewer: one is the
# reviewer persona's finding, the other the coding CLI's.)
KIND_TO_FINDER_AGENT = {
    "review_fix": "agentcore_hub_code_reviewer",
    "codex_fix": "agentcore_hub_code_reviewer",
    "qa_fix": "agentcore_hub_qa_verifier",
    "ship_fix": "agentcore_hub_release_manager",
    "ci_fix": "agentcore_hub_ci_agent",
    "sync_fix": "agentcore_hub_ci_agent",
}
# ci_fix/sync_fix are a red build or a branch that drifted from main — nobody
# disagreed with anybody, so they are never counted as a defect resurfacing.
# (Same reasoning as REWORK_FIX_KINDS in fix-contract.mjs.)
ENVIRONMENTAL_KINDS = frozenset({"ci_fix", "sync_fix"})
INTAKE_AGENT_ID = "agentcore_hub_requirements_analyst"
REGRESSION_MARKER = "REGRESSION-OF-FIX"
# Similarity floor for the PRE-CONTRACT fallback only (two fix titles about the
# same thing). Deliberately high: a false "resurfacing" accuses an agent of not
# fixing what it said it fixed.
TITLE_SIMILARITY = 0.6
TICKET_KEY_IN_TEXT = re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b")
TITLE_SLOT_SPLIT = re.compile(r"\) — |\): |:")
TAG_STOPWORDS = frozenset(
    {"a", "an", "the", "and", "or", "of", "in", "on", "to", "for", "fix", "findings", "finding"}
)

# ── Business hours (TEAM-4121 FR-10) ────────────────────────────────────────
# A 7-hour merge-approval wait that started at 23:40 on a Friday is not the same
# finding as a 7-hour wait that started at 09:00 on a Tuesday, and the WM was
# reporting both as "human wait". Half-open [start, end) local hours, Sat/Sun
# always outside.
DEFAULT_BUSINESS_HOURS = "08-18"
DEFAULT_BUSINESS_TZ = "UTC"
BUSINESS_HOURS_RE = re.compile(r"^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$")


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


def business_window(tz_name=None, hours_spec=None, missing=None):
    """→ (tzinfo, start_hour, end_hour) for the "was this outside business hours"
    test. Env is read HERE and only here, and both values arrive as arguments so
    a test can pin a window without touching os.environ.

    Anything unparseable falls back to the documented defaults and leaves a
    missingSignals note: the WM must never silently answer "outside hours" for a
    whole run because WM_BUSINESS_TZ was typo'd."""
    if tz_name is None:
        tz_name = os.getenv("WM_BUSINESS_TZ", DEFAULT_BUSINESS_TZ)
    if hours_spec is None:
        hours_spec = os.getenv("WM_BUSINESS_HOURS", DEFAULT_BUSINESS_HOURS)
    notes = [] if missing is None else missing

    try:
        tz = ZoneInfo(tz_name or DEFAULT_BUSINESS_TZ)
    except Exception:  # unknown zone, or no tzdata in the container
        notes.append(
            f"WM_BUSINESS_TZ={tz_name!r} is not a known time zone — "
            f"used {DEFAULT_BUSINESS_TZ} for outsideHours"
        )
        tz = timezone.utc

    m = BUSINESS_HOURS_RE.match(str(hours_spec or ""))
    start, end = (int(m.group(1)), int(m.group(2))) if m else (None, None)
    if start is None or not (0 <= start < end <= 24):
        notes.append(
            f"WM_BUSINESS_HOURS={hours_spec!r} is not HH-HH — "
            f"used {DEFAULT_BUSINESS_HOURS} for outsideHours"
        )
        start, end = (int(x) for x in DEFAULT_BUSINESS_HOURS.split("-"))
    return tz, start, end


def is_outside_hours(dt, window):
    """Weekend, or outside [start, end) local hours. None when there is no
    timestamp to judge (an unknown answer must not read as "inside")."""
    if dt is None:
        return None
    tz, start, end = window
    local = dt.astimezone(tz)
    return local.weekday() >= 5 or not (start <= local.hour < end)


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


def compute_human_reviews(tickets, events, workflow, ended, missing, window=None):
    reviews, total_wait = [], 0
    # One window for the whole run (see business_window for why it is injectable).
    if window is None:
        window = business_window(missing=missing)
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
                # Was the human ASKED outside their working hours? Keyed on
                # requestedAt, not on the wait: a request that lands at 23:40
                # Friday explains its own 40-hour wait, and that explanation is
                # not a process defect the WM should file work against.
                "outsideHours": is_outside_hours(requested, window),
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


def spawned_kind(ticket):
    """The machine-stamped fix kind, or None. Any truthy `kind` counts — a kind
    this toolkit does not recognize is still provenance an agent stamped, and
    dropping it would undercount the moment a seventh kind ships."""
    spawned = ticket.get("spawnedBy")
    kind = spawned.get("kind") if isinstance(spawned, dict) else None
    return str(kind) if kind else None


def intake_completed_at(events, tickets, epic_id):
    """When the requirements analyst finished planning the run.

    Everything it planned — including, on a BUG-FIX run, a "Fix: <the feature>"
    ticket — was created before this instant; every fix ticket an agent filed
    against the pipeline was created after it. That single boundary is what lets
    the legacy "Fix:" title keep counting without counting the run's own work.

    Falls back to the epic's first child completing (a dossier whose analyst
    events were pruned), and to None (no exclusion at all — better to overcount
    by one than to silently drop a real fix)."""
    stamps = [
        parse_ts(e.get("timestamp"))
        for e in events_of(events, *TERMINAL_TASK_EVENTS)
        if detail(e).get("agentId") == INTAKE_AGENT_ID
    ]
    stamps = [s for s in stamps if s]
    if stamps:
        return min(stamps)
    children = sorted(
        (t for t in tickets
         if (t.get("parentId") or t.get("parent")) == epic_id and t.get("type") != "epic"),
        key=created_key,
    )
    if not children:
        return None
    first = children[0].get("ticketId")
    stamps = [
        parse_ts(e.get("timestamp"))
        for e in events_of(events, *TERMINAL_TASK_EVENTS)
        if detail(e).get("ticketId") == first
    ]
    stamps = [s for s in stamps if s]
    return min(stamps) if stamps else None


def created_key(ticket):
    """Sort key: creation order, unparseable timestamps last, id as tiebreak."""
    ts = parse_ts(ticket.get("createdAt"))
    return (ts is None, ts or datetime.min.replace(tzinfo=timezone.utc),
            str(ticket.get("ticketId") or ""))


def is_fix_ticket(ticket, intake_at=None):
    """A ticket an agent filed against its own pipeline (see FIX_TITLE)."""
    if spawned_kind(ticket):
        return True
    title = str(ticket.get("title") or "")
    if FIX_TITLE.match(title):
        return True
    if not title.startswith(FIX_PREFIX):
        return False
    created = parse_ts(ticket.get("createdAt"))
    # Legacy "Fix:" — a rework loop only if it was NOT part of the intake plan.
    return not (intake_at and created and created < intake_at)


def title_fix_kind(title):
    """→ (kind, reverify) for a ticket with no spawnedBy: everything minted
    before FR-8 stamped provenance. The slot is the parenthesized word the
    agents standardized on; "unknown" is honest and keeps the ticket counted."""
    text = str(title or "")
    if re.match(r"^Re-verify \(", text, re.I):
        return "qa_fix", True
    m = re.match(r"^Fix \(([^)]*)\)", text, re.I)
    if not m:
        return "unknown", False
    slot = m.group(1).strip().lower()
    reverify = "re-verify" in slot or "reverify" in slot
    # Order matters: "ship-review" contains "review", and the real yteqfl run
    # used "Fix (QA re-verify)" as well as "Fix (QA)".
    if slot.startswith("ship") or "ship-review" in slot:
        return "ship_fix", reverify
    if slot.startswith("sync"):
        return "sync_fix", reverify
    if slot.startswith("qa"):
        return "qa_fix", reverify
    if slot.startswith("ci"):
        return "ci_fix", reverify
    if "review" in slot:
        return "codex_fix", reverify
    return "unknown", reverify


def cited_paths(contract):
    """The PATHS (not the line numbers) a fix contract cited. Two fixes at
    different lines of the same file are the same place for lineage purposes —
    line numbers move when the first fix lands."""
    raw = contract.get("citedLocation") or contract.get("cited_location") or []
    if isinstance(raw, str):
        raw = raw.split(",")
    paths = set()
    for loc in raw:
        text = str(loc or "").strip()
        if text:
            paths.add(text.split(":")[0].strip().lower())
    return paths


def norm_invariant(contract):
    inv = str(contract.get("invariant") or "").strip().lower()
    return re.sub(r"\s+", " ", inv)


def title_slot_tokens(title):
    """The content words of a fix title, after the kind slot.

    "Fix (QA): intake.ts — placeholder name leaks into the S3 error detail" →
    the tokens of everything after the colon. Ticket keys and digits go (a
    resurfacing fix quotes the ticket it is redoing, and round numbers differ by
    construction), then punctuation, then stopwords."""
    text = str(title or "")
    parts = TITLE_SLOT_SPLIT.split(text, maxsplit=1)
    slot = parts[1] if len(parts) > 1 else text
    slot = TICKET_KEY_IN_TEXT.sub(" ", slot).lower()
    slot = re.sub(r"[^a-z]+", " ", slot)
    return frozenset(w for w in slot.split() if w and w not in TAG_STOPWORDS)


def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def finder_origin(kind, created, events):
    """No spawnedBy → the origin is the ticket of the agent that FINDS this kind
    of defect, the last one it completed before the fix was filed."""
    agent = KIND_TO_FINDER_AGENT.get(kind)
    if not agent or created is None:
        return None
    best_ts, best_tid = None, None
    for e in events_of(events, "agent.complete"):
        d = detail(e)
        if d.get("agentId") != agent or not d.get("ticketId"):
            continue
        ts = parse_ts(e.get("timestamp"))
        if ts and ts < created and (best_ts is None or ts > best_ts):
            best_ts, best_tid = ts, d["ticketId"]
    return best_tid


def compute_fix_tickets(tickets, events, epic_id):
    """fixTickets v2 — the count the WM cites, plus the lineage behind it.

    `count`/`ticketIds` keep their old meaning (and their old key names, so every
    existing reader is unaffected); `entries` says, per fix, WHAT KIND it was,
    WHICH ticket it came from, WHICH ROUND of that origin it is, and — the point
    of the whole exercise — whether the run was making progress:

      new            a defect nobody had filed a fix for yet
      resurfacing    the same place / the same invariant as an earlier fix, i.e.
                     an earlier fix did not hold
      fix-induced    filed against an origin that a previous fix had blocked, or
                     explicitly marked REGRESSION-OF-FIX — the fix broke it
      environmental  a red build or a stale branch, nobody's disagreement

    Three "new" fixes is a run finding three bugs. Three "resurfacing" fixes is
    ONE bug and a loop, and the WM's advice for the two is not the same."""
    intake_at = intake_completed_at(events, tickets, epic_id)
    fixes = sorted((t for t in tickets if is_fix_ticket(t, intake_at)), key=created_key)
    by_id = {t.get("ticketId"): t for t in tickets if t.get("ticketId")}

    entries, prints, rounds = [], [], {}
    for ticket in fixes:
        tid = ticket.get("ticketId")
        title = str(ticket.get("title") or "")
        created = parse_ts(ticket.get("createdAt"))
        spawned = ticket.get("spawnedBy") if isinstance(ticket.get("spawnedBy"), dict) else {}
        contract = ticket.get("fixContract") if isinstance(ticket.get("fixContract"), dict) else {}

        kind = spawned_kind(ticket)
        title_kind, reverify = title_fix_kind(title)
        if not kind:
            kind = title_kind
        elif spawned.get("reverify"):
            reverify = True

        origin = spawned.get(KIND_TO_ORIGIN_KEY.get(kind, ""), None) or None
        if not origin:
            origin = finder_origin(kind, created, events)

        key = (kind, origin)
        rounds[key] = rounds.get(key, 0) + 1

        fingerprint = {
            "paths": cited_paths(contract),
            "invariant": norm_invariant(contract),
            "slot": title_slot_tokens(title),
        }

        tag = "new"
        if kind in ENVIRONMENTAL_KINDS:
            tag = "environmental"
        else:
            origin_ticket = by_id.get(origin) or {}
            blockers = {str(b) for b in (origin_ticket.get("blockedBy") or [])}
            earlier_ids = {e["ticketId"] for e in entries}
            marker_text = " ".join(
                [title] + [str(l) for l in (ticket.get("labels") or [])]
            ).upper()
            if (blockers & earlier_ids) or REGRESSION_MARKER in marker_text:
                tag = "fix-induced"
            else:
                for prev in prints:
                    same_place = bool(fingerprint["paths"] and prev["paths"]
                                      and fingerprint["paths"] & prev["paths"])
                    same_invariant = bool(fingerprint["invariant"]
                                          and fingerprint["invariant"] == prev["invariant"])
                    # Title similarity is the PRE-CONTRACT fallback only: once
                    # either side carries a contract, the contract is the answer
                    # and a prose coincidence must not override it.
                    pre_contract = not (fingerprint["paths"] or fingerprint["invariant"]
                                        or prev["paths"] or prev["invariant"])
                    same_words = pre_contract and jaccard(
                        fingerprint["slot"], prev["slot"]) >= TITLE_SIMILARITY
                    if same_place or same_invariant or same_words:
                        tag = "resurfacing"
                        break

        entry = {
            "ticketId": tid,
            "kind": kind,
            "originTicketId": origin,
            "round": rounds[key],
            "tag": tag,
            "createdAt": ticket.get("createdAt"),
            "title": title,
        }
        if reverify:
            # A re-verification is not a new round of anything (rework-loop-cap.mjs
            # exempts it for the same reason) — it re-runs a check, it does not
            # redo the work.
            entry["reverify"] = True
        entries.append(entry)
        prints.append(fingerprint)

    by_kind = {}
    for e in entries:
        by_kind[e["kind"]] = by_kind.get(e["kind"], 0) + 1
    by_tag = {"new": 0, "resurfacing": 0, "fix-induced": 0, "environmental": 0}
    for e in entries:
        by_tag[e["tag"]] = by_tag.get(e["tag"], 0) + 1
    return {
        "count": len(entries),
        "ticketIds": [e["ticketId"] for e in entries],
        "entries": entries,
        "byKind": by_kind,
        "byTag": by_tag,
    }


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
    # Dedupe FIRST, before the sort and before anything counts a row. pull_dossier
    # now collapses the double-write at collection time, but every dossier saved
    # before that change still carries both copies of every event — and with them
    # doubled human-review cycles, doubled rework counts and doubled event totals.
    # Deduping again here is idempotent and makes old dossiers compute clean.
    events = sorted(
        dedupe_events(dossier.get("events") or []),
        key=lambda e: (e.get("timestamp", ""), e.get("eventId", "")),
    )
    missing = list(dossier.get("missingSignals") or [])

    started, ended = run_bounds(workflow, events)
    window = business_window(missing=missing)
    reviews, human_wait = compute_human_reviews(
        tickets, events, workflow, ended, missing, window=window
    )
    fix_tickets = compute_fix_tickets(tickets, events, dossier.get("epicId"))
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
        # How many gate requests landed on a human outside their working hours —
        # the honest denominator for "why did this run wait 7 hours".
        "humanReviewsOutsideHours": sum(1 for r in reviews if r.get("outsideHours")),
        "changeRequests": compute_change_requests(events),
        "fixTickets": fix_tickets,
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
        # The breakdown, not just the total: "3 fix tickets, all resurfacing" is
        # a different run from "3 fix tickets, all new", and the summary line is
        # what a human reads first.
        "fixTicketsByTag": metrics["fixTickets"]["byTag"],
        "humanReviewsOutsideHours": metrics["humanReviewsOutsideHours"],
        "missingSignals": metrics["dataQuality"]["missingSignals"],
    }, indent=2))


if __name__ == "__main__":
    main()
