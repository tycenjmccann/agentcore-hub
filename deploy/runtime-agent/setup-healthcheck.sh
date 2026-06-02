#!/bin/bash
#
# setup-healthcheck.sh — Set up all infrastructure for fleet health check tests
#
# This script:
#   1. Discovers deployed agents and generates fleet-runtime-ids.json
#   2. Creates and uploads S3 test fixtures
#   3. Validates Jira access (creates parent ticket if needed)
#   4. Validates GitHub MCP access
#   5. Outputs the command to run the health check
#
# Prerequisites:
#   - AWS CLI configured (AWS_PROFILE or default credentials)
#   - agentcore CLI installed (pip install bedrock-agentcore-starter-toolkit)
#   - ARTIFACT_BUCKET env var set (or auto-detected)
#   - JIRA_* env vars set (for Jira validation)
#   - GITHUB_PAT env var set (for GitHub validation)
#
# Usage:
#   ./setup-healthcheck.sh [--region us-east-1] [--bucket my-bucket]
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGION="${AWS_REGION:-us-east-1}"
BUCKET="${ARTIFACT_BUCKET:-}"
JIRA_PARENT_KEY="${JIRA_HEALTHCHECK_PARENT:-TEAM-116}"
FLEET_FILE="$SCRIPT_DIR/fleet-runtime-ids.json"
FIXTURES_DIR="$SCRIPT_DIR/healthcheck-fixtures"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --jira-parent) JIRA_PARENT_KEY="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

echo "═══════════════════════════════════════════════════════════════"
echo "  Fleet Health Check — Setup"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─── Step 1: Auto-detect ARTIFACT_BUCKET if not set ─────────────────────────

if [ -z "$BUCKET" ]; then
  echo "  [1/5] Auto-detecting artifact bucket..."
  BUCKET=$(aws s3 ls 2>/dev/null | grep -o 'agentcore-hub-artifacts-[^ ]*' | head -1)
  if [ -z "$BUCKET" ]; then
    echo "  ERROR: Could not find artifact bucket. Set ARTIFACT_BUCKET env var."
    exit 1
  fi
  echo "        Found: $BUCKET"
else
  echo "  [1/5] Using bucket: $BUCKET"
fi
echo ""

# ─── Step 2: Discover deployed agents → fleet-runtime-ids.json ──────────────
#
# Use the AgentCore control plane as source of truth. We previously read
# CloudWatch log groups, but those persist long after a runtime is deleted —
# producing phantom ARNs that the verify script then tries to invoke.

echo "  [2/5] Discovering deployed agents..."

# Use boto3 directly rather than `aws bedrock-agentcore-control list-agent-runtimes`.
# That control-plane API is in preview: it ships in the AWS SDKs (boto3) but is
# NOT yet exposed by the AWS CLI, so the CLI call fails on stock installs. boto3
# is already a dependency of the fleet tooling, so this works everywhere the
# health check runs. Errors are surfaced, not swallowed.
AGENT_ARNS=$(REGION="$REGION" python3 <<'PY'
import json, os, sys
try:
    import boto3
except ImportError:
    sys.stderr.write("ERROR: boto3 not installed. pip install boto3\n")
    sys.exit(2)

region = os.environ["REGION"]
try:
    client = boto3.client("bedrock-agentcore-control", region_name=region)
except Exception as e:
    sys.stderr.write(f"ERROR: could not create bedrock-agentcore-control client: {e}\n")
    sys.exit(2)

fleet = {}
next_token = None
try:
    while True:
        kwargs = {"nextToken": next_token} if next_token else {}
        resp = client.list_agent_runtimes(**kwargs)
        runtimes = resp.get("agentRuntimes") or resp.get("agentRuntimeSummaries") or []
        for r in runtimes:
            name = r.get("agentRuntimeName") or r.get("name") or ""
            if not name.startswith("agentcore_hub_"):
                continue
            status = (r.get("status") or "").upper()
            if status and status != "READY":
                continue
            arn = r.get("agentRuntimeArn") or r.get("arn")
            if name and arn:
                fleet[name] = arn
        next_token = resp.get("nextToken")
        if not next_token:
            break
except Exception as e:
    sys.stderr.write(f"ERROR: list_agent_runtimes failed: {e}\n")
    sys.exit(2)

print(json.dumps(fleet, indent=2))
PY
) || {
  echo "  ERROR: Failed to list agent runtimes in $REGION (see error above)."
  exit 1
}

if [ -z "$AGENT_ARNS" ] || [ "$AGENT_ARNS" = "{}" ]; then
  echo "  ERROR: No READY agentcore-hub runtimes found in $REGION."
  echo "         Deploy agents first: ./deploy-topology.sh (or ./deploy-fleet.sh)"
  exit 1
fi

echo "$AGENT_ARNS" > "$FLEET_FILE"
AGENT_COUNT=$(echo "$AGENT_ARNS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
echo "        Found $AGENT_COUNT READY agents → $FLEET_FILE"
echo ""

# ─── Step 3: Create and upload S3 test fixtures ─────────────────────────────

echo "  [3/5] Creating test fixtures..."

mkdir -p "$FIXTURES_DIR"

# buggy-component.tsx — React component with localStorage-in-useState SSR bug
cat > "$FIXTURES_DIR/buggy-component.tsx" << 'TSX'
import React, { useState } from "react";

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  // BUG: localStorage is not available during SSR (server-side rendering).
  // This causes a hydration mismatch because the server renders with undefined
  // but the client renders with the stored value.
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem("theme") || "light";
  });

  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem("theme", next);
  };

  return (
    <button className={className} onClick={toggle}>
      {theme === "light" ? "🌙" : "☀️"} {theme} mode
    </button>
  );
}
TSX

# fixed-component.tsx — The correct SSR-safe implementation
cat > "$FIXTURES_DIR/fixed-component.tsx" << 'TSX'
import React, { useState, useEffect } from "react";

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  // FIX: Use a safe default for SSR, then hydrate from localStorage in useEffect
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    const saved = localStorage.getItem("theme");
    if (saved) setTheme(saved);
  }, []);

  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem("theme", next);
  };

  return (
    <button className={className} onClick={toggle}>
      {theme === "light" ? "🌙" : "☀️"} {theme} mode
    </button>
  );
}
TSX

# test-page.html — Known HTML content for browser test
cat > "$FIXTURES_DIR/test-page.html" << 'HTML'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>AgentCore Hub Fleet Status</title>
  <style>
    body { font-family: system-ui; background: #0f172a; color: #e2e8f0; padding: 40px; }
    h1 { color: #0ea5e9; }
    .status { color: #22c55e; font-size: 1.2em; }
    .version { color: #64748b; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1 id="title">AgentCore Hub Fleet Status</h1>
  <p class="status" id="message">All systems operational</p>
  <p class="version" id="version">v2.1.0</p>
  <ul>
    <li>Requirements Analyst: online</li>
    <li>Frontend Designer: online</li>
    <li>Backend Dev: online</li>
    <li>QA Verifier: online</li>
    <li>CI Agent: online</li>
  </ul>
</body>
</html>
HTML

# test-logo.png — Generate a simple blue circle with "AGENTCORE" text using Python
# We write directly into $FIXTURES_DIR (already mkdir'd above) and pass the path
# via env var so the quoted heredoc keeps its literal Python.
HEALTHCHECK_LOGO_PATH="$FIXTURES_DIR/test-logo.png" python3 << 'PYIMG'
import os
out_path = os.environ["HEALTHCHECK_LOGO_PATH"]
try:
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (400, 400), color=(15, 23, 42))
    draw = ImageDraw.Draw(img)
    # Blue circle
    draw.ellipse([100, 50, 300, 250], fill=(14, 165, 233), outline=(56, 189, 248), width=3)
    # Text "AGENTCORE" below
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 36)
    except (OSError, IOError):
        font = ImageFont.load_default()
    draw.text((120, 280), "AGENTCORE", fill=(226, 232, 240), font=font)
    img.save(out_path)
    print("        Generated test-logo.png (PIL)")
except ImportError:
    # Fallback: create a minimal valid PNG without PIL
    import struct, zlib
    width, height = 200, 200
    # Create a simple blue square PNG
    raw = b""
    for y in range(height):
        raw += b"\x00"  # filter byte
        for x in range(width):
            # Blue circle: check if (x,y) is within radius 80 of center (100,100)
            dx, dy = x - 100, y - 100
            if dx*dx + dy*dy < 80*80:
                raw += b"\x0e\xa5\xe9\xff"  # blue
            else:
                raw += b"\x0f\x17\x2a\xff"  # dark bg

    def make_chunk(chunk_type, data):
        chunk = chunk_type + data
        return struct.pack(">I", len(data)) + chunk + struct.pack(">I", zlib.crc32(chunk) & 0xffffffff)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n"
    png += make_chunk(b"IHDR", ihdr)
    png += make_chunk(b"IDAT", zlib.compress(raw))
    png += make_chunk(b"IEND", b"")

    with open(out_path, "wb") as f:
        f.write(png)
    print("        Generated test-logo.png (raw PNG fallback)")
PYIMG

# Upload all fixtures to S3
echo "        Uploading fixtures to s3://$BUCKET/healthcheck/fixtures/..."
aws s3 sync "$FIXTURES_DIR/" "s3://$BUCKET/healthcheck/fixtures/" --region "$REGION" --quiet
echo "        Uploaded: buggy-component.tsx, fixed-component.tsx, test-page.html, test-logo.png"
echo ""

# ─── Step 4: Validate Jira access ──────────────────────────────────────────

echo "  [4/5] Validating Jira access..."

if [ -z "${JIRA_SITE_URL:-}" ] || [ -z "${JIRA_EMAIL:-}" ] || [ -z "${JIRA_API_TOKEN:-}" ]; then
  echo "        SKIP: JIRA_SITE_URL, JIRA_EMAIL, or JIRA_API_TOKEN not set"
  echo "        Jira tests will fail. Set these env vars for full validation."
else
  JIRA_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
    "https://$JIRA_SITE_URL/rest/api/3/issue/$JIRA_PARENT_KEY" 2>/dev/null)

  if [ "$JIRA_STATUS" = "200" ]; then
    echo "        Jira: Connected to $JIRA_SITE_URL"
    echo "        Parent ticket: $JIRA_PARENT_KEY (exists)"
  elif [ "$JIRA_STATUS" = "404" ]; then
    echo "        WARNING: Parent ticket $JIRA_PARENT_KEY not found."
    echo "        Creating it..."
    CREATE_RESULT=$(curl -s -X POST \
      -u "$JIRA_EMAIL:$JIRA_API_TOKEN" \
      -H "Content-Type: application/json" \
      "https://$JIRA_SITE_URL/rest/api/3/issue" \
      -d "{\"fields\":{\"project\":{\"key\":\"${JIRA_PROJECT_KEY:-TEAM}\"},\"summary\":\"[HEALTHCHECK] Integration Test Parent\",\"issuetype\":{\"name\":\"Epic\"},\"labels\":[\"healthcheck\"]}}" 2>/dev/null)
    NEW_KEY=$(echo "$CREATE_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('key','FAILED'))" 2>/dev/null)
    echo "        Created parent: $NEW_KEY (update JIRA_HEALTHCHECK_PARENT if different from $JIRA_PARENT_KEY)"
  else
    echo "        ERROR: Jira returned HTTP $JIRA_STATUS. Check credentials."
  fi
fi
echo ""

# ─── Step 4b: Detect Bedrock Knowledge Base ────────────────────────────────

BEDROCK_KB_ID="${BEDROCK_KB_ID:-}"
if [ -z "$BEDROCK_KB_ID" ]; then
  # Try to find one in us-east-1 or us-west-2
  KB_ID=$(aws bedrock-agent list-knowledge-bases --region "$REGION" \
    --query 'knowledgeBaseSummaries[?status==`ACTIVE`].knowledgeBaseId | [0]' --output text 2>/dev/null)
  if [ "$KB_ID" = "None" ] || [ -z "$KB_ID" ]; then
    KB_ID=$(aws bedrock-agent list-knowledge-bases --region us-west-2 \
      --query 'knowledgeBaseSummaries[?status==`ACTIVE`].knowledgeBaseId | [0]' --output text 2>/dev/null)
  fi
  if [ "$KB_ID" != "None" ] && [ -n "$KB_ID" ]; then
    BEDROCK_KB_ID="$KB_ID"
    echo "        Bedrock KB: $BEDROCK_KB_ID (auto-detected)"
  else
    BEDROCK_KB_ID="NONE"
    echo "        Bedrock KB: none found (retrieve test will be skipped)"
  fi
else
  echo "        Bedrock KB: $BEDROCK_KB_ID (from env)"
fi
echo ""

# ─── Step 5: Validate GitHub access ────────────────────────────────────────

echo "  [5/5] Validating GitHub access..."

if [ -z "${GITHUB_PAT:-}" ]; then
  echo "        SKIP: GITHUB_PAT not set. GitHub MCP tests will fail."
else
  GH_USER=$(curl -s -H "Authorization: Bearer $GITHUB_PAT" \
    "https://api.github.com/user" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin).get('login','FAILED'))" 2>/dev/null)

  if [ "$GH_USER" != "FAILED" ] && [ -n "$GH_USER" ]; then
    echo "        GitHub: Authenticated as $GH_USER"
    # Check rate limit
    RATE=$(curl -s -H "Authorization: Bearer $GITHUB_PAT" \
      "https://api.github.com/rate_limit" 2>/dev/null | python3 -c "import json,sys; r=json.load(sys.stdin).get('rate',{}); print(f\"{r.get('remaining',0)}/{r.get('limit',0)}\")" 2>/dev/null)
    echo "        Rate limit: $RATE remaining"
  else
    echo "        ERROR: GitHub auth failed. Check GITHUB_PAT."
  fi
fi

# ─── Done ───────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Setup Complete"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Fleet file:  $FLEET_FILE"
echo "  Fixtures:    s3://$BUCKET/healthcheck/fixtures/"
echo "  Jira parent: $JIRA_PARENT_KEY"
echo ""
echo "  Run the health check:"
echo "  ─────────────────────"
echo "  BEDROCK_KB_ID=$BEDROCK_KB_ID GITHUB_OWNER=\$GITHUB_OWNER GITHUB_REPO=\$GITHUB_REPO \\"
echo "  python3 $SCRIPT_DIR/verify-fleet-invoke.py \\"
echo "    --fleet-file $FLEET_FILE \\"
echo "    --region $REGION \\"
echo "    --timeout 540 \\"
echo "    --parallel 3"
echo ""
echo "  Test a single agent:"
echo "  ─────────────────────"
echo "  BEDROCK_KB_ID=$BEDROCK_KB_ID GITHUB_OWNER=\$GITHUB_OWNER GITHUB_REPO=\$GITHUB_REPO \\"
echo "  python3 $SCRIPT_DIR/verify-fleet-invoke.py \\"
echo "    --fleet-file $FLEET_FILE \\"
echo "    --agent agentcore_hub_requirements_analyst \\"
echo "    --timeout 540 --verbose"
echo ""
echo "═══════════════════════════════════════════════════════════════"
