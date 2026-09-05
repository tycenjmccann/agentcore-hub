import { describe, it, expect } from "vitest";
import { parseRepoUrl, resolveDefaultBranch, resolveRepoIdentity } from "./default-branch.mjs";

/**
 * TEAM-3992 D4.1 — the base-branch + repo-identity resolvers that replace every
 * hardcoded `|| "main"` in index.mjs. Pure functions, no AWS: the resolution
 * chain (repoCheck → repoConfig → "main") and the renamed-repo identity swap are
 * unit-tested here directly. The wiring that feeds them (ensureRepoCheck →
 * repoCheck; the intake manifest.repo write) is exercised by repo-check.test.mjs.
 */

const URL = "https://github.com/tycenjmccann/agentcore-hub";
const wf = (repoConfig, repoCheck) => ({ id: "wf_1", repoConfig, ...(repoCheck ? { repoCheck } : {}) });
const cfg = (defaultBranch) => ({ repos: [{ url: URL, ...(defaultBranch ? { defaultBranch } : {}) }] });
const check = (result) => ({ checkedAt: "x", results: [{ url: URL, ok: true, status: 200, ...result }] });

describe("resolveDefaultBranch", () => {
  it("prefers the branch GitHub reported (repoCheck) over the configured one", () => {
    expect(resolveDefaultBranch(wf(cfg("main"), check({ defaultBranch: "master" })))).toBe("master");
  });

  it("falls back to the configured defaultBranch when repoCheck has none", () => {
    expect(resolveDefaultBranch(wf(cfg("develop")))).toBe("develop");
    expect(resolveDefaultBranch(wf(cfg("develop"), check({})))).toBe("develop");
  });

  it("falls back to 'main' only when nothing else is known — the ONLY hardcoded default", () => {
    expect(resolveDefaultBranch(wf(cfg()))).toBe("main");
    expect(resolveDefaultBranch(wf({ repos: [] }))).toBe("main");
    expect(resolveDefaultBranch({})).toBe("main");
  });

  it("matches the repoCheck result to the PRIMARY repo url, not just any ok result", () => {
    const workflow = {
      repoConfig: { repos: [{ url: URL, defaultBranch: "main" }] },
      repoCheck: {
        checkedAt: "x",
        results: [
          { url: "https://github.com/other/repo", ok: true, defaultBranch: "trunk" },
          { url: URL, ok: true, defaultBranch: "release" },
        ],
      },
    };
    expect(resolveDefaultBranch(workflow)).toBe("release");
  });
});

describe("resolveRepoIdentity", () => {
  it("parses owner/repo from the configured URL when nothing was renamed", () => {
    expect(resolveRepoIdentity(wf(cfg("main")))).toEqual({ owner: "tycenjmccann", repo: "agentcore-hub" });
    expect(resolveRepoIdentity(wf(cfg("main"), check({ renamed: false, fullName: "tycenjmccann/agentcore-hub" }))))
      .toEqual({ owner: "tycenjmccann", repo: "agentcore-hub" });
  });

  it("uses the canonical full_name when GitHub reported a rename/transfer", () => {
    expect(resolveRepoIdentity(wf(cfg("main"), check({ renamed: true, fullName: "neworg/agentcore-console" }))))
      .toEqual({ owner: "neworg", repo: "agentcore-console" });
  });

  it("ignores a renamed flag with no usable full_name and falls back to the URL", () => {
    expect(resolveRepoIdentity(wf(cfg("main"), check({ renamed: true }))))
      .toEqual({ owner: "tycenjmccann", repo: "agentcore-hub" });
  });
});

describe("parseRepoUrl", () => {
  it("returns empty strings (never throws) on an unparseable config", () => {
    expect(parseRepoUrl(undefined)).toEqual({ owner: "", repo: "" });
    expect(parseRepoUrl({ repos: [{ url: "not-a-url" }] })).toEqual({ owner: "", repo: "" });
    expect(parseRepoUrl({ repos: [{ url: "git@github.com:o/r" }] })).toEqual({ owner: "o", repo: "r" });
  });
});
