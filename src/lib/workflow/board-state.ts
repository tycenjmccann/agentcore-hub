/**
 * Pure agentTask-map transforms shared by WorkflowBoard's replay reducer and
 * live SSE handler — one place for the "when may a completed agent go back to
 * running" rule. A review-gate rework re-runs the SAME ticket, so ticketId
 * alone can't distinguish a rework re-invocation from a late/duplicate event;
 * the event timestamp vs the task's completedAt can.
 */

import type { AgentTask, AgentTaskStatus } from "./types";

interface AgentStatusEventLike {
  agentId: string;
  status: AgentTaskStatus;
  ticketId?: string;
  timestamp?: string;
}

interface AgentCompleteEventLike {
  agentId: string;
  output?: string;
  branch?: string;
  commitSha?: string;
  timestamp?: string;
}

/**
 * A completed task may regress to running only for:
 *  - a NEW ticket (QA fix-it fan-out re-invokes the agent on a fresh ticket), or
 *  - a rework re-run of the SAME ticket: the status event was published AFTER
 *    the completion. Late/duplicate events carry older timestamps, so they
 *    still can't resurrect a finished agent.
 * Unparseable/missing timestamps keep the original blocking behavior.
 */
export function canRegressCompletedTask(
  task: Pick<AgentTask, "ticketId" | "completedAt">,
  event: AgentStatusEventLike
): boolean {
  if (event.ticketId && event.ticketId !== task.ticketId) return true;
  const eventTs = Date.parse(event.timestamp || "");
  const completedTs = Date.parse(task.completedAt || "");
  return Number.isFinite(eventTs) && Number.isFinite(completedTs) && eventTs > completedTs;
}

/**
 * Apply an agent_status event. Returns the next tasks map, or null when the
 * event must be ignored (late/duplicate status for an already-completed task).
 */
export function applyAgentStatus(
  tasks: Record<string, AgentTask>,
  event: AgentStatusEventLike
): Record<string, AgentTask> | null {
  const existing = tasks[event.agentId];
  if (!existing) {
    return {
      ...tasks,
      [event.agentId]: {
        id: `task_${Date.now()}`,
        agentId: event.agentId,
        ticketId: event.ticketId || "",
        status: event.status,
        input: "",
      },
    };
  }
  if (existing.status === "complete" && !canRegressCompletedTask(existing, event)) {
    return null;
  }
  const isNewTicket = !!event.ticketId && event.ticketId !== existing.ticketId;
  const regressing = existing.status === "complete" && event.status !== "complete";
  return {
    ...tasks,
    [event.agentId]: {
      ...existing,
      status: event.status,
      ...(isNewTicket ? { ticketId: event.ticketId } : {}),
      // A rework re-run is a fresh attempt — its old completion stamp must not
      // block this run's own completion→rework cycle or force its ticket done.
      ...(regressing ? { completedAt: undefined } : {}),
    },
  };
}

/**
 * Apply an agent_complete event: mark complete and stamp completedAt from the
 * event, so a later rework re-run (same ticket) can prove it started after
 * this completion. Keeps the longer output (accumulated streamed text often
 * beats the event's truncated copy). Returns null when no task matches.
 */
export function applyAgentComplete(
  tasks: Record<string, AgentTask>,
  event: AgentCompleteEventLike
): Record<string, AgentTask> | null {
  const key = tasks[event.agentId]
    ? event.agentId
    : Object.keys(tasks).find((k) => tasks[k].agentId === event.agentId);
  if (!key) return null;
  const existing = tasks[key];
  const existingOutput = existing.output || "";
  const newOutput = event.output || "";
  return {
    ...tasks,
    [key]: {
      ...existing,
      status: "complete",
      completedAt: event.timestamp || new Date().toISOString(),
      output: newOutput.length > existingOutput.length ? newOutput : existingOutput,
      branch: event.branch,
      commitSha: event.commitSha,
    },
  };
}

/**
 * The Jira search index lags real transitions, so a completed agentTask
 * normally overrides a stale open ticket to "done" on the board. EXCEPT during
 * rework: the review gate reopened the ticket AFTER the agent completed — a
 * ticket updated after completedAt is trusted as genuinely open.
 */
export function shouldForceTicketDone(
  task: { status?: string; completedAt?: string },
  ticket: { status?: string; updatedAt?: string } | undefined
): boolean {
  if (task.status !== "complete") return false;
  if (!ticket || ticket.status === "done") return false;
  const completedTs = Date.parse(task.completedAt || "");
  const updatedTs = Date.parse(ticket.updatedAt || "");
  if (Number.isFinite(completedTs) && Number.isFinite(updatedTs) && updatedTs > completedTs) {
    return false; // reopened after completion — rework in flight
  }
  return true;
}
