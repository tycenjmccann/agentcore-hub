/**
 * Item 12 probe + reviewer finding F8 — drive the REAL validator on a plan shaped
 * like workflows/<id>/shared/ticket-plan.json, and ask whether a real-looking
 * non-feature branch is rejected as "invented".
 *
 * lambda/orchestrator/ticket-plan-validator.mjs is a zero-import leaf module
 * (`grep -c "^import" ` -> 0), so nothing here is stubbed.
 *
 * The plan below is built from the REAL vendored c2uqki dossier, so the two
 * ticket ids and their real descriptions come from the run, not from me.
 */
import { readFileSync } from "node:fs";
import {
  validateTicketPlan,
  findBranchTokens,
  canonicalBranchFor,
  rewriteBranchNames,
  normalizeTicketPlanValidatorMode,
  BRANCH_TOKEN_RE,
  CANONICAL_BRANCH_RE,
} from "../../../lambda/orchestrator/ticket-plan-validator.mjs";

const D = JSON.parse(
  readFileSync(
    new URL("../../../deploy/workflow-manager/toolkit/fixtures/c2uqki-dossier.json", import.meta.url),
    "utf8",
  ),
);
const tk = (id) => D.tickets.find((t) => t.ticketId === id);

console.log("=== 12.1  the plan as submitted, from the real dossier ===");
// The shape submit_ticket_plan receives: the plan's own entries, `blocked_by`
// exactly as the analyst wrote them. TEAM-4229 (requirements) is NOT in the plan —
// that is the c2uqki defect: its first entry IS the offender.
const plan = [
  { ticketId: "TEAM-4230", title: tk("TEAM-4230").title, assignee: tk("TEAM-4230").assignee, description: tk("TEAM-4230").description, blocked_by: [] },
  { ticketId: "TEAM-4229", title: tk("TEAM-4229").title, assignee: tk("TEAM-4229").assignee, blocked_by: [] },
];
for (const t of plan) {
  console.log(`  ${t.ticketId}  assignee=${t.assignee}  blocked_by=${JSON.stringify(t.blocked_by)}`);
  console.log(`      title: ${String(t.title).slice(0, 88)}`);
}

console.log("\n=== 12.2  validateTicketPlan with TEAM-4229 as the OPEN root ===");
const a = validateTicketPlan(plan, { rootTicketId: "TEAM-4229", rootStatus: "open" });
console.log(`  ok = ${a.ok}   violations = ${a.violations.length}`);
for (const v of a.violations) console.log(`  [${v.code}] ${v.ticketRef}\n      ${v.message}`);
const unblocked = a.violations.filter((v) => v.code === "unblocked-non-root");
console.log(`  unblocked-non-root count = ${unblocked.length}   (TEAM-4229 is exempt as the root)`);
console.log(`  the ONE message names BOTH ids? ${unblocked.length === 1 && unblocked[0].message.includes("TEAM-4230") && unblocked[0].message.includes("TEAM-4229")}`);

console.log("\n=== 12.3  controls ===");
const asDone = validateTicketPlan(plan, { rootTicketId: "TEAM-4229", rootStatus: "done" });
console.log(`  root status 'done'  -> unblocked-non-root: ${asDone.violations.filter((v) => v.code === "unblocked-non-root").length}  (fails open)`);
const noRoot = validateTicketPlan([plan[0]], { rootTicketId: null, rootStatus: "open" });
console.log(`  no resolvable root  -> ${noRoot.violations.filter((v) => v.code === "unblocked-non-root").length} violation(s), message says: "${noRoot.violations.find((v) => v.code === "unblocked-non-root")?.message.match(/root (.*?) is not done/)?.[1]}"`);
const advisory = validateTicketPlan(
  [{ ticketId: "TEAM-9001", title: "Advisory: later", assignee: "agentcore_hub_backend_dev", blocked_by: [], labels: ["advisory"] }],
  { rootTicketId: "TEAM-4229", rootStatus: "open" },
);
console.log(`  advisory, no blockers -> ok=${advisory.ok}, violations=${advisory.violations.length}  (EXEMPT)`);
const fixKind = validateTicketPlan(
  [{ ticketId: "TEAM-4241", title: "fix", assignee: "agentcore_hub_code_sweeper", blocked_by: [], spawnedBy: { kind: "review_fix" } }],
  { rootTicketId: "TEAM-4229", rootStatus: "open" },
);
console.log(`  fix lineage, no blockers -> ok=${fixKind.ok}  (chained by the fix contract instead)`);

console.log("\n=== 12.4  F8 — which branch-shaped tokens does the rule REJECT under enforce? ===");
console.log(`  CANONICAL_BRANCH_RE = ${CANONICAL_BRANCH_RE}`);
console.log(`  BRANCH_TOKEN_RE     = ${BRANCH_TOKEN_RE}\n`);
const BRANCHES = [
  "chore/dead-code-sweep-2026-08-31",   // the reviewer's example 1
  "release/v1.2",                        // the reviewer's example 2
  "chore/dead-code-sweep-2026-09-07",   // what c2uqki actually wrote
  "feature/TEAM-4230-code-sweeper",     // the harness convention
  "feature/TEAM-4243--si-system-binding-gate-verdicts-verifie", // THIS branch
  "feature/team-4230-code-sweeper",     // lower-case key
  "feature/TEAM-4230-Code-Sweeper",     // upper-case slug
  "hotfix/prod-outage",
  "bugfix/JIRA-1-thing",
  "fix/TEAM-1-x",
  "main",
  "origin/main",
  "renovate/lodash-4.x",                // not in the prefix alternation
];
for (const b of BRANCHES) {
  const text = `Work happens on branch \`${b}\` -> main.`;
  const toks = findBranchTokens(text);
  const r = validateTicketPlan([{ ticketId: "TEAM-1", assignee: "agentcore_hub_backend_dev", blocked_by: ["TEAM-0"], description: text }], {
    rootTicketId: "TEAM-0",
    rootStatus: "open",
  });
  const inv = r.violations.filter((v) => v.code === "invented-branch");
  console.log(`  ${b.padEnd(58)} tokenised=${String(toks.length > 0).padEnd(5)} canonical=${String(CANONICAL_BRANCH_RE.test(b)).padEnd(5)} REJECTED=${inv.length > 0}`);
}

console.log("\n=== 12.5  F8 — does knownBranches save a legitimate release branch? ===");
const relText = "Cut from `release/v1.2` after review.";
const relTicket = [{ ticketId: "TEAM-1", assignee: "agentcore_hub_release_manager", blocked_by: ["TEAM-0"], description: relText }];
const without = validateTicketPlan(relTicket, { rootTicketId: "TEAM-0", rootStatus: "open" });
const withKnown = validateTicketPlan(relTicket, { rootTicketId: "TEAM-0", rootStatus: "open", knownBranches: ["release/v1.2"] });
console.log(`  no knownBranches      -> invented-branch: ${without.violations.filter((v) => v.code === "invented-branch").length}`);
console.log(`  knownBranches supplied -> invented-branch: ${withKnown.violations.filter((v) => v.code === "invented-branch").length}`);
console.log("  So the escape hatch WORKS -- the question is whether the caller uses it.");

console.log("\n=== 12.6  do the three production callers pass knownBranches? ===");
const CALLERS = [
  ["lambda/workflow-output/index.mjs", 73, "submit_ticket_plan (the whole plan, both codes)"],
  ["lambda/agentcore-hub-tickets/index.mjs", 362, "create_ticket, DDB provider"],
  ["lambda/agentcore-hub-jira/index.mjs", 395, "create_ticket, Jira provider"],
];
for (const [file, line, what] of CALLERS) {
  const src = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8").split("\n");
  const call = src.slice(line - 2, line + 4).join("\n");
  console.log(`  --- ${file}:${line}  (${what})`);
  console.log(call.split("\n").map((l) => `      ${l}`).join("\n"));
  console.log(`      passes knownBranches? ${call.includes("knownBranches") ? "YES" : "NO"}`);
  console.log(`      filters to unblocked-non-root only? ${call.includes("unblocked-non-root") || src.slice(line, line + 8).join("").includes("unblocked-non-root") ? "YES" : "NO"}`);
}

console.log("\n=== 12.7  canonicalBranchFor + rewriteBranchNames on the real c2uqki text ===");
const canonical = canonicalBranchFor("TEAM-4230", "agentcore_hub_code_sweeper");
console.log(`  canonicalBranchFor("TEAM-4230","agentcore_hub_code_sweeper") = ${canonical}`);
console.log(`  advisory variant = ${canonicalBranchFor("TEAM-4230", "agentcore_hub_code_sweeper", { advisory: true })}`);
const real = String(tk("TEAM-4230").description || "");
const found = findBranchTokens(real);
console.log(`  branch tokens in TEAM-4230's REAL description: ${JSON.stringify(found)}`);
if (found.length) {
  const rw = rewriteBranchNames(real, { canonical });
  console.log(`  rewrites: ${JSON.stringify(rw.rewrites)}`);
  console.log(`  text changed? ${rw.text !== real}`);
}

console.log("\n=== 12.8  mode normaliser ===");
for (const raw of [undefined, null, "", "   ", "off", "OFF", " Enforce ", "shadow", "banana", "1", "true", "on"]) {
  console.log(`  ${String(JSON.stringify(raw)).padEnd(12)} -> ${normalizeTicketPlanValidatorMode(raw)}`);
}

console.log("\n=== ITEM 12 / F8 VERDICT ===");
console.log("  Item 12: both clauses reproduce on the real module against real dossier data.");
console.log("  F8 REPRODUCED, with a scope limit: the invented-branch code fires on ANY");
console.log("  chore/ feature/ feat/ fix/ hotfix/ release/ bugfix/ token that is not the");
console.log("  harness convention and not in knownBranches -- including release/v1.2 and a");
console.log("  dated chore/ sweep branch. The one caller that surfaces that code");
console.log("  (workflow-output submit_ticket_plan) passes NO knownBranches, so under");
console.log("  enforce a plan that legitimately cites a release branch is rejected.");
