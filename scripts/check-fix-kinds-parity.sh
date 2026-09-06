#!/usr/bin/env bash
# ─── FIX_KINDS parity guard (TEAM-4121 FR-8) ──────────────────────────────────
#
# The set of fix-ticket kinds is duplicated across SEVEN places that CANNOT
# import each other:
#
#   1. lambda/orchestrator/fix-contract.mjs        FIX_KINDS  (the source of truth)
#   2. lambda/agentcore-hub-tickets/fix-contract.mjs   byte-identical copy
#   3. lambda/agentcore-hub-jira/fix-contract.mjs      byte-identical copy
#   4. lambda/orchestrator/completion.mjs          FIX_KINDS  (open-fix gate)
#   5. src/lib/workflow/types.ts                   spawnedBy.kind union (UI/API)
#   6. deploy/runtime-agent/main.py                the origin-key map (harness)
#   7. deploy/workflow-manager/toolkit/compute_metrics.py
#                                    FIX_KINDS + KIND_TO_ORIGIN_KEY (TEAM-4130 F3)
#
# Each ticket Lambda ships as a self-contained zip, so the module is copied
# rather than shared; completion.mjs keeps a literal Set so it stays loadable in
# isolation; types.ts is TypeScript, main.py and compute_metrics.py are Python
# (and compute_metrics.py ships to a container with no lambda/ dir, so it cannot
# import even the other Python copy). Every one of these is a place a kind can be
# forgotten — and a forgotten kind fails SILENTLY: the ticket is created but the
# completion gate stops waiting on it, the harness drops the origin id and the fix
# has no lineage, or the delivery metrics under-count a whole class of rework.
#
# This guard normalizes every kind list to a sorted set and fails on ANY
# difference. It also (a) byte-compares the three fix-contract.mjs copies (cmp),
# the only thing keeping the duplicated module from drifting, and (b) compares the
# kind -> originKey MAPPING (not just its key set) across the three places that
# carry one — fix-contract.mjs, compute_metrics.py and main.py — because a kind
# pointed at the wrong origin key is as silent as a missing kind.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# ─── 1. the three fix-contract.mjs copies must be byte-identical ──────────────
CANON="lambda/orchestrator/fix-contract.mjs"
for copy in lambda/agentcore-hub-tickets/fix-contract.mjs lambda/agentcore-hub-jira/fix-contract.mjs; do
  if [ ! -f "$copy" ]; then
    echo "FAIL: missing fix-contract.mjs copy: $copy" >&2
    fail=1
  elif ! cmp -s "$CANON" "$copy"; then
    echo "FAIL: $copy is not byte-identical to $CANON" >&2
    echo "      fix-contract.mjs is a zero-import module duplicated per Lambda zip." >&2
    echo "      Edit ONE copy, then: cp $CANON $copy" >&2
    diff <(cat "$CANON") <(cat "$copy") | head -20 >&2 || true
    fail=1
  fi
done

# ─── 2. the kind lists must agree ─────────────────────────────────────────────
# Each extractor prints the kinds it found, one per line. Empty output = the
# pattern stopped matching (a refactor moved/renamed the literal), which is
# itself a failure — a silently-empty list would make every set "agree".
extract_mjs_fix_kinds() {  # FIX_KINDS = ["a","b"] or new Set(["a","b"])
  sed -n 's/.*FIX_KINDS *= *\(new Set(\)\?\[\([^]]*\)\].*/\2/p' "$1" \
    | head -1 | tr ',' '\n' | sed 's/[^a-z_]//g' | grep -v '^$' || true
}

extract_ts_union() {  # kind: "a" | "b" | "c";
  sed -n 's/^ *kind: *\(".*"\);$/\1/p' "$1" \
    | head -1 | tr '|' '\n' | sed 's/[^a-z_]//g' | grep -v '^$' || true
}

extract_py_origin_map() {  # the "<kind>": "<originKey>" map inside create_ticket
  # $2 = "pairs" prints `kind=originKey` instead of just the kinds (TEAM-4130 F3).
  python3 - "$1" "${2:-keys}" <<'PY' || true
import ast, sys

src = open(sys.argv[1]).read()
pairs = sys.argv[2] == "pairs"
tree = ast.parse(src)
fn = next(
    (n for n in tree.body
     if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
     and n.name == "Tickets___create_ticket"),
    None,
)
if fn is None:
    sys.exit(0)  # empty output → the caller fails
# the dict literal whose values are all *TicketId keys is the origin map
for node in ast.walk(fn):
    if not isinstance(node, ast.Dict) or not node.keys:
        continue
    vals = [v.value for v in node.values if isinstance(v, ast.Constant) and isinstance(v.value, str)]
    if len(vals) == len(node.values) and vals and all(v.endswith("TicketId") for v in vals):
        for k, v in zip(node.keys, node.values):
            if isinstance(k, ast.Constant) and isinstance(k.value, str):
                print(f"{k.value}={v.value}" if pairs else k.value)
        break
PY
}

extract_py_literal() {  # module-level NAME = (...)/[...]/{...} of string constants
  python3 - "$1" "$2" <<'PY' || true
import ast, sys

src, name = open(sys.argv[1]).read(), sys.argv[2]
for node in ast.parse(src).body:
    if not isinstance(node, ast.Assign):
        continue
    if not any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
        continue
    v = node.value
    if isinstance(v, ast.Dict):                      # the map: print its KEYS
        elts = v.keys
    elif isinstance(v, (ast.Tuple, ast.List, ast.Set)):
        elts = v.elts
    else:
        break
    for e in elts:
        if isinstance(e, ast.Constant) and isinstance(e.value, str):
            print(e.value)
    break
PY
}

extract_py_dict_pairs() {  # module-level NAME = {...} → sorted `key=value` pairs
  python3 - "$1" "$2" <<'PY' || true
import ast, sys

src, name = open(sys.argv[1]).read(), sys.argv[2]
for node in ast.parse(src).body:
    if not isinstance(node, ast.Assign):
        continue
    if not any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
        continue
    if isinstance(node.value, ast.Dict):
        for k, val in zip(node.value.keys, node.value.values):
            if isinstance(k, ast.Constant) and isinstance(val, ast.Constant):
                print(f"{k.value}={val.value}")
    break
PY
}

extract_mjs_origin_pairs() {  # fix-contract.mjs KIND_TO_ORIGIN_KEY → `key=value`
  # fix-contract.mjs is a zero-import ESM module, so importing it is both exact
  # and cheaper than re-parsing the literal with sed.
  node --input-type=module -e '
    const m = await import(process.argv[1]);
    for (const [k, v] of Object.entries(m.KIND_TO_ORIGIN_KEY || {})) console.log(`${k}=${v}`);
  ' "$PWD/$1" 2>/dev/null || true
}

# NOTE: `grep -v` exits 1 on empty input, and under `set -euo pipefail` that
# killed the script inside add_source's command substitution BEFORE its "extracted
# NO fix kinds" diagnostic could print — an extractor that had rotted failed the
# guard, but silently. Swallowing only grep's status keeps the failure loud.
normalize() { tr ' ' '\n' | { grep -v '^$' || true; } | sort -u | paste -sd, -; }

declare -a NAMES=()
declare -a KINDS=()

add_source() {  # name, newline-separated kinds
  local name="$1" raw="$2" norm
  norm="$(printf '%s\n' "$raw" | normalize)"
  if [ -z "$norm" ]; then
    echo "FAIL: extracted NO fix kinds from $name — the literal moved or was renamed." >&2
    echo "      Update the extractor in scripts/check-fix-kinds-parity.sh." >&2
    fail=1
    return
  fi
  NAMES+=("$name")
  KINDS+=("$norm")
}

add_source "$CANON (FIX_KINDS)"                          "$(extract_mjs_fix_kinds "$CANON")"
add_source "lambda/orchestrator/completion.mjs (FIX_KINDS)" \
  "$(extract_mjs_fix_kinds lambda/orchestrator/completion.mjs)"
add_source "src/lib/workflow/types.ts (spawnedBy.kind)"  "$(extract_ts_union src/lib/workflow/types.ts)"
add_source "deploy/runtime-agent/main.py (origin map)"   "$(extract_py_origin_map deploy/runtime-agent/main.py)"
# TEAM-4130 F3: the delivery-metrics toolkit keeps BOTH literals, and they are
# independently forgettable — FIX_KINDS decides what counts as rework at all,
# KIND_TO_ORIGIN_KEY decides which ticket a round is attributed to. Registered as
# two sources so an empty extraction from either one fails loudly (add_source).
METRICS_PY="deploy/workflow-manager/toolkit/compute_metrics.py"
add_source "$METRICS_PY (FIX_KINDS)"          "$(extract_py_literal "$METRICS_PY" FIX_KINDS)"
add_source "$METRICS_PY (KIND_TO_ORIGIN_KEY)" "$(extract_py_literal "$METRICS_PY" KIND_TO_ORIGIN_KEY)"

if [ "${#KINDS[@]}" -gt 0 ]; then
  expected="${KINDS[0]}"
  for i in "${!KINDS[@]}"; do
    if [ "${KINDS[$i]}" != "$expected" ]; then
      echo "FAIL: fix-kind set differs between locations:" >&2
      echo "      ${NAMES[0]}: $expected" >&2
      echo "      ${NAMES[$i]}: ${KINDS[$i]}" >&2
      fail=1
    fi
  done
fi

# ─── 3. the kind -> originKey MAP must agree where it is carried ───────────────
# A kind present everywhere but pointed at the wrong origin key is just as silent
# as a missing one: the fix ticket is created, and its lineage points at nothing.
map_contract="$(extract_mjs_origin_pairs "$CANON" | normalize)"
map_metrics="$(extract_py_dict_pairs "$METRICS_PY" KIND_TO_ORIGIN_KEY | normalize)"
map_harness="$(extract_py_origin_map deploy/runtime-agent/main.py pairs | normalize)"
declare -a MAP_NAMES=("$CANON (KIND_TO_ORIGIN_KEY)" "$METRICS_PY (KIND_TO_ORIGIN_KEY)" "deploy/runtime-agent/main.py (origin map)")
declare -a MAPS=("$map_contract" "$map_metrics" "$map_harness")
for i in "${!MAPS[@]}"; do
  if [ -z "${MAPS[$i]}" ]; then
    echo "FAIL: extracted NO kind=originKey pairs from ${MAP_NAMES[$i]} — the literal moved or was renamed." >&2
    echo "      Update the extractor in scripts/check-fix-kinds-parity.sh." >&2
    fail=1
  elif [ "${MAPS[$i]}" != "$map_contract" ]; then
    echo "FAIL: kind -> originKey map differs between locations:" >&2
    echo "      ${MAP_NAMES[0]}: $map_contract" >&2
    echo "      ${MAP_NAMES[$i]}: ${MAPS[$i]}" >&2
    fail=1
  fi
done

# ─── 4. the REWORK subset must agree, and must be a real subset ───────────────
extract_rework() {
  sed -n 's/.*REWORK_FIX_KINDS *= *\(new Set(\)\?\[\([^]]*\)\].*/\2/p' "$1" \
    | head -1 | tr ',' '\n' | sed 's/[^a-z_]//g' | grep -v '^$' | sort -u | paste -sd, - || true
}
rw_contract="$(extract_rework "$CANON")"
rw_completion="$(extract_rework lambda/orchestrator/completion.mjs)"
if [ -z "$rw_contract" ] || [ -z "$rw_completion" ]; then
  echo "FAIL: could not extract REWORK_FIX_KINDS from fix-contract.mjs and/or completion.mjs" >&2
  fail=1
elif [ "$rw_contract" != "$rw_completion" ]; then
  echo "FAIL: REWORK_FIX_KINDS differs: fix-contract.mjs=$rw_contract completion.mjs=$rw_completion" >&2
  fail=1
else
  # every rework kind must also be a fix kind
  for k in ${rw_contract//,/ }; do
    case ",${KINDS[0]}," in
      *",$k,"*) ;;
      *) echo "FAIL: REWORK_FIX_KINDS member '$k' is not in FIX_KINDS (${KINDS[0]})" >&2; fail=1 ;;
    esac
  done
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "fix-kinds parity guard FAILED — add/remove the kind in ALL locations listed" >&2
  echo "at the top of scripts/check-fix-kinds-parity.sh, then re-run." >&2
  exit 1
fi

echo "fix-kinds parity guard: OK"
echo "  FIX_KINDS        = ${KINDS[0]}  (${#KINDS[@]} locations in agreement)"
echo "  REWORK_FIX_KINDS = $rw_contract"
echo "  origin-key map   = $map_contract  (${#MAPS[@]} locations in agreement)"
echo "  fix-contract.mjs = 3 byte-identical copies"
