#!/bin/bash
# ─── Submit Workflow ─────────────────────────────────────────────────────────
#
# Production workflow submission tool with input validation.
#
# Features:
#   - Validates GitHub repos are accessible before submission
#   - Uploads local images to S3 and generates presigned URLs
#   - Supports model override (opus, sonnet)
#   - Validates API endpoint is healthy before submission
#   - Supports description from file (--desc-file)
#   - Dry-run mode to preview the payload
#
# Usage:
#   ./scripts/submit-workflow.sh \
#     --title "Feature Name" \
#     --desc "Description or requirements" \
#     --repo "https://github.com/owner/repo" \
#     --model sonnet \
#     --image /path/to/screenshot.png \
#     --image s3://bucket/key.png
#
# Examples:
#   # Simple with inline description
#   ./scripts/submit-workflow.sh --title "Add dark mode" --desc "Add toggle..." --repo https://github.com/org/app
#
#   # With image and description file
#   ./scripts/submit-workflow.sh --title "Progress Card" --desc-file ./prd.md --repo https://github.com/org/app --image ./screenshot.png --model opus
#
#   # Dry run (preview payload, don't submit)
#   ./scripts/submit-workflow.sh --title "Test" --desc "..." --dry-run
#
# ─────────────────────────────────────────────────────────────────────────────

set -e

# ─── Defaults ────────────────────────────────────────────────────────────────

BASE_URL="${WORKFLOW_API_URL:?ERROR: Set WORKFLOW_API_URL to your App Runner URL}"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-agentcore-hub-artifacts-${ACCOUNT_ID}}"
DEFAULT_BRANCH="main"

TITLE=""
DESC=""
DESC_FILE=""
REPO_URLS=()
IMAGES=()
MODEL=""
DRY_RUN=false
SKIP_VALIDATION=false

# ─── Model aliases ───────────────────────────────────────────────────────────

resolve_model() {
  case "$1" in
    opus|opus4.6|opus-4.6)   echo "us.anthropic.claude-opus-5" ;;
    sonnet|sonnet4.6|sonnet-4.6) echo "us.anthropic.claude-sonnet-5" ;;
    haiku|haiku3.5)          echo "us.anthropic.claude-3-5-haiku-20241022-v1:0" ;;
    us.anthropic.*)          echo "$1" ;;  # Already a full model ID
    *)
      echo "ERROR: Unknown model '$1'. Use: opus, sonnet, haiku, or a full model ID" >&2
      exit 1
      ;;
  esac
}

# ─── Parse args ──────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)        TITLE="$2"; shift 2 ;;
    --desc)         DESC="$2"; shift 2 ;;
    --desc-file)    DESC_FILE="$2"; shift 2 ;;
    --repo)         REPO_URLS+=("$2"); shift 2 ;;
    --branch)       DEFAULT_BRANCH="$2"; shift 2 ;;
    --image)        IMAGES+=("$2"); shift 2 ;;
    --model)        MODEL="$2"; shift 2 ;;
    --url)          BASE_URL="$2"; shift 2 ;;
    --dry-run)      DRY_RUN=true; shift ;;
    --skip-validation) SKIP_VALIDATION=true; shift ;;
    -h|--help)
      sed -n '2,/^# ───.*$/p' "$0" | grep "^#" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown arg: $1 (use --help)"; exit 1 ;;
  esac
done

# ─── Validate required inputs ────────────────────────────────────────────────

ERRORS=()

if [ -z "$TITLE" ]; then
  ERRORS+=("--title is required")
fi

if [ -z "$DESC" ] && [ -z "$DESC_FILE" ]; then
  ERRORS+=("--desc or --desc-file is required")
fi

if [ -n "$DESC_FILE" ]; then
  if [ ! -f "$DESC_FILE" ]; then
    ERRORS+=("Description file not found: $DESC_FILE")
  else
    DESC=$(cat "$DESC_FILE")
  fi
fi

if [ ${#ERRORS[@]} -gt 0 ]; then
  echo "═══ Validation Errors ═══"
  for err in "${ERRORS[@]}"; do
    echo "  ✗ $err"
  done
  echo ""
  echo "Run with --help for usage."
  exit 1
fi

# ─── Resolve model ───────────────────────────────────────────────────────────

MODEL_ID=""
if [ -n "$MODEL" ]; then
  MODEL_ID=$(resolve_model "$MODEL")
fi

# ─── Validate API endpoint ───────────────────────────────────────────────────

if [ "$SKIP_VALIDATION" = false ]; then
  echo "Validating API endpoint..."
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/health" 2>/dev/null || echo "000")
  if [ "$HTTP_STATUS" = "000" ]; then
    echo "  ✗ Cannot reach $BASE_URL — is the server running?"
    exit 1
  fi
  echo "  ✓ API reachable ($BASE_URL)"
fi

# ─── Validate GitHub repos ───────────────────────────────────────────────────

if [ "$SKIP_VALIDATION" = false ] && [ ${#REPO_URLS[@]} -gt 0 ]; then
  echo "Validating repositories..."
  for REPO in "${REPO_URLS[@]}"; do
    # Extract owner/repo from URL
    OWNER_REPO=$(echo "$REPO" | sed -E 's|https?://github\.com/||; s|\.git$||; s|/$||')

    # Check via GitHub API (works without auth for public repos)
    GITHUB_PAT="${GITHUB_PAT:-}"
    AUTH_HEADER=""
    [ -n "$GITHUB_PAT" ] && AUTH_HEADER="Authorization: token $GITHUB_PAT"

    REPO_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
      "https://api.github.com/repos/$OWNER_REPO" 2>/dev/null)

    if [ "$REPO_STATUS" = "200" ]; then
      echo "  ✓ $REPO (accessible)"
    elif [ "$REPO_STATUS" = "404" ]; then
      echo "  ✗ $REPO — NOT FOUND (404). Check the URL."
      exit 1
    elif [ "$REPO_STATUS" = "401" ] || [ "$REPO_STATUS" = "403" ]; then
      echo "  ⚠ $REPO — auth required (private repo). Set GITHUB_PAT to validate."
    else
      echo "  ⚠ $REPO — got HTTP $REPO_STATUS (proceeding anyway)"
    fi
  done
fi

# ─── Process images ──────────────────────────────────────────────────────────

IMAGE_URLS=()
if [ ${#IMAGES[@]} -gt 0 ]; then
  echo "Processing images..."
  for IMG in "${IMAGES[@]}"; do
    if [[ "$IMG" == s3://* ]]; then
      # Already in S3 — generate presigned URL
      S3_PATH="${IMG#s3://}"
      BUCKET_NAME="${S3_PATH%%/*}"
      KEY="${S3_PATH#*/}"
      PRESIGNED=$(aws s3 presign "s3://$BUCKET_NAME/$KEY" --expires-in 604800 --region "$AWS_REGION" 2>&1)
      IMAGE_URLS+=("$PRESIGNED")
      echo "  ✓ S3: $KEY (presigned 7d)"

    elif [[ "$IMG" == http* ]]; then
      # Already a URL — use as-is
      IMAGE_URLS+=("$IMG")
      echo "  ✓ URL: ${IMG:0:60}..."

    elif [ -f "$IMG" ]; then
      # Local file — upload to S3
      FILENAME=$(basename "$IMG")
      S3_KEY="workflow-inputs/${FILENAME}"
      aws s3 cp "$IMG" "s3://$ARTIFACT_BUCKET/$S3_KEY" --region "$AWS_REGION" > /dev/null 2>&1
      PRESIGNED=$(aws s3 presign "s3://$ARTIFACT_BUCKET/$S3_KEY" --expires-in 604800 --region "$AWS_REGION" 2>&1)
      IMAGE_URLS+=("$PRESIGNED")
      echo "  ✓ Uploaded: $FILENAME → s3://$ARTIFACT_BUCKET/$S3_KEY"

      # Also append S3 reference to description so agents can use download_s3_file
      DESC="${DESC}

## Image: ${FILENAME}
- Browser URL: ${PRESIGNED}
- S3 key (use download_s3_file tool): ${S3_KEY}
- S3 bucket: ${ARTIFACT_BUCKET}"
    else
      echo "  ✗ Image not found: $IMG"
      exit 1
    fi
  done
fi

# ─── Build repos JSON ────────────────────────────────────────────────────────

REPOS_JSON="[]"
if [ ${#REPO_URLS[@]} -gt 0 ]; then
  REPOS_JSON=$(printf '%s\n' "${REPO_URLS[@]}" | jq -R '{"url": ., "defaultBranch": "'"$DEFAULT_BRANCH"'"}' | jq -s '.')
fi

# ─── Build request body ─────────────────────────────────────────────────────

BODY=$(jq -n \
  --arg title "$TITLE" \
  --arg desc "$DESC" \
  --argjson repos "$REPOS_JSON" \
  --arg model "$MODEL_ID" \
  '{
    title: $title,
    description: $desc,
    sources: [],
    repoConfig: { repos: $repos }
  } + (if $model != "" then { modelOverride: $model } else {} end)')

# ─── Dry run ─────────────────────────────────────────────────────────────────

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "═══ DRY RUN — Payload Preview ═══"
  echo "$BODY" | jq '{title, model: .modelOverride, repos: [.repoConfig.repos[].url], desc_length: (.description | length), desc_preview: (.description[:200] + "...")}'
  echo ""
  echo "Full payload written to /tmp/workflow-payload.json"
  echo "$BODY" | jq . > /tmp/workflow-payload.json
  exit 0
fi

# ─── Submit ──────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Submitting Workflow"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Title:   $TITLE"
echo "  Model:   ${MODEL_ID:-default (opus)}"
echo "  Repos:   ${REPO_URLS[*]:-none}"
echo "  Images:  ${#IMAGES[@]}"
echo "  Desc:    ${#DESC} chars"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$BASE_URL/api/workflow/start" \
  -H "Content-Type: application/json" \
  -d "$BODY")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ne 200 ]; then
  echo "  ✗ FAILED (HTTP $HTTP_CODE)"
  echo "  Response: $BODY_RESPONSE"
  echo ""
  echo "  Payload saved to /tmp/workflow-payload-failed.json"
  echo "$BODY" | jq . > /tmp/workflow-payload-failed.json
  exit 1
fi

WORKFLOW_ID=$(echo "$BODY_RESPONSE" | jq -r '.workflowId // empty')
EPIC_ID=$(echo "$BODY_RESPONSE" | jq -r '.epicId // empty')

echo "  ✓ Workflow started!"
echo ""
echo "  Workflow ID: $WORKFLOW_ID"
echo "  Epic ID:     $EPIC_ID"
echo ""
echo "  View in UI:  $BASE_URL/workflow?id=$WORKFLOW_ID"
echo ""
echo "  Monitor:"
echo "    curl -s $BASE_URL/api/workflow/$WORKFLOW_ID/state | jq .phase"
echo ""
echo "═══════════════════════════════════════════════════════"
