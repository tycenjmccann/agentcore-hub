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
  return { status: res.status, json };
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
  let status;
  try {
    ({ status } = await ghGet(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, opts));
  } catch (err) {
    return { url, ok: false, definitive: false, status: null, owner, repo, reason: `GitHub unreachable: ${err.message}` };
  }
  if (status === 200) return { url, ok: true, definitive: true, status, owner, repo, reason: "found" };
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
