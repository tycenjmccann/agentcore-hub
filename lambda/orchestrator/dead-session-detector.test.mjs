import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDetector } from "./dead-session-detector.mjs";
import { SWEEP_ROTATION_QUANTUM_MS } from "./sweep-scan.mjs";

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

/**
 * Run `fn` while capturing the single EMF record emitMetrics() writes to
 * console.log (the injected `log` is a no-op, so emitMetrics is the only thing
 * that reaches console.log). Returns { result, emf } — emf is the parsed EMF
 * object (the one carrying the `_aws` block), or null if none was emitted.
 */
async function captureEmf(fn) {
  const orig = console.log;
  const lines = [];
  console.log = (...args) => { if (typeof args[0] === "string") lines.push(args[0]); };
  let result;
  try {
    result = await fn();
  } finally {
    console.log = orig;
  }
  let emf = null;
  for (const l of lines) {
    if (l.includes('"_aws"')) { try { emf = JSON.parse(l); } catch { /* not the EMF line */ } }
  }
  return { result, emf };
}

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

/**
 * TEAM-3839 — the capped window must ROTATE so older workflows are inspected
 * (port of the TEAM-3764 F5 reconcile-sweep fix). Before this fix the
 * detector's scan re-inspected the same newest-50 slice on EVERY sweep, so with
 * >SWEEP_CAP open workflows a dead session in any older workflow was NEVER
 * detected — a permanent liveness gap. The window now rotates: chunk k of the
 * recency-sorted list this rotation quantum, chunk k+1 the next, wrapping — so
 * every open workflow is inspected within ceil(N/50) quanta. Mirrors the
 * reconcile-sweep rotation tests.
 */
describe("TEAM-3839 — the capped window rotates so older workflows are inspected", () => {
  // 120 open workflows, newest first (wf_0 newest … wf_119 oldest) → 3 chunks.
  // ONLY the oldest — unreachable before this fix — carries the dead session.
  const N = 120;
  const PAGES = Math.ceil(N / 50);
  const fleet = () =>
    Array.from({ length: N }, (_, i) =>
      makeWorkflow({
        id: `wf_${i}`, workflowId: `wf_${i}`,
        updatedAt: new Date(NOW - (i + 1) * 60_000).toISOString(),
        agentTasks: i === N - 1 ? { "TEAM-2": { ...deadTask } } : {},
      }));

  it("a dead session in the OLDEST workflow is detected within ceil(N/cap) sweeps", async () => {
    const clock = { v: NOW };
    const { deps, store } = makeDeps({
      ddb: makeDdb({ workflows: fleet() }),
      now: () => clock.v,
    });
    const { runSweep } = createDetector(deps);

    let sweepsUntilDetected = null;
    for (let sweep = 1; sweep <= PAGES; sweep++) {
      await runSweep("enforce");
      if (sweepsUntilDetected === null && store.markDeadSessionDetected.mock.calls.length > 0) {
        sweepsUntilDetected = sweep;
      }
      clock.v += SWEEP_ROTATION_QUANTUM_MS; // next sweep lands in the next quantum
    }

    // wf_119 (oldest — deepest chunk, starved forever before this fix) WAS
    // reached, within ceil(120/50) = 3 rotation quanta.
    expect(sweepsUntilDetected).not.toBeNull();
    expect(sweepsUntilDetected).toBeLessThanOrEqual(PAGES);
    expect(store.markDeadSessionDetected).toHaveBeenCalledWith(`wf_${N - 1}`, "TEAM-2", DEAD_STARTED);
  });

  it("emits the dead_session.sweep_truncated rotating-window log line when N > cap", async () => {
    const lines = [];
    const { deps } = makeDeps({
      ddb: makeDdb({ workflows: fleet() }),
      log: (msg) => lines.push(msg),
    });
    const { runSweep } = createDetector(deps);
    const m = await runSweep("shadow");
    expect(m.truncated).toBe(true);
    expect(lines.some((l) =>
      /^dead_session\.sweep_truncated — 120 non-terminal workflows, capped at 50; inspecting rotating window [1-3]\/3 \(every window is reached within 3 rotation quanta\)/.test(l),
    )).toBe(true);
  });

  it("under the cap rotation is a no-op — a deep-quantum clock still inspects everything", async () => {
    // 5 open workflows, dead session in the oldest; a clock deep into some
    // arbitrary quantum must NOT slice a 5-row set (below-cap behavior is
    // exactly the old slice(0, SWEEP_CAP)).
    const few = Array.from({ length: 5 }, (_, i) =>
      makeWorkflow({
        id: `wf_${i}`, workflowId: `wf_${i}`,
        updatedAt: new Date(NOW - (i + 1) * 60_000).toISOString(),
        agentTasks: i === 4 ? { "TEAM-2": { ...deadTask } } : {},
      }));
    const { deps, store } = makeDeps({
      ddb: makeDdb({ workflows: few }),
      now: () => NOW + 7 * SWEEP_ROTATION_QUANTUM_MS,
    });
    const { runSweep } = createDetector(deps);
    const m = await runSweep("enforce");
    expect(m.truncated).toBe(false);
    expect(store.markDeadSessionDetected).toHaveBeenCalledWith("wf_4", "TEAM-2", DEAD_STARTED);
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

describe("AC-D4.1 — hung tool-call death classification", () => {
  it('streamed_then_silent: a session that heartbeat AFTER its claim start then went silent fires ONCE, auto-retries, and tags the hung-tool-call class', async () => {
    // A heartbeat 2h after the 00:00 claim start, then 10h of silence (>> the
    // 60min fallback threshold): the mid-turn-hang / hung-tool-call class.
    const streamedActivity = "2026-09-01T02:00:00Z";
    const { deps, store, lease } = makeDeps();
    lease.lastAgentActivity.mockResolvedValue(streamedActivity); // guard 1 AND the pre-steal re-check
    // isLeaseLive stays false (default): 10h silence is well past the TTL.
    const { runSweep } = createDetector(deps);

    const { result: m, emf } = await captureEmf(() => runSweep("enforce"));

    // Exactly one agent.error, then a single auto-retry (priorRetries 0).
    const errs = eventsOfType(deps.publishEvent, "agent.error");
    expect(errs).toHaveLength(1);
    expect(errs[0][2].reason).toBe("dead_session");
    expect(errs[0][2].detectorMeta.deathClass).toBe("streamed_then_silent");
    expect(store.incrementDeadSessionRetry).toHaveBeenCalledTimes(1);
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(eventsOfType(deps.publishEvent, "agent.escalated")).toHaveLength(0);

    // Metric surface: fired=1, retries=1, and the new hung-tool-call tag.
    expect(m.fired).toBe(1);
    expect(m.retries).toBe(1);
    expect(m.hungToolCalls).toBe(1);
    expect(emf).toBeTruthy();
    expect(emf.DetectorFired).toBe(1);
    expect(emf.DetectorRetries).toBe(1);
    expect(emf.DetectorHungToolCalls).toBe(1);
    // The metric is declared in the EMF metric directive too, not just as a field.
    const declared = emf._aws.CloudWatchMetrics[0].Metrics.map((x) => x.Name);
    expect(declared).toContain("DetectorHungToolCalls");
  });

  it('silent_since_start: a claim that never heartbeat past its start fires but is NOT counted as a hung tool-call', async () => {
    // Default lastAgentActivity → null: no heartbeat ever cleared the claim start.
    const { deps, store } = makeDeps();
    const { runSweep } = createDetector(deps);

    const { result: m, emf } = await captureEmf(() => runSweep("enforce"));

    const errs = eventsOfType(deps.publishEvent, "agent.error");
    expect(errs).toHaveLength(1);
    expect(errs[0][2].detectorMeta.deathClass).toBe("silent_since_start");
    expect(store.incrementDeadSessionRetry).toHaveBeenCalledTimes(1);
    expect(m.fired).toBe(1);
    expect(m.retries).toBe(1);
    expect(m.hungToolCalls).toBe(0);
    expect(emf.DetectorHungToolCalls).toBe(0);
  });
});

describe("AC-D4.3 — slow-but-alive is never stolen", () => {
  it("a heartbeat within the lease TTL (live lease) skips recovery: DetectorSkippedLiveLease++, zero steal, zero agent.error, zero retry", async () => {
    const { deps, store, lease } = makeDeps();
    // A fresh heartbeat 1min ago — well within the 30min TTL: slow, not dead.
    lease.lastAgentActivity.mockResolvedValue(new Date(NOW - 60 * 1000).toISOString());
    lease.isLeaseLive.mockImplementation((task, activityIso) => activityIso != null);
    const { runSweep } = createDetector(deps);

    const { result: m, emf } = await captureEmf(() => runSweep("enforce"));

    expect(m.candidates).toBe(1);
    expect(m.skippedLiveLease).toBe(1);
    expect(m.fired).toBe(0);
    expect(m.retries).toBe(0);
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(eventsOfType(deps.publishEvent, "agent.error")).toHaveLength(0);
    expect(emf.DetectorSkippedLiveLease).toBe(1);
    expect(emf.DetectorFired).toBe(0);
  });
});

describe("AC-D4.4 — a second sweep over a recovered ticket is a no-op", () => {
  it("completion detected on pass 2: the recovered agent finished → zero additional writes", async () => {
    // Shared, mutable events partition: empty on pass 1 (nothing to complete),
    // then the recovered agent's completion lands before pass 2.
    const events = [];
    const { deps, store, lease } = makeDeps({
      ddb: makeDdb({ workflows: [makeWorkflow()], events }),
    });
    const { runSweep } = createDetector(deps);

    // ── Pass 1: dead session recovered (stamp → steal → error → retry). ──
    const m1 = await runSweep("enforce");
    expect(m1.fired).toBe(1);
    expect(m1.retries).toBe(1);

    const snap = {
      mark: store.markDeadSessionDetected.mock.calls.length,
      steal: lease.stealClaim.mock.calls.length,
      redispatch: deps.redispatch.mock.calls.length,
      increment: store.incrementDeadSessionRetry.mock.calls.length,
      errors: eventsOfType(deps.publishEvent, "agent.error").length,
    };

    // The redispatched agent reports completion before the next sweep.
    events.push(completeEvt());

    // ── Pass 2: the completion check short-circuits before ANY write. ──
    const m2 = await runSweep("enforce");

    expect(m2.candidates).toBe(1);   // still inspected…
    expect(m2.fired).toBe(0);        // …but nothing fired
    // Zero additional writes on pass 2 — every counter is unchanged.
    expect(store.markDeadSessionDetected.mock.calls.length).toBe(snap.mark);
    expect(lease.stealClaim.mock.calls.length).toBe(snap.steal);
    expect(deps.redispatch.mock.calls.length).toBe(snap.redispatch);
    expect(store.incrementDeadSessionRetry.mock.calls.length).toBe(snap.increment);
    expect(eventsOfType(deps.publishEvent, "agent.error").length).toBe(snap.errors);
  });

  it("claim CAS lost on pass 2: the stale-generation steal loses harmlessly → no duplicate recovery", async () => {
    const { deps, store, lease } = makeDeps();
    // Steal wins once (pass 1), then loses (pass 2: the claim generation moved
    // when the recovered agent re-claimed).
    lease.stealClaim.mockResolvedValue(false);
    lease.stealClaim.mockResolvedValueOnce(true);
    const { runSweep } = createDetector(deps);

    const m1 = await runSweep("enforce");
    expect(m1.fired).toBe(1);
    expect(m1.retries).toBe(1);

    const errorsAfter1 = eventsOfType(deps.publishEvent, "agent.error").length;
    const redispatchAfter1 = deps.redispatch.mock.calls.length;
    const incrementAfter1 = store.incrementDeadSessionRetry.mock.calls.length;

    const m2 = await runSweep("enforce");

    // The steal CAS lost → recovery bailed before announcing/retrying again.
    expect(m2.fired).toBe(0);
    expect(m2.retries).toBe(0);
    expect(eventsOfType(deps.publishEvent, "agent.error").length).toBe(errorsAfter1);
    expect(deps.redispatch.mock.calls.length).toBe(redispatchAfter1);
    expect(store.incrementDeadSessionRetry.mock.calls.length).toBe(incrementAfter1);
    expect(lease.stealClaim).toHaveBeenCalledTimes(2); // both passes reached the steal
  });
});

/**
 * TEAM-3756 F5 — the detector must not scan runs that already CLOSED.
 *
 * Same gap (and same fix) as the reconcile sweep's TEAM-3755 F8: the scan's
 * FilterExpression named only complete/cancelled/error, so a run closed on a
 * TEAM-3747 D2 honest outcome (deploy-blocked / static-ci-only) still read as
 * "open" — and in enforce mode (the default) a stale agentTask inside a
 * terminally-blocked run could be stolen, re-dispatched or escalated AFTER the
 * verdict. The filter is now DERIVED from the shared TERMINAL_WORKFLOW_PHASES
 * list (completion.mjs notTerminalPhaseFilter), so the consumers cannot drift.
 */
describe("TEAM-3756 F5 — the detector's workflow scan excludes EVERY terminal phase", () => {
  /** Which phase values the emitted FilterExpression actually refuses (placeholder-agnostic). */
  const refusedPhases = (input) => {
    const inList = String(input.FilterExpression).match(/IN \(([^)]*)\)/)?.[1] || "";
    const keys = inList.split(",").map((k) => k.trim());
    return keys.map((k) => input.ExpressionAttributeValues[k]).sort();
  };
  const ALL_TERMINAL_PHASES = ["cancelled", "complete", "deploy-blocked", "error", "static-ci-only"];

  /**
   * A ddb stub that EMULATES the server-side filter (makeDdb returns every row
   * regardless), mirroring `NOT (#p IN (…))`: a row with NO phase attribute is
   * KEPT, exactly as DynamoDB evaluates it.
   */
  function makeFilteringDdb(workflows) {
    return {
      send: vi.fn(async (cmd) => {
        if (cmd.constructor.name !== "ScanCommand") return { Items: [] };
        if (cmd.input.TableName !== "workflows") return { Items: [] };
        const refused = new Set(refusedPhases(cmd.input));
        return { Items: workflows.filter((w) => !(w.phase && refused.has(w.phase))) };
      }),
    };
  }

  it("refuses all five terminal phases, derived from the shared list", async () => {
    const { deps } = makeDeps();
    const { runSweep } = createDetector(deps);
    await runSweep("enforce");

    const scans = deps.ddb.send.mock.calls
      .filter((c) => c[0].constructor.name === "ScanCommand" && c[0].input.TableName === "workflows")
      .map((c) => c[0].input);
    expect(scans).toHaveLength(1);
    expect(refusedPhases(scans[0])).toEqual(ALL_TERMINAL_PHASES);
    expect(scans[0].ExpressionAttributeNames).toEqual({ "#p": "phase" });
    // Every declared value is referenced by the filter and vice-versa.
    expect(Object.keys(scans[0].ExpressionAttributeValues)).toHaveLength(ALL_TERMINAL_PHASES.length);
  });

  it("a dead task inside a deploy-blocked run is NEVER stolen/re-dispatched (enforce)", async () => {
    // Identical to the "first dead session" scenario except the run already
    // closed deploy-blocked. Before F5 this claim was stolen + re-dispatched.
    const { deps, store, lease } = makeDeps({
      ddb: makeFilteringDdb([makeWorkflow({ phase: "deploy-blocked" })]),
    });
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(m.candidates).toBe(0);
    expect(store.markDeadSessionDetected).not.toHaveBeenCalled();
    expect(lease.stealClaim).not.toHaveBeenCalled();
    expect(deps.redispatch).not.toHaveBeenCalled();
  });

  it("a static-ci-only run is skipped too", async () => {
    const { deps, lease } = makeDeps({
      ddb: makeFilteringDdb([makeWorkflow({ phase: "static-ci-only" })]),
    });
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(m.candidates).toBe(0);
    expect(lease.stealClaim).not.toHaveBeenCalled();
  });

  it("an OPEN run beside two blocked ones is still recovered", async () => {
    // The filter must narrow the scan, not empty it.
    const { deps } = makeDeps({
      ddb: makeFilteringDdb([
        makeWorkflow({ id: "wf_b1", workflowId: "wf_b1", phase: "deploy-blocked" }),
        makeWorkflow(),
        makeWorkflow({ id: "wf_b2", workflowId: "wf_b2", phase: "static-ci-only" }),
      ]),
    });
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(m.candidates).toBe(1);
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
  });

  it("a row with NO phase attribute still scans as open (unchanged semantics)", async () => {
    // The `NOT (#p IN (…))` form is kept deliberately: a chain of `#p <> :v`
    // would silently DROP phase-less rows (e.g. the start-route dedup markers).
    const { phase, ...noPhase } = makeWorkflow();
    const { deps } = makeDeps({ ddb: makeFilteringDdb([noPhase]) });
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(m.candidates).toBe(1);
  });
});

/**
 * TEAM-3991 D1.2 trigger (a): a dead session that already delivered. The agent
 * pushed the branch / opened the PR and then died before report_completion —
 * spending a retry (or, worse, escalating to a human) re-runs work that already
 * exists. When the injected synthesizeCompletion harvests GitHub evidence, the
 * ticket is transitioned by THAT path (which drives the normal done cascade) and
 * the detector must stop: no retry, no escalation, no re-dispatch. The dep is
 * optional, so an unwired detector keeps the pre-3991 behaviour exactly.
 */
describe("synthesized completion (D1.2 trigger a)", () => {
  it("evidence found → agent.error still announced, but NO retry/escalate/re-dispatch", async () => {
    const synthesizeCompletion = vi.fn(async () => ({ synthesized: true, branch: "feature/TEAM-2-dev", prUrl: "https://github.com/o/r/pull/9" }));
    const { deps, store, lease } = makeDeps({ synthesizeCompletion });
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    // The steal still happens — the claim IS dead, and the synthesize path needs
    // the entry released before it can transition the ticket.
    expect(lease.stealClaim).toHaveBeenCalledTimes(1);
    expect(eventsOfType(deps.publishEvent, "agent.error")).toHaveLength(1);
    expect(synthesizeCompletion).toHaveBeenCalledTimes(1);
    expect(synthesizeCompletion.mock.calls[0][0]).toMatchObject({ id: "wf_1" });
    expect(synthesizeCompletion.mock.calls[0][1]).toMatchObject({ ticketId: "TEAM-2" });
    // The whole point: the retry budget is untouched and no human is paged.
    expect(deps.redispatch).not.toHaveBeenCalled();
    expect(store.incrementDeadSessionRetry).not.toHaveBeenCalled();
    expect(eventsOfType(deps.publishEvent, "agent.escalated")).toHaveLength(0);
    expect(store.appendNotification).not.toHaveBeenCalled();
    expect(deps.blockTicket).not.toHaveBeenCalled();
    expect(m.fired).toBe(1);
    expect(m.retries).toBe(0);
    expect(m.escalations).toBe(0);
  });

  it("no evidence → the retry path is unchanged", async () => {
    const synthesizeCompletion = vi.fn(async () => ({ synthesized: false, reason: "no_branch" }));
    const { deps, store } = makeDeps({ synthesizeCompletion });
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(synthesizeCompletion).toHaveBeenCalledTimes(1);
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(store.incrementDeadSessionRetry).toHaveBeenCalledWith("wf_1", "TEAM-2");
    expect(m.retries).toBe(1);
  });

  it("evidence found on the LAST retry → escalation suppressed too (a delivered ticket is not a failure)", async () => {
    const synthesizeCompletion = vi.fn(async () => ({ synthesized: true, branch: "feature/TEAM-2-dev" }));
    const wf = makeWorkflow({ deadSessionRetries: { "TEAM-2": 1 } });
    const { deps, store } = makeDeps({ ddb: makeDdb({ workflows: [wf] }), synthesizeCompletion });
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(eventsOfType(deps.publishEvent, "agent.escalated")).toHaveLength(0);
    expect(store.setTaskStatus).not.toHaveBeenCalled();
    expect(deps.blockTicket).not.toHaveBeenCalled();
    expect(m.escalations).toBe(0);
  });

  it("a throwing synthesize never breaks the sweep — falls through to retry", async () => {
    const synthesizeCompletion = vi.fn(async () => { throw new Error("s3 down"); });
    const { deps } = makeDeps({ synthesizeCompletion });
    const { runSweep } = createDetector(deps);

    const m = await runSweep("enforce");

    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(m.retries).toBe(1);
  });

  it("shadow mode never asks GitHub (observe-only means zero side effects)", async () => {
    const synthesizeCompletion = vi.fn(async () => ({ synthesized: true }));
    const { deps } = makeDeps({ synthesizeCompletion });
    const { runSweep } = createDetector(deps);

    await runSweep("shadow");

    expect(synthesizeCompletion).not.toHaveBeenCalled();
  });
});
