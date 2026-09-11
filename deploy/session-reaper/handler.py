"""
Cloud Code session reaper — releases a coding session's compute and storage.

One Lambda, two entrypoints:

  stream  DynamoDB Streams, REMOVE only. The API soft-deletes a session (stamps
          `deletedAt` + a short `ttl`), the table expires the row, and the stream
          delivers the REMOVE here — exactly once per real delete, no polling.

  sweep   EventBridge rate(15 minutes), event {"sweep": true}. Releases the compute
          behind sessions whose work is over: a workflow session whose run reached
          a terminal phase, a workflow session whose run row is gone, or an
          Instances session idle past the retention window. Rows are KEPT (history
          stays in the Cloud Code tab) and stamped `computeReleasedAt`; a later
          resume simply starts a fresh workspace (the fleet refuses to adopt a
          released row — deploy/runtime-agent/main.py _maybe_resume_session).

Which release depends on where the session's workspace lives — the row's
`runtimeArn`, or CODING_AGENT_RUNTIME_ARN for rows written before that column
existed (they all live on the runtime the fleet was pointed at then):

  Instances runtime (capacityProviderConfiguration set) → DeleteCapacityProviderSession.
      Terminates the EC2 instance and deletes the per-session EBS volume, which
      bills until then even while the session is idle or stopped. Nothing else on
      the platform ever deletes it.
  microVM + EFS runtime → StopRuntimeSession, then the runtime's `purge` action on
      a fresh VM that re-mounts EFS: rmtree the session dir + transcript, delete
      its S3 artifacts. EFS survives the microVM recycle, so cleanup never needs
      the original VM alive and is never torn down mid-rmtree.

Failure policy: the stream path raises so Lambda + the stream's retry/bisect
redeliver; the sweep logs and continues (the next tick retries anything left
unstamped). An S3 lifecycle rule backstops any artifact both still miss.
"""

import json
import os
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("AWS_REGION", "us-east-1")
# Rows without `runtimeArn` (pre-cutover) live here. Keep this on the microVM
# runtime after a cutover; new rows name their runtime explicitly.
DEFAULT_RUNTIME_ARN = os.environ.get("CODING_AGENT_RUNTIME_ARN", "")
CLOUD_CODE_TABLE = os.environ.get("CLOUD_CODE_TABLE", "agentcore-hub-cloud-code-sessions")
WORKFLOWS_TABLE = os.environ.get("WORKFLOWS_TABLE", "agentcore-hub-workflows")

# Sweep knobs (seconds unless noted). Grace after a run turns terminal before its
# sessions are released: short on Instances (the volume is the cost; a late
# straggler turn re-provisions in ~100 s), long on EFS (a purge boots a microVM
# and there is nothing to save). Human Instances sessions are released after two
# idle weeks; human EFS sessions are the UI's to delete.
SWEEP_GRACE_CP_S = int(os.environ.get("SWEEP_GRACE_CP_S", "1800"))
SWEEP_GRACE_EFS_S = int(os.environ.get("SWEEP_GRACE_EFS_S", "21600"))
SWEEP_IDLE_CP_S = int(os.environ.get("SWEEP_IDLE_CP_S", str(14 * 86400)))
SWEEP_MISSING_WORKFLOW_S = int(os.environ.get("SWEEP_MISSING_WORKFLOW_S", "86400"))
SWEEP_MAX_CP = int(os.environ.get("SWEEP_MAX_CP", "100"))
SWEEP_MAX_PURGE = int(os.environ.get("SWEEP_MAX_PURGE", "20"))
# Wall clock kept in reserve so the last release started can finish and the
# summary line can print. One EFS purge cold-boots a microVM (20-40 s); the
# check happens BEFORE a release starts, so this must exceed the slowest
# single release.
SWEEP_DEADLINE_MARGIN_MS = int(os.environ.get("SWEEP_DEADLINE_MARGIN_MS", "90000"))

# Workflow phases after which no agent will touch the session again
# (lambda/orchestrator: completeWorkflow / claimTerminalOutcome / cancel route).
TERMINAL_PHASES = frozenset({"complete", "error", "cancelled", "deploy-blocked", "static-ci-only"})

# invoke_agent_runtime / stop_runtime_session / delete_capacity_provider_session
# are data-plane (bedrock-agentcore); get_agent_runtime is control-plane.
_agentcore = boto3.client("bedrock-agentcore", region_name=REGION)
_control = boto3.client("bedrock-agentcore-control", region_name=REGION)
_ddb = boto3.client("dynamodb", region_name=REGION)

_runtime_cp_cache: dict = {}


def _sdk_has_capacity_providers() -> bool:
    return "DeleteCapacityProviderSession" in _agentcore.meta.service_model.operation_names


def _ddb_str(attr):
    """Pull a plain string out of a DynamoDB attribute value ({'S': ...})."""
    if isinstance(attr, dict):
        return attr.get("S")
    return None


def _parse_ts(value):
    """ISO-8601 (with or without a trailing Z) → aware datetime, or None."""
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


# ─── which compute backs a runtime ──────────────────────────────────────────────

def _capacity_provider_id(runtime_arn: str):
    """Capacity-provider id when the runtime runs on Instances, None when it is a
    microVM runtime. Raises on a failed lookup: guessing microVM for an Instances
    runtime would boot an EC2 instance just to purge files and leave the volume
    billing, so an unknown runtime is skipped instead."""
    if runtime_arn in _runtime_cp_cache:
        return _runtime_cp_cache[runtime_arn]
    if not _sdk_has_capacity_providers():
        # An old botocore silently DROPS capacityProviderConfiguration from the
        # GetAgentRuntime response, so every runtime would look like a microVM.
        raise RuntimeError("boto3 in this Lambda predates the capacity-provider API — "
                           "attach the boto3 layer (deploy/session-reaper/deploy.sh)")
    rt = _control.get_agent_runtime(agentRuntimeId=runtime_arn.rsplit("/", 1)[-1])
    cp_arn = (rt.get("capacityProviderConfiguration") or {}).get("capacityProviderArn")
    cp_id = cp_arn.rsplit("/", 1)[-1] if cp_arn else None
    _runtime_cp_cache[runtime_arn] = cp_id
    return cp_id


# ─── the three release primitives ───────────────────────────────────────────────

def _stop_session(session_id: str, runtime_arn: str) -> None:
    """Stop the runtime session — kills the in-flight CLI and frees the microVM.
    Idempotent: a session that already aged out / never started just errors, which
    we swallow."""
    try:
        _agentcore.stop_runtime_session(
            runtimeSessionId=session_id,
            agentRuntimeArn=runtime_arn,
            qualifier="DEFAULT",
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
            print(f"[reaper] stop {session_id}: runtime session already gone (ResourceNotFoundException)")
        else:
            print(f"[reaper] stop {session_id}: {type(exc).__name__}: {str(exc)[:200]}")
    except Exception as exc:  # noqa: BLE001 — stop is best-effort; purge is the goal
        print(f"[reaper] stop {session_id}: {type(exc).__name__}: {str(exc)[:200]}")


def _purge_session(session_id: str, runtime_arn: str, cli: str, claude_session_id,
                   tenant_id) -> dict:
    """Invoke the runtime's purge action on a fresh VM. Raises on a failed invoke so
    the caller retries (stream redelivery / next sweep)."""
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
        agentRuntimeArn=runtime_arn,
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


def _delete_capacity_provider_session(session_id: str, cp_id: str) -> str:
    """Terminate the instance + delete the EBS volume behind an Instances session.
    A session the platform no longer knows (never provisioned, or already deleted)
    counts as released."""
    try:
        _agentcore.delete_capacity_provider_session(capacityProviderId=cp_id, sessionId=session_id)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
            return "cp-session-absent"
        raise
    return "cp-session-deleted"


def _release_compute(session_id: str, runtime_arn: str, cli: str, claude_session_id,
                     tenant_id) -> str:
    """Release whatever compute backs the session. Returns the release kind."""
    cp_id = _capacity_provider_id(runtime_arn)
    if cp_id:
        return _delete_capacity_provider_session(session_id, cp_id)
    _stop_session(session_id, runtime_arn)
    _purge_session(session_id, runtime_arn, cli, claude_session_id, tenant_id)
    return "efs-purged"


# ─── stream path: UI delete → tombstone → TTL expiry → REMOVE ───────────────────

def _reap(image: dict) -> bool:
    """Reap one expired row (the stream's OldImage). Returns True only when it
    actually released a soft-deleted session row; False for skipped rows."""
    session_id = _ddb_str(image.get("sessionId"))
    if not session_id or session_id.startswith("config:"):
        return False
    if not _ddb_str(image.get("deletedAt")):
        # Hard delete with no tombstone → already reaped or never a session. Skip.
        return False
    if _ddb_str(image.get("computeReleasedAt")):
        # The sweep already released this session's compute (and purged EFS/S3
        # where that applied). Instances sessions' S3 artifacts age out via the
        # bucket lifecycle rule.
        print(f"[reaper] {session_id} already released by the sweep — skipping")
        return False
    runtime_arn = _ddb_str(image.get("runtimeArn")) or DEFAULT_RUNTIME_ARN
    if not runtime_arn:
        raise RuntimeError(f"{session_id}: no runtimeArn on the row and CODING_AGENT_RUNTIME_ARN is not set")
    cli = _ddb_str(image.get("cli")) or "claude"
    claude_session_id = _ddb_str(image.get("claudeSessionId"))
    tenant_id = _ddb_str(image.get("tenantId"))

    print(f"[reaper] reaping {session_id} (cli={cli}, tenant={tenant_id or 'default'}, "
          f"runtime={runtime_arn.rsplit('/', 1)[-1]})")
    kind = _release_compute(session_id, runtime_arn, cli, claude_session_id, tenant_id)
    print(f"[reaper] reaped {session_id}: {kind}")
    return True


def _handle_stream(event) -> dict:
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


# ─── sweep path: release compute behind finished runs ───────────────────────────

def _scan_candidates() -> list:
    """Every live session row not yet released. ~1k rows → one paged scan."""
    rows, kwargs = [], {
        "TableName": CLOUD_CODE_TABLE,
        "FilterExpression": ("attribute_not_exists(computeReleasedAt) AND attribute_not_exists(deletedAt) "
                             "AND NOT begins_with(sessionId, :cfg)"),
        "ExpressionAttributeValues": {":cfg": {"S": "config:"}},
        "ProjectionExpression": ("sessionId, workflowId, #o, runtimeArn, cli, claudeSessionId, "
                                 "tenantId, createdAt, updatedAt"),
        "ExpressionAttributeNames": {"#o": "origin"},
    }
    while True:
        page = _ddb.scan(**kwargs)
        rows.extend(page.get("Items", []))
        lek = page.get("LastEvaluatedKey")
        if not lek:
            return rows
        kwargs["ExclusiveStartKey"] = lek


def _workflow_rows(workflow_ids) -> dict:
    """workflowId → {phase, terminalAt} for the ids that exist."""
    out, ids = {}, sorted(set(workflow_ids))
    for i in range(0, len(ids), 100):
        request = {WORKFLOWS_TABLE: {
            "Keys": [{"workflowId": {"S": wid}} for wid in ids[i:i + 100]],
            "ProjectionExpression": "workflowId, phase, completedAt, cancelledAt, updatedAt",
        }}
        while request:
            page = _ddb.batch_get_item(RequestItems=request)
            for item in page.get("Responses", {}).get(WORKFLOWS_TABLE, []):
                wid = _ddb_str(item.get("workflowId"))
                terminal_at = (_parse_ts(_ddb_str(item.get("completedAt")))
                               or _parse_ts(_ddb_str(item.get("cancelledAt")))
                               or _parse_ts(_ddb_str(item.get("updatedAt"))))
                out[wid] = {"phase": _ddb_str(item.get("phase")), "terminalAt": terminal_at}
            request = page.get("UnprocessedKeys") or None
    return out


def _decide(row: dict, workflows: dict, is_cp: bool, now: datetime):
    """Why this session's compute may be released now, or None to keep it."""
    workflow_id = _ddb_str(row.get("workflowId"))
    is_workflow = bool(workflow_id) or _ddb_str(row.get("origin")) == "workflow"
    last_touch = _parse_ts(_ddb_str(row.get("updatedAt"))) or _parse_ts(_ddb_str(row.get("createdAt")))
    idle_s = (now - last_touch).total_seconds() if last_touch else None

    if is_workflow:
        wf = workflows.get(workflow_id) if workflow_id else None
        if wf is None:
            # Run row gone (or a row that never named its run): nothing will ever
            # resume it, but give a just-started run's first write time to land.
            if idle_s is not None and idle_s > SWEEP_MISSING_WORKFLOW_S:
                return "workflow-missing"
            return None
        if wf["phase"] not in TERMINAL_PHASES:
            return None
        grace = SWEEP_GRACE_CP_S if is_cp else SWEEP_GRACE_EFS_S
        since = (now - wf["terminalAt"]).total_seconds() if wf["terminalAt"] else grace + 1
        return f"workflow-{wf['phase']}" if since > grace else None

    # Human (Cloud Code tab) sessions: only Instances ones, only after a long idle.
    if is_cp and idle_s is not None and idle_s > SWEEP_IDLE_CP_S:
        return "idle"
    return None


def _stamp_released(session_id: str, kind: str, reason: str) -> None:
    try:
        _ddb.update_item(
            TableName=CLOUD_CODE_TABLE,
            Key={"sessionId": {"S": session_id}},
            UpdateExpression="SET computeReleasedAt = :t, computeRelease = :k, computeReleaseReason = :r",
            ConditionExpression="attribute_not_exists(computeReleasedAt)",
            ExpressionAttributeValues={":t": {"S": _now_iso()}, ":k": {"S": kind}, ":r": {"S": reason}},
        )
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise


def _sweep(dry_run: bool = False, context=None) -> dict:
    now = datetime.now(timezone.utc)
    rows = _scan_candidates()
    workflows = _workflow_rows([w for w in (_ddb_str(r.get("workflowId")) for r in rows) if w])
    summary = {"scanned": len(rows), "released": {"cp": 0, "efs": 0}, "planned": [],
               "skipped": 0, "errors": 0, "dry_run": dry_run,
               "deadline_hit": False, "deferred": 0}
    budget = {"cp": SWEEP_MAX_CP, "efs": SWEEP_MAX_PURGE}
    # No context (or a context without the method) → no deadline, behaviour
    # unchanged from before this Lambda-context awareness existed.
    remaining_ms = getattr(context, "get_remaining_time_in_millis", None)

    try:
        for row in rows:
            session_id = _ddb_str(row.get("sessionId"))
            runtime_arn = _ddb_str(row.get("runtimeArn")) or DEFAULT_RUNTIME_ARN
            if not session_id or not runtime_arn:
                summary["skipped"] += 1
                continue
            try:
                cp_id = _capacity_provider_id(runtime_arn)
            except Exception as exc:  # noqa: BLE001 — unknown runtime → leave the row for next time
                print(f"[sweep] {session_id}: runtime lookup failed, skipping: {type(exc).__name__}: {str(exc)[:200]}")
                summary["errors"] += 1
                continue
            reason = _decide(row, workflows, bool(cp_id), now)
            if not reason:
                continue
            lane = "cp" if cp_id else "efs"
            if budget[lane] <= 0:
                summary["skipped"] += 1
                continue
            budget[lane] -= 1
            if dry_run:
                summary["planned"].append({"sessionId": session_id, "lane": lane, "reason": reason})
                continue
            if not summary["deadline_hit"] and remaining_ms and remaining_ms() < SWEEP_DEADLINE_MARGIN_MS:
                summary["deadline_hit"] = True
            if summary["deadline_hit"]:
                # Next tick re-plans this row: it is still unstamped, so the scan finds it.
                summary["deferred"] += 1
                continue
            try:
                kind = _release_compute(session_id, runtime_arn, _ddb_str(row.get("cli")) or "claude",
                                        _ddb_str(row.get("claudeSessionId")), _ddb_str(row.get("tenantId")))
                _stamp_released(session_id, kind, reason)
                summary["released"][lane] += 1
                print(f"[sweep] released {session_id}: {kind} ({reason})")
            except Exception as exc:  # noqa: BLE001 — one bad row must not stop the sweep
                summary["errors"] += 1
                print(f"[sweep] {session_id}: release failed: {type(exc).__name__}: {str(exc)[:300]}")
    finally:
        print(f"[sweep] {json.dumps({k: v for k, v in summary.items() if k != 'planned'})}"
              + (f" planned={len(summary['planned'])}" if dry_run else ""))
    return summary


def handler(event, context):
    """Stream records → reap each tombstoned REMOVE (raises so the batch is
    retried/bisected). {"sweep": true[, "dry_run": true]} → one sweep pass."""
    if event.get("Records"):
        return _handle_stream(event)
    if event.get("sweep"):
        return _sweep(dry_run=bool(event.get("dry_run")), context=context)
    raise ValueError("unrecognised event: expected DynamoDB stream Records or {\"sweep\": true}")
