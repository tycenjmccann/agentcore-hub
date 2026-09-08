/**
 * P-B (and item 7's independent probe) — how is `heads.pr` derived?
 *
 * Imports the REAL lambda/orchestrator/completion.mjs (a zero-import leaf module:
 * `grep -n "^import" completion.mjs` returns nothing, so nothing is stubbed) and
 * drives evaluateVerifiedHeads with the REAL vendored dowtdh dossier.
 */
import { readFileSync } from "node:fs";
import {
  evaluateVerifiedHeads,
  normalizeHeadSha,
  GATE_PERSONA_IDS,
} from "../../../lambda/orchestrator/completion.mjs";

const D = JSON.parse(
  readFileSync(
    new URL(
      "../../../deploy/workflow-manager/toolkit/fixtures/dowtdh-dossier.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const agentTasks = D.workflow.agentTasks;
const children = D.tickets.filter((t) => t.type !== "epic");

console.log("=== P-B.1  the raw material: every done ticket's head-bearing fields ===");
for (const t of children) {
  const e = agentTasks[t.ticketId];
  if (!e) continue;
  const gate = GATE_PERSONA_IDS.has(t.assignee || e.agentId);
  console.log(
    `  ${t.ticketId} ${String(t.assignee || e.agentId).padEnd(38)} status=${String(t.status).padEnd(5)} gate=${gate ? "Y" : "n"}`,
  );
  console.log(
    `      commitSha=${e.commitSha ? e.commitSha.slice(0, 7) : "-"}  testedHead=${e.testedHead ?? e.tested_head ?? "-"}  mergeCommit=${e.mergeCommit ? String(e.mergeCommit).slice(0, 7) : "-"}  completedAt=${e.completedAt}`,
  );
}

console.log("\n=== P-B.2  evaluateVerifiedHeads on the dossier AS VENDORED (no opts) ===");
const asIs = evaluateVerifiedHeads(children, agentTasks);
console.log("  " + JSON.stringify(asIs, null, 2).split("\n").join("\n  "));
console.log(
  "  heads.qa/heads.ci are NULL because the pre-D1 fixture has no testedHead field",
);
console.log("  anywhere — the exact hole D1 exists to close.");

console.log("\n=== P-B.3  with tested_head seeded (what the personas write under D1) ===");
const seeded = JSON.parse(JSON.stringify(agentTasks));
seeded["TEAM-4181"].tested_head = "933ea6f1f04fc0212b88b84a6fcbe6aa0ce1d052"; // QA
seeded["TEAM-4182"].tested_head = "12e9ac6ef5081343701945e8a3b39803d9c53cc6"; // CI
const withHeads = evaluateVerifiedHeads(children, seeded);
console.log("  " + JSON.stringify(withHeads, null, 2).split("\n").join("\n  "));

console.log("\n=== P-B.4  where did heads.pr come from? ===");
const nonGateDone = children
  .filter((t) => {
    const e = seeded[t.ticketId];
    const a = t.assignee || e?.agentId || "";
    return (
      String(t.status).toLowerCase() === "done" &&
      e &&
      !GATE_PERSONA_IDS.has(a) &&
      !a.startsWith("human:") &&
      (e.commitSha || e.commit_sha)
    );
  })
  .map((t) => ({
    ticketId: t.ticketId,
    assignee: t.assignee || seeded[t.ticketId].agentId,
    commitSha: String(seeded[t.ticketId].commitSha || seeded[t.ticketId].commit_sha).slice(0, 7),
    completedAt: seeded[t.ticketId].completedAt,
  }))
  .sort((a, b) => (a.completedAt < b.completedAt ? -1 : 1));
for (const r of nonGateDone) {
  console.log(`  ${r.completedAt}  ${r.ticketId} ${r.assignee.padEnd(32)} ${r.commitSha}`);
}
console.log(
  `  newest-by-completedAt = ${nonGateDone.at(-1).ticketId} @ ${nonGateDone.at(-1).commitSha}`,
);
console.log(`  heads.pr reported     = ${String(withHeads.heads.pr).slice(0, 7)}`);
console.log(
  `  MATCH? ${String(withHeads.heads.pr).startsWith(nonGateDone.at(-1).commitSha) ? "YES — heads.pr IS the latest non-gate (dev/fix) commitSha" : "NO"}`,
);

console.log("\n=== P-B.5  does a caller-supplied prHeadSha win? ===");
const supplied = evaluateVerifiedHeads(children, seeded, { prHeadSha: "deadbee" + "f".repeat(33) });
console.log(`  heads.pr with opts.prHeadSha = ${supplied.heads.pr}`);
console.log(`  => the opts path EXISTS and takes precedence (completion.mjs:700,707).`);

console.log("\n=== P-B.6  is mergeCommit ever used? ===");
const anyMerge = Object.values(agentTasks).filter((e) => e && (e.mergeCommit || e.merge_commit));
console.log(`  agentTasks entries carrying a mergeCommit: ${anyMerge.length}`);
console.log("  headFrom() for the pr slot reads ONLY [\"commitSha\",\"commit_sha\"]");
console.log("  (completion.mjs:747) — mergeCommit is deliberately excluded.");

console.log("\n=== P-B VERDICT ===");
console.log("  heads.pr = normalizeHeadSha(opts.prHeadSha) when the CALLER supplies one,");
console.log("  else the newest `commitSha` on a done NON-GATE, non-human ticket — i.e. the");
console.log("  latest dev/fix task commit. It is NOT read from the actual PR or from the");
console.log("  integration branch head, and never from mergeCommit.");
console.log("  normalizeHeadSha sanity: " + JSON.stringify(normalizeHeadSha("  933EA6F  ")));
