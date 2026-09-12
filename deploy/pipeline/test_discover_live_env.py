"""Hermetic tests for discover-live-env.py (no AWS). Run with pytest from repo root."""
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("discover_live_env", HERE / "discover-live-env.py")
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)

CONN = "arn:aws:codeconnections:us-east-1:111111111111:connection/abc"
TOPIC = "arn:aws:sns:us-east-1:111111111111:agentcore-hub-pipeline-approvals"
ECS = "arn:aws:ecs:us-east-1:111111111111:service/default/agentcore-hub"
OUTPUTS = {"ConnectionArn": CONN, "ApprovalTopicArn": TOPIC}


def run(env=None, **kw):
    base = dict(
        current_env=env or {},
        stack_exists=True,
        resource_types={d.TOPIC_TYPE},  # topic stack-owned, connection imported
        outputs=OUTPUTS,
        deploy_project_env={"ECS_SERVICE_ARN": ECS},
        ci_webhook_present=False,
    )
    base.update(kw)
    return d.derive(**base)


def test_first_deploy_derives_nothing():
    assert run(stack_exists=False) == {}


def test_imported_connection_and_ecs_are_kept_across_redeploy():
    # The 2026-09-09 hazard: a bare shell would have re-minted the connection.
    out = run()
    assert out["PIPELINE_CONNECTION_ARN"] == CONN
    assert out["ECS_SERVICE_ARN"] == ECS
    assert "PIPELINE_APPROVAL_SNS_ARN" not in out  # stack-owned -> never imported
    assert "PIPELINE_CI_WEBHOOK" not in out


def test_stack_owned_connection_is_never_exported_as_import():
    out = run(resource_types={d.TOPIC_TYPE, d.CONNECTION_TYPE})
    assert "PIPELINE_CONNECTION_ARN" not in out


def test_imported_topic_is_kept():
    out = run(resource_types=set())
    assert out["PIPELINE_APPROVAL_SNS_ARN"] == TOPIC


def test_explicit_env_wins_and_blank_counts_as_unset():
    out = run(env={"PIPELINE_CONNECTION_ARN": "arn:explicit", "ECS_SERVICE_ARN": "  "})
    assert "PIPELINE_CONNECTION_ARN" not in out
    assert out["ECS_SERVICE_ARN"] == ECS


def test_live_webhook_is_preserved():
    assert run(ci_webhook_present=True)["PIPELINE_CI_WEBHOOK"] == "1"


def test_missing_live_values_are_skipped():
    out = run(outputs={}, deploy_project_env={})
    assert out == {}
