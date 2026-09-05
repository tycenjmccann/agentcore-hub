import { describe, it, expect, vi, beforeEach } from "vitest";
import { createShipHeadGate } from "./ship-head-stability.mjs";

/**
 * TEAM-4111 — ship-head stability gate. DI coverage for the dispatch-time
 * decision that keeps the RM off a moving head: dispatch only when the PR head
 * is quiet (>= stableMs) AND CI is green on THAT head; otherwise defer. off is
 * byte-identical to today (no probe, no metrics); a real CI red passes through;
 * a perpetually-moving head fails open at maxDeferrals; a probe throw fails open.
 * Same DI-harness + captureMetrics shape as merge-on-green.test.mjs.
 */

const NOW = Date.parse("2026-09-05T00:00:00Z");
const STABLE_MS = 3 * 60 * 1000;
const HEAD = "headSHA1";

const workflow = { id: "wf_1", epicId: "EPIC-1", featureBranch: "feature/EPIC-1-x" };
const gateTicket = { ticketId: "TEAM-SHIP", title: "Ship: widget", assignee: "agentcore_hub_release_manager" };

// A GitHub probe result: green on head, quiet for 10 minutes.
function stableGreenProbe() {
  return { headSha: HEAD, lastHeadMoveAt: NOW - 10 * 60 * 1000, ci: { sha: HEAD, conclusion: "success" } };
}

function makeGate(overrides = {}) {
  const githubProbe = overrides.githubProbe || vi.fn(async () => stableGreenProbe());
  const deps = {
    githubProbe,
    now: () => NOW,
    stableMs: STABLE_MS,
    maxDeferrals: overrides.maxDeferrals ?? 8,
    log: () => {},
    mode: overrides.mode,
  };
  return { gate: createShipHeadGate(deps), githubProbe };
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
const metric = (records, name) => records.find((r) => name in r)?.[name];

beforeEach(() => vi.clearAllMocks());

describe("off (default) — byte-identical to today", () => {
  it("never probes, always dispatches, emits zero metrics", async () => {
    const { gate, githubProbe } = makeGate({ mode: undefined });
    expect(gate.mode).toBe("off");
    const cap = captureMetrics();
    const r = await gate.evaluate(workflow, gateTicket);
    const records = cap.records();
    cap.restore();
    expect(r.action).toBe("dispatch");
    expect(githubProbe).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
  });
});

describe("shadow — measures, never defers", () => {
  it("head moving → wouldDefer + ShipHeadWouldDefer=1, still dispatches", async () => {
    const githubProbe = vi.fn(async () => ({ headSha: HEAD, lastHeadMoveAt: NOW - 30 * 1000, ci: { sha: HEAD, conclusion: "success" } }));
    const { gate } = makeGate({ mode: "shadow", githubProbe });
    const cap = captureMetrics();
    const r = await gate.evaluate(workflow, gateTicket);
    const records = cap.records();
    cap.restore();
    expect(r.action).toBe("dispatch");
    expect(r.wouldDefer).toBe(true);
    expect(metric(records, "ShipHeadWouldDefer")).toBe(1);
    expect(metric(records, "ShipHeadDeferred")).toBe(0);
  });
});

describe("enforce", () => {
  it("stable + green on head → dispatch", async () => {
    const { gate } = makeGate({ mode: "enforce" });
    const r = await gate.evaluate(workflow, gateTicket);
    expect(r.action).toBe("dispatch");
    expect(r.reason).toBe("stable-green");
  });

  it("head moved within stableMs → defer, ShipHeadDeferred=1", async () => {
    const githubProbe = vi.fn(async () => ({ headSha: HEAD, lastHeadMoveAt: NOW - 30 * 1000, ci: { sha: HEAD, conclusion: "success" } }));
    const { gate } = makeGate({ mode: "enforce", githubProbe });
    const cap = captureMetrics();
    const r = await gate.evaluate(workflow, gateTicket);
    const records = cap.records();
    cap.restore();
    expect(r.action).toBe("defer");
    expect(r.reason).toBe("head-unstable");
    expect(metric(records, "ShipHeadDeferred")).toBe(1);
  });

  it("head stable but CI not green on head (pending / ran on old sha) → defer", async () => {
    // CI green, but on an older SHA than the current head → not green on head.
    const githubProbe = vi.fn(async () => ({ headSha: HEAD, lastHeadMoveAt: NOW - 10 * 60 * 1000, ci: { sha: "OLDsha", conclusion: "success" } }));
    const { gate } = makeGate({ mode: "enforce", githubProbe });
    const r = await gate.evaluate(workflow, gateTicket);
    expect(r.action).toBe("defer");
    expect(r.reason).toBe("ci-not-green-on-head");
  });

  it("CI red ON THE HEAD → dispatch (pass-through to CI-fix, never masked)", async () => {
    const githubProbe = vi.fn(async () => ({ headSha: HEAD, lastHeadMoveAt: NOW - 30 * 1000, ci: { sha: HEAD, conclusion: "failure" } }));
    const { gate } = makeGate({ mode: "enforce", githubProbe });
    const r = await gate.evaluate(workflow, gateTicket);
    expect(r.action).toBe("dispatch");
    expect(r.reason).toBe("ci-red-passthrough");
  });

  it("deferrals >= maxDeferrals → dispatch (deadlock fail-open), ShipHeadDeadlockForced=1", async () => {
    const githubProbe = vi.fn(async () => ({ headSha: HEAD, lastHeadMoveAt: NOW - 30 * 1000, ci: { sha: HEAD, conclusion: "success" } }));
    const { gate } = makeGate({ mode: "enforce", maxDeferrals: 3, githubProbe });
    const cap = captureMetrics();
    const r = await gate.evaluate({ ...workflow, shipHeadDeferrals: 3 }, gateTicket);
    const records = cap.records();
    cap.restore();
    expect(r.action).toBe("dispatch");
    expect(r.reason).toBe("deadlock-forced");
    expect(metric(records, "ShipHeadDeadlockForced")).toBe(1);
  });

  it("githubProbe throws → dispatch (fail open), ShipHeadProbeErrors=1", async () => {
    const githubProbe = vi.fn(async () => { throw new Error("gh 502"); });
    const { gate } = makeGate({ mode: "enforce", githubProbe });
    const cap = captureMetrics();
    const r = await gate.evaluate(workflow, gateTicket);
    const records = cap.records();
    cap.restore();
    expect(r.action).toBe("dispatch");
    expect(r.reason).toBe("probe-error");
    expect(metric(records, "ShipHeadProbeErrors")).toBe(1);
  });
});

describe("unrecognized mode → fails safe to off (never defers)", () => {
  it('legacy "on" is treated as off (strict allow-list, opposite of merge-on-green)', async () => {
    const { gate, githubProbe } = makeGate({ mode: "on" });
    expect(gate.mode).toBe("off");
    const r = await gate.evaluate(workflow, gateTicket);
    expect(r.action).toBe("dispatch");
    expect(githubProbe).not.toHaveBeenCalled();
  });

  it("garbage mode → off", async () => {
    const { gate } = makeGate({ mode: "xyzzy" });
    expect(gate.mode).toBe("off");
  });
});

import { aggregateCheckConclusion, createGitHubShipHeadProbe } from "./ship-head-stability.mjs";

describe("aggregateCheckConclusion", () => {
  it("no runs → none", () => expect(aggregateCheckConclusion([])).toBe("none"));
  it("undefined → none", () => expect(aggregateCheckConclusion(undefined)).toBe("none"));
  it("any not-completed → pending", () =>
    expect(aggregateCheckConclusion([
      { status: "completed", conclusion: "success" },
      { status: "in_progress", conclusion: null },
    ])).toBe("pending"));
  it("all completed, one failure → failure", () =>
    expect(aggregateCheckConclusion([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
    ])).toBe("failure"));
  it("all completed, neutral/skipped count as green → success", () =>
    expect(aggregateCheckConclusion([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "neutral" },
      { status: "completed", conclusion: "skipped" },
    ])).toBe("success"));
  it("hard-negatives beyond failure (timed_out/cancelled/action_required/stale) → failure", () => {
    for (const c of ["timed_out", "cancelled", "action_required", "stale"]) {
      expect(aggregateCheckConclusion([{ status: "completed", conclusion: c }])).toBe("failure");
    }
  });
});

describe("createGitHubShipHeadProbe", () => {
  const parseRepoUrl = () => ({ owner: "o", repo: "r" });
  const wf = { repoConfig: {}, featureBranch: "feature/x" };

  it("null head when repo/branch unresolvable", async () => {
    const probe = createGitHubShipHeadProbe({ githubApi: async () => [], parseRepoUrl: () => ({}) });
    expect(await probe(wf)).toEqual({ headSha: null, lastHeadMoveAt: null, ci: {} });
  });

  it("no open PR → null head (never a false green)", async () => {
    const probe = createGitHubShipHeadProbe({ githubApi: async () => [], parseRepoUrl });
    expect(await probe(wf)).toEqual({ headSha: null, lastHeadMoveAt: null, ci: {} });
  });

  it("assembles headSha + lastHeadMoveAt + aggregated ci on the exact head", async () => {
    const when = "2026-09-05T00:00:00Z";
    const githubApi = vi.fn(async (path) => {
      if (path.includes("/pulls?")) return [{ number: 7, head: { sha: "SHA9" } }];
      if (path.endsWith("/commits/SHA9")) return { commit: { committer: { date: when } } };
      if (path.endsWith("/commits/SHA9/check-runs")) return { check_runs: [{ status: "completed", conclusion: "success" }] };
      throw new Error(`unexpected ${path}`);
    });
    const probe = createGitHubShipHeadProbe({ githubApi, parseRepoUrl });
    const r = await probe(wf);
    expect(r.headSha).toBe("SHA9");
    expect(r.lastHeadMoveAt).toBe(Date.parse(when));
    expect(r.ci).toEqual({ sha: "SHA9", conclusion: "success" });
  });

  it("unparseable commit date → lastHeadMoveAt null (gate reads null as stable)", async () => {
    const githubApi = async (path) => {
      if (path.includes("/pulls?")) return [{ head: { sha: "S" } }];
      if (path.endsWith("/commits/S")) return { commit: { committer: { date: "not-a-date" } } };
      return { check_runs: [{ status: "in_progress" }] };
    };
    const probe = createGitHubShipHeadProbe({ githubApi, parseRepoUrl });
    const r = await probe(wf);
    expect(r.lastHeadMoveAt).toBeNull();
    expect(r.ci.conclusion).toBe("pending");
  });
});
