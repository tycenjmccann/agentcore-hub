#!/usr/bin/env bash
# ─── CD registry — which repos the hub MERGES + DEPLOYS ──────────────────────
#
# The registry is s3://<ARTIFACT_BUCKET>/config/cd-registry.json (seeded from
# src/config/cd-registry.json on first deploy). A workflow on a registered repo
# runs the full ship phase (final-PR review → human Merge Approval → merge +
# deploy via the named pipeline or the repo's DEPLOY.md). A workflow on any
# other repo is a HANDOFF: it ends after review/QA/CI, the orchestrator opens the
# unified PR and leaves it open for the owning team. The orchestrator re-reads
# the registry within CD_REGISTRY_TTL_MS (60s) — no redeploy.
#
# Usage:
#   scripts/cd-registry.sh list
#   scripts/cd-registry.sh add <owner/repo|github url> [--pipeline NAME] [--region R] [--ci-project NAME] [--deploy-doc PATH] [--notes TEXT]
#   scripts/cd-registry.sh remove <owner/repo|github url>
#   scripts/cd-registry.sh seed           # upload src/config/cd-registry.json ONLY if S3 has none
#
# Bucket comes from deploy/config.sh (ARTIFACT_BUCKET) — never hardcoded.
# The same edits are available in the UI: Workflow tab → Target Repository → "CD registry…".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/deploy/config.sh" >/dev/null 2>&1 || true
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET not set (source deploy/config.sh or export it)}"
REGION="${AWS_REGION:-us-east-1}"
KEY="config/cd-registry.json"
URI="s3://${ARTIFACT_BUCKET}/${KEY}"

fetch() {
  if aws s3 cp "$URI" - --region "$REGION" 2>/dev/null; then return 0; fi
  echo '{"version":1,"repos":[]}'
}

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

cmd="${1:-}"; shift || true
case "$cmd" in
  list)
    fetch | python3 -c '
import json,sys
d=json.load(sys.stdin); repos=d.get("repos",[])
if not repos: print("(no repos registered — every run is a HANDOFF: PR left open, no merge/deploy)"); sys.exit(0)
for e in repos:
    how = ("pipeline=" + e["pipeline"] + (" (" + e["region"] + ")" if e.get("region") else "")) if e.get("pipeline") else "deploy-doc=" + e.get("deployDoc", "DEPLOY.md")
    print(e["repo"].ljust(45), how, ("  # " + e["notes"]) if e.get("notes") else "")'
    ;;
  add)
    repo="${1:?owner/repo or GitHub URL required}"; shift
    pipeline=""; region=""; ciproject=""; deploydoc=""; notes=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --pipeline) pipeline="$2"; shift 2 ;;
        --region) region="$2"; shift 2 ;;
        # A CodeBuild PROJECT (the PR check), not a CodePipeline — see
        # src/config/cd-registry.json. Read by the orchestrator's CI_CHECK_MODE probe.
        --ci-project) ciproject="$2"; shift 2 ;;
        --deploy-doc) deploydoc="$2"; shift 2 ;;
        --notes) notes="$2"; shift 2 ;;
        *) echo "unknown flag $1" >&2; usage ;;
      esac
    done
    fetch | REPO="$repo" PIPELINE="$pipeline" RG="$region" CIP="$ciproject" DD="$deploydoc" NOTES="$notes" python3 -c '
import json,os,re,sys,datetime
def key(v):
    s=str(v or "").strip(); s=re.sub(r"^git@[^:]+:","",s); s=re.sub(r"^[a-z]+://[^/]+/","",s,flags=re.I)
    s=re.sub(r"\.git$","",s,flags=re.I).strip("/"); p=s.split("/")
    return f"{p[0]}/{p[1]}".lower() if len(p)==2 and p[0] and p[1] else None
k=key(os.environ["REPO"])
if not k: sys.exit("repo must be owner/repo or a GitHub URL")
d=json.load(sys.stdin); repos=[e for e in d.get("repos",[]) if e.get("repo")!=k]
prev=next((e for e in d.get("repos",[]) if e.get("repo")==k),{})
e={"repo":k,"addedAt":prev.get("addedAt") or datetime.datetime.now(datetime.timezone.utc).isoformat()}
for f,env in (("pipeline","PIPELINE"),("region","RG"),("ciProject","CIP"),("deployDoc","DD"),("notes","NOTES")):
    v=os.environ.get(env,"").strip() or prev.get(f)
    if v: e[f]=v
repos.append(e); repos.sort(key=lambda x:x["repo"])
json.dump({"version":d.get("version",1),"repos":repos},sys.stdout,indent=2); print()' > /tmp/cd-registry.json
    aws s3 cp /tmp/cd-registry.json "$URI" --region "$REGION" --content-type application/json --only-show-errors
    echo "registered → $URI"; "$0" list
    ;;
  remove)
    repo="${1:?owner/repo or GitHub URL required}"
    fetch | REPO="$repo" python3 -c '
import json,os,re,sys
def key(v):
    s=str(v or "").strip(); s=re.sub(r"^git@[^:]+:","",s); s=re.sub(r"^[a-z]+://[^/]+/","",s,flags=re.I)
    s=re.sub(r"\.git$","",s,flags=re.I).strip("/"); p=s.split("/")
    return f"{p[0]}/{p[1]}".lower() if len(p)==2 and p[0] and p[1] else None
k=key(os.environ["REPO"]); d=json.load(sys.stdin)
repos=[e for e in d.get("repos",[]) if e.get("repo")!=k]
if len(repos)==len(d.get("repos",[])): print(f"{k} was not registered", file=sys.stderr)
json.dump({"version":d.get("version",1),"repos":repos},sys.stdout,indent=2); print()' > /tmp/cd-registry.json
    aws s3 cp /tmp/cd-registry.json "$URI" --region "$REGION" --content-type application/json --only-show-errors
    echo "updated → $URI"; "$0" list
    ;;
  seed)
    if aws s3api head-object --bucket "$ARTIFACT_BUCKET" --key "$KEY" --region "$REGION" >/dev/null 2>&1; then
      echo "registry already exists at $URI — not overwriting (edit with add/remove or the UI)"
    else
      aws s3 cp "$REPO_ROOT/src/config/cd-registry.json" "$URI" --region "$REGION" --content-type application/json --only-show-errors
      echo "seeded $URI from src/config/cd-registry.json"
    fi
    ;;
  *) usage ;;
esac
