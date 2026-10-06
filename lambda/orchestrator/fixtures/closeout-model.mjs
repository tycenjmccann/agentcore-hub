/**
 * TEAM-5359 — test-only model of "Stop the run" (requirements FR-3 + FR-5) over an
 * exported fixture. Pure: (workflow row, events, completion records) in, the
 * post-cancel board out. It lives under fixtures/ so it is never zipped into the
 * orchestrator and costs no DL-009 line budget. When api_dev's cancel route lands,
 * replay-closeout.test.mjs should import its helper instead of this one.
 *
 * Rules (README "Cancel model"):
 *  - Stop time: the first workflow.cancelled, else the start of the Done burst
 *    around workflow.complete (same rule as export-closeout.cjs; the test pins the
 *    two against closeout-manifest.json).
 *  - Done at stop: the ticket's first agent.complete precedes the stop. Anything
 *    done only by the stop burst was force-Done, not done.
 *  - Agent session: an agent.invoked / orchestrator.agent_invoked / agent.started
 *    before the stop. A non-done ticket with one is live and keeps its status.
 *  - Follow-up move (FR-5): a follow-up (followUpsMaterialized.created) open at
 *    the stop whose only open blocker on the at-stop board is the run's CD ticket
 *    (findCdTicket: newest non-human ship-phase sibling). It is re-parented to
 *    "Post-run follow-ups <workflowId>" with blockedBy [], keeps its open status,
 *    and is NOT cancelled. Security follow-ups go to human:engineer.
 *  - Cancelled (FR-3): not done at stop, no completion record, no agent session,
 *    and not moved.
 */

export const FOLLOW_UP_HUMAN_ASSIGNEE = "human:engineer";
const BURST_GAP_MS = 15_000, BURST_NEAR_MS = 60_000;
const SESSION_EVENTS = new Set(["agent.invoked", "orchestrator.agent_invoked", "agent.started"]);

const ts = (e) => e.detail?.timestamp || e.timestamp;
const tid = (e) => e.detail?.ticketId || e.detail?.ticket?.id || null;
const isHuman = (a) => typeof a === "string" && a.startsWith("human:");

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

export function isSecurityFollowUp(t) {
  return (t.labels || []).some((l) => String(l).toLowerCase() === "security") || /^security:/i.test(t.title || "");
}

/** @returns the at-stop board, the buckets, and the post-cancel board. */
export function modelCancel({ workflow, events: rawEvents, completions, phaseOf }) {
  const events = rawEvents.filter((e) => e.type !== "agent.streaming").sort((a, b) => ts(a).localeCompare(ts(b)));
  const wfId = workflow.workflowId || workflow.id;
  const cancel = events.find((e) => e.type === "workflow.cancelled");
  const stopAt = cancel ? (cancel.detail?.cancelledAt || ts(cancel)) : forceCloseBurstStart(events);
  const first = (pred) => {
    const m = new Map();
    for (const e of events) if (pred(e) && tid(e) && !m.has(tid(e))) m.set(tid(e), e);
    return m;
  };
  const created = first((e) => e.type === "ticket.created");
  const doneAt = first((e) => e.type === "agent.complete");
  const session = first((e) => SESSION_EVENTS.has(e.type) && ts(e) < stopAt);
  const fuBlockers = new Map();
  for (const r of Object.values(completions)) for (const f of r?.followUpsMaterialized?.created || []) fuBlockers.set(f.ticketId, f.blockedBy || []);

  const ids = [...new Set([...created.keys(), ...Object.keys(workflow.agentTasks || {})])].filter((id) => id !== workflow.epicId).sort();
  const board = ids.map((id) => {
    const c = created.get(id)?.detail?.ticket || {};
    const task = workflow.agentTasks?.[id] || {};
    const done = doneAt.has(id) && ts(doneAt.get(id)) < stopAt;
    return {
      ticketId: id, parentId: workflow.epicId, workflowId: wfId, type: "task", title: c.title || "",
      assignee: c.assignee || task.agentId, labels: c.labels || [], blockedBy: fuBlockers.get(id) || c.blockedBy || [],
      status: done ? "done" : session.has(id) ? "in_progress" : (c.status || "ready"),
      createdAt: ts(created.get(id) || {}) || task.createdAt,
    };
  });
  const byId = new Map(board.map((t) => [t.ticketId, t]));
  const ships = board.filter((t) => !isHuman(t.assignee) && phaseOf(t.assignee) === "ship").sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const cdTicketId = ships.length ? ships[ships.length - 1].ticketId : null;

  const nonDone = board.filter((t) => t.status !== "done").map((t) => t.ticketId);
  const followUps = [...fuBlockers.keys()].filter((id) => byId.has(id)).sort();
  const openBlockers = (t) => t.blockedBy.filter((b) => byId.get(b)?.status !== "done");
  const moved = followUps.filter((id) => {
    const t = byId.get(id);
    if (t.status === "done") return false;
    const open = openBlockers(t);
    return open.length === 1 && open[0] === cdTicketId;
  });
  const buckets = {
    epic: workflow.epicId,
    cdTicketId,
    doneBeforeStop: board.filter((t) => t.status === "done").map((t) => t.ticketId),
    nonDoneWithCompletion: nonDone.filter((id) => completions[id]),
    nonDoneLiveSession: nonDone.filter((id) => !completions[id] && session.has(id)),
    nonDoneWithout: nonDone.filter((id) => !completions[id] && !session.has(id)),
    forceDoneWithoutCompletion: nonDone.filter((id) => doneAt.has(id) && !completions[id]),
    followUps,
    followUpsMoved: moved,
  };
  buckets.cancelled = buckets.nonDoneWithout.filter((id) => !moved.includes(id));

  const postRunEpic = { ticketId: `POST-RUN-${wfId}`, title: `Post-run follow-ups ${wfId}`, type: "epic" };
  const followUpMoves = moved.map((id) => {
    const t = byId.get(id);
    return { ...t, parentId: postRunEpic.ticketId, blockedBy: [], assignee: isSecurityFollowUp(t) ? FOLLOW_UP_HUMAN_ASSIGNEE : t.assignee };
  });
  const children = board
    .filter((t) => !moved.includes(t.ticketId))
    .map((t) => (buckets.cancelled.includes(t.ticketId) ? { ...t, status: "cancelled" } : { ...t }));
  return { stopAt, stopKind: cancel ? "workflow.cancelled" : "force-close-burst", board, buckets, postRunEpic, followUpMoves, children };
}
