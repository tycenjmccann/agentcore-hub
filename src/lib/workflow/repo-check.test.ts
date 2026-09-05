import { describe, it, expect } from "vitest";
import {
  parseGitHubUrl,
  checkRepoUrl,
  checkRepoConfig,
  definitiveFailures,
  describeRepoCheckFailure,
  formatRepoCheckWarning,
  classifyProtection,
  checkBranchProtection,
  PROTECTION_REQUIREMENTS,
} from "./repo-check";

/**
 * The 2026-09-03 incident in miniature: `tycenj/agentcore-hub` was submitted
 * for `tycenjmccann/agentcore-hub`. Nothing asked GitHub, the clone 404'd on
 * every coding engine, and the personas escalated a fake runtime outage.
 * These pin the pre-flight that now asks.
 */

type Route = { status: number; json?: unknown; url?: string; redirected?: boolean };
function fakeFetch(routes: Record<string, Route>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method || "GET"} ${url}`);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const r: Route = hit ? hit[1] : { status: 404, json: { message: "Not Found" } };
    return {
      status: r.status,
      ok: r.status < 400,
      // url/redirected model a followed 301 for the D4.1 rename-detection tests.
      url: r.url ?? url,
      redirected: r.redirected ?? false,
      json: async () => r.json ?? {},
    } as unknown as Response;
  }) as typeof fetch;
}

describe("parseGitHubUrl", () => {
  it("handles https, .git, trailing slash and ssh forms", () => {
    expect(parseGitHubUrl("https://github.com/tycenjmccann/agentcore-hub")).toEqual({ owner: "tycenjmccann", repo: "agentcore-hub" });
    expect(parseGitHubUrl("https://github.com/tycenjmccann/agentcore-hub.git")).toEqual({ owner: "tycenjmccann", repo: "agentcore-hub" });
    expect(parseGitHubUrl("https://github.com/tycenjmccann/agentcore-hub/")).toEqual({ owner: "tycenjmccann", repo: "agentcore-hub" });
    expect(parseGitHubUrl("git@github.com:tycenjmccann/agentcore-hub.git")).toEqual({ owner: "tycenjmccann", repo: "agentcore-hub" });
    expect(parseGitHubUrl("https://gitlab.com/x/y")).toBeNull();
  });
});

describe("checkRepoUrl — GitHub", () => {
  it("200 → ok, definitive", async () => {
    const r = await checkRepoUrl("https://github.com/tycenjmccann/agentcore-hub", {
      token: "t",
      fetchImpl: fakeFetch({ "/repos/tycenjmccann/agentcore-hub": { status: 200, json: { full_name: "tycenjmccann/agentcore-hub" } } }),
    });
    expect(r.ok).toBe(true);
    expect(r.definitive).toBe(true);
  });

  it("authenticated 404 → definitive failure with the GITHUB_OWNER did-you-mean", async () => {
    const calls: string[] = [];
    const r = await checkRepoUrl("https://github.com/tycenj/agentcore-hub", {
      token: "t",
      fallbackOwner: "tycenjmccann",
      fetchImpl: fakeFetch(
        {
          "/repos/tycenj/agentcore-hub": { status: 404 },
          "/users/tycenj": { status: 404 },
          "/repos/tycenjmccann/agentcore-hub": { status: 200, json: { full_name: "tycenjmccann/agentcore-hub" } },
          "/user/repos": { status: 200, json: [{ name: "agentcore-hub", full_name: "tycenjmccann/agentcore-hub" }, { name: "juno", full_name: "tycenjmccann/juno" }] },
        },
        calls
      ),
    });
    expect(r.ok).toBe(false);
    expect(r.definitive).toBe(true);
    expect(r.status).toBe(404);
    expect(r.ownerExists).toBe(false);
    expect(r.suggestions).toEqual(["tycenjmccann/agentcore-hub"]);
    expect(r.reason).toMatch(/owner "tycenj" does not exist/);
  });

  it("unauthenticated 404 is NOT definitive (private repos look identical)", async () => {
    const r = await checkRepoUrl("https://github.com/someone/private-thing", {
      fetchImpl: fakeFetch({ "/repos/someone/private-thing": { status: 404 }, "/users/someone": { status: 200 } }),
    });
    expect(r.ok).toBe(false);
    expect(r.definitive).toBe(false);
    expect(r.reason).toMatch(/without a token/);
  });

  it("403 / 5xx / network error → not definitive, never throws", async () => {
    const limited = await checkRepoUrl("https://github.com/a/b", { token: "t", fetchImpl: fakeFetch({ "/repos/a/b": { status: 403 } }) });
    expect(limited).toMatchObject({ ok: false, definitive: false, status: 403 });
    const boom = await checkRepoUrl("https://github.com/a/b", {
      token: "t",
      fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch,
    });
    expect(boom).toMatchObject({ ok: false, definitive: false, status: null });
    expect(boom.reason).toMatch(/ECONNRESET/);
  });
});

describe("checkRepoUrl — body capture (TEAM-3992 D4.1)", () => {
  const GOOD = "https://github.com/tycenjmccann/agentcore-hub";

  it("200 captures default_branch + full_name; renamed false when the body matches", async () => {
    const r = await checkRepoUrl(GOOD, {
      token: "t",
      fetchImpl: fakeFetch({ "/repos/tycenjmccann/agentcore-hub": { status: 200, json: { full_name: "tycenjmccann/agentcore-hub", default_branch: "main" } } }),
    });
    expect(r).toMatchObject({ ok: true, defaultBranch: "main", fullName: "tycenjmccann/agentcore-hub", renamed: false, owner: "tycenjmccann", repo: "agentcore-hub" });
  });

  it("a non-'main' default is captured verbatim", async () => {
    const r = await checkRepoUrl(GOOD, {
      token: "t",
      fetchImpl: fakeFetch({ "/repos/tycenjmccann/agentcore-hub": { status: 200, json: { full_name: "tycenjmccann/agentcore-hub", default_branch: "master" } } }),
    });
    expect(r.defaultBranch).toBe("master");
  });

  it("a followed 301 → renamed:true, owner/repo from the canonical full_name", async () => {
    const r = await checkRepoUrl(GOOD, {
      token: "t",
      fetchImpl: fakeFetch({
        "/repos/tycenjmccann/agentcore-hub": {
          status: 200,
          redirected: true,
          url: "https://api.github.com/repos/tycenjmccann/agentcore-console",
          json: { full_name: "tycenjmccann/agentcore-console", default_branch: "main" },
        },
      }),
    });
    expect(r).toMatchObject({ ok: true, renamed: true, fullName: "tycenjmccann/agentcore-console", owner: "tycenjmccann", repo: "agentcore-console" });
  });

  it("a 200 with no body fields → defaultBranch undefined (NOT 'main'), renamed false", async () => {
    const r = await checkRepoUrl(GOOD, {
      token: "t",
      fetchImpl: fakeFetch({ "/repos/tycenjmccann/agentcore-hub": { status: 200, json: {} } }),
    });
    expect(r.ok).toBe(true);
    expect(r.defaultBranch).toBeUndefined();
    expect(r.fullName).toBeUndefined();
    expect(r.renamed).toBe(false);
    expect(r).toMatchObject({ owner: "tycenjmccann", repo: "agentcore-hub" });
  });
});

describe("checkRepoUrl — non-GitHub", () => {
  it("HEAD <400 → ok; ≥400 → soft failure", async () => {
    expect((await checkRepoUrl("https://git.example.com/x/y", { fetchImpl: fakeFetch({ "git.example.com": { status: 200 } }) })).ok).toBe(true);
    const r = await checkRepoUrl("https://git.example.com/x/y", { fetchImpl: fakeFetch({ "git.example.com": { status: 404 } }) });
    expect(r).toMatchObject({ ok: false, definitive: false, status: 404 });
  });
});

describe("checkRepoConfig / helpers", () => {
  it("dedupes URLs, and definitiveFailures picks only trusted negatives", async () => {
    const check = await checkRepoConfig(
      { repos: [{ url: "https://github.com/tycenj/agentcore-hub" }, { url: "https://github.com/tycenj/agentcore-hub" }, { url: "https://github.com/a/b" }] },
      { token: "t", fetchImpl: fakeFetch({ "/repos/a/b": { status: 500 } }) }
    );
    expect(check.results.length).toBe(2);
    expect(definitiveFailures(check).map((r) => r.url)).toEqual(["https://github.com/tycenj/agentcore-hub"]);
  });

  it("describeRepoCheckFailure carries the did-you-mean + waiver hint", () => {
    const body = describeRepoCheckFailure([
      { url: "https://github.com/tycenj/agentcore-hub", ok: false, definitive: true, status: 404, reason: "GitHub 404", suggestions: ["tycenjmccann/agentcore-hub"] },
    ]);
    expect(body.error).toMatch(/did not resolve/);
    expect(body.suggestions).toEqual(["tycenjmccann/agentcore-hub"]);
    expect(body.hint).toMatch(/Did you mean: https:\/\/github.com\/tycenjmccann\/agentcore-hub/);
    expect(body.hint).toMatch(/allowUnresolvedRepo:true/);
  });

  it("formatRepoCheckWarning is empty when clean and tells the agent NOT to treat a 404 clone as an outage", () => {
    expect(formatRepoCheckWarning({ checkedAt: "x", results: [{ url: "u", ok: true, definitive: true, status: 200, reason: "found" }] })).toBe("");
    const w = formatRepoCheckWarning({
      checkedAt: "x",
      results: [{ url: "https://github.com/tycenj/agentcore-hub", ok: false, definitive: true, status: 404, reason: "GitHub 404", suggestions: ["tycenjmccann/agentcore-hub"] }],
    });
    expect(w).toMatch(/^## ⚠️ REPOSITORY URL DID NOT RESOLVE/);
    expect(w).toMatch(/NOT a coding-runtime outage/);
    expect(w).toMatch(/https:\/\/github.com\/tycenjmccann\/agentcore-hub/);
    expect(w).toMatch(/STOP\. Block your ticket/);
  });
});

/**
 * TEAM-3991 D1.1: the same branch-protection preflight the orchestrator runs
 * (lambda/orchestrator/repo-check.mjs). classifyProtection parity with the .mjs
 * copy is pinned separately by repo-check-parity.test.ts; these pin the
 * behaviour both copies must have — in particular that an unreadable answer
 * (403/timeout) is never reported as "not protected", because that would put a
 * false "your default branch is wide open" warning on every run.
 */
const FULL_PROTECTION = {
  required_pull_request_reviews: { required_approving_review_count: 1 },
  enforce_admins: { enabled: true },
  allow_force_pushes: { enabled: false },
};

describe("classifyProtection", () => {
  it("protection 200, fully configured → protected via source 'protection'", () => {
    expect(classifyProtection({ protectionStatus: 200, protectionJson: FULL_PROTECTION })).toEqual({
      protected: true,
      requiresPr: true,
      requiredApprovals: 1,
      enforceAdmins: true,
      source: "protection",
      missing: [],
    });
  });

  it("PR required but zero approvals → not protected", () => {
    const r = classifyProtection({
      protectionStatus: 200,
      protectionJson: { required_pull_request_reviews: { required_approving_review_count: 0 } },
    });
    expect(r.protected).toBe(false);
    expect(r.missing).toEqual(["required_approvals", "enforce_admins", "block_force_push"]);
  });

  it("rulesets fallback: 404 protection + a pull_request rule → source 'rules'", () => {
    const r = classifyProtection({
      protectionStatus: 404,
      rulesStatus: 200,
      rulesJson: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }, { type: "non_fast_forward" }, { type: "deletion" }],
    });
    expect(r).toMatchObject({ source: "rules", protected: true, requiredApprovals: 1, missing: ["enforce_admins"] });
  });

  it("empty rules array → 'none' with every requirement missing; 403s → 'unreadable'", () => {
    expect(classifyProtection({ protectionStatus: 404, rulesStatus: 200, rulesJson: [] })).toMatchObject({
      source: "none",
      protected: false,
      missing: [...PROTECTION_REQUIREMENTS],
    });
    expect(classifyProtection({ protectionStatus: 403, rulesStatus: 403 })).toMatchObject({ source: "unreadable", protected: false });
  });
});

describe("checkBranchProtection", () => {
  const target = { owner: "tycenjmccann", repo: "agentcore-hub", branch: "main" };

  it("prefers classic protection and skips the rules call", async () => {
    const calls: string[] = [];
    const r = await checkBranchProtection(target, {
      token: "t",
      fetchImpl: fakeFetch({ "/branches/main/protection": { status: 200, json: FULL_PROTECTION } }, calls),
    });
    expect(r).toMatchObject({ source: "protection", protected: true, protectionStatus: 200, rulesStatus: null });
    expect(calls.length).toBe(1);
  });

  it("never throws: a dead fetch is 'unreadable', not 'unprotected'", async () => {
    const r = await checkBranchProtection(target, { token: "t", fetchImpl: (async () => { throw new Error("ETIMEDOUT"); }) as unknown as typeof fetch });
    expect(r).toMatchObject({ source: "unreadable", protected: false, error: "ETIMEDOUT" });
  });

  it("encodes every path segment", async () => {
    const calls: string[] = [];
    await checkBranchProtection({ owner: "own er", repo: "re/po", branch: "feature/x..y" }, { token: "t", fetchImpl: fakeFetch({}, calls) });
    expect(calls[0]).toContain("/repos/own%20er/re%2Fpo/branches/feature%2Fx..y/protection");
  });
});
