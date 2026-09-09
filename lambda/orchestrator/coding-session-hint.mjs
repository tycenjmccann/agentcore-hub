/**
 * Prior-coding-session hint — pure selection + rendering (DL-025).
 *
 * A Cloud Code session is ONE git checkout and ONE CLI on the coding runtime.
 * The hint used to be "this agent's most recent session in the run", so two
 * parallel fix tickets for the same dev (TEAM-3963/3964, 2026-09-04) both
 * resumed the same session and two CLIs interleaved checkouts in one working
 * tree. A session is now offered back ONLY to the ticket that created it — a
 * reopen (review rejection) or a re-dispatch (self-park unblocked, dead-session
 * retry) of that same ticket, which can never run in parallel with itself.
 *
 * Rows come from the cloud-code-sessions table (fleet `_record_coding_session`).
 * `ticketId` is the column new rows carry; older rows encode it only in the
 * title ("[wf] TEAM-123 backend_dev"). A row with neither is nobody's to resume.
 */

const TITLE_TICKET_RE = /^\[wf\]\s+(\S+)\s/;

export function sessionTicketId(row) {
  if (!row) return null;
  if (typeof row.ticketId === "string" && row.ticketId) return row.ticketId;
  const m = TITLE_TICKET_RE.exec(String(row.title || ""));
  return m ? m[1] : null;
}

/**
 * Most recently touched session that belongs to `ticketId`, else null.
 * `rows` = every (workflow, agent, origin=workflow) session row.
 */
export function pickTicketSession(rows, ticketId) {
  if (!ticketId || !Array.isArray(rows)) return null;
  const mine = rows
    .filter(r => r && r.sessionId && sessionTicketId(r) === ticketId)
    .sort((x, y) => String(y.updatedAt || "").localeCompare(String(x.updatedAt || "")));
  return mine[0]?.sessionId || null;
}

/** Dispatch-context block for a ticket that has its own prior session. */
export function renderPriorSessionBlock(ticketId, sessionId) {
  return (
    `## Prior Coding Session (resume by DEFAULT)\n` +
    `This ticket (${ticketId}) already has a coding session in this workflow: ${sessionId}\n` +
    `Pass resume_session="${sessionId}" on your FIRST claude_code/codex/kiro call — it restores THIS TICKET's prior conversation and workspace (the code you wrote or reviewed, your findings, your decisions) instead of rebuilding that context from scratch.\n` +
    `- Reopened after review/QA feedback, or unblocked after the fix tickets you filed closed: resume — you are continuing the same work.\n` +
    `- Start fresh ONLY if the feedback explicitly calls for a clean-slate redo.\n` +
    `Never resume a session id from another ticket (a sibling's or parent's [coding-session] footer): one session is one git checkout and one CLI, and a second CLI in it collides with the first. Resume is best-effort — if the session is gone or busy you start fresh automatically. This supersedes any Ported Session instruction above; your own session already contains it.\n\n`
  );
}

/** Review-rejection resume note suffix for a reopened upstream ticket. */
export function renderRejectionSessionHint(sessionId) {
  if (!sessionId) return "";
  return (
    `\n\nYour previous coding session for this ticket: ${sessionId}. ` +
    `DEFAULT: pass it as resume_session on your first claude_code/codex/kiro call — it continues that ` +
    `conversation with its context intact. Start fresh only if the feedback demands a restart. Resume is best-effort.`
  );
}
