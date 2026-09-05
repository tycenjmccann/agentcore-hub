// TEAM-3738: deploy.sh forwards PIPELINE_ENABLED verbatim, so whitespace or
// casing variants ("1 ", " true", "TRUE") must not be silently read as disabled.
export function isPipelineEnabled(raw) {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

// TEAM-4044: PIPELINE_ENABLED is one orchestrator-wide flag, but the pipeline it
// describes has exactly ONE Source repo (the hub's own agentcore-hub-deploy).
// Runs on any other repo (juno) were still told "a CodePipeline owns this repo's
// deploy", so the release manager's Pipeline___get_state preflight resolved to
// the hub's pipeline and CD blocked on a phantom infra ticket.
//
// PIPELINE_REPOS scopes the flag to the repos the pipeline actually deploys:
// comma/whitespace-separated `owner/repo` entries. Full GitHub URLs and a `.git`
// suffix are tolerated; matching is case-insensitive (GitHub owner/repo are).
// Unset/empty → every repo (single-repo installs need no extra config; the hub
// prod sets it because the fleet ships several repos).
export function parsePipelineRepos(raw) {
  const out = new Set();
  for (const tok of String(raw ?? "").split(/[\s,]+/)) {
    const key = normalizeRepoKey(tok);
    if (key) out.add(key);
  }
  return out;
}

export function normalizeRepoKey(value) {
  let s = String(value ?? "").trim();
  if (!s) return null;
  // https://github.com/owner/repo(.git) | git@github.com:owner/repo(.git) | owner/repo
  s = s.replace(/^git@[^:]+:/, "").replace(/^[a-z]+:\/\/[^/]+\//i, "");
  s = s.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const parts = s.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return `${parts[0]}/${parts[1]}`.toLowerCase();
}

/**
 * True when the run's repo is one the pipeline deploys. `repoConfig` is the
 * workflow's repoConfig ({ repos: [{ url }] }); `rawRepos` is PIPELINE_REPOS.
 * A run with no repo URL is never pipeline-owned when a scope is configured.
 */
export function pipelineOwnsRepo(repoConfig, rawRepos) {
  const scope = parsePipelineRepos(rawRepos);
  if (scope.size === 0) return true; // unscoped: legacy global behavior
  const key = normalizeRepoKey(repoConfig?.repos?.[0]?.url);
  return key !== null && scope.has(key);
}
