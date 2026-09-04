import { describe, it, expect } from "vitest";
import {
  parseGitHubUrl,
  checkRepoUrl,
  checkRepoConfig,
  definitiveFailures,
  describeRepoCheckFailure,
  formatRepoCheckWarning,
} from "./repo-check";

/**
 * The 2026-09-03 incident in miniature: `tycenj/agentcore-hub` was submitted
 * for `tycenjmccann/agentcore-hub`. Nothing asked GitHub, the clone 404'd on
 * every coding engine, and the personas escalated a fake runtime outage.
 * These pin the pre-flight that now asks.
 */

type Route = { status: number; json?: unknown };
function fakeFetch(routes: Record<string, Route>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method || "GET"} ${url}`);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const r: Route = hit ? hit[1] : { status: 404, json: { message: "Not Found" } };
    return {
      status: r.status,
      ok: r.status < 400,
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
