import { describe, it, expect, vi } from "vitest";
import {
  followUpPrGate as wrapped,
  followUpPrGateConfigured,
  githubApi,
  openFollowUpPrsAtCompletion,
} from "./follow-up-pr-gate";
import { followUpPrGate as orchestrator } from "../../../lambda/orchestrator/completion.mjs";

/**
 * TEAM-6136 — the /complete route's follow-up PR gate IS the orchestrator's
 * (one implementation, no hand-port to drift), and the route-side deps keep the
 * orchestrator's semantics: githubApi throws on non-2xx, a Done-intent
 * reservation is no record, and the guard mirrors mergeVerifyConfigured.
 */
describe("follow-up PR gate wrapper (TEAM-6136)", () => {
  it("re-exports the orchestrator's followUpPrGate itself", () => {
    expect(wrapped).toBe(orchestrator);
  });

  it("githubApi returns the JSON on 200 and throws on 404 / 500", async () => {
    const respond = (status: number) =>
      vi.fn(async () => new Response(JSON.stringify({ state: "open" }), { status })) as unknown as typeof fetch;
    await expect(githubApi("t", respond(200))("/repos/o/r/pulls/1")).resolves.toEqual({ state: "open" });
    await expect(githubApi("t", respond(404))("/repos/o/r/pulls/1")).rejects.toThrow("404");
    await expect(githubApi("t", respond(500))("/repos/o/r/pulls/1")).rejects.toThrow("500");
  });

  it("followUpPrGateConfigured mirrors the orchestrator's mergeVerifyConfigured", () => {
    const wf = { featureBranch: "feature/x", repoConfig: { repos: [] } };
    const env = { GITHUB_PAT: "t" };
    expect(followUpPrGateConfigured(wf, true, env)).toBe(true);
    expect(followUpPrGateConfigured(wf, false, env)).toBe(false);
    expect(followUpPrGateConfigured(wf, true, {})).toBe(false);
    expect(followUpPrGateConfigured({ ...wf, featureBranch: "" }, true, env)).toBe(false);
    expect(followUpPrGateConfigured({ featureBranch: "feature/x" }, true, env)).toBe(false);
    for (const off of ["off", " FALSE ", "0"]) {
      expect(followUpPrGateConfigured(wf, true, { ...env, SHIP_MERGE_VERIFY: off })).toBe(false);
    }
    expect(followUpPrGateConfigured(wf, true, { ...env, SHIP_MERGE_VERIFY: "on" })).toBe(true);
  });

  const workflow = {
    workflowId: "wf_1",
    featureBranch: "feature/x",
    repoConfig: { repos: [{ url: "https://github.com/o/r", defaultBranch: "main" }] },
    agentTasks: {
      "T-4": { ticketId: "T-4", agentId: "rm", mergeCommit: "abc" },
      "T-9": { ticketId: "T-9", agentId: "fixer", prUrl: "https://github.com/o/r/pull/78" },
    },
  };
  const getAgentPhase = (id: string) => (id === "rm" ? "ship" : "development");
  const openFetch = () =>
    vi.fn(async (url: string) =>
      new Response(JSON.stringify({ state: "open", base: { ref: "main" }, head: { ref: "fix/y" }, url }), { status: 200 })
    ) as unknown as typeof fetch;

  it("a Done-intent reservation is no record → the cached prUrl is checked", async () => {
    const prs = await openFollowUpPrsAtCompletion({
      workflow,
      tickets: [],
      readCompletionRecord: async (tid) => (tid === "T-9" ? { reservation: "done-intent", ticketId: "T-9" } : null),
      getAgentPhase,
      token: "t",
      fetchImpl: openFetch(),
    });
    expect(prs).toEqual(["https://github.com/o/r/pull/78"]);
  });

  it("a record read that throws falls back to the cached prUrl; a throwing dep never escapes", async () => {
    const prs = await openFollowUpPrsAtCompletion({
      workflow,
      tickets: [],
      readCompletionRecord: async () => { throw new Error("s3 down"); },
      getAgentPhase,
      token: "t",
      fetchImpl: openFetch(),
    });
    expect(prs).toEqual(["https://github.com/o/r/pull/78"]);
    await expect(
      openFollowUpPrsAtCompletion({
        workflow,
        tickets: [],
        readCompletionRecord: async () => null,
        getAgentPhase: () => { throw new Error("roster"); },
        token: "t",
        fetchImpl: openFetch(),
      })
    ).resolves.toEqual([]);
  });
});
