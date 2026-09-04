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
    log: () => {},
  });
  return { ...sweep, ddb, getChildTickets, cascade, publishEvent, lease, redispatch, reawakenGate,
    store: overrides.store, blockTicket: overrides.blockTicket };
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

describe("TEAM-3972 — an escalated ticket is HELD for the human in every status", () => {
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
