/**
 * P-C — does workflow-output's evidence_keys WRITE shape agree with the
 * orchestrator's harvest READ shape?
 *
 * Producer  lambda/workflow-output/index.mjs:238-239 (string, comma-joined)
 * Consumer  lambda/orchestrator/index.mjs:2751       (guarded on Array.isArray)
 *
 * reportCompletion is not exported (it is an inner handler that writes to S3), so
 * this probe reimplements the two lines VERBATIM from the source and exercises the
 * agent-facing input shapes that deploy/runtime-agent/main.py:1822 can actually
 * produce (`evidence_keys: str = ""` — a comma-separated string).
 */

// ── VERBATIM from lambda/workflow-output/index.mjs:238-239 ────────────────────
function producerNormalize(evidence_keys) {
  const keys =
    typeof evidence_keys === "string"
      ? evidence_keys.trim()
      : Array.isArray(evidence_keys)
        ? evidence_keys.join(",")
        : "";
  const report = {};
  if (keys) report.evidence_keys = keys;
  return report;
}

// ── VERBATIM guard from lambda/orchestrator/index.mjs:2751 ───────────────────
function consumerHarvests(record, entry = {}) {
  return (
    Array.isArray(record.evidence_keys) &&
    record.evidence_keys.length > 0 &&
    !entry?.evidence_keys
  );
}

// The shapes an agent can actually send. main.py types the tool param as `str`,
// so rows 1-2 are the only ones reachable via the real runtime agent; the array
// rows are included to show the producer flattens them too.
const INPUTS = [
  ["CSV string (what runtime-agent main.py:1822 sends)", "qa-evidence/401.png,qa-evidence/run.log"],
  ["single-key string", "qa-evidence/a.png"],
  ["array (only reachable via a direct Lambda invoke)", ["qa-evidence/a.png", "qa-evidence/b.png"]],
  ["empty string", ""],
  ["undefined", undefined],
];

console.log("=== P-C.1  producer output shape, then consumer guard on that output ===");
let harvestedCount = 0;
for (const [label, input] of INPUTS) {
  const record = producerNormalize(input);
  const stored = record.evidence_keys;
  const harvests = consumerHarvests(record);
  if (harvests) harvestedCount++;
  console.log(`  ${label}`);
  console.log(`    input            = ${JSON.stringify(input)}`);
  console.log(`    stored record    = ${JSON.stringify(record)}`);
  console.log(`    typeof stored    = ${typeof stored}${Array.isArray(stored) ? " (array)" : ""}`);
  console.log(`    Array.isArray    = ${Array.isArray(stored)}`);
  console.log(`    orchestrator harvests evidence_keys? -> ${harvests ? "YES" : "NO"}`);
}
console.log(`\n  harvested in ${harvestedCount} of ${INPUTS.length} cases`);

console.log("\n=== P-C.2  the ONLY record shape that would satisfy the consumer ===");
const arrayRecord = { evidence_keys: ["qa-evidence/a.png"] };
console.log(`  hand-built record ${JSON.stringify(arrayRecord)} -> harvests=${consumerHarvests(arrayRecord)}`);
console.log("  ...but producerNormalize can never emit that shape: .join(\",\") makes it a string.");

console.log("\n=== P-C.3  cross-check — live-reverify.mjs reads the SAME field CSV-correctly ===");
const { extractEvidenceKeys } = await import("./p-c-splitcsv-shim.mjs");
for (const [label, input] of INPUTS) {
  const record = producerNormalize(input);
  console.log(`  ${label}: splitCsv(record.evidence_keys) -> ${JSON.stringify(extractEvidenceKeys(record))}`);
}

console.log("\n=== P-C VERDICT ===");
console.log("  Producer writes:  string (always — arrays are .join(\",\")-flattened)");
console.log("  Consumer expects: Array  (Array.isArray guard at index.mjs:2751)");
console.log("  => They DO NOT AGREE. The harvest branch is UNREACHABLE for any record");
console.log("     written by workflow-output, so agentTasks[t].evidence_keys is never set.");
console.log("  => Blast radius today: nil. grep shows NOTHING reads the harvested");
console.log("     entry.evidence_keys, and live-reverify.mjs:116 reads the S3 record");
console.log("     directly through a shape-tolerant splitCsv (handles string AND array).");
console.log("     It is a dead branch / latent bug, not a live functional break.");
