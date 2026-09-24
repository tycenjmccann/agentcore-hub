"""merge-codex-config.py owns the provider wiring; the user owns everything else.

Codex is fully config-driven, so this one file decides which Bedrock endpoint a
turn reaches and with which headers. Three things must hold (TEAM-4995):

  1. Each endpoint's fragment is byte-exact. `web_search = "disabled"` on
     bedrock-runtime ONLY (without it a --yolo turn dies with "web search is not
     supported for this request"); `OpenAI-Project` on bedrock-mantle ONLY
     (without it Mantle answers "Engine not found").
  2. Switching endpoints strips the OTHER endpoint's stale provider block — two
     [model_providers.bedrock-*] tables in one file means codex can resolve the
     wrong one.
  3. The user's config survives INTACT and IN PLACE: mcp_servers, profiles (with
     their own `model =`), and top-level prefs. The merge order is the bug this
     pins — a surviving top-level `approval_policy = "never"` emitted after our
     [model_providers.…] header silently becomes a key of our provider table.

Hermetic: pure text in, pure text out. The output is also parsed with tomllib so
a hostile model id can't produce a file codex would reject.

Run: python3 -m pytest deploy/coding-agent-runtime/test_merge_codex_config.py -q
"""

import importlib.util
import tomllib
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "merge-codex-config.py"

MODEL_RUNTIME = "us.openai.gpt-5.5"
MODEL_MANTLE = "openai.gpt-5.5"
URL_RUNTIME = "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1"
URL_MANTLE = "https://bedrock-mantle.us-east-2.api.aws/openai/v1"

RUNTIME_FRAGMENT = '''model = "us.openai.gpt-5.5"
model_provider = "bedrock-runtime"
model_context_window = 400000
model_max_output_tokens = 128000
web_search = "disabled"

[model_providers.bedrock-runtime]
name = "Amazon Bedrock (OpenAI-compatible)"
base_url = "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
'''

MANTLE_FRAGMENT = '''model = "openai.gpt-5.5"
model_provider = "bedrock-mantle"
model_context_window = 400000
model_max_output_tokens = 128000

[model_providers.bedrock-mantle]
name = "Amazon Bedrock Mantle (OpenAI-compatible)"
base_url = "https://bedrock-mantle.us-east-2.api.aws/openai/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"

[model_providers.bedrock-mantle.http_headers]
OpenAI-Project = "default"
'''


def _load():
    # The file is a script with a hyphenated name — no importable module path.
    spec = importlib.util.spec_from_file_location("merge_codex_config", MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mcc = _load()


def _merge(existing, *, endpoint="bedrock-mantle", model=None, base_url=None,
           project="default", context_window=400000):
    mantle = endpoint == "bedrock-mantle"
    return mcc.merge(existing,
                     model or (MODEL_MANTLE if mantle else MODEL_RUNTIME),
                     base_url or (URL_MANTLE if mantle else URL_RUNTIME),
                     endpoint, project, context_window)


def _run_cli(tmp_path, argv_tail, existing=None):
    path = tmp_path / "config.toml"
    if existing is not None:
        path.write_text(existing)
    rc = mcc.main([str(path)] + argv_tail)
    return rc, (path.read_text() if path.exists() else None)


# ─── 1. byte-exact fragments, one per endpoint ───────────────────────────────

def test_bedrock_runtime_fragment_is_byte_exact():
    assert _merge("", endpoint="bedrock-runtime") == RUNTIME_FRAGMENT


def test_bedrock_mantle_fragment_is_byte_exact():
    assert _merge("", endpoint="bedrock-mantle") == MANTLE_FRAGMENT


def test_web_search_disabled_only_on_bedrock_runtime():
    assert 'web_search = "disabled"' in _merge("", endpoint="bedrock-runtime")
    assert "web_search" not in _merge("", endpoint="bedrock-mantle")


def test_openai_project_header_only_on_mantle():
    out = _merge("", endpoint="bedrock-mantle", project="acme")
    assert "[model_providers.bedrock-mantle.http_headers]" in out
    assert 'OpenAI-Project = "acme"' in out
    assert "http_headers" not in _merge("", endpoint="bedrock-runtime")
    assert "OpenAI-Project" not in _merge("", endpoint="bedrock-runtime")


def test_context_window_is_a_bare_int_from_the_registry():
    out = _merge("", endpoint="bedrock-runtime", context_window=272000)
    assert "model_context_window = 272000" in out
    assert tomllib.loads(out)["model_context_window"] == 272000


def test_cli_defaults_project_and_context_window(tmp_path):
    rc, out = _run_cli(tmp_path, [MODEL_MANTLE, URL_MANTLE, "bedrock-mantle"])
    assert rc == 0
    assert out == MANTLE_FRAGMENT  # project → "default", context → 400000


def test_cli_rejects_an_unknown_endpoint(tmp_path):
    rc, out = _run_cli(tmp_path, [MODEL_MANTLE, URL_MANTLE, "openai-direct"])
    assert rc == 2
    assert out is None  # nothing written


def test_cli_falls_back_on_a_junk_context_window(tmp_path):
    rc, out = _run_cli(tmp_path, [MODEL_MANTLE, URL_MANTLE, "bedrock-mantle",
                                  "default", "not-a-number"])
    assert rc == 0
    assert "model_context_window = 400000" in out


# ─── 2. the other endpoint's block is stripped ──────────────────────────────

def test_merging_mantle_strips_a_stale_bedrock_runtime_block():
    out = _merge(RUNTIME_FRAGMENT, endpoint="bedrock-mantle")
    assert out == MANTLE_FRAGMENT
    assert "bedrock-runtime" not in out


def test_merging_runtime_strips_a_stale_mantle_block_and_its_subtable():
    out = _merge(MANTLE_FRAGMENT, endpoint="bedrock-runtime")
    assert out == RUNTIME_FRAGMENT
    assert "bedrock-mantle" not in out
    assert "OpenAI-Project" not in out


def test_a_user_web_search_live_is_stripped():
    # The one value that kills every turn on bedrock-runtime, so the user's copy
    # must not survive even though it is "their" pref.
    out = _merge('web_search = "live"\napproval_policy = "never"\n',
                 endpoint="bedrock-runtime")
    assert out.count("web_search") == 1
    assert 'web_search = "disabled"' in out
    assert tomllib.loads(out)["web_search"] == "disabled"


def test_remerge_is_idempotent_for_both_endpoints():
    for endpoint, expected in (("bedrock-runtime", RUNTIME_FRAGMENT),
                               ("bedrock-mantle", MANTLE_FRAGMENT)):
        once = _merge("", endpoint=endpoint)
        assert _merge(once, endpoint=endpoint) == expected
        assert _merge(_merge(once, endpoint=endpoint), endpoint=endpoint) == expected
        doc = tomllib.loads(once)  # no duplicate keys → parses at all
        assert doc["model_provider"] == endpoint


# ─── 3. the user's config survives, in the right place ──────────────────────

USER_CONFIG = '''approval_policy = "never"
sandbox_mode = "workspace-write"

[mcp_servers.x]
command = "npx"
args = ["-y", "@acme/mcp"]

[profiles.y]
model = "gpt-5-codex"
model_provider = "openai"
'''


def test_user_tables_and_their_inner_model_key_survive():
    out = _merge(USER_CONFIG)
    doc = tomllib.loads(out)
    assert doc["mcp_servers"]["x"]["command"] == "npx"
    assert doc["mcp_servers"]["x"]["args"] == ["-y", "@acme/mcp"]
    # A `model =` inside [profiles.*] is the user's — only the top-level one is ours.
    assert doc["profiles"]["y"]["model"] == "gpt-5-codex"
    assert doc["profiles"]["y"]["model_provider"] == "openai"


def test_user_top_level_prefs_stay_top_level_not_inside_our_provider_table():
    # The regression: emitted after our [model_providers.…] header, these become
    # keys of OUR table and codex silently loses the prefs.
    out = _merge(USER_CONFIG)
    doc = tomllib.loads(out)
    assert doc["approval_policy"] == "never"
    assert doc["sandbox_mode"] == "workspace-write"
    assert "approval_policy" not in doc["model_providers"]["bedrock-mantle"]
    assert "sandbox_mode" not in doc["model_providers"]["bedrock-mantle"]
    # ...and positionally: before the first table header in the file.
    assert out.index('approval_policy = "never"') < out.index("[model_providers.")


def test_our_keys_still_win_over_the_users():
    out = _merge('model = "their-model"\nmodel_provider = "openai"\n'
                 'model_context_window = 8192\n')
    doc = tomllib.loads(out)
    assert doc["model"] == MODEL_MANTLE
    assert doc["model_provider"] == "bedrock-mantle"
    assert doc["model_context_window"] == 400000
    assert "their-model" not in out


def test_user_file_with_only_tables_keeps_the_blank_line_shape():
    out = _merge("[mcp_servers.x]\ncommand = \"npx\"\n")
    assert out.startswith('model = "openai.gpt-5.5"\n')
    assert out.endswith('command = "npx"\n')
    tomllib.loads(out)


# ─── 4. hostile values cannot break out of the TOML ─────────────────────────

@pytest.mark.parametrize("hostile", [
    'ev"il',
    'ev\nil',
    'ev"il\nmodel_provider = "openai"',
    'back\\slash',
    'quote"and\nnewline',
])
def test_a_hostile_model_id_is_escaped_and_the_file_still_parses(hostile):
    out = _merge("", model=hostile)
    doc = tomllib.loads(out)
    assert doc["model"] == hostile                      # round-trips exactly
    assert doc["model_provider"] == "bedrock-mantle"     # not overridden
    assert doc["model_providers"]["bedrock-mantle"]["wire_api"] == "responses"


def test_a_hostile_base_url_and_project_are_escaped_too():
    out = _merge("", base_url='https://x/"\n', project='p"\n')
    doc = tomllib.loads(out)
    assert doc["model_providers"]["bedrock-mantle"]["base_url"] == 'https://x/"\n'
    assert doc["model_providers"]["bedrock-mantle"]["http_headers"]["OpenAI-Project"] == 'p"\n'
