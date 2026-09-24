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
