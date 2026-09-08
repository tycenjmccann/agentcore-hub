import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCascade } from "./cascade.mjs";
import { resolveGateReverifyCap, REVIEW_GATE_MAX_ROUNDS_CEILING } from "./review-cap.mjs";

/**
 * TEAM-4264 F4 — the gate re-verify cap.
 *
 * Every non-PASS verdict the cascade observes files a re-verify ticket, and until
 * this landed nothing compared that round number to a maximum. The one cap that
 * could have caught it opts out on purpose: rework-loop-cap.mjs `isReworkFix`
 * excludes the reverify/rearmOf lineage, and the per-gate review cap counts HUMAN
 * rejections. So a gate persona that keeps restating BLOCKED filed round 2, 3,
 * 4 … forever, each one a dispatch and a model call.
 *
 * The property these pin, and the reason this is not just a counter: reaching the
 * cap is NOT a release. The successors stay held on something durable and a human
 * is paged through the SAME escalation pair rework-loop-cap.mjs uses. A cap that
 * failed open at the ceiling would re-open the exact hole F1 closed.
 */

const NOW = Date.parse("2026-09-01T12:00:00Z");
const PERSONA = "agentcore_hub_code_reviewer";
const GATE = "TEAM-4180"; // the lineage root
const SUCC = "TEAM-4181"; // the QA successor waiting on it
const FIX = "TEAM-4183";
const RV_NEW = "TEAM-4999"; // the re-verify a below-cap round files
const HEAD = "933ea6f1c2b3a4d5e6f70819202a3b4c5d6e7f80";
const workflow = { id: "wf_1", workflowId: "wf_1" };

/**
 * `priorRounds` re-verify tickets, chained: `spawnedBy.rearmOf` points at the
 * ticket that was RE-ARMED, which for round 3 is round 2's ticket, not the root
 * (live-reverify.mjs files against whatever just completed). The chain shape is
 * the whole reason the cap counts a lineage walk rather than direct children.
 */
function chain(priorRounds) {
  const rows = [];
  let parent = GATE;
  for (let round = 2; round <= priorRounds + 1; round++) {
    const ticketId = `TEAM-43${round}0`;
    rows.push({
      ticketId, status: "done", assignee: PERSONA,
      spawnedBy: { kind: "review_fix", reverify: true, rearmOf: parent, round },
      completedAt: `2026-09-0${Math.min(9, round)}T10:00:00Z`,
    });
    parent = ticketId;
  }
  return rows;
}

/** The board at `priorRounds`, plus the id of the ticket that just completed. */
function board(priorRounds, over = {}) {
  const rv = chain(priorRounds);
  if (over.openLatest && rv.length) rv[rv.length - 1].status = "in_progress";
  const head = rv.length ? rv[rv.length - 1].ticketId : GATE;
  return {
    head,
    latestReverify: rv.length ? rv[rv.length - 1].ticketId : null,
    rows: [
      { ticketId: GATE, status: "done", assignee: PERSONA, completedAt: "2026-09-01T09:00:00Z" },
      ...rv,
      { ticketId: SUCC, status: "blocked", blockedBy: [head], ...over.succ },
      ...(over.extra || []),
    ],
  };
}

function harness({ mode = "enforce", priorRounds = 0, gate = {}, reviewGate, over = {}, store, parkRunEscalationGate, openLatest = false,
  reverifyResult = { action: "created", reverifyTicketId: RV_NEW, sha7: HEAD.slice(0, 7) } } = {}) {
  const b = board(priorRounds, { ...over, openLatest });
  const publishEvent = vi.fn(async () => {});
  const addBlockers = vi.fn(async (_id, ids) => ids);
  const reverify = vi.fn(async () => reverifyResult);
  const verdictGate = vi.fn(async () => ({
    isGatePersona: true, verdict: "BLOCKED", verdictSource: "declared",
    testedHead: HEAD, spawnedTickets: [FIX], ...gate,
  }));
  const appendReworkEscalation = vi.fn(async () => ({}));
  const park = parkRunEscalationGate || vi.fn(async () => true);
  const deps = {
    ddb: { send: vi.fn(async () => ({})) },
    ticketsTable: "tickets",
    provider: "dynamodb",
    jiraTransition: vi.fn(async () => {}),
    getChildTickets: vi.fn(async () => b.rows),
    publishEvent,
    now: () => NOW,
    log: () => {},
    sleep: vi.fn(async () => {}),
    verdictGate,
    verdictGateMode: mode,
    reverify,
    addBlockers,
    store: store === null ? undefined : { appendReworkEscalation, ...store },
    parkRunEscalationGate: park,
    ...(reviewGate === undefined ? {} : { reviewGateFor: () => reviewGate }),
  };
  const { cascadeUnblock } = createCascade(deps);
  return { ...b, cascadeUnblock, deps, publishEvent, addBlockers, reverify, verdictGate, appendReworkEscalation, park };
}

const eventsOfType = (fn, type) => fn.mock.calls.filter((c) => c[1] === type);
const capEvents = (fn) => eventsOfType(fn, "orchestrator.gate_reverify_cap_reached").map((c) => c[2]);

beforeEach(() => vi.clearAllMocks());

describe("the cap number is the gate's own maxRounds (TEAM-4264 F4)", () => {
  it("defaults to 3 — the review cap's default, one number per gate", () => {
    expect(resolveGateReverifyCap(undefined).maxRounds).toBe(3);
    expect(resolveGateReverifyCap({}).maxRounds).toBe(3);
  });

  it("reads reviewGates[].maxRounds", () => {
    expect(resolveGateReverifyCap({ maxRounds: 5 }).maxRounds).toBe(5);
  });

  it("clamps at the ceiling rather than honouring an unbounded config", () => {
    expect(resolveGateReverifyCap({ maxRounds: 1e9 }).maxRounds).toBe(REVIEW_GATE_MAX_ROUNDS_CEILING);
  });

  it.each([0, -1, NaN, "3", null])("rejects %p and falls back to the default", (maxRounds) => {
    expect(resolveGateReverifyCap({ maxRounds }).maxRounds).toBe(3);
  });
});

describe("rounds below the cap file a re-verify, exactly as before", () => {
  it.each([
    [0, 1],
    [1, 2],
    [2, 3],
  ])("%i prior rounds → files round %i", async (priorRounds, round) => {
    const h = harness({ priorRounds });

    expect(await h.cascadeUnblock(h.head, "EPIC-1", workflow)).toEqual([]);
    expect(h.reverify).toHaveBeenCalledTimes(1);
    expect(h.reverify.mock.calls[0][0].round).toBe(round);
    expect(capEvents(h.publishEvent)).toHaveLength(0);
    expect(h.appendReworkEscalation).not.toHaveBeenCalled();
    expect(h.park).not.toHaveBeenCalled();
  });

  it("counts the whole CHAIN, not the completing ticket's direct children", async () => {
    // Round 3's ticket hangs off round 2's, so a direct-children count reported
    // "1 prior round" forever and every re-verify after the first was mislabelled.
    const h = harness({ priorRounds: 2 });

    await h.cascadeUnblock(h.head, "EPIC-1", workflow);

    expect(h.reverify.mock.calls[0][0].round).toBe(3);
  });
});

describe("at the cap, nothing is filed and a human is paged", () => {
  it("files NO re-verify and publishes gate_reverify_cap_reached", async () => {
    const h = harness({ priorRounds: 3 });

    // Nothing unblocked, nothing filed: the round the persona would have burned.
    expect(await h.cascadeUnblock(h.head, "EPIC-1", workflow)).toEqual([]);
    expect(h.reverify).not.toHaveBeenCalled();
    const [detail] = capEvents(h.publishEvent);
    expect(detail).toEqual({
      workflowId: "wf_1",
      gateTicketId: h.head,
      persona: PERSONA,
      verdict: "BLOCKED",
      round: 4,
      maxRounds: 3,
      heldSuccessors: [SUCC],
      heldOn: [FIX],
    });
  });

  it("the successor is still DURABLY blocked — the cap must not fail open", async () => {
    const h = harness({ priorRounds: 3 });

    await h.cascadeUnblock(h.head, "EPIC-1", workflow);

    expect(h.addBlockers).toHaveBeenCalledTimes(1);
    expect(h.addBlockers.mock.calls[0][0]).toBe(SUCC);
    expect(h.addBlockers.mock.calls[0][1]).toEqual([FIX]);
    // No transition, no unblock journal: the three effects the hold suppresses.
    expect(eventsOfType(h.publishEvent, "orchestrator.unblocked")).toHaveLength(0);
  });

  it("escalates through the SAME pair rework-loop-cap.mjs uses", async () => {
    const h = harness({ priorRounds: 3 });

    await h.cascadeUnblock(h.head, "EPIC-1", workflow);

    expect(h.appendReworkEscalation).toHaveBeenCalledTimes(1);
    const [wfId, key, entry] = h.appendReworkEscalation.mock.calls[0];
    expect(wfId).toBe("wf_1");
    // Namespaced by the lineage ROOT so a redelivery of any round hits one key,
    // and out of every `<workflowId>:<phase>` bucket the rework cap counts.
    expect(key).toBe(`wf_1:gate-reverify:${GATE}`);
    expect(entry).toMatchObject({ escalatedAtRound: 4, decision: null });
    expect(h.park).toHaveBeenCalledWith(workflow, "gate-reverify");
  });

  it("does not re-page while the escalation is still open (idempotent)", async () => {
    const wf = { ...workflow, reworkLineage: { [`wf_1:gate-reverify:${GATE}`]: { escalations: [{ escalatedAtRound: 4, decision: null }] } } };
    const h = harness({ priorRounds: 3 });

    await h.cascadeUnblock(h.head, "EPIC-1", wf);

    expect(h.reverify).not.toHaveBeenCalled();
    expect(h.appendReworkEscalation).not.toHaveBeenCalled();
    expect(capEvents(h.publishEvent)).toHaveLength(0);
    expect(h.park).not.toHaveBeenCalled();
    // Still held: losing the page must never lose the hold.
    expect(h.addBlockers.mock.calls[0][1]).toEqual([FIX]);
  });

  it("a lower configured maxRounds trips sooner", async () => {
    const h = harness({ priorRounds: 1, reviewGate: { maxRounds: 1 } });

    await h.cascadeUnblock(h.head, "EPIC-1", workflow);

    expect(h.reverify).not.toHaveBeenCalled();
    expect(capEvents(h.publishEvent)[0]).toMatchObject({ round: 2, maxRounds: 1 });
  });

  it("a higher one keeps filing past the default", async () => {
    const h = harness({ priorRounds: 3, reviewGate: { maxRounds: 6 } });

    await h.cascadeUnblock(h.head, "EPIC-1", workflow);

    expect(h.reverify).toHaveBeenCalledTimes(1);
    expect(capEvents(h.publishEvent)).toHaveLength(0);
  });

  it("an UNKNOWN verdict reports null on the wire, like every other D1 event", async () => {
    const h = harness({ priorRounds: 3, gate: { verdict: null, verdictSource: null } });

    await h.cascadeUnblock(h.head, "EPIC-1", workflow);

    expect(capEvents(h.publishEvent)[0]).toMatchObject({ verdict: null, round: 4 });
  });

  it("a ledger write that throws still holds, still publishes, still parks", async () => {
    const h = harness({
      priorRounds: 3,
      store: { appendReworkEscalation: vi.fn(async () => { throw new Error("DDB 500"); }) },
    });

    await h.cascadeUnblock(h.head, "EPIC-1", workflow);

    expect(capEvents(h.publishEvent)).toHaveLength(1);
    expect(h.park).toHaveBeenCalledTimes(1);
    expect(h.addBlockers.mock.calls[0][1]).toEqual([FIX]);
  });

  it("a park that throws is non-fatal — the hold is the safety property", async () => {
    const h = harness({ priorRounds: 3, parkRunEscalationGate: vi.fn(async () => { throw new Error("no gate"); }) });

    expect(await h.cascadeUnblock(h.head, "EPIC-1", workflow)).toEqual([]);
    expect(h.addBlockers.mock.calls[0][1]).toEqual([FIX]);
  });
});

describe("what the successors are held ON at the cap", () => {
  it("the open fixes, when the gate filed any", async () => {
    const h = harness({ priorRounds: 3 });

    expect(await h.cascadeUnblock(h.head, "EPIC-1", workflow)).toEqual([]);
    expect(h.addBlockers.mock.calls.map((c) => [c[0], c[1]])).toEqual([[SUCC, [FIX]]]);
  });

  it("an OPEN re-verify round when there are no fixes", async () => {
    // The root re-completing (a redelivered Done) while its last re-verify is
    // still open: that ticket is a real barrier, so the edge is worth writing.
    const h = harness({
      priorRounds: 3,
      gate: { spawnedTickets: [], openEpicFixIds: [] },
      over: { succ: { blockedBy: [GATE] } },
      openLatest: true, // the last round is still in flight
    });

    expect(await h.cascadeUnblock(GATE, "EPIC-1", workflow)).toEqual([]);
    expect(h.addBlockers.mock.calls[0][1]).toEqual([h.latestReverify]);
    expect(capEvents(h.publishEvent)[0]).toMatchObject({ heldOn: [h.latestReverify] });
  });

  it("NOTHING, honestly, when every round is closed and no fix is open", async () => {
    // The usual road to the cap: all three rounds are Done (that is how they got
    // spent) and the persona filed no fixes. An edge to a DONE ticket satisfies
    // allBlockersResolved, so writing one would look like a hold and be none —
    // the event says `heldOn: []` and the hold rests on belt 2 (the reconcile
    // sweep re-reads the still-non-PASS lineage verdict) plus this escalation.
    const h = harness({ priorRounds: 3, gate: { spawnedTickets: [], openEpicFixIds: [] } });

    expect(await h.cascadeUnblock(h.head, "EPIC-1", workflow)).toEqual([]);
    expect(h.addBlockers).not.toHaveBeenCalled();
    expect(eventsOfType(h.publishEvent, "orchestrator.unblocked")).toHaveLength(0);
    expect(capEvents(h.publishEvent)[0]).toMatchObject({ heldOn: [], heldSuccessors: [SUCC] });
    expect(h.park).toHaveBeenCalledTimes(1);
  });

  it("round 1 is never capped, and an unfilable re-verify holds in memory only", async () => {
    // maxRounds 1 with ZERO prior rounds is BELOW the cap (the cap counts rounds
    // already spent), so this files — and when the filing fails and the gate
    // spawned no fixes there is no edge to write at all. Nothing is unblocked.
    const h = harness({
      priorRounds: 0,
      reviewGate: { maxRounds: 1 },
      gate: { spawnedTickets: [], openEpicFixIds: [] },
      reverifyResult: { action: "failed" },
    });

    expect(await h.cascadeUnblock(GATE, "EPIC-1", workflow)).toEqual([]);
    expect(h.reverify).toHaveBeenCalledTimes(1);
    expect(h.addBlockers).not.toHaveBeenCalled();
    expect(eventsOfType(h.publishEvent, "orchestrator.unblocked")).toHaveLength(0);
    expect(capEvents(h.publishEvent)).toHaveLength(0);
  });

  it("the NEXT round on that same board caps", async () => {
    const h = harness({ priorRounds: 1, reviewGate: { maxRounds: 1 }, gate: { spawnedTickets: [], openEpicFixIds: [] } });

    expect(await h.cascadeUnblock(h.head, "EPIC-1", workflow)).toEqual([]);
    expect(h.reverify).not.toHaveBeenCalled();
    expect(capEvents(h.publishEvent)[0]).toMatchObject({ round: 2, maxRounds: 1 });
    expect(h.park).toHaveBeenCalledTimes(1);
  });

  it("an unwired store does not stop the page or the hold", async () => {
    const h = harness({ priorRounds: 3, store: null });

    await h.cascadeUnblock(h.head, "EPIC-1", workflow);

    expect(capEvents(h.publishEvent)).toHaveLength(1);
    expect(h.addBlockers.mock.calls[0][1]).toEqual([FIX]);
  });
});

describe("off and shadow never reach the cap path", () => {
  it("off cascades the successor and asks nothing", async () => {
    const h = harness({ mode: "off", priorRounds: 3 });

    expect(await h.cascadeUnblock(h.head, "EPIC-1", workflow)).toEqual([SUCC]);
    expect(h.verdictGate).not.toHaveBeenCalled();
    expect(capEvents(h.publishEvent)).toHaveLength(0);
  });

  it("shadow observes only — no cap event, no ledger, no park, no edge", async () => {
    const h = harness({ mode: "shadow", priorRounds: 3 });

    expect(await h.cascadeUnblock(h.head, "EPIC-1", workflow)).toEqual([SUCC]);
    expect(capEvents(h.publishEvent)).toHaveLength(0);
    expect(h.appendReworkEscalation).not.toHaveBeenCalled();
    expect(h.park).not.toHaveBeenCalled();
    expect(h.addBlockers).not.toHaveBeenCalled();
    expect(h.reverify).not.toHaveBeenCalled();
    expect(eventsOfType(h.publishEvent, "orchestrator.verdict_observed")).toHaveLength(1);
  });
});
