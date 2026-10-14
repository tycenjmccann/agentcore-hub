import { describe, it, expect, vi } from "vitest";
import { createDetector } from "./dead-session-detector.mjs";

/**
 * TEAM-6081 — rollingMedian's events read must be bounded by a key condition
 * (the candidate's own workflow partition), independent of total table size.
 * Before this fix it ran a full-table ScanCommand capped at MEDIAN_SCAN_PAGES
 * (10) × 1000-item pages; a table with enough OTHER workflows' rows ahead of
 * the candidate's partition could exhaust that cap before ever reaching it —
 * reading more AND finding fewer samples as the table grows.
 *
 * The counting fake below behaves like DynamoDB where cost is decided: a Query
 * applies its KeyConditionExpression (the partition) before Limit/paging; a
 * Scan has no key and pages 1000 items at a time over the WHOLE table,
 * oldest-inserted first — so seeding N "other workflow" rows BEFORE the
 * candidate's own partition reproduces the real failure mode (the candidate
 * partition sits behind N rows of unrelated history).
 *
 * Driven through the real createDetector/runSweep ("shadow", so nothing is
 * written) with lease fully stubbed dead — only hasCompletionSince and
 * rollingMedian touch the fake ddb for this candidate.
 */

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const WF = "wf_candidate";
const TICKET = "TEAM-9000";
const AGENT = "agentcore_hub_persona_dev";
// Older than MAX_THRESHOLD_MS (6h) so GUARD 2 fires regardless of the median
// (3x the seeded ~4.5min median clamps up to the 30min TTL anyway — this just
// keeps the test independent of that clamp).
const CLAIMED_AT = new Date(NOW - 25 * 3_600_000).toISOString();
const TTL_MS = 30 * 60 * 1000;

/** 8 started/complete pairs for AGENT in wf_candidate's own partition, plus noise. */
function candidateRows() {
  const rows = [];
  const base = NOW - 10 * 3_600_000;
  const durations = [];
  for (let i = 0; i < 8; i++) {
    const startMs = base + i * 10 * 60_000;
    const dur = (i + 1) * 60_000; // 1min, 2min, ... 8min — median = 4.5min
    durations.push(dur);
    rows.push({ workflowId: WF, eventId: `${startMs}-s${i}`, type: "agent.started", timestamp: new Date(startMs).toISOString(), detail: { agentId: AGENT, ticketId: `TEAM-${8000 + i}` } });
    rows.push({ workflowId: WF, eventId: `${startMs + dur}-c${i}`, type: "agent.complete", timestamp: new Date(startMs + dur).toISOString(), detail: { agentId: AGENT, ticketId: `TEAM-${8000 + i}` } });
    rows.push({ workflowId: WF, eventId: `${startMs + 1000}-n${i}`, type: "agent.streaming", timestamp: new Date(startMs + 1000).toISOString(), detail: { agentId: AGENT, type: "text", content: "noise" } });
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const expectedMedianMs = (sorted[3] + sorted[4]) / 2; // 8 samples, even count
  return { rows, expectedMedianMs, expectedSampleCount: 8 };
}

/** N rows spread across OTHER workflow partitions, inserted BEFORE wf_candidate's rows. */
function otherRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const ms = NOW - 20 * 3_600_000 - i * 1_000;
    const wf = `wf_other_${String(i % 50).padStart(3, "0")}`;
    rows.push({ workflowId: wf, eventId: `${ms}-${i}`, type: i % 7 === 0 ? "agent.started" : i % 7 === 1 ? "agent.complete" : "agent.streaming", timestamp: new Date(ms).toISOString(), detail: { agentId: `${AGENT}_other`, ticketId: `OTHER-${i}` } });
  }
  return rows;
}

function matches(reader, e, input) {
  const v = input.ExpressionAttributeValues || {};
  const ts = String(e.timestamp);
  if (reader === "rollingMedian") return [v[":started"], v[":complete"]].includes(e.type) && e.detail?.agentId === v[":aid"];
  if (reader === "hasCompletionSince") return e.type === v[":complete"] && e.detail?.ticketId === v[":tid"] && ts >= v[":since"];
  return false;
}

/** Counting DocumentClient: tallies every row a call READS (pre-filter), per reader/kind. */
function countingDdb({ workflows, events }) {
  const tally = { scanEventsCalls: 0, scanEventsItems: 0 };
  const bump = (reader, page) => {
    const t = (tally[reader] ||= { calls: 0, items: 0 });
    t.calls++; t.items += page.length;
  };
  const send = vi.fn(async (cmd) => {
    const kind = cmd.constructor.name;
    const input = cmd.input;
    if (kind === "ScanCommand" && input.TableName === "workflows") return { Items: workflows };
    if (kind === "ScanCommand") {
      // Whole-table scan, oldest-inserted-first, 1000-item pages — the OLD
      // rollingMedian's shape. No key condition exists for a Scan. Tallied
      // SEPARATELY from the Query readers so "no Scan against events" is a
      // real assertion, not folded into the same counter as the fix's Query.
      const start = input.ExclusiveStartKey ? events.findIndex((e) => e.eventId === input.ExclusiveStartKey.eventId) + 1 : 0;
      const page = events.slice(start, start + 1000);
      tally.scanEventsCalls++; tally.scanEventsItems += page.length;
      const more = start + 1000 < events.length;
      return { Items: page, LastEvaluatedKey: more ? { workflowId: WF, eventId: page.at(-1).eventId } : undefined };
    }
    if (kind === "QueryCommand") {
      const v = input.ExpressionAttributeValues || {};
      const reader = v[":started"] ? "rollingMedian" : "hasCompletionSince";
      let rows = events.filter((e) => e.workflowId === v[":w"]);
      const start = input.ExclusiveStartKey ? rows.findIndex((e) => e.eventId === input.ExclusiveStartKey.eventId) + 1 : 0;
      const limit = input.Limit ?? Infinity;
      const page = rows.slice(start, start + limit);
      bump(reader, page);
      const more = start + limit < rows.length;
      return { Items: page.filter((e) => matches(reader, e, input)), LastEvaluatedKey: more ? { workflowId: v[":w"], eventId: page.at(-1).eventId } : undefined };
    }
    return {}; // UpdateCommand — shadow mode never issues one
  });
  return { send, tally };
}

function makeDeps(events) {
  const task = { id: "task_1", agentId: AGENT, ticketId: TICKET, status: "running", startedAt: CLAIMED_AT };
  const workflow = { id: WF, workflowId: WF, phase: "development", startedAt: CLAIMED_AT, agentTasks: { [TICKET]: task } };
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
    lease: {
      LEASE_TTL_MS: TTL_MS,
      isLeaseLive: vi.fn(() => false), // dead by default — GUARD 1 passes straight through
      lastAgentActivity: vi.fn(async () => null),
      stealClaim: vi.fn(async () => true),
      hasAgentErrorSince: vi.fn(async () => false), // no positive death — GUARD 2 decides
    },
    getTicket: vi.fn(async () => ({ ticketId: TICKET, type: "task", status: "in_progress", assignee: AGENT })),
    getAgentDef: vi.fn((agentId) => ({ agentId, phase: "development" })),
    publishEvent: vi.fn(async () => {}),
    redispatch: vi.fn(async () => true),
    blockTicket: vi.fn(async () => {}),
    now: () => NOW,
    log: () => {},
  };
  return { deps, tally: ddb.tally };
}

async function runOneSweep(events) {
  const { deps, tally } = makeDeps(events);
  const m = await createDetector(deps).runSweep("shadow");
  const shadowCall = deps.publishEvent.mock.calls.find((c) => c[1] === "dead_session.shadow");
  return { m, tally, detectorMeta: shadowCall?.[2]?.detectorMeta };
}

describe("rollingMedian read cost (TEAM-6081)", () => {
  it.each([1_000, 25_000])("is bounded by the candidate's own workflow partition, not table size (N=%i)", async (n) => {
    const { rows: candidate, expectedMedianMs, expectedSampleCount } = candidateRows();
    const events = [...otherRows(n), ...candidate]; // candidate partition sits BEHIND N other rows
    const { m, tally, detectorMeta } = await runOneSweep(events);

    console.log(`\n[TEAM-6081 rolling-median-read-cost] N=${n} candidatePartitionSize=${candidate.length}`);
    console.log(`[TEAM-6081 rolling-median-read-cost] N=${n} scanEventsCalls=${tally.scanEventsCalls} scanEventsItems=${tally.scanEventsItems} | rollingMedian(Query) calls=${tally.rollingMedian?.calls ?? 0} items=${tally.rollingMedian?.items ?? 0}`);
    console.log(`[TEAM-6081 rolling-median-read-cost] N=${n} medianMs=${detectorMeta?.medianMs} sampleCount=${detectorMeta?.sampleCount} fired=${m.fired}`);

    // No ScanCommand reaches the events table for rollingMedian — only a
    // partition-bounded Query.
    expect(tally.scanEventsCalls).toBe(0);

    // Bounded by the candidate's own partition: never more than its size, and
    // identical regardless of how much unrelated history sits ahead of it.
    const items = tally.rollingMedian?.items ?? 0;
    expect(items).toBeGreaterThan(0);
    expect(items).toBeLessThanOrEqual(candidate.length);

    // Semantic parity: the partition's own pairs are found and medianed correctly.
    expect(detectorMeta.sampleCount).toBe(expectedSampleCount);
    expect(detectorMeta.medianMs).toBe(expectedMedianMs);
  });

  it("items read are IDENTICAL at N=1k and N=25k (the core invariant)", async () => {
    const { rows: candidate } = candidateRows();
    const at1k = await runOneSweep([...otherRows(1_000), ...candidate]);
    const at25k = await runOneSweep([...otherRows(25_000), ...candidate]);

    const items1k = at1k.tally.rollingMedian?.items ?? 0;
    const items25k = at25k.tally.rollingMedian?.items ?? 0;
    console.log(`[TEAM-6081 rolling-median-read-cost] rollingMedian items: N=1k -> ${items1k}, N=25k -> ${items25k}`);
    expect(items25k).toBe(items1k);
    expect(at1k.detectorMeta.sampleCount).toBe(at25k.detectorMeta.sampleCount);
    expect(at1k.detectorMeta.medianMs).toBe(at25k.detectorMeta.medianMs);
  });

  it("caches per workflowId:agentId — a second workflow queries once, a repeat sweep within the interval queries never", async () => {
    const { rows: candidate } = candidateRows();
    const WF2 = "wf_candidate_2";
    const task2 = { id: "task_2", agentId: AGENT, ticketId: "TEAM-9100", status: "running", startedAt: CLAIMED_AT };
    const wf2 = { id: WF2, workflowId: WF2, phase: "development", startedAt: CLAIMED_AT, agentTasks: { "TEAM-9100": task2 } };
    const wf1Task = { id: "task_1", agentId: AGENT, ticketId: TICKET, status: "running", startedAt: CLAIMED_AT };
    const wf1 = { id: WF, workflowId: WF, phase: "development", startedAt: CLAIMED_AT, agentTasks: { [TICKET]: wf1Task } };

    const events = [...candidate, ...candidate.map((e) => ({ ...e, workflowId: WF2 }))];
    const ddb = countingDdb({ workflows: [wf1, wf2], events });
    const deps = {
      ddb, workflowsTable: "workflows", eventsTable: "events",
      store: {
        markDeadSessionDetected: vi.fn(async () => true), clearDeadSessionDetected: vi.fn(async () => true),
        incrementDeadSessionRetry: vi.fn(async () => 1), setTaskStatus: vi.fn(async () => {}),
        appendNotification: vi.fn(async () => {}), getWorkflow: vi.fn(async () => wf1),
      },
      lease: { LEASE_TTL_MS: TTL_MS, isLeaseLive: vi.fn(() => false), lastAgentActivity: vi.fn(async () => null), stealClaim: vi.fn(async () => true), hasAgentErrorSince: vi.fn(async () => false) },
      getTicket: vi.fn(async (ticketId) => ({ ticketId, type: "task", status: "in_progress", assignee: AGENT })),
      getAgentDef: vi.fn((agentId) => ({ agentId, phase: "development" })),
      publishEvent: vi.fn(async () => {}),
      redispatch: vi.fn(async () => true),
      blockTicket: vi.fn(async () => {}),
      now: () => NOW,
      log: () => {},
    };
    const detector = createDetector(deps);

    await detector.runSweep("shadow");
    expect(ddb.tally.rollingMedian.calls).toBe(2); // one per workflowId:agentId key

    await detector.runSweep("shadow"); // same `now()` — within SWEEP_INTERVAL_MS
    expect(ddb.tally.rollingMedian.calls).toBe(2); // cache hit for both — no new Query
  });
});
