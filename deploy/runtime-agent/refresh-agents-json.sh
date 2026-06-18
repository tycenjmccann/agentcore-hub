#!/bin/bash
#
# refresh-agents-json.sh — Sync src/config/agents.json with what's actually
# deployed in AgentCore, without redeploying.
#
# Reconciles three fields on every agent in agents.json:
#   - runtimeArn     — the runtime ARN (queried from AgentCore)
#   - evalConfigName — the CW Logs eval config name (queried from CloudWatch)
#   - tools          — the actual tool capability set loaded by main.py
#                      (computed by parsing main.py + the GitHub MCP set
#                      declared in the canonical tool list below)
#
# The runtime resource name IS agent.agentId (convention) — no separate
# harnessName field is stored.
#
# All 14 fleet agents load an identical 37-tool capability set in main.py,
# so the same canonical list is written to every agent. The event processor
# in the UI reads agents.json to map tool_use events to icons.
#
# Also writes deploy/runtime-agent/fleet-runtime-ids.json for use by the
# health-check harness (verify-fleet-invoke.py).
#
# Use this when:
#   - You deployed individual agents with deploy.sh / deploy-one.sh (which
#     don't update agents.json).
#   - agents.json drifted from reality and you want to reconcile.
#   - You need fleet-runtime-ids.json for verify-fleet-invoke.py.
#
# Usage:
#   AWS_PROFILE=<your-profile> ./refresh-agents-json.sh [--region us-east-1]
#

set -e

REGION="${AWS_REGION:-us-east-1}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_JSON="$SCRIPT_DIR/../../src/config/agents.json"
RESULTS_FILE="$SCRIPT_DIR/fleet-runtime-ids.json"

if [ ! -f "$AGENTS_JSON" ]; then
  echo "ERROR: agents.json not found at $AGENTS_JSON"
  exit 1
fi

SCRIPT_DIR_PY="$SCRIPT_DIR" REGION="$REGION" AGENTS_JSON="$AGENTS_JSON" RESULTS_FILE="$RESULTS_FILE" \
python3 <<'PYEOF'
import ast
import json
import os
import re
import sys

import boto3

region = os.environ["REGION"]
agents_json_path = os.environ["AGENTS_JSON"]
results_file = os.environ["RESULTS_FILE"]
script_dir = os.environ["SCRIPT_DIR_PY"]
main_py_path = os.path.join(script_dir, "main.py")

# ─── Step 1: Query deployed runtimes ────────────────────────────────────────
print(f"Querying AgentCore runtimes in {region}...")
client = boto3.client("bedrock-agentcore-control", region_name=region)

deployed = {}
paginator = client.get_paginator("list_agent_runtimes")
for page in paginator.paginate():
    for rt in page.get("agentRuntimes", []):
        name = rt.get("agentRuntimeName", "")
        arn = rt.get("agentRuntimeArn", "")
        if name.startswith("agentcore_hub_"):
            deployed[name] = arn

if not deployed:
    print(f"ERROR: No agentcore_hub_* runtimes found in {region}. Check your AWS_PROFILE.")
    sys.exit(1)

print(f"  Found {len(deployed)} deployed runtimes.")

with open(results_file, "w") as f:
    json.dump(deployed, f, indent=2)
    f.write("\n")
print(f"  Wrote {len(deployed)} entries to fleet-runtime-ids.json")

# ─── Step 1b: Query CW Logs for eval config names ───────────────────────────
# Eval log groups live at /aws/bedrock-agentcore/evaluations/results/<configName>
# where <configName> = "eval_<short>-<random>" (e.g. eval_requirements_analyst-FO0D...)
# We strip the "-<random>" suffix and key on the canonical "eval_<short>" form
# that matches what's in agents.json. If multiple log groups share the same
# canonical prefix (e.g. duplicate configs), we use the most recently created.
print(f"Querying eval log groups in {region}...")
logs = boto3.client("logs", region_name=region)
eval_configs = {}  # short_name -> full_log_group_basename
seen_creation = {}
paginator2 = logs.get_paginator("describe_log_groups")
for page in paginator2.paginate(logGroupNamePrefix="/aws/bedrock-agentcore/evaluations/results/"):
    for lg in page.get("logGroups", []):
        full_name = lg["logGroupName"].rsplit("/", 1)[-1]  # eval_X-randomId
        m = re.match(r"^(eval_[a-z_]+?)(-[A-Za-z0-9]+)?$", full_name)
        if not m:
            continue
        short = m.group(1)
        created = lg.get("creationTime", 0)
        # Keep the most recent if dupes
        if short not in eval_configs or created > seen_creation.get(short, 0):
            eval_configs[short] = short
            seen_creation[short] = created

print(f"  Found {len(eval_configs)} eval configs.")

# ─── Step 2: Compute canonical tool set from main.py ────────────────────────
# Every agent loads the same set: builtin strands tools + AgentCore service
# tools + LAMBDA_TOOLS (declared in main.py) + claude_code + GitHub MCP tools.
# We parse main.py to extract the lists rather than hardcoding them, so this
# script stays in sync if the fleet's capabilities change.

with open(main_py_path) as f:
    main_py_src = f.read()

tree = ast.parse(main_py_src)

# Local @tool functions become tool names (function name).
local_tool_names = []
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef):
        for dec in node.decorator_list:
            dec_name = (
                dec.id if isinstance(dec, ast.Name)
                else dec.attr if isinstance(dec, ast.Attribute)
                else dec.func.id if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Name)
                else None
            )
            if dec_name == "tool":
                local_tool_names.append(node.name)
                break

# strands_tools imports — these are the built-ins each agent loads.
strands_tool_imports = []
for node in ast.walk(tree):
    if isinstance(node, ast.ImportFrom) and node.module == "strands_tools":
        for alias in node.names:
            strands_tool_imports.append(alias.asname or alias.name)

# AgentCore service tools attached as builtin (code_interpreter, browser).
agentcore_service_tools = ["code_interpreter", "browser"]

# GitHub MCP tools — these come from the MCP server, not main.py source.
# Canonical set verified against fleet-health-results.json across all agents.
github_mcp_tools = [
    "create_branch",
    "create_or_update_file",
    "create_pull_request",
    "get_file_contents",
    "get_me",
    "list_branches",
    "push_files",
    "search_code",
    "search_repositories",
]

canonical_tools = sorted(set(
    local_tool_names + strands_tool_imports + agentcore_service_tools + github_mcp_tools
))

print(f"  Canonical tool set: {len(canonical_tools)} tools")
print(f"    (local @tool: {len(local_tool_names)}, strands_tools: {len(strands_tool_imports)}, "
      f"agentcore: {len(agentcore_service_tools)}, github MCP: {len(github_mcp_tools)})")

# ─── Step 3: Reconcile agents.json with line-level edits ────────────────────
# Surgical regex edits preserve the file's existing formatting (compact
# inline arrays). A naive json.load/json.dump round-trip would expand
# every array onto multiple lines.
with open(agents_json_path) as f:
    text = f.read()

config = json.loads(text)

plans = []
missing = []
for agent in config["agents"]:
    # Convention: agentId IS the runtime name (e.g. "agentcore_hub_requirements_analyst")
    runtime_name = agent["agentId"]
    # Eval config name is "eval_" + the full agentId, matching what
    # setup-evaluations.sh creates (config_name="eval_${name}", name=agentId)
    # and the resulting CW log group eval_agentcore_hub_requirements_analyst-XXXX.
    eval_short = "eval_" + agent["agentId"]
    eval_name = eval_configs.get(eval_short)
    if runtime_name in deployed:
        plans.append((agent["agentId"], runtime_name, deployed[runtime_name], eval_name))
    else:
        missing.append(agent["agentId"])

# Compact JSON-array string for the tools field, matching agents.json style.
tools_array_str = "[" + ", ".join(f'"{t}"' for t in canonical_tools) + "]"

updated = 0
unchanged = 0

for agent_id, runtime_name, runtime_arn, eval_name in plans:
    id_marker = f'"agentId": "{agent_id}"'
    id_pos = text.find(id_marker)
    if id_pos < 0:
        continue
    end_pos = text.find("\n    }", id_pos)
    if end_pos < 0:
        continue
    block = text[id_pos:end_pos]

    new_block = block

    # evalConfigName — set if found, else insert after agentId
    if eval_name:
        if re.search(r'"evalConfigName":\s*("[^"]*"|null)', new_block):
            new_block = re.sub(r'"evalConfigName":\s*("[^"]*"|null)', f'"evalConfigName": "{eval_name}"', new_block)
        else:
            new_block = re.sub(
                r'("agentId":\s*"' + re.escape(agent_id) + r'",\n)',
                r'\1      "evalConfigName": "' + eval_name + r'",\n',
                new_block,
            )

    # runtimeArn — set if found (including null), else insert after evalConfigName/agentId
    if re.search(r'"runtimeArn":\s*("[^"]*"|null)', new_block):
        new_block = re.sub(r'"runtimeArn":\s*("[^"]*"|null)', f'"runtimeArn": "{runtime_arn}"', new_block)
    else:
        anchor = (
            r'("evalConfigName":\s*"[^"]*",\n)' if eval_name and '"evalConfigName"' in new_block
            else r'("agentId":\s*"' + re.escape(agent_id) + r'",\n)'
        )
        new_block = re.sub(
            anchor,
            r'\1      "runtimeArn": "' + runtime_arn + r'",\n',
            new_block,
        )

    # tools — match the entire single-line array (anything between [ and ])
    if re.search(r'"tools":\s*\[[^\]]*\]', new_block):
        new_block = re.sub(
            r'"tools":\s*\[[^\]]*\]',
            f'"tools": {tools_array_str}',
            new_block,
        )
    else:
        new_block = re.sub(
            r'("runtimeArn":\s*"' + re.escape(runtime_arn) + r'",\n)',
            r'\1      "tools": ' + tools_array_str + r',\n',
            new_block,
        )

    if new_block == block:
        unchanged += 1
    else:
        text = text[:id_pos] + new_block + text[end_pos:]
        updated += 1

# Validate JSON is still parseable before writing.
try:
    json.loads(text)
except json.JSONDecodeError as e:
    print(f"ERROR: regex edit produced invalid JSON: {e}")
    sys.exit(1)

with open(agents_json_path, "w") as f:
    f.write(text)

print(f"  agents.json: {updated} updated, {unchanged} unchanged")
if missing:
    print(f"  WARNING: {len(missing)} agents in agents.json have no deployed runtime:")
    for m in missing:
        print(f"    - {m}")
PYEOF

echo ""
echo "Done. Files synced:"
echo "  - $AGENTS_JSON"
echo "  - $RESULTS_FILE"
