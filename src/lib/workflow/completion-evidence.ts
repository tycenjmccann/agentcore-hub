/**
 * TEAM-3976 — completions-record fallback for the deliverable-evidence gate.
 *
 * PARITY with lambda/orchestrator/completion.mjs (completionRecordHasEvidence,
 * evidenceBackfillFields, resolveMissingEvidenceFromRecords). Hand-ported TS
 * twin used by POST /api/workflow/[id]/complete; the .mjs is the orchestrator's
 * copy. Keep them in agreement — completion-evidence-parity.test.ts pins both
 * pure functions against a shared fixture table.
 *
 * The gap this closes: a ticket transitioned to done OUT-OF-BAND (Workflow
 * Manager mark_done) before the agent's report_completion fired. The done
 * cascade's one-shot harvest found no completions/{tid}.json and left the
 * agentTasks entry evidence-less; the later report_completion wrote the record
 * but its transition_ticket(done) was a no-op (done→done), so no second harvest
 * ever ran. Both gates then refused forever on a ticket whose authoritative
 * record proves the deliverable. These helpers let the gates consult that
 * record for the would-be offenders ONLY (zero S3 reads on the happy path).
 */

/** Shape written by lambda/workflow-output reportCompletion to completions/{ticket_id}.json. */
export interface CompletionRecord {
  ticket_id?: unknown;
  summary?: unknown;
  artifacts?: unknown;
  branch?: unknown;
  commit_sha?: unknown;
  pr_url?: unknown;
  [key: string]: unknown;
}

/** Structural subset of an agentTasks entry — the route's AgentTaskLike satisfies it. */
export interface EvidenceEntryLike {
  ticketId?: unknown;
  output?: unknown;
  artifactKey?: unknown;
  branch?: unknown;
  commitSha?: unknown;
  prUrl?: unknown;
}

export interface MissingEvidenceTicket {
  ticketId: string;
  phase: string;
}

export interface BackfillFields {
  output?: string;
  branch?: string;
  commitSha?: string;
  prUrl?: string;
}

export interface ResolveEvidenceDeps {
  readCompletionRecord: (ticketId: string) => Promise<CompletionRecord | null>;
  backfill: (ticketId: string, fields: BackfillFields) => Promise<void>;
  log?: (msg: string) => void;
}

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * Does a completions/{ticketId}.json record (written by lambda/workflow-output
 * reportCompletion) prove the ticket produced a deliverable? A blank/empty
 * record is NOT evidence (TEAM-3690 / AC-D4.1).
 */
export function completionRecordHasEvidence(record: unknown): boolean {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const r = record as CompletionRecord;
  if (nonEmptyString(r.summary)) return true;
  if (nonEmptyString(r.pr_url)) return true;
  if (nonEmptyString(r.commit_sha)) return true;
  const artifacts = r.artifacts;
  if (nonEmptyString(artifacts)) return true;
  if (Array.isArray(artifacts) && artifacts.some((a) => nonEmptyString(a))) return true;
  return false;
}

/**
 * Fields to backfill onto an evidence-less agentTasks entry from a completions
 * record. FILL-ONLY-IF-MISSING: never emits a key the entry already has a
 * non-empty value for. Supplies output/branch/commitSha/prUrl ONLY — never
 * mergeCommit/outcome/blockReason (ship-verdict signals, TEAM-3747 D2 /
 * TEAM-3755 F1). commitSha is NOT a merge signal.
 */
export function evidenceBackfillFields(
  record: unknown,
  entry: EvidenceEntryLike | undefined | null
): BackfillFields {
  const fields: BackfillFields = {};
  if (!record || typeof record !== "object") return fields;
  const r = record as CompletionRecord;
  const e: EvidenceEntryLike = entry && typeof entry === "object" ? entry : {};
  if (!nonEmptyString(e.output) && nonEmptyString(r.summary)) {
    fields.output = r.summary.trim().slice(0, 10000); // same cap as harvestCompletionEvidence
  }
  if (!nonEmptyString(e.branch) && nonEmptyString(r.branch)) fields.branch = r.branch;
  if (!nonEmptyString(e.commitSha) && nonEmptyString(r.commit_sha)) fields.commitSha = r.commit_sha;
  if (!nonEmptyString(e.prUrl) && nonEmptyString(r.pr_url)) fields.prUrl = r.pr_url;
  return fields;
}

/**
 * Second pass over missingEvidenceTickets() offenders: consult the authoritative
 * completions record for each would-be offender ONLY (zero S3 reads on the happy
 * path). Drops offenders whose record proves evidence and backfills their entry
 * so the run self-heals. Any read/backfill failure leaves the offender IN the
 * list (only tightens when it can prove — never a 500).
 */
export async function resolveMissingEvidenceFromRecords(
  missing: MissingEvidenceTicket[],
  agentTasks: Record<string, EvidenceEntryLike> | undefined | null,
  deps: ResolveEvidenceDeps
): Promise<MissingEvidenceTicket[]> {
  if (!Array.isArray(missing) || missing.length === 0) return missing;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const tasks: Record<string, EvidenceEntryLike> =
    agentTasks && typeof agentTasks === "object" ? agentTasks : {};
  const byTicketId = new Map<string, EvidenceEntryLike>();
  for (const entry of Object.values(tasks)) {
    if (entry && typeof entry.ticketId === "string") byTicketId.set(entry.ticketId, entry);
  }
  const remaining: MissingEvidenceTicket[] = [];
  for (const offender of missing) {
    const ticketId = offender?.ticketId;
    let record: CompletionRecord | null = null;
    try {
      record = await deps.readCompletionRecord(ticketId);
    } catch (err) {
      log(`[completion] completions record read failed for ${ticketId}: ${(err as Error)?.message || err}`);
      remaining.push(offender);
      continue;
    }
    if (!completionRecordHasEvidence(record)) {
      log(`[completion] completions record for ${ticketId} ${record ? "carries no evidence" : "not found"}`);
      remaining.push(offender);
      continue;
    }
    const entry = tasks[ticketId] || byTicketId.get(ticketId);
    const fields = evidenceBackfillFields(record, entry);
    if (Object.keys(fields).length > 0) {
      try {
        await deps.backfill(ticketId, fields);
      } catch (err) {
        // Evidence is proven by the record itself; a failed backfill only means
        // the next gate pass re-reads the record. Never re-block on it.
        log(`[completion] evidence backfill failed for ${ticketId}: ${(err as Error)?.message || err}`);
      }
    }
  }
  return remaining;
}

// ─── TEAM-5359 FR-2 / TEAM-5358: a run once refused stays refused ─────────────
// PARITY with lambda/orchestrator/completion.mjs (same names, same semantics;
// closeout-override-parity.test.ts pins the notice prefix). The override itself is
// read and verified by ./closeout-override.

export const COMPLETION_BLOCKED_NOTIF_RE = /^notif_completion_/;

/** The row carries a completion-blocked escalation (`notif_completion_*`). */
export function hasCompletionBlockedNotice(workflow: unknown): boolean {
  const list = (workflow as { humanNotifications?: unknown } | null | undefined)?.humanNotifications;
  return Array.isArray(list) && list.some((n) => COMPLETION_BLOCKED_NOTIF_RE.test(String((n as { id?: unknown })?.id || "")));
}

/** A parsed override names every id in `offenderIds` ("@phase" ignored on both sides). */
export function closeoutOverrideCovers(override: { offenders?: unknown } | null | undefined, offenderIds: readonly string[]): boolean {
  if (!Array.isArray(override?.offenders)) return false;
  const covered = new Set(override.offenders.map((o) => String(o).split("@")[0]));
  return offenderIds.every((id) => covered.has(String(id).split("@")[0]));
}

// ─── TEAM-5358 FR-1 / F4 / F7: gate-class tickets owe their own record ─────────
// A gate-class ticket (review, CI, QA, ship, security review, or any human gate)
// closed done must be backed by evidence its owner produced — never a record the
// console or the Workflow Manager wrote on its behalf.

export const GATE_CLASS_PHASES: readonly string[] = ["review", "verification", "ship"];
/** Gate agents whose roster phase is not a gate phase (F7: the security reviewer sits in design). */
export const GATE_CLASS_EXTRA_AGENTS: readonly string[] = ["agentcore_hub_security_reviewer"];
/** `source` the console's mark-done stamps on the record it writes (transition route). */
export const CONSOLE_RECORD_SOURCE = "workflow-manager";

interface GateTicketLike {
  ticketId?: unknown;
  type?: unknown;
  assignee?: unknown;
  labels?: unknown;
  parentId?: unknown;
  status?: unknown;
}

/** Human review gate (assignee `human:<who>` or `human-review` label) — twin of completion.mjs. */
export function isHumanGateTicket(t: GateTicketLike | null | undefined): boolean {
  if (typeof t?.assignee === "string" && t.assignee.startsWith("human:")) return true;
  return Array.isArray(t?.labels) && t.labels.some((l) => String(l).trim().toLowerCase() === "human-review");
}

/** Gate-class: any human gate, a gate-phase ticket, or a GATE_CLASS_EXTRA_AGENTS assignee. Epics never. */
export function isGateClassTicket(t: GateTicketLike | null | undefined, phaseOf: (t: GateTicketLike) => string | undefined): boolean {
  if (!t || t.type === "epic") return false;
  if (isHumanGateTicket(t)) return true;
  if (typeof t.assignee === "string" && GATE_CLASS_EXTRA_AGENTS.includes(t.assignee)) return true;
  const phase = phaseOf(t);
  return typeof phase === "string" && GATE_CLASS_PHASES.includes(phase);
}

const SWEEPER_IN_SUMMARY_RE = /\bby ([A-Z][A-Z0-9]*-\d+)\b/;

/**
 * The sweeper a completions record proves skipped this ticket, or null. Port of the
 * twins' judgeSkipRecord (gate-contract.mjs): a `skipped` record for THIS run naming
 * a sweeper other than the ticket itself.
 */
export function sweepSkipSweeperOf(record: unknown, ticketId: string, workflowId: string): string | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const r = record as Record<string, unknown>;
  if (r.evidence_kind !== "skipped" || r.skipped !== true) return null;
  if (r.ticketId && r.ticketId !== ticketId) return null;
  if (!workflowId || r.workflowId !== workflowId) return null;
  const sweeper =
    (typeof r.sweeperTicketId === "string" && r.sweeperTicketId) ||
    SWEEPER_IN_SUMMARY_RE.exec(String(r.summary || ""))?.[1] ||
    null;
  return sweeper && sweeper !== ticketId ? sweeper : null;
}

export type GateRecordVerdict = { ok: true } | { ok: false; why: "no_record" | "no_evidence" | "console_record" | "agent_mismatch" };

/**
 * Does `record` (completions/<id>.json) satisfy an AGENT gate-class ticket (F4)? It
 * must carry evidence, must not be the console's record, and must name the ticket's
 * assignee as `agent_id`. Human gates are judged by their gate decision record
 * instead (./closeout-offenders); a sweep skip is judged there too, against the roster.
 */
export function gateClassRecordSatisfies(record: unknown, ticket: GateTicketLike): GateRecordVerdict {
  if (!record || typeof record !== "object" || Array.isArray(record)) return { ok: false, why: "no_record" };
  const r = record as Record<string, unknown>;
  if (r.source === CONSOLE_RECORD_SOURCE) return { ok: false, why: "console_record" };
  if (!completionRecordHasEvidence(r)) return { ok: false, why: "no_evidence" };
  if (typeof ticket.assignee !== "string" || r.agent_id !== ticket.assignee) return { ok: false, why: "agent_mismatch" };
  return { ok: true };
}
