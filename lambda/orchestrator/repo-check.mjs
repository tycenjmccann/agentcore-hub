/**
 * Repo URL pre-flight — orchestrator mirror of src/lib/workflow/repo-check.ts.
 *
 * The API checks at submit time; this runs at dispatch for runs that never hit
 * the API (Jira bug bootstrap) and re-checks any run whose stored result is
 * negative, so a fixed URL clears the warning on the next invoke. Keep the
 * warning text in sync with the TS module — it is the first thing every
 * persona reads on an affected run.
 */

const GITHUB_API = "https://api.github.com";

export function parseGitHubUrl(url) {
  const m = String(url || "").match(/github\.com[:/]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function ghHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agentcore-hub-orchestrator-repo-check",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function ghGet(path, opts) {
  const f = opts.fetchImpl || fetch;
  const res = await f(`${GITHUB_API}${path}`, {
    method: "GET",
    headers: ghHeaders(opts.token),
    signal: AbortSignal.timeout(opts.timeoutMs || 8000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  // res.url/res.redirected expose a followed 301 (renamed/transferred repo); fetch
  // follows redirects by default, so the body's full_name is already canonical.
  return { status: res.status, json, url: res.url, redirected: res.redirected };
}

async function suggestGitHub(owner, repo, opts) {
  const suggestions = new Set();
  let ownerExists = false;
  const want = repo.toLowerCase();
  const probes = [
    ghGet(`/users/${encodeURIComponent(owner)}`, opts).then((r) => { ownerExists = r.status === 200; }).catch(() => undefined),
  ];
  if (opts.fallbackOwner && opts.fallbackOwner.toLowerCase() !== owner.toLowerCase()) {
    probes.push(
      ghGet(`/repos/${encodeURIComponent(opts.fallbackOwner)}/${encodeURIComponent(repo)}`, opts)
        .then((r) => { if (r.status === 200 && r.json?.full_name) suggestions.add(r.json.full_name); })
        .catch(() => undefined)
    );
  }
  if (opts.token) {
    probes.push(
      ghGet(`/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`, opts)
        .then((r) => {
          if (r.status !== 200 || !Array.isArray(r.json)) return;
          for (const item of r.json) {
            if (item?.name?.toLowerCase() === want && item.full_name) suggestions.add(item.full_name);
          }
        })
        .catch(() => undefined)
    );
  }
  await Promise.all(probes);
  return { ownerExists, suggestions: [...suggestions] };
}

export async function checkRepoUrl(url, opts = {}) {
  const gh = parseGitHubUrl(url);
  if (!gh) {
    try {
      const f = opts.fetchImpl || fetch;
      const res = await f(url, { method: "HEAD", signal: AbortSignal.timeout(opts.timeoutMs || 8000) });
      return res.status < 400
        ? { url, ok: true, definitive: true, status: res.status, reason: "reachable" }
        : { url, ok: false, definitive: false, status: res.status, reason: `HTTP ${res.status} on HEAD` };
    } catch (err) {
      return { url, ok: false, definitive: false, status: null, reason: `unreachable: ${err.message}` };
    }
  }
  const { owner, repo } = gh;
  let res;
  try {
    res = await ghGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, opts);
  } catch (err) {
    return { url, ok: false, definitive: false, status: null, owner, repo, reason: `GitHub unreachable: ${err.message}` };
  }
  const { status, json } = res;
  if (status === 200) {
    // Keep the body: default_branch feeds resolveDefaultBranch (no more hardcoded
    // "main"), and full_name is the canonical owner/name after any rename.
    const fullName = typeof json?.full_name === "string" ? json.full_name : undefined;
    const defaultBranch = typeof json?.default_branch === "string" ? json.default_branch : undefined;
    const canon = fullName && fullName.includes("/") ? { owner: fullName.split("/")[0], repo: fullName.split("/")[1] } : null;
    const requested = `${owner}/${repo}`.toLowerCase();
    const renamed = Boolean(res.redirected) || (fullName ? fullName.toLowerCase() !== requested : false);
    return {
      url, ok: true, definitive: true, status,
      owner: canon?.owner || owner,
      repo: canon?.repo || repo,
      reason: "found",
      ...(fullName ? { fullName } : {}),
      ...(defaultBranch ? { defaultBranch } : {}),
      renamed,
    };
  }
  if (status === 404) {
    const { ownerExists, suggestions } = await suggestGitHub(owner, repo, opts);
    const reason = opts.token
      ? `GitHub 404: ${owner}/${repo} not found${ownerExists ? "" : ` (owner "${owner}" does not exist)`}`
      : `GitHub 404 without a token — ${owner}/${repo} is missing or private`;
    return { url, ok: false, definitive: Boolean(opts.token), status, owner, repo, ownerExists, suggestions, reason };
  }
  return { url, ok: false, definitive: false, status, owner, repo, reason: `GitHub ${status} — could not verify` };
}

export async function checkRepoConfig(repoConfig, opts = {}) {
  const urls = [...new Set((repoConfig?.repos || []).map((r) => r?.url).filter(Boolean))];
  const results = await Promise.all(urls.map((u) => checkRepoUrl(u, opts)));
  return { checkedAt: new Date().toISOString(), results };
}

export function formatRepoCheckWarning(check) {
  const bad = (check?.results || []).filter((r) => !r.ok);
  if (bad.length === 0) return "";
  const suggestions = [...new Set(bad.flatMap((f) => f.suggestions || []))];
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

/**
 * Resolve the repo check for a workflow at dispatch time, cheaply:
 *   - stored result clean and for the current URLs → reuse (no network)
 *   - stored result negative, stale, or absent → re-check now and persist
 * Returns the check ({checkedAt, results}) or null when there are no repos /
 * REPO_CHECK_MODE=off. Never throws — a check failure degrades to "no warning".
 */
export async function ensureRepoCheck(workflow, { store, env = process.env, fetchImpl } = {}) {
  if (env.REPO_CHECK_MODE === "off") return null;
  const urls = (workflow?.repoConfig?.repos || []).map((r) => r?.url).filter(Boolean);
  if (urls.length === 0) return null;
  const stored = workflow.repoCheck;
  const storedUrls = new Set((stored?.results || []).map((r) => r.url));
  const storedCoversCurrent = urls.every((u) => storedUrls.has(u));
  if (stored && storedCoversCurrent && stored.results.every((r) => r.ok)) return stored;
  try {
    const check = await checkRepoConfig(workflow.repoConfig, {
      token: env.GITHUB_PAT,
      fallbackOwner: env.GITHUB_OWNER,
      fetchImpl,
    });
    if (store?.setRepoCheck) {
      try { await store.setRepoCheck(workflow.id || workflow.workflowId, check); } catch (err) {
        console.warn(`[orchestrator] repo-check persist failed for ${workflow.id}: ${err.message}`);
      }
    }
    const bad = check.results.filter((r) => !r.ok);
    if (bad.length) console.warn(`[orchestrator] repo-check ${workflow.id}: ${bad.map((b) => `${b.url} → ${b.reason}`).join("; ")}`);
    return check;
  } catch (err) {
    console.warn(`[orchestrator] repo-check skipped for ${workflow?.id}: ${err.message}`);
    return stored || null;
  }
}

// ─── Branch-protection preflight (TEAM-3991 D1.1) ─────────────────────────────

/**
 * A Merge Approval gate is only as strong as the base branch. If `main` requires
 * no PR and no approving review, the gate is advisory: an agent can push straight
 * to it and the run's "approval" never happened. This is the pure classifier —
 * mirrored byte-for-byte in src/lib/workflow/repo-check.ts (pinned by
 * src/lib/workflow/repo-check-parity.test.ts).
 *
 * `protected` means specifically "merge-gate protected": a PR is required AND at
 * least one approving review is. An UNREADABLE answer (token without admin
 * scope) is never reported as protected — but it is not reported as unprotected
 * either; source tells the caller which it is.
 */
export const PROTECTION_REQUIREMENTS = ["require_pr", "required_approvals", "enforce_admins", "block_force_push"];

export function classifyProtection({ protectionStatus, protectionJson, rulesStatus, rulesJson } = {}) {
  const blank = {
    protected: false,
    requiresPr: false,
    requiredApprovals: 0,
    enforceAdmins: false,
    source: "none",
    missing: [...PROTECTION_REQUIREMENTS],
  };

  // Classic branch protection — the authoritative source when readable.
  if (protectionStatus === 200 && protectionJson && typeof protectionJson === "object") {
    const reviews = protectionJson.required_pull_request_reviews;
    const requiresPr = Boolean(reviews);
    const requiredApprovals = Number(reviews?.required_approving_review_count) || 0;
    const enforceAdmins = Boolean(protectionJson.enforce_admins?.enabled);
    const blockForcePush = protectionJson.allow_force_pushes?.enabled === false;
    const missing = [];
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
    if (rulesJson.length === 0) return blank;
    const prRule = rulesJson.find((r) => r?.type === "pull_request");
    const requiresPr = Boolean(prRule);
    const requiredApprovals = Number(prRule?.parameters?.required_approving_review_count) || 0;
    const nonFastForward = rulesJson.some((r) => r?.type === "non_fast_forward");
    const deletion = rulesJson.some((r) => r?.type === "deletion");
    const missing = [];
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
 * source "unreadable" with the error attached. Uses the same ghGet seam as the
 * repo URL check, so tests inject fetchImpl.
 */
export async function checkBranchProtection({ owner, repo, branch }, opts = {}) {
  const o = encodeURIComponent(owner || "");
  const r = encodeURIComponent(repo || "");
  const b = encodeURIComponent(branch || "");
  const withToken = { ...opts, token: opts.token || process.env.GITHUB_PAT };
  let protectionStatus = null;
  let protectionJson = null;
  let rulesStatus = null;
  let rulesJson = null;
  let error;
  try {
    ({ status: protectionStatus, json: protectionJson } = await ghGet(`/repos/${o}/${r}/branches/${b}/protection`, withToken));
  } catch (err) {
    error = err?.message || String(err);
  }
  if (protectionStatus !== 200) {
    try {
      ({ status: rulesStatus, json: rulesJson } = await ghGet(`/repos/${o}/${r}/rules/branches/${b}`, withToken));
    } catch (err) {
      error = error || err?.message || String(err);
    }
  }
  const result = classifyProtection({ protectionStatus, protectionJson, rulesStatus, rulesJson });
  if (error && result.source === "none") {
    result.source = "unreadable";
    result.protected = false;
  }
  return { ...result, branch, protectionStatus, rulesStatus, ...(error ? { error } : {}) };
}
