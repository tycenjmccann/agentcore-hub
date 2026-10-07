/**
 * TEAM-5370 — the board a stopped run had at the moment it was stopped, projected
 * from an exported fixture. Inputs only: no cancel buckets, no follow-up moves, no
 * security rule. replay-closeout.test.mjs seeds this board into the mocked tickets
 * table and POSTs the REAL stop route, so what is cancelled, kept or moved is
 * decided by src/lib/workflow/cancel-run.ts, never here. Test-only: fixtures/ is
 * not zipped into the orchestrator and costs no DL-009 line budget.
 *
 * Rules (README "Board at stop"):
 *  - Stop time: the first workflow.cancelled, else the start of the Done burst
 *    around workflow.complete (same rule as export-closeout.cjs; the test pins the
 *    two against closeout-manifest.json).
 *  - done: the ticket's first agent.complete precedes the stop. Anything done only
 *    by the stop burst was force-Done, not done.
 *  - blocked (task ready): the ticket's last session event before the stop is an
 *    orchestrator.claim_released reason agent_self_park (index.mjs: the agent moved
 *    it in_progress → blocked; the claim is released and the task set ready).
 *    blockedBy is the park's list.
 *  - in_progress (task running): any other agent.invoked /
 *    orchestrator.agent_invoked / agent.started before the stop.
 *  - otherwise the status from ticket.created.
 *  - at-stop-evidence.json: a per-run, per-ticket override for a status the
 *    exported lifecycle events do not carry; every entry cites the events it rests on.
 *  - Follow-ups (followUpsMaterialized.created) take their blockedBy from the record.
 */

import { readFileSync } from "node:fs";

const BURST_GAP_MS = 15_000, BURST_NEAR_MS = 60_000;
const SESSION_EVENTS = new Set(["agent.invoked", "orchestrator.agent_invoked", "agent.started"]);
const SELF_PARK = (e) => e.type === "orchestrator.claim_released" && e.detail?.reason === "agent_self_park";

const ts = (e) => e.detail?.timestamp || e.timestamp;
const tid = (e) => e.detail?.ticketId || e.detail?.ticket?.id || null;

export const AT_STOP_EVIDENCE = JSON.parse(readFileSync(new URL("./at-stop-evidence.json", import.meta.url), "utf8"));

function forceCloseBurstStart(events) {
  const complete = events.find((e) => e.type === "workflow.complete");
  if (!complete) return null;
  const at = Date.parse(ts(complete));
  const chains = [];
  for (const t of events.filter((e) => e.type === "agent.complete").map(ts).sort()) {
    const last = chains[chains.length - 1];
    if (last && Date.parse(t) - Date.parse(last[last.length - 1]) <= BURST_GAP_MS) last.push(t); else chains.push([t]);
  }
  const near = chains.filter((c) => Date.parse(c[0]) - BURST_NEAR_MS <= at && at <= Date.parse(c[c.length - 1]) + BURST_NEAR_MS);
  return near.length ? near[near.length - 1][0] : null;
}

/**
 * @returns {{ stopAt: string, stopKind: string, board: any[], tasksAtStop: Record<string, any> }}
 *   board: one tickets-table row per child (the epic excluded), as of the stop.
 */
export function boardAtStop({ run, workflow, events: rawEvents, completions }) {
  const events = rawEvents.filter((e) => e.type !== "agent.streaming").sort((a, b) => ts(a).localeCompare(ts(b)));
  const wfId = workflow.workflowId || workflow.id;
  const cancel = events.find((e) => e.type === "workflow.cancelled");
  const stopAt = cancel ? (cancel.detail?.cancelledAt || ts(cancel)) : forceCloseBurstStart(events);
  const before = events.filter((e) => ts(e) < stopAt);

  const created = new Map();
  const doneAt = new Map();
  const lastSession = new Map(); // ticketId → last session or self-park event before the stop
  for (const e of events) {
    const id = tid(e);
    if (!id) continue;
    if (e.type === "ticket.created" && !created.has(id)) created.set(id, e);
    if (e.type === "agent.complete" && !doneAt.has(id)) doneAt.set(id, e);
  }
  for (const e of before) if (tid(e) && (SESSION_EVENTS.has(e.type) || SELF_PARK(e))) lastSession.set(tid(e), e);
  const fuBlockers = new Map();
  for (const r of Object.values(completions)) for (const f of r?.followUpsMaterialized?.created || []) fuBlockers.set(f.ticketId, f.blockedBy || []);
  const overrides = AT_STOP_EVIDENCE.runs?.[run] || {};

  const ids = [...new Set([...created.keys(), ...Object.keys(workflow.agentTasks || {})])].filter((id) => id !== workflow.epicId).sort();
  const board = [];
  const tasksAtStop = {};
  for (const id of ids) {
    const c = created.get(id)?.detail?.ticket || {};
    const task = workflow.agentTasks?.[id];
    const last = lastSession.get(id);
    let status, taskStatus, blockedBy = fuBlockers.get(id) || c.blockedBy || [];
    if (doneAt.has(id) && ts(doneAt.get(id)) < stopAt) [status, taskStatus] = ["done", "complete"];
    else if (last && SELF_PARK(last)) [status, taskStatus, blockedBy] = ["blocked", "ready", fuBlockers.get(id) || last.detail.blockedBy || blockedBy];
    else if (last) [status, taskStatus] = ["in_progress", "running"];
    else status = c.status || "ready";
    const o = overrides[id];
    if (o) {
      status = o.status;
      taskStatus = o.taskStatus;
      if (o.blockedBy) blockedBy = o.blockedBy;
    }
    board.push({
      ticketId: id, parentId: workflow.epicId, workflowId: wfId, type: "task", title: c.title || "",
      assignee: c.assignee || task?.agentId, labels: c.labels || [], blockedBy, status,
      createdAt: ts(created.get(id) || {}) || task?.createdAt,
    });
    if (task && taskStatus) {
      const { completedAt: _c, output: _o, ...rest } = task;
      tasksAtStop[id] = taskStatus === "complete" ? { ...task, ticketId: id, status: "complete" } : { ...rest, ticketId: id, status: taskStatus };
    }
  }
  return { stopAt, stopKind: cancel ? "workflow.cancelled" : "force-close-burst", board, tasksAtStop };
}
