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
  /** The ticket's assignee: a record it did not write is no evidence (recordOwnership, TEAM-5369). */
  assigneeOf?: (ticketId: string) => string | undefined;
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
    const assignee = typeof deps.assigneeOf === "function" ? deps.assigneeOf(ticketId) : undefined;
    const own = recordOwnership(record, assignee);
    if (!own.ok) {
      const r = record as CompletionRecord;
      log(`[completion] completions record for ${ticketId} is not its assignee's (agent_mismatch: ${r.agent_id ?? r.agentId ?? r.agent} ≠ ${assignee})`);
      remaining.push(offender);
      continue;
    }
    if (own.warning) log(`[completion] completions record for ${ticketId} is a legacy record, no agent_id - accepted`);
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
// read, verified and matched (offender-set equality, DL-036) by ./closeout-override.

export const COMPLETION_BLOCKED_NOTIF_RE = /^notif_completion_/;

/** The row carries a completion-blocked escalation (`notif_completion_*`). */
export function hasCompletionBlockedNotice(workflow: unknown): boolean {
  const list = (workflow as { humanNotifications?: unknown } | null | undefined)?.humanNotifications;
  return Array.isArray(list) && list.some((n) => COMPLETION_BLOCKED_NOTIF_RE.test(String((n as { id?: unknown })?.id || "")));
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

/** fix-contract.mjs labelList: an array or a comma string, trimmed + lowercased, empties dropped. */
function labelList(labels: unknown): string[] {
  const list: unknown[] = Array.isArray(labels) ? labels : typeof labels === "string" ? labels.split(",") : [];
  return list.map((l) => String(l ?? "").trim().toLowerCase()).filter(Boolean);
}

/**
 * THE human-gate rule (TEAM-5371), the one TS mirror of fix-contract.mjs isHumanGate
 * (canonical; completion.mjs re-exports it under this name): assignee `human:<who>`, or a
 * `human-review` / `reviewer:<who>` label. Every TS "is this a human gate?" calls this.
 * Kept zero-import: decision-grammar.ts (client-bundled) imports it.
 */
export function isHumanGateTicket(t: GateTicketLike | null | undefined): boolean {
  if (typeof t?.assignee === "string" && t.assignee.startsWith("human:")) return true;
  return labelList(t?.labels).some((l) => l === "human-review" || l.startsWith("reviewer:"));
}

/**
 * Mirror of completion.mjs owesNoDeliverable: a done child exempt from the deliverable /
 * gate-class record. Exactly the pre-TEAM-5371 set (an exemption is a privilege), so a
 * reviewer:-only gate is a human gate yet still owes the record it owed before.
 */
export function owesNoDeliverable(t: GateTicketLike | null | undefined): boolean {
  if (typeof t?.assignee === "string" && t.assignee.startsWith("human:")) return true;
  return Array.isArray(t?.labels) && labelList(t.labels).includes("human-review");
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

/**
 * The agent-identity fields a completions record may carry. reportCompletion stamps
 * `agent_id` since TEAM-5358 F4 (null when the caller sent none); a record written
 * before that carries none and is a legacy record.
 */
export const AGENT_IDENTITY_FIELDS: readonly string[] = ["agent_id", "agentId", "agent"];

export type GateRecordOffence = "no_record" | "no_evidence" | "console_record" | "agent_mismatch" | "unproven_skip";
export type GateRecordWarning = "legacy_no_agent_id";
export type GateRecordVerdict = { ok: true; warning?: GateRecordWarning } | { ok: false; why: GateRecordOffence };
export type RecordOwnership = { ok: true; warning?: GateRecordWarning } | { ok: false; why: "agent_mismatch" };

/**
 * THE completions-record ownership rule (TEAM-5369), the TS mirror of
 * lambda/orchestrator/proof-record-verify.mjs recordOwnership (canonical;
 * record-ownership-cases.json pins both and the toolkit's Python): every identity
 * field the record carries must equal `assignee` exactly (no trim, no aliasing); a
 * record carrying none is a legacy record, accepted with a warning.
 */
export function recordOwnership(record: unknown, assignee: unknown): RecordOwnership {
  const r = (record && typeof record === "object" && !Array.isArray(record) ? record : {}) as Record<string, unknown>;
  const carried = AGENT_IDENTITY_FIELDS.filter((f) => r[f] !== undefined && r[f] !== null && r[f] !== "");
  if (carried.length === 0) return { ok: true, warning: "legacy_no_agent_id" };
  return typeof assignee === "string" && carried.every((f) => r[f] === assignee) ? { ok: true } : { ok: false, why: "agent_mismatch" };
}

/**
 * Does `record` (completions/<id>.json) satisfy an AGENT gate-class ticket (F4)?
 *   - it must exist, must not be the console's record, and must carry evidence;
 *   - a sweep skip record here is one the roster did not prove (./closeout-offenders
 *     judges the proof first), so it is an offender, never a legacy record;
 *   - every agent-identity field it carries must equal the ticket's assignee;
 *   - a record carrying none is a legacy record: accepted, with a warning.
 * Human gates are judged by their gate decision record instead (./closeout-offenders).
 */
export function gateClassRecordSatisfies(record: unknown, ticket: GateTicketLike): GateRecordVerdict {
  if (!record || typeof record !== "object" || Array.isArray(record)) return { ok: false, why: "no_record" };
  const r = record as Record<string, unknown>;
  if (r.source === CONSOLE_RECORD_SOURCE) return { ok: false, why: "console_record" };
  if (r.evidence_kind === "skipped" || r.skipped === true) return { ok: false, why: "unproven_skip" };
  if (!completionRecordHasEvidence(r)) return { ok: false, why: "no_evidence" };
  return recordOwnership(r, ticket.assignee);
}
