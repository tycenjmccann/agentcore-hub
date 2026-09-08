/** splitCsv + the evidence-key extraction VERBATIM from lambda/orchestrator/live-reverify.mjs:93-101,116. */
function splitCsv(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v : typeof v?.s3Key === "string" ? v.s3Key : ""))
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof value !== "string") return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}
export function extractEvidenceKeys(record) {
  return [...splitCsv(record.artifacts), ...splitCsv(record.evidence_keys)];
}
