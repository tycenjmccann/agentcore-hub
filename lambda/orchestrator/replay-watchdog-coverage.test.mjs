import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReconcileSweep } from "./reconcile-sweep.mjs";
import { resolveWatchdog, LEGACY_WATCHDOG } from "./watchdog.mjs";

/**
 * TEAM-4739 W2/W3 replay — the stalls nothing in the system ever mentioned.
 *
 * Three real runs, none of which produced a single notification at the time:
 *
 *   fz514x   a human gate (`human:tycen`) went open at 08:14Z on 2026-09-14 and
 *            was still open hours later. The cascade was behaving CORRECTLY - it
 *            was waiting - so no code path had anything to say. Must page by
 *            2026-09-14T12:18Z.
 *   37ule1   the same shape four hours later (open from 12:14Z). Must page by
 *            2026-09-14T16:18Z.
 *   TEAM-4660 a gate that closed at 06:20Z and was re-filed at 07:30Z. That is a
 *            70-minute gap - ordinary sequential work, NOT the close/re-file
 *            loop W3 exists to catch. Must produce NO page at all.
 *
 * WHY THE WATCHDOG DID NOT COVER THIS. `watchdog.mjs` is a CONFIG RESOLVER
 * (heartbeat interval, tool deadline, turn timeout, all per-agent). It is not a
 * pager and it never looks at a ticket, so a human gate nobody answers is
 * outside it by construction. This fixture only READS it, to keep that division
 * of labour asserted; watchdog.mjs is untouched by TEAM-4739.
 *
 * Fixture shape: the REAL sweep with its I/O seams mocked (ddb scan, sibling
 * fetch, cascade, and the two injected W2/W3 deps).
 */

const HOUR = 60 * 60 * 1000;
const at = (iso) => Date.parse(iso);

// The 5-minute EventBridge grid the sweep actually runs on.
const gridAfter = (ms) => Math.ceil(ms / (5 * 60 * 1000)) * (5 * 60 * 1000);

function makeSweep({ workflow, siblings, nowMs, streamedAt = {}, mode = "enforce" }) {
  const notifications = [];
  const logs = [];
  const deps = {
    ddb: { send: vi.fn(async (cmd) => (cmd.constructor.name === "ScanCommand" ? { Items: [workflow] } : { Items: [] })) },
    workflowsTable: "workflows",
    cascade: { reconcileDependent: vi.fn(async () => "noop") },
    getChildTickets: vi.fn(async () => siblings),
    leaseTtlMs: 30 * 60 * 1000,
    now: () => nowMs,
    log: (msg) => logs.push(msg),
    appendNotification: vi.fn(async (wfId, id, notification, opts) => {
      notifications.push({ wfId, id, notification, opts });
      return true;
    }),
    // TICKET-scoped liveness, exactly as index.mjs wires it (lease.lastStreamedText
    // with {withTimestamp:true}). The map is keyed by ticket so a busy sibling's
    // frames cannot be read as this ticket's.
    lastStreamedTextAt: vi.fn(async (_wfId, _agentId, ticketId) => streamedAt[ticketId] || ""),
  };
  const { runSweep } = createReconcileSweep(deps);
  return { runSweep: () => runSweep(mode), notifications, logs, deps };
}

const wf = (id, epicId) => ({ id, workflowId: id, epicId, phase: "review" });

/** An unanswered human gate ticket: assigned to a person, sitting in in_review. */
const gate = (ticketId, updatedAt, extra = {}) => ({
  ticketId, type: "task", status: "in_review", assignee: "human:tycen",
  labels: ["gate:approval"], updatedAt, createdAt: updatedAt, ...extra,
});

beforeEach(() => vi.clearAllMocks());

describe("replay fz514x / 37ule1 — an unanswered human gate now pages (TEAM-4739 W2)", () => {
  it("fz514x: silent from 08:14Z pages on the first sweep at/before 12:18Z", async () => {
    const OPENED = at("2026-09-14T08:14:00Z");
    const DEADLINE = at("2026-09-14T12:18:00Z");
    const fires = gridAfter(OPENED + 4 * HOUR);
    expect(fires).toBeLessThanOrEqual(DEADLINE); // 12:15Z - the assertion the run failed

    const siblings = [gate("TEAM-4610", new Date(OPENED).toISOString())];
    const early = makeSweep({ workflow: wf("fz514x", "TEAM-4600"), siblings, nowMs: fires - 5 * 60 * 1000 });
    const m0 = await early.runSweep();
    expect(m0.watchGate).toBe(0);
    expect(early.notifications).toEqual([]);

    const onTime = makeSweep({ workflow: wf("fz514x", "TEAM-4600"), siblings, nowMs: fires });
    const m1 = await onTime.runSweep();

    expect(m1.watchGate).toBe(1);
    expect(onTime.notifications).toHaveLength(1);
    const { id, notification, opts } = onTime.notifications[0];
    expect(id).toBe("notif_watch_gate_TEAM-4610");
    expect(notification.type).toBe("manager_escalation");
    expect(notification.watch).toBe("watch_gate");
    expect(opts).toEqual({ maxCount: 6 });
  });

  it("37ule1: the same gate shape four hours later pages by 16:18Z", async () => {
    const OPENED = at("2026-09-14T12:14:00Z");
    const fires = gridAfter(OPENED + 4 * HOUR);
    expect(fires).toBeLessThanOrEqual(at("2026-09-14T16:18:00Z"));

    const s = makeSweep({
      workflow: wf("37ule1", "TEAM-4640"),
      siblings: [gate("TEAM-4650", new Date(OPENED).toISOString())],
      nowMs: fires,
    });
    const m = await s.runSweep();

    expect(m.watchGate).toBe(1);
    expect(s.notifications[0].id).toBe("notif_watch_gate_TEAM-4650");
  });

  it("a busy sibling does NOT mask the wedged gate (ticket-scoped liveness)", async () => {
    // The run is loud: a dev persona on TEAM-4611 has been streaming all along.
    // A workflow-wide activity read would call the gate "alive" and stay quiet -
    // which is precisely how this class of stall stayed invisible.
    const OPENED = at("2026-09-14T08:14:00Z");
    const NOW = gridAfter(OPENED + 4 * HOUR);
    const siblings = [
      gate("TEAM-4610", new Date(OPENED).toISOString()),
      { ticketId: "TEAM-4611", type: "task", status: "in_progress", assignee: "agentcore_hub_backend_dev", updatedAt: new Date(NOW - 30_000).toISOString() },
    ];
    const s = makeSweep({
      workflow: wf("fz514x", "TEAM-4600"),
      siblings,
      nowMs: NOW,
      streamedAt: { "TEAM-4611": new Date(NOW - 30_000).toISOString() }, // loud sibling
    });

    const m = await s.runSweep();

    expect(m.watchGate).toBe(1);
    expect(s.notifications[0].id).toBe("notif_watch_gate_TEAM-4610");
    // The probe was asked about the GATE's ticket, not the workflow at large.
    expect(s.deps.lastStreamedTextAt).toHaveBeenCalledWith("fz514x", "human:tycen", "TEAM-4610");
    // And an agent ticket, however long it runs, is never a W2 page - that is
    // the dead-session detector's job.
    expect(s.notifications.every((n) => n.notification.ticketId !== "TEAM-4611")).toBe(true);
  });

  it("shadow mode observes the same page and writes nothing (RECONCILE_SWEEP_MODE)", async () => {
    const OPENED = at("2026-09-14T08:14:00Z");
    const s = makeSweep({
      workflow: wf("fz514x", "TEAM-4600"),
      siblings: [gate("TEAM-4610", new Date(OPENED).toISOString())],
      nowMs: gridAfter(OPENED + 4 * HOUR),
      mode: "shadow",
    });

    const m = await s.runSweep();

    expect(m.wouldwatchGate).toBe(1);
    expect(m.watchGate).toBe(0);
    expect(s.notifications).toEqual([]);
    expect(s.logs.some((l) => l.includes("reconcile.would_watch_gate (shadow)"))).toBe(true);
  });

  it("an open review_needed already put a human on it — no second page", async () => {
    const OPENED = at("2026-09-14T08:14:00Z");
    const NOW = gridAfter(OPENED + 4 * HOUR);
    const workflow = {
      ...wf("fz514x", "TEAM-4600"),
      humanNotifications: [{ id: "notif_review_TEAM-4610", type: "review_needed", ticketId: "TEAM-4610", createdAt: new Date(NOW - HOUR).toISOString(), acknowledged: false }],
    };
    const s = makeSweep({ workflow, siblings: [gate("TEAM-4610", new Date(OPENED).toISOString())], nowMs: NOW });

    const m = await s.runSweep();

    expect(m.watchGate).toBe(0);
    expect(s.notifications).toEqual([]);
  });
});

describe("replay TEAM-4660 — 06:20Z close, 07:30Z re-file is NOT a loop (TEAM-4739 W3)", () => {
  const CLOSED = "2026-09-14T06:20:00Z";
  const REFILED = "2026-09-14T07:30:00Z";
  const NOW = at("2026-09-14T08:00:00Z");
  const closedGate = {
    ticketId: "TEAM-4660", type: "task", status: "done", assignee: "human:tycen",
    labels: ["gate:deploy-approval"], updatedAt: CLOSED, createdAt: "2026-09-14T05:00:00Z",
  };

  it("70 minutes apart is sequential work — no false fire", async () => {
    const later = {
      ticketId: "TEAM-4661", type: "task", status: "in_review", assignee: "human:tycen",
      labels: ["gate:deploy-approval"], updatedAt: REFILED, createdAt: REFILED,
    };
    const s = makeSweep({ workflow: wf("37ule1", "TEAM-4640"), siblings: [closedGate, later], nowMs: NOW });

    const m = await s.runSweep();

    expect(m.watchRefile).toBe(0);
    expect(s.notifications.map((n) => n.id)).not.toContain("notif_watch_refile_TEAM-4660");
    // And the closed gate never becomes a recovery candidate either.
    expect(s.deps.cascade.reconcileDependent).not.toHaveBeenCalledWith(closedGate, expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it("the SAME pair 25 minutes apart is the loop, and it does fire", async () => {
    // The discriminator is the gap, not the shape: a gate re-filed inside 30m of
    // its own close is the close/re-file cycle each turn of which looks like
    // local progress.
    const quick = {
      ticketId: "TEAM-4662", type: "task", status: "in_review", assignee: "human:tycen",
      labels: ["gate:deploy-approval"], updatedAt: "2026-09-14T06:45:00Z", createdAt: "2026-09-14T06:45:00Z",
    };
    const s = makeSweep({ workflow: wf("37ule1", "TEAM-4640"), siblings: [closedGate, quick], nowMs: NOW });

    const m = await s.runSweep();

    expect(m.watchRefile).toBe(1);
    expect(s.notifications[0].id).toBe("notif_watch_refile_TEAM-4660");
    expect(s.notifications[0].notification.watch).toBe("watch_refile");
  });

  // SR2-4: the window used to be Math.abs(createdAt - closedMs) <= refileMs, which
  // is SYMMETRIC — a sibling already open 10m BEFORE the close (not a re-file at
  // all) fell inside it and paged a false watch_refile. This is the mutation
  // check: restoring Math.abs on the comparison line makes this one fail.
  it("SR2-4: a same-kind sibling created 10m BEFORE the close is not a re-file — no page", async () => {
    const before = {
      ticketId: "TEAM-4663", type: "task", status: "in_review", assignee: "human:tycen",
      labels: ["gate:deploy-approval"], updatedAt: "2026-09-14T06:10:00Z", createdAt: "2026-09-14T06:10:00Z",
    };
    const s = makeSweep({ workflow: wf("37ule1", "TEAM-4640"), siblings: [closedGate, before], nowMs: NOW });

    const m = await s.runSweep();

    expect(m.watchRefile).toBe(0);
    expect(s.notifications.map((n) => n.id)).not.toContain("notif_watch_refile_TEAM-4660");
  });

  it("SR2-4: the same shape 10m AFTER the close still pages", async () => {
    const after = {
      ticketId: "TEAM-4664", type: "task", status: "in_review", assignee: "human:tycen",
      labels: ["gate:deploy-approval"], updatedAt: "2026-09-14T06:30:00Z", createdAt: "2026-09-14T06:30:00Z",
    };
    const s = makeSweep({ workflow: wf("37ule1", "TEAM-4640"), siblings: [closedGate, after], nowMs: NOW });

    const m = await s.runSweep();

    expect(m.watchRefile).toBe(1);
    expect(s.notifications[0].id).toBe("notif_watch_refile_TEAM-4660");
  });

  it("SR2-4: an unparseable close timestamp never pages, even with a valid re-file sibling", async () => {
    const nanClosedGate = { ...closedGate, updatedAt: "not-a-date" };
    const validSibling = {
      ticketId: "TEAM-4665", type: "task", status: "in_review", assignee: "human:tycen",
      labels: ["gate:deploy-approval"], updatedAt: "2026-09-14T06:30:00Z", createdAt: "2026-09-14T06:30:00Z",
    };
    const s = makeSweep({ workflow: wf("37ule1", "TEAM-4640"), siblings: [nanClosedGate, validSibling], nowMs: NOW });

    const m = await s.runSweep();

    expect(m.watchRefile).toBe(0);
    expect(s.notifications.map((n) => n.id)).not.toContain("notif_watch_refile_TEAM-4660");
  });

  it("SR2-4: an unparseable sibling createdAt never pages, even against a valid close", async () => {
    const garbageSibling = {
      ticketId: "TEAM-4666", type: "task", status: "in_review", assignee: "human:tycen",
      labels: ["gate:deploy-approval"], updatedAt: "2026-09-14T06:30:00Z", createdAt: undefined,
    };
    const s = makeSweep({ workflow: wf("37ule1", "TEAM-4640"), siblings: [closedGate, garbageSibling], nowMs: NOW });

    const m = await s.runSweep();

    expect(m.watchRefile).toBe(0);
    expect(s.notifications.map((n) => n.id)).not.toContain("notif_watch_refile_TEAM-4660");
  });
});

describe("watchdog.mjs is a config resolver, which is why W2/W3 exist", () => {
  it("resolves per-turn timings only — it has no ticket, gate or human concept", () => {
    const cfg = resolveWatchdog("agentcore_hub_backend_dev");
    expect(Object.keys(cfg).sort()).toEqual(
      ["enabled", "heartbeatIntervalMs", "toolDeadlineSecs", "turnTimeoutSecs"]
    );
    expect(cfg.turnTimeoutSecs).toBe(LEGACY_WATCHDOG.turnTimeoutSecs);
  });
});
