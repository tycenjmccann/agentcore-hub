"""Hermetic tests for update-runtime-image.py's read-then-swap kwargs (no AWS)."""
import importlib.util
import pathlib

_SPEC = importlib.util.spec_from_file_location(
    "update_runtime_image", pathlib.Path(__file__).with_name("update-runtime-image.py")
)
uri = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(uri)

NEW = "123.dkr.ecr.us-east-1.amazonaws.com/runtime-agent@sha256:" + "e" * 64


def _live_vpc():
    return {
        "agentRuntimeId": "rt-1",
        "agentRuntimeArn": "arn:...",  # output-only, must not be echoed
        "status": "READY",
        "agentRuntimeVersion": "56",
        "roleArn": "arn:aws:iam::123:role/r",
        "networkConfiguration": {
            "networkMode": "VPC",
            "networkModeConfig": {
                "securityGroups": ["sg-1"],
                "subnets": ["subnet-a", "subnet-b"],
                "requireServiceS3Endpoint": False,
            },
        },
        "protocolConfiguration": {"serverProtocol": "HTTP"},
        "filesystemConfigurations": [{"efsAccessPoint": {"accessPointArn": "ap", "mountPath": "/mnt/efs"}}],
        "lifecycleConfiguration": {"idleRuntimeSessionTimeout": 1800, "maxLifetime": 28800},
        "environmentVariables": {"MEMORY_ID": "m", "GITHUB_PAT": "secret"},
        "agentRuntimeArtifact": {"containerConfiguration": {"containerUri": "old"}},
    }


def test_strips_require_service_s3_endpoint_but_keeps_vpc_wiring():
    kw = uri._update_kwargs_from_live(_live_vpc(), NEW)
    cfg = kw["networkConfiguration"]["networkModeConfig"]
    assert "requireServiceS3Endpoint" not in cfg
    assert cfg["securityGroups"] == ["sg-1"]
    assert cfg["subnets"] == ["subnet-a", "subnet-b"]
    assert kw["networkConfiguration"]["networkMode"] == "VPC"


def test_only_image_changes_and_output_fields_are_not_echoed():
    kw = uri._update_kwargs_from_live(_live_vpc(), NEW)
    assert kw["agentRuntimeArtifact"]["containerConfiguration"]["containerUri"] == NEW
    assert kw["agentRuntimeId"] == "rt-1"
    for preserved in uri._PRESERVED:
        assert preserved in kw
    assert kw["environmentVariables"] == {"MEMORY_ID": "m", "GITHUB_PAT": "secret"}
    assert kw["lifecycleConfiguration"]["maxLifetime"] == 28800
    for output_only in ("agentRuntimeArn", "status", "agentRuntimeVersion"):
        assert output_only not in kw


def test_public_network_mode_passes_through_untouched():
    live = _live_vpc()
    live["networkConfiguration"] = {"networkMode": "PUBLIC"}
    for f in ("protocolConfiguration", "filesystemConfigurations"):
        live.pop(f)
    kw = uri._update_kwargs_from_live(live, NEW)
    assert kw["networkConfiguration"] == {"networkMode": "PUBLIC"}
    assert "protocolConfiguration" not in kw
    assert "filesystemConfigurations" not in kw


# ── Post-promote smoke (fleet v41, 2026-09-09) ───────────────────────────────
# READY is a control-plane status. The image that killed every persona at import
# was READY. _smoke is what turns "accepted" into "verified", and its failure is
# what fires the buildspec's rollback trap.
import io
import pytest


class _FakeBody:
    def __init__(self, text):
        self._text = text

    def read(self):
        return self._text.encode()


class _FakeDataPlane:
    def __init__(self, bodies):
        self._bodies = list(bodies)
        self.calls = []

    def invoke_agent_runtime(self, **kwargs):
        self.calls.append(kwargs)
        nxt = self._bodies.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return {"response": _FakeBody(nxt)}


def _patch(monkeypatch, client):
    monkeypatch.setattr(uri.boto3, "client", lambda *a, **k: client)
    monkeypatch.setattr(uri.time, "sleep", lambda _s: None)


def test_smoke_passes_on_ok_marker(monkeypatch):
    client = _FakeDataPlane(['{"ok": true, "marker": "AGENTCORE_HUB_HEALTHCHECK_OK"}'])
    _patch(monkeypatch, client)
    uri._smoke("us-east-1", "arn:rt", "agentcore_hub_agent")
    assert len(client.calls) == 1
    assert len(client.calls[0]["runtimeSessionId"]) >= 33
    assert b'"healthcheck"' in client.calls[0]["payload"]


def test_smoke_fails_hard_on_fail_marker(monkeypatch):
    body = '{"ok": false, "marker": "AGENTCORE_HUB_HEALTHCHECK_FAIL", "error": "ImportError"}'
    client = _FakeDataPlane([body, body, body])
    _patch(monkeypatch, client)
    with pytest.raises(SystemExit) as e:
        uri._smoke("us-east-1", "arn:rt", "agentcore_hub_agent")
    assert e.value.code == 1
    assert len(client.calls) == 3  # every attempt used before failing


def test_smoke_retries_a_cold_start_error_then_passes(monkeypatch):
    client = _FakeDataPlane([
        RuntimeError("read timeout on cold start"),
        '{"marker": "AGENTCORE_HUB_HEALTHCHECK_OK"}',
    ])
    _patch(monkeypatch, client)
    uri._smoke("us-east-1", "arn:rt", "agentcore_hub_agent")
    assert len(client.calls) == 2
    # fresh session id per attempt — never reuse a half-dead session
    assert client.calls[0]["runtimeSessionId"] != client.calls[1]["runtimeSessionId"]


def test_smoke_treats_a_body_with_no_marker_as_failure(monkeypatch):
    client = _FakeDataPlane(['{"error": "Received error (500)"}'] * 3)
    _patch(monkeypatch, client)
    with pytest.raises(SystemExit):
        uri._smoke("us-east-1", "arn:rt", "agentcore_hub_agent", attempts=3)
