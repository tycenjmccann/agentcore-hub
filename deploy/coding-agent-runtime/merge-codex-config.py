#!/usr/bin/env python3
"""
merge-codex-config.py — ensure OUR Bedrock provider in ~/.codex/config.toml
without clobbering a user-supplied config.

Codex is fully config-driven (model providers, MCP servers, profiles, AGENTS.md).
A user can upload their own config.toml, but it must NOT override how we reach the
model: inference goes through Amazon Bedrock, authenticated by the microVM IAM
role. Which Bedrock endpoint depends on the model, and the model registry
(config/models.json, DL-033) is what knows:

  bedrock-runtime  the inference-profile ids (us.openai.gpt-…) on
                   https://bedrock-runtime.<region>.amazonaws.com/openai/v1,
                   no OpenAI-Project header
  bedrock-mantle   the bare ids (openai.gpt-…) on
                   https://bedrock-mantle.<region>.api.aws/openai/v1, which
                   REQUIRES OpenAI-Project ("Engine not found" without it)

So we treat the provider wiring as ours and everything else (mcp_servers,
profiles, prefs) as theirs: strip any top-level key we own and EITHER
[model_providers.bedrock-*] section from their file — switching endpoints has to
remove the other endpoint's stale block — then emit ours first and theirs after.
The bearer token is NOT written here: it is an env var (`OPENAI_API_KEY`)
referenced via `env_key`, minted fresh per run.

Config reference: https://developers.openai.com/codex/config-file/config-reference

Usage: merge-codex-config.py <config.toml> <model> <base_url> <endpoint> \
                             [project] [context_window]
Writes the merged file back in place (creates it if absent).
"""
import json
import re
import sys

ENDPOINTS = ("bedrock-runtime", "bedrock-mantle")
DEFAULT_PROJECT = "default"
# GPT-5 class: 400k context, 128k max output. Codex has no built-in metadata for
# these ids over Bedrock, so it warns and falls back to conservative defaults
# unless we declare the limits explicitly.
DEFAULT_CONTEXT_WINDOW = 400000
MAX_OUTPUT_TOKENS = 128000

# The top-level keys we own. A `model =` inside a [profiles.*] table is the
# user's and must survive — only the pre-first-header block is ours. Re-stripped
# on every merge so our own keys never duplicate.
OURS_TOP_LEVEL_RE = re.compile(
    r"^\s*(model|model_provider|model_context_window|model_max_output_tokens"
    r"|web_search)\s*="
)


def split_user_config(existing: str) -> tuple[str, str]:
    """Split the user's file into (top-level keys, [table] blocks), dropping
    every key and section we own."""
    top: list[str] = []
    tables: list[str] = []
    skip_section = False
    in_top_level = True  # before the first [section] header
    for line in existing.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            in_top_level = False
            # Enter/exit EITHER of our provider sections (and their subtables).
            # Deliberately not endpoint-specific: a session that moves from
            # mantle to bedrock-runtime must not leave the old provider behind.
            skip_section = stripped.startswith("[model_providers.bedrock-")
            if skip_section:
                continue
        if skip_section:
            continue
        if in_top_level and OURS_TOP_LEVEL_RE.match(line):
            continue
        (top if in_top_level else tables).append(line)
    return "\n".join(top).strip(), "\n".join(tables).strip()


def our_fragment(model: str, base_url: str, endpoint: str, project: str,
                 context_window: int) -> tuple[str, str]:
    """Our (top-level keys, provider tables) for one endpoint."""
    top = [
        f"model = {json.dumps(model)}",
        f"model_provider = {json.dumps(endpoint)}",
        f"model_context_window = {context_window}",
        f"model_max_output_tokens = {MAX_OUTPUT_TOKENS}",
    ]
    if endpoint == "bedrock-runtime":
        # MANDATORY on this endpoint. `codex exec --yolo` defaults web_search to
        # "live", and Bedrock answers a request carrying the web_search tool with
        # turn.failed "web search is not supported for this request" — i.e. every
        # turn dies. Mantle does not need it, which is why it is emitted here
        # only (design DD3b).
        top.append('web_search = "disabled"')

    name = ("Amazon Bedrock Mantle (OpenAI-compatible)" if endpoint == "bedrock-mantle"
            else "Amazon Bedrock (OpenAI-compatible)")
    tables = [
        f"[model_providers.{endpoint}]",
        f"name = {json.dumps(name)}",
        f"base_url = {json.dumps(base_url)}",
        'env_key = "OPENAI_API_KEY"',
        # GPT-5 class only supports /responses.
        'wire_api = "responses"',
    ]
    if endpoint == "bedrock-mantle":
        tables += [
            "",
            f"[model_providers.{endpoint}.http_headers]",
            f"OpenAI-Project = {json.dumps(project)}",
        ]
    return "\n".join(top), "\n".join(tables)


def merge(existing: str, model: str, base_url: str, endpoint: str, project: str,
          context_window: int) -> str:
    """Our keys, then the user's surviving top-level keys, then our tables, then
    the user's tables.

    The order matters and used to be wrong: emitting the user's surviving
    top-level keys AFTER our [model_providers.…] header silently turned their
    `approval_policy = "never"` into a key of OUR provider table.
    """
    user_top, user_tables = split_user_config(existing)
    ours_top, ours_tables = our_fragment(model, base_url, endpoint, project,
                                         context_window)
    blocks = [b for b in (ours_top, user_top, ours_tables, user_tables) if b]
    return "\n\n".join(blocks) + "\n"


def main(argv: list[str]) -> int:
    if len(argv) < 4:
        sys.stderr.write(
            "usage: merge-codex-config.py <config.toml> <model> <base_url> "
            "<endpoint> [project] [context_window]\n")
        return 2
    path, model, base_url, endpoint = argv[:4]
    project = (argv[4] if len(argv) > 4 else "") or DEFAULT_PROJECT
    if endpoint not in ENDPOINTS:
        sys.stderr.write(f"merge-codex-config: unknown endpoint {endpoint!r} "
                         f"(want one of {', '.join(ENDPOINTS)})\n")
        return 2
    raw_ctx = argv[5] if len(argv) > 5 else ""
    context_window = DEFAULT_CONTEXT_WINDOW
    if raw_ctx.strip():
        try:
            context_window = int(raw_ctx.strip())
            if context_window <= 0:
                raise ValueError(raw_ctx)
        except ValueError:
            sys.stderr.write(f"merge-codex-config: bad context_window {raw_ctx!r} "
                             f"— using {DEFAULT_CONTEXT_WINDOW}\n")
            context_window = DEFAULT_CONTEXT_WINDOW

    try:
        with open(path) as f:
            existing = f.read()
    except FileNotFoundError:
        existing = ""

    with open(path, "w") as f:
        f.write(merge(existing, model, base_url, endpoint, project, context_window))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
