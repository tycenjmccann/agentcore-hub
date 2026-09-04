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
