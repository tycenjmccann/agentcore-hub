/**
 * TEAM-3992 D4.1 — the base-branch + repo-identity resolvers, resolved once at
 * intake and read everywhere.
 *
 * Kept in a side-effect-free module (like pipeline-enabled.mjs) so the pure
 * resolution logic is unit-testable without importing index.mjs's module-load
 * AWS client construction. index.mjs imports all three.
 */

/** owner/repo from the primary repo URL. `{owner:"", repo:""}` when unparseable. */
export function parseRepoUrl(repoConfig) {
  const url = repoConfig?.repos?.[0]?.url || "";
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  return match ? { owner: match[1], repo: match[2] } : { owner: "", repo: "" };
}

/**
 * The base branch. Preference: the branch GitHub reported for the repo
 * (repoCheck) → the branch the submitter configured → "main". This is the ONLY
 * place "main" is assumed, so a repo whose default is `master`/`develop` is
 * branched, compared and PR'd against the right branch instead of a 404-on-`main`.
 */
export function resolveDefaultBranch(workflow) {
  const primaryUrl = workflow?.repoConfig?.repos?.[0]?.url;
  const results = workflow?.repoCheck?.results || [];
  const match =
    results.find((r) => r?.url === primaryUrl && r?.defaultBranch) ||
    results.find((r) => r?.defaultBranch);
  return match?.defaultBranch || workflow?.repoConfig?.repos?.[0]?.defaultBranch || "main";
}

/**
 * Canonical owner/repo. When GitHub answered a rename/transfer (301→200), the
 * configured URL points at the old name; repoCheck captured the canonical
 * full_name, so use it. Otherwise fall back to parsing the configured URL.
 */
export function resolveRepoIdentity(workflow) {
  const primaryUrl = workflow?.repoConfig?.repos?.[0]?.url;
  const results = workflow?.repoCheck?.results || [];
  const match = results.find((r) => r?.url === primaryUrl && r?.ok) || results.find((r) => r?.ok);
  if (match?.renamed && typeof match.fullName === "string" && match.fullName.includes("/")) {
    const [owner, repo] = match.fullName.split("/");
    return { owner, repo };
  }
  return parseRepoUrl(workflow?.repoConfig);
}
