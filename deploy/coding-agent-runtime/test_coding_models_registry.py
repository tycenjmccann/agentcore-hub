"""The coding runtime's copy of models_registry.py resolves identically (TEAM-4995).

The full resolution contract is exercised once, against the canonical twin, in
deploy/runtime-agent/tests/test_models_registry.py. This file covers the two
things that are specific to THIS copy:

  1. It is importable from this directory and resolves the same shared-fixture
     cases as the canonical twin (the ticket asks both Python tests to read the
     fixture). Byte-identity is enforced separately by
     scripts/check-models-registry-parity.sh — so this is not a content check,
     it is an "it actually loads and answers inside this container" check.
  2. The coding-runtime env names work here: this container uses the plain
     ARTIFACT_BUCKET (no AgentCore reservation to dodge) and reads
     BEDROCK_MANTLE_REGION for the Mantle branch.

The fixture is authored by TEAM-4997 and may not be on this branch yet; that one
test skips while it is absent. It is never forked or copied here.

NAME: not `test_models_registry.py`. Neither this directory nor
deploy/runtime-agent/tests is a package, so two test files with the same
basename collide on import ("import file mismatch") the moment one pytest run
collects both — which the whole-branch verification does. Hence the prefix.
"""

import importlib.util
import json
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
MODULE_PATH = HERE / "models_registry.py"
FIXTURE = REPO_ROOT / "src" / "config" / "__fixtures__" / "models-registry.case.json"


def _load_module():
    spec = importlib.util.spec_from_file_location("coding_models_registry", MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mr = _load_module()


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in ("MODEL_ID", "ANTHROPIC_MODEL", "CLAUDE_MODEL", "CODEX_MODEL",
                "BEDROCK_MANTLE_REGION", "AWS_REGION",
                "ARTIFACT_BUCKET", "AGENTCORE_HUB_ARTIFACT_BUCKET"):
        monkeypatch.delenv(var, raising=False)
    mr.reset_cache()


def _fixture_cases():
    if not FIXTURE.exists():
        return []
    doc = json.loads(FIXTURE.read_text())
    return doc.get("cases") or doc.get("resolveCases") or []


@pytest.mark.parametrize("case", _fixture_cases() or [None],
                         ids=lambda c: (c or {}).get("name", "fixture-absent") if c else "fixture-absent")
def test_shared_fixture_cases(case, monkeypatch):
    """Same table, same answers — this copy must not drift in behaviour either."""
    if case is None:
        pytest.skip("fixture authored by TEAM-4997 not on branch yet")
    registry = None
    if case.get("registry"):
        registry, _, errors = mr.validate_registry(case["registry"])
        assert errors == [], errors
    for k, v in (case.get("env") or {}).items():
        monkeypatch.setenv(k, v)
    kind = case.get("kind", "model")
    if kind == "agent":
        got = mr.resolve_agent_model(registry, case.get("agentId", ""), case.get("override"))
    elif kind == "coding":
        got = mr.resolve_coding_model(registry, case.get("input", ""), case.get("cli", "claude"))[0]
    else:
        got = mr.resolve_model(registry, case.get("input", ""), case.get("cli"))
    assert got == case["expected"], case.get("name")


def test_the_module_loads_and_resolves_in_this_container():
    assert mr.resolve_coding_model(None, "", "claude") == (
        mr.LITERAL_CODING_CLAUDE, "bedrock-runtime", "us-east-1", "converse", 400000)
    assert mr.resolve_coding_model(None, "", "codex") == (
        mr.LITERAL_CODING_CODEX, "bedrock-mantle", "us-east-2", "responses", 400000)


def test_this_container_reads_the_plain_bucket_var(monkeypatch, caplog):
    # No AgentCore reservation here, so ARTIFACT_BUCKET is the name in use
    # (coding-agent-runtime/main.py). With it unset we must fall back loudly.
    with caplog.at_level("INFO"):
        assert mr.load_registry() is None
    assert "registry.fallback reason=no-bucket" in caplog.text


def test_mantle_region_env_only_moves_the_mantle_branch(monkeypatch):
    monkeypatch.setenv("BEDROCK_MANTLE_REGION", "us-west-2")
    monkeypatch.setenv("AWS_REGION", "eu-central-1")
    assert mr.resolve_coding_model(None, "", "codex")[2] == "us-west-2"
    assert mr.resolve_coding_model(None, "", "claude")[2] == "eu-central-1"
