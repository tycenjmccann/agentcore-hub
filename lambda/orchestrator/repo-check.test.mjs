import { describe, it, expect } from "vitest";
import { checkRepoUrl, ensureRepoCheck, formatRepoCheckWarning, parseGitHubUrl } from "./repo-check.mjs";

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
