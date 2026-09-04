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
