#!/usr/bin/env bash
# ─── Model-surface guard (DL-033) ─────────────────────────────────────────────
#
# Which model an agent, a coding CLI or a tier name runs on is declared in ONE
# document, config/models.json, and resolved at the point of use. This guard is
# what makes that a property of the repo rather than a wish: a Bedrock model id
# literal in a tracked, non-doc, non-test file is a second source of truth, and
# a second source of truth drifts silently — a tier meant one model on the fleet
# runtime and another in the orchestrator for months before TEAM-4995.
#
# What is legitimately a literal, and therefore allow-listed below:
#   * the registry's own seed / catalog / pricing files
#   * each byte-copied loader's LITERAL_* fallback constant (the last resort when
#     S3 is unreadable — a hub with no registry must still boot)
#   * the env-fallback layer in the deploy scripts (DD4: `--env X=${X:-<literal>}`
#     in bash, `os.environ.get("X", <literal>)` in Python)
#   * prose — a comment, docstring, help text or prompt example
# Everything else is a resolution path and must go through the registry.
#
# Every ALLOW entry carries a one-line reason. An entry may be:
#   path/               a directory prefix
#   path                the whole file
#   path:12             ONLY line 12 of that file
#   path:12-20          ONLY lines 12..20
#   path:/ERE/          ONLY lines matching the extended regex
# The `/ERE/` form exists because pinning line numbers inside a 4600-line
# main.py would redden CI on any unrelated edit above them; it pins the *shape*
# of the allowed line (an env fallback, a comment) instead of its position.
#
# A passing run also prints a WARN list of allow entries that cover nothing on
# this tree (path gone, or the literal removed) — warn-only, because an entry for
# a file a sibling branch adds or deletes is legitimately dead here.
#
# No AWS, no network, pure text — same shape as scripts/check-cd-registry-parity.sh.
# `--self-test` runs the whole check over a temp tree with one planted literal and
# fails if the guard passed: a guard nobody proved can fail is not a guard.
set -uo pipefail
cd "$(dirname "$0")/.."

PATTERN='us\.anthropic\.claude-|global\.anthropic\.claude-|anthropic\.claude-|us\.openai\.gpt-|openai\.gpt-'

# Docs, blueprints, tests, evals and fixtures are exempt by construction: they
# describe or exercise model ids, they never resolve one at runtime.
EXCLUDE_GLOBS=(
  'docs/*' '*/docs/*'
  'blueprints/*'
  'tests/*' '*/tests/*'
  'evals/*' '*/evals/*'
  '*.md'
  '*.test.ts' '*.test.tsx' '*.test.mjs'
  'test_*.py' '*/test_*.py'
  '__tests__/*' '*/__tests__/*'
  'fixtures/*' '*/fixtures/*'
)

ALLOW=(
  # ── the registry itself ─────────────────────────────────────────────────────
  # The seed of the live document: the catalog IS the list of model ids.
  'src/config/models.json'
  # Per-model rates. Keyed by model id by definition; refreshed by the reconcile.
  'src/config/pricing.json'
  # The shared registry case fixture (TEAM-4997) — test data for all four loaders.
  'src/config/__fixtures__/'

  # ── the five loaders: LITERAL_* last-resort constants + prose ───────────────
  # The TS canonical's compiled-in floors — the same last-resort constants the two
  # Python and two mjs twins carry: a hub that cannot read S3 must still boot.
  'src/lib/models-registry.ts:/^export const LITERAL_[A-Z_]+ = /'
  # Python twins: LITERAL_PERSONA / LITERAL_CODING_CLAUDE / LITERAL_CODING_CODEX.
  'deploy/runtime-agent/models_registry.py:/^LITERAL_[A-Z_]+ = /'
  'deploy/coding-agent-runtime/models_registry.py:/^LITERAL_[A-Z_]+ = /'
  # ...and the two-endpoint explanation in resolve_coding_model's docstring.
  'deploy/runtime-agent/models_registry.py:/^\s*(#|`|Runtime serves|\*)/'
  'deploy/coding-agent-runtime/models_registry.py:/^\s*(#|`|Runtime serves|\*)/'
  # mjs canonical + twins: the same three constants, plus the jsdoc that documents
  # the two endpoints and the id-parsing rules (`us.anthropic.claude-opus-5 -> vendor …`).
  'src/lib/models/models-registry.mjs:/^export const LITERAL_[A-Z_]+ = /'
  'lambda/token-aggregator/models-registry.mjs:/^export const LITERAL_[A-Z_]+ = /'
  'deploy/telegram-bug-intake/models-registry.mjs:/^export const LITERAL_[A-Z_]+ = /'
  'src/lib/models/models-registry.mjs:/^\s*\*/'
  'lambda/token-aggregator/models-registry.mjs:/^\s*\*/'
  'deploy/telegram-bug-intake/models-registry.mjs:/^\s*\*/'

  # ── the env-fallback layer (DD4) ────────────────────────────────────────────
  # The fleet runtime's one allowed literal: the MODEL_ID env tail, which
  # resolve_agent_model() falls through to when there is no registry.
  'deploy/runtime-agent/main.py:/^MODEL_ID = os\.getenv/'
  # Comments in the codex config block naming the two endpoints' id shapes, and
  # the invoke docstring's payload example.
  'deploy/runtime-agent/main.py:/^\s*#/'
  # The coding runtime's CLAUDE_MODEL / CODEX_MODEL env tails.
  'deploy/coding-agent-runtime/main.py:/os\.environ\.get\(/'
  'deploy/coding-agent-runtime/main.py:/^\s*"CLAUDE_MODEL", /'
  # The env-fallback tails on the create/update calls: the runtime reads the
  # registry at the point of use, but a runtime created before the registry
  # existed still needs a model, so a deploy script passes one as the LAST resort
  # under an env override. Shape-pinned rather than whole-file (TEAM-5023): the
  # entry now enforces the shape the reason claims — `--env NAME=${NAME:-<literal>}`
  # in bash, `os.environ.get("NAME", "<literal>")` in Python — instead of blessing
  # any literal these four files ever grow. deploy-fleet.sh holds MODEL_ID only to
  # print it in the banner, and exports it for the child deploy-one.sh /
  # deploy-one-robust.py, so banner and baked value cannot drift.
  'deploy/runtime-agent/deploy-one.sh:/"[A-Z_]+=\$\{[A-Z_]+:-/'
  'deploy/runtime-agent/deploy-one-robust.py:/os\.environ\.get\("[A-Z_]+", "/'
  'deploy/runtime-agent/deploy-fleet.sh:/^MODEL_ID="\$\{MODEL_ID:-/'
  'deploy/coding-agent-runtime/deploy.py:/os\.environ\.get\("[A-Z_]+", "/'
  # Both remaining hits are comments explaining which endpoint serves which id
  # shape; the model id itself now arrives via `models_registry.py --export`.
  'deploy/coding-agent-runtime/run-codex.sh:/^#/'
  'deploy/coding-agent-runtime/merge-codex-config.py:/^\s*(#|bedrock-)/'
  # The Telegram bridge's literal tail behind resolveAgentModel(reg,"telegram_intake").
  'deploy/telegram-bug-intake/index.mjs:/^const MODEL_ID_FALLBACK = /'
  # The three setup scripts: LITERAL_MODEL_ID is the tail of registry -> pin ->
  # default -> literal, and the `--model-id` usage examples are help text.
  'deploy/setup-builder-agent.mjs:/^const LITERAL_MODEL_ID = /'
  'deploy/workflow-manager/setup-workflow-manager.mjs:/(^const LITERAL_MODEL_ID = | \* |^\/\/ )/'
  'deploy/routine-builder/setup-routine-builder.mjs:/(^const LITERAL_MODEL_ID = | \* )/'
  # The Workflow Manager toolkit runs in the harness container, which does not
  # ship the Python twin; MODEL_ID env with a literal tail is all it has.
  'deploy/workflow-manager/toolkit/save_analysis.py:/^MODEL_ID = os\.environ\.get/'

  # ── prose: comments, help text, prompt copy ────────────────────────────────
  # REPORT_VERSION history comment (which model was repriced at which version).
  'lambda/cost-report/index.mjs:/^\/\//'
  # CARD_MIN_REPORT_VERSION comment, same history.
  'deploy/workflow-manager/toolkit/compute_metrics.py:/^\s*#/'
  # `--model` help text example on the fleet invoke verifier.
  'deploy/runtime-agent/verify-fleet-invoke.py:/help=/'
  # A hand-run local A/B harness: its variants ARE two specific model ids, which
  # is the point of an A/B — it never resolves a tier.
  'deploy/runtime-agent/local-ab-test.py'
  # A standalone streaming-test runtime, deployed by hand, outside the fleet.
  'deploy/runtime-agent/test-streaming/'
  # Judge/evaluator configs: AgentCore evaluation resources, created by hand from
  # these documents; the registry does not own evaluation judges.
  'deploy/evaluations/'
  # The builder's prompt copy is now generated: the create_harness example prints
  # the resolved MODEL_ID and the "models you may pin" bullets are a projection of
  # the catalog (pinnableModelsCopy). What is left is the tail it falls back to
  # when config/models.json is unreadable — a named constant, like LITERAL_MODEL_ID.
  'deploy/setup-builder-agent.mjs:/^const LITERAL_PINNABLE_MODEL_IDS = /'
  # Static /pipeline diagram copy (a display string in a fixed illustration).
  'src/lib/pipeline-config.ts:/{ key: "Model", val:/'
  # Prose: the discovery sweep's jsdoc explaining why the eval judge's bare
  # foundation-model id must not be retired on absence (it is not a profile).
  'src/lib/models/discovery.ts:/^\s*\*/'
  # Prose: shortModelId's jsdoc names a full id to contrast with the short form.
  'src/lib/model-label.ts:/^\s*\*/'
  # Prose: the card report-version history (which model was repriced at which
  # version) trails CURRENT_REPORT_VERSION on the same line.
  'src/lib/workflow/performance.ts:/^export const CURRENT_REPORT_VERSION = /'
  # Prose: an id-shortening comment, a spans jsdoc, and one tool-schema
  # `description` example. Display/help text on read paths, never a resolution.
  'src/app/api/agentcore/traces/route.ts:/^\s*\/\//'
  'src/app/api/agentcore/metrics/route.ts:/^\s*\*/'
  'src/lib/agentcore-sdk.ts:/description: "Bedrock model ID/'
  # The builder-tools source has no deploy surface and no invoker — no deploy.sh
  # in the directory, surfaces.json records "No deployed function", and the one
  # BUILDER_TOOLS_LAMBDA mention is an unread env default (proof quoted at the
  # constant). So its create_harness default is a named LITERAL floor, the same
  # shape the five loaders and the three setup scripts use, not a resolution.
  'lambda/builder-tools/index.mjs:/^const LITERAL_MODEL_ID = /'

  # This guard's own prose and --self-test fixtures: comments explaining WHY a
  # literal is allowed elsewhere, and planted strings it writes into a temp dir
  # to prove itself. Neither resolves a model at runtime.
  'scripts/check-model-surface.sh'
)

# ─── core check ───────────────────────────────────────────────────────────────

path_excluded() { # $1 = repo-relative path
  local p="$1" g
  for g in "${EXCLUDE_GLOBS[@]}"; do
    # shellcheck disable=SC2254
    case "$p" in $g) return 0 ;; esac
  done
  return 1
}

file_list() { # $1 = root — tracked files if it is a repo, every file otherwise
  local root="$1"
  if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$root" ls-files
  else
    ( cd "$root" && find . -type f | sed 's|^\./||' )
  fi
}

collect_hits() { # $1 = root; stdin = paths; stdout = path:line:text
  local root="$1" f
  while IFS= read -r f; do
    path_excluded "$f" && continue
    [ -f "$root/$f" ] || continue
    grep -nE "$PATTERN" "$root/$f" 2>/dev/null | sed "s|^|$f:|"
  done
}

entry_covers() { # $1 = entry, $2 = path, $3 = line no, $4 = line text
  local entry="$1" p="$2" n="$3" text="$4" spec where start end
  case "$entry" in
    # /ERE/ first: a regex entry also ends in `/`, so it must not be read as a
    # directory prefix.
    *:/*/)
      spec="${entry%%:/*}"; where="${entry#*:/}"; where="${where%/}"
      [ "$spec" = "$p" ] && printf '%s' "$text" | grep -qE "$where" && return 0 ;;
    */) [ "${p#"$entry"}" != "$p" ] && return 0 ;;
    *:[0-9]*-[0-9]*)
      spec="${entry%%:*}"; where="${entry##*:}"
      start="${where%%-*}"; end="${where##*-}"
      [ "$spec" = "$p" ] && [ "$n" -ge "$start" ] && [ "$n" -le "$end" ] && return 0 ;;
    *:[0-9]*)
      spec="${entry%%:*}"; where="${entry##*:}"
      [ "$spec" = "$p" ] && [ "$n" -eq "$where" ] && return 0 ;;
    *) [ "$entry" = "$p" ] && return 0 ;;
  esac
  return 1
}

hit_allowed() { # $1 = path, $2 = line no, $3 = line text
  local entry
  for entry in "${ALLOW[@]}"; do
    [ -n "$entry" ] || continue
    entry_covers "$entry" "$1" "$2" "$3" && return 0
  done
  return 1
}

entry_path() { # $1 = entry — the path part, whatever the pin form
  case "$1" in
    *:/*/) printf '%s' "${1%%:/*}" ;;
    */)    printf '%s' "$1" ;;
    *:[0-9]*-[0-9]*|*:[0-9]*) printf '%s' "${1%%:*}" ;;
    *)     printf '%s' "$1" ;;
  esac
}

run_check() { # $1 = root — 0 = clean, 1 = an unallowed literal exists
  local root="$1" hit p n text bad=0
  while IFS= read -r hit; do
    p="${hit%%:*}"; hit="${hit#*:}"
    n="${hit%%:*}"; text="${hit#*:}"
    if ! hit_allowed "$p" "$n" "$text"; then
      [ "$bad" -eq 0 ] && echo "FAIL: model id literal outside the registry" >&2
      bad=$((bad + 1))
      printf '  %s:%s: %s\n' "$p" "$n" "$(printf '%s' "$text" | cut -c1-120)" >&2
    fi
  done < <(file_list "$root" | collect_hits "$root")
  [ "$bad" -eq 0 ]
}

# ─── stale-entry report (WARN only, never changes the exit code) ───────────────
#
# hit_allowed() is consulted only when a hit is found, so an entry for a path
# that no longer exists — or one whose literal was removed — sits in the list
# forever, silently widening the allow surface for whatever lands at that path
# next. This reports them. Warn-only on purpose: entries covering a file a
# sibling branch adds or deletes are legitimately dead on THIS tree, and CI must
# not go red because another branch has not merged yet.
stale_report() { # $1 = root
  local root="$1" entry spec hits hit p n text covered absent=() dead=()
  hits="$(file_list "$root" | collect_hits "$root")"
  for entry in "${ALLOW[@]}"; do
    [ -n "$entry" ] || continue
    spec="$(entry_path "$entry")"
    case "$spec" in
      */) [ -d "$root/$spec" ] || { absent+=("$entry"); continue; } ;;
      *)  [ -f "$root/$spec" ] || { absent+=("$entry"); continue; } ;;
    esac
    covered=0
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      p="${hit%%:*}"; hit="${hit#*:}"; n="${hit%%:*}"; text="${hit#*:}"
      case "$spec" in
        */) [ "${p#"$spec"}" != "$p" ] || continue ;;
        *)  [ "$p" = "$spec" ] || continue ;;
      esac
      if entry_covers "$entry" "$p" "$n" "$text"; then covered=1; break; fi
    done <<< "$hits"
    [ "$covered" -eq 1 ] || dead+=("$entry")
  done
  [ "${#absent[@]}" -eq 0 ] && [ "${#dead[@]}" -eq 0 ] && return 0
  echo "  WARN: allow entries that nothing needs on this tree — delete them, or say"
  echo "        in the reason which branch re-creates the literal they cover:"
  for entry in "${absent[@]}"; do echo "        path gone   $entry"; done
  for entry in "${dead[@]}";   do echo "        no hits     $entry"; done
}

# ─── --self-test: the guard must catch a planted literal ──────────────────────

self_test() {
  local tmp pass=0 fail=0
  echo "self-test: planting literals in a temp tree; each MUST make the guard fail"

  # 1. a planted literal in a file nothing allows
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/lambda/somewhere"
  printf 'const m = "us.anthropic.claude-opus-5";\n' > "$tmp/lambda/somewhere/index.mjs"
  if run_check "$tmp" >/dev/null 2>&1; then
    echo "  SELF-TEST FAIL: guard passed with a planted literal" >&2; fail=$((fail + 1))
  else
    echo "  ok — caught: planted literal in an unallowed file"; pass=$((pass + 1))
  fi

  # 2. ...and it is NOT caught once the file is allow-listed (no false positives)
  ALLOW+=("lambda/somewhere/index.mjs")
  if run_check "$tmp" >/dev/null 2>&1; then
    echo "  ok — allow-listed file passes"; pass=$((pass + 1))
  else
    echo "  SELF-TEST FAIL: allow-listed file still failed" >&2; fail=$((fail + 1))
  fi
  ALLOW=("${ALLOW[@]/lambda\/somewhere\/index.mjs/}")

  # 3. a :line entry covers ONLY that line
  printf 'ok\nconst a = "openai.gpt-5.5";\nconst b = "openai.gpt-5.5";\n' \
    > "$tmp/lambda/somewhere/index.mjs"
  ALLOW+=("lambda/somewhere/index.mjs:2")
  if run_check "$tmp" >/dev/null 2>&1; then
    echo "  SELF-TEST FAIL: a :2 entry also covered line 3" >&2; fail=$((fail + 1))
  else
    echo "  ok — caught: :line entry does not cover a second line"; pass=$((pass + 1))
  fi

  # 4. docs/tests are exempt by construction
  rm -f "$tmp/lambda/somewhere/index.mjs"
  mkdir -p "$tmp/docs" "$tmp/src/lib"
  printf 'us.anthropic.claude-opus-5\n' > "$tmp/docs/note.md"
  printf 'const m = "us.anthropic.claude-opus-5";\n' > "$tmp/src/lib/thing.test.ts"
  if run_check "$tmp" >/dev/null 2>&1; then
    echo "  ok — docs and *.test.ts are exempt"; pass=$((pass + 1))
  else
    echo "  SELF-TEST FAIL: an exempt path was reported" >&2; fail=$((fail + 1))
  fi

  rm -rf "$tmp"
  echo "self-test: $pass ok, $fail missed"
  [ "$fail" -eq 0 ]
}

if [ "${1:-}" = "--self-test" ]; then
  self_test || { echo "" >&2; echo "model-surface guard SELF-TEST FAILED" >&2; exit 1; }
  exit 0
fi

if ! run_check "."; then
  echo "" >&2
  echo "Model ids live in ONE document (config/models.json, DL-033). Resolve the" >&2
  echo "model where it is used — resolve_model / resolveAgentModel / resolve_coding_model" >&2
  echo "in the registry loader — or, for a deploy script, pass it as an env fallback" >&2
  echo "(\${VAR:-<literal>}). If the literal really is prose or test data, add it to" >&2
  echo "ALLOW in scripts/check-model-surface.sh WITH A ONE-LINE REASON." >&2
  echo "" >&2
  echo "Model-surface guard FAILED (scripts/check-model-surface.sh)" >&2
  exit 1
fi

echo "model-surface guard: OK"
echo "  pattern = anthropic.claude-* / openai.gpt-* ids in tracked, non-doc, non-test files"
echo "  allowed = ${#ALLOW[@]} entries, each with a reason (registry files, LITERAL_* tails, env fallbacks, prose)"
stale_report "."
