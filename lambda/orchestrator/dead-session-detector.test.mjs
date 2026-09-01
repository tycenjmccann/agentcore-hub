import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDetector } from "./dead-session-detector.mjs";

/**
 * TEAM-3618 D1.2 — the orchestrator dead-session sweep. Every effect is
 * injected, so these run with a stub ddb + stub store + stub lease and a fake
 * clock. They pin the HARD INVARIANTS: the lease-live guard is absolute (zero
 * steal/error/dispatch inside a live lease), the trigger sequence is CAS →
 * steal → error → retry-once → escalate, shadow mode writes nothing, and the
 * silence threshold is floored at the lease TTL with a low-sample fallback.
 */

const TTL_MS = 30 * 60 * 1000; // 30 min — matches lease-constants default
const NOW = Date.parse("2026-09-01T12:00:00Z");
const DEAD_STARTED = "2026-09-01T00:00:00Z"; // 12h before NOW → far past any threshold

// A running claim on a leaf ticket that has gone silent for 12h.
const deadTask = { id: "task_1", agentId: "dev", ticketId: "TEAM-2", status: "running", startedAt: DEAD_STARTED };
const leafTicket = { ticketId: "TEAM-2", type: "task", status: "in_progress", assignee: "dev" };

/** Fake DocumentClient: workflows Scan → the given rows; events Scan/Query → empty. */
function makeDdb({ workflows = [], medianEvents = [], completions = [] } = {}) {
  return {
    send: vi.fn(async (cmd) => {
      const kind = cmd.constructor.name;
      const table = cmd.input.TableName;
      if (kind === "ScanCommand" && table === "workflows") return { Items: workflows };
      if (kind === "ScanCommand" && table === "events") return { Items: medianEvents };
      if (kind === "QueryCommand" && table === "events") return { Items: completions };
      return { Items: [] };
    }),
  };
}

function makeDeps(overrides = {}) {
  const store = {
    markDeadSessionDetected: vi.fn(async () => true),
    incrementDeadSessionRetry: vi.fn(async () => 1),
    setTaskStatus: vi.fn(async () => {}),
    appendNotification: vi.fn(async () => {}),
  };
  const lease = {
    LEASE_TTL_MS: TTL_MS,
    isLeaseLive: vi.fn(() => false), // dead by default
    lastAgentActivity: vi.fn(async () => null), // no heartbeat → silence = now - startedAt
    stealClaim: vi.fn(async () => true),
  };
  const deps = {
    ddb: overrides.ddb || makeDdb({ workflows: [makeWorkflow()] }),
    workflowsTable: "workflows",
    eventsTable: "events",
    store,
    lease,
    getTicket: vi.fn(async () => leafTicket),
    getAgentDef: vi.fn(() => ({ agentId: "dev", phase: "development" })),
    publishEvent: vi.fn(async () => {}),
    redispatch: vi.fn(async () => true),
    blockTicket: vi.fn(async () => {}),
    now: () => NOW,
    log: () => {},
    ...overrides,
  };
  return { deps, store, lease };
}

function makeWorkflow(extra = {}) {
  return {
    id: "wf_1",
    workflowId: "wf_1",
    phase: "development",
    agentTasks: { "TEAM-2": { ...deadTask } },
    startedAt: DEAD_STARTED,
    ...extra,
  };
}

const eventsOfType = (fn, type) => fn.mock.calls.filter((c) => c[1] === type);

beforeEach(() => vi.clearAllMocks());

describe("live-lease guard (HARD INVARIANT)", () => {
  it("a live lease is a no-op — zero steal, zero error, zero dispatch", async () => {
    const { deps, store, lease } = makeDeps();
    lease.isLeaseLive.mockReturnValue(true);
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(m.skippedLiveLease).toBe(1);
    expect(m.fired).toBe(0);
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(eventsOfType(deps.publishEvent, "agent.error")).toHaveLength(0);
  });
});

describe("first dead session (retry count 0)", () => {
  it("stamps → steals → emits agent.error → increments → re-dispatches", async () => {
    const { deps, store, lease } = makeDeps();
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(store.markDeadSessionDetected).toHaveBeenCalledWith("wf_1", "TEAM-2", DEAD_STARTED);
    expect(lease.stealClaim).toHaveBeenCalledWith(deps.ddb, "workflows", "wf_1", "TEAM-2", DEAD_STARTED);
    const errs = eventsOfType(deps.publishEvent, "agent.error");
    expect(errs).toHaveLength(1);
    expect(errs[0][2].reason).toBe("dead_session");
    expect(errs[0][2].shadow).toBeUndefined();
    expect(store.incrementDeadSessionRetry).toHaveBeenCalledWith("wf_1", "TEAM-2");
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(eventsOfType(deps.publishEvent, "agent.escalated")).toHaveLength(0);
    expect(store.setTaskStatus).not.toHaveBeenCalled();
    expect(m.fired).toBe(1);
    expect(m.retries).toBe(1);
    expect(m.escalations).toBe(0);
  });
});

describe("second dead session, same ticket (retry exhausted)", () => {
  it("escalates: agent.escalated + setTaskStatus error + block + notify, NO re-dispatch", async () => {
    const wf = makeWorkflow({ deadSessionRetries: { "TEAM-2": 1 } });
    const { deps, store } = makeDeps({ ddb: makeDdb({ workflows: [wf] }) });
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    const esc = eventsOfType(deps.publishEvent, "agent.escalated");
    expect(esc).toHaveLength(1);
    expect(esc[0][2].reason).toBe("dead_session_retry_exhausted");
    expect(store.setTaskStatus).toHaveBeenCalledWith("wf_1", "TEAM-2", "error");
    expect(deps.blockTicket).toHaveBeenCalledWith("TEAM-2", "dead_session_retry_exhausted");
    expect(store.appendNotification).toHaveBeenCalledTimes(1);
    expect(store.appendNotification.mock.calls[0][1].type).toBe("manager_escalation");
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(store.incrementDeadSessionRetry).not.toHaveBeenCalled();
    expect(m.escalations).toBe(1);
    expect(m.retries).toBe(0);
  });
});

describe("shadow mode", () => {
  it("emits a shadow-flagged agent.error and writes NOTHING", async () => {
    const { deps, store, lease } = makeDeps();
    const { runSweep } = createDetector(deps);

    const m = await runSweep("shadow");

    const errs = eventsOfType(deps.publishEvent, "agent.error");
    expect(errs).toHaveLength(1);
    expect(errs[0][2].shadow).toBe(true);
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(store.incrementDeadSessionRetry).not.toHaveBeenCalled();
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(store.setTaskStatus).not.toHaveBeenCalled();
    expect(m.fired).toBe(1);
  });
});

describe("off mode", () => {
  it("skips the sweep entirely — no scan, no candidates", async () => {
    const { deps, store } = makeDeps();
    const { runSweep } = createDetector(deps);
    const m = await runSweep("off");
    expect(m.candidates).toBe(0);
    expect(deps.ddb.send).not.toHaveBeenCalled();
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
  });
});

describe("markDeadSessionDetected CAS loss", () => {
  it("stops the candidate: no steal, no error, no dispatch", async () => {
    const { deps, store, lease } = makeDeps();
    store.markDeadSessionDetected.mockResolvedValue(false);
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(eventsOfType(deps.publishEvent, "agent.error")).toHaveLength(0);
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(m.fired).toBe(0);
  });
});

describe("stealClaim loss (claim moved after stamp)", () => {
  it("stops after the stamp: no agent.error, no dispatch", async () => {
    const { deps, store, lease } = makeDeps();
    lease.stealClaim.mockResolvedValue(false);
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(store.markDeadSessionDetected).toHaveBeenCalled();
    expect(eventsOfType(deps.publishEvent, "agent.error")).toHaveLength(0);
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(m.fired).toBe(0);
  });
});

describe("candidate filtering", () => {
  it("skips non-running tasks, epics, and tickets not in_progress", async () => {
    const wf = makeWorkflow({
      agentTasks: {
        "TEAM-2": { ...deadTask },                 // valid candidate
        "TEAM-3": { ...deadTask, ticketId: "TEAM-3", status: "complete" }, // not running
      },
    });
    const tickets = {
      "TEAM-2": leafTicket,
      "TEAM-3": { ticketId: "TEAM-3", type: "task", status: "in_progress", assignee: "dev" },
    };
    const { deps } = makeDeps({
      ddb: makeDdb({ workflows: [wf] }),
      getTicket: vi.fn(async (id) => tickets[id]),
    });
    const { runSweep } = createDetector(deps);
    const m = await runSweep("enforce");
    expect(m.candidates).toBe(1); // only TEAM-2
  });

  it("skips a ticket a human already moved off in_progress", async () => {
    const { deps } = makeDeps({
      getTicket: vi.fn(async () => ({ ...leafTicket, status: "blocked" })),
    });
    const { runSweep } = createDetector(deps);
    const m = await runSweep("enforce");
    expect(m.candidates).toBe(0);
  });

  it("skips a task already stamped with deadSessionDetectedAt", async () => {
    const wf = makeWorkflow({
      agentTasks: { "TEAM-2": { ...deadTask, deadSessionDetectedAt: "2026-09-01T06:00:00Z" } },
    });
    const { deps } = makeDeps({ ddb: makeDdb({ workflows: [wf] }) });
    const { runSweep } = createDetector(deps);
    const m = await runSweep("enforce");
    expect(m.candidates).toBe(0);
  });
});

describe("completion race", () => {
  it("skips a candidate whose agent.complete already landed for this generation", async () => {
    const { deps, store } = makeDeps({
      ddb: makeDdb({
        workflows: [makeWorkflow()],
        completions: [{ workflowId: "wf_1", type: "agent.complete", detail: { ticketId: "TEAM-2" } }],
      }),
    });
    const { runSweep } = createDetector(deps);
    const m = await runSweep("enforce");
    expect(m.candidates).toBe(1); // counted, then dropped by the completion check
    expect(m.fired).toBe(0);
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
  });
});

describe("computeThreshold", () => {
  it("falls back to 2× TTL when sampleCount < 5 (the stale-claim hatch)", () => {
    const { deps } = makeDeps();
    const { computeThreshold } = createDetector(deps);
    expect(computeThreshold(999999, 4)).toBe(2 * TTL_MS);
    expect(computeThreshold(999999, 0)).toBe(2 * TTL_MS);
  });

  it("floors the threshold at the lease TTL (never fires inside a live lease)", () => {
    const { deps } = makeDeps();
    const { computeThreshold } = createDetector(deps);
    // 3 × 1min = 3min < 30min TTL → clamped up to TTL.
    expect(computeThreshold(60 * 1000, 10)).toBe(TTL_MS);
  });

  it("caps the threshold at 6h", () => {
    const { deps } = makeDeps();
    const { computeThreshold } = createDetector(deps);
    // 3 × 5h = 15h → clamped down to 6h.
    expect(computeThreshold(5 * 60 * 60 * 1000, 10)).toBe(6 * 60 * 60 * 1000);
  });

  it("uses 3× the median in the healthy middle range", () => {
    const { deps } = makeDeps();
    const { computeThreshold } = createDetector(deps);
    const med = 40 * 60 * 1000; // 40min → 3× = 120min, inside [TTL, 6h]
    expect(computeThreshold(med, 12)).toBe(3 * med);
  });
});

describe("silence below threshold", () => {
  it("does not fire when a dead lease has not yet been silent past the threshold", async () => {
    // startedAt only 45min ago → silence 45min < fallback 60min (2× TTL).
    const recent = new Date(NOW - 45 * 60 * 1000).toISOString();
    const wf = makeWorkflow({ agentTasks: { "TEAM-2": { ...deadTask, startedAt: recent } } });
    const { deps, store } = makeDeps({ ddb: makeDdb({ workflows: [wf] }) });
    const { runSweep } = createDetector(deps);
    const m = await runSweep("enforce");
    expect(m.candidates).toBe(1);
    expect(m.fired).toBe(0);
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
  });
});

describe("sweep truncation", () => {
  it("caps at 50 workflows and flags detector.sweep_truncated", async () => {
    const many = Array.from({ length: 55 }, (_, i) =>
      makeWorkflow({ id: `wf_${i}`, workflowId: `wf_${i}`, agentTasks: {} }));
    const { deps } = makeDeps({ ddb: makeDdb({ workflows: many }) });
    const { runSweep } = createDetector(deps);
    const m = await runSweep("shadow");
    expect(m.truncated).toBe(true);
  });
});
