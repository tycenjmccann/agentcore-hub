#!/usr/bin/env python3
"""Content-based dedupe for events-table rows (TEAM-4120 FR-2, consumer side).

Every orchestrator/agent-invoker event reaches the events table TWICE:
publishEvent PutItems it directly, and the same event goes to EventBridge, whose
`agentcore-hub-workflow-events` rule fans out to events-writer.mjs, which
PutItems it AGAIN under a different eventId. The table key is
(workflowId, eventId), so both copies survive as two rows that differ only in
their eventId, their `source` attribute, and their `detail` key ORDER (the
EventBridge copy has been through a JSON round-trip). Anything that counts rows
therefore double-counts: a 24-minute human review becomes two reviews totalling
49 minutes, one rework round becomes two, a stream of 40 chunks becomes 80.

Deduping here is deliberately UNCONDITIONAL — no flag. The producer-side fix
(lambda/orchestrator/event-id.mjs, EVENT_DEDUPE_MODE) only helps events written
after it is enabled; every dossier and every historical run still carries the
duplicates, and the Workflow Manager reads those. Dedupe on read fixes both.

The join string mirrors the two existing implementations so all three agree on
what "the same event" means:
  * lambda/cost-report/index.mjs dedupeEvents  (the other consumer)
  * lambda/orchestrator/event-id.mjs contentKey (the producer-side id)
Two deliberate differences from cost-report, both noted at their line below:
streaming rows are kept (keyed, not dropped), and the row-timestamp fallback is
not truncated to seconds.

Pure stdlib, no AWS, no I/O — imported by pull_dossier.py (at collection time)
and compute_metrics.py (at read time, so dossiers saved before this change also
compute clean numbers).

Run the tests: python3 -m unittest deploy/workflow-manager/toolkit/test_events.py
"""

import json

STREAMING_TYPE = "agent.streaming"


def stable_json(v):
    """Key-sorted JSON, byte-compatible with the JS `stableJson` in
    lambda/cost-report/index.mjs and lambda/orchestrator/event-id.mjs.

    Objects render with sorted keys and no whitespace so the two copies of one
    event — whose detail key order differs after the EventBridge JSON
    round-trip — produce the same string. `ensure_ascii=False` matches
    JSON.stringify, which does not escape non-ASCII.
    """
    if isinstance(v, dict):
        inner = ",".join(f"{json.dumps(k, ensure_ascii=False)}:{stable_json(v[k])}" for k in sorted(v))
        return "{" + inner + "}"
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(stable_json(x) for x in v) + "]"
    try:
        return json.dumps(v, ensure_ascii=False)
    except (TypeError, ValueError):
        # Decimal (raw DynamoDB) and anything else exotic: fall back to its text
        # form rather than raising. Only reachable on the no-ticketId branch,
        # where the string is compared against other rows of the same shape.
        return json.dumps(str(v), ensure_ascii=False)


def content_key(event):
    """The identity of an event, independent of which writer stored it."""
    etype = event.get("type") or ""
    d = event.get("detail")
    if not isinstance(d, dict):
        d = {}
    # detail.timestamp is the publisher's own clock and is IDENTICAL on both
    # copies — which is why the key uses it and not the row's timestamp. The two
    # copies' ROW timestamps do not always agree: in older runs the events-writer
    # copy carries EventBridge's `event.time`, which is second-granularity
    # (2026-09-03T06:15:05Z vs the direct copy's …:05.404Z).
    #
    # Rows from other writers (workflow.report_completion, manager.intervention,
    # agent.error/agent.retry, some agent.started) carry no detail.timestamp, so
    # fall back to the row's timestamp — never to "" for everything, which would
    # collapse genuinely different events onto one key. Those types are also the
    # ones that never reach EventBridge, so the fallback path has no duplicates
    # to collapse in practice (confirmed against both fixtures: every collapsed
    # pair is one direct row + one `source: agentcore-hub.orchestrator` row, and
    # the count of singletons equals direct-minus-bus exactly).
    #
    # Unlike cost-report's `(e.timestamp||"").slice(0,19)`, the fallback is NOT
    # truncated to seconds: dropping the milliseconds can only ever merge more
    # rows, and merging two genuinely distinct events — two agent.error rows from
    # one retry loop, say — is the one failure this must not have.
    ts = d.get("timestamp") or event.get("timestamp") or ""

    if etype == STREAMING_TYPE:
        # cost-report DROPS streaming rows; we keep them, because pull_dossier's
        # per-agent stream counts and verdict tail are built from them. Chunks
        # share (type, ts-to-the-ms, agentId, subtype) only when they are the
        # same chunk, so the doubled copies collapse and the counts come out
        # right — while two genuinely different chunks keep their own content.
        sub = d.get("type") or ""
        body = d.get("content") or d.get("toolName") or ""
        return "|".join([etype, ts, d.get("agentId") or "", sub, str(body)])

    ticket = d.get("ticket")
    tid = d.get("ticketId") or (ticket.get("id") if isinstance(ticket, dict) else None) or ""
    if tid:
        return f"{etype}|{ts}|{tid}|{d.get('agentId') or d.get('assignee') or ''}"
    return f"{etype}|{ts}|{stable_json(d)}"


def dedupe_events(events):
    """Drop duplicate copies of the same event. First occurrence wins, input
    order is preserved (callers sort afterwards, and the surviving row keeps the
    eventId/source of whichever writer's copy was read first)."""
    seen = set()
    out = []
    for e in events or []:
        key = content_key(e)
        if key in seen:
            continue
        seen.add(key)
        out.append(e)
    return out
