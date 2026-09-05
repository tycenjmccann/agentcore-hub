import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReconcileSweep, SWEEP_ROTATION_QUANTUM_MS } from "./reconcile-sweep.mjs";
import { createCascade } from "./cascade.mjs";

/**
 * TEAM-3747 D1 — the missed-unblock reconciliation sweep. A scheduled sentinel
 * invokes runSweep(): it scans non-terminal workflows for dependents whose
 * blockers are ALL satisfied but which never received their unblock event
 * (orchestrator crash, dropped stream/webhook delivery, or a stale-GSI miss past
 * the cascade's one bounded retry) and re-drives them idempotently.
 *
 * Every effect is injected, so these run with a stub ddb, a REAL cascade
 * instance (createCascade — the sweep MUST route through the ONE implementation
 * of the R3 invariant, never re-implement lease/steal), stub lease/redispatch/
 * reawaken effects, and a fake clock. They pin the HARD INVARIANTS:
 *   - R3 is enforced FIRST for every candidate — a live lease is nudge-only,
 *     ZERO steal, regardless of the board status the scan observed.
 *   - the stale-lease recovery is generation-CAS steal → claim-CAS redispatch;
 *     a ready/todo candidate goes straight through the claim CAS.
 *   - idempotent — a second pass whose claim CAS is lost is a harmless no-op.
 *   - shadow writes NOTHING; off skips the scan entirely; unknown mode fails
 *     safe to shadow.
 */

const TTL_MS = 30 * 60 * 1000; // 30 min — floors the min-parked window
const NOW = Date.parse("2026-09-01T12:00:00Z");
const STALE_STARTED = "2026-09-01T00:00:00Z"; // 12h before NOW → any lease stale, parked long enough
const PARENT = "EPIC-1";
const DONE = "TEAM-1"; // a satisfied (done) blocker in every snapshot

/** Fake DocumentClient: workflows Scan → the given rows; everything else empty. */
function makeDdb({ workflows = [] } = {}) {
  return {
    send: vi.fn(async (cmd) => {
      if (cmd.constructor.name === "ScanCommand") return { Items: workflows };
      return {};
    }),
  };
}

// emitReconcileMetrics writes a single EMF record to console.log (the sweep's own
// `log` dep is a no-op here), so any captured `_aws` record IS a metrics emission.
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

// A REAL cascade whose only injected effects are the lease/redispatch/reawaken
// stubs — reconcileDependent runs for real against them, honoring the mode the
// sweep passes per call (independent of the cascade's own extendedMode).
function makeCascade(overrides = {}) {
  const publishEvent = overrides.publishEvent || vi.fn(async () => {});
  const lease = {
    LEASE_TTL_MS: TTL_MS,
    isLeaseLive: vi.fn(() => false), // stale by default
    lastAgentActivity: vi.fn(async () => null),
    stealClaim: vi.fn(async () => true),
    ...overrides.lease,
  };
  const redispatch = overrides.redispatch || vi.fn(async () => true);
  const reawakenGate = overrides.reawakenGate || vi.fn(async () => true);
  const cascade = createCascade({
    ddb: { send: vi.fn(async () => ({})) },
    ticketsTable: "tickets",
    provider: "dynamodb",
    jiraTransition: vi.fn(async () => {}),
    getChildTickets: vi.fn(async () => []),
    publishEvent,
    now: () => NOW,
    log: () => {},
    extendedStates: "enforce", // irrelevant — reconcileDependent takes mode per call
    lease,
    eventsTable: "events",
    workflowsTable: "workflows",
    redispatch,
    reawakenGate,
    ...(overrides.store ? { store: overrides.store } : {}),
    ...(overrides.blockTicket ? { blockTicket: overrides.blockTicket } : {}),
  });
  return { cascade, publishEvent, lease, redispatch, reawakenGate };
}

function makeSweep(overrides = {}) {
  const { cascade, publishEvent, lease, redispatch, reawakenGate } = makeCascade(overrides);
  const ddb = overrides.ddb || makeDdb({ workflows: overrides.workflows || [] });
  const getChildTickets = overrides.getChildTickets || vi.fn(async () => overrides.siblings || []);
  const sweep = createReconcileSweep({
    ddb,
    workflowsTable: "workflows",
    cascade,
    getChildTickets,
    leaseTtlMs: overrides.leaseTtlMs !== undefined ? overrides.leaseTtlMs : TTL_MS,
    now: overrides.now || (() => NOW),
    log: overrides.log || (() => {}),
    // TEAM-3991 D2.3 — the ready-SLA floor and the two extra sweep steps. Left
    // undefined by default so every pre-D2.3 test still exercises the env/default
    // path and the extra steps stay off.
    readySlaMs: overrides.readySlaMs,
    gateBypassRecheck: overrides.gateBypassRecheck,
    retryEpicRollup: overrides.retryEpicRollup,
    // TEAM-3992 D4.2 — the coding-runtime-outage skip. Unset by default so every
    // pre-D4.2 test exercises the reserved-reason-stays-zero path.
    runtimeOutageActive: overrides.runtimeOutageActive,
    isCodingTicket: overrides.isCodingTicket,
  });
  return { ...sweep, ddb, getChildTickets, cascade, publishEvent, lease, redispatch, reawakenGate,
    store: overrides.store, blockTicket: overrides.blockTicket,
    runtimeOutageActive: overrides.runtimeOutageActive, isCodingTicket: overrides.isCodingTicket };
}

// A non-terminal workflow whose in_progress dependent carries a stale running claim.
const workflow = (extra = {}) => ({
  id: "wf_1", workflowId: "wf_1", epicId: PARENT, phase: "development",
  updatedAt: STALE_STARTED,
  agentTasks: {
    "TEAM-2": { id: "t2", agentId: "dev", ticketId: "TEAM-2", status: "running", startedAt: STALE_STARTED },
  },
  ...extra,
});

// Scenario snapshots (the parentId-index sibling set). The just-satisfied blocker
// DONE reads "done"; the parked dependent has been sitting since STALE_STARTED.
const inProgressStale = [
  { ticketId: DONE, status: "done", type: "task" },
  { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", type: "task", blockedBy: [DONE], updatedAt: STALE_STARTED },
];
const readyCandidate = [
  { ticketId: DONE, status: "done", type: "task" },
  { ticketId: "TEAM-3", status: "ready", assignee: "dev", type: "task", blockedBy: [DONE], updatedAt: STALE_STARTED },
];

const eventsOfType = (fn, type) => fn.mock.calls.filter((c) => c[1] === type);

beforeEach(() => vi.clearAllMocks());

describe("AC-D1.4 — a parked in_progress dependent with a satisfied blocker but no unblock event", () => {
  it("is found + recovered: generation-CAS steal → claim-CAS redispatch (enforce)", async () => {
    const s = makeSweep({ workflows: [workflow()], siblings: inProgressStale });

    const m = await s.runSweep("enforce");

    expect(m.candidates).toBe(1);
    // Stale generation stolen on the EXACT startedAt, then re-dispatched once.
    expect(s.lease.stealClaim).toHaveBeenCalledTimes(1);
    expect(s.lease.stealClaim.mock.calls[0].slice(1)).toEqual(["workflows", "wf_1", "TEAM-2", STALE_STARTED]);
    expect(s.redispatch).toHaveBeenCalledTimes(1);
    expect(s.redispatch.mock.calls[0][1].ticketId).toBe("TEAM-2");
    expect(m.redispatched).toBe(1);
    // The sweep recovers WITHOUT ever Readying via the cascade — no unblock journal.
    expect(eventsOfType(s.publishEvent, "orchestrator.unblocked")).toHaveLength(0);
    expect(eventsOfType(s.publishEvent, "orchestrator.nudge")).toHaveLength(0);
  });

  it("emits ReconcileRedispatch == 1 in the sweep's EMF record", async () => {
    const s = makeSweep({ workflows: [workflow()], siblings: inProgressStale });
    const cap = captureMetrics();
    await s.runSweep("enforce");
    const records = cap.records();
    cap.restore();

    expect(records).toHaveLength(1);
    expect(records[0].ReconcileMode).toBe("enforce");
    expect(records[0].ReconcileSweepCandidates).toBe(1);
    expect(records[0].ReconcileRedispatch).toBe(1);
    expect(records[0].ReconcileSkippedLiveLease).toBe(0);
  });

  it("a second pass whose claim CAS is lost is a harmless no-op (idempotent recovery)", async () => {
    // The recovery already ran; a racing fresh claim now wins the claim CAS, so
    // redispatch returns false → outcome redispatch-refused → tallied as noop.
    const s = makeSweep({
      workflows: [workflow()],
      siblings: inProgressStale,
      redispatch: vi.fn(async () => false),
    });

    const m = await s.runSweep("enforce");

    expect(m.candidates).toBe(1);
    expect(s.lease.stealClaim).toHaveBeenCalledTimes(1); // the steal still won…
    expect(m.redispatched).toBe(0);                       // …but the claim CAS lost
    expect(m.noop).toBe(1);
  });
});

describe("R3 — a live lease is gated FIRST: nudge at most, ZERO steal", () => {
  it("live in_progress candidate → nudge only, ReconcileSkippedLiveLease == 1", async () => {
    const s = makeSweep({
      workflows: [workflow()],
      siblings: inProgressStale,
      lease: { isLeaseLive: vi.fn(() => true) },
    });
    const cap = captureMetrics();

    const m = await s.runSweep("enforce");
    const records = cap.records();
    cap.restore();

    expect(m.candidates).toBe(1);
    expect(s.lease.stealClaim).not.toHaveBeenCalled();
    expect(s.redispatch).not.toHaveBeenCalled();
    expect(m.skippedLiveLease).toBe(1);
    // TEAM-3969: observed, not published — see cascade.test "sweep path".
    expect(eventsOfType(s.publishEvent, "orchestrator.nudge")).toHaveLength(0);
    expect(records[0].ReconcileSkippedLiveLease).toBe(1);
    expect(records[0].ReconcileRedispatch).toBe(0);
  });
});

describe("a ready/todo dependent whose blockers are satisfied is dispatched", () => {
  it("ready candidate → straight through the claim CAS (redispatch), no steal", async () => {
    const s = makeSweep({ workflows: [workflow()], siblings: readyCandidate });

    const m = await s.runSweep("enforce");

    expect(m.candidates).toBe(1);
    // ready has no live claim to steal — the lease gate returned false, so we go
    // straight to the claim CAS.
    expect(s.lease.stealClaim).not.toHaveBeenCalled();
    expect(s.redispatch).toHaveBeenCalledTimes(1);
    expect(s.redispatch.mock.calls[0][1].ticketId).toBe("TEAM-3");
    expect(m.redispatched).toBe(1);
  });
});

describe("a ticket with an UNsatisfied blocker is never touched", () => {
  it("an open (non-terminal) blocker keeps the dependent out of the candidate set", async () => {
    const siblings = [
      { ticketId: DONE, status: "done", type: "task" },
      // A second blocker still in flight, with NO assignee so it isn't itself a
      // candidate — the point is TEAM-2 stays untouched.
      { ticketId: "TEAM-9", status: "in_progress", type: "task" },
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", type: "task", blockedBy: [DONE, "TEAM-9"], updatedAt: STALE_STARTED },
    ];
    const s = makeSweep({ workflows: [workflow()], siblings });

    const m = await s.runSweep("enforce");

    expect(m.candidates).toBe(0);
    expect(s.lease.stealClaim).not.toHaveBeenCalled();
    expect(s.redispatch).not.toHaveBeenCalled();
  });
});

describe("shadow mode — candidates found + metrics emitted, ZERO writes", () => {
  it("stale in_progress candidate → would-redispatch tallied, no steal/redispatch/nudge", async () => {
    const s = makeSweep({ workflows: [workflow()], siblings: inProgressStale });
    const cap = captureMetrics();

    const m = await s.runSweep("shadow");
    const records = cap.records();
    cap.restore();

    expect(m.mode).toBe("shadow");
    expect(m.candidates).toBe(1);
    expect(s.lease.stealClaim).not.toHaveBeenCalled();
    expect(s.redispatch).not.toHaveBeenCalled();
    expect(eventsOfType(s.publishEvent, "orchestrator.nudge")).toHaveLength(0);
    expect(m.wouldRedispatch).toBe(1);
    expect(records[0].ReconcileMode).toBe("shadow");
    expect(records[0].ReconcileSweepCandidates).toBe(1);
    expect(records[0].ReconcileWouldRedispatch).toBe(1);
    expect(records[0].ReconcileRedispatch).toBe(0);
  });
});

describe("off mode skips the sweep entirely", () => {
  it("no scan, no candidates", async () => {
    const s = makeSweep({ workflows: [workflow()], siblings: inProgressStale });
    const m = await s.runSweep("off");
    expect(m.mode).toBe("off");
    expect(m.candidates).toBe(0);
    expect(s.ddb.send).not.toHaveBeenCalled();
    expect(s.redispatch).not.toHaveBeenCalled();
  });
});

describe("mode normalization (fail-safe, mirrors the detector)", () => {
  it('" ENFORCE " (case + whitespace) normalizes to enforce — the recovery runs', async () => {
    const s = makeSweep({ workflows: [workflow()], siblings: inProgressStale });
    const m = await s.runSweep(" ENFORCE ");
    expect(m.mode).toBe("enforce");
    expect(m.redispatched).toBe(1);
  });

  it('"OFF" normalizes to off — sweep skipped', async () => {
    const s = makeSweep({ workflows: [workflow()], siblings: inProgressStale });
    const m = await s.runSweep("OFF");
    expect(m.mode).toBe("off");
    expect(s.ddb.send).not.toHaveBeenCalled();
  });

  it.each(["bogus", "", "enfrce", undefined])(
    "unknown mode %j coerces to shadow — candidates found, ZERO writes",
    async (raw) => {
      const s = makeSweep({ workflows: [workflow()], siblings: inProgressStale });
      const m = await s.runSweep(raw);
      expect(m.mode).toBe("shadow");
      expect(m.candidates).toBe(1);
      expect(s.lease.stealClaim).not.toHaveBeenCalled();
      expect(s.redispatch).not.toHaveBeenCalled();
    }
  );
});

describe("candidate gating", () => {
  it("skips a dependent parked too recently to be a stall (updatedAt within the window)", async () => {
    const recent = new Date(NOW - 60 * 1000).toISOString(); // 1 min ago < 30 min TTL
    const siblings = [
      { ticketId: DONE, status: "done", type: "task" },
      { ticketId: "TEAM-2", status: "in_progress", assignee: "dev", type: "task", blockedBy: [DONE], updatedAt: recent },
    ];
    const s = makeSweep({ workflows: [workflow()], siblings });
    const m = await s.runSweep("enforce");
    expect(m.candidates).toBe(0);
    expect(s.redispatch).not.toHaveBeenCalled();
  });

  it("skips epics, unassigned tickets, and terminal/pending statuses", async () => {
    const siblings = [
      { ticketId: DONE, status: "done", type: "task" },
      { ticketId: "EPIC-X", status: "in_progress", assignee: "dev", type: "epic", blockedBy: [DONE], updatedAt: STALE_STARTED },
      { ticketId: "NOASSIGN", status: "ready", type: "task", blockedBy: [DONE], updatedAt: STALE_STARTED },
      { ticketId: "PENDING-X", status: "pending", assignee: "dev", type: "task", blockedBy: [DONE], updatedAt: STALE_STARTED },
      { ticketId: "DONE-X", status: "done", assignee: "dev", type: "task", blockedBy: [DONE], updatedAt: STALE_STARTED },
    ];
    const s = makeSweep({ workflows: [workflow()], siblings });
    const m = await s.runSweep("enforce");
    expect(m.candidates).toBe(0);
    expect(s.redispatch).not.toHaveBeenCalled();
  });

  it("skips a workflow with no epicId (nothing to scan)", async () => {
    const s = makeSweep({ workflows: [workflow({ epicId: undefined })], siblings: inProgressStale });
    const m = await s.runSweep("enforce");
    expect(m.candidates).toBe(0);
    expect(s.getChildTickets).not.toHaveBeenCalled();
  });
});

describe("per-candidate / per-workflow error isolation", () => {
  it("a getChildTickets throw is counted and does not abort the sweep", async () => {
    const s = makeSweep({
      workflows: [workflow()],
      getChildTickets: vi.fn(async () => { throw new Error("tickets API down"); }),
    });
    const m = await s.runSweep("enforce");
    expect(m.candidateErrors).toBe(1);
    expect(m.candidates).toBe(0);
  });
});

describe("sweep truncation", () => {
  it("caps at 50 workflows and flags truncated", async () => {
    const many = Array.from({ length: 55 }, (_, i) =>
      workflow({ id: `wf_${i}`, workflowId: `wf_${i}`, epicId: `EPIC-${i}` }));
    const s = makeSweep({ workflows: many, siblings: [] });
    const m = await s.runSweep("shadow");
    expect(m.truncated).toBe(true);
  });
});

/**
 * TEAM-3764 F5 — a capped scan must not starve older workflows. Before this fix
 * every sweep re-inspected the same newest-50 slice, so with >50 open workflows
 * the older parked ones were NEVER reached. The window now rotates: chunk k of
 * the recency-sorted list this rotation quantum, chunk k+1 the next, wrapping —
 * so every open workflow is inspected within ceil(N / 50) quanta. The rotation
 * derives from the injected clock (stateless — zero writes, shadow stays
 * write-free; a cold start computes the same window a warm one would).
 */
describe("TEAM-3764 F5 — the capped window rotates so older workflows are inspected", () => {
  // 120 open workflows, newest first (wf_0 newest … wf_119 oldest) → 3 chunks.
  const N = 120;
  const PAGES = Math.ceil(N / 50);
  const fleet = () =>
    Array.from({ length: N }, (_, i) =>
      workflow({
        id: `wf_${i}`, workflowId: `wf_${i}`, epicId: `EPIC-${i}`,
        updatedAt: new Date(NOW - (i + 1) * 60_000).toISOString(),
      }));

  it("a workflow OUTSIDE the first window is inspected within ceil(N/cap) sweeps", async () => {
    const clock = { v: NOW };
    const getChildTickets = vi.fn(async () => []);
    const s = makeSweep({ workflows: fleet(), getChildTickets, now: () => clock.v });

    const inspected = new Set();
    for (let sweep = 0; sweep < PAGES; sweep++) {
      const before = getChildTickets.mock.calls.length;
      await s.runSweep("shadow");
      const thisSweep = getChildTickets.mock.calls.slice(before).map((c) => c[0]);
      expect(thisSweep.length).toBeLessThanOrEqual(50); // the cap still holds per sweep
      thisSweep.forEach((e) => inspected.add(e));
      clock.v += SWEEP_ROTATION_QUANTUM_MS; // next sweep lands in the next quantum
    }

    // wf_119 (oldest — deepest chunk, unreachable before this fix) was inspected…
    expect(inspected.has(`EPIC-${N - 1}`)).toBe(true);
    // …and so was EVERY open workflow, within ceil(N/cap)=3 sweeps.
    expect(inspected.size).toBe(N);
  });

  it("sweeps within the SAME quantum re-inspect the same window (deterministic)", async () => {
    const clock = { v: NOW };
    const getChildTickets = vi.fn(async () => []);
    const s = makeSweep({ workflows: fleet(), getChildTickets, now: () => clock.v });

    await s.runSweep("shadow");
    const first = getChildTickets.mock.calls.map((c) => c[0]);
    getChildTickets.mockClear();
    clock.v += 1_000; // one second later — same quantum
    await s.runSweep("shadow");
    const second = getChildTickets.mock.calls.map((c) => c[0]);
    expect(second).toEqual(first);
  });

  it("under the cap the window is the whole set (rotation is a no-op)", async () => {
    const few = Array.from({ length: 5 }, (_, i) =>
      workflow({ id: `wf_${i}`, workflowId: `wf_${i}`, epicId: `EPIC-${i}` }));
    const getChildTickets = vi.fn(async () => []);
    // A clock deep into some arbitrary quantum — must not slice a 5-row set.
    const s = makeSweep({ workflows: few, getChildTickets, now: () => NOW + 7 * SWEEP_ROTATION_QUANTUM_MS });
    const m = await s.runSweep("shadow");
    expect(m.truncated).toBe(false);
    expect(getChildTickets.mock.calls.length).toBe(5);
  });
});

describe("exposed predicates", () => {
  it("allBlockersResolved: vacuously true with no blockers (a missed dispatch)", () => {
    const s = makeSweep();
    expect(s.allBlockersResolved({ ticketId: "T", blockedBy: [] }, [])).toBe(true);
    expect(s.allBlockersResolved({ ticketId: "T" }, [])).toBe(true);
  });

  it("allBlockersResolved: false while any blocker is non-terminal", () => {
    const s = makeSweep();
    const snap = [{ ticketId: "B1", status: "done" }, { ticketId: "B2", status: "in_progress" }];
    expect(s.allBlockersResolved({ ticketId: "T", blockedBy: ["B1", "B2"] }, snap)).toBe(false);
  });

  it("allBlockersResolved: true when every blocker is done/cancelled", () => {
    const s = makeSweep();
    const snap = [{ ticketId: "B1", status: "done" }, { ticketId: "B2", status: "cancelled" }];
    expect(s.allBlockersResolved({ ticketId: "T", blockedBy: ["B1", "B2"] }, snap)).toBe(true);
  });

  it("parkedLongEnough: no updatedAt → true; recent → false; old → true", () => {
    const s = makeSweep();
    expect(s.parkedLongEnough({}, NOW)).toBe(true);
    expect(s.parkedLongEnough({ updatedAt: new Date(NOW - 60 * 1000).toISOString() }, NOW)).toBe(false);
    expect(s.parkedLongEnough({ updatedAt: STALE_STARTED }, NOW)).toBe(true);
  });
});

/**
 * TEAM-3755 F8 — the sweep must not scan runs that already CLOSED.
 *
 * The scan's FilterExpression named only complete/cancelled/error, so a run closed
 * on a TEAM-3747 D2 honest outcome (deploy-blocked / static-ci-only) still read as
 * "open": in enforce mode the sweep could steal a lease and re-dispatch a parked
 * candidate inside a terminally-blocked workflow, resurrecting work after the
 * verdict. The filter is now DERIVED from the shared TERMINAL_WORKFLOW_PHASES
 * (completion.mjs, the F2 list), so the two can never drift again.
 */
describe("TEAM-3755 F8 — the workflow scan excludes EVERY terminal phase", () => {
  /** Which phase values the emitted FilterExpression actually refuses (placeholder-agnostic). */
  const refusedPhases = (input) => {
    const inList = String(input.FilterExpression).match(/IN \(([^)]*)\)/)?.[1] || "";
    const keys = inList.split(",").map((k) => k.trim());
    return keys.map((k) => input.ExpressionAttributeValues[k]).sort();
  };
  const ALL_TERMINAL_PHASES = ["cancelled", "complete", "deploy-blocked", "error", "static-ci-only"];

  /**
   * A ddb stub that EMULATES the server-side filter (the real Scan applies it;
   * makeDdb returns every row regardless), so these assert behavior, not strings.
   * Mirrors `NOT (#p IN (…))`: a row with NO phase attribute is KEPT, exactly as
   * DynamoDB evaluates it.
   */
  function makeFilteringDdb(workflows) {
    return {
      send: vi.fn(async (cmd) => {
        if (cmd.constructor.name !== "ScanCommand") return {};
        const refused = new Set(refusedPhases(cmd.input));
        return { Items: workflows.filter((w) => !(w.phase && refused.has(w.phase))) };
      }),
    };
  }

  it("refuses all five terminal phases, derived from the shared list", async () => {
    const s = makeSweep({ workflows: [workflow()], siblings: inProgressStale });
    await s.runSweep("enforce");

    const scans = s.ddb.send.mock.calls
      .filter((c) => c[0].constructor.name === "ScanCommand")
      .map((c) => c[0].input);
    expect(scans).toHaveLength(1);
    expect(refusedPhases(scans[0])).toEqual(ALL_TERMINAL_PHASES);
    expect(scans[0].ExpressionAttributeNames).toEqual({ "#p": "phase" });
    // Every declared value is referenced by the filter and vice-versa.
    expect(Object.keys(scans[0].ExpressionAttributeValues)).toHaveLength(ALL_TERMINAL_PHASES.length);
  });

  it("a deploy-blocked run's parked candidate is NEVER re-driven (enforce)", async () => {
    // Identical to the AC-D1.4 recovery scenario except the run already closed
    // deploy-blocked. Before F8 this candidate was stolen + re-dispatched.
    const s = makeSweep({
      ddb: makeFilteringDdb([workflow({ phase: "deploy-blocked" })]),
      siblings: inProgressStale,
    });

    const m = await s.runSweep("enforce");

    expect(m.candidates).toBe(0);
    expect(s.getChildTickets).not.toHaveBeenCalled();
    expect(s.lease.stealClaim).not.toHaveBeenCalled();
    expect(s.redispatch).not.toHaveBeenCalled();
  });

  it("a static-ci-only run is skipped too", async () => {
    const s = makeSweep({
      ddb: makeFilteringDdb([workflow({ phase: "static-ci-only" })]),
      siblings: inProgressStale,
    });

    const m = await s.runSweep("enforce");

    expect(m.candidates).toBe(0);
    expect(s.redispatch).not.toHaveBeenCalled();
  });

  it("an OPEN run beside two blocked ones is still recovered", async () => {
    // The filter must narrow the scan, not empty it.
    const s = makeSweep({
      ddb: makeFilteringDdb([
        workflow({ phase: "deploy-blocked" }),
        workflow({ phase: "development" }),
        workflow({ phase: "static-ci-only" }),
      ]),
      siblings: inProgressStale,
    });

    const m = await s.runSweep("enforce");

    expect(m.candidates).toBe(1);
    expect(s.redispatch).toHaveBeenCalledTimes(1);
  });

  it("a row with NO phase attribute still scans as open (unchanged semantics)", async () => {
    // The `NOT (#p IN (…))` form is kept deliberately: a chain of `#p <> :v` would
    // silently DROP phase-less rows (e.g. the start-route dedup markers).
    const { phase, ...noPhase } = workflow();
    const s = makeSweep({ ddb: makeFilteringDdb([noPhase]), siblings: inProgressStale });

    const m = await s.runSweep("enforce");

    expect(m.candidates).toBe(1);
  });
});

describe("TEAM-3969 — stale in_progress recovery shares the dead-session retry budget", () => {
  const makeStore = () => ({
    incrementDeadSessionRetry: vi.fn(async () => 1),
    setTaskStatus: vi.fn(async () => {}),
    appendNotification: vi.fn(async () => {}),
  });

  it("first death: steal + re-dispatch, and the retry counter is bumped AFTER the steal wins", async () => {
    const store = makeStore();
    const blockTicket = vi.fn(async () => {});
    const s = makeSweep({ workflows: [workflow()], siblings: inProgressStale, store, blockTicket });

    const m = await s.runSweep("enforce");

    expect(s.lease.stealClaim).toHaveBeenCalledTimes(1);
    expect(s.redispatch).toHaveBeenCalledTimes(1);
    expect(m.redispatched).toBe(1);
    expect(m.escalated).toBe(0);
    expect(store.incrementDeadSessionRetry).toHaveBeenCalledWith("wf_1", "TEAM-2");
    expect(store.setTaskStatus).not.toHaveBeenCalled();
    expect(blockTicket).not.toHaveBeenCalled();
  });

  it("aborted steal (lease live again on re-check) does NOT burn the budget", async () => {
    const store = makeStore();
    const isLeaseLive = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const s = makeSweep({ workflows: [workflow()], siblings: inProgressStale, store, lease: { isLeaseLive } });

    const m = await s.runSweep("enforce");

    expect(s.lease.stealClaim).not.toHaveBeenCalled();
    expect(store.incrementDeadSessionRetry).not.toHaveBeenCalled();
    expect(m.skippedLiveLease).toBe(1);
    expect(eventsOfType(s.publishEvent, "orchestrator.nudge")).toHaveLength(0);
  });

  it("second death (deadSessionRetries=1): ZERO steal/re-dispatch → manager_escalation, task error, ticket parked", async () => {
    const store = makeStore();
    const blockTicket = vi.fn(async () => {});
    const s = makeSweep({
      workflows: [workflow({ deadSessionRetries: { "TEAM-2": 1 } })],
      siblings: inProgressStale, store, blockTicket,
    });
    const cap = captureMetrics();

    const m = await s.runSweep("enforce");
    const records = cap.records();
    cap.restore();

    expect(s.lease.stealClaim).not.toHaveBeenCalled();
    expect(s.redispatch).not.toHaveBeenCalled();
    expect(store.incrementDeadSessionRetry).not.toHaveBeenCalled();
    expect(m.redispatched).toBe(0);
    expect(m.escalated).toBe(1);
    expect(records[0].ReconcileEscalations).toBe(1);
    expect(eventsOfType(s.publishEvent, "agent.escalated")).toHaveLength(1);
    expect(store.setTaskStatus).toHaveBeenCalledWith("wf_1", "TEAM-2", "error");
    expect(blockTicket).toHaveBeenCalledWith("TEAM-2", "dead_session_retry_exhausted");
    expect(store.appendNotification).toHaveBeenCalledTimes(1);
    const notif = store.appendNotification.mock.calls[0][1];
    expect(notif.type).toBe("manager_escalation");
    expect(notif.ticketId).toBe("TEAM-2");
    expect(notif.acknowledged).toBe(false);
  });

  it("second death in shadow mode: observe only, zero writes", async () => {
    const store = makeStore();
    const blockTicket = vi.fn(async () => {});
    const s = makeSweep({
      workflows: [workflow({ deadSessionRetries: { "TEAM-2": 1 } })],
      siblings: inProgressStale, store, blockTicket,
    });

    const m = await s.runSweep("shadow");

    expect(s.lease.stealClaim).not.toHaveBeenCalled();
    expect(s.redispatch).not.toHaveBeenCalled();
    expect(store.setTaskStatus).not.toHaveBeenCalled();
    expect(store.appendNotification).not.toHaveBeenCalled();
    expect(blockTicket).not.toHaveBeenCalled();
    expect(s.publishEvent).not.toHaveBeenCalled();
    expect(m.escalated).toBe(0);
    expect(m.wouldRedispatch).toBe(1);
  });

  it("store unwired: legacy uncapped steal (pre-3968 callers are byte-identical)", async () => {
    const s = makeSweep({
      workflows: [workflow({ deadSessionRetries: { "TEAM-2": 5 } })],
      siblings: inProgressStale,
    });

    const m = await s.runSweep("enforce");

    expect(s.lease.stealClaim).toHaveBeenCalledTimes(1);
    expect(m.redispatched).toBe(1);
    expect(m.escalated).toBe(0);
  });
});

describe("TEAM-3973 — an escalated ticket is HELD for the human in every status", () => {
  // deadSessionRetries spent + task status "error" = the escalation's own marks.
  const escalated = (extra = {}) => workflow({
    deadSessionRetries: { "TEAM-2": 1 },
    agentTasks: { "TEAM-2": { id: "t2", agentId: "dev", ticketId: "TEAM-2", status: "error", startedAt: STALE_STARTED } },
    ...extra,
  });

  for (const status of ["in_progress", "todo", "ready", "blocked", "in_review"]) {
    it(`${status} candidate is held: zero steal, zero redispatch, zero re-escalation`, async () => {
      const s = makeSweep({
        workflows: [escalated()],
        siblings: [
          { ticketId: DONE, status: "done", type: "task" },
          { ticketId: "TEAM-2", status, assignee: "dev", type: "task", blockedBy: [DONE], updatedAt: STALE_STARTED },
        ],
        store: { incrementDeadSessionRetry: vi.fn(), setTaskStatus: vi.fn(), appendNotification: vi.fn() },
      });
      const cap = captureMetrics();

      const m = await s.runSweep("enforce");
      const records = cap.records();
      cap.restore();

      expect(m.candidates).toBe(1);
      expect(m.escalationHeld).toBe(1);
      expect(records[0].ReconcileEscalationHeld).toBe(1);
      expect(s.lease.stealClaim).not.toHaveBeenCalled();
      expect(s.redispatch).not.toHaveBeenCalled();
      expect(s.reawakenGate).not.toHaveBeenCalled();
      expect(s.publishEvent).not.toHaveBeenCalled();
      expect(m.redispatched).toBe(0);
      expect(m.escalated).toBe(0);
      // The hold is not a liveness claim — it must not be counted as "agent alive".
      expect(m.skippedLiveLease).toBe(0);
    });
  }

  it("releases as soon as a human re-drive re-claims the ticket (status leaves error)", async () => {
    const s = makeSweep({
      workflows: [escalated({
        agentTasks: { "TEAM-2": { id: "t2", agentId: "dev", ticketId: "TEAM-2", status: "running", startedAt: STALE_STARTED } },
      })],
      siblings: inProgressStale,
    });

    const m = await s.runSweep("enforce");

    expect(m.escalationHeld).toBe(0);
    expect(m.redispatched).toBe(1);
  });

  it("a spent budget alone (task still running) does NOT hold — only the error status does", async () => {
    const s = makeSweep({
      workflows: [workflow({ deadSessionRetries: { "TEAM-2": 1 } })],
      siblings: inProgressStale,
      store: { incrementDeadSessionRetry: vi.fn(), setTaskStatus: vi.fn(async () => {}), appendNotification: vi.fn(async () => {}) },
    });

    const m = await s.runSweep("enforce");

    expect(m.escalationHeld).toBe(0);
    expect(m.escalated).toBe(1); // second death → escalate, unchanged (TEAM-3969)
  });
});

/**
 * TEAM-3991 D2.3 — the split floor, mandatory skip reasons, and the two extra
 * sweep steps.
 *
 * Prod shape driving this (sffzti TEAM-3970): the ticket sat READY and
 * un-dispatched from 20:56Z. Nothing was holding a claim on it — there was no
 * claim — but the sweep held it to the in_progress STEAL floor (the 30-minute
 * lease TTL), so the first sweep allowed to touch it ran at 21:26Z. Half an hour
 * of dead air on a ticket that only ever needed a dispatch. The steal floor itself
 * is correct and must not move: stealing a claim needs proof the session is dead.
 */
describe("D2.3 — the ready SLA is split from the steal floor", () => {
  const T = "TEAM-3970";
  const PARKED_AT = "2026-09-01T20:56:00Z";
  const at = (iso) => Date.parse(iso);

  /** The prod shape: blockers all done, no claim, just never dispatched. */
  const readySiblings = (status = "ready", extra = {}) => [
    { ticketId: DONE, status: "done", type: "task" },
    { ticketId: T, status, assignee: "dev", type: "task", blockedBy: [DONE], updatedAt: PARKED_AT, ...extra },
  ];

  const readyWorkflow = () => ({
    id: "wf_sffzti", workflowId: "wf_sffzti", epicId: PARENT, phase: "development",
    updatedAt: PARKED_AT, agentTasks: {},
  });

  it("sffzti TEAM-3970: one minute after parking it is too recent to touch", async () => {
    const s = makeSweep({
      workflows: [readyWorkflow()], siblings: readySiblings(), now: () => at("2026-09-01T20:57:00Z"),
    });

    const m = await s.runSweep("enforce");

    expect(m.candidates).toBe(0);
    expect(m.skipped.parked_too_recently).toBe(1);
    expect(s.redispatch).not.toHaveBeenCalled();
  });

  it("sffzti TEAM-3970: EIGHT minutes later the same sweep dispatches it (old floor: 30 min)", async () => {
    const s = makeSweep({
      workflows: [readyWorkflow()], siblings: readySiblings(), now: () => at("2026-09-01T21:04:00Z"),
    });

    const m = await s.runSweep("enforce");

    expect(m.candidates).toBe(1);
    expect(m.redispatched).toBe(1);
    expect(m.acted).toBe(1);
    expect(m.skipped.parked_too_recently).toBe(0);
    expect(s.redispatch).toHaveBeenCalledTimes(1);
    expect(s.redispatch.mock.calls[0][1].ticketId).toBe(T);
    // No claim existed, so nothing was stolen — this is a missed DISPATCH.
    expect(s.lease.stealClaim).not.toHaveBeenCalled();
  });

  it("the 2-minute floor applies to todo and blocked-with-satisfied-blockers too", async () => {
    for (const status of ["todo", "blocked"]) {
      const s = makeSweep({
        workflows: [readyWorkflow()], siblings: readySiblings(status), now: () => at("2026-09-01T21:04:00Z"),
      });
      const m = await s.runSweep("enforce");
      expect(m.redispatched, status).toBe(1);
    }
  });

  it("the in_progress STEAL floor is UNCHANGED at the lease TTL — 8 minutes is still too soon", async () => {
    const s = makeSweep({
      workflows: [readyWorkflow()], siblings: readySiblings("in_progress"), now: () => at("2026-09-01T21:04:00Z"),
    });

    const m = await s.runSweep("enforce");

    // 8 min < 30 min TTL → the steal candidate is held back exactly as before.
    expect(m.candidates).toBe(0);
    expect(m.skipped.parked_too_recently).toBe(1);
    expect(s.lease.stealClaim).not.toHaveBeenCalled();
    // ... and it becomes eligible only once past the TTL.
    const later = makeSweep({
      workflows: [readyWorkflow()], siblings: readySiblings("in_progress"), now: () => at("2026-09-01T21:27:00Z"),
    });
    expect((await later.runSweep("enforce")).candidates).toBe(1);
    expect(later.lease.stealClaim).toHaveBeenCalledTimes(1);
  });

  it("a LIVE lease is a lease_live skip, never a steal (R3 unchanged)", async () => {
    const s = makeSweep({
      workflows: [readyWorkflow()],
      siblings: readySiblings("in_progress", { updatedAt: STALE_STARTED }),
      lease: { isLeaseLive: vi.fn(() => true) },
    });

    const m = await s.runSweep("enforce");

    expect(m.candidates).toBe(1);
    expect(m.skipped.lease_live).toBe(1);
    expect(m.acted).toBe(0);
    expect(s.lease.stealClaim).not.toHaveBeenCalled();
    expect(s.redispatch).not.toHaveBeenCalled();
  });

  it("RECONCILE_READY_SLA_MS overrides the default, and a factory opt overrides the env", async () => {
    const saved = process.env.RECONCILE_READY_SLA_MS;
    try {
      // 1 hour via env → the 8-minutes-parked ticket is NOT yet eligible.
      process.env.RECONCILE_READY_SLA_MS = String(60 * 60 * 1000);
      const envSweep = makeSweep({
        workflows: [readyWorkflow()], siblings: readySiblings(), now: () => at("2026-09-01T21:04:00Z"),
      });
      expect(envSweep.readySlaMs).toBe(60 * 60 * 1000);
      expect((await envSweep.runSweep("enforce")).skipped.parked_too_recently).toBe(1);

      // An explicit factory opt wins over the env var.
      const optSweep = makeSweep({
        workflows: [readyWorkflow()], siblings: readySiblings(),
        now: () => at("2026-09-01T21:04:00Z"), readySlaMs: 60 * 1000,
      });
      expect(optSweep.readySlaMs).toBe(60 * 1000);
      expect((await optSweep.runSweep("enforce")).redispatched).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.RECONCILE_READY_SLA_MS;
      else process.env.RECONCILE_READY_SLA_MS = saved;
    }
  });

  it("defaults to two minutes when neither the env var nor the opt is set", async () => {
    const saved = process.env.RECONCILE_READY_SLA_MS;
    delete process.env.RECONCILE_READY_SLA_MS;
    try {
      expect(makeSweep({}).readySlaMs).toBe(120000);
    } finally {
      if (saved !== undefined) process.env.RECONCILE_READY_SLA_MS = saved;
    }
  });
});

describe("D2.3 — every scanned ticket yields an action or a NAMED reason", () => {
  const at = (iso) => Date.parse(iso);
  const NOW_LATE = at("2026-09-01T21:04:00Z");

  // Seven tickets, one per skip reason the scan itself can produce, none of which
  // the sweep should act on.
  const MIXED = [
    { ticketId: DONE, status: "done", type: "task" },                                                     // terminal
    { ticketId: "EPIC-1", status: "in_progress", assignee: "pm", type: "epic" },                          // epic
    { ticketId: "TEAM-A", status: "ready", type: "task", updatedAt: STALE_STARTED },                       // no_assignee
    { ticketId: "TEAM-B", status: "cancelled", assignee: "dev", type: "task" },                            // terminal
    { ticketId: "TEAM-C", status: "ready", assignee: "human:lead@example.com", type: "task", updatedAt: STALE_STARTED }, // human_assigned
    { ticketId: "TEAM-D", status: "ready", assignee: "dev", type: "task", blockedBy: ["TEAM-OPEN"], updatedAt: STALE_STARTED }, // blockers_pending
    { ticketId: "TEAM-OPEN", status: "in_progress", assignee: "dev", type: "task", updatedAt: "2026-09-01T21:03:00Z" }, // parked_too_recently
    { ticketId: "TEAM-E", status: "ready", assignee: "dev", type: "task", updatedAt: "2026-09-01T21:03:30Z" }, // parked_too_recently
  ];

  it("a sweep that acts on nothing still reports sum(skipped) === scanned", async () => {
    const s = makeSweep({
      workflows: [workflow({ agentTasks: {} })], siblings: MIXED, now: () => NOW_LATE,
    });

    const m = await s.runSweep("enforce");

    expect(m.acted).toBe(0);
    const sum = Object.values(m.skipped).reduce((a, b) => a + b, 0);
    expect(sum).toBe(m.scanned);
    expect(m.scanned).toBe(MIXED.length);
  });

  it("names each reason exactly, including human_assigned", async () => {
    const s = makeSweep({
      workflows: [workflow({ agentTasks: {} })], siblings: MIXED, now: () => NOW_LATE,
    });

    const m = await s.runSweep("enforce");

    expect(m.skipped.epic).toBe(1);
    expect(m.skipped.no_assignee).toBe(1);
    expect(m.skipped.terminal).toBe(2);
    expect(m.skipped.human_assigned).toBe(1);
    expect(m.skipped.blockers_pending).toBe(1);
    expect(m.skipped.parked_too_recently).toBe(2);
    // A human's ticket is never handed to an agent by a sweep.
    expect(s.redispatch).not.toHaveBeenCalled();
  });

  it("logs one structured reconcile.skip record per skipped ticket", async () => {
    const records = [];
    const s = makeSweep({
      workflows: [workflow({ agentTasks: {} })], siblings: MIXED, now: () => NOW_LATE,
      log: (msg) => { if (typeof msg === "object" && msg.type === "reconcile.skip") records.push(msg); },
    });

    const m = await s.runSweep("enforce");

    expect(records).toHaveLength(m.scanned);
    expect(records.every((r) => r.workflowId === "wf_1" && r.ticketId && r.reason)).toBe(true);
    expect(records.map((r) => r.reason)).toContain("human_assigned");
  });

  it("emits a ReconcileSkipped_<reason> count for EVERY reason, zeros included", async () => {
    const cap = captureMetrics();
    try {
      const s = makeSweep({
        workflows: [workflow({ agentTasks: {} })], siblings: MIXED, now: () => NOW_LATE, log: () => {},
      });
      await s.runSweep("enforce");
      const rec = cap.records().at(-1);
      expect(rec.ReconcileSkipped_human_assigned).toBe(1);
      expect(rec.ReconcileSkipped_parked_too_recently).toBe(2);
      expect(rec.ReconcileSkipped_escalation_held).toBe(0);
      // Reserved-but-unused reasons are still emitted, so adding the detector
      // later is not a metric migration.
      expect(rec.ReconcileSkipped_runtime_outage).toBe(0);
      expect(rec.ReconcileSweepScanned).toBe(MIXED.length);
    } finally {
      cap.restore();
    }
  });

  it("an in_review gate the cascade leaves alone is counted as in_review, not silence", async () => {
    const s = makeSweep({
      workflows: [workflow({ agentTasks: {} })],
      siblings: [
        { ticketId: DONE, status: "done", type: "task" },
        { ticketId: "TEAM-G", status: "in_review", assignee: "reviewer", type: "task", blockedBy: [DONE], updatedAt: STALE_STARTED },
      ],
      // reawakenGate declining ⇒ the cascade's "review-noop" ⇒ reason in_review.
      reawakenGate: vi.fn(async () => false),
    });

    const m = await s.runSweep("enforce");

    expect(m.candidates).toBe(1);
    expect(m.skipped.in_review + m.skipped.escalation_held).toBe(1);
    expect(m.acted).toBe(0);
  });
});

describe("D2.3 — the two extra sweep steps", () => {
  const at = (iso) => Date.parse(iso);
  const NOW_LATE = at("2026-09-01T21:04:00Z");

  it("re-runs a DEFERRED gate-bypass check once its grace has elapsed", async () => {
    const gateBypassRecheck = vi.fn(async () => ({ flagged: true }));
    const s = makeSweep({
      workflows: [workflow({
        agentTasks: {
          "TEAM-DUE": { ticketId: "TEAM-DUE", gateBypassCheckAt: "2026-09-01T21:00:00Z" },   // due
          "TEAM-LATER": { ticketId: "TEAM-LATER", gateBypassCheckAt: "2026-09-01T23:00:00Z" }, // not yet
          "TEAM-NONE": { ticketId: "TEAM-NONE", status: "done" },                              // never deferred
        },
      })],
      siblings: [], now: () => NOW_LATE, gateBypassRecheck,
    });

    const m = await s.runSweep("enforce");

    expect(gateBypassRecheck).toHaveBeenCalledTimes(1);
    expect(gateBypassRecheck.mock.calls[0][1]).toBe("TEAM-DUE");
    expect(m.bypassRechecked).toBe(1);
  });

  it("shadow mode re-checks nothing (zero writes) and a throwing re-check cannot kill the sweep", async () => {
    const tasks = { "TEAM-DUE": { gateBypassCheckAt: "2026-09-01T21:00:00Z" } };
    const shadow = makeSweep({
      workflows: [workflow({ agentTasks: tasks })], siblings: [], now: () => NOW_LATE,
      gateBypassRecheck: vi.fn(async () => {}),
    });
    await shadow.runSweep("shadow");
    expect(shadow.cascade).toBeTruthy();

    const boom = vi.fn(async () => { throw new Error("github 502"); });
    const s = makeSweep({
      workflows: [workflow({ agentTasks: tasks })], siblings: [], now: () => NOW_LATE, gateBypassRecheck: boom,
    });
    const m = await s.runSweep("enforce");
    expect(boom).toHaveBeenCalledTimes(1);
    expect(m.bypassRechecked).toBe(0);
    expect(m.candidateErrors).toBe(1);
  });

  it("retries an outstanding epic roll-up found by its OWN scan (complete runs are invisible to the main scan)", async () => {
    const pendingRun = {
      id: "wf_rollup", workflowId: "wf_rollup", epicId: "EPIC-9",
      phase: "complete", epicRollupPending: true, agentTasks: {},
    };
    // Two scans, two filters — the open-workflow scan must not see the complete
    // run, and the rollup scan must not see the open one.
    const ddb = {
      send: vi.fn(async (cmd) => {
        if (cmd.constructor.name !== "ScanCommand") return {};
        return String(cmd.input.FilterExpression).includes("epicRollupPending")
          ? { Items: [pendingRun] }
          : { Items: [workflow({ agentTasks: {} })] };
      }),
    };
    const retryEpicRollup = vi.fn(async () => ({ claimed: true, ok: true, attempts: 1 }));

    const s = makeSweep({ ddb, siblings: [], now: () => NOW_LATE, retryEpicRollup });
    const m = await s.runSweep("enforce");

    expect(retryEpicRollup).toHaveBeenCalledTimes(1);
    expect(retryEpicRollup.mock.calls[0][0].id).toBe("wf_rollup");
    expect(m.rollupsRetried).toBe(1);
    expect(m.rollupsRecovered).toBe(1);
  });

  it("a roll-up whose claim was lost counts as retried but NOT recovered, and shadow retries nothing", async () => {
    const pendingRun = { id: "wf_rollup", epicId: "EPIC-9", phase: "complete", epicRollupPending: true, agentTasks: {} };
    const ddb = {
      send: vi.fn(async (cmd) => (cmd.constructor.name === "ScanCommand"
        ? { Items: String(cmd.input.FilterExpression).includes("epicRollupPending") ? [pendingRun] : [] }
        : {})),
    };
    const lost = vi.fn(async () => ({ claimed: false, ok: false, reason: "claim_lost" }));
    const m = await makeSweep({ ddb, siblings: [], retryEpicRollup: lost }).runSweep("enforce");
    expect(m.rollupsRetried).toBe(1);
    expect(m.rollupsRecovered).toBe(0);

    const shadowDep = vi.fn(async () => ({ ok: true }));
    await makeSweep({ ddb, siblings: [], retryEpicRollup: shadowDep }).runSweep("shadow");
    expect(shadowDep).not.toHaveBeenCalled();
  });
});

/**
 * TEAM-3992 D4.2 — during an open coding-runtime outage the sweep must NOT
 * re-drive coding tickets: dispatching into a dead microVM is exactly what the
 * outage park prevented, and the runtime-health recovery sweep owns resuming
 * them. The gate is a ONCE-per-sweep S3 head (runtimeOutageActive) plus a
 * per-sibling roster check (isCodingTicket); non-coding tickets are untouched.
 */
describe("D4.2 — a coding-runtime outage holds coding candidates (runtime_outage skip)", () => {
  it("skips a coding candidate as runtime_outage, never re-dispatches, probes S3 once", async () => {
    const runtimeOutageActive = vi.fn(async () => true);
    const s = makeSweep({
      workflows: [workflow()], siblings: readyCandidate,
      runtimeOutageActive, isCodingTicket: () => true,
    });

    const m = await s.runSweep("enforce");

    expect(runtimeOutageActive).toHaveBeenCalledTimes(1); // once per sweep, not per sibling
    expect(m.skipped.runtime_outage).toBe(1);
    expect(m.candidates).toBe(0); // held before the candidate stage
    expect(m.acted).toBe(0);
    expect(s.redispatch).not.toHaveBeenCalled();
    expect(s.lease.stealClaim).not.toHaveBeenCalled();
  });

  it("during an outage a NON-coding candidate is still recovered normally", async () => {
    const s = makeSweep({
      workflows: [workflow()], siblings: readyCandidate,
      runtimeOutageActive: async () => true, isCodingTicket: () => false,
    });

    const m = await s.runSweep("enforce");

    expect(m.skipped.runtime_outage).toBe(0);
    expect(m.redispatched).toBe(1);
    expect(s.redispatch.mock.calls[0][1].ticketId).toBe("TEAM-3");
  });

  it("no outage → the gate is inert (coding candidate recovered as usual)", async () => {
    const runtimeOutageActive = vi.fn(async () => false);
    const s = makeSweep({
      workflows: [workflow()], siblings: readyCandidate,
      runtimeOutageActive, isCodingTicket: () => true,
    });

    const m = await s.runSweep("enforce");

    expect(runtimeOutageActive).toHaveBeenCalledTimes(1);
    expect(m.skipped.runtime_outage).toBe(0);
    expect(m.redispatched).toBe(1);
  });

  it("a throwing runtimeOutageActive fails safe (outage treated as inactive, sweep survives)", async () => {
    const s = makeSweep({
      workflows: [workflow()], siblings: readyCandidate,
      runtimeOutageActive: async () => { throw new Error("s3 down"); }, isCodingTicket: () => true,
    });

    const m = await s.runSweep("enforce");

    expect(m.skipped.runtime_outage).toBe(0);
    expect(m.redispatched).toBe(1); // recovery proceeds rather than stalling on a probe error
  });
});
