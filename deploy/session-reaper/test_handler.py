"""Hermetic tests for the session reaper (stream path + sweep). boto3 clients are
stubbed before the handler module is imported; no AWS."""

import importlib.util
import json
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import pytest
from botocore.exceptions import ClientError

HANDLER = Path(__file__).resolve().parent / "handler.py"

RUNTIME_A = "arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/coding-a"
RUNTIME_B = "arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/coding-b"
CP_ARN = "arn:aws:bedrock-agentcore:us-east-1:000000000000:capacity-provider/cp-1"

NOW = datetime(2026, 9, 11, 22, 0, 0, tzinfo=timezone.utc)


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _client_error(code):
    return ClientError({"Error": {"Code": code, "Message": code}}, "op")


class FakeAgentCore:
    def __init__(self, has_cp_api=True):
        ops = ["InvokeAgentRuntime", "StopRuntimeSession"] + (["DeleteCapacityProviderSession"] if has_cp_api else [])
        self.meta = types.SimpleNamespace(service_model=types.SimpleNamespace(operation_names=ops))
        self.stopped, self.purged, self.deleted = [], [], []
        self.delete_error = None
        self.stop_error = None

    def stop_runtime_session(self, **kw):
        if self.stop_error:
            raise self.stop_error
        self.stopped.append((kw["runtimeSessionId"], kw["agentRuntimeArn"]))

    def invoke_agent_runtime(self, **kw):
        payload = json.loads(kw["payload"])
        assert payload.get("purge") is True
        self.purged.append((kw["runtimeSessionId"], kw["agentRuntimeArn"], payload))
        return {"response": json.dumps({"purged": True}).encode()}

    def delete_capacity_provider_session(self, **kw):
        if self.delete_error:
            raise self.delete_error
        self.deleted.append((kw["sessionId"], kw["capacityProviderId"]))


class FakeControl:
    def __init__(self):
        self.calls = 0

    def get_agent_runtime(self, agentRuntimeId):
        self.calls += 1
        if agentRuntimeId == "coding-b":
            return {"agentRuntimeId": agentRuntimeId,
                    "capacityProviderConfiguration": {"capacityProviderArn": CP_ARN}}
        return {"agentRuntimeId": agentRuntimeId}


class FakeDynamo:
    def __init__(self, sessions, workflows):
        self.sessions = {s["sessionId"]["S"]: s for s in sessions}
        self.workflows = {w["workflowId"]["S"]: w for w in workflows}
        self.stamped = []

    def scan(self, **kw):
        # Emulate the FilterExpression the handler sends, two pages.
        live = [s for s in self.sessions.values()
                if "computeReleasedAt" not in s and "deletedAt" not in s
                and not s["sessionId"]["S"].startswith("config:")]
        if "ExclusiveStartKey" in kw:
            return {"Items": live[1:]}
        return {"Items": live[:1], "LastEvaluatedKey": {"sessionId": {"S": "x"}}} if len(live) > 1 \
            else {"Items": live}

    def batch_get_item(self, RequestItems):
        (table, req), = RequestItems.items()
        found = [self.workflows[k["workflowId"]["S"]] for k in req["Keys"] if k["workflowId"]["S"] in self.workflows]
        return {"Responses": {table: found}}

    def update_item(self, **kw):
        sid = kw["Key"]["sessionId"]["S"]
        if "computeReleasedAt" in self.sessions[sid]:
            raise _client_error("ConditionalCheckFailedException")
        vals = kw["ExpressionAttributeValues"]
        self.sessions[sid]["computeReleasedAt"] = vals[":t"]
        self.sessions[sid]["computeRelease"] = vals[":k"]
        self.stamped.append((sid, vals[":k"]["S"], vals[":r"]["S"]))


def _load(agentcore, control, ddb, env=None):
    fakes = {"bedrock-agentcore": agentcore, "bedrock-agentcore-control": control, "dynamodb": ddb}
    env = {"CODING_AGENT_RUNTIME_ARN": RUNTIME_A, **(env or {})}
    with mock.patch.dict("os.environ", env), \
         mock.patch("boto3.client", side_effect=lambda name, **kw: fakes[name]):
        spec = importlib.util.spec_from_file_location("reaper_handler_under_test", HANDLER)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
    return mod


def _session(sid, runtime=None, workflow=None, origin=None, updated=None, **extra):
    item = {"sessionId": {"S": sid}, "cli": {"S": "claude"}, "claudeSessionId": {"S": f"conv-{sid}"},
            "createdAt": {"S": _iso(NOW - timedelta(days=3))},
            "updatedAt": {"S": _iso(updated or NOW - timedelta(hours=2))}}
    if runtime:
        item["runtimeArn"] = {"S": runtime}
    if workflow:
        item["workflowId"] = {"S": workflow}
        item["origin"] = {"S": "workflow"}
    elif origin:
        item["origin"] = {"S": origin}
    for k, v in extra.items():
        item[k] = {"S": v}
    return item


def _workflow(wid, phase, terminal_at=None):
    item = {"workflowId": {"S": wid}, "phase": {"S": phase}}
    if terminal_at:
        item["completedAt"] = {"S": _iso(terminal_at)}
    return item


def _run_sweep(mod, dry_run=False, context=None):
    with mock.patch.object(mod, "datetime", wraps=datetime) as dt:
        dt.now.return_value = NOW
        return mod.handler({"sweep": True, "dry_run": dry_run}, context)


class FakeContext:
    """Lambda context whose remaining time drops below the margin once
    `purges_before_deadline` EFS purges have happened."""

    def __init__(self, ac, purges_before_deadline, margin_ms=90000):
        self.ac, self.n, self.margin_ms = ac, purges_before_deadline, margin_ms

    def get_remaining_time_in_millis(self):
        return 900_000 if len(self.ac.purged) < self.n else self.margin_ms - 1


# ─── sweep ───────────────────────────────────────────────────────────────────────

def test_terminal_workflow_past_grace_releases_cp_session_and_stamps_row():
    ac, ctl = FakeAgentCore(), FakeControl()
    ddb = FakeDynamo([_session("cc-1", RUNTIME_B, "wf-1")],
                     [_workflow("wf-1", "complete", NOW - timedelta(hours=1))])
    out = _run_sweep(_load(ac, ctl, ddb))
    assert ac.deleted == [("cc-1", "cp-1")]
    assert ac.purged == [] and ac.stopped == []
    assert ddb.stamped == [("cc-1", "cp-session-deleted", "workflow-complete")]
    assert out["released"] == {"cp": 1, "efs": 0}


def test_terminal_workflow_within_cp_grace_is_kept():
    ac, ctl = FakeAgentCore(), FakeControl()
    ddb = FakeDynamo([_session("cc-1", RUNTIME_B, "wf-1")],
                     [_workflow("wf-1", "complete", NOW - timedelta(minutes=10))])
    _run_sweep(_load(ac, ctl, ddb))
    assert ac.deleted == [] and ddb.stamped == []


def test_active_workflow_is_never_touched():
    ac, ctl = FakeAgentCore(), FakeControl()
    ddb = FakeDynamo([_session("cc-1", RUNTIME_B, "wf-1"), _session("cc-2", RUNTIME_A, "wf-1")],
                     [_workflow("wf-1", "dev", NOW - timedelta(days=2))])
    out = _run_sweep(_load(ac, ctl, ddb))
    assert ac.deleted == [] and ac.purged == [] and ddb.stamped == []
    assert out["scanned"] == 2


@pytest.mark.parametrize("phase", ["error", "cancelled", "deploy-blocked", "static-ci-only"])
def test_every_terminal_phase_counts(phase):
    ac, ctl = FakeAgentCore(), FakeControl()
    ddb = FakeDynamo([_session("cc-1", RUNTIME_B, "wf-1")], [_workflow("wf-1", phase, NOW - timedelta(hours=1))])
    _run_sweep(_load(ac, ctl, ddb))
    assert ddb.stamped == [("cc-1", "cp-session-deleted", f"workflow-{phase}")]


def test_efs_session_of_finished_run_is_stopped_and_purged_after_the_long_grace():
    ac, ctl = FakeAgentCore(), FakeControl()
    ddb = FakeDynamo([_session("cc-efs", None, "wf-1", tenantId="t-9")],  # legacy row: no runtimeArn
                     [_workflow("wf-1", "complete", NOW - timedelta(hours=7))])
    _run_sweep(_load(ac, ctl, ddb))
    assert ac.stopped == [("cc-efs", RUNTIME_A)]
    assert len(ac.purged) == 1
    sid, arn, payload = ac.purged[0]
    assert (sid, arn) == ("cc-efs", RUNTIME_A)
    assert payload["claude_session_id"] == "conv-cc-efs" and payload["tenant_id"] == "t-9"
    assert ddb.stamped == [("cc-efs", "efs-purged", "workflow-complete")]


def test_efs_session_within_efs_grace_is_kept_even_though_cp_grace_passed():
    ac, ctl = FakeAgentCore(), FakeControl()
    ddb = FakeDynamo([_session("cc-efs", RUNTIME_A, "wf-1")], [_workflow("wf-1", "complete", NOW - timedelta(hours=2))])
    _run_sweep(_load(ac, ctl, ddb))
    assert ac.purged == [] and ddb.stamped == []


def test_missing_workflow_row_releases_only_after_a_day():
    ac, ctl = FakeAgentCore(), FakeControl()
    ddb = FakeDynamo([_session("young", RUNTIME_B, "wf-gone", updated=NOW - timedelta(hours=3)),
                      _session("old", RUNTIME_B, "wf-gone", updated=NOW - timedelta(days=2))], [])
    _run_sweep(_load(ac, ctl, ddb))
    assert ac.deleted == [("old", "cp-1")]
    assert ddb.stamped == [("old", "cp-session-deleted", "workflow-missing")]


def test_human_sessions_cp_idle_two_weeks_released_efs_never():
    ac, ctl = FakeAgentCore(), FakeControl()
    ddb = FakeDynamo([_session("h-cp-idle", RUNTIME_B, origin="ui", updated=NOW - timedelta(days=15)),
                      _session("h-cp-fresh", RUNTIME_B, origin="ui", updated=NOW - timedelta(days=1)),
                      _session("h-efs-idle", RUNTIME_A, origin="ui", updated=NOW - timedelta(days=90))], [])
    _run_sweep(_load(ac, ctl, ddb))
    assert ac.deleted == [("h-cp-idle", "cp-1")]
    assert ac.purged == [] and ac.stopped == []
    assert [s for s, *_ in ddb.stamped] == ["h-cp-idle"]


def test_per_sweep_caps_are_respected_per_lane():
    ac, ctl = FakeAgentCore(), FakeControl()
    sessions = [_session(f"cp-{i}", RUNTIME_B, "wf-1") for i in range(4)] + \
               [_session(f"efs-{i}", RUNTIME_A, "wf-1") for i in range(3)]
    ddb = FakeDynamo(sessions, [_workflow("wf-1", "complete", NOW - timedelta(days=1))])
    out = _run_sweep(_load(ac, ctl, ddb, env={"SWEEP_MAX_CP": "2", "SWEEP_MAX_PURGE": "1"}))
    assert out["released"] == {"cp": 2, "efs": 1}
    assert out["skipped"] == 4


def test_dry_run_plans_without_any_mutation():
    ac, ctl = FakeAgentCore(), FakeControl()
    ddb = FakeDynamo([_session("cc-1", RUNTIME_B, "wf-1"), _session("cc-2", RUNTIME_A, "wf-1")],
                     [_workflow("wf-1", "complete", NOW - timedelta(days=1))])
    out = _run_sweep(_load(ac, ctl, ddb), dry_run=True)
    assert ac.deleted == [] and ac.purged == [] and ac.stopped == [] and ddb.stamped == []
    assert sorted((p["sessionId"], p["lane"]) for p in out["planned"]) == [("cc-1", "cp"), ("cc-2", "efs")]


def test_release_failure_is_logged_and_the_row_stays_unstamped():
    ac, ctl = FakeAgentCore(), FakeControl()
    ac.delete_error = _client_error("ThrottlingException")
    ddb = FakeDynamo([_session("cc-1", RUNTIME_B, "wf-1")], [_workflow("wf-1", "complete", NOW - timedelta(days=1))])
    out = _run_sweep(_load(ac, ctl, ddb))
    assert out["errors"] == 1 and ddb.stamped == []


def test_absent_cp_session_counts_as_released():
    ac, ctl = FakeAgentCore(), FakeControl()
    ac.delete_error = _client_error("ResourceNotFoundException")
    ddb = FakeDynamo([_session("cc-1", RUNTIME_B, "wf-1")], [_workflow("wf-1", "complete", NOW - timedelta(days=1))])
    _run_sweep(_load(ac, ctl, ddb))
    assert ddb.stamped == [("cc-1", "cp-session-absent", "workflow-complete")]


def test_runtime_lookup_is_cached_per_arn():
    ac, ctl = FakeAgentCore(), FakeControl()
    ddb = FakeDynamo([_session(f"cc-{i}", RUNTIME_B, "wf-1") for i in range(5)],
                     [_workflow("wf-1", "complete", NOW - timedelta(days=1))])
    _run_sweep(_load(ac, ctl, ddb))
    assert ctl.calls == 1


def test_old_sdk_fails_closed_instead_of_purging_an_instances_session():
    ac, ctl = FakeAgentCore(has_cp_api=False), FakeControl()
    ddb = FakeDynamo([_session("cc-1", RUNTIME_B, "wf-1")], [_workflow("wf-1", "complete", NOW - timedelta(days=1))])
    out = _run_sweep(_load(ac, ctl, ddb))
    assert ac.purged == [] and ac.deleted == [] and ddb.stamped == []
    assert out["errors"] == 1


# ─── sweep deadline ──────────────────────────────────────────────────────────────

def test_sweep_defers_remaining_releases_when_the_deadline_nears(capsys):
    ac, ctl = FakeAgentCore(), FakeControl()
    sessions = [_session(f"efs-{i}", RUNTIME_A, "wf-1") for i in range(5)]
    ddb = FakeDynamo(sessions, [_workflow("wf-1", "complete", NOW - timedelta(hours=7))])
    out = _run_sweep(_load(ac, ctl, ddb), context=FakeContext(ac, 2))
    assert len(ac.purged) == 2
    assert len(ddb.stamped) == 2
    assert out["deadline_hit"] is True
    assert out["deferred"] == 3
    assert out["released"]["efs"] + out["deferred"] == 5
    lines = [line for line in capsys.readouterr().out.splitlines() if line.startswith("[sweep] {")]
    assert len(lines) == 1
    assert "deadline_hit" in lines[0]


def test_sweep_without_a_context_releases_the_whole_plan():
    ac, ctl = FakeAgentCore(), FakeControl()
    sessions = [_session(f"efs-{i}", RUNTIME_A, "wf-1") for i in range(5)]
    ddb = FakeDynamo(sessions, [_workflow("wf-1", "complete", NOW - timedelta(hours=7))])
    out = _run_sweep(_load(ac, ctl, ddb))
    assert len(ac.purged) == 5
    assert len(ddb.stamped) == 5
    assert out["deadline_hit"] is False
    assert out["deferred"] == 0


def test_dry_run_plans_everything_even_past_the_deadline():
    ac, ctl = FakeAgentCore(), FakeControl()
    sessions = [_session(f"efs-{i}", RUNTIME_A, "wf-1") for i in range(4)]
    ddb = FakeDynamo(sessions, [_workflow("wf-1", "complete", NOW - timedelta(hours=7))])
    out = _run_sweep(_load(ac, ctl, ddb), dry_run=True, context=FakeContext(ac, 0))
    assert len(out["planned"]) == 4
    assert ac.purged == [] and ac.stopped == [] and ddb.stamped == []
    assert out["deferred"] == 0
    assert out["deadline_hit"] is False


def test_summary_is_printed_when_an_unexpected_error_escapes_the_loop(capsys):
    ac, ctl = FakeAgentCore(), FakeControl()
    ddb = FakeDynamo([_session("cc-1", RUNTIME_B, "wf-1")], [_workflow("wf-1", "complete", NOW - timedelta(days=1))])
    mod = _load(ac, ctl, ddb)
    with mock.patch.object(mod, "_decide", side_effect=RuntimeError("boom")):
        with pytest.raises(RuntimeError):
            _run_sweep(mod)
    lines = [line for line in capsys.readouterr().out.splitlines() if line.startswith("[sweep] {")]
    assert len(lines) == 1


def test_stop_of_an_already_gone_session_logs_an_info_line(capsys):
    ac, ctl = FakeAgentCore(), FakeControl()
    ac.stop_error = _client_error("ResourceNotFoundException")
    ddb = FakeDynamo([_session("cc-efs", None, "wf-1", tenantId="t-9")],
                     [_workflow("wf-1", "complete", NOW - timedelta(hours=7))])
    _run_sweep(_load(ac, ctl, ddb))
    assert len(ac.purged) == 1
    assert ddb.stamped == [("cc-efs", "efs-purged", "workflow-complete")]
    out = capsys.readouterr().out
    assert "[reaper] stop cc-efs: runtime session already gone (ResourceNotFoundException)" in out


# ─── stream path ─────────────────────────────────────────────────────────────────

def _remove_record(image):
    return {"eventName": "REMOVE", "dynamodb": {"OldImage": image}}


def test_stream_remove_of_instances_row_deletes_the_cp_session():
    ac, ctl = FakeAgentCore(), FakeControl()
    mod = _load(ac, ctl, FakeDynamo([], []))
    out = mod.handler({"Records": [_remove_record(_session("cc-1", RUNTIME_B, deletedAt=_iso(NOW)))]}, None)
    assert out == {"reaped": 1}
    assert ac.deleted == [("cc-1", "cp-1")] and ac.purged == []


def test_stream_remove_of_legacy_row_stops_and_purges_on_the_default_runtime():
    ac, ctl = FakeAgentCore(), FakeControl()
    mod = _load(ac, ctl, FakeDynamo([], []))
    out = mod.handler({"Records": [_remove_record(_session("cc-1", None, deletedAt=_iso(NOW)))]}, None)
    assert out == {"reaped": 1}
    assert ac.stopped == [("cc-1", RUNTIME_A)] and ac.purged[0][1] == RUNTIME_A


def test_stream_remove_skips_rows_without_tombstone_or_already_released():
    ac, ctl = FakeAgentCore(), FakeControl()
    mod = _load(ac, ctl, FakeDynamo([], []))
    out = mod.handler({"Records": [
        _remove_record(_session("hard-delete", RUNTIME_B)),
        _remove_record(_session("swept", RUNTIME_B, deletedAt=_iso(NOW), computeReleasedAt=_iso(NOW))),
        _remove_record({"sessionId": {"S": "config:foo"}, "deletedAt": {"S": _iso(NOW)}}),
        {"eventName": "MODIFY", "dynamodb": {"OldImage": _session("mod", RUNTIME_B, deletedAt=_iso(NOW))}},
    ]}, None)
    assert out == {"reaped": 0}
    assert ac.deleted == [] and ac.purged == [] and ac.stopped == []


def test_stream_failure_raises_so_the_batch_is_retried():
    ac, ctl = FakeAgentCore(), FakeControl()
    ac.delete_error = _client_error("ThrottlingException")
    mod = _load(ac, ctl, FakeDynamo([], []))
    with pytest.raises(ClientError):
        mod.handler({"Records": [_remove_record(_session("cc-1", RUNTIME_B, deletedAt=_iso(NOW)))]}, None)


def test_unknown_event_is_rejected():
    mod = _load(FakeAgentCore(), FakeControl(), FakeDynamo([], []))
    with pytest.raises(ValueError):
        mod.handler({"hello": True}, None)
