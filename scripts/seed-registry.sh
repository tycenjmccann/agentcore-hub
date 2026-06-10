#!/bin/bash
# ─── Seed the AgentCore Registry with demo data ──────────────────────────────
# Creates a demo registry ("agentcore-hub-demo") and a handful of realistic
# demo records across all descriptor types, using only the AWS CLI against the
# Amazon Bedrock AgentCore Registry control plane. Idempotent / safe to re-run:
# existing registries and records (matched by name) are skipped.
#
# Usage:   AWS_PROFILE=<profile> bash scripts/seed-registry.sh
#   (or)   bash scripts/seed-registry.sh        # uses ambient AWS credentials
#
# Make executable (optional):  chmod +x scripts/seed-registry.sh
#
# NEVER hardcodes account IDs, ARNs, bucket names, or usernames — demo content
# is generic and account-agnostic.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Source central deploy config for region if available; otherwise default.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/../deploy/config.sh" ]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/../deploy/config.sh" >/dev/null 2>&1 || true
fi
REGION="${AWS_REGION:-us-east-1}"

REGISTRY_NAME="agentcore-hub-demo"

# AWS_PROFILE is honored automatically by the aws CLI when set in the env.
echo "Seeding AgentCore Registry in region ${REGION}${AWS_PROFILE:+ (profile ${AWS_PROFILE})}"

aws_cmd() {
  # No --output pin here: callers pass their own (text for scalar extraction).
  aws bedrock-agentcore-control "$@" --region "${REGION}"
}

# ─── 1. Registry ─────────────────────────────────────────────────────────────
echo "Looking for existing registry named '${REGISTRY_NAME}'..."
REGISTRY_ID="$(aws_cmd list-registries \
  --query "registries[?name=='${REGISTRY_NAME}'].registryId | [0]" \
  --output text 2>/dev/null || echo "None")"

if [ -z "${REGISTRY_ID}" ] || [ "${REGISTRY_ID}" = "None" ]; then
  echo "Creating registry '${REGISTRY_NAME}'..."
  # CreateRegistry returns only registryArn (no registryId); derive id from the
  # ARN tail (.../registry/<id>). Create is async — poll until READY.
  REGISTRY_ARN="$(aws_cmd create-registry \
    --name "${REGISTRY_NAME}" \
    --description "Demo registry for AgentCore Hub - example MCP, A2A, custom, and agent-skills records." \
    --authorizer-type "AWS_IAM" \
    --approval-configuration '{"autoApproval":true}' \
    --query "registryArn" --output text)"
  REGISTRY_ID="${REGISTRY_ARN##*/}"
  echo "  created registryId=${REGISTRY_ID} (waiting for READY)..."
  for _ in $(seq 1 30); do
    st="$(aws_cmd get-registry --registry-id "${REGISTRY_ID}" --query "status" --output text 2>/dev/null || echo "")"
    [ "${st}" = "READY" ] && break
    sleep 2
  done
else
  echo "  registry already exists (registryId=${REGISTRY_ID}), reusing."
fi

# ─── helper: create a record only if a record with that name does not exist ──
record_exists() {
  local name="$1"
  local found
  found="$(aws_cmd list-registry-records --registry-id "${REGISTRY_ID}" \
    --query "registryRecords[?name=='${name}'].recordId | [0]" \
    --output text 2>/dev/null || echo "None")"
  [ -n "${found}" ] && [ "${found}" != "None" ]
}

create_record() {
  local name="$1"
  local descriptor_type="$2"
  local description="$3"
  local descriptors="$4"
  if record_exists "${name}"; then
    echo "  record '${name}' (${descriptor_type}) already exists, skipping."
    return
  fi
  echo "  creating record '${name}' (${descriptor_type})..."
  aws_cmd create-registry-record \
    --registry-id "${REGISTRY_ID}" \
    --name "${name}" \
    --description "${description}" \
    --descriptor-type "${descriptor_type}" \
    --descriptors "${descriptors}" \
    --query "recordId" --output text >/dev/null
}

echo "Seeding demo records..."

# ─── 2a. MCP server ──────────────────────────────────────────────────────────
# MCP server inlineContent schema (2025-07-09) accepts {name, description, version}.
MCP_SERVER='{"name":"weather/mcp","description":"MCP server exposing weather lookup tools.","version":"1.0.0"}'
create_record "weather-mcp-server" "MCP" \
  "Weather MCP server providing forecast and current-conditions tools." \
  "$(printf '{"mcp":{"server":{"schemaVersion":"2025-07-09","inlineContent":%s}}}' \
    "$(printf '%s' "${MCP_SERVER}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")"

# ─── 2b. A2A agent ───────────────────────────────────────────────────────────
# A2A agent card: schemaVersion "0.3", full card per A2A protocol (protocolVersion,
# capabilities, defaultInputModes/OutputModes, skills with tags).
A2A_CARD='{"name":"Research Assistant","description":"An A2A agent that performs multi-step web research and summarization.","version":"1.0.0","protocolVersion":"0.3.0","url":"https://example.com/a2a/research-assistant","capabilities":{},"defaultInputModes":["text/plain","application/json"],"defaultOutputModes":["application/json"],"skills":[{"id":"research","name":"Research","description":"Run a research task and return a cited summary.","tags":["research","summarization"]}]}'
create_record "research-assistant-a2a" "A2A" \
  "A2A research-assistant agent card." \
  "$(printf '{"a2a":{"agentCard":{"schemaVersion":"0.3","inlineContent":%s}}}' \
    "$(printf '%s' "${A2A_CARD}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")"

# ─── 2c. CUSTOM resource ─────────────────────────────────────────────────────
CUSTOM_PAYLOAD='{"kind":"knowledge-base","name":"product-docs-kb","description":"Vector knowledge base over product documentation.","embeddingModel":"titan-embed-text-v2","format":"markdown"}'
create_record "product-docs-kb" "CUSTOM" \
  "Custom resource describing a product-docs knowledge base." \
  "$(printf '{"custom":{"inlineContent":%s}}' \
    "$(printf '%s' "${CUSTOM_PAYLOAD}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")"

# ─── 2d. AGENT_SKILLS ────────────────────────────────────────────────────────
SKILL_MD='---
name: invoice-triage
description: Classify incoming invoices, extract line items, and flag anomalies.
version: 1.0.0
---
# Invoice Triage Skill

Classify incoming invoices, extract line items, and flag anomalies.

## When to use
- An invoice document (PDF or image) needs structured extraction.
- A vendor charge needs to be validated against a purchase order.

## Steps
1. Extract vendor, invoice number, date, totals, and line items.
2. Match against the open purchase order, if any.
3. Flag mismatches or unusual amounts for human review.
'
# AGENT_SKILLS: skillMd must begin with YAML frontmatter delimited by '---'.
create_record "invoice-triage-skill" "AGENT_SKILLS" \
  "Agent skill for triaging and extracting invoice data." \
  "$(printf '{"agentSkills":{"skillMd":{"inlineContent":%s}}}' \
    "$(printf '%s' "${SKILL_MD}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")"

# ─── 2e. second MCP server (database tools) ──────────────────────────────────
DB_SERVER='{"name":"acme/database-mcp","description":"MCP server exposing read-only SQL query tools.","version":"1.2.0"}'
create_record "database-mcp-server" "MCP" \
  "Database MCP server exposing read-only query tools." \
  "$(printf '{"mcp":{"server":{"schemaVersion":"2025-07-09","inlineContent":%s}}}' \
    "$(printf '%s' "${DB_SERVER}" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')")"

echo "Done. Registry '${REGISTRY_NAME}' (registryId=${REGISTRY_ID}) seeded."
