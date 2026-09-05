/**
 * TEAM-3991 D1.2/D1.5 — GitHub-harvested completion evidence, app side.
 *
 * PARITY TWIN of `lambda/orchestrator/evidence.mjs` (the pure half of it: the
 * probe reducer, the branch sweep, and the "does a PR already exist" lookup).
 * Kept lock-step by `src/lib/workflow/evidence-parity.test.ts` — change one, run
 * that test.
 *
 * Two consumers on this side:
 *   - the Workflow Manager's mark-done route, which harvests a dead agent's proof
 *     from GitHub instead of asking a human to retype it, and
 *   - the retry/nudge PR guard, which refuses to re-dispatch an agent onto work it
 *     already has a PR for (prod: TEAM-3790 re-investigated a merged finding).
 *
 * NEVER FABRICATE: no branch and no PR ⇒ `hasEvidence: false` / `null`, and the
 * caller must refuse rather than invent. Every GitHub error degrades to "no
 * answer" (never a throw out of this module), so a token or network problem can
 * only make a caller MORE conservative, never less.
 */

const GITHUB_API = "https://api.github.com";

export interface BranchHead {
  name?: string;
  commit?: { sha?: string };
}
export interface PullRequestLike {
  number?: number;
  html_url?: string;
  state?: string;
  merged_at?: string | null;
  head?: { ref?: string; sha?: string };
}
export interface BranchProbe {
  branch?: string;
  branchHead?: BranchHead | null;
  compare?: { ahead_by?: number } | null;
  prs?: PullRequestLike[];
}
export interface BranchEvidence {
  hasEvidence: boolean;
  branch?: string;
  commitSha?: string;
  prUrl?: string;
  prNumber?: number | null;
  prState?: string;
  aheadBy?: number;
}

/** A GitHub GET returning parsed JSON, or throwing (404s included). */
export type GithubFetch = (path: string) => Promise<unknown>;

/**
 * The default `GithubFetch`: GET api.github.com with the existing GITHUB_PAT (no
 * new secret). Throws on any non-2xx, which every caller here treats as "no
 * answer" — see the module note.
 */
export function githubApi(token = process.env.GITHUB_PAT): GithubFetch {
  return async (path: string) => {
    const res = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "agentcore-hub-workflow-manager",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
    return await res.json();
  };
}

/** `{ owner, repo }` from a workflow's repoConfig, or empty strings. */
export function parseRepo(repoConfig: unknown): { owner: string; repo: string } {
  const url =
    (repoConfig as { repos?: Array<{ url?: string }> } | undefined)?.repos?.[0]?.url || "";
  const m = String(url).match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  return m ? { owner: m[1], repo: m[2] } : { owner: "", repo: "" };
}

/** Every probe call is best-effort: a 404 and a transient are both "no answer". */
async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Reduce one branch probe to an evidence verdict. Evidence = the branch is at
 * least one commit ahead of the base, or a PR exists for it. A merged PR is the
 * strongest proof, then an open one, then whatever is there.
 */
export function evidenceFromBranchProbe(probe: BranchProbe = {}): BranchEvidence {
  const { branch = "", branchHead = null, compare = null, prs = [] } = probe;
  const list = Array.isArray(prs) ? prs : [];
  const aheadBy = Number.isFinite(compare?.ahead_by) ? (compare!.ahead_by as number) : 0;
  const pick = list.find((p) => p?.merged_at) || list.find((p) => p?.state === "open") || list[0] || null;
  return {
    hasEvidence: aheadBy >= 1 || list.length > 0,
    branch: branch || branchHead?.name || pick?.head?.ref || "",
    commitSha: branchHead?.commit?.sha || list[0]?.head?.sha || "",
    prUrl: pick?.html_url || "",
    prNumber: pick?.number ?? null,
    prState: pick ? (pick.merged_at ? "merged" : pick.state || "") : "",
    aheadBy,
  };
}

/** First candidate branch with evidence, else `{ hasEvidence: false }`. */
export async function probeTicketBranches(
  githubFetch: GithubFetch,
  { owner, repo, base = "main", branches = [] }: { owner: string; repo: string; base?: string; branches?: string[] }
): Promise<BranchEvidence> {
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  const tried = new Set<string>();
  for (const branch of Array.isArray(branches) ? branches : []) {
    if (!branch || tried.has(branch)) continue;
    tried.add(branch);
    const b = encodeURIComponent(branch);

    const branchHead = (await attempt(() => githubFetch(`/repos/${o}/${r}/branches/${b}`))) as BranchHead | null;
    if (!branchHead) continue; // 404 — the agent never pushed this one
    const compare = (await attempt(() =>
      githubFetch(`/repos/${o}/${r}/compare/${encodeURIComponent(base)}...${b}`)
    )) as { ahead_by?: number } | null;
    const prs = (await attempt(() =>
      githubFetch(`/repos/${o}/${r}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&per_page=20`)
    )) as PullRequestLike[] | null;

    const ev = evidenceFromBranchProbe({ branch, branchHead, compare, prs: Array.isArray(prs) ? prs : [] });
    if (ev.hasEvidence) return ev;
  }
  return { hasEvidence: false };
}

export interface TicketPullRequest {
  number: number | null;
  url: string;
  state: string;
  merged: boolean;
  headRef: string;
}

/**
 * TEAM-3991 D1.5 — the PR that already exists for a ticket, if any.
 *
 * ONE list call against the base branch, then a client-side match on the head
 * ref: `feature/<ticketId>[-suffix]` (the fleet's branch convention) or the run's
 * shared feature branch. Newest first, and a merged PR outranks an open one — the
 * caller's decision differs, so the strongest state must win when both exist.
 *
 * Returns null on any GitHub error: the callers FAIL OPEN (a retry proceeds), so
 * an unreachable GitHub can never wedge a human's intervention.
 */
export async function findTicketPullRequest(
  githubFetch: GithubFetch | null | undefined,
  {
    owner,
    repo,
    base = "main",
    ticketId = "",
    featureBranch = "",
  }: { owner: string; repo: string; base?: string; ticketId?: string; featureBranch?: string }
): Promise<TicketPullRequest | null> {
  if (!githubFetch || !owner || !repo || !ticketId) return null;
  const o = encodeURIComponent(owner);
  const r = encodeURIComponent(repo);
  const prs = (await attempt(() =>
    githubFetch(
      `/repos/${o}/${r}/pulls?state=all&base=${encodeURIComponent(base)}&per_page=100&sort=updated&direction=desc`
    )
  )) as PullRequestLike[] | null;
  if (!Array.isArray(prs)) return null;

  const prefix = `feature/${ticketId}-`;
  const mine = prs.filter((p) => {
    const ref = p?.head?.ref || "";
    return ref === `feature/${ticketId}` || ref.startsWith(prefix) || (featureBranch !== "" && ref === featureBranch);
  });
  if (mine.length === 0) return null;
  const pick = mine.find((p) => p?.merged_at) || mine.find((p) => p?.state === "open") || mine[0];
  return {
    number: pick.number ?? null,
    url: pick.html_url || "",
    state: pick.merged_at ? "merged" : pick.state || "",
    merged: Boolean(pick.merged_at),
    headRef: pick.head?.ref || "",
  };
}
