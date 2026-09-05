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
  ackedGateBypasses,
  gateBypassBlockReason,
  gateDoneWithoutLedger,
  gateLedgerEpoch,
  GATE_BYPASS_GRACE_MS,
  GATE_LEDGER_EPOCH_DEFAULT,
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
  const claims = [];
  const held = new Set();
  return {
    merges,
    statuses,
    notifications,
    claims,
    // Mirrors claimGateBypassFlag's contract (TEAM-4099 F2): the conditional
    // stamp admits exactly ONE winner per (workflow, ticket, scope). The check
    // and the insert are synchronous, so two concurrent callers really do race.
    claimGateBypassFlag: async (wf, tid, opts = {}) => {
      claims.push({ wf, tid, ...opts });
      const key = `${wf}/${tid}/${opts.shadow ? "shadow" : "flag"}`;
      if (held.has(key)) return { won: false };
      held.add(key);
      return { won: true };
    },
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

/**
 * A run old enough to predate the gate ledger (TEAM-4099 F3): created before
 * GATE_LEDGER_EPOCH and carrying no `reviewGateHistory` attribute at all. Only such
 * a run may treat a `done` gate ticket as the approval.
 */
const PRE_LEDGER_WF = { createdAt: "2026-09-01T00:00:00Z" };

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

  it("empty ledger + gate ticket done on a PRE-LEDGER run → one legacy_status APPROVE at updatedAt", () => {
    const rows = approvalsFor(PRE_LEDGER_WF, { ticketId: "TEAM-9", status: "done", updatedAt: iso(NOW - 900_000) });
    expect(rows).toEqual([
      { decision: "APPROVE", decidedAt: iso(NOW - 900_000), approvalSource: "legacy_status" },
    ]);
  });

  it("empty ledger + gate ticket still open → no approvals", () => {
    expect(approvalsFor(PRE_LEDGER_WF, { ticketId: "TEAM-9", status: "in_review" })).toEqual([]);
    expect(approvalsFor(PRE_LEDGER_WF, null)).toEqual([]);
  });
});

// ─── the legacy_status fence (TEAM-4099 F3) ───────────────────────────────────

/**
 * F3, second half: `legacy_status` was a forgeable approval. `transition_ticket`
 * is an ordinary agent tool with no caller identity, so an agent could move its own
 * merge gate to `done` and have the detector read that board status as the APPROVE
 * that certified the merge it had just performed. The stand-in is now fenced to runs
 * that provably predate the ledger; for everything else a `done` gate with no
 * APPROVE row is simply no approval.
 */
describe("legacy_status is fenced to pre-ledger runs", () => {
  const savedEpoch = process.env.GATE_LEDGER_EPOCH;
  afterEach(() => {
    if (savedEpoch === undefined) delete process.env.GATE_LEDGER_EPOCH;
    else process.env.GATE_LEDGER_EPOCH = savedEpoch;
  });

  const doneGate = { ticketId: "TEAM-9", status: "done", updatedAt: iso(NOW - 900_000) };

  it("a NEW run (created after the epoch) gets NO approval from a done gate", () => {
    const wf = { createdAt: iso(NOW - 3_600_000) }; // 2026-09-05T11:00Z, post-epoch
    expect(approvalsFor(wf, doneGate)).toEqual([]);
    expect(gateDoneWithoutLedger(wf, doneGate)).toBe(true);
  });

  // A run with the attribute demonstrably had a ledger to write to, so an empty one
  // is a real absence of decisions — not the pre-ledger blind spot.
  it("a run that HAS a reviewGateHistory attribute is never eligible, however old", () => {
    for (const history of [{}, { "TEAM-9": {} }, { "TEAM-9": { decisions: [] } }]) {
      const wf = { createdAt: "2026-08-01T00:00:00Z", reviewGateHistory: history };
      expect(approvalsFor(wf, doneGate)).toEqual([]);
      expect(gateDoneWithoutLedger(wf, doneGate)).toBe(true);
    }
  });

  // A run that cannot prove it predates the ledger does not get the ledger's
  // exemption — absent/garbage createdAt is not evidence of age.
  it("an absent or unparseable createdAt is not evidence of age", () => {
    for (const wf of [{}, { createdAt: null }, { createdAt: "last tuesday" }]) {
      expect(approvalsFor(wf, doneGate)).toEqual([]);
      expect(gateDoneWithoutLedger(wf, doneGate)).toBe(true);
    }
  });

  it("an OLD run with no ledger attribute keeps the legacy stand-in", () => {
    expect(approvalsFor(PRE_LEDGER_WF, doneGate)[0]).toMatchObject({ approvalSource: "legacy_status" });
    expect(gateDoneWithoutLedger(PRE_LEDGER_WF, doneGate)).toBe(false);
  });

  it("a real ledger APPROVE always wins, on either side of the epoch", () => {
    const wf = {
      createdAt: iso(NOW - 3_600_000),
      reviewGateHistory: { "TEAM-9": { decisions: [decision("APPROVE", NOW - 1_800_000)] } },
    };
    expect(approvalsFor(wf, doneGate)).toEqual([
      { decision: "APPROVE", decidedAt: iso(NOW - 1_800_000), approvalSource: "ledger" },
    ]);
    expect(gateDoneWithoutLedger(wf, doneGate)).toBe(false);
  });

  it("gateDoneWithoutLedger only speaks about DONE gates", () => {
    expect(gateDoneWithoutLedger({}, { ticketId: "TEAM-9", status: "in_review" })).toBe(false);
    expect(gateDoneWithoutLedger({}, null)).toBe(false);
  });

  it("GATE_LEDGER_EPOCH overrides the default for a later deploy", () => {
    delete process.env.GATE_LEDGER_EPOCH;
    expect(gateLedgerEpoch()).toBe(GATE_LEDGER_EPOCH_DEFAULT);
    process.env.GATE_LEDGER_EPOCH = "not a date";
    expect(gateLedgerEpoch()).toBe(GATE_LEDGER_EPOCH_DEFAULT); // garbage never widens the fence

    // An operator who shipped the ledger later moves the fence forward: a run this
    // default would call "new" is legacy again under their own epoch.
    process.env.GATE_LEDGER_EPOCH = "2026-10-01T00:00:00Z";
    const wf = { createdAt: iso(NOW - 3_600_000) };
    expect(approvalsFor(wf, doneGate)[0]).toMatchObject({ approvalSource: "legacy_status" });
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
    expect(result).toMatchObject({ checked: true, bypasses: 1, deferred: 0, flagged: true });

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
      // The gate is still in_review here, so "no approval yet" needs no explanation
      // beyond the missing ledger row (contrast the F3 done-gate case below).
      reason: null,
      mode: "enforce",
    });

    expect(store.statuses).toEqual([{ wf: WF_ID, tid: DEV, status: "in_review" }]);
    // TEAM-4099 F2: the flag is stamped by the CAS (claimGateBypassFlag), not by
    // an unconditional metadata merge — and it is the FIRST write on the path.
    expect(store.merges).toEqual([]);
    expect(store.claims).toEqual([
      { wf: WF_ID, tid: DEV, mergeCommit: "sha1", flaggedAt: iso(NOW), shadow: false },
    ]);
    expect(store.notifications).toHaveLength(1);
    expect(store.notifications[0]).toMatchObject({
      id: `notif_gate_bypass_${WF_ID}_sha1`,
      type: "manager_escalation",
      acknowledged: false,
      ticketId: DEV,
      mergeCommit: "sha1",
    });
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toContain("Merge without approval");
  });

  // TEAM-4099 F1: the escalation used to carry `kind`, but every consumer — the
  // console escalations route, the Telegram intake, the WM watch gate — selects
  // on `type === "manager_escalation"`. A notification nobody can see is a
  // notification nobody can ACK, and an unacked gate bypass blocks completion
  // forever, so the shape is load-bearing, not cosmetic.
  it("the escalation is shaped so the escalations route can list AND ack it (F1)", async () => {
    const { store } = await run();
    const n = store.notifications[0];
    expect(n).toMatchObject({
      type: "manager_escalation",
      title: "Merge without approval (gate bypass)",
      reviewer: "gate-bypass",
      acknowledged: false,
    });
    expect(n.details).toContain("Merge without approval");
    expect(typeof n.timestamp).toBe("string");
    expect(n.id).toBe(`notif_gate_bypass_${WF_ID}_sha1`); // still the idempotent id (F9)
    // Replicated verbatim from src/app/api/workflow/[id]/escalations/route.ts
    // (GET filter, line 40; PATCH skip, line 67) — the predicate that decides
    // whether a human ever sees this row.
    expect(n.type === "manager_escalation").toBe(true);
    expect(!(n.type !== "manager_escalation" || n.acknowledged)).toBe(true);
  });

  it("a second run for the SAME merge commit adds no duplicate escalation (F9)", async () => {
    const store = makeStore();
    await run({ store });
    await run({ store });
    expect(store.notifications).toHaveLength(1);
    expect(store.notifications[0].id).toBe(`notif_gate_bypass_${WF_ID}_sha1`);
  });

  // TEAM-4099 F2: the event was published BEFORE any conditional write, so a
  // re-Done (or the sweep racing a live cascade) re-announced a bypass a human
  // was already handling and re-parked the ticket. The claim CAS is now the
  // barrier for the whole side-effect set.
  it("a re-run of an already-flagged ticket is a total no-op — no second event, flip or escalation", async () => {
    const store = makeStore();
    const first = await run({ store });
    expect(first.events).toHaveLength(1);

    const second = await run({ store });
    expect(second.result).toMatchObject({ bypasses: 1, flagged: true, alreadyFlagged: true });
    expect(second.events).toEqual([]);
    expect(second.comments).toEqual([]);
    expect(store.statuses).toHaveLength(1);
    expect(store.notifications).toHaveLength(1);
  });

  it("two concurrent checks race the claim: exactly ONE event, flip and escalation (F2)", async () => {
    const store = makeStore();
    const [a, b] = await Promise.all([run({ store }), run({ store })]);
    const events = [...a.events, ...b.events];
    expect(events.filter((e) => e.type === "workflow.gate_bypass")).toHaveLength(1);
    expect(store.statuses).toHaveLength(1);
    expect(store.notifications).toHaveLength(1);
    expect([a.result.alreadyFlagged, b.result.alreadyFlagged].filter(Boolean)).toHaveLength(1);
    expect(store.claims).toHaveLength(2); // both tried; the CAS admitted one
  });

  it("an already-flagged task WITH its escalation on record short-circuits before GitHub is called", async () => {
    const calls = [];
    const gh = fakeGithub({ "&head=": [], "&base=main": [ghPr(1, iso(NOW - 900_000))] }, calls);
    const { result, events, store } = await run({
      gh,
      workflow: workflow({
        agentTasks: { [DEV]: { ticketId: DEV, gateBypassFlaggedAt: iso(NOW - 60_000) } },
        humanNotifications: [{ id: `notif_gate_bypass_${WF_ID}_sha1`, type: "manager_escalation", ticketId: DEV }],
      }),
    });
    expect(result).toEqual({ checked: false, reason: "already_flagged", flagged: true, alreadyFlagged: true });
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
    expect(store.claims).toEqual([]);
  });

  // The flag is written BEFORE the escalation, so a Lambda that dies in between
  // leaves a flagged task nothing is holding open. The next pass must self-heal the
  // escalation (id-idempotent) — but still not re-announce or re-flip.
  it("flagged but NOT escalated: the escalation is re-appended, with no second event or flip", async () => {
    const store = makeStore();
    store.claimGateBypassFlag = async (wf, tid, opts) => {
      store.claims.push({ wf, tid, ...opts });
      return { won: false }; // the dead flagger already holds it
    };
    const { result, events, comments } = await run({
      store,
      workflow: workflow({ agentTasks: { [DEV]: { ticketId: DEV, gateBypassFlaggedAt: iso(NOW - 60_000) } } }),
    });
    expect(result).toMatchObject({ checked: true, bypasses: 1, alreadyFlagged: true });
    expect(events).toEqual([]);
    expect(store.statuses).toEqual([]);
    expect(comments).toEqual([]);
    expect(store.notifications.map((n) => n.id)).toEqual([`notif_gate_bypass_${WF_ID}_sha1`]);
  });

  it("shadow: the event only — no status change, no enforcement flag, no escalation, no comment", async () => {
    const { result, events, comments, store } = await run({ mode: "shadow" });
    expect(result).toMatchObject({ checked: true, bypasses: 1 });
    expect(events[0].detail.mode).toBe("shadow");
    expect(store.statuses).toEqual([]);
    expect(store.merges).toEqual([]);
    expect(store.notifications).toEqual([]);
    expect(comments).toEqual([]);
    // The shadow claim exists (so measurement isn't double-counted on a re-run)
    // but is SHADOW-SCOPED: writing gateBypassFlaggedAt here would trip the F8
    // claimInvocation veto and make "measure only" un-reclaimable in practice.
    expect(store.claims).toEqual([
      { wf: WF_ID, tid: DEV, mergeCommit: "sha1", flaggedAt: iso(NOW), shadow: true },
    ]);
  });

  it("shadow re-run: the shadow claim suppresses a duplicate measurement event", async () => {
    const store = makeStore();
    await run({ store, mode: "shadow" });
    const { events, result } = await run({ store, mode: "shadow" });
    expect(events).toEqual([]);
    expect(result).toMatchObject({ alreadyFlagged: true });
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

  /** The same replay with the gate ticket already CLOSED (no ledger row). */
  async function replayWithDoneGate(workflowExtra) {
    const events = [];
    const store = makeStore();
    const result = await runGateBypassCheck({
      workflow: {
        id: WF_ID,
        repoConfig: { repos: [{ url: "https://github.com/o/r", defaultBranch: "main" }] },
        ...workflowExtra,
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
    return { result, events, store };
  }

  it("control: on a PRE-LEDGER run the gate ticket merely being done approves at ITS timestamp", async () => {
    // A legacy run whose gate ticket closed AFTER the merges is still a bypass —
    // "the gate is done now" was exactly the check that let sffzti through.
    const { result, events } = await replayWithDoneGate(PRE_LEDGER_WF);
    expect(result.bypasses).toBe(4);
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.detail.reason === null)).toBe(true);
  });

  // TEAM-4099 F3: the same fixture on a CURRENT run. The gate is done, the merges
  // came before it, and there is no ledger row — so the status is not an approval at
  // all and the escalation says which.
  it("on a NEW run a done gate with no ledger row is no approval: reason=gate_done_without_ledger", async () => {
    const { result, events, store } = await replayWithDoneGate({ createdAt: iso(NOW - 7_200_000) });
    expect(result.bypasses).toBe(4);
    expect(result.verdicts.every((v) => v.verdict === "bypass")).toBe(true);
    expect(result.verdicts.every((v) => v.approvalSource === "none")).toBe(true);
    expect(events.every((e) => e.detail.reason === "gate_done_without_ledger")).toBe(true);
    expect(events.every((e) => e.detail.approvalSource === "none")).toBe(true);
    expect(store.notifications[0].details).toContain("a board status is not an approval");
  });
});

// ─── hasUnackedGateBypass ─────────────────────────────────────────────────────

describe("hasUnackedGateBypass", () => {
  it("true while a gate-bypass escalation is unacked, false once acked", () => {
    const notif = (id, acknowledged) => ({ id, type: "manager_escalation", acknowledged });
    expect(hasUnackedGateBypass({ humanNotifications: [notif("notif_gate_bypass_wf1_sha1")] })).toBe(true);
    expect(hasUnackedGateBypass({ humanNotifications: [notif("notif_gate_bypass_wf1_sha1", true)] })).toBe(false);
  });

  it("other notification kinds and empty/absent lists never block", () => {
    expect(hasUnackedGateBypass({ humanNotifications: [{ id: "notif_review_wf1" }] })).toBe(false);
    expect(hasUnackedGateBypass({ humanNotifications: [] })).toBe(false);
    expect(hasUnackedGateBypass({})).toBe(false);
    expect(hasUnackedGateBypass(null)).toBe(false);
  });

  // The completion-blocked escalation is NOT a gate-bypass escalation: it is the
  // guard's own "this run cannot close" note. If the prefix matched it too, acking
  // the bypass would never be enough to release the run (and vice versa).
  it("the completion-blocked escalation is not itself a gate-bypass escalation", () => {
    const wf = { humanNotifications: [{ id: "notif_completion_gate_bypass_wf1", type: "manager_escalation" }] };
    expect(hasUnackedGateBypass(wf)).toBe(false);
    expect(ackedGateBypasses(wf)).toEqual([]);
  });
});

// ─── the accepted-bypass state (TEAM-4099 F1) ─────────────────────────────────

describe("ackedGateBypasses + gateBypassBlockReason", () => {
  const notif = (sha, acknowledged) => ({
    id: `notif_gate_bypass_wf1_${sha}`,
    type: "manager_escalation",
    mergeCommit: sha,
    prUrl: `https://github.com/o/r/pull/9`,
    acknowledged,
  });

  it("collects only the ACKED gate-bypass escalations", () => {
    const wf = { humanNotifications: [notif("aaa1111bbbb", true), notif("ccc2222dddd", false)] };
    expect(ackedGateBypasses(wf).map((n) => n.mergeCommit)).toEqual(["aaa1111bbbb"]);
    expect(ackedGateBypasses({})).toEqual([]);
    expect(ackedGateBypasses(null)).toEqual([]);
  });

  it("the blockReason names the PR and the short merge commit — never a green close", () => {
    expect(gateBypassBlockReason([notif("aaa1111bbbb", true)])).toBe(
      "gate bypass accepted: PR https://github.com/o/r/pull/9 merged aaa1111 before approval"
    );
    expect(gateBypassBlockReason([notif("aaa1111bbbb", true), notif("ccc2222dddd", true)])).toContain(
      "(+1 more merge(s))"
    );
    // Degenerate rows still produce a legible reason rather than "undefined".
    expect(gateBypassBlockReason([{}])).toBe("gate bypass accepted: PR unknown PR merged unknown commit before approval");
    expect(gateBypassBlockReason()).toContain("unknown PR");
  });
});
