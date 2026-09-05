import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMergeOnGreen } from "./merge-on-green.mjs";

/**
 * TEAM-4110 — merge-on-green. DI coverage for the fix that finishes a human's
 * Merge-Approval decision from the orchestrator: it merges a clean+green PR only
 * after the gate is done, only when GitHub reports mergeable_state:"clean", and
 * only with the exact head SHA. off is byte-identical to pre-4110 (never touches
 * GitHub). Same DI-harness + captureMetrics shape as level-trigger-dispatch.test.mjs.
 */

const EPIC = "EPIC-1";
const BRANCH = "feature/TEAM-1-x";
const workflow = {
  id: "wf_1",
  epicId: EPIC,
  featureBranch: BRANCH,
  repoConfig: { repos: [{ url: "https://github.com/acme/widgets", defaultBranch: "main" }] },
  agentTasks: {},
};

const parseRepoUrl = (rc) => {
  const url = rc?.repos?.[0]?.url || "";
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  return m ? { owner: m[1], repo: m[2] } : { owner: "", repo: "" };
};

const approvedGate = { ticketId: "GATE-1", assignee: "human:eng", title: "Merge Approval", status: "done" };
const openPrList = [{ number: 7, merged_at: null, mergeable_state: "clean", html_url: "http://pr/7", head: { sha: "abc123" } }];

function makeDeps(overrides = {}) {
  const githubApi = overrides.githubApi || vi.fn(async (path, method) => {
    if (method === "PUT") return { sha: "merge-sha-1", merged: true };
    if (/\/pulls\?/.test(path)) return openPrList;
    if (/\/pulls\/\d+$/.test(path)) return openPrList[0];
    return {};
  });
  const getChildTickets = overrides.getChildTickets || vi.fn(async () => [approvedGate]);
  const publishEvent = overrides.publishEvent || vi.fn(async () => {});
  const deps = {
    githubApi,
    getChildTickets,
    publishEvent,
    parseRepoUrl,
    getAgentPhase: overrides.getAgentPhase || (() => undefined),
    now: () => Date.parse("2026-09-05T00:00:00Z"),
    log: () => {},
    sleep: vi.fn(async () => {}),
    mode: overrides.mode,
    ...(overrides.extra || {}),
  };
  return { deps, githubApi, getChildTickets, publishEvent };
}

function captureMetrics() {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  return {
    records: () =>
      spy.mock.calls
        .map((c) => { try { return JSON.parse(c[0]); } catch { return null; } })
        .filter((r) => r && r._aws),
    restore: () => spy.mockRestore(),
  };
}
const putCalls = (githubApi) => githubApi.mock.calls.filter((c) => c[1] === "PUT");

beforeEach(() => vi.clearAllMocks());

describe("off (default) — byte-identical to pre-4110", () => {
  it("never calls githubApi; returns skip", async () => {
    const { deps, githubApi, getChildTickets } = makeDeps({ mode: undefined });
    const { mergeApprovedGreenPr, mode } = createMergeOnGreen(deps);
    expect(mode).toBe("off");
    const r = await mergeApprovedGreenPr(workflow, { merged: false });
    expect(r.outcome).toBe("skip");
    expect(githubApi).not.toHaveBeenCalled();
    expect(getChildTickets).not.toHaveBeenCalled();
  });
});

describe("gate not approved — never merges even in enforce", () => {
  it("gate missing → gate-not-approved, no PUT", async () => {
    const { deps, githubApi } = makeDeps({ mode: "enforce", getChildTickets: vi.fn(async () => []) });
    const cap = captureMetrics();
    const r = await createMergeOnGreen(deps).mergeApprovedGreenPr(workflow, { merged: false });
    const records = cap.records();
    cap.restore();
    expect(r.outcome).toBe("gate-not-approved");
    expect(putCalls(githubApi)).toHaveLength(0);
    expect(records.find((x) => "MergeOnGreenGateNotApproved" in x)?.MergeOnGreenGateNotApproved).toBe(1);
  });

  it("gate present but status != done → gate-not-approved", async () => {
    const gate = { ...approvedGate, status: "in_review" };
    const { deps, githubApi } = makeDeps({ mode: "enforce", getChildTickets: vi.fn(async () => [gate]) });
    const r = await createMergeOnGreen(deps).mergeApprovedGreenPr(workflow, { merged: false });
    expect(r.outcome).toBe("gate-not-approved");
    expect(putCalls(githubApi)).toHaveLength(0);
  });
});

describe("enforce — happy path", () => {
  it("gate done + clean + head matches → PUT squash merge with sha; returns merged", async () => {
    const { deps, githubApi, publishEvent } = makeDeps({
      mode: "enforce",
      getAgentPhase: () => "ship",
      extra: { }, // agentTasks has no ship head → approvedSha null → sha-param guard only
    });
    const cap = captureMetrics();
    const r = await createMergeOnGreen(deps).mergeApprovedGreenPr(workflow, { merged: false });
    const records = cap.records();
    cap.restore();
    expect(r.outcome).toBe("merged");
    expect(r.mergeCommit).toBe("merge-sha-1");
    const puts = putCalls(githubApi);
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toMatch(/\/repos\/acme\/widgets\/pulls\/7\/merge$/);
    expect(puts[0][2]).toEqual({ merge_method: "squash", sha: "abc123" });
    expect(publishEvent).toHaveBeenCalledWith(EPIC, "workflow.merged_on_green", expect.objectContaining({ mergeCommit: "merge-sha-1" }));
    expect(records.find((x) => "MergeOnGreenMerged" in x)?.MergeOnGreenMerged).toBe(1);
  });

  it("head matches the ship task's recorded commitSha → merges", async () => {
    const wf = { ...workflow, agentTasks: { "TEAM-9": { agentId: "rm", commitSha: "abc123" } } };
    const { deps, githubApi } = makeDeps({ mode: "enforce", getAgentPhase: (id) => (id === "rm" ? "ship" : undefined) });
    const r = await createMergeOnGreen(deps).mergeApprovedGreenPr(wf, { merged: false });
    expect(r.outcome).toBe("merged");
    expect(putCalls(githubApi)).toHaveLength(1);
  });
});

describe("shadow — observe only", () => {
  it("gate done + clean → wouldMerge metric, no PUT", async () => {
    const { deps, githubApi } = makeDeps({ mode: "shadow" });
    const cap = captureMetrics();
    const r = await createMergeOnGreen(deps).mergeApprovedGreenPr(workflow, { merged: false });
    const records = cap.records();
    cap.restore();
    expect(r.outcome).toBe("would-merge");
    expect(putCalls(githubApi)).toHaveLength(0);
    expect(records.find((x) => "MergeOnGreenWouldMerge" in x)?.MergeOnGreenWouldMerge).toBe(1);
  });
});

describe("not mergeable / head drift → no PUT", () => {
  it("mergeable_state blocked/dirty/behind → not-mergeable", async () => {
    for (const badState of ["blocked", "dirty", "behind"]) {
      const githubApi = vi.fn(async (path) => {
        if (/\/pulls\?/.test(path)) return [{ number: 7, merged_at: null, mergeable_state: badState, html_url: "http://pr/7", head: { sha: "abc123" } }];
        if (/\/pulls\/\d+$/.test(path)) return { number: 7, mergeable_state: badState, head: { sha: "abc123" } };
        return {};
      });
      const { deps } = makeDeps({ mode: "enforce", githubApi });
      const r = await createMergeOnGreen(deps).mergeApprovedGreenPr(workflow, { merged: false });
      expect(r.outcome).toBe("not-mergeable");
      expect(putCalls(githubApi)).toHaveLength(0);
    }
  });

  it("clean but PR head != gate-approved ship SHA → head-drift, no PUT", async () => {
    const wf = { ...workflow, agentTasks: { "TEAM-9": { agentId: "rm", commitSha: "OLD999" } } };
    const { deps, githubApi } = makeDeps({ mode: "enforce", getAgentPhase: (id) => (id === "rm" ? "ship" : undefined) });
    const cap = captureMetrics();
    const r = await createMergeOnGreen(deps).mergeApprovedGreenPr(wf, { merged: false });
    const records = cap.records();
    cap.restore();
    expect(r.outcome).toBe("head-drift");
    expect(putCalls(githubApi)).toHaveLength(0);
    expect(records.find((x) => "MergeOnGreenHeadDrift" in x)?.MergeOnGreenHeadDrift).toBe(1);
  });

  it("re-polls while mergeable_state is unknown, then merges once clean", async () => {
    let n = 0;
    const githubApi = vi.fn(async (path, method) => {
      if (method === "PUT") return { sha: "m2" };
      if (/\/pulls\?/.test(path)) return [{ number: 7, merged_at: null, mergeable_state: "unknown", html_url: "http://pr/7", head: { sha: "abc123" } }];
      if (/\/pulls\/\d+$/.test(path)) { n++; return { number: 7, mergeable_state: n >= 2 ? "clean" : "unknown", html_url: "http://pr/7", head: { sha: "abc123" } }; }
      return {};
    });
    const { deps } = makeDeps({ mode: "enforce", githubApi });
    const r = await createMergeOnGreen(deps).mergeApprovedGreenPr(workflow, { merged: false });
    expect(r.outcome).toBe("merged");
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

describe("enforce — merge refused is non-fatal", () => {
  it("GitHub 405 → merge-refused, refused metric, does not throw", async () => {
    const githubApi = vi.fn(async (path, method) => {
      if (method === "PUT") { const e = new Error("not mergeable"); e.status = 405; e.githubMessage = "not mergeable"; throw e; }
      if (/\/pulls\?/.test(path)) return openPrList;
      if (/\/pulls\/\d+$/.test(path)) return openPrList[0];
      return {};
    });
    const { deps } = makeDeps({ mode: "enforce", githubApi });
    const cap = captureMetrics();
    const r = await createMergeOnGreen(deps).mergeApprovedGreenPr(workflow, { merged: false });
    const records = cap.records();
    cap.restore();
    expect(r.outcome).toBe("merge-refused");
    expect(records.find((x) => "MergeOnGreenRefused" in x)?.MergeOnGreenRefused).toBe(1);
  });

  it("unexpected getChildTickets throw → error outcome, never throws", async () => {
    const { deps } = makeDeps({ mode: "enforce", getChildTickets: vi.fn(async () => { throw new Error("ddb down"); }) });
    const r = await createMergeOnGreen(deps).mergeApprovedGreenPr(workflow, { merged: false });
    expect(r.outcome).toBe("error");
  });
});

describe("unrecognized mode → fails safe to shadow (never merges)", () => {
  it("garbage mode value never PUTs (fails safe to shadow, observe-only)", async () => {
    const { deps, githubApi } = makeDeps({ mode: "xyzzy" });
    const { mode } = createMergeOnGreen(deps);
    expect(mode).toBe("shadow");
    const r = await createMergeOnGreen(deps).mergeApprovedGreenPr(workflow, { merged: false });
    expect(r.outcome).toBe("would-merge");
    expect(putCalls(githubApi)).toHaveLength(0);
  });

  it('legacy truthy mode="on" maps to enforce (parity with normalizeExtendedMode)', async () => {
    const { deps, githubApi } = makeDeps({ mode: "on" });
    const { mode } = createMergeOnGreen(deps);
    expect(mode).toBe("enforce");
    const r = await createMergeOnGreen(deps).mergeApprovedGreenPr(workflow, { merged: false });
    expect(r.outcome).toBe("merged");
    expect(putCalls(githubApi)).toHaveLength(1);
  });
});
