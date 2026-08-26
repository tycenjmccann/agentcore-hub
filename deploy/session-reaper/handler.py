"""
Cloud Code session reaper — reclaims a deleted session's backend storage.

Event-driven, fires exactly once per real delete: the API soft-deletes a session
(stamps `deletedAt` + a short `ttl`), DynamoDB expires the row when the TTL lapses,
and the table's stream delivers that REMOVE event here. We then:

  1. Stop the runtime session (kills any in-flight CLI + frees the microVM).
  2. Invoke the runtime's `purge` action on a fresh VM that re-mounts the
     persistent EFS — rmtree the session's EFS dir + transcript, delete its S3
     artifacts. EFS survives the microVM recycle, so cleanup never needs the
     original VM alive and is never torn down mid-rmtree.

No polling: this runs ~once per delete, not on a schedule. If the purge fails, we
raise — Lambda + the stream's retry/bisect redelivers, and an S3 lifecycle rule
backstops any artifact we still miss. Stop-then-purge + out-of-band execution is
what removes the request-path races entirely.

Only REMOVE events for soft-deleted SESSION rows are acted on. A REMOVE with no
`deletedAt` is a genuine hard delete (already reaped, or a config: row) and is
ignored — so the reaper is idempotent and safe to redeliver.
"""

import json
import os

import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")
RUNTIME_ARN = os.environ.get("CODING_AGENT_RUNTIME_ARN", "")

# Both invoke_agent_runtime and stop_runtime_session live on the data-plane
# client (bedrock-agentcore), not the control plane.
_agentcore = boto3.client("bedrock-agentcore", region_name=REGION)


def _ddb_str(attr):
    """Pull a plain string out of a DynamoDB stream attribute value ({'S': ...})."""
    if isinstance(attr, dict):
        return attr.get("S")
    return None


def _stop_session(session_id: str) -> None:
    """Stop the runtime session — kills the in-flight CLI and frees the microVM.
    Idempotent: a session that already aged out / never started just errors, which
    we swallow."""
    try:
        _agentcore.stop_runtime_session(
            runtimeSessionId=session_id,
            agentRuntimeArn=RUNTIME_ARN,
            qualifier="DEFAULT",
        )
    except Exception as exc:  # noqa: BLE001 — stop is best-effort; purge is the goal
        print(f"[reaper] stop {session_id}: {type(exc).__name__}: {str(exc)[:200]}")


def _purge_session(session_id: str, cli: str, claude_session_id: str | None,
                   tenant_id: str | None) -> dict:
    """Invoke the runtime's purge action on a fresh VM. Raises on a failed invoke so
    the stream redelivers (the reaper retries)."""
    payload = {
        "purge": True,
        "session_id": session_id,
        "cli": cli or "claude",
    }
    if claude_session_id:
        payload["claude_session_id"] = claude_session_id
    # Tenant scopes the S3 keys the runtime purges; "default"/None resolves to the
    # legacy unprefixed layout, so pre-tenancy rows are still fully reclaimed.
    if tenant_id:
        payload["tenant_id"] = tenant_id

    res = _agentcore.invoke_agent_runtime(
        agentRuntimeArn=RUNTIME_ARN,
        runtimeSessionId=session_id,
        payload=json.dumps(payload).encode("utf-8"),
        contentType="application/json",
        accept="application/json",
    )
    body = res.get("response")
    raw = body.read() if hasattr(body, "read") else body
    parsed = json.loads(raw) if raw else {}
    if not parsed.get("purged"):
        raise RuntimeError(f"purge did not confirm for {session_id}: {str(parsed)[:200]}")
    return parsed


def _reap(image: dict) -> bool:
    """Reap one expired row (the stream's OldImage). Returns True only when it
    actually reaped a soft-deleted session row; False for skipped rows."""
    session_id = _ddb_str(image.get("sessionId"))
    if not session_id or session_id.startswith("config:"):
        return False
    if not _ddb_str(image.get("deletedAt")):
        # Hard delete with no tombstone → already reaped or never a session. Skip.
        return False
    cli = _ddb_str(image.get("cli")) or "claude"
    claude_session_id = _ddb_str(image.get("claudeSessionId"))
    tenant_id = _ddb_str(image.get("tenantId"))

    print(f"[reaper] reaping {session_id} (cli={cli}, tenant={tenant_id or 'default'})")
    _stop_session(session_id)
    result = _purge_session(session_id, cli, claude_session_id, tenant_id)
    print(f"[reaper] reaped {session_id}: {json.dumps(result)}")
    return True


def handler(event, _context):
    """DynamoDB Streams entrypoint. Reaps every REMOVE record carrying a tombstone;
    a record that fails raises so the batch is retried/bisected by the stream."""
    if not RUNTIME_ARN:
        raise RuntimeError("CODING_AGENT_RUNTIME_ARN is not set")

    reaped = 0
    for record in event.get("Records", []):
        if record.get("eventName") != "REMOVE":
            continue
        old = record.get("dynamodb", {}).get("OldImage")
        if not old:
            continue
        if _reap(old):
            reaped += 1
    return {"reaped": reaped}
