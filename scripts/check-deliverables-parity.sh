#!/usr/bin/env bash
# ─── Deliverables / writing-standard parity guard ─────────────────────────────
#
# The hub has ONE writing standard (blueprints/writing-standard.md) and five
# family templates (blueprints/template-<family>.md). The registry of who owes
# what lives in src/config/workflows.json (`deliverableFamilies`, per-def
# `deliverables[]`) and is read by the workflow-output Lambda's write-time lint,
# the board strip and docs/workflow/deliverables.md. This guard keeps the four
# in step, text-only, no AWS:
#
#   1. every family template exists and lists exactly the family's sections
#      (the lint enforces the JSON; the template is what the agent reads)
#   2. every blueprint that WRITES a linted deliverable loads the writing
#      standard and that deliverable's template (otherwise the agent meets the
#      lint's refusal with no instructions on how to satisfy it)
#   3. no blueprint under an enforced def writes a shared/*.md that is not in
#      the registry (an unregistered deliverable is invisible to the board and
#      the docs, and the ALL-CAPS wall of text comes back through it)
#   4. docs/workflow/deliverables.md is regenerated from the registry
#
# `--self-test` seeds broken copies and fails if any check would have passed.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="src/config/workflows.json"
STANDARD='load_blueprint("writing-standard")'
# Blueprints that mention deliverable file names but do not author them.
READERS=(review-package qa-checklist writing-standard bug-fixer playbook-build template-brief template-assessment template-spec template-record template-external)
# Evidence folders and own-contract docs that blueprints write without a template.
UNREGISTERED_OK='^(ci-evidence/|qa-evidence/|merge-brief-recovery-|review-package-)'

json() { node -e "const c=require('./$1');$2"; }

run_checks() { # $1 = repo root
  local root="$1" fail=0
  local cfg="$root/$CONFIG"
  [ -f "$cfg" ] || { echo "FAIL: $CONFIG missing" >&2; return 1; }

  # 1. templates carry exactly their family's sections
  while IFS=$'\t' read -r fam template sections; do
    local f="$root/blueprints/$template.md"
    if [ ! -f "$f" ]; then echo "FAIL: family $fam has no template blueprints/$template.md" >&2; fail=1; continue; fi
    local listed
    listed=$(awk '/^## Sections/{on=1;next} /^## Example/{on=0} on' "$f" | grep -oE '^[0-9]+\. `## [^`]+`' | sed -E 's/^[0-9]+\. `## ([^`]+)`/\1/' | paste -sd'|' -)
    if [ "$listed" != "$sections" ]; then
      echo "FAIL: blueprints/$template.md lists sections [$listed] but workflows.json says [$sections]" >&2; fail=1
    fi
  done < <(node -e '
    const c=require(process.argv[1]);
    for (const [k,f] of Object.entries(c.deliverableFamilies||{})) console.log([k,f.template,f.sections.join("|")].join("\t"));
  ' "$cfg")

  # Linted deliverables: name<TAB>template for enforced defs (a glob key contributes its literal prefix).
  local linted
  linted=$(node -e '
    const c=require(process.argv[1]); const fam=c.deliverableFamilies||{}; const seen=new Set();
    for (const w of c.workflows||[]) { if (!w.writingStandard) continue;
      for (const d of w.deliverables||[]) {
        const t = d.template===undefined ? fam[d.family]?.template : d.template;
        if (!t || t!==fam[d.family]?.template || d.kind==="pr" || d.kind==="binary" || !/\.md$/.test(d.key)) continue;
        if (d.key.startsWith("design-doc-")) continue; // save_design_doc authors are checked separately
        const needle = d.key.includes("*") ? d.key.slice(0, d.key.indexOf("*")) : d.key; // glob → literal prefix
        if (!seen.has(needle)) { seen.add(needle); console.log(needle+"\t"+t); }
      } }' "$cfg")

  # 2. every author blueprint of a linted deliverable loads the standard + its template
  while IFS=$'\t' read -r key template; do
    for f in "$root"/blueprints/*.md; do
      local name; name=$(basename "$f" .md)
      case " ${READERS[*]} " in *" $name "*) continue;; esac
      [[ "$name" == template-* ]] && continue
      grep -qF -- "shared/$key" "$f" || continue
      if ! grep -qF -- "$STANDARD" "$f"; then echo "FAIL: blueprints/$name.md writes shared/$key but never calls $STANDARD" >&2; fail=1; fi
      if ! grep -qF -- "load_blueprint(\"$template\")" "$f"; then echo "FAIL: blueprints/$name.md writes shared/$key but never loads $template" >&2; fail=1; fi
    done
  done <<< "$linted"

  # design docs: every save_design_doc author loads template-spec
  for f in "$root"/blueprints/*.md; do
    local name; name=$(basename "$f" .md)
    grep -qF -- 'WorkflowOutput___save_design_doc' "$f" || continue
    grep -qE -- '^(2\. \*\*Save design doc\*\*|[0-9]+\. `WorkflowOutput___save_design_doc`|- `WorkflowOutput___save_design_doc`)' "$f" || continue
    if ! grep -qF -- 'load_blueprint("template-spec")' "$f"; then echo "FAIL: blueprints/$name.md saves a design doc but never loads template-spec" >&2; fail=1; fi
  done

  # 3. every shared/*.md an enforced-def blueprint writes is registered
  local registered
  registered=$(node -e '
    const c=require(process.argv[1]); const s=new Set();
    for (const w of c.workflows||[]) for (const d of w.deliverables||[]) s.add(d.key);
    console.log([...s].join("\n"));' "$cfg")
  local enforced_bps="operator release-manager requirements-analyst code-reviewer security-reviewer bug-fix-requirements analytics-designer localization legal-compliance ci-agent qa-verifier backend-designer frontend-designer ios-designer android-designer"
  for name in $enforced_bps; do
    local f="$root/blueprints/$name.md"; [ -f "$f" ] || continue
    while read -r key; do
      [ -z "$key" ] && continue
      echo "$key" | grep -qE -- "$UNREGISTERED_OK" && continue
      if ! grep -qxF -- "$key" <<< "$registered"; then
        # a glob entry may cover it
        if ! node -e '
          const c=require(process.argv[1]); const k=process.argv[2];
          const ok=(c.workflows||[]).some(w=>(w.deliverables||[]).some(d=>d.key.includes("*")&&new RegExp("^"+d.key.replace(/[.+^${}()|[\]\\]/g,"\\$&").replace(/\*/g,"[^/]*")+"$").test(k)));
          process.exit(ok?0:1)' "$cfg" "$key"; then
          echo "FAIL: blueprints/$name.md writes shared/$key, which is not in the deliverables registry ($CONFIG)" >&2; fail=1
        fi
      fi
    done < <(grep -oE 'shared/[A-Za-z0-9_./{}<>-]+\.md' "$f" | sed 's#^shared/##' | sed 's/{workflow_id}//' | sort -u)
  done

  # 4. generated doc is current (only meaningful on the real tree)
  if [ "$root" = "." ] || [ "$root" = "$(pwd)" ]; then
    node scripts/gen-deliverables-doc.mjs --check >/dev/null || { echo "FAIL: docs/workflow/deliverables.md is stale (node scripts/gen-deliverables-doc.mjs)" >&2; fail=1; }
  fi
  return $fail
}

self_test() {
  local tmp; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' RETURN
  local n=0
  seed() { rm -rf "$tmp/r"; mkdir -p "$tmp/r/src/config" "$tmp/r/blueprints"; cp "$CONFIG" "$tmp/r/$CONFIG"; cp blueprints/*.md "$tmp/r/blueprints/"; }
  expect_fail() { n=$((n+1)); if run_checks "$tmp/r" >/dev/null 2>&1; then echo "SELF-TEST FAIL ($n): $1 was not detected" >&2; return 1; fi; }
  seed; sed -i.bak 's/^2\. `## Why it is ready`/2. `## Why it is done`/' "$tmp/r/blueprints/template-brief.md"; expect_fail "template sections drift"
  seed; sed -i.bak 's/load_blueprint("template-brief")/load_blueprint("template-nope")/' "$tmp/r/blueprints/operator.md"; expect_fail "author lost its template load"
  seed; sed -i.bak 's/load_blueprint("writing-standard")//g' "$tmp/r/blueprints/code-reviewer.md"; expect_fail "author lost the writing standard"
  seed; printf '\nAlso write `workflows/{workflow_id}/shared/rogue-notes.md` with `S3Storage___write_object`.\n' >> "$tmp/r/blueprints/operator.md"; expect_fail "unregistered shared/*.md"
  seed; sed -i.bak 's/load_blueprint("template-spec")//g' "$tmp/r/blueprints/backend-designer.md"; expect_fail "design-doc author lost template-spec"
  echo "self-test: $n seeded breaks all detected"
}

if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_checks "." && echo "deliverables parity guard: OK"
