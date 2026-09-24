#!/usr/bin/env python3
"""Unit tests for save_routine's modelOverride gate (TEAM-5019) — hermetic, no AWS.

save_routine.py is the Routine Builder harness's write path for routine rows, and
it used to persist input.modelOverride untouched — bypassing the guard TEAM-5016
F6 put on POST/PATCH /api/routines. A bad override is forwarded to
/api/workflow/start on every fire and 400s there, so the routine failed silently
on its schedule forever. These tests pin the gate: the same shapes, reasons and
normalized id as src/lib/routines/model-override.ts, fail-closed when the
registry cannot be read, and no AWS write before the verdict.

boto3 is stubbed in sys.modules for the IMPORT only (save_routine builds its
clients at module load; the CI battery's deps need not include boto3), scoped
with patch.dict so the stub does not leak into later tests in the same run. The
registry is the bundled seed (src/config/models.json), normalized by the
toolkit's own models_registry copy and handed in by monkeypatching
load_registry — no S3 GET is ever made.

Run: pytest -q deploy/routine-builder/toolkit/test_save_routine.py
"""

import json
import os
import sys
from pathlib import Path
from unittest import mock

import pytest

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent.parent
SEED_PATH = REPO_ROOT / "src" / "config" / "models.json"
CANONICAL = REPO_ROOT / "deploy" / "runtime-agent" / "models_registry.py"

sys.path.insert(0, str(HERE))
os.environ.setdefault("ARTIFACT_BUCKET", "test-bucket")
with mock.patch.dict(sys.modules, {"boto3": mock.MagicMock()}):
    import save_routine  # noqa: E402

# A 6-field ARN: upsert_schedule reads the account from split(":")[4].
RUNNER_ARN = "arn:aws:lambda:us-east-1:111122223333:function:agentcore-hub-routines-runner"


@pytest.fixture(autouse=True)
def _harness(monkeypatch):
    """Harness env + fresh AWS stubs + the seed as the live registry, per test."""
    monkeypatch.setattr(save_routine, "RUNNER_ARN", RUNNER_ARN)
    monkeypatch.setattr(save_routine, "SCHEDULER_ROLE_ARN", "arn:aws:iam::111122223333:role/routines-scheduler")
    monkeypatch.setattr(save_routine, "ddb", mock.MagicMock())
    monkeypatch.setattr(save_routine, "scheduler", mock.MagicMock())
    seed, _warnings = save_routine.models_registry.parse_registry(json.loads(SEED_PATH.read_text()))
    loader = mock.MagicMock(return_value=seed)
    monkeypatch.setattr(save_routine.models_registry, "load_registry", loader)
    return loader


def _routine(**input_extra):
    return {
        "name": "Weekly Ad Report",
        "workflowDefId": "routine-weekly-ad-report",
        "schedule": {"expression": "cron(0 9 ? * MON *)", "timezone": "America/Los_Angeles"},
        "input": {
            "titleTemplate": "Weekly Ad Report {date}",
            "description": "Pull the numbers, draft the plan.",
            "workflowDefId": "routine-weekly-ad-report",
            **input_extra,
        },
    }


# ─── clearing and the no-GET path ────────────────────────────────────────────

def test_absent_override_reads_no_registry(_harness):
    r = _routine()
    before = json.loads(json.dumps(r))
    save_routine.validate(r)
    assert r == before
    _harness.assert_not_called()


@pytest.mark.parametrize("value", [None, "", "   "])
def test_null_or_blank_override_is_cleared_without_a_registry_read(_harness, value):
    r = _routine(modelOverride=value)
    save_routine.validate(r)
    # Removed, not stored as null: main()'s None filter is top-level only.
    assert "modelOverride" not in r["input"]
    _harness.assert_not_called()


# ─── acceptance: the NORMALIZED string is what lands ─────────────────────────

@pytest.mark.parametrize("value,model_id", [
    ("claude-sonnet-5", "us.anthropic.claude-sonnet-5"),
    ("opus", "us.anthropic.claude-opus-5"),
    ("  claude-sonnet-5  ", "us.anthropic.claude-sonnet-5"),
    # The object form is accepted, but a routine's override is a STRING.
    ({"bedrockModelConfig": {"modelId": "opus"}}, "us.anthropic.claude-opus-5"),
])
def test_valid_override_is_stored_as_the_catalog_id(_harness, value, model_id):
    r = _routine(modelOverride=value)
    save_routine.validate(r)
    assert r["input"]["modelOverride"] == model_id
    _harness.assert_called_once()


# ─── refusal: the hub's 400 vocabulary ───────────────────────────────────────

@pytest.mark.parametrize("value,reason", [
    ("clade-opus-5", "unknown_model"),
    ("us.anthropic.claude-nonesuch-9", "not_in_catalog"),
    ("us.anthropic.claude-opus-4-8", "inactive"),
    ("anthropic.claude-opus-5", "read_only"),
    ({"openAiModelConfig": {"modelId": "gpt-5.5"}}, "unsupported_shape"),
    ({"bedrockModelConfig": {"modelId": "us.anthropic.claude-opus-5", "apiKeyArn": "arn:x"}}, "unsupported_shape"),
    ({"bedrockModelConfig": {"modelId": ""}}, "unknown_model"),
    (42, "unsupported_shape"),
], ids=repr)
def test_invalid_override_is_refused_by_reason(value, reason):
    with pytest.raises(SystemExit) as exc:
        save_routine.validate(_routine(modelOverride=value))
    msg = str(exc.value)
    assert "invalid_model_override" in msg
    assert f"reason={reason}" in msg


def test_quarantined_and_unpriced_rows_are_refused(_harness):
    raw = json.loads(SEED_PATH.read_text())
    raw["quarantine"] = ["us.anthropic.claude-sonnet-5"]
    next(r for r in raw["catalog"] if r["modelId"] == "us.anthropic.claude-opus-5").pop("price", None)
    _harness.return_value = save_routine.models_registry.parse_registry(raw)[0]
    # The quarantine list and resolve_model's re-check both key on the CANONICAL
    # id (mirroring the TS canonical's resolveOverrideId) — an alias for a
    # quarantined id resolves as an unrelated unknown_model, not "quarantined".
    for value, reason in (("us.anthropic.claude-sonnet-5", "quarantined"), ("opus", "unpriced")):
        with pytest.raises(SystemExit) as exc:
            save_routine.validate(_routine(modelOverride=value))
        assert f"reason={reason}" in str(exc.value)


def test_unreadable_registry_fails_closed(_harness):
    # The hub would fall back to its bundled seed; the toolkit has none, and
    # writing the value unvalidated is the bug. So: refuse, and say how to proceed.
    _harness.return_value = None
    with pytest.raises(SystemExit) as exc:
        save_routine.validate(_routine(modelOverride="opus"))
    msg = str(exc.value)
    assert "config/models.json" in msg
    assert "omit modelOverride" in msg


# ─── through main(): the verdict precedes every AWS write ────────────────────

def _run_main(monkeypatch, tmp_path, routine):
    path = tmp_path / "routine.json"
    path.write_text(json.dumps(routine))
    monkeypatch.setattr(sys, "argv", ["save_routine.py", "--routine-file", str(path)])
    save_routine.main()


def test_main_refusal_makes_no_aws_call(monkeypatch, tmp_path):
    with pytest.raises(SystemExit):
        _run_main(monkeypatch, tmp_path, _routine(modelOverride="clade-opus-5"))
    assert save_routine.scheduler.method_calls == []
    assert save_routine.ddb.method_calls == []


def test_main_persists_the_normalized_override(monkeypatch, tmp_path, capsys):
    _run_main(monkeypatch, tmp_path, _routine(modelOverride="opus"))
    put = save_routine.ddb.Table.return_value.put_item
    put.assert_called_once()
    assert put.call_args.kwargs["Item"]["input"]["modelOverride"] == "us.anthropic.claude-opus-5"
    assert json.loads(capsys.readouterr().out)["saved"] is True


# ─── the shipped twin ────────────────────────────────────────────────────────

def test_toolkit_models_registry_is_byte_identical_to_the_canonical():
    # Also enforced by scripts/check-models-registry-parity.sh. Pinned here too
    # because another test in the same battery (the coding runtime's
    # merge-codex-config.py) imports a plain `models_registry` first, so which
    # copy sys.modules holds depends on collection order — byte-identity is
    # what makes that order irrelevant.
    assert (HERE / "models_registry.py").read_bytes() == CANONICAL.read_bytes()
