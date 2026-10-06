/**
 * The human-gate DECISION grammar (TEAM-5322 FR-9), split out of decision-contract.ts
 * by TEAM-5324 as a pure move — no behaviour change.
 *
 * This module imports NOTHING, so a client component (TicketDetailModal) can use the
 * one parser without pulling node's crypto into the browser bundle. decision-contract.ts
 * re-exports every name here unchanged, so it is still the TS mirror of
 * lambda/agentcore-hub-tickets/decision-contract.mjs, and
 * src/lib/workflow/decision-contract-parity.test.ts still pushes its truth table
 * through these functions (and fails if an import appears here).
 */

export const DECISION_REQUIRED = "decision_required";

/** The 409 `detail` when the hub cannot load the decision key to mint a token. */
export const DECISION_CHANNEL_UNAVAILABLE = "decision_channel_unavailable";

export const DECISION_OPTIONS_RE =
  /^\s*DECISION OPTIONS:\s*([a-z0-9][a-z0-9-]{0,39}(?:\s*\|\s*[a-z0-9][a-z0-9-]{0,39})+)\s*$/;
export const DECISION_ANSWER_RE =
  /^[\s*-]*(?:\*\*)?\s*DECISION\s*:\s*(override:)?([a-z0-9][a-z0-9-]{0,39})\s*(?:\*\*)?\s*\.?\s*$/i;

/** One option token, as a declaration spells it. */
export const DECISION_OPTION_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const FENCE_RE = /^\s*(```|~~~)/;

/** The 409 body POST /api/workflow/[id]/tickets/transition returns on a bound gate. */
export type DecisionRequiredResponse = {
  error: "Ticket transition rejected";
  reason: "decision_required";
  options: string[];
  detail?: string;
  /** TEAM-5338 F1: why the hub would not mint (requireHumanIdentity refusal). */
  identity?: "unauthenticated" | "default_identity" | "service_identity";
  ticketId: string;
  targetStatus: string;
};

/**
 * TEAM-5338 F8: the 200 body POST /api/workflow/[id]/tickets/transition returns when
 * the twin HOLDS an approved close (post-condition unmet): the gate is still In
 * Review behind `gate:verifying` until `verifyUntil`, and nothing downstream is
 * unblocked. A caller must not repaint the ticket as `targetStatus`. `status` is
 * the key the Telegram bridge branches on; `newStatus` is what the board shows.
 */
export type TransitionHeldResponse = {
  success: true;
  held: true;
  status: "verifying";
  ticketId: string;
  targetStatus: string;
  newStatus: "in_review";
  verifyUntil: string | null;
  postCondition: { met: false; detail: string | null };
  decision?: string;
  completionRecordWritten?: boolean;
};

function unfencedLines(text: string | null | undefined): string[] {
  if (typeof text !== "string" || text === "") return [];
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line);
  }
  return out;
}

/** The options a description declares (LAST unfenced declaration wins), or null. */
export function parseDecisionOptions(description: string | null | undefined): string[] | null {
  let found: string | null = null;
  for (const line of unfencedLines(description)) {
    const m = DECISION_OPTIONS_RE.exec(line);
    if (m) found = m[1];
  }
  if (found === null) return null;
  const opts = Array.from(new Set(found.split("|").map((s) => s.trim()).filter(Boolean)));
  return opts.length >= 2 ? opts : null;
}

/** The answer a text carries for `options` (LAST matching unfenced line), or null. */
export function parseDecisionAnswer(
  text: string | null | undefined,
  options: readonly string[]
): { option: string; override: boolean } | null {
  if (!Array.isArray(options) || options.length === 0) return null;
  let found: { option: string; override: boolean } | null = null;
  for (const line of unfencedLines(text)) {
    const m = DECISION_ANSWER_RE.exec(line);
    if (!m) continue;
    const option = m[2].toLowerCase();
    if (options.includes(option)) found = { option, override: Boolean(m[1]) };
  }
  return found;
}

/** True when the twins will refuse to close this ticket without a signed decision. */
export function isDecisionBound(ticket: { assignee?: string; description?: string }): boolean {
  return String(ticket?.assignee || "").startsWith("human:") && parseDecisionOptions(ticket?.description) !== null;
}
