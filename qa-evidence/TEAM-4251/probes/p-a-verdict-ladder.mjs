/**
 * P-A — independent probe of the verdict inference ladder at HEAD 5fa3728.
 * Imports the REAL lambda/orchestrator/verdict-contract.mjs (zero-import module,
 * so nothing is stubbed) and prints deriveVerdict/resolveVerdict for the exact
 * summaries the reviewer asked about, then the enforce-mode null-verdict decision.
 */
import {
  deriveVerdict,
  resolveVerdict,
  evaluateGate,
  normalizeVerdictMode,
} from "../../../lambda/orchestrator/verdict-contract.mjs";

const SUMMARIES = [
  "QA FAIL: 191 PASS / 8 FAIL, live Chromium",
  "Verdict: CHANGES NEEDED",
  "CHANGES NEEDED — see findings",
  "PASS",
  "BLOCKED: no gateway",
  "All checks passed",
  "",
];

console.log("=== P-A.1  deriveVerdict(summary) ===");
for (const s of SUMMARIES) {
  const d = deriveVerdict(s);
  console.log(
    `  input=${JSON.stringify(s)}\n    deriveVerdict -> ${d === null ? "null" : JSON.stringify(d)}`,
  );
}

console.log("\n=== P-A.2  resolveVerdict({summary}, qa_verifier) — gate persona, nothing declared ===");
for (const s of SUMMARIES) {
  const r = resolveVerdict({ summary: s }, "agentcore_hub_qa_verifier");
  console.log(`  input=${JSON.stringify(s)}\n    -> ${JSON.stringify(r)}`);
}

console.log("\n=== P-A.3  enforce mode, gate persona, verdict resolves to null ===");
for (const verdict of [null, undefined, "", "SUCCEEDED"]) {
  const g = evaluateGate({
    assignee: "agentcore_hub_qa_verifier",
    verdict,
    spawnedTickets: [],
    mode: "enforce",
  });
  console.log(`  verdict=${JSON.stringify(verdict)} mode=enforce -> ${JSON.stringify(g)}`);
}

console.log("\n=== P-A.4  control: a real non-PASS under enforce DOES suppress ===");
for (const verdict of ["FAIL", "CHANGES_NEEDED", "BLOCKED", "PASS"]) {
  const g = evaluateGate({
    assignee: "agentcore_hub_qa_verifier",
    verdict,
    spawnedTickets: ["TEAM-4183"],
    mode: "enforce",
  });
  console.log(`  verdict=${verdict} -> suppress=${g.suppress} reason=${g.reason} blockOn=${JSON.stringify(g.blockOn)} needsGateReverify=${g.needsGateReverify}`);
}

console.log("\n=== P-A.5  the end-to-end hole: QA prose 'QA FAIL: ...' under enforce ===");
const real = resolveVerdict(
  { summary: "QA FAIL: 191 PASS / 8 FAIL, live Chromium" },
  "agentcore_hub_qa_verifier",
);
const gate = evaluateGate({
  assignee: "agentcore_hub_qa_verifier",
  verdict: real.verdict,
  spawnedTickets: [],
  mode: "enforce",
});
console.log(`  resolveVerdict -> ${JSON.stringify(real)}`);
console.log(`  evaluateGate   -> ${JSON.stringify(gate)}`);
console.log(
  `  NET: successor is ${gate.suppress ? "HELD" : "DISPATCHED (fail-open)"} despite prose stating FAIL`,
);

console.log("\n=== P-A.6  normalizeVerdictMode fallbacks ===");
for (const raw of [undefined, null, "", "  ", "off", "shadow", "enforce", "ENFORCE", "garbage", "enforce ", "1", "true"]) {
  console.log(`  ${JSON.stringify(raw)} -> ${normalizeVerdictMode(raw)}`);
}
