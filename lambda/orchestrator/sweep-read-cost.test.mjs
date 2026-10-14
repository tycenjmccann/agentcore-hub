import { describe, it, expect, vi, afterEach } from "vitest";
import { createDetector } from "./dead-session-detector.mjs";
import * as lease from "./lease.mjs";

/**
 * TEAM-6021 — what one dead-session sweep READS from the events table, per
 * live lease. The real detector runs against the real lease.mjs; only the
 * DocumentClient is faked, and the fake is a COUNTING one that behaves like
 * DynamoDB where cost is decided:
 *   - the key condition selects the rows a Query can reach (bare partition,
 *     `eventId >= :lo`, `eventId BETWEEN :lo AND :hi`), in eventId order,
 *     reversed for ScanIndexForward:false;
 *   - Limit is applied BEFORE the FilterExpression, so every row in a page is
 *     read (and billed) even when the filter drops it; LastEvaluatedKey pages;
 *   - each FilterExpression is mirrored in JS so outcomes are the production ones.
 * Scan pages are 1000 items (a 1 MB page of small rows; the real size varies).
 *
 * Seed: one workflow, 50 live leases claimed 20 min ago, each with 500
 * pre-claim history rows (older generations, ms ids plus events-writer base-36
 * copies), an agent.started (ms id + base-36 copy) and 5 in-claim heartbeats.
 * Ticket 0's holder went through Bedrock retry-backoff (backoff heartbeats)
 * and published agent.died{transient_exhaustion} stamped with this claim.
 *
 * Invariant: the 49 tickets with no death read ZERO pre-claim rows, and the
 * sweep's events Queries are bounded by the in-window rows, not the history.
 * rollingMedian's table Scan (death ticket only, cached per sweep interval) is
 * a different defect and is reported, not asserted.
 */

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const WF = "wf_cost";
const LEASES = 50;
const HISTORY = 500;
const CLAIMED_AT = new Date(NOW - 20 * 60_000).toISOString();
const iso = (ms) => new Date(ms).toISOString();
const b36 = (ms, n) => `${ms.toString(36).padStart(9, "0")}-${String(n).padStart(4, "0")}`;
const tid = (i) => `TEAM-${7000 + i}`;
const aid = (i) => `agentcore_hub_persona_${String(i).padStart(2, "0")}`;

function seed() {
  const rows = [];
  let n = 0;
  const add = (i, ms, type, detail, { pre = false, bridged = false } = {}) => rows.push({
    workflowId: WF, eventId: bridged ? b36(ms, n++ % 10000) : `${ms}-${String(n++).padStart(6, "0")}`,
    type, timestamp: iso(ms), pre, ticketIdx: i,
    detail: { workflowId: WF, agentId: aid(i), ticketId: tid(i), ...detail },
  });
  const oldGen = iso(NOW - 26 * 3_600_000);
  for (let i = 0; i < LEASES; i++) {
    // Pre-claim history: hours older than the claim (and the lease window).
    for (let k = 0; k < HISTORY; k++) {
      const ms = NOW - 2 * 3_600_000 - (k * LEASES + i) * 2_000;
      const kind = k % 50;
      const type = kind === 0 ? "agent.died" : kind === 1 ? "agent.error" : kind === 2 ? "agent.complete" : kind === 3 ? "agent.started" : "agent.streaming";
      const detail = type === "agent.died" ? { reason: "transient_exhaustion", claimStartedAt: oldGen } : type === "agent.streaming" ? { type: "text", content: "…" } : {};
      add(i, ms, type, detail, { pre: true, bridged: k % 10 === 9 });
    }
    // This claim: orchestrator's agent.started (direct ms id + events-writer base-36 copy), 5 heartbeats.
    const claimMs = Date.parse(CLAIMED_AT);
    add(i, claimMs, "agent.started", {});
    add(i, claimMs + 5, "agent.started", {}, { bridged: true });
    for (let h = 0; h < 5; h++) add(i, claimMs + (h + 1) * 3 * 60_000, "agent.streaming", { type: "text", content: "working" });
  }
  // Ticket 0: retry-backoff heartbeats, then the holder's own exhaustion death for THIS generation.
  for (let h = 0; h < 3; h++) add(0, NOW - 90_000 + h * 20_000, "agent.streaming", { type: "retry_backoff", attempt: h + 1 });
  add(0, NOW - 20_000, "agent.died", { reason: "transient_exhaustion", claimStartedAt: CLAIMED_AT });
  return rows.sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
}

function readerOf(kind, input) {
  const v = input.ExpressionAttributeValues || {};
  if (kind === "ScanCommand") return input.TableName === "workflows" ? "workflowsScan" : "rollingMedian";
  if (v[":hb1"]) return "lastAgentActivity";
  if (v[":complete"]) return "hasCompletionSince";
  if (v[":dreason"]) return "strictDeathRead";
  if (v[":died"] || v[":err"]) return "looseDeathRead";
  return "other";
}

function matches(reader, e, input) {
  const v = input.ExpressionAttributeValues || {};
  const ts = String(e.timestamp);
  if (reader === "lastAgentActivity") return [v[":hb1"], v[":hb2"]].includes(e.type) && e.detail?.agentId === v[":aid"] && ts >= v[":cutoff"];
  if (reader === "hasCompletionSince") return e.type === v[":complete"] && e.detail?.ticketId === v[":tid"] && ts >= v[":since"];
  if (reader === "rollingMedian") return [v[":started"], v[":complete"]].includes(e.type) && e.detail?.agentId === v[":aid"];
  const strict = !String(input.FilterExpression).includes("attribute_not_exists(detail.claimStartedAt)");
  const died = v[":died"] && e.type === v[":died"]
    && (!v[":gen"] || (!strict && e.detail?.claimStartedAt == null) || e.detail?.claimStartedAt === v[":gen"])
    && (!v[":dreason"] || e.detail?.reason === v[":dreason"]);
  const err = v[":err"] && e.type === v[":err"] && e.detail?.reason !== v[":dead"];
  return (died || err) && e.detail?.ticketId === v[":tid"] && ts >= v[":since"];
}

function inKey(e, input) {
  const kc = input.KeyConditionExpression;
  const v = input.ExpressionAttributeValues;
  if (e.workflowId !== v[":w"]) return false;
  if (kc === "workflowId = :w") return true;
  if (kc === "workflowId = :w AND eventId >= :lo") return e.eventId >= v[":lo"];
  if (kc === "workflowId = :w AND eventId BETWEEN :lo AND :hi") return e.eventId >= v[":lo"] && e.eventId <= v[":hi"];
  throw new Error(`unmodelled key condition: ${kc}`);
}

/** Counting DocumentClient: tallies every row a call READS (pre-filter), per reader. */
function countingDdb({ workflows, events }) {
  const tally = {};
  const ticketOfAgent = new Map(Array.from({ length: LEASES }, (_, i) => [aid(i), i]));
  const bump = (reader, ticketIdx, page) => {
    const t = (tally[reader] ||= { calls: 0, items: 0, preClaimItems: 0, nonDeathItems: 0, nonDeathPreClaimItems: 0 });
    const pre = page.filter((e) => e.pre).length;
    t.calls++; t.items += page.length; t.preClaimItems += pre;
    if (ticketIdx !== 0) { t.nonDeathItems += page.length; t.nonDeathPreClaimItems += pre; }
  };
  const send = vi.fn(async (cmd) => {
    const kind = cmd.constructor.name;
    const input = cmd.input;
    const reader = readerOf(kind, input);
    const v = input.ExpressionAttributeValues || {};
    const ticketIdx = v[":tid"] ? Number(String(v[":tid"]).slice(5)) - 7000 : ticketOfAgent.get(v[":aid"]);
    if (kind === "ScanCommand" && input.TableName === "workflows") { bump(reader, -1, workflows); return { Items: workflows }; }
    if (kind === "ScanCommand") {
      const start = input.ExclusiveStartKey ? events.findIndex((e) => e.eventId === input.ExclusiveStartKey.eventId) + 1 : 0;
      const page = events.slice(start, start + 1000);
      bump(reader, ticketIdx, page);
      const more = start + 1000 < events.length;
      return { Items: page.filter((e) => matches(reader, e, input)), LastEvaluatedKey: more ? { workflowId: WF, eventId: page.at(-1).eventId } : undefined };
    }
    if (kind === "QueryCommand") {
      let rows = events.filter((e) => inKey(e, input));
      if (input.ScanIndexForward === false) rows = rows.slice().reverse();
      const start = input.ExclusiveStartKey ? rows.findIndex((e) => e.eventId === input.ExclusiveStartKey.eventId) + 1 : 0;
      const limit = input.Limit ?? Infinity;
      const page = rows.slice(start, start + limit);
      bump(reader, ticketIdx, page);
      const more = start + limit < rows.length;
      return { Items: page.filter((e) => matches(reader, e, input)), LastEvaluatedKey: more ? { workflowId: WF, eventId: page.at(-1).eventId } : undefined };
    }
    return {}; // UpdateCommand (stealClaim)
  });
  return { send, tally };
}

function makeDeps(events) {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  const agentTasks = {};
  for (let i = 0; i < LEASES; i++) agentTasks[tid(i)] = { agentId: aid(i), ticketId: tid(i), status: "running", startedAt: CLAIMED_AT };
  const workflow = { id: WF, workflowId: WF, phase: "development", startedAt: CLAIMED_AT, agentTasks };
  const ddb = countingDdb({ workflows: [workflow], events });
  const deps = {
    ddb, workflowsTable: "workflows", eventsTable: "events",
    store: {
      markDeadSessionDetected: vi.fn(async () => true),
      clearDeadSessionDetected: vi.fn(async () => true),
      incrementDeadSessionRetry: vi.fn(async () => 1),
      setTaskStatus: vi.fn(async () => {}),
      appendNotification: vi.fn(async () => {}),
      getWorkflow: vi.fn(async () => workflow),
    },
    lease, // the REAL module
    getTicket: vi.fn(async (ticketId) => ({ ticketId, type: "task", status: "in_progress" })),
    getAgentDef: vi.fn((agentId) => ({ agentId, phase: "development" })),
    publishEvent: vi.fn(async () => {}),
    redispatch: vi.fn(async () => true),
    blockTicket: vi.fn(async () => {}),
    now: () => NOW,
    log: () => {},
  };
  return { deps, tally: ddb.tally };
}

afterEach(() => vi.useRealTimers());

describe("dead-session sweep read cost (TEAM-6021)", () => {
  it("non-death live leases read no pre-claim history; total reads are bounded by the in-window rows", async () => {
    const events = seed();
    const { deps, tally } = makeDeps(events);
    const m = await createDetector(deps).runSweep("shadow");

    const rows = Object.entries(tally).map(([reader, t]) => ({
      reader, calls: t.calls, items: t.items, preClaimItems: t.preClaimItems,
      perNonDeathLease: +(t.nonDeathItems / (LEASES - 1)).toFixed(1),
      nonDeathPreClaimItems: t.nonDeathPreClaimItems,
    }));
    const eventQueryReaders = ["lastAgentActivity", "strictDeathRead", "looseDeathRead", "hasCompletionSince"];
    const queryItems = rows.filter((r) => eventQueryReaders.includes(r.reader)).reduce((s, r) => s + r.items, 0);
    const inWindowRows = events.filter((e) => !e.pre).length;
    console.log(`\n[TEAM-6021 sweep-read-cost] ${events.length} events rows (${events.filter((e) => e.pre).length} pre-claim, ${inWindowRows} in-window), ${LEASES} live leases`);
    console.table(rows);
    console.log(`[TEAM-6021 sweep-read-cost] events Query items total=${queryItems} perLiveLease=${(queryItems / LEASES).toFixed(1)} | rollingMedian Scan items=${tally.rollingMedian?.items ?? 0} (death ticket only; out of scope)`);
    console.log(`[TEAM-6021 sweep-read-cost] outcome candidates=${m.candidates} skippedLiveLease=${m.skippedLiveLease} fired=${m.fired} redispatched=${deps.redispatch.mock.calls.map((c) => c[1]?.ticketId).join(",")}`);

    // Outcomes are the production ones: ticket 0's own exhaustion death releases it (shadow → enforce), 49 stay live.
    expect(m.candidates).toBe(LEASES);
    expect(m.skippedLiveLease).toBe(LEASES - 1);
    expect(m.fired).toBe(1);
    expect(deps.redispatch).toHaveBeenCalledTimes(1);
    expect(deps.redispatch.mock.calls[0][1].ticketId).toBe(tid(0));

    // Invariant: no events Query issued for a non-death ticket reaches pre-claim history.
    for (const r of rows.filter((x) => eventQueryReaders.includes(x.reader))) expect(r.nonDeathPreClaimItems, r.reader).toBe(0);
    // Bounded: each live lease pays lastAgentActivity + the strict read (≤ 2 ranges of in-window rows each),
    // plus the death ticket's completion check — never the partition's history.
    expect(queryItems).toBeLessThanOrEqual((2 * LEASES + 4) * inWindowRows);
  });
});
