#!/usr/bin/env bash
# ─── Workflow-table write guard (R2 — docs/race-condition-study.md) ───────────
#
# The workflows table may only be written through lambda/orchestrator/
# workflow-store.mjs (scoped conditional writes). Full-row puts and ad-hoc
# UpdateCommands against it resurrect stale snapshots over concurrent scoped
# writes — the read-modify-write clobber class that caused most workflow races.
#
# This scan fails CI when orchestrator code outside the store touches the
# workflows table with a write command. It covers EVERY lambda/orchestrator/
# *.mjs (tests excluded), so a new module can't dodge the guard by not being
# on a hardcoded list, and it keys on both the WORKFLOWS_TABLE binding and
# workflowsTable-style parameters (lease.mjs receives the table name as an
# argument). One narrow allowlist exists: lease.mjs's stealClaim CAS — the
# mandated R3 primitive (never re-implemented in the store). lease.mjs must
# contain EXACTLY that one write; any extra hit there fails too.
#
# Next.js API routes are exempted only where their writes are already scoped +
# conditional; new routes must use scoped conditional writes too (reviewed via
# this list).
set -euo pipefail
cd "$(dirname "$0")/.."

# Orchestrator Lambda: zero write commands on the workflows table outside the
# store, except lease.mjs's single allowlisted stealClaim write.
if ! python3 - <<'EOF'
import glob, re, sys

WRITE_CMD = re.compile(r"new (?:Put|Update|Delete|BatchWrite|TransactWrite)Command\s*\(")
# The workflows table shows up either as the WORKFLOWS_TABLE env binding or a
# workflowsTable-style parameter/variable; tickets/events tables never match.
TABLE_REF = re.compile(r"TableName\s*:\s*[^,\n]*workflows?_?table", re.I)
# lease.mjs allowlist: the stealClaim CAS is identified by its exact
# UpdateExpression — anything else that writes the workflows table fails.
STEAL_MARK = "SET agentTasks.#tid.#st = :ready"

def command_body(src, open_paren):
    """Source between the command's balanced parens (open_paren at '(')."""
    depth = 0
    for i in range(open_paren, len(src)):
        if src[i] == "(":
            depth += 1
        elif src[i] == ")":
            depth -= 1
            if depth == 0:
                return src[open_paren + 1 : i]
    return src[open_paren + 1 :]

fail = False
for f in sorted(glob.glob("lambda/orchestrator/*.mjs")):
    name = f.rsplit("/", 1)[-1]
    if name == "workflow-store.mjs" or name.endswith(".test.mjs"):
        continue
    src = open(f).read()
    hits = []  # (line, body) of write commands whose args name the workflows table
    for m in WRITE_CMD.finditer(src):
        body = command_body(src, m.end() - 1)
        if TABLE_REF.search(body):
            hits.append((src[: m.start()].count("\n") + 1, body))
    if name == "lease.mjs":
        if len(hits) == 1 and STEAL_MARK in hits[0][1]:
            continue
        print(f"FAIL: {f} must contain exactly ONE workflows-table write — "
              f"stealClaim's CAS ('{STEAL_MARK}') — but found "
              f"{len(hits)} (lines: {' '.join(str(l) for l, _ in hits) or 'none'}). "
              "New lease writes need an explicit allowlist review here.")
        fail = True
        continue
    if hits:
        lines = " ".join(str(l) for l, _ in hits)
        print(f"FAIL: {f} writes the workflows table outside workflow-store.mjs (lines: {lines})")
        fail = True

sys.exit(1 if fail else 0)
EOF
then
  echo ""
  echo "Route all workflows-table writes through lambda/orchestrator/workflow-store.mjs."
  exit 1
fi
echo "workflow-write guard: OK"
