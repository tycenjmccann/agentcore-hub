/**
 * Item 4 probe — drive the REAL selectFixBeforeVerifyTargets with the REAL
 * vendored c2uqki dossier tickets, at the two moments the acceptance item names.
 *
 * Acceptance item 4:
 *   "TEAM-4232 (QA) does not start until TEAM-4241 completes; TEAM-4233 (CI) not
 *    until TEAM-4242 completes; CI observes no mid-run head move (16fc41d -> 73f0056)."
 *
 * The historical run (fixture narrative, c2uqki-analysis.json):
 *   TEAM-4241 12:30:16-12:44:26Z  overlapped QA TEAM-4232 12:30:58-12:55:09Z
 *   TEAM-4242 12:53:27-13:01:12Z  overlapped CI TEAM-4233 12:55:09-13:17:38Z
 *   "CI observed head 16fc41d->73f0056 mid-run and re-ran the full suite."
 *
 * No stubs: verdict-contract.mjs is a zero-import leaf module.
 */
import { readFileSync } from "node:fs";
import {
  selectFixBeforeVerifyTargets,
  FIX_BEFORE_VERIFY_PERSONAS,
} from "../../../lambda/orchestrator/verdict-contract.mjs";

const dossier = JSON.parse(
  readFileSync(
    new URL(
      "../../../deploy/workflow-manager/toolkit/fixtures/c2uqki-dossier.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const byId = new Map(dossier.tickets.map((t) => [t.ticketId, t]));
const ts = (s) => Date.parse(s);

// The production caller injects (kind) => FIX_KINDS.has(kind).
const isFixKind = (k) =>
  ["review_fix", "qa_fix", "ci_fix", "ship_fix", "sync_fix", "codex_fix"].includes(k);
const isAdvisory = () => false;
const phaseOf = () => null;

console.log("=== item-4.0  FIX_BEFORE_VERIFY_PERSONAS (real Set) ===");
console.log("  " + [...FIX_BEFORE_VERIFY_PERSONAS].join("\n  "));

console.log("\n=== item-4.1  the real c2uqki board, as vendored ===");
for (const t of dossier.tickets) {
  console.log(
    `  ${t.ticketId.padEnd(9)} ${String(t.assignee).padEnd(38)} created=${t.createdAt} done=${t.updatedAt} blockedBy=${JSON.stringify(t.blockedBy)}`,
  );
}

/**
 * Rebuild the board as it stood the instant a fix ticket was INSERTed, using only
 * fixture timestamps: a verifier is "open" if it had been created but not yet
 * finished at that moment.
 */
function boardAt(instantIso) {
  const at = ts(instantIso);
  return dossier.tickets
    .filter((t) => t.ticketId !== "TEAM-4228" && ts(t.createdAt) <= at)
    .map((t) => ({
      ticketId: t.ticketId,
      assignee: t.assignee,
      status: ts(t.updatedAt) <= at ? "done" : "in_progress",
      blockedBy: t.blockedBy || [],
    }));
}

const CASES = [
  { fixId: "TEAM-4241", kind: "codex_fix", expectVerifier: "TEAM-4232 (QA)" },
  { fixId: "TEAM-4242", kind: "qa_fix", expectVerifier: "TEAM-4233 (CI)" },
];

let allBlocked = true;
for (const c of CASES) {
  const fix = byId.get(c.fixId);
  const siblings = boardAt(fix.createdAt);
  console.log(
    `\n=== item-4.2  ${c.fixId} (${c.kind}) INSERTed at ${fix.createdAt} — board snapshot ===`,
  );
  for (const s of siblings) {
    console.log(`    ${s.ticketId.padEnd(9)} ${s.assignee.padEnd(38)} ${s.status}`);
  }
  // isFixKind is applied to the TARGET's own spawnedBy.kind (line 318, the cycle
  // guard) — NOT to the incoming fix's kind. Pass the real FIX_KINDS predicate.
  const targets = selectFixBeforeVerifyTargets({
    fixId: c.fixId,
    siblings,
    isFixKind,
    isAdvisory,
    phaseOf,
  });
  const ids = (targets || []).map((t) => t.ticketId ?? t).sort();
  console.log(`  selectFixBeforeVerifyTargets -> ${JSON.stringify(ids)}`);
  console.log(`  acceptance names ${c.expectVerifier} as the verifier to hold`);
  const want = c.expectVerifier.split(" ")[0];
  const got = ids.includes(want);
  if (!got) allBlocked = false;
  console.log(`  ${want} in targets? -> ${got ? "YES (blocked at creation)" : "NO"}`);
}

console.log("\n=== item-4.2b  the vendored tickets carry NO spawnedBy field ===");
for (const id of ["TEAM-4241", "TEAM-4242"]) {
  console.log(`  ${id}.spawnedBy = ${JSON.stringify(byId.get(id).spawnedBy)}`);
}
console.log(
  "  So the fixture cannot exercise the cycle guard (line 318 reads target.spawnedBy.kind).",
);
console.log("  Re-running case TEAM-4241 with production-shaped spawnedBy attached:");
{
  const siblings = boardAt(byId.get("TEAM-4241").createdAt).map((s) =>
    s.ticketId === "TEAM-4242" || s.ticketId === "TEAM-4241"
      ? { ...s, spawnedBy: { kind: "qa_fix" } }
      : s,
  );
  const ids = selectFixBeforeVerifyTargets({
    fixId: "TEAM-4241",
    siblings,
    isFixKind,
    isAdvisory,
    phaseOf,
  });
  console.log(`    -> ${JSON.stringify(ids)}  (fix siblings still excluded; verifiers still held)`);
}

console.log("\n=== item-4.3  clause 3 — the mid-run head move, derived ===");
const ci = byId.get("TEAM-4233");
const fix2 = byId.get("TEAM-4242");
console.log(`  TEAM-4242 created      ${fix2.createdAt}`);
console.log(`  TEAM-4242 completed    ${fix2.updatedAt}`);
console.log(`  TEAM-4233 (CI) created ${ci.createdAt}`);
console.log(`  TEAM-4233 (CI) done    ${ci.updatedAt}`);
console.log(
  `  Historical CI dispatch (fixture narrative): 12:55:09Z = ${new Date(Date.parse("2026-09-07T12:55:09Z")).toISOString()}`,
);
const ciDispatch = Date.parse("2026-09-07T12:55:09Z");
console.log(
  `  Was the fix still in flight at CI dispatch? ${ts(fix2.createdAt) <= ciDispatch && ciDispatch < ts(fix2.updatedAt) ? "YES" : "NO"}`,
);
console.log(
  "  => TEAM-4242 was open when CI was dispatched, so the FIX_BEFORE_VERIFY edge",
);
console.log(
  "     written at 4.2 would have held CI until 13:01:12Z, i.e. until AFTER the",
);
console.log("     73f0056 merge. CI would then start once, at the final head.");
console.log(
  "  NOTE: this is a DERIVATION from the blocker edge, not an assertion. No test",
);
console.log("     in the named files mentions 16fc41d or 73f0056 at all.");

console.log("\n=== item-4 VERDICT ===");
console.log(`  clauses 1+2 (QA/CI held on their fixes): ${allBlocked ? "REPRODUCED against the real fixture board" : "NOT reproduced"}`);
console.log("  clause 3 (no mid-run head move): NOT ASSERTED by any test; derivable only.");
