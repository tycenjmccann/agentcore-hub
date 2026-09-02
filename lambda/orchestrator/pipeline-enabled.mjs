// TEAM-3738: deploy.sh forwards PIPELINE_ENABLED verbatim, so whitespace or
// casing variants ("1 ", " true", "TRUE") must not be silently read as disabled.
export function isPipelineEnabled(raw) {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}
