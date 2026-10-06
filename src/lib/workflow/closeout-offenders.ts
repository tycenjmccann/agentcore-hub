/**
 * The close-out offenders of a run (TEAM-5358 FR-1, F4, F7): every done gate-class
 * ticket whose closure is not backed by evidence its owner produced. One evaluator,
 * two callers: POST /complete refuses on a non-empty list, and the closeout-override
 * route signs exactly this list. They cannot disagree about what a human overrode.
 *
 * A ticket is satisfied by one of:
 *   - human gate: a verified v3 gate decision record for this run and ticket, status done;
 *   - agent gate: its completions record, written by its assignee (gateClassRecordSatisfies).
 *     A legacy record that names no agent is accepted with a `legacy_no_agent_id`
 *     warning: records carry no agent identity until TEAM-5358 3f deploys;
 *   - either: a sweep skip record naming a same-parent sweeper that did real work.
 * A read that fails (other than not-found) makes the ticket an offender: this
 * evaluator only fails closed.
 *
 * closeoutState() is the whole close-out verdict both routes act on: the
 * missing-evidence tickets (TEAM-3619 D4a / TEAM-3976, moved here from /complete),
 * the gate offenders, and whether the row was refused before. `offenderIds`, the
 * union of the first two, is what an override must name, which is also what the
 * orchestrator's completion.mjs compares against.
 */

import agentsConfig from "@/config/agents.json";
import { resolveWorkflowDef } from "./defs-loader";
import {
  type EvidenceEntryLike,
  type ResolveEvidenceDeps,
  hasCompletionBlockedNotice,
  resolveMissingEvidenceFromRecords,
  type GateRecordOffence,
  type GateRecordWarning,
  gateClassRecordSatisfies,
  isGateClassTicket,
  isHumanGateTicket,
  sweepSkipSweeperOf,
} from "./completion-evidence";
import { gateDecisionRecordKey, verifyGateDecisionRecord } from "./gate-decision-record";

export type CloseoutTicket = Record<string, unknown>;

export type CloseoutOffenderWhy =
  | GateRecordOffence
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

/** A gate ticket that passed with a caveat; never blocks, always reported. */
export interface CloseoutWarning {
  ticketId: string;
  title: string;
  phase: string | null;
  assignee: string | null;
  why: GateRecordWarning;
}

export interface CloseoutReview {
  offenders: CloseoutOffender[];
  warnings: CloseoutWarning[];
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

type Judgement = { why: CloseoutOffenderWhy } | { warning: GateRecordWarning } | null;

async function judge(deps: CloseoutOffenderDeps, t: CloseoutTicket): Promise<Judgement> {
  const ticketId = String(t.ticketId || "");
  if (isHumanGateTicket(t)) {
    const decision = await read(deps, gateDecisionRecordKey(deps.workflowId, ticketId));
    const r = decision as Record<string, unknown> | null;
    if (r && deps.decisionKeys && verifyGateDecisionRecord(r, deps.decisionKeys) && r.ticketId === ticketId && r.workflowId === deps.workflowId) {
      return r.status === "done" ? null : { why: "decision_not_done" };
    }
    // An unverifiable record is no record.
    const completion = await read(deps, completionKey(ticketId));
    if (await sweepProvesSkip(deps, t, completion)) return null;
    return { why: r && !deps.decisionKeys ? "decision_key_unavailable" : "no_decision_record" };
  }
  const completion = await read(deps, completionKey(ticketId));
  if (await sweepProvesSkip(deps, t, completion)) return null;
  const verdict = gateClassRecordSatisfies(completion, t);
  if (!verdict.ok) return { why: verdict.why };
  return verdict.warning ? { warning: verdict.warning } : null;
}

/** Offenders and warnings in roster order; no offenders = every done gate-class ticket is backed. */
export async function closeoutReview(deps: CloseoutOffenderDeps): Promise<CloseoutReview> {
  const review: CloseoutReview = { offenders: [], warnings: [] };
  for (const t of deps.tickets) {
    if (String(t.status || "").toLowerCase() !== "done") continue;
    if (!isGateClassTicket(t, (x) => deps.phaseOf(x as CloseoutTicket))) continue;
    let j: Judgement;
    try {
      j = await judge(deps, t);
    } catch (err) {
      if (!(err instanceof Unreadable)) throw err;
      j = { why: "record_unreadable" };
    }
    if (!j) continue;
    const who = {
      ticketId: String(t.ticketId || ""),
      title: String(t.title || ""),
      phase: deps.phaseOf(t) ?? null,
      assignee: typeof t.assignee === "string" ? t.assignee : null,
    };
    if ("why" in j) review.offenders.push({ ...who, why: j.why });
    else review.warnings.push({ ...who, why: j.warning });
  }
  return review;
}

/** Just the offenders (what an override must name). */
export async function closeoutOffenders(deps: CloseoutOffenderDeps): Promise<CloseoutOffender[]> {
  return (await closeoutReview(deps)).offenders;
}

// ─── The whole close-out verdict ───────────────────────────────────────────────

// agentId → agent phase, from the bundled roster (same doc the pipeline reads).
const AGENT_PHASE_BY_ID: Record<string, string> = Object.fromEntries(
  (agentsConfig.agents as Array<{ agentId: string; phase: string }>).map((a) => [a.agentId, a.phase])
);

/** The agent phase a child ticket belongs to: an explicit `phase` stamp wins
 *  (TEAM-3619 D4c routes spawned fixes to their originating upstream phase),
 *  else derive it from the assignee's roster phase. Undefined for humans/unknowns. */
export function phaseOfTicket(t: CloseoutTicket): string | undefined {
  if (typeof t.phase === "string" && t.phase) return t.phase;
  const assignee = typeof t.assignee === "string" ? t.assignee : "";
  return AGENT_PHASE_BY_ID[assignee];
}

export type MissingEvidence = { ticketId: string; phase: string };

export interface AgentTaskLike {
  ticketId?: string;
  output?: unknown;
  artifactKey?: unknown;
}

/**
 * TEAM-3619 D4a deliverable-evidence check. For every DONE (not cancelled) child
 * ticket whose phase is one the def requires for completion, assert its agentTask
 * entry carries proof of work: a non-empty `output` OR an `artifactKey`. A "done"
 * ticket with an empty task is a phantom deliverable. Tickets whose phase we can't
 * resolve, or that aren't a required phase, are left alone.
 */
export function missingEvidenceTickets(
  tickets: CloseoutTicket[],
  agentTasks: Record<string, AgentTaskLike>,
  requiredPhases: string[]
): MissingEvidence[] {
  if (!requiredPhases.length) return [];
  const required = new Set(requiredPhases);
  const tasks = agentTasks && typeof agentTasks === "object" ? agentTasks : {};
  const byTicketId = new Map<string, AgentTaskLike>();
  for (const entry of Object.values(tasks)) {
    if (entry && typeof entry.ticketId === "string") byTicketId.set(entry.ticketId, entry);
  }
  const missing: MissingEvidence[] = [];
  for (const t of tickets) {
    if (t.type === "epic") continue;
    if (String(t.status || "").toLowerCase() !== "done") continue; // cancelled excluded
    // Human review gates owe no deliverable (PARITY with completion.mjs
    // isHumanGateTicket): hub-materialized gates carry `phase:<afterPhase>`, so
    // phaseOfTicket resolves them into a required phase with no agentTask evidence.
    if (isHumanGateTicket(t)) continue;
    const phase = phaseOfTicket(t);
    if (!phase || !required.has(phase)) continue;
    const ticketId = String(t.ticketId || "");
    const entry = tasks[ticketId] || byTicketId.get(ticketId);
    const hasOutput = typeof entry?.output === "string" && entry.output.trim().length > 0;
    const hasArtifact = typeof entry?.artifactKey === "string" && entry.artifactKey.length > 0;
    if (!hasOutput && !hasArtifact) missing.push({ ticketId, phase });
  }
  return missing;
}

/**
 * TEAM-3619 D4a / TEAM-3690: the evidence gate is ON unless explicitly opted out
 * (COMPLETION_EVIDENCE_REQUIRED=off|false|0); any other value enforces. The opt-out
 * covers missing evidence only, never the gate-class offenders (TEAM-5358 FR-1).
 */
export function completionEvidenceRequired(): boolean {
  return !/^(off|false|0)$/i.test((process.env.COMPLETION_EVIDENCE_REQUIRED || "").trim());
}

export interface CloseoutStateDeps {
  workflowId: string;
  workflow: Record<string, unknown>;
  tickets: CloseoutTicket[];
  /** Parsed JSON at `key`, null when absent; throws on any other failure. Null disables record reads. */
  readJson: ((key: string) => Promise<unknown>) | null;
  decisionKeys: readonly string[] | null;
  /** /complete self-heals agentTasks from a found record (TEAM-3976); the override route does not. */
  backfill?: ResolveEvidenceDeps["backfill"];
  log?: (msg: string) => void;
}

export interface CloseoutState extends CloseoutReview {
  missing: MissingEvidence[];
  /** missing ∪ gate offenders: what a covering override must name. */
  offenderIds: string[];
  /** The row carries a notif_completion_* notice (it was refused before). */
  blockedBefore: boolean;
}

const noRecords = async (): Promise<null> => null;

export async function closeoutState(deps: CloseoutStateDeps): Promise<CloseoutState> {
  const log = deps.log || console.warn;
  const readJson = deps.readJson || noRecords;
  let missing: MissingEvidence[] = [];
  try {
    const def = await resolveWorkflowDef(String(deps.workflow.workflowDefId || ""));
    const requiredPhases = def?.completionRequiresAgentPhases || [];
    const agentTasks = (deps.workflow.agentTasks as Record<string, EvidenceEntryLike & AgentTaskLike>) || {};
    missing = missingEvidenceTickets(deps.tickets, agentTasks, requiredPhases);
    // TEAM-3976: a ticket closed out-of-band (mark_done) BEFORE its
    // report_completion landed has an evidence-less agentTasks entry. Consult the
    // authoritative completions/{ticketId}.json for the would-be offenders ONLY (no
    // S3 reads on the happy path). The resolver swallows read/backfill failures
    // itself: a failed read keeps the offender.
    if (missing.length > 0 && deps.readJson) {
      missing = await resolveMissingEvidenceFromRecords(missing, agentTasks, {
        readCompletionRecord: async (ticketId) => (await readJson(`completions/${ticketId}.json`)) as Record<string, unknown> | null,
        backfill: deps.backfill || (async () => {}),
        log,
      });
    }
    if (missing.length > 0 && !completionEvidenceRequired()) {
      log(
        `[closeout] ${deps.workflowId} would be blocked for missing evidence (shadow opt-out): ` +
          missing.map((m) => `${m.ticketId}@${m.phase}`).join(", ")
      );
      missing = [];
    }
  } catch (err) {
    // Never let evidence resolution (def load) turn a legitimate completion into a
    // 500: the evidence gate only tightens when it can prove a phantom deliverable.
    missing = [];
    log(`[closeout] evidence check skipped: ${(err as Error).message}`);
  }

  const review = await closeoutReview({
    workflowId: deps.workflowId,
    tickets: deps.tickets,
    phaseOf: phaseOfTicket,
    readJson,
    decisionKeys: deps.decisionKeys,
  });
  const offenderIds = [...new Set([...missing.map((m) => m.ticketId), ...review.offenders.map((o) => o.ticketId)])];
  return { ...review, missing, offenderIds, blockedBefore: hasCompletionBlockedNotice(deps.workflow) };
}
