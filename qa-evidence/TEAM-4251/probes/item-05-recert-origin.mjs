/**
 * Item 5 probe — is TEAM-4157 (the CI re-certification) orchestrator-created?
 *
 * Acceptance item 5: "Replay f50ucz ship-review r1->r2: no regression; TEAM-4157
 * CI re-cert is orchestrator-created."
 *
 * Reads the REAL vendored f50ucz dossier for TEAM-4157's provenance, and the REAL
 * live-reverify.mjs GATE_OWNER_FIX_KIND map for what the orchestrator would file
 * instead. Zero stubs.
 */
import { readFileSync, readdirSync } from "node:fs";
import { GATE_OWNER_FIX_KIND } from "../../../lambda/orchestrator/live-reverify.mjs";

const dir = new URL("../../../deploy/workflow-manager/toolkit/fixtures/", import.meta.url);
console.log("=== item-5.0  vendored f50ucz fixtures ===");
const files = readdirSync(dir).filter((f) => f.includes("f50ucz"));
console.log("  " + files.join("\n  "));

const dossier = JSON.parse(readFileSync(new URL("f50ucz-dossier.json", dir), "utf8"));
const byId = new Map(dossier.tickets.map((t) => [t.ticketId, t]));

console.log("\n=== item-5.1  TEAM-4157 as the fixture records it ===");
const recert = byId.get("TEAM-4157");
if (!recert) {
  console.log("  TEAM-4157 NOT PRESENT in the dossier tickets");
} else {
  console.log(`  ticketId   ${recert.ticketId}`);
  console.log(`  title      ${recert.title}`);
  console.log(`  assignee   ${recert.assignee}`);
  console.log(`  blockedBy  ${JSON.stringify(recert.blockedBy)}`);
  console.log(`  spawnedBy  ${JSON.stringify(recert.spawnedBy ?? null)}`);
  console.log(
    `  => spawnedBy is ${(recert.spawnedBy ?? null) === null ? "NULL — no orchestrator lineage stamp, i.e. AGENT-FILED" : "present"}`,
  );
}

console.log("\n=== item-5.2  what the orchestrator files instead (real GATE_OWNER_FIX_KIND) ===");
for (const [owner, kind] of Object.entries(GATE_OWNER_FIX_KIND)) {
  console.log(`  ${owner.padEnd(38)} -> ${kind}`);
}
console.log(
  "  A ship round is owned by agentcore_hub_release_manager, so an orchestrator-filed",
);
console.log(
  "  re-verify is assigned to the RELEASE MANAGER with kind ship_fix and the title",
);
console.log("  'Re-verify (round N)' — it is NOT a CI re-certification ticket.");

console.log("\n=== item-5.3  which f50ucz tickets carry an orchestrator lineage stamp? ===");
let stamped = 0;
for (const t of dossier.tickets) {
  const sb = t.spawnedBy ?? null;
  if (sb) stamped++;
  console.log(
    `  ${t.ticketId.padEnd(9)} ${String(t.assignee).padEnd(38)} spawnedBy=${JSON.stringify(sb)}`,
  );
}
console.log(`  tickets with a spawnedBy stamp: ${stamped} of ${dossier.tickets.length}`);

console.log("\n=== item-5 VERDICT ===");
console.log("  clause 'no regression': see the test assertion expect(enforce).toEqual(off).");
console.log("  clause 'TEAM-4157 CI re-cert is orchestrator-created': CONTRADICTED.");
console.log("    TEAM-4157 is agent-filed in the fixture (spawnedBy null), and on the");
console.log("    converging r1->r2 path the orchestrator files NOTHING at all.");
