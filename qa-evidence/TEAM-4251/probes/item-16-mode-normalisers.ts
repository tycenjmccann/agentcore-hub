/**
 * TEAM-4251 item 16 probe — every flag normaliser's fallback, on the real modules.
 *
 * The seven acceptance flags read through FIVE distinct normalisers: the four D1
 * flags share `normalizeVerdictMode`, the completion route has its own TS twin,
 * and the sweep-cadence / ticket-plan / decision-ledger flags each have one.
 * Run under vite-node so the two TypeScript ones import for real.
 *
 *   npx vite-node qa-evidence/TEAM-4251/probes/item-16-mode-normalisers.ts
 *
 * The question this answers is not "does it parse" — it is which way each flag
 * FAILS when someone typos it in a task definition. A normaliser that falls to
 * `off` silently disables a gate; one that falls to `shadow` keeps writing.
 */
import { normalizeVerdictMode } from "../../../lambda/orchestrator/verdict-contract.mjs";
import { normalizeTicketPlanValidatorMode } from "../../../lambda/orchestrator/ticket-plan-validator.mjs";
import { normalizeDecisionLedgerMode } from "../../../lambda/orchestrator/artifact-chain.mjs";
import { normalizeSweepCadenceMode } from "../../../src/lib/workflow/sweep-cadence";
import { normalizeVerifiedHeadMode } from "../../../src/lib/workflow/verified-heads";

/** The inputs the acceptance item names, plus the two legacy truthies. */
const INPUTS: Array<[string, unknown]> = [
  ['"banana"', "banana"],
  ['""', ""],
  ["undefined", undefined],
  ['"ENFORCE "', "ENFORCE "],
  ['"Shadow"', "Shadow"],
  // Not in the item, but the failure everyone actually types:
  ["null", null],
  ['"   "', "   "],
  ['"on"', "on"],
  ['"true"', "true"],
  ['"1"', "1"],
  ["1 (number)", 1],
  ['"OFF"', "OFF"],
  ['"enfroce" (typo)', "enfroce"],
  ['"shdaow" (typo)', "shdaow"],
];

const NORMALISERS: Array<{
  name: string;
  file: string;
  fn: (raw: unknown) => string;
  flags: string[];
}> = [
  {
    name: "normalizeVerdictMode",
    file: "lambda/orchestrator/verdict-contract.mjs:214",
    fn: normalizeVerdictMode as (raw: unknown) => string,
    flags: ["VERDICT_GATE", "FIX_BEFORE_VERIFY", "VERIFIED_HEAD_COMPLETION", "SWEEP_DETECTION_PHASE"],
  },
  {
    name: "normalizeVerifiedHeadMode",
    file: "src/lib/workflow/verified-heads.ts:186",
    fn: normalizeVerifiedHeadMode as (raw: unknown) => string,
    flags: ["VERIFIED_HEAD_COMPLETION (the /complete route's own twin)"],
  },
  {
    name: "normalizeSweepCadenceMode",
    file: "src/lib/workflow/sweep-cadence.ts:86",
    fn: normalizeSweepCadenceMode as (raw: unknown) => string,
    flags: ["SWEEP_CADENCE_GATE"],
  },
  {
    name: "normalizeTicketPlanValidatorMode",
    file: "lambda/orchestrator/ticket-plan-validator.mjs:68 (x4 byte-identical copies)",
    fn: normalizeTicketPlanValidatorMode as (raw: unknown) => string,
    flags: ["TICKET_PLAN_VALIDATOR"],
  },
  {
    name: "normalizeDecisionLedgerMode",
    file: "lambda/orchestrator/artifact-chain.mjs:251",
    fn: normalizeDecisionLedgerMode as (raw: unknown) => string,
    flags: ["DECISION_LEDGER"],
  },
];

console.log("=== 16.1  fallback of every normaliser, on the real modules ===\n");

const unrecognized: Record<string, string> = {};
const unset: Record<string, string> = {};

for (const n of NORMALISERS) {
  console.log(`--- ${n.name}  (${n.file})`);
  console.log(`      flags: ${n.flags.join(", ")}`);
  for (const [label, raw] of INPUTS) {
    let out: string;
    try {
      out = JSON.stringify(n.fn(raw));
    } catch (e) {
      out = `THREW ${(e as Error).message}`;
    }
    console.log(`      ${label.padEnd(18)} -> ${out}`);
  }
  unrecognized[n.name] = n.fn("banana");
  unset[n.name] = n.fn(undefined);
  console.log();
}

console.log("=== 16.2  the two answers that matter ===\n");
console.log("  flag value UNSET (a deploy that never sets it):");
for (const n of NORMALISERS) {
  console.log(`      ${n.name.padEnd(34)} -> ${unset[n.name]}`);
}
console.log("\n  flag value UNRECOGNIZED (a typo in the task definition):");
for (const n of NORMALISERS) {
  const v = unrecognized[n.name];
  const note = v === "off" ? "  <-- FAILS OPEN: the gate silently stops running" : "  <-- still writes";
  console.log(`      ${n.name.padEnd(34)} -> ${v}${note}`);
}

console.log("\n=== 16.3  whitespace + case tolerance ===\n");
for (const n of NORMALISERS) {
  const ok = n.fn("ENFORCE ") === "enforce" && n.fn("Shadow") === "shadow";
  console.log(`      ${n.name.padEnd(34)} "ENFORCE "/"Shadow" handled: ${ok ? "YES" : "NO"}`);
}

console.log("\n=== 16.4  do the two VERIFIED_HEAD_COMPLETION twins agree? ===\n");
let drift = 0;
for (const [label, raw] of INPUTS) {
  const a = normalizeVerdictMode(raw as never);
  const b = normalizeVerifiedHeadMode(raw);
  const same = a === b;
  if (!same) drift++;
  console.log(`      ${label.padEnd(18)} orchestrator=${String(a).padEnd(8)} route=${String(b).padEnd(8)} ${same ? "" : "<-- DRIFT"}`);
}
console.log(
  `\n      ${drift === 0 ? "AGREE on every input — one flag, one meaning on both surfaces." : `DRIFT on ${drift} input(s)`}`,
);

console.log("\n=== ITEM 16 VERDICT ===");
console.log("  Four of the five normalisers fall an unrecognized value to `off`, so a typo");
console.log("  in VERDICT_GATE / FIX_BEFORE_VERIFY / VERIFIED_HEAD_COMPLETION /");
console.log("  SWEEP_DETECTION_PHASE / SWEEP_CADENCE_GATE / TICKET_PLAN_VALIDATOR silently");
console.log("  disables that gate with no log line. DECISION_LEDGER is the exception:");
console.log("  anything unrecognized lands on `shadow`, so it keeps writing. Unset is");
console.log("  `shadow` everywhere — no flag ships enforcing.");
