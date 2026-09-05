import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * TEAM-3991 D1.1 — merge-without-approval detection.
 *
 * The regression this pins: wf sffzti merged four PRs while its Merge Approval
 * gate ticket was still open, and every existing check passed. The detector must
 * see ALL merged PRs (not the first one `featureBranchMergeProbe` finds), compare
 * each merge time against the gate LEDGER (not the gate ticket's status), and
 * escalate exactly once per offending merge commit.
 *
 * Harness (b): pure module + injected fetch/store. No AWS SDK, no vi.mock.
 */

import {
  findMergeApprovalGate,
  approvalsFor,
  evaluateGateBypass,
  listMergedPrsForRun,
  gateBypassMode,
  runGateBypassCheck,
  hasUnackedGateBypass,
  GATE_BYPASS_GRACE_MS,
} from "./gate-bypass.mjs";

// ─── harness ──────────────────────────────────────────────────────────────────

/** Substring-matched route table; records every requested path in `calls`. */
function fakeGithub(routes, calls = []) {
  return async (path) => {
    calls.push(path);
    const hit = Object.entries(routes).find(([k]) => String(path).includes(k));
    if (!hit) return [];
    const val = typeof hit[1] === "function" ? hit[1](path) : hit[1];
    if (val instanceof Error) throw val;
    return val;
  };
}

/** Async recorders standing in for workflow-store.mjs (the only writer, R2). */
function makeStore() {
  const merges = [];
  const statuses = [];
  const notifications = [];
  return {
    merges,
    statuses,
    notifications,
    setTaskStatus: async (wf, tid, status) => { statuses.push({ wf, tid, status }); },
    mergeTaskMetadataOrTrack: async (wf, tid, fields, seed) => { merges.push({ wf, tid, fields, seed }); return true; },
    // Mirrors appendNotificationOnce's contract: appends only for a new id.
    appendNotificationOnce: async (wf, notification) => {
      if (notifications.some((n) => n.id === notification.id)) return false;
      notifications.push(notification);
      return true;
    },
  };
}

const NOW = Date.parse("2026-09-05T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const pr = (number, mergedAt, extra = {}) => ({
  mergeCommit: `sha${number}`,
  prUrl: `https://github.com/o/r/pull/${number}`,
  mergedAt,
  number,
  ...extra,
});
const decision = (verdict, ms, extra = {}) => ({ decision: verdict, decidedAt: iso(ms), ...extra });

const GATE_DEF = {
  reviewGates: [
    { afterPhase: "ship", name: "Merge Approval", blocking: true, assignee: "human:engineer" },
  ],
};

// ─── evaluateGateBypass ───────────────────────────────────────────────────────

describe("evaluateGateBypass — approval-before-merge matrix", () => {
  it("APPROVE before the merge → clean, with the approval time and source", () => {
    const [v] = evaluateGateBypass({
      mergedPrs: [pr(1, iso(NOW - 60_000))],
      decisions: [decision("APPROVE", NOW - 600_000)],
      nowMs: NOW,
    });
    expect(v.verdict).toBe("clean");
    expect(v.approvedAt).toBe(iso(NOW - 600_000));
    expect(v.approvalSource).toBe("ledger");
  });

  it("merge BEFORE the only approval → bypass (the sffzti shape)", () => {
    const [v] = evaluateGateBypass({
      mergedPrs: [pr(1, iso(NOW - 600_000))],
      decisions: [decision("APPROVE", NOW - 60_000)],
      nowMs: NOW,
    });
    expect(v.verdict).toBe("bypass");
    expect(v.approvedAt).toBeNull();
    expect(v.approvalSource).toBeNull();
  });

  it("no approval at all but the merge is inside the grace window → deferred", () => {
    const [v] = evaluateGateBypass({
      mergedPrs: [pr(1, iso(NOW - 30_000))],
      decisions: [],
      nowMs: NOW,
    });
    expect(v.verdict).toBe("deferred");
    expect(GATE_BYPASS_GRACE_MS).toBe(180000);
  });

  it("no approval and the merge is past the grace window → bypass", () => {
    const [v] = evaluateGateBypass({
      mergedPrs: [pr(1, iso(NOW - GATE_BYPASS_GRACE_MS - 1000))],
      decisions: [],
      nowMs: NOW,
    });
    expect(v.verdict).toBe("bypass");
  });

  it("APPROVE → REQUEST_CHANGES → merge → bypass (the approval was withdrawn)", () => {
    const [v] = evaluateGateBypass({
      mergedPrs: [pr(1, iso(NOW - 60_000))],
      decisions: [decision("APPROVE", NOW - 900_000), decision("REQUEST_CHANGES", NOW - 300_000)],
      nowMs: NOW,
    });
    expect(v.verdict).toBe("bypass");
  });

  it("APPROVE → REQUEST_CHANGES → APPROVE → merge → clean (re-approved)", () => {
    const [v] = evaluateGateBypass({
      mergedPrs: [pr(1, iso(NOW - 60_000))],
      decisions: [
        decision("APPROVE", NOW - 900_000),
        decision("REQUEST_CHANGES", NOW - 600_000),
        decision("APPROVE", NOW - 300_000),
      ],
      nowMs: NOW,
    });
    expect(v.verdict).toBe("clean");
    expect(v.approvedAt).toBe(iso(NOW - 300_000));
  });

  it("a REQUEST_CHANGES landing AFTER the merge does not retro-invalidate it", () => {
    const [v] = evaluateGateBypass({
      mergedPrs: [pr(1, iso(NOW - 300_000))],
      decisions: [decision("APPROVE", NOW - 600_000), decision("REQUEST_CHANGES", NOW - 60_000)],
      nowMs: NOW,
    });
    expect(v.verdict).toBe("clean");
  });

  it("per-PR verdicts: one approved merge, one that beat the approval", () => {
    const verdicts = evaluateGateBypass({
      mergedPrs: [pr(1, iso(NOW - 900_000)), pr(2, iso(NOW - 60_000))],
      decisions: [decision("APPROVE", NOW - 300_000)],
      nowMs: NOW,
    });
    expect(verdicts.map((v) => v.verdict)).toEqual(["bypass", "clean"]);
  });

  it("unparsable / missing decidedAt rows are ignored, not trusted", () => {
    const [v] = evaluateGateBypass({
      mergedPrs: [pr(1, iso(NOW - 900_000))],
      decisions: [{ decision: "APPROVE" }, { decision: "APPROVE", decidedAt: "not-a-date" }],
      nowMs: NOW,
    });
    expect(v.verdict).toBe("bypass");
  });

  it("no merged PRs → no verdicts", () => {
    expect(evaluateGateBypass({ mergedPrs: [], decisions: [], nowMs: NOW })).toEqual([]);
  });
});

// ─── findMergeApprovalGate ────────────────────────────────────────────────────

describe("findMergeApprovalGate", () => {
  const gatePhaseOf = (c) => c.phase;

  it("matches the human child by GUARDED PHASE, not by title or assignee string", () => {
    const children = [
      { ticketId: "TEAM-1", assignee: "agentcore_hub_backend_dev", phase: "development" },
      { ticketId: "TEAM-9", assignee: "human:alice@example.com", phase: "ship", title: "Sign it off" },
    ];
    const found = findMergeApprovalGate(children, GATE_DEF, { gatePhaseOf });
    expect(found.gate.name).toBe("Merge Approval");
    expect(found.ticket.ticketId).toBe("TEAM-9");
  });

  it("falls back to a title match when no phase resolves", () => {
    const children = [{ ticketId: "TEAM-9", assignee: "human:bob", title: "Merge Approval" }];
    const found = findMergeApprovalGate(children, GATE_DEF, { gatePhaseOf });
    expect(found.ticket.ticketId).toBe("TEAM-9");
  });

  it("agent-assigned children never count as the gate", () => {
    const children = [{ ticketId: "TEAM-1", assignee: "agentcore_hub_release_manager", phase: "ship", title: "Merge Approval" }];
    expect(findMergeApprovalGate(children, GATE_DEF, { gatePhaseOf }).ticket).toBeNull();
  });

  it("a def with no reviewGates is inert (marketing/sales)", () => {
    expect(findMergeApprovalGate([{ assignee: "human:x", phase: "ship" }], { phases: [] }, { gatePhaseOf })).toBeNull();
  });

  it("a def whose only gate is not a merge gate is inert (legal Counsel Sign-off)", () => {
    const legal = { reviewGates: [{ afterPhase: "redline", name: "Counsel Sign-off" }] };
    expect(findMergeApprovalGate([{ assignee: "human:x", phase: "redline" }], legal, { gatePhaseOf })).toBeNull();
  });
});

// ─── approvalsFor ─────────────────────────────────────────────────────────────

describe("approvalsFor", () => {
  it("returns the ledger rows in order, stamped approvalSource=ledger", () => {
    const wf = {
      reviewGateHistory: {
        "TEAM-9": { decisions: [decision("APPROVE", NOW - 100), decision("REQUEST_CHANGES", NOW - 50)] },
      },
    };
    const rows = approvalsFor(wf, { ticketId: "TEAM-9", status: "done" });
    expect(rows.map((r) => r.decision)).toEqual(["APPROVE", "REQUEST_CHANGES"]);
    expect(rows.every((r) => r.approvalSource === "ledger")).toBe(true);
  });

  it("empty ledger + gate ticket done → one legacy_status APPROVE at updatedAt", () => {
    const rows = approvalsFor({}, { ticketId: "TEAM-9", status: "done", updatedAt: iso(NOW - 900_000) });
    expect(rows).toEqual([
      { decision: "APPROVE", decidedAt: iso(NOW - 900_000), approvalSource: "legacy_status" },
    ]);
  });

  it("empty ledger + gate ticket still open → no approvals", () => {
    expect(approvalsFor({}, { ticketId: "TEAM-9", status: "in_review" })).toEqual([]);
    expect(approvalsFor({}, null)).toEqual([]);
  });
});

// ─── listMergedPrsForRun ──────────────────────────────────────────────────────

describe("listMergedPrsForRun", () => {
  const ghPr = (number, mergedAt) => ({
    number,
    merged_at: mergedAt,
    merge_commit_sha: `sha${number}`,
    html_url: `https://github.com/o/r/pull/${number}`,
    head: { sha: `head${number}`, ref: `feature/TEAM-1-dev` },
  });

  it("paginates until a short page and keeps only merged PRs", async () => {
    const calls = [];
    const gh = fakeGithub({
      "page=1": [ghPr(1, iso(NOW - 1000)), { number: 2, merged_at: null }],
      "page=2": [ghPr(3, iso(NOW - 500))],
    }, calls);
    const { prs } = await listMergedPrsForRun(gh, { owner: "o", repo: "r", branches: ["b"], perPage: 2 });
    expect(prs.map((p) => p.number)).toEqual([1, 3]);
    expect(calls).toHaveLength(2); // page 2 was short → stopped
    expect(prs[0]).toEqual({
      mergeCommit: "sha1",
      prUrl: "https://github.com/o/r/pull/1",
      mergedAt: iso(NOW - 1000),
      number: 1,
      headSha: "head1",
      headRef: "feature/TEAM-1-dev",
    });
  });

  it("dedupes by PR number across branches and skips empty branch names", async () => {
    const gh = fakeGithub({ "/pulls": [ghPr(7, iso(NOW - 1000))] });
    const { prs } = await listMergedPrsForRun(gh, {
      owner: "o", repo: "r", branches: ["a", "", null, "b"], perPage: 100,
    });
    expect(prs.map((p) => p.number)).toEqual([7]);
  });

  it("encodes every path segment and query value", async () => {
    const calls = [];
    const gh = fakeGithub({ "/pulls": [] }, calls);
    await listMergedPrsForRun(gh, { owner: "my org", repo: "re po", branches: ["feature/a b"], perPage: 100 });
    expect(calls[0]).toBe(
      "/repos/my%20org/re%20po/pulls?state=closed&head=my%20org%3Afeature%2Fa%20b&per_page=100&page=1"
    );
  });

  it("a GitHub error yields { error, prs: [] } — never 'nothing merged'", async () => {
    const gh = fakeGithub({ "/pulls": new Error("GitHub GET /pulls 502: bad gateway") });
    const res = await listMergedPrsForRun(gh, { owner: "o", repo: "r", branches: ["b"] });
    expect(res.prs).toEqual([]);
    expect(res.error).toContain("502");
  });

  it("no branches → no requests", async () => {
    const calls = [];
    const gh = fakeGithub({ "/pulls": [] }, calls);
    expect(await listMergedPrsForRun(gh, { owner: "o", repo: "r", branches: [] })).toEqual({ prs: [] });
    expect(calls).toEqual([]);
  });
});

// ─── gateBypassMode ───────────────────────────────────────────────────────────

describe("gateBypassMode", () => {
  const saved = process.env.GATE_BYPASS_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_BYPASS_MODE;
    else process.env.GATE_BYPASS_MODE = saved;
  });

  it("defaults to enforce when unset or unrecognised", () => {
    delete process.env.GATE_BYPASS_MODE;
    expect(gateBypassMode()).toBe("enforce");
    process.env.GATE_BYPASS_MODE = "yes-please";
    expect(gateBypassMode()).toBe("enforce");
  });

  it("normalises case and whitespace for the three real modes", () => {
    for (const raw of [" OFF ", "Shadow", "ENFORCE"]) {
      process.env.GATE_BYPASS_MODE = raw;
      expect(gateBypassMode()).toBe(raw.trim().toLowerCase());
    }
  });
});

// ─── runGateBypassCheck ───────────────────────────────────────────────────────

describe("runGateBypassCheck", () => {
  const WF_ID = "wf_sffzti";
  const DEV = "TEAM-100";
  const GATE = "TEAM-109";

  const workflow = (extra = {}) => ({
    id: WF_ID,
    featureBranch: "feature/EPIC-1-thing",
    repoConfig: { repos: [{ url: "https://github.com/o/r", defaultBranch: "main" }] },
    ...extra,
  });
  const children = () => [
    { ticketId: DEV, assignee: "agentcore_hub_release_manager", phase: "ship" },
    { ticketId: GATE, assignee: "human:alice@example.com", phase: "ship", title: "Merge Approval", status: "in_review" },
  ];
  const ticket = { ticketId: DEV, assignee: "agentcore_hub_release_manager", status: "done" };
  const gatePhaseOf = (c) => (c.assignee?.startsWith("human:") ? c.phase : c.phase);

  const ghPr = (number, mergedAt, ref = `feature/${DEV}-release-manager`) => ({
    number,
    merged_at: mergedAt,
    merge_commit_sha: `sha${number}`,
    html_url: `https://github.com/o/r/pull/${number}`,
    head: { sha: `head${number}`, ref },
  });

  function run(overrides = {}) {
    const events = [];
    const comments = [];
    const store = makeStore();
    const gh = overrides.gh || fakeGithub({
      "&head=": [],
      "&base=main": [ghPr(1, iso(NOW - 900_000))],
    });
    return runGateBypassCheck({
      workflow: overrides.workflow || workflow(),
      ticket: overrides.ticket || ticket,
      children: overrides.children || children(),
      workflowDef: overrides.workflowDef || GATE_DEF,
      deps: {
        githubFetch: gh,
        store: overrides.store || store,
        publishEvent: async (tid, type, detail) => { events.push({ tid, type, detail }); },
        addTicketComment: async (tid, text) => { comments.push({ tid, text }); },
        gatePhaseOf,
        now: () => NOW,
        log: { warn: () => {} },
        mode: overrides.mode || "enforce",
      },
    }).then((result) => ({ result, events, comments, store: overrides.store || store }));
  }

  it("enforce: event + in_review + gateBypassFlaggedAt + one escalation + a comment", async () => {
    const { result, events, comments, store } = await run();
    expect(result).toMatchObject({ checked: true, bypasses: 1, deferred: 0 });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("workflow.gate_bypass");
    expect(events[0].detail).toEqual({
      workflowId: WF_ID,
      ticketId: DEV,
      mergeCommit: "sha1",
      prUrl: "https://github.com/o/r/pull/1",
      mergedAt: iso(NOW - 900_000),
      gateTicketId: GATE,
      approvedAt: null,
      approvalSource: null,
      mode: "enforce",
    });

    expect(store.statuses).toEqual([{ wf: WF_ID, tid: DEV, status: "in_review" }]);
    expect(store.merges).toHaveLength(1);
    expect(store.merges[0].fields).toEqual({
      gateBypassFlaggedAt: iso(NOW),
      gateBypassMergeCommit: "sha1",
    });
    expect(store.notifications).toHaveLength(1);
    expect(store.notifications[0]).toMatchObject({
      id: `notif_gate_bypass_${WF_ID}_sha1`,
      kind: "manager_escalation",
      ticketId: DEV,
      mergeCommit: "sha1",
    });
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toContain("Merge without approval");
  });

  it("a second run for the SAME merge commit adds no duplicate escalation (F9)", async () => {
    const store = makeStore();
    await run({ store });
    await run({ store });
    expect(store.notifications).toHaveLength(1);
    expect(store.notifications[0].id).toBe(`notif_gate_bypass_${WF_ID}_sha1`);
  });

  it("shadow: the event only — no status change, no flag, no escalation, no comment", async () => {
    const { result, events, comments, store } = await run({ mode: "shadow" });
    expect(result).toMatchObject({ checked: true, bypasses: 1 });
    expect(events[0].detail.mode).toBe("shadow");
    expect(store.statuses).toEqual([]);
    expect(store.merges).toEqual([]);
    expect(store.notifications).toEqual([]);
    expect(comments).toEqual([]);
  });

  it("off: fully inert", async () => {
    const { result, events, store } = await run({ mode: "off" });
    expect(result).toEqual({ checked: false, reason: "mode_off" });
    expect(events).toEqual([]);
    expect(store.merges).toEqual([]);
  });

  it("a human ticket's own done is never a bypass", async () => {
    const { result, events } = await run({ ticket: { ticketId: GATE, assignee: "human:alice@example.com", status: "done" } });
    expect(result).toEqual({ checked: false, reason: "human_ticket" });
    expect(events).toEqual([]);
  });

  it("a def without a merge gate → not checked (F7 scope is the def's gate)", async () => {
    const { result } = await run({ workflowDef: { reviewGates: [] } });
    expect(result).toEqual({ checked: false, reason: "no_merge_gate" });
  });

  it("no repo config → not checked", async () => {
    const { result } = await run({ workflow: workflow({ repoConfig: null }) });
    expect(result).toEqual({ checked: false, reason: "no_repo" });
  });

  it("GitHub unreachable → NO verdict (never 'nothing merged')", async () => {
    const gh = fakeGithub({ "/pulls": new Error("GitHub GET /pulls 503: unavailable") });
    const { result, events, store } = await run({ gh });
    expect(result).toEqual({ checked: false, reason: "github_unreachable" });
    expect(events).toEqual([]);
    expect(store.merges).toEqual([]);
  });

  it("a fresh merge with no approval defers with a re-check time, no escalation", async () => {
    const gh = fakeGithub({ "&head=": [], "&base=main": [ghPr(1, iso(NOW - 30_000))] });
    const { result, events, store } = await run({ gh });
    expect(result).toMatchObject({ checked: true, bypasses: 0, deferred: 1 });
    expect(events).toEqual([]);
    expect(store.notifications).toEqual([]);
    expect(store.merges[0].fields).toEqual({
      gateBypassCheckAt: iso(NOW + GATE_BYPASS_GRACE_MS),
      gateBypassMergeCommit: "sha1",
    });
  });

  it("an approved merge writes nothing at all", async () => {
    const wf = workflow({
      reviewGateHistory: { [GATE]: { decisions: [decision("APPROVE", NOW - 1_800_000)] } },
    });
    const { result, events, store } = await run({ workflow: wf });
    expect(result).toMatchObject({ checked: true, bypasses: 0, deferred: 0 });
    expect(result.verdicts[0].verdict).toBe("clean");
    expect(events).toEqual([]);
    expect(store.merges).toEqual([]);
    expect(store.statuses).toEqual([]);
  });

  it("finds per-ticket branch merges the run-branch head lookup misses", async () => {
    const calls = [];
    const gh = fakeGithub({
      "&head=": [],
      "&base=main": [
        ghPr(1, iso(NOW - 900_000), `feature/${DEV}-release-manager`),
        ghPr(2, iso(NOW - 800_000), "feature/OTHER-1-dev"), // another run's branch — ignored
      ],
    }, calls);
    const { result } = await run({ gh });
    expect(result.verdicts.map((v) => v.number)).toEqual([1]);
    expect(calls.some((p) => p.includes("&base=main"))).toBe(true);
  });

  it("never throws when a dep blows up mid-write", async () => {
    const store = makeStore();
    store.setTaskStatus = async () => { throw new Error("DDB down"); };
    const { result } = await run({ store });
    expect(result).toEqual({ checked: false, reason: "error" });
  });
});

// ─── the sffzti fixture ───────────────────────────────────────────────────────

describe("wf sffzti replay — 4 PRs merged before any approval", () => {
  const WF_ID = "wf_sffzti";
  const DEV = "TEAM-3897";
  const GATE = "TEAM-3899";
  const MERGES = [
    { number: 327, at: Date.parse("2026-09-01T09:00:00Z") },
    { number: 341, at: Date.parse("2026-09-02T10:00:00Z") },
    { number: 342, at: Date.parse("2026-09-02T11:00:00Z") },
    { number: 345, at: Date.parse("2026-09-03T12:00:00Z") },
  ];

  const gh = () => fakeGithub({
    "&head=": [],
    "&base=main": MERGES.map(({ number, at }) => ({
      number,
      merged_at: iso(at),
      merge_commit_sha: `sha${number}`,
      html_url: `https://github.com/o/r/pull/${number}`,
      head: { sha: `head${number}`, ref: `feature/${DEV}-release-manager` },
    })),
  });

  async function replay(reviewGateHistory) {
    const events = [];
    const store = makeStore();
    const result = await runGateBypassCheck({
      workflow: {
        id: WF_ID,
        featureBranch: "feature/EPIC-3890-si-system",
        repoConfig: { repos: [{ url: "https://github.com/o/r", defaultBranch: "main" }] },
        reviewGateHistory,
      },
      ticket: { ticketId: DEV, assignee: "agentcore_hub_release_manager", status: "done" },
      children: [
        { ticketId: DEV, assignee: "agentcore_hub_release_manager", phase: "ship" },
        { ticketId: GATE, assignee: "human:tycen@example.com", phase: "ship", title: "Merge Approval", status: "in_review" },
      ],
      workflowDef: GATE_DEF,
      deps: {
        githubFetch: gh(),
        store,
        publishEvent: async (tid, type, detail) => { events.push({ type, detail }); },
        addTicketComment: async () => {},
        gatePhaseOf: (c) => c.phase,
        now: () => NOW,
        log: { warn: () => {} },
        mode: "enforce",
      },
    });
    return { result, events, store };
  }

  it("flags all four merges: 4 gate_bypass events and 4 distinct escalation ids", async () => {
    const { result, events, store } = await replay(undefined);
    expect(result.bypasses).toBe(4);
    expect(result.verdicts.map((v) => v.verdict)).toEqual(["bypass", "bypass", "bypass", "bypass"]);
    expect(events.filter((e) => e.type === "workflow.gate_bypass")).toHaveLength(4);
    expect(events.map((e) => e.detail.mergeCommit)).toEqual(["sha327", "sha341", "sha342", "sha345"]);
    expect(new Set(store.notifications.map((n) => n.id)).size).toBe(4);
    expect(store.notifications.map((n) => n.id)).toEqual(
      MERGES.map(({ number }) => `notif_gate_bypass_${WF_ID}_sha${number}`)
    );
  });

  it("control: a ledger APPROVE earlier than every merge flags nothing", async () => {
    const { result, events, store } = await replay({
      [GATE]: { decisions: [decision("APPROVE", Date.parse("2026-08-31T08:00:00Z"))] },
    });
    expect(result.bypasses).toBe(0);
    expect(result.verdicts.every((v) => v.verdict === "clean")).toBe(true);
    expect(events).toEqual([]);
    expect(store.notifications).toEqual([]);
  });

  it("control: the gate ticket merely being done (legacy, no ledger) approves at ITS timestamp", async () => {
    // A legacy run whose gate ticket closed AFTER the merges is still a bypass —
    // "the gate is done now" was exactly the check that let sffzti through.
    const events = [];
    const store = makeStore();
    const result = await runGateBypassCheck({
      workflow: {
        id: WF_ID,
        repoConfig: { repos: [{ url: "https://github.com/o/r", defaultBranch: "main" }] },
      },
      ticket: { ticketId: DEV, assignee: "agentcore_hub_release_manager", status: "done" },
      children: [
        { ticketId: GATE, assignee: "human:tycen@example.com", phase: "ship", status: "done", updatedAt: iso(NOW) },
      ],
      workflowDef: GATE_DEF,
      deps: {
        githubFetch: gh(),
        store,
        publishEvent: async (tid, type, detail) => { events.push({ type, detail }); },
        addTicketComment: async () => {},
        gatePhaseOf: (c) => c.phase,
        now: () => NOW,
        log: { warn: () => {} },
        mode: "enforce",
      },
    });
    expect(result.bypasses).toBe(4);
    expect(events).toHaveLength(4);
  });
});

// ─── hasUnackedGateBypass ─────────────────────────────────────────────────────

describe("hasUnackedGateBypass", () => {
  it("true while a gate-bypass escalation is unacked, false once acked", () => {
    const notif = (id, acknowledged) => ({ id, kind: "manager_escalation", acknowledged });
    expect(hasUnackedGateBypass({ humanNotifications: [notif("notif_gate_bypass_wf1_sha1")] })).toBe(true);
    expect(hasUnackedGateBypass({ humanNotifications: [notif("notif_gate_bypass_wf1_sha1", true)] })).toBe(false);
  });

  it("other notification kinds and empty/absent lists never block", () => {
    expect(hasUnackedGateBypass({ humanNotifications: [{ id: "notif_review_wf1" }] })).toBe(false);
    expect(hasUnackedGateBypass({ humanNotifications: [] })).toBe(false);
    expect(hasUnackedGateBypass({})).toBe(false);
    expect(hasUnackedGateBypass(null)).toBe(false);
  });
});
