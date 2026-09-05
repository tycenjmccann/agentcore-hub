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

import { SHIP_BLOCKED_OUTCOMES } from "./types";

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

/* ------------------------------------------------------------------------- *
 * TEAM-3991 D1.4 — the pure half of the honest close.
 *
 * PARITY with lambda/orchestrator/completion.mjs (openGateOf, parseCdEvidence,
 * blockReasonWithGate, shipVerdictOf, SHIP_PROVEN_OUTCOMES,
 * ACCEPTED_SHIP_OUTCOMES). completion-evidence-parity.test.ts feeds one fixture
 * table through both copies, so a drift is a red test, not a production split.
 *
 * Why they exist (three production runs, one gap each):
 *   - wf 1pl3h1 closed `complete` while escalation gate TEAM-3757 sat in_review
 *     over unmerged PR #274, and the run's own "# PREFLIGHT BLOCKED" cd-evidence
 *     file was never read.
 *   - wf sffzti merged 4 PRs and deployed, then closed `static-ci-only`: the CD
 *     agent's evidence says "DEPLOY SUCCEEDED", a word no outcome list contained.
 * ------------------------------------------------------------------------- */

/**
 * The outcomes that PROVE the work landed. `deployed` joins `shipped` because it
 * is the word the CD agent's own evidence uses; both mean the same thing to the
 * ship gate and differ only in what the terminal event REPORTS.
 */
export const SHIP_PROVEN_OUTCOMES = ["shipped", "deployed"] as const;

/** Every outcome value a completion record may legitimately carry. */
export const ACCEPTED_SHIP_OUTCOMES = Object.freeze([
  ...SHIP_PROVEN_OUTCOMES,
  ...SHIP_BLOCKED_OUTCOMES,
]) as readonly string[];

/** Human-gate statuses that mean "a person still owes this run a decision". */
const OPEN_GATE_STATUSES = new Set(["in_review", "todo", "blocked"]);
const ESCALATION_TITLE = /^Escalation #\d+/i;
const isHumanAssignee = (a: unknown): boolean => typeof a === "string" && a.startsWith("human:");

export interface OpenGate {
  ticketId: string;
  title: string;
  status: string;
  kind: "escalation" | "merge_gate";
}

export interface GateChildLike {
  ticketId?: unknown;
  title?: unknown;
  status?: unknown;
  assignee?: unknown;
  type?: unknown;
}

/**
 * The one human gate a caller must name before closing green. Lowest ticketId
 * wins so the choice is deterministic across surfaces; a done gate owes nothing;
 * an AGENT ticket is never a gate (an agent holds no merge authority) and neither
 * is the epic itself.
 */
export function openGateOf(children: unknown): OpenGate | null {
  if (!Array.isArray(children)) return null;
  const open = (children as GateChildLike[])
    .filter(
      (t) =>
        t &&
        t.type !== "epic" &&
        isHumanAssignee(t.assignee) &&
        OPEN_GATE_STATUSES.has(String(t.status || "").toLowerCase())
    )
    .sort((a, b) => String(a.ticketId || "").localeCompare(String(b.ticketId || "")));
  if (open.length === 0) return null;
  const gate = open[0];
  const title = String(gate.title || "");
  return {
    ticketId: String(gate.ticketId || ""),
    title,
    status: String(gate.status || "").toLowerCase(),
    kind: ESCALATION_TITLE.test(title) ? "escalation" : "merge_gate",
  };
}

export interface CdEvidence {
  outcome: "deployed" | "deploy-blocked";
  blockReason?: string;
}

/**
 * Read the verdict out of a `cd-evidence/deploy-*.md` file. First verdict line
 * wins — a later contradiction cannot upgrade a block. No verdict ⇒ null: the
 * ladder then runs on self-reported evidence exactly as before, never on a guess.
 */
export function parseCdEvidence(markdown: unknown): CdEvidence | null {
  const text = typeof markdown === "string" ? markdown : "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/DEPLOY SUCCEEDED/i.test(line)) return { outcome: "deployed" };
    if (/(DEPLOY|PREFLIGHT) BLOCKED/i.test(line)) {
      return { outcome: "deploy-blocked", blockReason: line.replace(/^#+\s*/, "").trim() };
    }
  }
  return null;
}

/** Prefix a block reason with the gate a human still owes a decision on. */
export function blockReasonWithGate(reason: unknown, openGate: OpenGate | null | undefined): string | null {
  const base = typeof reason === "string" && reason.trim() ? reason.trim() : "";
  if (!openGate?.ticketId) return base || null;
  const head = `awaiting ${openGate.kind} ${openGate.ticketId}`;
  return base ? `${head}: ${base}` : head;
}

export interface ShipTaskLike {
  mergeCommit?: unknown;
  outcome?: unknown;
  commitSha?: unknown;
}

/**
 * Classify ONE ship-phase agentTasks entry: "shipped" (a non-empty mergeCommit,
 * or an explicit SHIP_PROVEN_OUTCOMES outcome), a SHIP_BLOCKED_OUTCOMES value, or
 * null (a phantom green close). Mere output/artifact is NOT proof it shipped, and
 * `commitSha` is deliberately NOT a merge signal in either twin (TEAM-3755 F1 —
 * it is the HEAD of the still-unmerged branch, harvested onto every completion
 * record, and accepting it closed run 29g73c green over an unmerged branch).
 */
export function shipVerdictOf(entry: ShipTaskLike | undefined | null): string | null {
  if (!entry || typeof entry !== "object") return null;
  const outcome = typeof entry.outcome === "string" ? entry.outcome.trim().toLowerCase() : "";
  if ((SHIP_BLOCKED_OUTCOMES as readonly string[]).includes(outcome)) return outcome;
  const merged = typeof entry.mergeCommit === "string" && entry.mergeCommit.trim().length > 0;
  if (merged || (SHIP_PROVEN_OUTCOMES as readonly string[]).includes(outcome)) return "shipped";
  return null;
}
