/**
 * The hub's own repository as owner/name — where Workflow Manager filings
 * (crash RCAs, manager-noticed defects) belong, as opposed to the workload repo
 * GITHUB_OWNER/GITHUB_REPO the hub serves by default.
 *
 * Source of truth is HUB_REPO_URL (deploy/config.sh derives it as
 * https://github.com/${GITHUB_OWNER}/agentcore-hub.git); the fallback mirrors
 * that same convention so the default is right even where the env is not set.
 */
export function hubRepo(): string {
  const url = (process.env.HUB_REPO_URL || "").trim();
  const m = /^(?:https?:\/\/[^/]+\/|git@[^:]+:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (m) return `${m[1]}/${m[2]}`;
  return process.env.GITHUB_OWNER ? `${process.env.GITHUB_OWNER}/agentcore-hub` : "";
}
