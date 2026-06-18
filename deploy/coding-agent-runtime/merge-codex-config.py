#!/usr/bin/env python3
"""
merge-codex-config.py — ensure the Bedrock Mantle provider in ~/.codex/config.toml
without clobbering a user-supplied config.

Codex is fully config-driven (model providers, MCP servers, profiles, AGENTS.md).
A user can upload their own config.toml, but it must NOT override how we reach the
model: GPT-5.5 runs through Bedrock Mantle, authenticated by the microVM IAM role.

So we treat the provider wiring as ours and everything else (mcp_servers, profiles,
prefs) as theirs: strip any top-level `model`/`model_provider` and the
`[model_providers.bedrock-mantle]` section from their file, then prepend our
canonical block. The bearer token is NOT written here — it's an env var
(`OPENAI_API_KEY`) referenced via `env_key`, minted fresh per run.

Usage: merge-codex-config.py <config.toml path> <model> <base_url> <project>
Writes the merged file back in place (creates it if absent).
"""
import re
import sys


def main() -> None:
    path, model, base_url, project = sys.argv[1:5]

    try:
        with open(path) as f:
            existing = f.read()
    except FileNotFoundError:
        existing = ""

    # Drop the keys/section we own so the user's copy can't shadow them.
    lines = existing.splitlines()
    kept: list[str] = []
    skip_section = False
    in_top_level = True  # before the first [section] header
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("["):
            in_top_level = False
            # Enter/exit our provider section (and any of its subtables).
            skip_section = stripped.startswith("[model_providers.bedrock-mantle")
            if skip_section:
                continue
        if skip_section:
            continue
        # Only TOP-LEVEL model/model_provider are ours; a `model=` inside a
        # [profiles.*] table is the user's and must survive.
        if in_top_level and re.match(r"^\s*(model|model_provider)\s*=", line):
            continue
        kept.append(line)

    user_rest = "\n".join(kept).strip()

    ours = (
        f'model = "{model}"\n'
        f'model_provider = "bedrock-mantle"\n\n'
        f'[model_providers.bedrock-mantle]\n'
        f'name = "Amazon Bedrock Mantle (OpenAI-compatible)"\n'
        f'base_url = "{base_url}"\n'
        f'env_key = "OPENAI_API_KEY"\n'
        f'wire_api = "responses"\n\n'
        f'[model_providers.bedrock-mantle.http_headers]\n'
        f'OpenAI-Project = "{project}"\n'
    )

    merged = ours if not user_rest else f"{ours}\n{user_rest}\n"
    with open(path, "w") as f:
        f.write(merged)


if __name__ == "__main__":
    main()
