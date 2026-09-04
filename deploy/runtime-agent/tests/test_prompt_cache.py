"""TEAM-3953: Bedrock prompt-cache plumbing on the runtime agent.

main.py cannot be imported (its module top-level installs Node.js, fetches the
system prompt from S3, chdirs), so — exactly like tests/test_completion_gate.py
— the pieces under test are extracted from deploy/runtime-agent/main.py via ast
and exec'd in a controlled namespace. This pins the shipped source, not a copy
that could drift.

Part A exercises the env-knob validation and the `_persona_cache_kwargs()`
helper across the on / off / bad-ttl / unsupported-CacheConfig matrix.

Part B builds a REAL strands `BedrockModel` with the helper's kwargs and asserts
the `cachePoint` shape in the formatted request. `format_request` is pure — it
builds the Converse request dict and never calls Bedrock, so this stays offline.
"""

import ast
import json
import logging
from pathlib import Path

from strands.models import BedrockModel
from strands.models.model import CacheConfig

MAIN_PY = Path(__file__).resolve().parent.parent / "main.py"
_TREE = ast.parse(MAIN_PY.read_text())

# The exact cache marker strands emits for cache_config(ttl="1h"), cache="default".
_CACHE_POINT_1H = {"cachePoint": {"type": "default", "ttl": "1h"}}


# ── extraction helpers ─────────────────────────────────────────────────────
def _func_node(name):
    return next(
        n for n in _TREE.body
        if isinstance(n, ast.FunctionDef) and n.name == name
    )


def _load_cache_kwargs_helper(*, prompt_cache, cache_ttl, cache_config):
    """Extract `_persona_cache_kwargs` and exec it with injected module globals.

    The helper reads PERSONA_PROMPT_CACHE / PERSONA_CACHE_TTL / CacheConfig from
    its module namespace — inject them so each matrix cell is controlled.
    """
    module = ast.Module(body=[_func_node("_persona_cache_kwargs")], type_ignores=[])
    ns = {
        "PERSONA_PROMPT_CACHE": prompt_cache,
        "PERSONA_CACHE_TTL": cache_ttl,
        "CacheConfig": cache_config,
    }
    exec(compile(module, str(MAIN_PY), "exec"), ns)  # noqa: S102
    return ns["_persona_cache_kwargs"]


def _resolve_knobs():
    """Re-exec the module-level PERSONA_* knob assignments + the TTL-validation
    `if` under the current os.environ, returning the resolved values.

    Extracting the real statements (not replicating them) means the default,
    the "0"-disables rule, and the invalid-ttl warning+fallback are all the
    shipped logic. Nodes are collected in source order so the validation `if`
    runs after the assignments.
    """
    nodes = []
    for n in _TREE.body:
        if isinstance(n, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id in ("PERSONA_PROMPT_CACHE", "PERSONA_CACHE_TTL")
            for t in n.targets
        ):
            nodes.append(n)
        elif isinstance(n, ast.If) and any(
            isinstance(x, ast.Name) and x.id == "PERSONA_CACHE_TTL" for x in ast.walk(n.test)
        ):
            nodes.append(n)
    module = ast.Module(body=nodes, type_ignores=[])
    import os as _os
    ns = {"os": _os, "logging": logging}
    exec(compile(module, str(MAIN_PY), "exec"), ns)  # noqa: S102
    return ns["PERSONA_PROMPT_CACHE"], ns["PERSONA_CACHE_TTL"]


# ── Part A: env matrix ──────────────────────────────────────────────────────
def test_default_env_caching_on(monkeypatch):
    monkeypatch.delenv("PERSONA_PROMPT_CACHE", raising=False)
    monkeypatch.delenv("PERSONA_CACHE_TTL", raising=False)
    prompt_cache, ttl = _resolve_knobs()
    assert prompt_cache is True
    assert ttl == "1h"

    kwargs = _load_cache_kwargs_helper(
        prompt_cache=prompt_cache, cache_ttl=ttl, cache_config=CacheConfig
    )()
    assert kwargs["cache_tools"] == "default"
    cc = kwargs["cache_config"]
    assert isinstance(cc, CacheConfig)
    assert cc.strategy == "auto"
    assert cc.ttl == "1h"


def test_cache_disabled_by_env(monkeypatch):
    monkeypatch.setenv("PERSONA_PROMPT_CACHE", "0")
    monkeypatch.delenv("PERSONA_CACHE_TTL", raising=False)
    prompt_cache, ttl = _resolve_knobs()
    assert prompt_cache is False

    kwargs = _load_cache_kwargs_helper(
        prompt_cache=prompt_cache, cache_ttl=ttl, cache_config=CacheConfig
    )()
    assert kwargs == {}


def test_bad_ttl_falls_back_to_1h_and_warns(monkeypatch, caplog):
    monkeypatch.delenv("PERSONA_PROMPT_CACHE", raising=False)
    monkeypatch.setenv("PERSONA_CACHE_TTL", "2h")
    with caplog.at_level(logging.WARNING):
        prompt_cache, ttl = _resolve_knobs()
    assert prompt_cache is True
    assert ttl == "1h"
    assert any(
        "invalid" in r.getMessage() and "2h" in r.getMessage()
        for r in caplog.records
    ), f"expected an invalid-ttl warning, got {[r.getMessage() for r in caplog.records]}"

    # Post-fallback, the helper caches with the corrected ttl.
    kwargs = _load_cache_kwargs_helper(
        prompt_cache=prompt_cache, cache_ttl=ttl, cache_config=CacheConfig
    )()
    assert kwargs["cache_config"].ttl == "1h"


def test_cache_config_unavailable_yields_empty(monkeypatch):
    # Simulates an older strands where `from strands.models.model import
    # CacheConfig` failed and main.py's guard left CacheConfig = None.
    monkeypatch.delenv("PERSONA_PROMPT_CACHE", raising=False)
    monkeypatch.delenv("PERSONA_CACHE_TTL", raising=False)
    prompt_cache, ttl = _resolve_knobs()
    kwargs = _load_cache_kwargs_helper(
        prompt_cache=prompt_cache, cache_ttl=ttl, cache_config=None
    )()
    assert kwargs == {}


# ── Part B: real request shape ──────────────────────────────────────────────
def _format_request(cache_kwargs):
    """Build a real BedrockModel and format a minimal Converse request.

    No credentials or network: the boto client is created lazily and
    format_request only assembles the request dict.
    """
    model = BedrockModel(
        model_id="us.anthropic.claude-fable-5-1",
        region_name="us-east-1",
        **cache_kwargs,
    )
    messages = [{"role": "user", "content": [{"text": "hello"}]}]
    tool_specs = [
        {
            "name": "noop",
            "description": "a tool",
            "inputSchema": {"json": {"type": "object", "properties": {}}},
        }
    ]
    system_prompt_content = [{"text": "you are a helpful agent"}]
    return model.format_request(
        messages, tool_specs, system_prompt_content=system_prompt_content
    )


def test_request_has_cache_points_when_on():
    kwargs = _load_cache_kwargs_helper(
        prompt_cache=True, cache_ttl="1h", cache_config=CacheConfig
    )()
    req = _format_request(kwargs)

    tools = req["toolConfig"]["tools"]
    assert tools[-1] == _CACHE_POINT_1H, "cachePoint must be LAST in toolConfig.tools"

    system = req["system"]
    assert system[-1] == _CACHE_POINT_1H, "cachePoint must be LAST in system"

    last_user = req["messages"][-1]
    assert last_user["role"] == "user"
    assert _CACHE_POINT_1H in last_user["content"], (
        "cachePoint must be present in the last user message"
    )


def test_request_has_no_cache_points_when_off():
    req = _format_request({})
    assert "cachePoint" not in json.dumps(req)
