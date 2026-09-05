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

// ─── Branch-protection preflight (TEAM-3991 D1.1) ─────────────────────────────

export type ProtectionSource = "protection" | "rules" | "none" | "unreadable";

export interface ProtectionResult {
  protected: boolean;
  requiresPr: boolean;
  requiredApprovals: number;
  enforceAdmins: boolean;
  source: ProtectionSource;
  missing: string[];
}

export interface ProtectionProbe {
  protectionStatus?: number | null;
  protectionJson?: unknown;
  rulesStatus?: number | null;
  rulesJson?: unknown;
}

/**
 * A Merge Approval gate is only as strong as the base branch. If `main` requires
 * no PR and no approving review, the gate is advisory: an agent can push straight
 * to it and the run's "approval" never happened.
 *
 * `protected` means specifically "merge-gate protected": a PR is required AND at
 * least one approving review is. An UNREADABLE answer (token without admin
 * scope) is never reported as protected — but it is not reported as unprotected
 * either; `source` tells the caller which it is.
 *
 * Mirrored byte-for-byte in lambda/orchestrator/repo-check.mjs; the twins are
 * pinned by repo-check-parity.test.ts.
 */
export const PROTECTION_REQUIREMENTS = ["require_pr", "required_approvals", "enforce_admins", "block_force_push"];

export function classifyProtection({ protectionStatus, protectionJson, rulesStatus, rulesJson }: ProtectionProbe = {}): ProtectionResult {
  const blank: ProtectionResult = {
    protected: false,
    requiresPr: false,
    requiredApprovals: 0,
    enforceAdmins: false,
    source: "none",
    missing: [...PROTECTION_REQUIREMENTS],
  };

  // Classic branch protection — the authoritative source when readable.
  if (protectionStatus === 200 && protectionJson && typeof protectionJson === "object") {
    const p = protectionJson as {
      required_pull_request_reviews?: { required_approving_review_count?: number };
      enforce_admins?: { enabled?: boolean };
      allow_force_pushes?: { enabled?: boolean };
    };
    const reviews = p.required_pull_request_reviews;
    const requiresPr = Boolean(reviews);
    const requiredApprovals = Number(reviews?.required_approving_review_count) || 0;
    const enforceAdmins = Boolean(p.enforce_admins?.enabled);
    const blockForcePush = p.allow_force_pushes?.enabled === false;
    const missing: string[] = [];
    if (!requiresPr) missing.push("require_pr");
    if (requiredApprovals < 1) missing.push("required_approvals");
    if (!enforceAdmins) missing.push("enforce_admins");
    if (!blockForcePush) missing.push("block_force_push");
    return {
      protected: requiresPr && requiredApprovals >= 1,
      requiresPr,
      requiredApprovals,
      enforceAdmins,
      source: "protection",
      missing,
    };
  }

  // Rulesets — what a repo on the newer model returns (and readable without
  // admin scope). An empty array is a definite "no rules apply to this branch".
  if (rulesStatus === 200 && Array.isArray(rulesJson)) {
    const rules = rulesJson as Array<{ type?: string; parameters?: { required_approving_review_count?: number } }>;
    if (rules.length === 0) return blank;
    const prRule = rules.find((r) => r?.type === "pull_request");
    const requiresPr = Boolean(prRule);
    const requiredApprovals = Number(prRule?.parameters?.required_approving_review_count) || 0;
    const nonFastForward = rules.some((r) => r?.type === "non_fast_forward");
    const deletion = rules.some((r) => r?.type === "deletion");
    const missing: string[] = [];
    if (!requiresPr) missing.push("require_pr");
    if (requiredApprovals < 1) missing.push("required_approvals");
    // The rules endpoint reports the effective rules, not who may bypass them,
    // so admin enforcement is unknowable here — reported as missing, honestly.
    missing.push("enforce_admins");
    if (!(nonFastForward && deletion)) missing.push("block_force_push");
    return {
      protected: requiresPr && requiredApprovals >= 1,
      requiresPr,
      requiredApprovals,
      enforceAdmins: false,
      source: "rules",
      missing,
    };
  }

  // 404 on both: the branch genuinely has neither protection nor rulesets.
  if (protectionStatus === 404 && (rulesStatus === 404 || rulesStatus === 200)) return blank;
  // Anything else (401/403, 5xx, no answer) — we simply do not know.
  return { ...blank, source: "unreadable" };
}

/**
 * Probe a branch's protection. Never throws: any transport failure degrades to
 * source "unreadable" with the error attached.
 */
export async function checkBranchProtection(
  { owner, repo, branch }: { owner: string; repo: string; branch: string },
  opts: RepoCheckOptions = {}
): Promise<ProtectionResult & { branch: string; protectionStatus: number | null; rulesStatus: number | null; error?: string }> {
  const o = encodeURIComponent(owner || "");
  const r = encodeURIComponent(repo || "");
  const b = encodeURIComponent(branch || "");
  const withToken: RepoCheckOptions = { ...opts, token: opts.token || process.env.GITHUB_PAT };
  let protectionStatus: number | null = null;
  let protectionJson: unknown = null;
  let rulesStatus: number | null = null;
  let rulesJson: unknown = null;
  let error: string | undefined;
  try {
    ({ status: protectionStatus, json: protectionJson } = await ghGet(`/repos/${o}/${r}/branches/${b}/protection`, withToken));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  if (protectionStatus !== 200) {
    try {
      ({ status: rulesStatus, json: rulesJson } = await ghGet(`/repos/${o}/${r}/rules/branches/${b}`, withToken));
    } catch (err) {
      error = error || (err instanceof Error ? err.message : String(err));
    }
  }
  const result = classifyProtection({ protectionStatus, protectionJson, rulesStatus, rulesJson });
  if (error && result.source === "none") {
    result.source = "unreadable";
    result.protected = false;
  }
  return { ...result, branch, protectionStatus, rulesStatus, ...(error ? { error } : {}) };
}
