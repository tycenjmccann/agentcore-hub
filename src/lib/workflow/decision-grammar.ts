/**
 * The human-gate DECISION grammar (TEAM-5322 FR-9), split out of decision-contract.ts
 * by TEAM-5324 as a pure move — no behaviour change.
 *
 * This module imports nothing but the zero-import completion-evidence.ts (TEAM-5371: the
 * one human-gate rule), so a client component (TicketDetailModal) can use the
 * one parser without pulling node's crypto into the browser bundle. decision-contract.ts
 * re-exports every name here unchanged, so it is still the TS mirror of
 * lambda/agentcore-hub-tickets/decision-contract.mjs, and
 * src/lib/workflow/decision-contract-parity.test.ts still pushes its truth table
 * through these functions (and fails if an import appears here).
 */

import { isHumanGateTicket } from "./completion-evidence";

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

// TEAM-5358 FR-6: admitted on every human gate whatever DECISION OPTIONS says; it
// only ever cancels the gate (see the .mjs).
export const UNIVERSAL_DECISION_OPTIONS: readonly string[] = Object.freeze(["stopped"]);

/** The declared options plus the universal ones, declared first, deduped. */
export function admittedOptions(declared: readonly string[] | null | undefined): string[] {
  return Array.from(new Set([...(Array.isArray(declared) ? declared : []), ...UNIVERSAL_DECISION_OPTIONS]));
}

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
  /** TEAM-5358 F4: evidence was sent for a gate-class ticket and NOT recorded. */
  evidenceRecorded?: false;
  reason?: "gate_class";
};

/** The ordinary 200 body — every success that isn't a held gate (TEAM-5339). */
export type TransitionDoneResponse = {
  success: true;
  ticketId: string;
  newStatus: string;
  decision?: string;
  completionRecordWritten?: boolean;
  /** TEAM-5358 F4: evidence was sent for a gate-class ticket and NOT recorded. */
  evidenceRecorded?: false;
  reason?: "gate_class";
};

/**
 * TEAM-5339: TS mirrors of the gate labels the reprobe writes
 * (lambda/agentcore-hub-tickets/gate-contract.mjs GATE_VERIFYING_RE /
 * GATE_APPROVED_UNVERIFIED_RE, byte-identical in the jira twin). `[:-]` because
 * Jira rewrites a colon in a label to a hyphen on write.
 */
export const GATE_VERIFYING_RE = /^gate[:-]verifying$/;
export const GATE_APPROVED_UNVERIFIED_RE = /^gate[:-]approved-unverified$/;

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
  const admitted = admittedOptions(options);
  let found: { option: string; override: boolean } | null = null;
  for (const line of unfencedLines(text)) {
    const m = DECISION_ANSWER_RE.exec(line);
    if (!m) continue;
    const option = m[2].toLowerCase();
    if (admitted.includes(option)) found = { option, override: Boolean(m[1]) };
  }
  return found;
}

/** True when the twins will refuse to close this ticket without a signed decision. */
export function isDecisionBound(ticket: { assignee?: string; labels?: unknown; description?: string }): boolean {
  return isHumanGateTicket(ticket) && parseDecisionOptions(ticket?.description) !== null;
}

// ── Gate scope (TEAM-5358 F3; the .mjs's parseGateScope, ported) ─────────────

/** `<ticket>:<8 hex>` — residualFindingId's shape. */
export const FINDING_ID_RE = /^[A-Za-z0-9_-]+:[0-9a-f]{8}$/;
export const GATE_SCOPE_MAX_FINDINGS = 50;
const GATE_SCOPE_LINE_RE = /^\s*gate-scope:\s*(.*)$/;
const GATE_SCOPE_HEAD_RE = /^[0-9a-f]{40}$/i;

export type GateScope = { round: number; headSha: string; findingIds: string[] };

/** The LAST `gate-scope: {…}` line, validated (findingIds deduped + sorted), or null. */
export function parseGateScope(description: string | null | undefined): GateScope | null {
  const lines = String(description ?? "")
    .split(/\r?\n/)
    .map((l) => GATE_SCOPE_LINE_RE.exec(l))
    .filter((m): m is RegExpExecArray => m !== null);
  if (lines.length === 0) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;
  try {
    raw = JSON.parse(lines[lines.length - 1][1]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const round =
    typeof raw.round === "number"
      ? raw.round
      : typeof raw.round === "string" && /^\s*\d+\s*$/.test(raw.round)
        ? Number(raw.round)
        : NaN;
  if (!Number.isInteger(round) || round < 1) return null;
  const headSha = typeof raw.headSha === "string" ? raw.headSha.trim().toLowerCase() : "";
  if (!GATE_SCOPE_HEAD_RE.test(headSha)) return null;
  if (!Array.isArray(raw.findingIds) || raw.findingIds.length === 0 || raw.findingIds.length > GATE_SCOPE_MAX_FINDINGS) return null;
  const ids: string[] = raw.findingIds.map((id: unknown) => (typeof id === "string" ? id.trim() : ""));
  if (ids.some((id) => !FINDING_ID_RE.test(id))) return null;
  return { round, headSha, findingIds: Array.from(new Set(ids)).sort() };
}
