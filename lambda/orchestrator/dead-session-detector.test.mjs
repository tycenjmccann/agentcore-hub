import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDetector } from "./dead-session-detector.mjs";

/**
 * TEAM-3618 D1.2 — the orchestrator dead-session sweep. Every effect is
 * injected, so these run with a stub ddb + stub store + stub lease and a fake
 * clock. They pin the HARD INVARIANTS: the lease-live guard is absolute (zero
 * steal/error/dispatch inside a live lease), the trigger sequence is CAS →
 * steal → error → retry-once → escalate, shadow mode writes nothing, and the
 * silence threshold is floored at the lease TTL with a low-sample fallback.
 *
 * TEAM-3683 adds: the completion check paginates with DynamoDB's real
 * limit-BEFORE-filter semantics (the stub models them), one failing candidate
 * never aborts the sweep, stolen-but-stalled tasks are re-driven, a pre-steal
 * liveness re-check catches mid-sweep resurrections, and the mode gate fails
 * safe on unknown values.
 */

const TTL_MS = 30 * 60 * 1000; // 30 min — matches lease-constants default
const NOW = Date.parse("2026-09-01T12:00:00Z");
const DEAD_STARTED = "2026-09-01T00:00:00Z"; // 12h before NOW → far past any threshold

// A running claim on a leaf ticket that has gone silent for 12h.
const deadTask = { id: "task_1", agentId: "dev", ticketId: "TEAM-2", status: "running", startedAt: DEAD_STARTED };
const leafTicket = { ticketId: "TEAM-2", type: "task", status: "in_progress", assignee: "dev" };

/**
 * Fake DocumentClient: workflows Scan → the given rows; events Scan →
 * medianEvents; events Query → a page over `events` with REAL DynamoDB
 * semantics (TEAM-3683 F1): the key condition picks the partition, Limit
 * applies to raw items BEFORE the FilterExpression, and LastEvaluatedKey /
 * ExclusiveStartKey page through the remainder — so a Limit:1 query only ever
 * examines the partition's first event, exactly like the real service.
 */
function makeDdb({ workflows = [], medianEvents = [], events = [] } = {}) {
  return {
    send: vi.fn(async (cmd) => {
      const kind = cmd.constructor.name;
      const table = cmd.input.TableName;
      if (kind === "ScanCommand" && table === "workflows") return { Items: workflows };
      if (kind === "ScanCommand" && table === "events") return { Items: medianEvents };
      if (kind === "QueryCommand" && table === "events") return queryEventsPage(events, cmd.input);
      return { Items: [] };
    }),
  };
}

/** One Query page: partition → slice(Limit) → THEN hasCompletionSince's filter. */
function queryEventsPage(events, input) {
  const v = input.ExpressionAttributeValues || {};
  const partition = events.filter((e) => e.workflowId === v[":w"]);
  const start = input.ExclusiveStartKey ? input.ExclusiveStartKey.idx : 0;
  const raw = partition.slice(start, start + (input.Limit ?? partition.length));
  const Items = raw.filter((e) =>
    e.type === v[":complete"] &&
    e.detail?.ticketId === v[":tid"] &&
    String(e.timestamp || "") >= String(v[":since"] || ""));
  const res = { Items };
  if (start + raw.length < partition.length) res.LastEvaluatedKey = { idx: start + raw.length };
  return res;
}

function makeDeps(overrides = {}) {
  const store = {
    markDeadSessionDetected: vi.fn(async () => true),
    clearDeadSessionDetected: vi.fn(async () => true),
    incrementDeadSessionRetry: vi.fn(async () => 1),
    setTaskStatus: vi.fn(async () => {}),
    appendNotification: vi.fn(async () => {}),
    getWorkflow: vi.fn(async () => null), // backstop's fresh read — tests override
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
  it("emits a shadow-flagged dead_session.shadow and writes NOTHING", async () => {
    const { deps, store, lease } = makeDeps();
    const { runSweep } = createDetector(deps);

    const m = await runSweep("shadow");

    const obs = eventsOfType(deps.publishEvent, "dead_session.shadow");
    expect(obs).toHaveLength(1);
    // Full observation payload is preserved (TEAM-3698 F2) — only the type changed.
    expect(obs[0][2].shadow).toBe(true);
    expect(obs[0][2].reason).toBe("dead_session");
    expect(obs[0][2]).toMatchObject({ workflowId: "wf_1", ticketId: "TEAM-2", agentId: "dev" });
    expect(obs[0][2].detectorMeta).toBeDefined();
    expect(obs[0][2].detectorMeta.claimStartedAt).toBe(DEAD_STARTED);
    // TEAM-3698: never agent.error — the UI error stream and the anomaly
    // watcher's agent_error_retry_rate both read that type as a real failure.
    expect(eventsOfType(deps.publishEvent, "agent.error")).toHaveLength(0);
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(store.incrementDeadSessionRetry).not.toHaveBeenCalled();
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(store.setTaskStatus).not.toHaveBeenCalled();
    expect(m.fired).toBe(1);
  });
});

describe("enforce publishes a real agent.error (TEAM-3698 F2)", () => {
  it("the death announcement is agent.error with NO shadow flag and no dead_session.shadow", async () => {
    const { deps } = makeDeps();
    const { runSweep } = createDetector(deps);

    await runSweep("enforce");

    const errs = eventsOfType(deps.publishEvent, "agent.error");
    expect(errs).toHaveLength(1);
    expect(errs[0][2].reason).toBe("dead_session");
    expect(errs[0][2].shadow).toBeUndefined();
    // Enforce mode never emits the shadow-only observation type.
    expect(eventsOfType(deps.publishEvent, "dead_session.shadow")).toHaveLength(0);
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

  it("re-evaluates (not skips) a running task already stamped with deadSessionDetectedAt (TEAM-3702)", async () => {
    // Old behavior skipped stamped live-status tasks unconditionally — which
    // permanently exempted a generation whose resurrected-path clear failed,
    // or whose stamping sweep crashed pre-steal. New contract: the held stamp
    // is reused (no re-stamp — the attribute_not_exists CAS would lose
    // forever) and the dead lease is recovered normally.
    const wf = makeWorkflow({
      agentTasks: { "TEAM-2": { ...deadTask, deadSessionDetectedAt: "2026-09-01T06:00:00Z" } },
    });
    const { deps, store, lease } = makeDeps({ ddb: makeDdb({ workflows: [wf] }) });
    const { runSweep } = createDetector(deps);
    const m = await runSweep("enforce");
    expect(m.candidates).toBe(1);
    expect(m.fired).toBe(1);
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled(); // stamp held, never re-written
    expect(lease.stealClaim).toHaveBeenCalledWith(deps.ddb, "workflows", "wf_1", "TEAM-2", DEAD_STARTED);
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
  });
});

// Events-partition fixtures for the completion check (timestamps ≥ DEAD_STARTED).
const completeEvt = () => ({
  workflowId: "wf_1", type: "agent.complete", detail: { ticketId: "TEAM-2" },
  timestamp: "2026-09-01T06:00:00Z",
});
const noiseEvt = (i) => ({
  workflowId: "wf_1", type: "agent.streaming", detail: { ticketId: "TEAM-2" },
  timestamp: "2026-09-01T05:00:00Z", eventId: `noise_${i}`,
});

describe("completion race", () => {
  it("skips a candidate whose agent.complete landed DEEPER than the partition's first event (TEAM-3683 F1 regression)", async () => {
    // Limit-before-filter: the old Limit:1 query only ever saw noise_0 and
    // would have missed this completion, stealing a finished session.
    const { deps, store } = makeDeps({
      ddb: makeDdb({
        workflows: [makeWorkflow()],
        events: [noiseEvt(0), noiseEvt(1), completeEvt()],
      }),
    });
    const { runSweep } = createDetector(deps);
    const m = await runSweep("enforce");
    expect(m.candidates).toBe(1); // counted, then dropped by the completion check
    expect(m.fired).toBe(0);
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
  });
});

describe("hasCompletionSince pagination (TEAM-3683 F1)", () => {
  const detectorFor = (events) => {
    const { deps } = makeDeps({ ddb: makeDdb({ workflows: [], events }) });
    return { detector: createDetector(deps), deps };
  };

  it("pages past a full 500-item page of noise to reach the completion", async () => {
    const events = [...Array.from({ length: 501 }, (_, i) => noiseEvt(i)), completeEvt()];
    const { detector, deps } = detectorFor(events);
    expect(await detector.hasCompletionSince("wf_1", "TEAM-2", DEAD_STARTED)).toBe(true);
    // Page 1 (500 noise items) filtered to nothing → must have followed
    // LastEvaluatedKey into page 2.
    expect(deps.ddb.send.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(deps.ddb.send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ idx: 500 });
  });

  it("returns false when the partition holds no matching completion", async () => {
    const { detector } = detectorFor(Array.from({ length: 3 }, (_, i) => noiseEvt(i)));
    expect(await detector.hasCompletionSince("wf_1", "TEAM-2", DEAD_STARTED)).toBe(false);
  });

  it("ignores a completion from BEFORE the claim generation", async () => {
    const stale = { ...completeEvt(), timestamp: "2026-08-31T00:00:00Z" }; // < startedAt
    const { detector } = detectorFor([noiseEvt(0), stale]);
    expect(await detector.hasCompletionSince("wf_1", "TEAM-2", DEAD_STARTED)).toBe(false);
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

describe("per-candidate error isolation (TEAM-3683 F2)", () => {
  const secondWorkflow = () => makeWorkflow({
    id: "wf_2", workflowId: "wf_2",
    agentTasks: { "TEAM-9": { ...deadTask, ticketId: "TEAM-9" } },
  });
  const secondTicket = { ...leafTicket, ticketId: "TEAM-9" };

  it("a candidate whose getTicket throws is counted and does NOT abort the sweep", async () => {
    const { deps, store } = makeDeps({
      ddb: makeDdb({ workflows: [makeWorkflow(), secondWorkflow()] }),
      getTicket: vi.fn(async (id) => {
        if (id === "TEAM-2") throw new Error("tickets API down");
        return secondTicket;
      }),
    });
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(m.candidateErrors).toBe(1);
    // The later workflow's candidate was still fully recovered.
    expect(store.markDeadSessionDetected).toHaveBeenCalledWith("wf_2", "TEAM-9", DEAD_STARTED);
    expect(m.retries).toBe(1);
  });

  it("a redispatch that throws AFTER the steal is counted and later candidates still sweep", async () => {
    const { deps, store, lease } = makeDeps({
      ddb: makeDdb({ workflows: [makeWorkflow(), secondWorkflow()] }),
      getTicket: vi.fn(async (id) => (id === "TEAM-2" ? leafTicket : secondTicket)),
      redispatch: vi.fn(async (wf, ticket) => {
        if (ticket.ticketId === "TEAM-2") throw new Error("invoke failed");
        return true;
      }),
    });
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(m.candidateErrors).toBe(1);
    expect(lease.stealClaim).toHaveBeenCalledTimes(2); // both candidates reached the steal
    expect(store.markDeadSessionDetected).toHaveBeenCalledWith("wf_2", "TEAM-9", DEAD_STARTED);
    expect(m.retries).toBe(1); // wf_2 only
  });
});

describe("stolen-but-stalled backstop (TEAM-3683 F2)", () => {
  const STAMPED = "2026-09-01T06:00:00Z";
  const stalledWorkflow = (extra = {}) => makeWorkflow({
    agentTasks: { "TEAM-2": { ...deadTask, status: "ready", deadSessionDetectedAt: STAMPED } },
    ...extra,
  });

  it("re-drives retry when priorRetries is 0 — redispatch, no new stamp/steal", async () => {
    const wf = stalledWorkflow();
    const { deps, store, lease } = makeDeps({ ddb: makeDdb({ workflows: [wf] }) });
    store.getWorkflow.mockResolvedValue(wf);
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(m.candidates).toBe(1);
    expect(store.getWorkflow).toHaveBeenCalledWith("wf_1");
    expect(store.incrementDeadSessionRetry).toHaveBeenCalledWith("wf_1", "TEAM-2");
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(m.retries).toBe(1);
    // The stamp + steal already happened last sweep — never repeated.
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(lease.stealClaim).not.toHaveBeenCalled();
    // TEAM-3698: the clear is a resurrected-path-only concern — the backstop
    // re-drives on the stamp, so it must NEVER clear it.
    expect(store.clearDeadSessionDetected).not.toHaveBeenCalled();
  });

  it("escalates when priorRetries ≥ 1 — no redispatch", async () => {
    const wf = stalledWorkflow({ deadSessionRetries: { "TEAM-2": 1 } });
    const { deps, store } = makeDeps({ ddb: makeDdb({ workflows: [wf] }) });
    store.getWorkflow.mockResolvedValue(wf);
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    const esc = eventsOfType(deps.publishEvent, "agent.escalated");
    expect(esc).toHaveLength(1);
    expect(esc[0][2].detectorMeta.recoveredStalledSteal).toBe(true);
    expect(store.setTaskStatus).toHaveBeenCalledWith("wf_1", "TEAM-2", "error");
    expect(deps.blockTicket).toHaveBeenCalledWith("TEAM-2", "dead_session_retry_exhausted");
    expect(store.appendNotification).toHaveBeenCalledTimes(1);
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(m.escalations).toBe(1);
    expect(m.retries).toBe(0);
  });

  it("skips when the claim generation moved since the scan snapshot", async () => {
    const wf = stalledWorkflow();
    const { deps, store } = makeDeps({ ddb: makeDdb({ workflows: [wf] }) });
    // Fresh read shows the ticket was re-claimed — a new live generation.
    store.getWorkflow.mockResolvedValue(makeWorkflow({
      agentTasks: { "TEAM-2": { ...deadTask, startedAt: "2026-09-01T11:00:00Z" } },
    }));
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(store.incrementDeadSessionRetry).not.toHaveBeenCalled();
    expect(m.retries).toBe(0);
    expect(m.escalations).toBe(0);
    expect(m.candidateErrors).toBe(0);
  });

  it("is observe-only in shadow mode — zero reads-for-recovery, zero writes", async () => {
    const { deps, store } = makeDeps({ ddb: makeDdb({ workflows: [stalledWorkflow()] }) });
    const { runSweep } = createDetector(deps);

    const m = await runSweep("shadow");

    expect(m.candidates).toBe(1);
    expect(store.getWorkflow).not.toHaveBeenCalled();
    expect(store.incrementDeadSessionRetry).not.toHaveBeenCalled();
    expect(store.setTaskStatus).not.toHaveBeenCalled();
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(deps.blockTicket).not.toHaveBeenCalled();
    expect(deps.publishEvent).not.toHaveBeenCalled();
  });
});

describe("resurrection TOCTOU re-check (TEAM-3683 F4)", () => {
  it("a heartbeat between the first liveness read and the steal skips the steal", async () => {
    const { deps, store, lease } = makeDeps();
    // First activity read (guard 1): silence. Second (pre-steal re-check): a
    // fresh heartbeat — the agent resurrected mid-sweep.
    lease.lastAgentActivity
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Date(NOW - 1000).toISOString());
    lease.isLeaseLive.mockImplementation((task, activityIso) => activityIso != null);
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(store.markDeadSessionDetected).toHaveBeenCalledTimes(1); // stamp landed first
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(eventsOfType(deps.publishEvent, "agent.error")).toHaveLength(0);
    expect(m.skippedLiveLease).toBe(1);
    expect(m.fired).toBe(0);
    // TEAM-3698: the stamp we just wrote is CLEARED on the exact generation, so
    // a later silent death on this same claim is not permanently suppressed.
    expect(store.clearDeadSessionDetected).toHaveBeenCalledWith("wf_1", "TEAM-2", DEAD_STARTED);
  });
});

describe("recovery is never permanently suppressed (TEAM-3698 F1)", () => {
  it("resurrect-then-die: stamp cleared on resurrection, a later sweep on the SAME claim fires + retries", async () => {
    // A mutable clock so the second sweep is genuinely "later" — the claim is
    // never re-issued, so silence is still measured from the same startedAt.
    let clock = NOW;
    const { deps, store, lease } = makeDeps({ now: () => clock });
    // Liveness is decided purely by whether a heartbeat is visible.
    lease.isLeaseLive.mockImplementation((task, activityIso) => activityIso != null);
    const { runSweep } = createDetector(deps);

    // ── Sweep 1: dead at guard 1, then a heartbeat lands before the steal. ──
    lease.lastAgentActivity
      .mockResolvedValueOnce(null)                                  // guard 1: silent
      .mockResolvedValueOnce(new Date(NOW - 1000).toISOString());   // re-check: resurrected
    const m1 = await runSweep("enforce");

    expect(m1.skippedLiveLease).toBe(1);
    expect(m1.fired).toBe(0);
    expect(store.markDeadSessionDetected).toHaveBeenCalledTimes(1);
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(eventsOfType(deps.publishEvent, "agent.error")).toHaveLength(0);
    // The stamp came back OFF, scoped to this exact claim generation.
    expect(store.clearDeadSessionDetected).toHaveBeenCalledTimes(1);
    expect(store.clearDeadSessionDetected).toHaveBeenCalledWith("wf_1", "TEAM-2", DEAD_STARTED);

    // ── Sweep 2 (later): the SAME claim generation goes silent again. ───────
    // No mockResolvedValueOnce queued → lastAgentActivity returns null (the
    // base stub): dead at guard 1 AND at the re-check.
    clock = NOW + 10 * 60 * 1000;
    const m2 = await runSweep("enforce");

    // It fires: not suppressed. Stamp → steal (same generation) → error.
    expect(store.markDeadSessionDetected).toHaveBeenCalledTimes(2);
    expect(lease.stealClaim).toHaveBeenCalledWith(deps.ddb, "workflows", "wf_1", "TEAM-2", DEAD_STARTED);
    const errs = eventsOfType(deps.publishEvent, "agent.error");
    expect(errs).toHaveLength(1);
    expect(errs[0][2].shadow).toBeUndefined();
    // Retry-once: prior retries 0 → increment + redispatch.
    expect(store.incrementDeadSessionRetry).toHaveBeenCalledWith("wf_1", "TEAM-2");
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(m2.fired).toBe(1);
    expect(m2.retries).toBe(1);
    expect(m2.escalations).toBe(0);
    // The clear fired only on the resurrected sweep, never on the firing sweep.
    expect(store.clearDeadSessionDetected).toHaveBeenCalledTimes(1);
  });

  it("resurrect-then-die with retries already 1: the later sweep ESCALATES, not retries", async () => {
    let clock = NOW;
    const wf = makeWorkflow({ deadSessionRetries: { "TEAM-2": 1 } });
    const { deps, store, lease } = makeDeps({ ddb: makeDdb({ workflows: [wf] }), now: () => clock });
    lease.isLeaseLive.mockImplementation((task, activityIso) => activityIso != null);
    const { runSweep } = createDetector(deps);

    lease.lastAgentActivity
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Date(NOW - 1000).toISOString());
    const m1 = await runSweep("enforce");
    expect(store.clearDeadSessionDetected).toHaveBeenCalledWith("wf_1", "TEAM-2", DEAD_STARTED);
    expect(m1.fired).toBe(0);

    clock = NOW + 10 * 60 * 1000;
    const m2 = await runSweep("enforce");

    const esc = eventsOfType(deps.publishEvent, "agent.escalated");
    expect(esc).toHaveLength(1);
    expect(esc[0][2].reason).toBe("dead_session_retry_exhausted");
    expect(store.setTaskStatus).toHaveBeenCalledWith("wf_1", "TEAM-2", "error");
    expect(deps.blockTicket).toHaveBeenCalledWith("TEAM-2", "dead_session_retry_exhausted");
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(m2.escalations).toBe(1);
    expect(m2.retries).toBe(0);
  });

  it("clear CAS loses (generation moved between stamp and clear): logs, no steal, no throw", async () => {
    const log = vi.fn();
    const { deps, store, lease } = makeDeps({ log });
    store.clearDeadSessionDetected.mockResolvedValue(false); // CAS lost
    lease.lastAgentActivity
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Date(NOW - 1000).toISOString());
    lease.isLeaseLive.mockImplementation((task, activityIso) => activityIso != null);
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce"); // must not throw

    expect(store.clearDeadSessionDetected).toHaveBeenCalledTimes(1);
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(eventsOfType(deps.publishEvent, "agent.error")).toHaveLength(0);
    expect(m.skippedLiveLease).toBe(1);
    expect(m.fired).toBe(0);
    expect(m.candidateErrors).toBe(0); // a lost clear CAS is not an error
    expect(log.mock.calls.some(([msg]) => msg.includes("detector.resurrected"))).toBe(true);
  });
});

describe("a failed stamp-clear never permanently suppresses detection (TEAM-3702)", () => {
  it("clear throws ThrottlingException on the resurrected path; a later silent death on the SAME claim still fires + retries", async () => {
    let clock = NOW;
    const wf = makeWorkflow();
    const task = wf.agentTasks["TEAM-2"];
    const { deps, store, lease } = makeDeps({ ddb: makeDdb({ workflows: [wf] }), now: () => clock });
    // Stateful stamp stub: persist onto the scanned row like the real table,
    // so sweep 2 sees the stamp sweep 1 left behind.
    store.markDeadSessionDetected.mockImplementation(async () => {
      if (task.deadSessionDetectedAt) return false;
      task.deadSessionDetectedAt = new Date(clock).toISOString();
      return true;
    });
    // Sweep 1's clear dies on a NON-conditional error (throttling) — the
    // detector's per-candidate catch swallows it, leaving the stamp stuck.
    const throttle = Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
    store.clearDeadSessionDetected.mockRejectedValueOnce(throttle);
    lease.isLeaseLive.mockImplementation((t, activityIso) => activityIso != null);
    const { runSweep } = createDetector(deps);

    // ── Sweep 1: dead at guard 1, resurrected before the steal, clear THROWS. ─
    lease.lastAgentActivity
      .mockResolvedValueOnce(null)                                // guard 1: silent
      .mockResolvedValueOnce(new Date(NOW - 1000).toISOString()); // re-check: resurrected
    const m1 = await runSweep("enforce");

    expect(m1.candidateErrors).toBe(1);              // swallowed, sweep continued
    expect(m1.fired).toBe(0);
    expect(lease.stealClaim).not.toHaveBeenCalled(); // R3: nothing acted on the live lease
    expect(task.deadSessionDetectedAt).toBeTruthy(); // the stamp is stuck on a running task

    // ── Sweep 2 (later): SAME claim generation, still stamped, dies silently. ─
    // No queued activity → null from the base stub: dead at guard 1 AND at the
    // re-check.
    clock = NOW + 10 * 60 * 1000;
    const m2 = await runSweep("enforce");

    // Detected + recovered — the stamped generation is re-driven, not skipped.
    expect(lease.stealClaim).toHaveBeenCalledWith(deps.ddb, "workflows", "wf_1", "TEAM-2", DEAD_STARTED);
    expect(eventsOfType(deps.publishEvent, "agent.error")).toHaveLength(1);
    expect(store.incrementDeadSessionRetry).toHaveBeenCalledWith("wf_1", "TEAM-2");
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(m2.fired).toBe(1);
    expect(m2.retries).toBe(1);
    // The held stamp was reused: markDeadSessionDetected ran only on sweep 1.
    expect(store.markDeadSessionDetected).toHaveBeenCalledTimes(1);
  });

  it("a stamped task whose lease is LIVE retries the CAS'd clear each sweep and touches nothing else (R3)", async () => {
    const log = vi.fn();
    const wf = makeWorkflow({
      agentTasks: { "TEAM-2": { ...deadTask, deadSessionDetectedAt: "2026-09-01T06:00:00Z" } },
    });
    const { deps, store, lease } = makeDeps({ ddb: makeDdb({ workflows: [wf] }), log });
    lease.isLeaseLive.mockReturnValue(true); // live at guard 1
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    // The residual stamp is retried off, scoped to the exact generation…
    expect(store.clearDeadSessionDetected).toHaveBeenCalledWith("wf_1", "TEAM-2", DEAD_STARTED);
    expect(log.mock.calls.some(([msg]) => msg.includes("detector.stale_stamp_cleared"))).toBe(true);
    // …and NOTHING acts against the live lease.
    expect(m.skippedLiveLease).toBe(1);
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(eventsOfType(deps.publishEvent, "agent.error")).toHaveLength(0);
  });

  it("shadow mode: a stamped live task logs the would-clear and writes NOTHING", async () => {
    const log = vi.fn();
    const wf = makeWorkflow({
      agentTasks: { "TEAM-2": { ...deadTask, deadSessionDetectedAt: "2026-09-01T06:00:00Z" } },
    });
    const { deps, store, lease } = makeDeps({ ddb: makeDdb({ workflows: [wf] }), log });
    lease.isLeaseLive.mockReturnValue(true);
    const { runSweep } = createDetector(deps);

    await runSweep("shadow");

    expect(log.mock.calls.some(([msg]) => msg.includes("detector.would_clear_stale_stamp"))).toBe(true);
    expect(store.clearDeadSessionDetected).not.toHaveBeenCalled();
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(lease.stealClaim).not.toHaveBeenCalled();
  });
});

describe("mode normalization (TEAM-3683 F5)", () => {
  it('"OFF" behaves as off — sweep skipped entirely', async () => {
    const { deps, store } = makeDeps();
    const { runSweep } = createDetector(deps);
    const m = await runSweep("OFF");
    expect(m.mode).toBe("off");
    expect(deps.ddb.send).not.toHaveBeenCalled();
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
  });

  it('"Shadow " (case + trailing space) behaves as shadow — flagged event, zero writes', async () => {
    const { deps, store, lease } = makeDeps();
    const { runSweep } = createDetector(deps);
    const m = await runSweep("Shadow ");
    expect(m.mode).toBe("shadow");
    const obs = eventsOfType(deps.publishEvent, "dead_session.shadow");
    expect(obs).toHaveLength(1);
    expect(obs[0][2].shadow).toBe(true);
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(lease.stealClaim).not.toHaveBeenCalled();
  });

  it('" ENFORCE " normalizes to enforce — the full trigger path runs', async () => {
    const { deps, store } = makeDeps();
    const { runSweep } = createDetector(deps);
    const m = await runSweep(" ENFORCE ");
    expect(m.mode).toBe("enforce");
    expect(store.markDeadSessionDetected).toHaveBeenCalled();
    expect(m.retries).toBe(1);
  });

  it.each(["enfrce", "", "definitely-not-a-mode"])(
    "unknown mode %j coerces to shadow with a warning — zero writes",
    async (raw) => {
      const log = vi.fn();
      const { deps, store, lease } = makeDeps({ log });
      const { runSweep } = createDetector(deps);

      const m = await runSweep(raw);

      expect(m.mode).toBe("shadow");
      expect(log.mock.calls.some(([msg]) => msg.includes("detector.unknown_mode"))).toBe(true);
      expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
      expect(store.incrementDeadSessionRetry).not.toHaveBeenCalled();
      expect(store.setTaskStatus).not.toHaveBeenCalled();
      expect(lease.stealClaim).not.toHaveBeenCalled();
      expect(deps.redispatch).not.toHaveBeenCalled();
      // Still swept: the would-fire lands as a shadow-flagged event.
      const obs = eventsOfType(deps.publishEvent, "dead_session.shadow");
      expect(obs).toHaveLength(1);
      expect(obs[0][2].shadow).toBe(true);
    }
  );
});
