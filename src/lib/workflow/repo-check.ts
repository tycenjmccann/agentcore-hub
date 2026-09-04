/**
 * Repo URL pre-flight.
 *
 * A mistyped repository owner (`tycenj/…` for `tycenjmccann/…`) cost a full
 * day of pipeline time on 2026-09-03: the coding runtime's clone 404'd, the
 * fleet wrapper reported it as "coding turn vanished", and the personas
 * concluded every coding engine was down. Nothing along the chain ever asked
 * GitHub whether the URL existed. This module does, once, at submit time (and
 * the orchestrator mirrors it in lambda/orchestrator/repo-check.mjs at first
 * dispatch for runs that bypass the API, e.g. Jira bug bootstrap).
 *
 * Semantics:
 *   - `ok`          the repo resolved (GitHub 200, or a non-GitHub URL answered <400).
 *   - `definitive`  a negative we can trust. Only an AUTHENTICATED GitHub 404 is
 *                   definitive — an unauthenticated 404 is what GitHub returns
 *                   for a private repo, so without a token we only warn.
 *   - `suggestions` "owner/name" candidates when the name exists under the
 *                   configured owner or among the token's repos — the typo case.
 */

export interface RepoCheckResult {
  url: string;
  ok: boolean;
  definitive: boolean;
  status: number | null;
  reason: string;
  owner?: string;
  repo?: string;
  ownerExists?: boolean;
  suggestions?: string[];
}

export interface RepoCheck {
  checkedAt: string;
  results: RepoCheckResult[];
}

export interface RepoCheckOptions {
  /** GitHub token (GITHUB_PAT). Without it, GitHub negatives are non-definitive. */
  token?: string;
  /** Owner to try the same repo name under when the given owner 404s (GITHUB_OWNER). */
  fallbackOwner?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const GITHUB_API = "https://api.github.com";

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const m = String(url || "").match(/github\.com[:/]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function ghHeaders(token?: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agentcore-hub-repo-check",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function ghGet(
  path: string,
  opts: RepoCheckOptions
): Promise<{ status: number; json: unknown }> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${GITHUB_API}${path}`, {
    method: "GET",
    headers: ghHeaders(opts.token),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json };
}

async function suggestGitHub(
  owner: string,
  repo: string,
  opts: RepoCheckOptions
): Promise<{ ownerExists: boolean; suggestions: string[] }> {
  const suggestions = new Set<string>();
  let ownerExists = false;
  const want = repo.toLowerCase();

  const probes: Promise<void>[] = [
    ghGet(`/users/${encodeURIComponent(owner)}`, opts)
      .then((r) => {
        ownerExists = r.status === 200;
      })
      .catch(() => undefined),
  ];
  if (opts.fallbackOwner && opts.fallbackOwner.toLowerCase() !== owner.toLowerCase()) {
    probes.push(
      ghGet(`/repos/${encodeURIComponent(opts.fallbackOwner)}/${encodeURIComponent(repo)}`, opts)
        .then((r) => {
          const fullName = (r.json as { full_name?: string } | null)?.full_name;
          if (r.status === 200 && fullName) suggestions.add(fullName);
        })
        .catch(() => undefined)
    );
  }
  if (opts.token) {
    probes.push(
      ghGet(`/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`, opts)
        .then((r) => {
          if (r.status !== 200 || !Array.isArray(r.json)) return;
          for (const item of r.json as Array<{ name?: string; full_name?: string }>) {
            if (item?.name?.toLowerCase() === want && item.full_name) suggestions.add(item.full_name);
          }
        })
        .catch(() => undefined)
    );
  }
  await Promise.all(probes);
  return { ownerExists, suggestions: [...suggestions] };
}

export async function checkRepoUrl(url: string, opts: RepoCheckOptions = {}): Promise<RepoCheckResult> {
  const gh = parseGitHubUrl(url);
  if (!gh) {
    // Non-GitHub remote: a plain reachability probe. Never definitive — private
    // hosts legitimately answer 401/403/404 to anonymous HEADs.
    try {
      const f = opts.fetchImpl ?? fetch;
      const res = await f(url, { method: "HEAD", signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
      return res.status < 400
        ? { url, ok: true, definitive: true, status: res.status, reason: "reachable" }
        : { url, ok: false, definitive: false, status: res.status, reason: `HTTP ${res.status} on HEAD` };
    } catch (err) {
      return { url, ok: false, definitive: false, status: null, reason: `unreachable: ${(err as Error).message}` };
    }
  }

  const { owner, repo } = gh;
  let status: number;
  try {
    ({ status } = await ghGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, opts));
  } catch (err) {
    return { url, ok: false, definitive: false, status: null, owner, repo, reason: `GitHub unreachable: ${(err as Error).message}` };
  }

  if (status === 200) return { url, ok: true, definitive: true, status, owner, repo, reason: "found" };

  if (status === 404) {
    const { ownerExists, suggestions } = await suggestGitHub(owner, repo, opts);
    const reason = opts.token
      ? `GitHub 404: ${owner}/${repo} not found${ownerExists ? "" : ` (owner "${owner}" does not exist)`}`
      : `GitHub 404 without a token — ${owner}/${repo} is missing or private`;
    return { url, ok: false, definitive: Boolean(opts.token), status, owner, repo, ownerExists, suggestions, reason };
  }

  // 401/403 (bad token, rate limit) / 5xx: we learned nothing about the URL.
  return { url, ok: false, definitive: false, status, owner, repo, reason: `GitHub ${status} — could not verify` };
}

export async function checkRepoConfig(
  repoConfig: { repos?: Array<{ url?: string }> } | undefined,
  opts: RepoCheckOptions = {}
): Promise<RepoCheck> {
  const urls = [...new Set((repoConfig?.repos ?? []).map((r) => r?.url).filter((u): u is string => Boolean(u)))];
  const results = await Promise.all(urls.map((u) => checkRepoUrl(u, opts)));
  return { checkedAt: new Date().toISOString(), results };
}

/** Definitive negatives only — the ones a submitter must fix or explicitly waive. */
export function definitiveFailures(check: RepoCheck): RepoCheckResult[] {
  return check.results.filter((r) => !r.ok && r.definitive);
}

/** Human-facing 422 body. */
export function describeRepoCheckFailure(failures: RepoCheckResult[]): { error: string; details: string[]; suggestions: string[]; hint: string } {
  const suggestions = [...new Set(failures.flatMap((f) => f.suggestions ?? []))];
  return {
    error: "Repository URL did not resolve",
    details: failures.map((f) => `${f.url} — ${f.reason}`),
    suggestions,
    hint:
      (suggestions.length ? `Did you mean: ${suggestions.map((s) => `https://github.com/${s}`).join(", ")}? ` : "") +
      "Fix the repoConfig URL (typo?) and resubmit, or pass allowUnresolvedRepo:true to let the intake agent hunt for the right repo and escalate if it can't.",
  };
}

/**
 * Agent-facing warning, prepended to the FIRST thing every persona reads on a
 * run whose repo did not resolve. Mirrored verbatim in the orchestrator's
 * repo-check.mjs — keep the two in sync.
 */
export function formatRepoCheckWarning(check: RepoCheck): string {
  const bad = check.results.filter((r) => !r.ok);
  if (bad.length === 0) return "";
  const suggestions = [...new Set(bad.flatMap((f) => f.suggestions ?? []))];
  const lines = [
    "## ⚠️ REPOSITORY URL DID NOT RESOLVE — READ THIS FIRST",
    "The repository configured for this workflow could not be verified:",
    ...bad.map((f) => `- ${f.url} → ${f.reason}`),
    suggestions.length
      ? `Likely a typo in the submission. Matching repositories visible to the hub: ${suggestions.map((s) => `https://github.com/${s}`).join(", ")}`
      : "Likely a typo in the submission (or a private repo the hub token cannot see).",
    "",
    "Before ANY coding tool call (claude_code / codex / kiro / git):",
    "1. Do NOT retry the configured URL. A clone of it fails identically on every engine — that is a bad URL, NOT a coding-runtime outage, and must not be escalated as one.",
    "2. Identify the correct repository: prefer the candidates above; otherwise search GitHub under the hub's own identity for the repo name.",
    "3. If you can identify it with confidence, use it for every git/coding call, and state the correction (old → new URL) in a ticket comment and in your completion summary so the operator can fix the workflow's repoConfig.",
    "4. If you cannot, STOP. Block your ticket with reason \"repo URL unresolvable: <url>\" and escalate to a human via the Tickets tools. Do not guess a repo and do not attempt the fix from the description alone.",
    "",
  ];
  return lines.join("\n") + "\n";
}
