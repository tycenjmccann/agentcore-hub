/**
 * TEAM-6146 — the ONE shared source for "Jira status display name -> hub internal
 * status" on the src/ side. Extracted out of ticket-transition-refusal.ts (where it
 * started life as a private TEAM-6141 mirror) so the webhook route, jira-client.ts,
 * ticket-provider-jira.ts and jira-read.ts can all import it instead of carrying their
 * own partial copies.
 *
 * TEAM-6141 — mirror of the jira Lambda's status map (INTERNAL_TO_JIRA / JIRA_TO_INTERNAL /
 * mapStatusToInternal in lambda/agentcore-hub-jira/index.mjs). The Lambda ships as a
 * self-contained zip, so the two copies cannot share a file; parity is pinned against the
 * REAL Lambda module by ticket-transition-refusal.jira-e2e.test.ts and (TEAM-6146)
 * jira-status-map-parity.test.ts. Edit the Lambda first.
 */
import type { TicketStatus } from "./types";

function normalizeStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** The hub's own columns. A Jira move that lands in one of these is proof only when it IS the target. */
export const HUB_STATUSES = ["todo", "ready", "in_progress", "in_review", "blocked", "done", "cancelled"];

const INTERNAL_TO_JIRA: Record<string, string> = {
  todo: "To Do",
  ready: "Ready",
  in_progress: "In Progress",
  in_review: "In Review",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Won't Do",
};
const JIRA_TO_INTERNAL: Record<string, string> = {
  ...Object.fromEntries(Object.entries(INTERNAL_TO_JIRA).map(([k, v]) => [v.toLowerCase(), k])),
  "wont do": "cancelled",
  cancelled: "cancelled",
  canceled: "cancelled",
};

/** What the Lambda reports as `status` for a Jira status name (its mapStatusToInternal). */
export function jiraStatusToInternal(name: unknown): string {
  const n = normalizeStatus(name);
  return JIRA_TO_INTERNAL[n] || n.replace(/\s+/g, "_");
}

/**
 * The Jira display name the Lambda matches a requested internal status against — its
 * `effectiveStatus` (`INTERNAL_TO_JIRA[target] || target`), lowercased as it compares it.
 */
export function jiraDisplayNameOf(target: string): string {
  return normalizeStatus(INTERNAL_TO_JIRA[target] ?? target);
}

/** Every TicketStatus the board can show — HUB_STATUSES plus `backlog`, which the Lambda
 *  never targets (it is a pre-dispatch board state, not a Jira-side status). */
const TICKET_STATUSES = new Set<TicketStatus>([...HUB_STATUSES, "backlog"] as TicketStatus[]);

/**
 * The board's reading of a Jira status name: the Lambda's own mapping
 * (jiraStatusToInternal) when that lands on a status the hub models, else "todo" — a
 * status the board doesn't know renders in To Do, as every board reader already did
 * before this file existed.
 */
export function jiraStatusToTicketStatus(name: unknown): TicketStatus {
  const s = jiraStatusToInternal(name);
  return TICKET_STATUSES.has(s as TicketStatus) ? (s as TicketStatus) : "todo";
}
