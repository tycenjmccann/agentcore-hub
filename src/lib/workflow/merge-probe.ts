/**
 * TEAM-3991 D1.3/D1.4 — GitHub as the ground truth for "did this run's feature
 * branch actually land?".
 *
 * PARITY TWIN of `lambda/orchestrator/index.mjs featureBranchMergeProbe`, with the
 * two pure result mappings shared verbatim with `lambda/orchestrator/evidence.mjs`
 * (`mergeProbeFromPulls` / `mergeProbeFromCompare`) and pinned by
 * completion-evidence-parity.test.ts.
 *
 * Why the console side needs it at all: the release manager's `report_completion`
 * tool has no outcome/merge_commit field, so a merged-and-deployed run's
 * self-reported ship verdict can never read "shipped" (`commitSha` is the branch
 * HEAD, deliberately not proof). Without this probe the complete route closed every
 * such run `static-ci-only` — and, worse, could not tell that case apart from a run
 * whose branch was never merged at all.
 *
 * THREE answers, and the third is not a failure mode to paper over:
 *   { merged: true,  mergeCommit, prUrl }  a PR for this head has `merged_at`, or
 *                                          compare says the branch is already in
 *                                          the base → stamp the proof.
 *   { merged: false, reason }              compare says ahead/diverged → provably
 *                                          unmerged; refuse the green close.
 *   { merged: null }                       no PAT, no repo config, unknown compare
 *                                          status, or any fetch error → UNKNOWN.
 *                                          Fail OPEN: fall back to the run's own
 *                                          self-reported evidence. GitHub being
 *                                          unreachable must never invent a verdict
 *                                          in either direction.
 */
import { githubApi, parseRepo, type GithubFetch } from "./evidence";

export interface MergeProbeResult {
  /** true = proven merged, false = proven unmerged, null = unknown. */
  merged: boolean | null;
  mergeCommit?: string;
  prUrl?: string;
  reason?: string;
}

export interface PullRequestMergeLike {
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  html_url?: string | null;
}

export interface CompareLike {
  status?: string;
  ahead_by?: number;
  base_commit?: { sha?: string };
}

/**
 * `merged_at` is the ONLY authoritative merge signal on a pull request: `state`
 * reads "closed" for an abandoned PR too, and GitHub populates `merge_commit_sha`
 * with a TEST-merge sha on PRs that never merged. Treating either as proof is
 * exactly how an unshipped run gets a green close, so the reduction is on
 * `merged_at` alone.
 *
 * null = no PR in the list has merged; the caller must then ask `compare`, because
 * a squash/rebase merge can leave no merged PR attached to this head.
 */
export function mergeProbeFromPulls(prs: unknown): MergeProbeResult | null {
  const list = Array.isArray(prs) ? (prs as PullRequestMergeLike[]) : [];
  const mergedPr = list.find((p) => p?.merged_at);
  if (!mergedPr) return null;
  return {
    merged: true,
    mergeCommit: mergedPr.merge_commit_sha || "",
    prUrl: mergedPr.html_url || "",
  };
}

/**
 * identical/behind ⇒ the branch's commits are already in the base (merged, however
 * it landed); ahead/diverged ⇒ provably unmerged; anything else ⇒ unknown.
 */
export function mergeProbeFromCompare(cmp: unknown, base = "main"): MergeProbeResult {
  const c = (cmp || {}) as CompareLike;
  if (c.status === "identical" || c.status === "behind") {
    return { merged: true, mergeCommit: c.base_commit?.sha || "", prUrl: "" };
  }
  if (c.status === "ahead" || c.status === "diverged") {
    return { merged: false, reason: `branch ${c.ahead_by} commit(s) ahead of ${base} (status=${c.status})` };
  }
  return { merged: null };
}

export interface MergeProbeInput {
  featureBranch?: unknown;
  repoConfig?: unknown;
}

/**
 * The full probe: PR list first (one call answers the common case), compare only
 * when no PR for the head has merged. `githubFetch` is injectable so tests never
 * touch the network; the default carries the existing GITHUB_PAT — no new secret.
 */
export async function featureBranchMergeProbe(
  workflow: MergeProbeInput,
  deps: { githubFetch?: GithubFetch } = {}
): Promise<MergeProbeResult> {
  const head = String(workflow?.featureBranch || "");
  const { owner, repo } = parseRepo(workflow?.repoConfig);
  // No branch, no repo, no token → UNKNOWN, not "unmerged". There is nothing to
  // probe, and a probe that cannot run has proven nothing.
  if (!head || !owner || !repo) return { merged: null };
  const githubFetch = deps.githubFetch || (process.env.GITHUB_PAT ? githubApi() : null);
  if (!githubFetch) return { merged: null };

  const base =
    (workflow?.repoConfig as { repos?: Array<{ defaultBranch?: string }> } | undefined)?.repos?.[0]
      ?.defaultBranch || "main";
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);

  try {
    const prs = await githubFetch(
      `/repos/${o}/${r}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=all&per_page=20`
    );
    const fromPr = mergeProbeFromPulls(prs);
    if (fromPr) return fromPr;

    const cmp = await githubFetch(
      `/repos/${o}/${r}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
    );
    return mergeProbeFromCompare(cmp, base);
  } catch (err) {
    console.warn(`[merge-probe] skipped for ${head}: ${(err as Error).message}`);
    return { merged: null };
  }
}
