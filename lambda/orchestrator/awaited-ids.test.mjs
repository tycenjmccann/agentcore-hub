import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAwaitedIds,
  normalizeAwaitedIdsMode,
  AWAITED_IDS_MODES,
  tallyBlockerResult,
} from "./awaited-ids.mjs";
import { normalizeSyncMode } from "./sync-main.mjs";
import { KIND_TO_ORIGIN_KEY } from "./fix-contract.mjs";

/**
 * TEAM-4166 D1 — the awaited-ids re-wake decision module. Fully DI'd (no AWS):
 * every effect is a plain fake, so the whole surface — mode normalization, the
 * off/shadow/enforce write rules, the addBlockers seam contract, the
 * preconditionUnmet stamp, the await-timeout CAS, and the EMF record — is
 * asserted directly.
 *
 * Provider parity (jira == dynamodb): the module never branches on provider — it
 * routes every write through the ONE provider-aware `addBlockers` seam — so each
 * assertion runs under BOTH providers and must be identical. That IS the parity
 * guarantee at this layer; the seam's own DDB/jira branches are the caller's job
 * (index.mjs) and are pinned by ticket-blockers.test.mjs / the jira contract test.
 */

const NOW = Date.parse("2026-09-06T08:00:00.000Z");

/**
 * A recording `addBlockers` seam that mirrors the REAL index.mjs shape: it
 * returns an array of the id STRINGS newly added, and OMITS idempotent-present
 * ids (a re-add of an existing edge yields []). Tracks edges per origin so a
 * second write of the same edge reads back present-by-omission.
 */
function makeAddBlockers() {
  const calls = [];
  const edges = new Map(); // originId → Set(blockerId)
  const fn = async (ticketId, ids, opts = {}) => {
    calls.push({ ticketId, ids: [...ids], opts });
    const set = edges.get(ticketId) || new Set();
    const added = [];
    for (const id of ids) {
      if (!set.has(id)) { set.add(id); added.push(id); }
    }
    edges.set(ticketId, set);
    return added; // real seam: added-id strings; present ids omitted
  };
  fn.calls = calls;
  return fn;
}

function makeDeps(overrides = {}) {
  const addBlockers = overrides.addBlockers || makeAddBlockers();
  const annotateCalls = [];
  const events = [];
  const casResults = overrides.casResults ? [...overrides.casResults] : [];
  const tickets = overrides.tickets || {};
  const logs = [];
  return {
    _addBlockers: addBlockers,
    _annotateCalls: annotateCalls,
    _events: events,
    _logs: logs,
    deps: {
      provider: overrides.provider || "dynamodb",
      addBlockers,
      annotatePreconditionUnmet: overrides.annotatePreconditionUnmet
        || (async (originId, payload) => { annotateCalls.push({ originId, payload }); }),
      publishEvent: async (ticketId, type, detail) => { events.push({ ticketId, type, detail }); },
      getTicket: async (id) => (id in tickets ? tickets[id] : (overrides.getTicketDefault ?? null)),
      store: {
        markAwaitTimeoutEmitted: async (wfId, ticketId, at) => {
          if (casResults.length) return casResults.shift();
          return true;
        },
      },
      now: () => NOW,
      log: (msg) => logs.push(String(msg)),
      mode: overrides.mode ?? "enforce",
      timeoutMinutes: overrides.timeoutMinutes ?? 120,
    },
  };
}

// ── mode normalization (provider-independent) ───────────────────────────────
describe("normalizeAwaitedIdsMode", () => {
  it("passes the allow-list through", () => {
    for (const m of AWAITED_IDS_MODES) expect(normalizeAwaitedIdsMode(m)).toBe(m);
    expect(normalizeAwaitedIdsMode("ENFORCE")).toBe("enforce");
    expect(normalizeAwaitedIdsMode("  shadow ")).toBe("shadow");
  });

  it("unset/blank → off, silently (a fresh deploy changes nothing)", () => {
    const log = vi.fn();
    expect(normalizeAwaitedIdsMode(undefined, log)).toBe("off");
    expect(normalizeAwaitedIdsMode(null, log)).toBe("off");
    expect(normalizeAwaitedIdsMode("", log)).toBe("off");
    expect(log).not.toHaveBeenCalled();
  });

  it("garbage → off, LOUDLY (awaited_ids.unknown_mode)", () => {
    const log = vi.fn();
    expect(normalizeAwaitedIdsMode("main-first", log)).toBe("off");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("awaited_ids.unknown_mode");
  });
});

describe("tallyBlockerResult (seam contract — tolerate both shapes)", () => {
  it("counts a returned id string as a write", () => {
    expect(tallyBlockerResult(["TEAM-100"], ["TEAM-100"])).toEqual({ written: 1, present: 0 });
  });
  it("treats a requested id ABSENT from an id-shaped result as present (real seam omission)", () => {
    expect(tallyBlockerResult([], ["TEAM-100"])).toEqual({ written: 0, present: 1 });
  });
  it("tolerates the idealized token form (added / present / single string)", () => {
    expect(tallyBlockerResult(["added"], ["TEAM-100"])).toEqual({ written: 1, present: 0 });
    expect(tallyBlockerResult(["present"], ["TEAM-100"])).toEqual({ written: 0, present: 1 });
    expect(tallyBlockerResult("added", ["TEAM-100"])).toEqual({ written: 1, present: 0 });
  });
});

// FR-1.6 tie-in — NOTE: the design brief asserts normalizeSyncMode("main-first")
// !== "off", but the ACTUAL sync-main allow-list is off|shadow|enforce, so
// "main-first" coerces to "off". We assert the brief's INTENT instead: a valid
// non-off mode stays non-off, and garbage coerces to off. (Reported as a design
// mismatch.)
describe("FR-1.6 sync-main tie-in", () => {
  it("a valid sync mode is non-off; garbage coerces to off", () => {
    expect(normalizeSyncMode("enforce")).not.toBe("off");
    expect(normalizeSyncMode("shadow")).not.toBe("off");
    expect(normalizeSyncMode("garbage")).toBe("off");
  });
  it("sync_fix derivation maps to ciTicketId (the edge only exists when the flag is on)", () => {
    expect(KIND_TO_ORIGIN_KEY.sync_fix).toBe("ciTicketId");
    const { deps } = makeDeps({ mode: "off" });
    const ai = createAwaitedIds(deps);
    const derived = ai.deriveAwaitedIds({ ticketId: "TEAM-4157", spawnedBy: { kind: "sync_fix", ciTicketId: "TEAM-4125" } });
    expect(derived).toEqual({ originId: "TEAM-4125", ids: ["TEAM-4157"] });
  });
});

for (const provider of ["dynamodb", "jira"]) {
  describe(`awaited-ids [provider=${provider}]`, () => {
    describe("deriveAwaitedIds (pure)", () => {
      it("maps each fix kind with an origin key to { originId, ids:[fixId] }", () => {
        const { deps } = makeDeps({ provider, mode: "off" });
        const ai = createAwaitedIds(deps);
        for (const [kind, key] of Object.entries(KIND_TO_ORIGIN_KEY)) {
          const d = ai.deriveAwaitedIds({ ticketId: "TEAM-9001", spawnedBy: { kind, [key]: "TEAM-4126" } });
          expect(d).toEqual({ originId: "TEAM-4126", ids: ["TEAM-9001"] });
        }
      });
      it("returns null for a non-fix ticket, a bad id shape, or a self-reference", () => {
        const { deps } = makeDeps({ provider, mode: "off" });
        const ai = createAwaitedIds(deps);
        expect(ai.deriveAwaitedIds({ ticketId: "TEAM-1", spawnedBy: null })).toBeNull();
        expect(ai.deriveAwaitedIds({ ticketId: "TEAM-1", spawnedBy: { kind: "ship_fix", shipTicketId: "not a key" } })).toBeNull();
        expect(ai.deriveAwaitedIds({ ticketId: "TEAM-1", spawnedBy: { kind: "ship_fix", shipTicketId: "TEAM-1" } })).toBeNull();
      });
    });

    describe("off — zero calls to any dependency", () => {
      it("applyAwaitedEdgesForSpawn touches nothing", async () => {
        const h = makeDeps({ provider, mode: "off", tickets: { "TEAM-4126": { ticketId: "TEAM-4126", status: "in_progress" } } });
        const ai = createAwaitedIds(h.deps);
        const res = await ai.applyAwaitedEdgesForSpawn("TEAM-4156", { kind: "ship_fix", shipTicketId: "TEAM-4126" });
        expect(res).toEqual({ skipped: "off" });
        expect(h._addBlockers.calls).toHaveLength(0);
        expect(h._annotateCalls).toHaveLength(0);
      });
    });

    describe("shadow — zero writes, metrics counted", () => {
      it("counts the derivation but never writes", async () => {
        const h = makeDeps({ provider, mode: "shadow", tickets: { "TEAM-4126": { ticketId: "TEAM-4126", status: "in_progress" } } });
        const ai = createAwaitedIds(h.deps);
        const m = ai.newMetrics();
        const res = await ai.applyAwaitedEdgesForSpawn("TEAM-4156", { kind: "ship_fix", shipTicketId: "TEAM-4126" });
        expect(res.skipped).toBe("shadow");
        expect(h._addBlockers.calls).toHaveLength(0); // ZERO writes
        expect(h._annotateCalls).toHaveLength(0);
        expect(m.derived).toBe(1);
        expect(m.written).toBe(0);
        expect(m.present).toBe(0);
      });
    });

    describe("enforce — writes via the seam + stamps preconditionUnmet", () => {
      it("calls addBlockers with preserveStatusIf and annotates {source:'derived'}", async () => {
        const h = makeDeps({ provider, mode: "enforce", tickets: { "TEAM-4126": { ticketId: "TEAM-4126", status: "in_progress" } } });
        const ai = createAwaitedIds(h.deps);
        const m = ai.newMetrics();
        const res = await ai.applyAwaitedEdgesForSpawn("TEAM-4156", { kind: "ship_fix", shipTicketId: "TEAM-4126" });
        expect(res.written).toBe(1);
        expect(h._addBlockers.calls).toHaveLength(1);
        expect(h._addBlockers.calls[0].ticketId).toBe("TEAM-4126");
        expect(h._addBlockers.calls[0].ids).toEqual(["TEAM-4156"]);
        expect(h._addBlockers.calls[0].opts.preserveStatusIf).toEqual(["in_progress", "in_review"]);
        expect(h._annotateCalls).toHaveLength(1);
        expect(h._annotateCalls[0].originId).toBe("TEAM-4126");
        expect(h._annotateCalls[0].payload.source).toBe("derived");
        expect(h._annotateCalls[0].payload.awaitingIds).toEqual(["TEAM-4156"]);
        expect(h._annotateCalls[0].payload.reportedAt).toBe(new Date(NOW).toISOString());
        expect(m.written).toBe(1);
        expect(m.derived).toBe(1);
      });

      it("skips a terminal origin (done/cancelled) — no write", async () => {
        for (const status of ["done", "cancelled"]) {
          const h = makeDeps({ provider, mode: "enforce", tickets: { "TEAM-4126": { ticketId: "TEAM-4126", status } } });
          const ai = createAwaitedIds(h.deps);
          const res = await ai.applyAwaitedEdgesForSpawn("TEAM-4156", { kind: "ship_fix", shipTicketId: "TEAM-4126" });
          expect(res).toEqual({ skipped: "origin-terminal" });
          expect(h._addBlockers.calls).toHaveLength(0);
        }
      });

      it("skips a missing origin — no write", async () => {
        const h = makeDeps({ provider, mode: "enforce", tickets: {} });
        const ai = createAwaitedIds(h.deps);
        const res = await ai.applyAwaitedEdgesForSpawn("TEAM-4156", { kind: "ship_fix", shipTicketId: "TEAM-4126" });
        expect(res).toEqual({ skipped: "origin-missing" });
        expect(h._addBlockers.calls).toHaveLength(0);
      });

      it("second write of the same edge is present, not written (idempotent seam)", async () => {
        const addBlockers = makeAddBlockers();
        const h = makeDeps({ provider, mode: "enforce", addBlockers });
        const ai = createAwaitedIds(h.deps);
        const m = ai.newMetrics();
        await ai.applyAwaitedEdges("TEAM-4126", ["TEAM-4156"], "tool");
        expect(m.written).toBe(1);
        expect(m.present).toBe(0);
        await ai.applyAwaitedEdges("TEAM-4126", ["TEAM-4156"], "tool");
        expect(m.written).toBe(1);   // unchanged
        expect(m.present).toBe(1);   // the idempotent no-op
      });

      it("counts AwaitedEdgesFromTool vs AwaitedEdgesDerived by source", async () => {
        const h = makeDeps({ provider, mode: "enforce" });
        const ai = createAwaitedIds(h.deps);
        const m = ai.newMetrics();
        await ai.applyAwaitedEdges("TEAM-4126", ["TEAM-4156"], "tool");
        await ai.applyAwaitedEdges("TEAM-4126", ["TEAM-4157"], "spawnedBy");
        expect(m.fromTool).toBe(1);
        expect(m.derived).toBe(1);
      });

      it("dedupes, drops self-reference, and caps at 20 ids", async () => {
        const h = makeDeps({ provider, mode: "enforce" });
        const ai = createAwaitedIds(h.deps);
        ai.newMetrics();
        const dupes = ["TEAM-4156", "TEAM-4156", "TEAM-4126" /* self */, "not-an-id"];
        const res = await ai.applyAwaitedEdges("TEAM-4126", dupes, "tool");
        expect(res.ids).toEqual(["TEAM-4156"]);
        const many = Array.from({ length: 30 }, (_, i) => `TEAM-${5000 + i}`);
        const capped = await ai.applyAwaitedEdges("TEAM-4126", many, "tool");
        expect(capped.ids).toHaveLength(20);
      });
    });

    describe("checkAwaitTimeout (pure boundaries)", () => {
      const siblings = [{ ticketId: "TEAM-4156", status: "in_progress" }];
      const ticket = {
        ticketId: "TEAM-4126",
        blockedBy: ["TEAM-4156"],
        preconditionUnmet: { awaitingIds: ["TEAM-4156"], reportedAt: new Date(NOW).toISOString() },
      };

      it("null when nothing is awaited", () => {
        const { deps } = makeDeps({ provider, mode: "enforce" });
        const ai = createAwaitedIds(deps);
        expect(ai.checkAwaitTimeout({ ticketId: "T-1" }, [], NOW)).toBeNull();
      });

      it("null when all awaited ids are terminal", () => {
        const { deps } = makeDeps({ provider, mode: "enforce" });
        const ai = createAwaitedIds(deps);
        expect(ai.checkAwaitTimeout(ticket, [{ ticketId: "TEAM-4156", status: "done" }], NOW)).toBeNull();
      });

      it("timedOut flips exactly at timeoutMinutes*60000", () => {
        const { deps } = makeDeps({ provider, mode: "enforce", timeoutMinutes: 120 });
        const ai = createAwaitedIds(deps);
        const justUnder = ai.checkAwaitTimeout(ticket, siblings, NOW + 120 * 60000 - 1);
        expect(justUnder.timedOut).toBe(false);
        expect(justUnder.awaitingIds).toEqual(["TEAM-4156"]);
        const atBoundary = ai.checkAwaitTimeout(ticket, siblings, NOW + 120 * 60000);
        expect(atBoundary.timedOut).toBe(true);
        expect(atBoundary.waitedMs).toBe(120 * 60000);
      });
    });

    describe("emitAwaitTimeoutOnce", () => {
      it("emits at most once via the store CAS (true then false)", async () => {
        const h = makeDeps({ provider, mode: "enforce", casResults: [true, false] });
        const ai = createAwaitedIds(h.deps);
        const m = ai.newMetrics();
        const wf = { id: "wf_1" };
        const first = await ai.emitAwaitTimeoutOnce(wf, "TEAM-4126", ["TEAM-4156"], 99, "sweep");
        expect(first).toBe(true);
        expect(h._events).toHaveLength(1);
        expect(h._events[0].type).toBe("orchestrator.await_timeout");
        expect(h._events[0].detail).toMatchObject({ workflowId: "wf_1", ticketId: "TEAM-4126", awaitingIds: ["TEAM-4156"], waitedMs: 99, source: "sweep" });
        expect(m.timeouts).toBe(1);

        const second = await ai.emitAwaitTimeoutOnce(wf, "TEAM-4126", ["TEAM-4156"], 99, "sweep");
        expect(second).toBe(false);
        expect(h._events).toHaveLength(1); // no second event
        expect(m.timeouts).toBe(1);
      });

      it("shadow logs the decision but writes no store row and emits no event", async () => {
        const marked = [];
        const h = makeDeps({
          provider, mode: "shadow",
        });
        h.deps.store.markAwaitTimeoutEmitted = async (...a) => { marked.push(a); return true; };
        const ai = createAwaitedIds(h.deps);
        ai.newMetrics();
        const res = await ai.emitAwaitTimeoutOnce({ id: "wf_1" }, "TEAM-4126", ["TEAM-4156"], 99, "sweep");
        expect(res).toBe(false);
        expect(marked).toHaveLength(0);
        expect(h._events).toHaveLength(0);
      });
    });

    describe("emitAwaitedMetrics — EMF record with explicit zeros", () => {
      it("writes the AgentCoreHub/Orchestrator record with all five metrics + AwaitedMode", () => {
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          const { deps } = makeDeps({ provider, mode: "enforce" });
          const ai = createAwaitedIds(deps);
          ai.emitAwaitedMetrics(ai.newMetrics());
          const rec = JSON.parse(spy.mock.calls.at(-1)[0]);
          expect(rec._aws.CloudWatchMetrics[0].Namespace).toBe("AgentCoreHub/Orchestrator");
          const names = rec._aws.CloudWatchMetrics[0].Metrics.map((x) => x.Name);
          expect(names).toEqual([
            "AwaitedEdgesDerived", "AwaitedEdgesFromTool", "AwaitedEdgesWritten",
            "AwaitedEdgesPresent", "AwaitTimeouts",
          ]);
          for (const k of ["AwaitedEdgesDerived", "AwaitedEdgesFromTool", "AwaitedEdgesWritten", "AwaitedEdgesPresent", "AwaitTimeouts"]) {
            expect(rec[k]).toBe(0);
          }
          expect(rec.AwaitedMode).toBe("enforce");
        } finally {
          spy.mockRestore();
        }
      });
    });
  });
}
