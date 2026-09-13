/**
 * completions-record evidence check (record-write hygiene, not a completion gate).
 *
 * The per-ticket completion-evidence PRECONDITION gate was removed (an agent's
 * report_completion is now the sole definition of done); this helper survives for
 * a different, narrower job: the mark-done path in
 * src/app/api/workflow/[id]/tickets/transition/route.ts uses it to decide whether
 * a completions/{ticketId}.json record already carries a deliverable before it
 * PUTs one, so a Workflow Manager mark-done never clobbers a richer agent record
 * with a thinner one. KPIs / cost-report also read these records.
 *
 * PARITY with lambda/orchestrator/completion.mjs is no longer required — the .mjs
 * copies of these helpers were deleted with the gate; this is the only remaining
 * copy.
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
