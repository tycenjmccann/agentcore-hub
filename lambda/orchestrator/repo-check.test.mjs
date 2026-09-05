import { describe, it, expect } from "vitest";
import {
  checkRepoUrl,
  ensureRepoCheck,
  formatRepoCheckWarning,
  parseGitHubUrl,
  classifyProtection,
  checkBranchProtection,
  PROTECTION_REQUIREMENTS,
} from "./repo-check.mjs";

/**
 * Dispatch-time mirror of the submit-time pre-flight. ensureRepoCheck is the
 * policy under test: reuse a clean stored result (no network), re-check a
 * negative/stale/absent one and persist it, honor REPO_CHECK_MODE=off, and
 * never throw into invokeAgent.
 */
function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push(`${init?.method || "GET"} ${url}`);
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    const r = hit ? hit[1] : { status: 404, json: { message: "Not Found" } };
    return { status: r.status, ok: r.status < 400, json: async () => r.json ?? {} };
  };
}
const BAD = "https://github.com/tycenj/agentcore-hub";
const GOOD = "https://github.com/tycenjmccann/agentcore-hub";
const wf = (url, repoCheck) => ({ id: "wf_1", repoConfig: { repos: [{ url, defaultBranch: "main" }] }, ...(repoCheck ? { repoCheck } : {}) });
const env = { GITHUB_PAT: "t", GITHUB_OWNER: "tycenjmccann" };
const routes = {
  "/repos/tycenj/agentcore-hub": { status: 404 },
  "/users/tycenj": { status: 404 },
  "/repos/tycenjmccann/agentcore-hub": { status: 200, json: { full_name: "tycenjmccann/agentcore-hub" } },
  "/user/repos": { status: 200, json: [{ name: "agentcore-hub", full_name: "tycenjmccann/agentcore-hub" }] },
};

describe("repo-check.mjs parity", () => {
  it("parses the same URL forms as the TS module", () => {
    expect(parseGitHubUrl("git@github.com:tycenjmccann/agentcore-hub.git")).toEqual({ owner: "tycenjmccann", repo: "agentcore-hub" });
    expect(parseGitHubUrl("https://gitlab.com/x/y")).toBeNull();
  });
  it("authenticated 404 → definitive, with the GITHUB_OWNER did-you-mean", async () => {
    const r = await checkRepoUrl(BAD, { token: "t", fallbackOwner: "tycenjmccann", fetchImpl: fakeFetch(routes) });
    expect(r).toMatchObject({ ok: false, definitive: true, status: 404, ownerExists: false, suggestions: ["tycenjmccann/agentcore-hub"] });
  });
});

describe("ensureRepoCheck", () => {
  it("absent stored result → checks, persists via store.setRepoCheck, returns the negative", async () => {
    const calls = [], saved = [];
    const store = { setRepoCheck: async (id, rc) => saved.push([id, rc]) };
    const check = await ensureRepoCheck(wf(BAD), { store, env, fetchImpl: fakeFetch(routes, calls) });
    expect(check.results[0]).toMatchObject({ url: BAD, ok: false, definitive: true });
    expect(saved.length).toBe(1);
    expect(saved[0][0]).toBe("wf_1");
    expect(calls.some((c) => c.includes("/repos/tycenj/agentcore-hub"))).toBe(true);
    expect(formatRepoCheckWarning(check)).toMatch(/NOT a coding-runtime outage/);
  });

  it("clean stored result for the current URL → reused, zero network, zero writes", async () => {
    const calls = [], saved = [];
    const stored = { checkedAt: "x", results: [{ url: GOOD, ok: true, definitive: true, status: 200, reason: "found" }] };
    const check = await ensureRepoCheck(wf(GOOD, stored), { store: { setRepoCheck: async (...a) => saved.push(a) }, env, fetchImpl: fakeFetch(routes, calls) });
    expect(check).toBe(stored);
    expect(calls.length).toBe(0);
    expect(saved.length).toBe(0);
    expect(formatRepoCheckWarning(check)).toBe("");
  });

  it("negative stored result → re-checked every dispatch, so a fixed URL clears the warning", async () => {
    const stored = { checkedAt: "x", results: [{ url: BAD, ok: false, definitive: true, status: 404, reason: "GitHub 404" }] };
    // Operator fixed repoConfig to GOOD; stored check is for BAD → stale → re-check → clean.
    const check = await ensureRepoCheck(wf(GOOD, stored), { store: { setRepoCheck: async () => {} }, env, fetchImpl: fakeFetch(routes) });
    expect(check.results[0]).toMatchObject({ url: GOOD, ok: true });
    expect(formatRepoCheckWarning(check)).toBe("");
  });

  it("REPO_CHECK_MODE=off / no repos → null; checker or store failures never throw", async () => {
    expect(await ensureRepoCheck(wf(BAD), { env: { ...env, REPO_CHECK_MODE: "off" } })).toBeNull();
    expect(await ensureRepoCheck({ id: "wf_2", repoConfig: { repos: [] } }, { env })).toBeNull();
    const boomStore = { setRepoCheck: async () => { throw new Error("ddb down"); } };
    const check = await ensureRepoCheck(wf(BAD), { store: boomStore, env, fetchImpl: fakeFetch(routes) });
    expect(check.results[0].ok).toBe(false);
    const stored = { checkedAt: "x", results: [{ url: BAD, ok: false, definitive: true, status: 404, reason: "GitHub 404" }] };
    const fallback = await ensureRepoCheck(wf(BAD, stored), { env, fetchImpl: async () => { throw new Error("net"); } });
    // fetch threw inside checkRepoUrl → classified as a soft failure, still a usable check
    expect(fallback.results[0]).toMatchObject({ url: BAD, ok: false, definitive: false });
  });
});

/**
 * TEAM-3991 D1.1 branch-protection preflight. The gate-bypass detector answers
 * "did a merge land without approval"; this answers the prior question "could
 * it?" — an unprotected default branch is the precondition, so the run says so
 * once at dispatch instead of after the fact. classifyProtection is pure (the
 * TS twin src/lib/workflow/repo-check.ts is pinned to it by
 * src/lib/workflow/repo-check-parity.test.ts) and checkBranchProtection must
 * NEVER throw: "we do not know" (unreadable) is a real answer, and it must
 * never be mistaken for "not protected".
 */
const FULL_PROTECTION = {
  required_pull_request_reviews: { required_approving_review_count: 1 },
  enforce_admins: { enabled: true },
  allow_force_pushes: { enabled: false },
};

describe("classifyProtection", () => {
  it("protection 200, fully configured → source protection, protected, nothing missing", () => {
    const r = classifyProtection({ protectionStatus: 200, protectionJson: FULL_PROTECTION });
    expect(r).toEqual({ protected: true, requiresPr: true, requiredApprovals: 1, enforceAdmins: true, source: "protection", missing: [] });
  });

  it("protection 200 with reviews but 0 approvals → NOT protected (a PR nobody must approve is not a gate)", () => {
    const r = classifyProtection({
      protectionStatus: 200,
      protectionJson: { required_pull_request_reviews: { required_approving_review_count: 0 }, enforce_admins: { enabled: false }, allow_force_pushes: { enabled: true } },
    });
    expect(r.protected).toBe(false);
    expect(r.requiresPr).toBe(true);
    expect(r.missing).toEqual(["required_approvals", "enforce_admins", "block_force_push"]);
  });

  it("protection 404 + rules 200 → source rules; enforce_admins is always reported missing (unknowable there)", () => {
    const r = classifyProtection({
      protectionStatus: 404,
      rulesStatus: 200,
      rulesJson: [
        { type: "pull_request", parameters: { required_approving_review_count: 2 } },
        { type: "non_fast_forward" },
        { type: "deletion" },
      ],
    });
    expect(r).toEqual({ protected: true, requiresPr: true, requiredApprovals: 2, enforceAdmins: false, source: "rules", missing: ["enforce_admins"] });
  });

  it("rules 200 with an empty array → a definite 'none', every requirement missing", () => {
    const r = classifyProtection({ protectionStatus: 404, rulesStatus: 200, rulesJson: [] });
    expect(r.source).toBe("none");
    expect(r.protected).toBe(false);
    expect(r.missing).toEqual([...PROTECTION_REQUIREMENTS]);
  });

  it("403 on protection AND a non-200 rules answer → unreadable, never 'not protected'", () => {
    for (const probe of [
      { protectionStatus: 403, rulesStatus: 403 },
      { protectionStatus: 401, rulesStatus: 500 },
      { protectionStatus: null, rulesStatus: null },
    ]) {
      const r = classifyProtection(probe);
      expect(r.source).toBe("unreadable");
      expect(r.protected).toBe(false);
    }
    // 404 on protection is different: it is GitHub saying "no protection here".
    expect(classifyProtection({ protectionStatus: 404, rulesStatus: 404 }).source).toBe("none");
  });
});

describe("checkBranchProtection", () => {
  const target = { owner: "tycenjmccann", repo: "agentcore-hub", branch: "main" };

  it("reads classic protection first and does not call the rules endpoint", async () => {
    const calls = [];
    const r = await checkBranchProtection(target, {
      token: "t",
      fetchImpl: fakeFetch({ "/branches/main/protection": { status: 200, json: FULL_PROTECTION } }, calls),
    });
    expect(r).toMatchObject({ source: "protection", protected: true, branch: "main", protectionStatus: 200, rulesStatus: null });
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("/repos/tycenjmccann/agentcore-hub/branches/main/protection");
  });

  it("falls back to rulesets on a 404 protection", async () => {
    const calls = [];
    const r = await checkBranchProtection(target, {
      token: "t",
      fetchImpl: fakeFetch({ "/rules/branches/main": { status: 200, json: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }] } }, calls),
    });
    expect(r).toMatchObject({ source: "rules", protected: true, protectionStatus: 404, rulesStatus: 200 });
    expect(calls.length).toBe(2);
  });

  it("403 on both → unreadable with no verdict; a thrown fetch degrades the same way", async () => {
    const r = await checkBranchProtection(target, {
      token: "t",
      fetchImpl: fakeFetch({ "/repos/tycenjmccann/agentcore-hub": { status: 403, json: { message: "Resource not accessible by personal access token" } } }),
    });
    expect(r).toMatchObject({ source: "unreadable", protected: false });

    const boom = await checkBranchProtection(target, { token: "t", fetchImpl: async () => { throw new Error("ETIMEDOUT"); } });
    expect(boom.source).toBe("unreadable");
    expect(boom.protected).toBe(false);
    expect(boom.error).toBe("ETIMEDOUT");
  });

  it("URL-encodes every path segment, so a slashed/dotted branch cannot escape the path", async () => {
    const calls = [];
    await checkBranchProtection({ owner: "own er", repo: "re/po", branch: "feature/x..y" }, { token: "t", fetchImpl: fakeFetch({}, calls) });
    expect(calls[0]).toContain("/repos/own%20er/re%2Fpo/branches/feature%2Fx..y/protection");
    expect(calls[0]).not.toContain("/x..y/");
  });
});
