/**
 * TEAM-5339 — the ONE place a client reads POST /api/workflow/[id]/tickets/transition's
 * response. TicketDetailModal.tsx used to repaint the ticket as `targetStatus` on any
 * `res.ok`, which is wrong for a held gate (TEAM-5338 FR-10): the route answers 200
 * with `held:true, status:"verifying", newStatus:"in_review"` and the caller must not
 * treat that as Done. See docs/workflow/gate-verify-lifecycle.md.
 *
 * Dependency-free (like ./decision-grammar, which this imports): a client component
 * can use it without pulling node's crypto (decision-contract.ts) into the bundle.
 */

import {
  DECISION_CHANNEL_UNAVAILABLE,
  DECISION_REQUIRED,
  GATE_APPROVED_UNVERIFIED_RE,
  GATE_VERIFYING_RE,
} from "./decision-grammar";
import type { TicketStatus } from "./types";

const VALID_STATUSES: readonly TicketStatus[] = [
  "backlog", "todo", "ready", "in_progress", "in_review", "done", "blocked", "cancelled",
];

function isTicketStatus(s: unknown): s is TicketStatus {
  return typeof s === "string" && (VALID_STATUSES as readonly string[]).includes(s);
}

/** The result of parsing one transition response, independent of HTTP plumbing. */
export type TransitionOutcome =
  | { kind: "moved"; status: TicketStatus; decision?: string }
  | { kind: "held"; status: "in_review"; verifyUntil: string | null; detail: string | null; decision?: string }
  | { kind: "decision"; notice: "required" | "channel" | "service"; options: string[] }
  | { kind: "error"; message: string };

/**
 * Parse POST .../tickets/transition's response. Never falls back to the
 * caller's own `targetStatus` — a held gate or an unrecognized body must not be
 * repainted as the status the caller asked for.
 */
export function parseTransitionResponse(httpStatus: number, body: unknown): TransitionOutcome {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  if (httpStatus >= 200 && httpStatus < 300) {
    // TEAM-5338 F8: held is reported inside a 2xx — `held`/`status` are the keys,
    // never `newStatus === targetStatus`.
    if (b.held === true || b.status === "verifying") {
      const postCondition = (b.postCondition && typeof b.postCondition === "object" ? b.postCondition : {}) as Record<string, unknown>;
      return {
        kind: "held",
        status: "in_review",
        verifyUntil: typeof b.verifyUntil === "string" ? b.verifyUntil : null,
        detail: typeof postCondition.detail === "string" ? postCondition.detail : null,
        ...(typeof b.decision === "string" ? { decision: b.decision } : {}),
      };
    }
    if (isTicketStatus(b.newStatus)) {
      return {
        kind: "moved",
        status: b.newStatus,
        ...(typeof b.decision === "string" ? { decision: b.decision } : {}),
      };
    }
    // A 2xx with no recognizable newStatus is NOT a reason to guess targetStatus.
    return { kind: "error", message: "Transition response had no recognizable status" };
  }

  if (b.reason === DECISION_REQUIRED) {
    if (httpStatus === 403) return { kind: "decision", notice: "service", options: [] };
    if (b.detail === DECISION_CHANNEL_UNAVAILABLE) return { kind: "decision", notice: "channel", options: [] };
    return {
      kind: "decision",
      notice: "required",
      options: Array.isArray(b.options) ? (b.options as string[]) : [],
    };
  }

  const message = typeof b.error === "string" && b.error ? b.error : `HTTP ${httpStatus}`;
  return { kind: "error", message };
}

/** What a loaded ticket's own labels (+ gateVerify, DynamoDB mode only) say about a hold. */
export type GateHoldState =
  | { kind: "verifying"; verifyUntil: string | null }
  | { kind: "approved-unverified" };

/**
 * TEAM-5339 (requirement 4): a modal opened fresh must not show stale state —
 * read the hold straight off the ticket's own labels, so reopening after a close
 * (or a reprobe that ran while the modal was shut) shows the right banner without
 * waiting for another transition response.
 *
 * `gateVerify.verifyUntil` is DynamoDB-only (lambda/agentcore-hub-tickets
 * buildGateVerify): the attribute rides the raw ticket row, which the dynamodb-mode
 * tickets route returns unprojected. Jira mode keeps the record as an issue
 * property the tickets route doesn't fetch, so `verifyUntil` is null there — the
 * banner just omits the time.
 */
export function gateHoldState(ticket: { labels?: unknown; gateVerify?: unknown }): GateHoldState | null {
  const labels = Array.isArray(ticket?.labels) ? (ticket.labels as unknown[]) : [];
  const strings = labels.filter((l): l is string => typeof l === "string");
  if (strings.some((l) => GATE_APPROVED_UNVERIFIED_RE.test(l))) {
    return { kind: "approved-unverified" };
  }
  if (strings.some((l) => GATE_VERIFYING_RE.test(l))) {
    const gv = (ticket.gateVerify && typeof ticket.gateVerify === "object" ? ticket.gateVerify : {}) as Record<string, unknown>;
    return { kind: "verifying", verifyUntil: typeof gv.verifyUntil === "string" ? gv.verifyUntil : null };
  }
  return null;
}
