/**
 * TEAM-4120 FR-2 — deterministic event ids (event-id.mjs).
 *
 * event-id.mjs is pure (node:crypto only), so everything here is direct: no
 * AWS seams, no module reloading. What matters and is easy to get subtly wrong:
 *   - determinism (two writers computing the same id from the same content),
 *   - the id SHAPE (a 13-digit decimal ms prefix keeps these ids in the same
 *     lexicographic ordering class as the pre-4120 direct-write ids, which the
 *     anomaly-watcher's `eventId > :cursor` range query depends on),
 *   - byte-for-byte agreement with the CONSUMER-side content key that
 *     lambda/cost-report/index.mjs dedupeEvents already uses — a producer-side
 *     collapse that disagreed with the consumer-side collapse would be worse
 *     than no collapse at all,
 *   - nullish normalization (ticketId:null must hash like a missing ticketId,
 *     or the two copies of ONE event could pick different ids),
 *   - the fail-safe directions: mode normalization is a strict allow-list, and
 *     agent.streaming / an unparseable timestamp fall back to random ids.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";

import {
  contentKey,
  deterministicEventId,
  eventIdFor,
  normalizeEventDedupeMode,
  RANDOM_ID_TYPES,
  stableJson,
} from "./event-id.mjs";

const ID_RE = /^\d{13}-[0-9a-f]{8}$/;
// The legacy shapes: publishEvent's 4-char suffix and publishAgentEvent's 6-char.
const LEGACY_RE = /^\d{13}-[0-9a-z]{2,6}$/;

/** A representative orchestrator event: the ticketId branch of the content key. */
const TICKET_DETAIL = {
  ticketId: "TEAM-4120",
  assignee: "agentcore_hub_api_dev",
  agentId: "agentcore_hub_api_dev",
  workflowId: "wf_1788637257831_f50ucz",
  timestamp: "2026-09-05T12:00:00.000Z",
};

/** No ticketId → the stableJson branch. */
const PHASE_DETAIL = {
  phase: "development",
  workflowId: "wf_1788637257831_f50ucz",
  timestamp: "2026-09-05T12:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deterministicEventId — determinism and shape", () => {
  it("is a pure function of (type, detail): the same input twice gives the same id", () => {
    const a = deterministicEventId("agent.complete", TICKET_DETAIL);
    const b = deterministicEventId("agent.complete", { ...TICKET_DETAIL });
    expect(a).toBe(b);
    // Key order in `detail` must not matter either — the EventBridge round-trip
    // reshuffles it (JSON.stringify → JSON.parse), and the two writers must
    // still agree. (Here it only matters on the stableJson branch, but the
    // ticketId branch reads named fields, so both are order-independent.)
    const shuffled = { timestamp: PHASE_DETAIL.timestamp, workflowId: PHASE_DETAIL.workflowId, phase: PHASE_DETAIL.phase };
    expect(deterministicEventId("workflow.phase_change", shuffled))
      .toBe(deterministicEventId("workflow.phase_change", PHASE_DETAIL));
  });

  it("has the form <13-digit ms>-<8 hex> and its prefix is Date.parse(detail.timestamp)", () => {
    const id = deterministicEventId("agent.complete", TICKET_DETAIL);
    expect(id).toMatch(ID_RE);
    const [ms, hash] = id.split("-");
    expect(Number(ms)).toBe(Date.parse(TICKET_DETAIL.timestamp));
    expect(ms).toHaveLength(13);
    expect(hash).toBe(
      createHash("sha1").update(contentKey("agent.complete", TICKET_DETAIL)).digest("hex").slice(0, 8),
    );
  });

  it("keeps the pre-4120 ordering class: a later event's id sorts after an earlier one as a STRING", () => {
    // This is what the anomaly-watcher's `eventId > :cursor` KeyCondition relies
    // on. Both prefixes are 13-digit decimal ms, so string compare == time order.
    const early = deterministicEventId("agent.started", { ...TICKET_DETAIL, timestamp: "2026-09-05T12:00:00.000Z" });
    const late = deterministicEventId("agent.complete", { ...TICKET_DETAIL, timestamp: "2026-09-05T12:00:05.000Z" });
    expect(early < late).toBe(true);
    // …and against a legacy direct-write id from the same instant.
    const legacy = `${Date.parse("2026-09-05T12:00:03.000Z")}-ab12`;
    expect(early < legacy).toBe(true);
    expect(legacy < late).toBe(true);
  });

  it("distinguishes events that differ only in type, ticket, or agent", () => {
    const base = deterministicEventId("agent.complete", TICKET_DETAIL);
    expect(deterministicEventId("agent.started", TICKET_DETAIL)).not.toBe(base);
    expect(deterministicEventId("agent.complete", { ...TICKET_DETAIL, ticketId: "TEAM-4121" })).not.toBe(base);
    expect(deterministicEventId("agent.complete", { ...TICKET_DETAIL, agentId: "agentcore_hub_qa" })).not.toBe(base);
    // Same second, different millisecond → different id (detail.timestamp is
    // ms-precision, unlike EventBridge's second-granularity event.time).
    expect(deterministicEventId("agent.complete", { ...TICKET_DETAIL, timestamp: "2026-09-05T12:00:00.001Z" }))
      .not.toBe(base);
  });
});

describe("contentKey — byte-for-byte agreement with the consumer-side dedupe key", () => {
  // The literals below are the strings lambda/cost-report/index.mjs dedupeEvents
  // builds for these same rows (`${e.type}|${ts}|${tid}|${agentId||assignee}`,
  // else `${e.type}|${ts}|${stableJson(d)}`). cost-report does NOT export its
  // key builder — only dedupeEvents — so these are pinned as literals. Both
  // branches are covered; if either side's formula ever changes, one of these
  // fails instead of the collapse silently disagreeing with the dedupe.
  it("ticketId branch: type|detail.timestamp|ticketId|agentId", () => {
    expect(contentKey("agent.complete", TICKET_DETAIL)).toBe(
      "agent.complete|2026-09-05T12:00:00.000Z|TEAM-4120|agentcore_hub_api_dev",
    );
  });

  it("ticketId branch falls back agentId → assignee", () => {
    const { agentId, ...noAgentId } = TICKET_DETAIL;
    expect(contentKey("agent.started", noAgentId)).toBe(
      "agent.started|2026-09-05T12:00:00.000Z|TEAM-4120|agentcore_hub_api_dev",
    );
    const { assignee, ...neither } = noAgentId;
    expect(contentKey("agent.started", neither)).toBe("agent.started|2026-09-05T12:00:00.000Z|TEAM-4120|");
  });

  it("nested ticket.id is accepted as the ticket identity, like cost-report", () => {
    expect(contentKey("review.needed", { ticket: { id: "TEAM-9" }, timestamp: "2026-09-05T12:00:00.000Z" }))
      .toBe("review.needed|2026-09-05T12:00:00.000Z|TEAM-9|");
  });

  it("no-ticket branch: type|detail.timestamp|stableJson(detail), keys sorted", () => {
    expect(contentKey("workflow.phase_change", PHASE_DETAIL)).toBe(
      'workflow.phase_change|2026-09-05T12:00:00.000Z|{"phase":"development","timestamp":"2026-09-05T12:00:00.000Z","workflowId":"wf_1788637257831_f50ucz"}',
    );
  });

  it("nullish fields normalize to \"\": ticketId:null hashes identically to a missing ticketId", () => {
    const withNull = { ...PHASE_DETAIL, ticketId: null };
    // Both take the no-ticket branch. stableJson still SEES the null key, so the
    // ids differ only because the detail genuinely differs — what must never
    // happen is one copy taking the ticketId branch and the other not.
    expect(contentKey("workflow.phase_change", withNull).startsWith("workflow.phase_change|2026-09-05T12:00:00.000Z|{"))
      .toBe(true);
    // The identity that actually matters: the SAME detail object, one copy
    // reshaped by an EventBridge JSON round-trip, yields the same id.
    const roundTripped = JSON.parse(JSON.stringify(withNull));
    expect(deterministicEventId("workflow.phase_change", roundTripped))
      .toBe(deterministicEventId("workflow.phase_change", withNull));
    // And on the ticketId branch, an explicit-null agentId hashes like a missing
    // one (`d.agentId || d.assignee || ""`).
    expect(contentKey("agent.complete", { ticketId: "TEAM-1", agentId: null, timestamp: "T" }))
      .toBe(contentKey("agent.complete", { ticketId: "TEAM-1", timestamp: "T" }));
  });

  it("a missing detail.timestamp contributes \"\" rather than throwing", () => {
    expect(contentKey("agent.complete", { ticketId: "TEAM-1" })).toBe("agent.complete||TEAM-1|");
    expect(contentKey("agent.complete", null)).toBe('agent.complete||{}');
    expect(contentKey("agent.complete", undefined)).toBe('agent.complete||{}');
  });
});

/**
 * The literals above pin the FORMULA; this pins the BEHAVIOUR against the real
 * consumer. cost-report/index.mjs does not export its key builder (only
 * dedupeEvents), so parity is asserted the only way it's observable from
 * outside: two rows that our deterministic id collapses onto one key must be
 * exactly the pair dedupeEvents collapses, and two rows it keeps distinct must
 * survive as two. cost-report constructs AWS clients at module load, but
 * constructors do no I/O, so a plain import is safe here.
 */
describe("parity with lambda/cost-report dedupeEvents (the live consumer-side dedupe)", () => {
  const row = (eventId, type, detail) => ({ workflowId: "wf_1", eventId, type, detail, timestamp: detail.timestamp });

  it("collapses exactly the rows dedupeEvents collapses — the current double-write pair", async () => {
    const { dedupeEvents } = await import("../cost-report/index.mjs");
    // The two copies of ONE event as the table holds them today: same content,
    // different eventIds, and the EventBridge copy's detail key order reshuffled
    // by the JSON round-trip.
    const direct = row("1757040000000-ab12", "agent.complete", TICKET_DETAIL);
    const viaBus = row("0lq7k2x00-0001", "agent.complete", JSON.parse(JSON.stringify(TICKET_DETAIL)));

    expect(dedupeEvents([direct, viaBus])).toHaveLength(1);
    // …and our producer-side id agrees: one key, so the second Put overwrites.
    expect(deterministicEventId(direct.type, direct.detail))
      .toBe(deterministicEventId(viaBus.type, viaBus.detail));
  });

  it("keeps distinct exactly the rows dedupeEvents keeps distinct", async () => {
    const { dedupeEvents } = await import("../cost-report/index.mjs");
    const a = row("1757040000000-ab12", "agent.complete", TICKET_DETAIL);
    const b = row("1757040000001-cd34", "agent.started", TICKET_DETAIL);
    const c = row("1757040000002-ef56", "agent.complete", { ...TICKET_DETAIL, ticketId: "TEAM-4121" });
    const d = row("1757040000003-0789", "workflow.phase_change", PHASE_DETAIL);

    expect(dedupeEvents([a, b, c, d])).toHaveLength(4);
    expect(new Set([a, b, c, d].map((r) => deterministicEventId(r.type, r.detail))).size).toBe(4);
  });

  it("agent.streaming is skipped by dedupeEvents and exempt from our collapse — the same carve-out", async () => {
    const { dedupeEvents } = await import("../cost-report/index.mjs");
    const chunk = (eventId, text) => row(eventId, "agent.streaming", { ...TICKET_DETAIL, chunk: text });

    // dedupeEvents drops streaming rows entirely rather than deduping them…
    expect(dedupeEvents([chunk("a-1", "one"), chunk("b-2", "two")])).toHaveLength(0);
    // …and we never collapse them, so no heartbeat is lost from the table.
    expect(RANDOM_ID_TYPES.has("agent.streaming")).toBe(true);
  });
});

describe("stableJson — same semantics as the cost-report original", () => {
  it("sorts object keys recursively and renders primitives/null/arrays like JSON.stringify", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))
      .toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
    expect(stableJson(null)).toBe("null");
    expect(stableJson(undefined)).toBe("null");
    expect(stableJson("x")).toBe('"x"');
    expect(stableJson(7)).toBe("7");
    expect(stableJson([1, "a"])).toBe('[1,"a"]');
  });
});

describe("deterministicEventId — unparseable timestamp falls back to a random id", () => {
  it.each([
    ["missing", {}],
    ["null", { timestamp: null }],
    ["garbage", { timestamp: "not-a-date" }],
    ["no detail at all", undefined],
  ])("%s detail.timestamp → legacy random shape + a console.warn", (_label, detail) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = deterministicEventId("agent.complete", detail);
    expect(id).toMatch(LEGACY_RE);
    expect(id).not.toMatch(ID_RE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("[event-id] agent.complete");
    expect(warn.mock.calls[0][0]).toContain("detail.timestamp missing/invalid");
  });
});

describe("normalizeEventDedupeMode — strict allow-list, everything else is off", () => {
  it.each(["enforce", "ENFORCE", "  Enforce ", "eNfOrCe"])("%j → enforce", (v) => {
    expect(normalizeEventDedupeMode(v)).toBe("enforce");
  });

  it.each([
    // "shadow" is deliberately NOT a mode here: there is nothing to observe
    // without changing the write, so a shadow request must not turn it on.
    "shadow",
    // Legacy truthy spellings other flags accept are off for this one — a typo
    // must never change what lands in the events table.
    "on", "true", "1", "yes",
    "off", "OFF", "", "   ", "garbage",
  ])("%j → off", (v) => {
    expect(normalizeEventDedupeMode(v)).toBe("off");
  });

  it.each([[undefined], [null], [0], [{}]])("%j (non-string) → off", (v) => {
    expect(normalizeEventDedupeMode(v)).toBe("off");
  });
});

describe("eventIdFor — the single call site the three writers share", () => {
  const legacy = () => "LEGACY-ID";

  it("off delegates to the caller's legacy generator, untouched (byte-identical path)", () => {
    expect(eventIdFor("off", "agent.complete", TICKET_DETAIL, legacy)).toBe("LEGACY-ID");
  });

  it("an unnormalized/garbage mode also delegates (fail-safe: only exact \"enforce\" enforces)", () => {
    for (const mode of ["shadow", "ENFORCE", undefined, ""]) {
      expect(eventIdFor(mode, "agent.complete", TICKET_DETAIL, legacy)).toBe("LEGACY-ID");
    }
  });

  it("enforce returns the deterministic id", () => {
    expect(eventIdFor("enforce", "agent.complete", TICKET_DETAIL, legacy))
      .toBe(deterministicEventId("agent.complete", TICKET_DETAIL));
  });

  it("agent.streaming keeps random ids even under enforce (collapsing them would drop heartbeats)", () => {
    expect(RANDOM_ID_TYPES.has("agent.streaming")).toBe(true);
    expect(eventIdFor("enforce", "agent.streaming", { ...TICKET_DETAIL, chunk: "…" }, legacy)).toBe("LEGACY-ID");
    // Nothing else is exempt.
    expect(RANDOM_ID_TYPES.size).toBe(1);
  });

  it("calls the legacy generator exactly once, and only on the legacy path", () => {
    const spy = vi.fn(() => "L");
    eventIdFor("off", "agent.complete", TICKET_DETAIL, spy);
    expect(spy).toHaveBeenCalledTimes(1);
    eventIdFor("enforce", "agent.complete", TICKET_DETAIL, spy);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
