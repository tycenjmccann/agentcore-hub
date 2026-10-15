import { describe, it, expect, vi } from "vitest";
import {
  followUpPrGate as wrapped,
  followUpPrGateConfigured,
  githubApi,
  featureBranchMergeProbe,
  overlayFreshRecords,
  openFollowUpPrsAtCompletion,
} from "./follow-up-pr-gate";
import { followUpPrGate as orchestrator } from "../../../lambda/orchestrator/completion.mjs";

/**
 * TEAM-6136 — the /complete route's follow-up PR gate IS the orchestrator's
 * (one implementation, no hand-port to drift), and the route-side deps keep the
 * orchestrator's semantics: githubApi throws on non-2xx, a Done-intent
 * reservation is no record, and the guard mirrors mergeVerifyConfigured.
 *
 * TEAM-6187 — so are the gate's INPUTS: the landing probe (featureBranchLanding,
 * the orchestrator's featureBranchMergeProbe) supplies mergeProof and the
 * unmerged refusal, and the fresh-record overlay (freshRecordFields, the
 * orchestrator's pre-probe harvestCompletionEvidence) feeds agentTasks.
 */
const REPO = { repos: [{ url: "https://github.com/o/r", defaultBranch: "main" }] };
const workflow = {
  workflowId: "wf_1",
  featureBranch: "feature/x",
  repoConfig: REPO,
  agentTasks: {
    "T-4": { ticketId: "T-4", agentId: "rm", mergeCommit: "abc" },
    "T-9": { ticketId: "T-9", agentId: "fixer", prUrl: "https://github.com/o/r/pull/78" },
  },
};
const getAgentPhase = (id: string) => (id === "rm" ? "ship" : "development");
const OPEN = { state: "open", base: { ref: "main" }, head: { ref: "fix/y" } };
type Route = [match: string, status: number, body: unknown];
/** Routed fetch: first substring match wins; unmatched → `200 {}` (probe inconclusive). */
const routed = (routes: Route[], calls: string[] = []) =>
  vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    const hit = routes.find(([m]) => u.includes(m));
    const [, status, body] = hit ?? ["", 200, {}];
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
const openFetch = () => routed([["/pulls/", 200, OPEN]]);
const MERGED_PR = { number: 70, state: "closed", merged_at: "2026-10-01T00:00:00Z", head: { sha: "h1" }, base: { ref: "main" }, merge_commit_sha: "m70", html_url: "https://github.com/o/r/pull/70" };

describe("follow-up PR gate wrapper (TEAM-6136)", () => {
  it("re-exports the orchestrator's followUpPrGate itself", () => {
    expect(wrapped).toBe(orchestrator);
  });

  it("githubApi returns the JSON on 200 and throws on 404 / 500 — with the orchestrator's err.status (TEAM-6187 §1a)", async () => {
    const respond = (status: number) =>
      vi.fn(async () => new Response(JSON.stringify({ state: "open" }), { status })) as unknown as typeof fetch;
    await expect(githubApi("t", respond(200))("/repos/o/r/pulls/1")).resolves.toEqual({ state: "open" });
    await expect(githubApi("t", respond(404))("/repos/o/r/pulls/1")).rejects.toMatchObject({ status: 404 });
    await expect(githubApi("t", respond(500))("/repos/o/r/pulls/1")).rejects.toMatchObject({ status: 500 });
    await expect(githubApi("t", respond(404))("/repos/o/r/pulls/1")).rejects.toThrow("404");
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

  it("a Done-intent reservation is no record → the cached prUrl is checked", async () => {
    const r = await openFollowUpPrsAtCompletion({
      workflow,
      tickets: [],
      readCompletionRecord: async (tid) => (tid === "T-9" ? { reservation: "done-intent", ticketId: "T-9" } : null),
      getAgentPhase,
      token: "t",
      fetchImpl: openFetch(),
    });
    expect(r).toEqual({ prs: ["https://github.com/o/r/pull/78"] });
  });

  it("a record read that throws falls back to the cached prUrl; a throwing dep never escapes", async () => {
    const r = await openFollowUpPrsAtCompletion({
      workflow,
      tickets: [],
      readCompletionRecord: async () => { throw new Error("s3 down"); },
      getAgentPhase,
      token: "t",
      fetchImpl: openFetch(),
    });
    expect(r).toEqual({ prs: ["https://github.com/o/r/pull/78"] });
    await expect(
      openFollowUpPrsAtCompletion({
        workflow,
        tickets: [],
        readCompletionRecord: async () => null,
        getAgentPhase: () => { throw new Error("roster"); },
        token: "t",
        fetchImpl: openFetch(),
      })
    ).resolves.toEqual({ prs: [] });
  });
});

describe("featureBranchMergeProbe — the orchestrator's featureBranchMergeProbe (TEAM-6187 F1)", () => {
  const api = (routes: Route[]) => githubApi("t", routed(routes));
  const probe = (routes: Route[], agentTasks: Record<string, Record<string, unknown>> = {}) =>
    featureBranchMergeProbe({ workflow, agentTasks, api: api(routes), warn: () => {} });

  it("merged PR head == branch head → merged:true with mergeCommit + prUrl", async () => {
    await expect(probe([["/pulls?head=", 200, [MERGED_PR]], ["/branches/", 200, { commit: { sha: "h1" } }]])).resolves.toEqual({
      merged: true, mergeCommit: "m70", prUrl: "https://github.com/o/r/pull/70",
    });
  });

  it("no PR and compare says ahead → merged:false with the reason (the orchestrator's refusal input)", async () => {
    const r = await probe([["/pulls?head=", 200, []], ["/compare/", 200, { status: "ahead", ahead_by: 3 }]]);
    expect(r.merged).toBe(false);
    expect(r.reason).toContain("3 commit(s) ahead of main");
  });

  it("branch auto-deleted (404) and every recorded head contained in the merged head → proof (needs err.status)", async () => {
    const r = await probe(
      [["/pulls?head=", 200, [MERGED_PR]], ["/branches/", 404, { message: "Not Found" }], ["/compare/old1111...h1", 200, { status: "ahead", behind_by: 0 }]],
      { "T-1": { commitSha: "old1111" } }
    );
    expect(r).toEqual({ merged: true, mergeCommit: "m70", prUrl: "https://github.com/o/r/pull/70" });
  });

  it("GitHub 500 / malformed answers → merged:null, never rejects", async () => {
    await expect(probe([["/pulls?head=", 500, { message: "boom" }]])).resolves.toEqual({ merged: null });
    await expect(probe([])).resolves.toEqual({ merged: null });
    await expect(
      featureBranchMergeProbe({ workflow: { ...workflow, repoConfig: undefined }, agentTasks: {}, api: api([]), warn: () => {} })
    ).resolves.toEqual({ merged: null });
  });
});

describe("overlayFreshRecords — the orchestrator's pre-probe harvest (TEAM-6187 §1c)", () => {
  const entry = { ticketId: "T-4", agentId: "rm", startedAt: "2026-10-01T00:00:00Z", completedAt: "2026-10-01T00:05:00Z", output: "old", commitSha: "aaa" };
  const fresh = { completed_at: "2026-10-01T00:06:00Z", merge_commit: "m1", commit_sha: "bbb", pr_url: "https://github.com/o/r/pull/70", outcome: "SHIPPED", block_reason: "x", summary: " new summary ", branch: "feature/x" };

  it("a record written after the Done stamp overwrites the ship signals on a COPY", async () => {
    const tasks = { "T-4": { ...entry } };
    const out = await overlayFreshRecords(tasks, async () => fresh);
    expect(out["T-4"]).toEqual({
      ...entry, output: "new summary", branch: "feature/x", commitSha: "bbb", prUrl: "https://github.com/o/r/pull/70", mergeCommit: "m1", outcome: "shipped", blockReason: "x",
    });
    expect(tasks["T-4"]).toEqual(entry); // input untouched
  });

  it("stale record / no startedAt / no record / throwing reader → entry unchanged", async () => {
    const stale = { ...fresh, completed_at: "2026-10-01T00:04:00Z" };
    expect((await overlayFreshRecords({ "T-4": { ...entry } }, async () => stale))["T-4"]).toEqual(entry);
    const noStart = { ticketId: "T-4", completedAt: "2026-10-01T00:05:00Z" };
    expect((await overlayFreshRecords({ "T-4": { ...noStart } }, async () => fresh))["T-4"]).toEqual(noStart);
    expect((await overlayFreshRecords({ "T-4": { ...entry } }, async () => null))["T-4"]).toEqual(entry);
    expect((await overlayFreshRecords({ "T-4": { ...entry } }, async () => { throw new Error("s3"); }))["T-4"]).toEqual(entry);
  });

  it("an unknown outcome is dropped, exactly as harvestableShipOutcome drops it", async () => {
    const out = await overlayFreshRecords({ "T-4": { ...entry } }, async () => ({ completed_at: "2026-10-01T00:06:00Z", outcome: "banana" }));
    expect(out["T-4"].outcome).toBeUndefined();
  });
});

describe("openFollowUpPrsAtCompletion — probe + overlay feed the gate (TEAM-6187)", () => {
  const read = (records: Record<string, Record<string, unknown>>) => {
    const reads: string[] = [];
    return { reads, fn: async (tid: string) => (reads.push(tid), records[tid] ?? null) };
  };

  it("GitHub proof engages the gate when no task carries a mergeCommit", async () => {
    const wf = { ...workflow, agentTasks: { "T-4": { ticketId: "T-4", agentId: "rm", outcome: "shipped" }, "T-9": workflow.agentTasks["T-9"] } };
    const r = await openFollowUpPrsAtCompletion({
      workflow: wf, tickets: [], readCompletionRecord: async () => null, getAgentPhase, token: "t",
      fetchImpl: routed([["/pulls?head=", 200, [MERGED_PR]], ["/branches/", 200, { commit: { sha: "h1" } }], ["/pulls/78", 200, OPEN]]),
    });
    expect(r).toEqual({ prs: ["https://github.com/o/r/pull/78"] });
  });

  it("a proven-unmerged branch returns the refusal and never reads the follow-up PR", async () => {
    const calls: string[] = [];
    const r = await openFollowUpPrsAtCompletion({
      workflow, tickets: [], readCompletionRecord: async () => null, getAgentPhase, token: "t",
      fetchImpl: routed([["/pulls?head=", 200, []], ["/compare/", 200, { status: "ahead", ahead_by: 2 }], ["/pulls/78", 200, OPEN]], calls),
    });
    expect(r).toMatchObject({ unmerged: { reason: expect.stringContaining("2 commit(s) ahead") } });
    expect(calls.some((u) => u.endsWith("/pulls/78"))).toBe(false);
  });

  it("a fresh ship record supplies the mergeCommit; each record is read ONCE for overlay + gate", async () => {
    const wf = {
      ...workflow,
      agentTasks: {
        "T-4": { ticketId: "T-4", agentId: "rm", startedAt: "2026-10-01T00:00:00Z", completedAt: "2026-10-01T00:05:00Z" },
        "T-9": { ticketId: "T-9", agentId: "fixer", startedAt: "2026-10-01T00:00:00Z", completedAt: "2026-10-01T00:05:00Z" },
      },
    };
    const { reads, fn } = read({
      "T-4": { completed_at: "2026-10-01T00:06:00Z", merge_commit: "m1" },
      "T-9": { completed_at: "2026-10-01T00:01:00Z", pr_url: "https://github.com/o/r/pull/78" }, // stale for overlay, still the gate's pr_url
    });
    const r = await openFollowUpPrsAtCompletion({ workflow: wf, tickets: [], readCompletionRecord: fn, getAgentPhase, token: "t", fetchImpl: openFetch() });
    expect(r).toEqual({ prs: ["https://github.com/o/r/pull/78"] });
    expect(reads.sort()).toEqual(["T-4", "T-9"]);
  });
});
