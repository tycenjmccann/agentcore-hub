import { describe, it, expect, vi } from "vitest";
import { createCascade } from "./cascade.mjs";
import { createReconcileSweep } from "./reconcile-sweep.mjs";
import * as realLease from "./lease.mjs";

const WF = "wf_bug_TEAM-4798";
const TICKET = "TEAM-4801";
const PARENT = "EPIC-TEAM-4801";
const AGENT = "backend_dev";
const START = Date.parse("2026-09-19T00:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

function makeDdb(row, events) {
  return {
    send: vi.fn(async (cmd) => {
      const input = cmd.input || {};
      if (cmd.constructor.name === "ScanCommand") return { Items: [row], Count: 1, ScannedCount: 1 };
      if (cmd.constructor.name === "QueryCommand") {
        const values = input.ExpressionAttributeValues || {};
        const typeSet = new Set([values[":err"], values[":died"], values[":hb1"], values[":hb2"]].filter(Boolean));
        const visible = events.filter((event) => {
          if (event.workflowId !== values[":w"]) return false;
          if (typeSet.size && !typeSet.has(event.type)) return false;
          if (values[":tid"] && event.detail?.ticketId !== values[":tid"]) return false;
          if (values[":since"] && String(event.timestamp || "") < values[":since"]) return false;
          if (values[":cutoff"] && String(event.timestamp || "") < values[":cutoff"]) return false;
          if (values[":aid"] && event.detail?.agentId !== values[":aid"]) return false;
          if (values[":dead"] && event.detail?.reason === values[":dead"]) return false;
          return true;
        });
        return { Items: visible };
      }
      return {};
    }),
  };
}

function makeFixture({ injectDeathProbe }) {
  let clock = START + 2 * 24 * 60 * 60_000;
  const row = {
    id: WF,
    workflowId: WF,
    epicId: PARENT,
    phase: "development",
    updatedAt: iso(START),
    deadSessionRetries: {},
    agentTasks: {
      [TICKET]: { id: "task_backend", ticketId: TICKET, agentId: AGENT, status: "running", startedAt: iso(START) },
    },
  };
  const siblings = [
    { ticketId: "BLOCKER-1", status: "done", type: "task" },
    { ticketId: TICKET, status: "blocked", assignee: AGENT, type: "task", blockedBy: ["BLOCKER-1"], updatedAt: iso(START) },
  ];
  const events = Array.from({ length: 57 }, (_, i) => ({
    workflowId: WF,
    eventId: `died_${i}`,
    type: "agent.died",
    timestamp: iso(START + i * 60 * 60_000),
    detail: { ticketId: TICKET, agentId: AGENT },
  }));
  const ddb = makeDdb(row, events);
  const store = {
    getWorkflow: vi.fn(async () => row),
    incrementDeadSessionRetry: vi.fn(async (_workflowId, ticketId) => {
      row.deadSessionRetries[ticketId] = (row.deadSessionRetries[ticketId] || 0) + 1;
      return row.deadSessionRetries[ticketId];
    }),
    setTaskStatus: vi.fn(async (_workflowId, ticketId, status) => { row.agentTasks[ticketId].status = status; }),
    appendNotification: vi.fn(async () => {}),
  };
  const lease = injectDeathProbe ? realLease : { ...realLease, hasAgentErrorSince: undefined };
  const publishEvent = vi.fn(async () => {});
  const redispatch = vi.fn(async (_workflow, ticket) => {
    row.agentTasks[ticket.ticketId].status = "running";
    row.agentTasks[ticket.ticketId].startedAt = iso(clock);
    events.push({
      workflowId: WF,
      eventId: `died_after_${redispatch.mock.calls.length}`,
      type: "agent.died",
      timestamp: iso(clock + 60_000),
      detail: { ticketId: ticket.ticketId, agentId: AGENT },
    });
    return true;
  });
  const cascade = createCascade({
    ddb,
    ticketsTable: "tickets",
    provider: "dynamodb",
    jiraTransition: vi.fn(async () => {}),
    getChildTickets: vi.fn(async () => []),
    publishEvent,
    now: () => clock,
    log: () => {},
    extendedStates: "enforce",
    lease,
    eventsTable: "events",
    workflowsTable: "workflows",
    redispatch,
    store,
    blockTicket: vi.fn(async () => {}),
  });
  const sweep = createReconcileSweep({
    ddb,
    workflowsTable: "workflows",
    cascade,
    getChildTickets: vi.fn(async () => siblings),
    leaseTtlMs: realLease.LEASE_TTL_MS,
    now: () => clock,
    log: () => {},
  });
  return { row, store, publishEvent, redispatch, sweep, advance: () => { clock += 5 * 60_000; } };
}

const eventsOfType = (fn, type) => fn.mock.calls.filter((call) => call[1] === type);

describe("TEAM-4889 replay — TEAM-4801 blocked died claim is capped", () => {
  it("with hasAgentErrorSince: two consecutive sweep redispatches, one escalation, then held", async () => {
    const fx = makeFixture({ injectDeathProbe: true });
    const summaries = [];
    for (let i = 0; i < 5; i++) {
      summaries.push(await fx.sweep.runSweep("enforce"));
      fx.advance();
    }

    expect(fx.redispatch).toHaveBeenCalledTimes(2);
    expect(fx.store.incrementDeadSessionRetry).toHaveBeenCalledTimes(2);
    expect(fx.row.deadSessionRetries[TICKET]).toBe(2);
    expect(eventsOfType(fx.publishEvent, "agent.escalated")).toHaveLength(1);
    expect(summaries.map((m) => m.redispatched)).toEqual([1, 1, 0, 0, 0]);
    expect(summaries.map((m) => m.escalated || 0)).toEqual([0, 0, 1, 0, 0]);
    expect(summaries.map((m) => m.escalationHeld || 0)).toEqual([0, 0, 0, 1, 1]);
  });

  it("without hasAgentErrorSince: no infinite 59-dispatch loop; still caps at two then escalates", async () => {
    // Pre-fix counter-assertion from prod: 59 dispatches, 57 agent.died rows,
    // zero escalations, and no deadSessionRetries on wf_bug_TEAM-4798.
    const fx = makeFixture({ injectDeathProbe: false });
    const dispatchAt = [];
    const escalatedAt = [];
    for (let i = 0; i < 40; i++) {
      const m = await fx.sweep.runSweep("enforce");
      if (m.redispatched) dispatchAt.push(i);
      if (m.escalated) escalatedAt.push(i);
      fx.advance();
    }

    expect(fx.redispatch.mock.calls.length).toBeLessThanOrEqual(2);
    expect(dispatchAt).toEqual([0, 6]);
    expect(escalatedAt).toEqual([12]);
    expect(fx.store.incrementDeadSessionRetry).toHaveBeenCalledTimes(2);
    expect(fx.row.deadSessionRetries[TICKET]).toBe(2);
    expect(eventsOfType(fx.publishEvent, "agent.escalated")).toHaveLength(1);
  });
});
