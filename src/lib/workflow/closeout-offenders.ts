/**
 * The close-out offenders of a run (TEAM-5358 FR-1, F4, F7): every done gate-class
 * ticket whose closure is not backed by evidence its owner produced. One evaluator,
 * two callers: POST /complete refuses on a non-empty list, and the closeout-override
 * route signs exactly this list. They cannot disagree about what a human overrode.
 *
 * A ticket is satisfied by one of:
 *   - human gate: a verified v3 gate decision record for this run and ticket, status done;
 *   - agent gate: its completions record, written by its assignee (gateClassRecordSatisfies);
 *   - either: a sweep skip record naming a same-parent sweeper that did real work.
 * A read that fails (other than not-found) makes the ticket an offender: this
 * evaluator only fails closed.
 */

import {
  gateClassRecordSatisfies,
  isGateClassTicket,
  isHumanGateTicket,
  sweepSkipSweeperOf,
} from "./completion-evidence";
import { gateDecisionRecordKey, verifyGateDecisionRecord } from "./gate-decision-record";

export type CloseoutTicket = Record<string, unknown>;

export type CloseoutOffenderWhy =
  | "no_record"
  | "no_evidence"
  | "console_record"
  | "agent_mismatch"
  | "no_decision_record"
  | "decision_not_done"
  | "decision_key_unavailable"
  | "record_unreadable";

export interface CloseoutOffender {
  ticketId: string;
  title: string;
  phase: string | null;
  assignee: string | null;
  why: CloseoutOffenderWhy;
}

export interface CloseoutOffenderDeps {
  workflowId: string;
  tickets: CloseoutTicket[];
  phaseOf: (t: CloseoutTicket) => string | undefined;
  /** Parsed JSON at `key`, null when the object does not exist; throws on any other failure. */
  readJson: (key: string) => Promise<unknown>;
  /** Gate-decision keys, or null when they cannot be loaded (human gates then cannot verify). */
  decisionKeys: readonly string[] | null;
}

const completionKey = (ticketId: string) => `completions/${ticketId}.json`;

class Unreadable extends Error {}

async function read(deps: CloseoutOffenderDeps, key: string): Promise<unknown> {
  try {
    return await deps.readJson(key);
  } catch {
    throw new Unreadable(key);
  }
}

/** Port of the twins' sweeperProvesSkip, against the run's own roster. */
async function sweepProvesSkip(deps: CloseoutOffenderDeps, ticket: CloseoutTicket, record: unknown): Promise<boolean> {
  const ticketId = String(ticket.ticketId || "");
  const sweeperId = sweepSkipSweeperOf(record, ticketId, deps.workflowId);
  if (!sweeperId) return false;
  const sweeper = deps.tickets.find((t) => t.ticketId === sweeperId);
  if (!sweeper || !ticket.parentId || sweeper.parentId !== ticket.parentId) return false;
  if (sweeper.workflowId && sweeper.workflowId !== deps.workflowId) return false;
  const status = String(sweeper.status || "").toLowerCase();
  if (status === "done") return true;
  if (status !== "in_progress") return false;
  const own = (await read(deps, completionKey(sweeperId))) as Record<string, unknown> | null;
  return Boolean(own && typeof own === "object" && own.workflowId === deps.workflowId && own.evidence_kind !== "skipped" && own.skipped !== true);
}

async function judge(deps: CloseoutOffenderDeps, t: CloseoutTicket): Promise<CloseoutOffenderWhy | null> {
  const ticketId = String(t.ticketId || "");
  if (isHumanGateTicket(t)) {
    const decision = await read(deps, gateDecisionRecordKey(deps.workflowId, ticketId));
    const r = decision as Record<string, unknown> | null;
    if (r && deps.decisionKeys && verifyGateDecisionRecord(r, deps.decisionKeys) && r.ticketId === ticketId && r.workflowId === deps.workflowId) {
      return r.status === "done" ? null : "decision_not_done";
    }
    // An unverifiable record is no record.
    const completion = await read(deps, completionKey(ticketId));
    if (await sweepProvesSkip(deps, t, completion)) return null;
    return r && !deps.decisionKeys ? "decision_key_unavailable" : "no_decision_record";
  }
  const completion = await read(deps, completionKey(ticketId));
  if (await sweepProvesSkip(deps, t, completion)) return null;
  const verdict = gateClassRecordSatisfies(completion, t);
  return verdict.ok ? null : verdict.why;
}

/** Offenders in roster order; empty = every done gate-class ticket is backed. */
export async function closeoutOffenders(deps: CloseoutOffenderDeps): Promise<CloseoutOffender[]> {
  const offenders: CloseoutOffender[] = [];
  for (const t of deps.tickets) {
    if (String(t.status || "").toLowerCase() !== "done") continue;
    if (!isGateClassTicket(t, (x) => deps.phaseOf(x as CloseoutTicket))) continue;
    let why: CloseoutOffenderWhy | null;
    try {
      why = await judge(deps, t);
    } catch (err) {
      if (!(err instanceof Unreadable)) throw err;
      why = "record_unreadable";
    }
    if (!why) continue;
    offenders.push({
      ticketId: String(t.ticketId || ""),
      title: String(t.title || ""),
      phase: deps.phaseOf(t) ?? null,
      assignee: typeof t.assignee === "string" ? t.assignee : null,
      why,
    });
  }
  return offenders;
}
