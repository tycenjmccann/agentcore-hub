/**
 * Escalation-gate decision helpers (TEAM-3971). Shared by the ticket transition
 * API; the orchestrator (lambda/orchestrator/index.mjs) and the Telegram bot
 * (deploy/telegram-bug-intake/index.mjs) carry the same title regex + decision
 * vocabulary in JS — keep the three in step.
 */

// Release-manager convergence escalation gate (blueprints/release-manager.md,
// "Escalation gate ticket") — the orchestrator and the Telegram bot match the
// same summary shape.
const ESCALATION_GATE_TITLE = /^Escalation #\d+: ship-review not converging/i;
const DECISIONS = ["continue", "merge-with-known-findings", "cancel"];
// What a bare approve means. The orchestrator's own gate comment tells the human
// "Approve this gate (transition it to Done) to accept the change set as it
// stands" — that IS merge-with-known-findings, and the human still owns the
// Merge Approval gate afterwards. Never default to `continue` (TEAM-3595).
const DEFAULT_APPROVE_DECISION = "merge-with-known-findings";

// Port of lambda/orchestrator/review-cap.mjs parseDecision: the LAST line that
// is nothing but `DECISION: <option>` (markdown noise tolerated) wins.
export function parseDecision(text: string | undefined | null): string | null {
  const line = /^[\s>*-]*(?:\*\*)?\s*decision\s*:\s*([a-z][a-z-]*)\s*(?:\*\*)?\s*\.?\s*$/i;
  let found: string | null = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const m = line.exec(raw);
    if (m && DECISIONS.includes(m[1].toLowerCase())) found = m[1].toLowerCase();
  }
  return found;
}

/**
 * TEAM-3971 — approving an escalation gate WITHOUT a DECISION line left the
 * release manager failing closed on every re-invoke (blueprint contract) while
 * the gate comment promised the human that approving accepts the change set.
 * Every human approve path (console + Telegram) lands here, so this is the one
 * place to honor that promise: a bare Done on an escalation gate carries
 * `DECISION: merge-with-known-findings`. An explicit DECISION always wins.
 */
export function withDefaultDecision(
  comment: string | undefined,
  targetStatus: string,
  ticketTitle: string | undefined
): { comment: string | undefined; decisionDefaulted: string | null } {
  if (targetStatus !== "done") return { comment, decisionDefaulted: null };
  if (!ESCALATION_GATE_TITLE.test(String(ticketTitle || ""))) return { comment, decisionDefaulted: null };
  if (parseDecision(comment)) return { comment, decisionDefaulted: null };
  return {
    comment: `${comment || "Approved from console"}\nDECISION: ${DEFAULT_APPROVE_DECISION}`,
    decisionDefaulted: DEFAULT_APPROVE_DECISION,
  };
}


