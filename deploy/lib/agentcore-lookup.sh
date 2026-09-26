#!/bin/bash
# ─── deploy/lib/agentcore-lookup.sh — paginated AgentCore name → field lookup ──
#
# Source it after deploy/config.sh (it reads AWS_REGION), then:
#
#   source "$REPO_ROOT/deploy/lib/agentcore-lookup.sh"
#   id="$(agentcore_runtime_field agentcore_hub_coding_runtime agentRuntimeId)" || rc=$?
#   arn="$(agentcore_harness_field agentcore_hub_workflow_manager arn)"        || rc=$?
#
# WHY (TEAM-5173 r5-F1): every deploy script used to resolve these with
#   aws bedrock-agentcore-control list-agent-runtimes \
#     --query "agentRuntimes[?agentRuntimeName=='x'].agentRuntimeId | [0]" --output text
# The AWS CLI's TEXT formatter applies --query to EACH PAGE of a paginated
# operation, so once the account has more runtimes than one page holds the
# output is "None\n<id>" (or "<id>\nNone"). The usual `[[ -z || == None ]]`
# guard passes that value, and lambda/cost-report/deploy.sh configured the
# Lambda with a log-group name containing a newline and the word None — which
# fails silently, as a data gap. (The JSON/YAML formatters buffer every page
# before applying --query; only text is per-page.)
#
# This helper pages explicitly (--no-paginate + --next-token), parses each page
# as JSON in python3 (already a dependency of the deploy scripts), and validates
# the value, so "None", "", whitespace and multi-line output are impossible.
#
# Return codes — callers decide what "not found" means for them:
#   0  exactly one match; the field value is printed on stdout
#   1  the COMPLETE listing has no item with that name; nothing printed
#   2  cannot answer: the CLI call failed, a page was not JSON, the value is
#      not a plain id/ARN, more than one item matched, or the page cap was hit.
#      A one-line reason goes to stderr. Never swallowed here.
#
# Needs: aws (with bedrock-agentcore-control), python3, AWS_REGION.

AGENTCORE_LOOKUP_MAX_PAGES="${AGENTCORE_LOOKUP_MAX_PAGES:-100}"

# _agentcore_lookup <operation> <collection> <nameKey> <name> <field>
_agentcore_lookup() {
  local op="$1" collection="$2" name_key="$3" name="$4" field="$5"
  local token="" page="" parsed="" matches="" pages=0 match_count=0
  if [[ -z "${AWS_REGION:-}" ]]; then
    echo "agentcore-lookup: AWS_REGION is not set" >&2; return 2
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "agentcore-lookup: python3 not found on PATH" >&2; return 2
  fi
  while :; do
    pages=$((pages + 1))
    if (( pages > AGENTCORE_LOOKUP_MAX_PAGES )); then
      echo "agentcore-lookup: ${op} exceeded ${AGENTCORE_LOOKUP_MAX_PAGES} pages looking for ${name}" >&2
      return 2
    fi
    local -a args=(bedrock-agentcore-control "$op" --region "$AWS_REGION" --output json --no-paginate)
    if [[ -n "$token" ]]; then args+=(--next-token "$token"); fi
    if ! page="$(aws "${args[@]}" 2>&1)"; then
      echo "agentcore-lookup: aws ${op} failed (page ${pages}): ${page}" >&2
      return 2
    fi
    # One line per match ("MATCH<TAB>value"), then "NEXT<TAB>token" when the
    # page is not the last. Anything not parseable is a hard error.
    if ! parsed="$(printf '%s' "$page" | python3 -c '
import json, sys
collection, name_key, name, field = sys.argv[1:5]
try:
    doc = json.load(sys.stdin)
except ValueError as e:
    sys.stderr.write("page is not JSON: %s\n" % e); sys.exit(3)
if not isinstance(doc, dict):
    sys.stderr.write("page is not a JSON object\n"); sys.exit(3)
for item in doc.get(collection) or []:
    if isinstance(item, dict) and item.get(name_key) == name:
        v = item.get(field)
        print("MATCH\t%s" % ("" if v is None else v))
nxt = doc.get("nextToken")
if nxt:
    print("NEXT\t%s" % nxt)
' "$collection" "$name_key" "$name" "$field" 2>&1)"; then
      echo "agentcore-lookup: aws ${op} returned an unusable page ${pages}: ${parsed}" >&2
      return 2
    fi
    token=""
    local line
    while IFS= read -r line; do
      case "$line" in
        MATCH*) matches+="${line#MATCH$'\t'}"$'\n'; match_count=$((match_count + 1)) ;;
        NEXT*)  token="${line#NEXT$'\t'}" ;;
        "")     ;;
        *)      echo "agentcore-lookup: unexpected parser output: ${line}" >&2; return 2 ;;
      esac
    done <<< "$parsed"
    [[ -n "$token" ]] || break
  done
  if (( match_count == 0 )); then
    return 1
  fi
  if (( match_count > 1 )); then
    echo "agentcore-lookup: ${op}: more than one item named ${name}" >&2
    return 2
  fi
  # Strip the trailing newline the accumulator adds.
  matches="${matches%$'\n'}"
  # Plain ids and ARNs only — this is what rules out None/empty/whitespace and
  # anything that could not be spliced into a log-group name or IAM policy.
  if [[ "$matches" == "None" || "$matches" == "null" || ! "$matches" =~ ^[A-Za-z0-9:/_.-]+$ ]]; then
    echo "agentcore-lookup: ${op}: ${name}.${field} is not a plain id/ARN: '${matches}'" >&2
    return 2
  fi
  printf '%s\n' "$matches"
  return 0
}

# agentcore_runtime_field <agentRuntimeName> <field>   (agentRuntimeId | agentRuntimeArn | ...)
agentcore_runtime_field() {
  _agentcore_lookup list-agent-runtimes agentRuntimes agentRuntimeName "$1" "$2"
}

# agentcore_harness_field <harnessName> <field>   (arn | harnessId | ...)
agentcore_harness_field() {
  _agentcore_lookup list-harnesses harnesses harnessName "$1" "$2"
}
