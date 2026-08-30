/**
 * Workflow command queue (R1 of the race-condition plan — docs/race-condition-study.md).
 *
 * Every workflow trigger becomes a COMMAND on an SQS FIFO queue instead of a
 * direct Lambda invoke. MessageGroupId serializes all commands for one
 * workflow (FIFO processes one group strictly in order) while different
 * workflows still run in parallel. This removes intra-workflow concurrency —
 * the root cause behind the duplicate-invocation / double-cascade guard
 * whack-a-mole catalogued in the study.
 *
 * Group key: the workflow ROOT issue key (epic, or the Bug itself for
 * bug-fix runs). Every ticket event carries it as `parent.key`; root-issue
 * events use their own key. All tickets of a run share one root, so one
 * group = one workflow. (A Bug's pre-bootstrap events group under its own
 * key and post-bootstrap sub-task events under the same key — consistent.)
 *
 * Dedup key: Jira redelivers webhooks at-least-once with the SAME event
 * timestamp. (issueKey, newStatus, timestamp) collapses redeliveries while
 * still admitting a genuine re-transition to the same status later (e.g.
 * Ready → In Progress → Ready after a reopen).
 */

export interface WorkflowCommand {
  source: "jira-webhook";
  ticketId: string;
  newStatus: string;
  oldStatus: string;
}

/** All commands for one workflow serialize under its root issue key. */
export function commandGroupId(issueKey: string, parentKey?: string): string {
  return parentKey || issueKey;
}

/**
 * Collapse at-least-once redeliveries. `eventTimestamp` is Jira's own
 * webhook `timestamp` (epoch ms) — identical across redeliveries of one
 * event, different for a later re-transition to the same status.
 */
export function commandDedupId(
  issueKey: string,
  newStatus: string,
  eventTimestamp?: number | string
): string {
  // No timestamp (unexpected) → fall back to a unique id: better to process
  // a duplicate (handlers are guarded) than to silently drop a real event.
  const stamp = eventTimestamp ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Dedup IDs allow alphanumerics + punctuation, max 128 chars.
  return `${issueKey}:${newStatus}:${stamp}`.replace(/[^a-zA-Z0-9:_.-]/g, "_").slice(0, 128);
}
