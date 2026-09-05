import { describe, it, expect } from "vitest";
import { createReworkLoopCap, lineageKey, effectiveReworkRounds } from "./rework-loop-cap.mjs";

/**
 * TEAM-4113 replay — the failure mode the lineage cap exists for. A QA→dev loop
 * that never converges files a FRESH qa_fix ticket each round (a new ticket id
 * every time, because the bug-fix reopen path spawns a new ticket rather than
 * re-rejecting one gate). The per-gate review-cap keys by ticket id, so every
 * round lands in its own ledger with count 1 and the cap NEVER trips — the run
 * spins for hours. This asserts the lineage cap (keyed by workflow+phase)
 * catches it at exactly `maxRounds`, and fires cap_reached ONCE.
 */

function makeStore() {
  const ledgers = {};
  const seed = (k) => (ledgers[k] ||= { rounds: [], authorizations: [], escalations: [] });
  return {
    ledgers,
    async appendReworkRound(_wf, k, r) { seed(k).rounds.push(r); return JSON.parse(JSON.stringify(ledgers[k])); },
    async appendReworkEscalation(_wf, k, e) { seed(k).escalations.push(e); },
    async appendReworkAuthorization(_wf, k, a) { seed(k).authorizations.push(a); },
  };
}

// Nine distinct fix ticket ids in ONE phase — the real oyg9t1-class runaway.
const LOOP = Array.from({ length: 9 }, (_, i) => ({
  ticketId: `TEAM-90${i}`,
  assignee: "agentcore_hub_qa_verifier",
  phase: "verification",
  spawnedBy: { kind: "qa_fix", gateTicketId: `GATE-${i}` }, // a NEW gate id each round
}));

describe("runaway loop that hops ticket ids", () => {
  it("lineage cap trips at maxRounds and signals exactly once", async () => {
    const store = makeStore();
    const events = [];
    const cap = createReworkLoopCap({
      store,
      publishEvent: async (tid, name, detail) => events.push({ tid, name, detail }),
      emitMetrics: () => {},
      mode: "enforce",
      maxRounds: 4,
      now: () => new Date("2026-09-05T00:00:00Z"),
    });
    const workflow = { id: "wf_run", epicId: "TEAM-1", reworkLineage: store.ledgers };

    const actions = [];
    for (const t of LOOP) actions.push((await cap.observe({ workflow, ticket: t, phase: t.phase })).action);

    // rounds 1..3 recorded, round 4 caps, rounds 5..9 already-escalated.
    expect(actions.slice(0, 3)).toEqual(["recorded", "recorded", "recorded"]);
    expect(actions[3]).toBe("capped");
    expect(actions.slice(4)).toEqual(Array(5).fill("still-escalated"));

    const caps = events.filter((e) => e.name === "rework.cap_reached");
    expect(caps).toHaveLength(1);
    expect(caps[0].detail.rounds).toBe(4);
    expect(caps[0].detail.lineageKey).toBe("wf_run:verification");

    // All 9 distinct fix tickets accumulated under the single lineage key.
    expect(effectiveReworkRounds(store.ledgers["wf_run:verification"])).toBe(9);
  });

  it("a per-GATE-id ledger (what the review-cap keys on) never reaches the cap", () => {
    // Model the review-cap's keying: one ledger per gate ticket id. Because
    // every round carries a distinct gateTicketId, each holds exactly one round.
    const perGate = {};
    for (const t of LOOP) {
      const k = t.spawnedBy.gateTicketId;
      (perGate[k] ||= { rounds: [] }).rounds.push({ ticketId: t.ticketId });
    }
    const maxPerGate = Math.max(...Object.values(perGate).map((l) => effectiveReworkRounds(l)));
    expect(maxPerGate).toBe(1); // never >= 4 → the review-cap is blind to this loop
    expect(Object.keys(perGate)).toHaveLength(9);
  });
});

describe("lineageKey", () => {
  it("keys strictly by workflow + phase", () => {
    expect(lineageKey("wf_a", "development")).toBe("wf_a:development");
    expect(lineageKey("wf_a", "development")).not.toBe(lineageKey("wf_a", "verification"));
  });
});
