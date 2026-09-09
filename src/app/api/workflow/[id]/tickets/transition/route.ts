import { NextRequest, NextResponse } from "next/server";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getWorkflowFromDynamo, getTicketsForWorkflowFromDynamo } from "@/lib/workflow/dynamo-read";
import { getTicketsForWorkflowFromJira } from "@/lib/workflow/jira-read";
import { withDefaultDecision } from "@/lib/workflow/gate-decision";
// TEAM-4282 F3: the SAME predicate both completion gates use to decide whether a
// completions record proves a deliverable. Imported (not replicated) so a blank
// record we are allowed to fill is defined identically here and at the gate.
import { completionRecordHasEvidence } from "@/lib/workflow/completion-evidence";

export const dynamic = "force-dynamic";

const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";
const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

// TEAM-4266: cap the operator's evidence string at the same length
// evidenceBackfillFields (lambda/orchestrator/completion.mjs) slices a record's
// summary to, so the record can never be larger than what the gate will read.
const EVIDENCE_MAX_LEN = 10000;

// TEAM-4282 F1b: ticketId becomes an S3 key segment (completions/{ticketId}.json),
// so it must be a single path segment with no traversal. Every id the system mints
// is `${PROJECT_KEY}-${n}` (lambda/agentcore-hub-tickets nextTicketId) or a Jira
// key like TEAM-4266 — both well inside this shape. It also rejects the tickets
// table's `__COUNTER__` sentinel, which must never be transitioned.
const TICKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const TICKET_ID_MAX_LEN = 128;

const VALID_STATUSES = ["todo", "ready", "in_progress", "in_review", "done", "blocked"];

// Simplified flow: todo → ready → in_progress → done  (+blocked as escape hatch).
// in_review is the human-review gate state: approve (→done) or request changes (→blocked).
const VALID_TRANSITIONS: Record<string, string[]> = {
  todo: ["ready", "blocked"],
  ready: ["in_progress", "in_review", "blocked"],
  in_progress: ["done", "in_review", "blocked"],
  in_review: ["done", "blocked"],
  blocked: ["todo", "ready", "in_progress", "in_review", "done"],
  done: ["todo"],
};

/**
 * TEAM-4266 — persist an out-of-band approve's evidence as the SAME completion
 * record the agent's own report_completion would have written
 * (completions/{ticketId}.json, lambda/workflow-output/index.mjs reportCompletion).
 *
 * The bug this closes: when an agent ships its deliverable and then dies before
 * calling report_completion, the Workflow Manager closes the ticket with
 * `intervene.py mark-done --evidence "..."`. That recorded the proof as prose only
 * (a ticket comment + a manager.intervention event), so nothing ever wrote the
 * record BOTH completion evidence gates require — harvestCompletionEvidence /
 * missingEvidenceTickets in lambda/orchestrator, and the twin in
 * POST /api/workflow/[id]/complete. The run then emitted
 * workflow.completion_blocked reason=missing_evidence forever and /complete 409'd.
 * Writing the record here makes mark-done a first-class evidence producer with no
 * change to either gate: a non-empty `summary` is all completionRecordHasEvidence
 * needs, and evidenceBackfillFields maps it onto agentTasks[ticketId].output.
 *
 * FILL-ONLY-IF-MISSING, atomically: IfNoneMatch "*" makes the PUT fail with 412
 * PreconditionFailed when a record already exists, so an agent's authoritative
 * record (which carries pr_url / commit_sha / merge signals this one cannot) is
 * never clobbered by an operator's prose. A late-landing agent record is already
 * handled by the gates' own completions-record fallback (TEAM-3976).
 *
 * TEAM-4282 F2 — NO LONGER BEST-EFFORT. A swallowed write failure left the ticket
 * done with no record AND no way to retry (mark-done again is a done→done the
 * ticket Lambda refuses), i.e. exactly the unrecoverable state TEAM-4266 exists to
 * remove. A failed write now fails the whole request BEFORE the transition fires.
 *
 * TEAM-4282 F3 — 412 is not automatically "the agent's record wins". reportCompletion
 * (lambda/workflow-output) writes `summary` verbatim and PUTs unconditionally, so an
 * agent can leave an all-blank record that is NOT evidence per
 * completionRecordHasEvidence yet 412s this create-only PUT forever. On 412 we read
 * the record: evidence → keep it untouched; blank → refill it with IfMatch on the
 * ETag we just read, so a real agent record landing in between still wins (412).
 *
 * The outcome is returned rather than a boolean because the caller must be able to
 * UNDO its own write when the transition is then refused (F1): "created" is deleted,
 * "filled" is restored to the exact bytes it replaced. A record this call did not
 * write is never touched.
 */
type EvidenceWrite =
  /** create-only PUT landed — this call brought the record into existence. */
  | { outcome: "created"; key: string; etag?: string }
  /** 412 + the existing record was blank — we overwrote it and can put it back. */
  | { outcome: "filled"; key: string; etag?: string; previousBody: string }
  /** the existing record is real evidence (or a concurrent writer won the race). */
  | { outcome: "kept" }
  /** no record was written and none can be — the caller must not transition. */
  | { outcome: "failed"; message: string };

/** Did this call write the record (and therefore own the right to undo it)? */
function isEvidenceWritten(w: EvidenceWrite | null): w is Extract<EvidenceWrite, { key: string }> {
  return w?.outcome === "created" || w?.outcome === "filled";
}

const is412 = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "PreconditionFailed" || e?.$metadata?.httpStatusCode === 412;
};

const isNotFound = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
};

/**
 * TEAM-4286 — a 409 ConditionalRequestConflict is a RACE, not a fault, and was
 * being lumped in with AccessDenied et al: `!is412(err)` → "failed" → 502, so a
 * mark-done that lost a millisecond-scale race got "completion evidence record
 * write failed" and the ticket never closed.
 *
 * Straight off the installed SDK (@aws-sdk/client-s3 3.1048.0):
 *   commands/PutObjectCommand.d.ts:75-78 (IfNoneMatch)
 *     "If a conflicting operation occurs during the upload, S3 returns a 409
 *      ConditionalRequestConflict response. On a 409 failure, retry the upload."
 *   models/models_0.d.ts:14711 (PutObjectRequest.IfMatch)
 *     "...On a 409 failure you should fetch the object's ETag and retry the upload."
 * DeleteObject documents no 409 at all (models_0.d.ts:3439 — 412 only).
 *
 * BOTH arms are required. 409 is not modelled as a named exception class (the
 * command's @throws list is EncryptionTypeMismatch | InvalidRequest |
 * InvalidWriteOffset | TooManyParts | S3ServiceException), so it arrives via
 * @smithy/core's throwDefaultError, which names the exception
 * `parsedBody.Code || errorCode || String(statusCode)`: that is
 * "ConditionalRequestConflict" when S3 sends the <Code>, and the bare "409" when
 * the error body is empty — which only the $metadata arm catches.
 *
 * And the SDK will not do this for us: 409 is absent from @smithy/core's
 * TRANSIENT_ERROR_STATUS_CODES ([500, 502, 503, 504]) and the error is
 * $fault: "client", so the default maxAttempts never retries it.
 */
const is409 = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "ConditionalRequestConflict" || e?.$metadata?.httpStatusCode === 409;
};

/** Total attempts per conditional command, and the waits between them. */
const CONFLICT_ATTEMPTS = 3;
const CONFLICT_BACKOFF_MS = [25, 75];

/** Rounds of the create → read → refill sequence (see writeCompletionRecord). */
const WRITE_ROUNDS = 3;

/**
 * TEAM-4286 — send ONE conditional S3 command, retrying ONLY a 409. Every other
 * error (412, 404, AccessDenied) is rethrown on its first occurrence, so the 412
 * fill-if-blank path (F3) and the fail-closed path (F2) are reached exactly as
 * before — in particular a 409 must never be mistaken for a 412 and trigger the
 * read-back.
 *
 * The backoff is a short fixed pair rather than something the tests stub: it
 * bounds the added latency at 100ms per command, which is cheap enough that the
 * unit tests need no seam and production code needs no test-awareness.
 */
async function sendConditional<T>(send: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      if (!is409(err) || attempt >= CONFLICT_ATTEMPTS) throw err;
      console.warn(
        `[transition] ${label}: 409 ConditionalRequestConflict — retrying (${attempt + 1}/${CONFLICT_ATTEMPTS})`
      );
      await new Promise((r) => setTimeout(r, CONFLICT_BACKOFF_MS[attempt - 1] ?? 75));
    }
  }
}

async function writeCompletionRecord(ticketId: string, evidence: string): Promise<EvidenceWrite> {
  if (!ARTIFACT_BUCKET) {
    // TEAM-4282 F2: a distinct, self-diagnosing message — the alternative
    // (transition anyway) is the unrecoverable done-with-no-record state.
    console.warn(`[transition] ${ticketId}: ARTIFACT_BUCKET unset — refusing to close the ticket with no evidence record`);
    return { outcome: "failed", message: "ARTIFACT_BUCKET is not configured" };
  }
  const key = `completions/${ticketId}.json`;
  // Byte-compatible superset of reportCompletion's record: the same key set, plus
  // `source` (audit: this came from an operator, not the agent) and the already-
  // valid evidence_kind "static". Every reader ignores unknown keys.
  const record = {
    ticket_id: ticketId,
    summary: evidence.slice(0, EVIDENCE_MAX_LEN),
    artifacts: "",
    branch: null,
    commit_sha: null,
    pr_url: null,
    completed_at: new Date().toISOString(),
    source: "workflow-manager",
    evidence_kind: "static",
  };
  const s3 = new S3Client({ region: REGION });

  // TEAM-4286/TEAM-4293 — the create → read → refill sequence is a bounded LOOP, not
  // a straight line. Every UNCERTAIN outcome goes round again and re-reads; only a
  // PROVEN one returns. Three ways a round ends inconclusively, all races against a
  // concurrent writer of the same key:
  //   read-back GET 404   — deleted between our PUT and the read. AWS: reupload
  //                         ("You should reupload the object", conditional-writes
  //                         userguide) → re-create.
  //   refill PUT 404      — deleted after the read → re-create.
  //   refill PUT 412      — REWRITTEN after the read. TEAM-4293: this is not proof
  //                         the winner is evidence, so re-read and judge it.
  // The rule: "kept" is only ever returned after completionRecordHasEvidence has
  // actually run on the bytes being kept. Budget exhausted → "failed" (502), never
  // "kept" — closing the ticket here is unrecoverable (done→done cannot be retried),
  // a 502 is retryable.
  //
  // Worst case is 3 rounds x (<=3 create PUTs + 1 GET + <=3 refill PUTs) = 21 sends
  // and <=600ms of backoff, reachable only against an adversarial bucket.
  let exhaustedBecause = "kept vanishing between the create-only PUT and the read";
  for (let round = 1; round <= WRITE_ROUNDS; round++) {
    try {
      const put = await sendConditional(
        () =>
          s3.send(
            new PutObjectCommand({
              Bucket: ARTIFACT_BUCKET,
              Key: key,
              Body: JSON.stringify(record, null, 2),
              ContentType: "application/json",
              IfNoneMatch: "*",
            })
          ),
        `${ticketId} create`
      );
      console.log(`[transition] ${ticketId}: wrote completion evidence record s3://${ARTIFACT_BUCKET}/${key}`);
      return { outcome: "created", key, etag: put.ETag };
    } catch (err) {
      if (!is412(err)) {
        console.error(
          `[transition] ${ticketId}: completion evidence record write failed: ${err instanceof Error ? err.message : err}`
        );
        return { outcome: "failed", message: err instanceof Error ? err.message : String(err) };
      }
    }

    // ── TEAM-4282 F3: 412 — a record exists. Fill it only if it is not evidence. ──
    let previousBody: string;
    let previousEtag: string | undefined;
    try {
      const existing = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }));
      previousBody = (await existing.Body?.transformToString()) || "";
      previousEtag = existing.ETag;
    } catch (err) {
      if (isNotFound(err)) {
        // TEAM-4286: raced with a delete between our PUT and this GET. Nothing was
        // written, so re-create it rather than closing the ticket with no evidence.
        console.log(
          `[transition] ${ticketId}: ${key} vanished between the create-only PUT and the read — re-creating it (round ${round}/${WRITE_ROUNDS})`
        );
        continue;
      }
      console.error(
        `[transition] ${ticketId}: could not read the existing completion record: ${err instanceof Error ? err.message : err}`
      );
      return { outcome: "failed", message: err instanceof Error ? err.message : String(err) };
    }

    let existingRecord: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(previousBody);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existingRecord = parsed as Record<string, unknown>;
      }
    } catch {
      // An unparseable body cannot be evidence — fall through and fill it.
    }

    if (completionRecordHasEvidence(existingRecord)) {
      console.log(`[transition] ${ticketId}: ${key} already carries evidence — keeping the existing record`);
      return { outcome: "kept" };
    }

    // Spread-then-override: only the fields this record owns are set, so a blank
    // record's incidental non-evidence fields (e.g. `branch`) survive the refill.
    const merged = {
      ...(existingRecord || {}),
      ticket_id: ticketId,
      summary: record.summary,
      completed_at: (existingRecord?.completed_at as string) || record.completed_at,
      source: "workflow-manager",
      evidence_kind: (existingRecord?.evidence_kind as string) || "static",
    };
    try {
      const put = await sendConditional(
        () =>
          s3.send(
            new PutObjectCommand({
              Bucket: ARTIFACT_BUCKET,
              Key: key,
              Body: JSON.stringify(merged, null, 2),
              ContentType: "application/json",
              // Conditional on what we just read: an agent's authoritative record landing
              // in between makes this 412 and IT wins.
              IfMatch: previousEtag,
            })
          ),
        `${ticketId} refill`
      );
      console.log(`[transition] ${ticketId}: filled the evidence-less completion record s3://${ARTIFACT_BUCKET}/${key}`);
      return { outcome: "filled", key, etag: put.ETag, previousBody };
    } catch (err) {
      if (is412(err)) {
        // TEAM-4293: a 412 here says only "the object changed between the GET at the
        // top of this round and this PUT" — it does NOT say the winner is evidence.
        // reportCompletion (lambda/workflow-output) is the only unconditional writer
        // of this key and it stores `summary` verbatim, so a BLANK winner is real —
        // the same premise the 412 read-back exists for (see F3 in the header). This
        // used to `return { outcome: "kept" }`, which transitioned the ticket without
        // ever running completionRecordHasEvidence on the new bytes: the TEAM-4266
        // stall again, since done→done cannot be retried. Go round instead — the next
        // create-only PUT 412s, the GET reads the NEWER record, and evidence ⇒ kept
        // (proven), blank ⇒ refill against ITS ETag.
        exhaustedBecause = "kept being rewritten while every version read back was blank";
        console.log(
          `[transition] ${ticketId}: ${key} changed while filling it — re-reading the newer record (round ${round}/${WRITE_ROUNDS})`
        );
        continue;
      }
      if (isNotFound(err)) {
        // TEAM-4286: an If-Match PUT answers 404 when a concurrent delete wins, and
        // AWS says to reupload — so fall back to the create-only PUT.
        console.log(
          `[transition] ${ticketId}: ${key} was deleted after the read — re-creating it (round ${round}/${WRITE_ROUNDS})`
        );
        continue;
      }
      console.error(
        `[transition] ${ticketId}: completion evidence refill failed: ${err instanceof Error ? err.message : err}`
      );
      return { outcome: "failed", message: err instanceof Error ? err.message : String(err) };
    }
  }

  // TEAM-4286/TEAM-4293: every round ended inconclusively. Refusing is the point —
  // "kept" here would close the ticket on a record nobody proved, with no way to
  // retry.
  console.error(`[transition] ${ticketId}: ${key} ${exhaustedBecause} — gave up after ${WRITE_ROUNDS} attempts`);
  return {
    outcome: "failed",
    message: `${key} ${exhaustedBecause} after ${WRITE_ROUNDS} attempts`,
  };
}

/**
 * TEAM-4282 F1 — undo THIS call's evidence write after the transition was refused,
 * so a ticket that never moved is not left carrying evidence that it did.
 *
 * Only ever touches what this request wrote, and conditionally on the ETag it got
 * back, so a record an agent overwrote in the meantime is left alone:
 *   created → DeleteObject IfMatch
 *   filled  → PutObject of the exact previous bytes, IfMatch
 * A "kept" outcome is somebody else's record and is never compensated.
 */
async function revertCompletionRecord(ticketId: string, write: EvidenceWrite): Promise<boolean> {
  if (!isEvidenceWritten(write)) return false;
  if (!write.etag) {
    // No ETag = no safe conditional. Leaving the record is the lesser harm: the
    // gates only read records for tickets that are done, and this one is not.
    console.warn(`[transition] ${ticketId}: no ETag for the evidence record — leaving it in place`);
    return false;
  }
  const s3 = new S3Client({ region: REGION });
  try {
    // TEAM-4286: the restore PUT's IfMatch is documented to answer 409 on a
    // concurrent operation, so it gets the same bounded retry as the forward
    // writes. DeleteObject's IfMatch documents 412 only (models_0.d.ts:3439), so
    // wrapping it too is defence in depth rather than a known case.
    if (write.outcome === "created") {
      await sendConditional(
        () =>
          s3.send(
            new DeleteObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: write.key, IfMatch: write.etag })
          ),
        `${ticketId} revert-delete`
      );
      console.log(`[transition] ${ticketId}: transition refused — removed the evidence record this call created`);
    } else {
      await sendConditional(
        () =>
          s3.send(
            new PutObjectCommand({
              Bucket: ARTIFACT_BUCKET,
              Key: write.key,
              Body: write.previousBody,
              ContentType: "application/json",
              IfMatch: write.etag,
            })
          ),
        `${ticketId} revert-restore`
      );
      console.log(`[transition] ${ticketId}: transition refused — restored the record this call had filled`);
    }
    return true;
  } catch (err) {
    if (is412(err)) {
      console.log(`[transition] ${ticketId}: evidence record changed since this call wrote it — left as is`);
    } else if (is409(err)) {
      // TEAM-4286: still racing after the full budget. Leaving the record is the
      // same lesser harm as the no-ETag case above.
      console.warn(
        `[transition] ${ticketId}: evidence record still conflicted after ${CONFLICT_ATTEMPTS} attempts — left as is`
      );
    } else {
      console.warn(
        `[transition] ${ticketId}: could not revert the evidence record: ${err instanceof Error ? err.message : err}`
      );
    }
    return false;
  }
}

/**
 * TEAM-4282 F1 — BOTH ticket Lambdas report a refused transition inside a 200
 * payload with no FunctionError, so `response.FunctionError` alone reported
 * success:true for tickets that never moved. Returns the refusal text, or null
 * when nothing proves a refusal.
 *
 * The two vocabularies, read off the Lambdas:
 *   lambda/agentcore-hub-tickets/index.mjs:805  success = { key, status: "transitioned", from, to, … }
 *                                        :748  refusal = textResult(...) = { content: [{ text }] }
 *   lambda/agentcore-hub-jira/index.mjs:722     success = { ticketId, status: <internal>, message }
 *                                      :1074    refusal = { error: err.message }
 * Note the jira success `status` is the internal status ("done"), NOT "transitioned",
 * and can differ from targetStatus when Jira matched by transition name — so this is
 * a DENY-list, not a success allow-list. It therefore fails OPEN on an unknown shape:
 * a false refusal would revert a record for a ticket that really did move, which is
 * strictly worse than the pre-existing false success.
 */
function rejectedDetails(payload: unknown, targetStatus: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.error === "string" && p.error.trim()) return p.error.trim();
  if (Array.isArray(p.content) && p.status !== "transitioned" && p.status !== targetStatus) {
    const first = p.content[0] as { text?: unknown } | undefined;
    return typeof first?.text === "string" && first.text.trim()
      ? first.text.trim()
      : "transition refused by the tickets Lambda";
  }
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  // Parse request body
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // TEAM-4266: `evidence` is STRICTLY optional — the console UI never sends it, and
  // a blank/non-string value is ignored rather than rejected, so every existing
  // caller behaves exactly as before.
  const { ticketId, targetStatus, comment, evidence } = body;
  const trimmedEvidence = typeof evidence === "string" ? evidence.trim() : "";

  // Validate ticketId
  if (!ticketId || typeof ticketId !== "string") {
    return NextResponse.json(
      { error: "ticketId is required and must be a non-empty string" },
      { status: 400 }
    );
  }

  // TEAM-4282 F1b: reject anything that is not a plain single path segment BEFORE
  // it can reach an S3 key or a ticket backend. Runs for every caller — no id the
  // system mints fails it.
  if (!TICKET_ID_RE.test(ticketId) || ticketId.length > TICKET_ID_MAX_LEN) {
    return NextResponse.json(
      { error: "ticketId has an unexpected format" },
      { status: 400 }
    );
  }

  // Validate targetStatus
  if (!targetStatus || !VALID_STATUSES.includes(targetStatus)) {
    return NextResponse.json(
      { error: `targetStatus must be one of: ${VALID_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  // Verify workflow exists
  const workflow = await getWorkflowFromDynamo(params.id);
  if (!workflow) {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }

  // In jira mode tickets live in Jira (no DynamoDB tickets table). The ticket
  // Lambda validates transition legality against Jira's live transitions, so we
  // skip the DDB pre-check here. In dynamodb mode we still validate locally.
  let tickets: Record<string, unknown>[] = [];
  if (TICKET_PROVIDER !== "jira") {
    tickets = (await getTicketsForWorkflowFromDynamo(params.id)) as Record<string, unknown>[];
    const ticket = tickets.find((t) => (t as Record<string, unknown>).ticketId === ticketId);
    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }
    const currentStatus = ticket.status as string;
    const allowedTransitions = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowedTransitions.includes(targetStatus)) {
      return NextResponse.json(
        { error: `Invalid transition from ${currentStatus} to ${targetStatus}` },
        { status: 400 }
      );
    }
    // in_review is reserved for human-review-gate tickets (assignee "human:*").
    const assignee = String((ticket as Record<string, unknown>).assignee || "");
    if (targetStatus === "in_review" && !assignee.startsWith("human:")) {
      return NextResponse.json(
        { error: "Only human-review tickets can be sent to in_review" },
        { status: 400 }
      );
    }
  }

  // TEAM-3971: only an approve (→ done) needs the gate's title, and only to
  // recognise an escalation gate. Best-effort — a lookup failure must never
  // block a human's approval.
  let decisionDefaulted: string | null = null;
  let finalComment: string | undefined = comment;
  // TEAM-4282 F1b: the same lookup is the ONLY thing that can prove a jira-mode
  // ticket belongs to this workflow (dynamodb mode proved it above). Record its
  // outcome without changing its best-effort nature for the non-evidence callers.
  let gateFound = false;
  let gateLookupError: string | null = null;
  if (targetStatus === "done") {
    try {
      if (TICKET_PROVIDER === "jira") {
        tickets = (await getTicketsForWorkflowFromJira(params.id)) as unknown as Record<string, unknown>[];
      }
      const gate = tickets.find((t) => t.ticketId === ticketId);
      gateFound = !!gate;
      ({ comment: finalComment, decisionDefaulted } = withDefaultDecision(
        comment, targetStatus, gate ? String(gate.title || "") : undefined
      ));
      if (decisionDefaulted) {
        console.log(`[transition] ${ticketId}: escalation gate approved without a DECISION line — recorded as DECISION: ${decisionDefaulted}`);
      }
    } catch (err) {
      gateLookupError = err instanceof Error ? err.message : String(err);
      console.warn(`[transition] ${ticketId}: escalation-gate lookup failed (non-fatal): ${gateLookupError}`);
    }
  }

  // TEAM-4266: write the completion evidence record BEFORE the transition. The
  // orchestrator's done cascade (markTaskComplete → harvestCompletionEvidence) runs
  // off the DDB stream / Jira webhook this transition fires, so writing first means
  // the evidence is harvested in the SAME orchestrator pass instead of waiting for
  // the completion-time re-harvest. Sits on the shared path, so it behaves
  // identically in both jira and dynamodb ticket-provider modes.
  const wantsEvidenceRecord = targetStatus === "done" && trimmedEvidence.length > 0;

  // TEAM-4282 F1b: in jira mode nothing above proved the ticket belongs to THIS
  // workflow, and ticketId is about to become an S3 key — a mismatch would forge
  // evidence onto another run. Gated on wantsEvidenceRecord so the console UI and
  // the Telegram bot (neither sends `evidence`) keep today's behaviour exactly.
  if (wantsEvidenceRecord && TICKET_PROVIDER === "jira") {
    if (gateLookupError) {
      // Fail closed: ownership is unproven, not disproven. A Jira blip is retryable.
      return NextResponse.json(
        { error: "could not verify the ticket belongs to this workflow", details: gateLookupError },
        { status: 502 }
      );
    }
    if (!gateFound) {
      // Same answer dynamodb mode already gives for a ticket outside the workflow.
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }
  }

  const evidenceWrite = wantsEvidenceRecord
    ? await writeCompletionRecord(ticketId, trimmedEvidence)
    : null;

  // TEAM-4282 F2: no record, no transition. Proceeding would close the ticket with
  // no evidence and no retry (mark-done again is a done→done the Lambda refuses).
  if (evidenceWrite?.outcome === "failed") {
    return NextResponse.json(
      { error: "completion evidence record write failed", details: evidenceWrite.message },
      { status: 502 }
    );
  }
  const completionRecordWritten = isEvidenceWritten(evidenceWrite);

  // Invoke the agentcore-hub-tickets Lambda
  const lambda = new LambdaClient({ region: REGION });

  const payload = {
    tool_name: "Tickets___transition_ticket",
    parameters: {
      ticket_id: ticketId,
      transition_id: targetStatus,
      reason: finalComment || "Manual override from console",
    },
  };

  try {
    const command = new InvokeCommand({
      FunctionName: process.env.TICKET_TOOLS_LAMBDA || "agentcore-hub-tickets",
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(payload)),
    });

    const response = await lambda.send(command);

    if (response.FunctionError) {
      // TEAM-4282: deliberately NOT reverted. A FunctionError is AMBIGUOUS — the
      // Lambda can throw after it already applied the DDB/Jira transition (e.g. a
      // timeout on the way out) — so we cannot tell "did not move" from "moved, then
      // failed to tell us". Reverting on a guess would recreate the unrecoverable
      // done-with-no-record state TEAM-4266 exists to fix. An orphan record left on a
      // still-open ticket is inert (both completion gates only read records for done
      // tickets) and reportCompletion overwrites it unconditionally regardless. Only
      // rejectedDetails, a payload-level refusal, is an UNAMBIGUOUS "did not move" —
      // that is the only path that reverts.
      const errorMessage = response.Payload
        ? Buffer.from(response.Payload).toString()
        : "Unknown error";
      return NextResponse.json(
        {
          error: "Lambda invocation failed",
          // TEAM-4286: this branch deliberately leaves the record in place (see
          // above), so the body has to SAY an orphan record was left or the operator
          // is blind — the 500 was previously indistinguishable from one that wrote
          // nothing. Placed BEFORE `details` because intervene.py's api_post
          // truncates the surfaced body at 500 chars and `details` is unbounded.
          // Gated on wantsEvidenceRecord, so the console UI's and the Telegram
          // bot's response shapes are unchanged (same idiom as the 409 body below).
          ...(wantsEvidenceRecord ? { completionRecordWritten, completionRecordReverted: false } : {}),
          details: errorMessage,
        },
        { status: 500 }
      );
    }

    // TEAM-4282 F1: a refusal arrives as a 200 payload with no FunctionError, so it
    // has to be read out of the payload itself. Reporting success:true for a ticket
    // that never moved misleads every caller (console optimistically repaints the
    // status; intervene.py records a manager.intervention) and, worse, leaves the
    // evidence record this call just wrote attached to work that did not close.
    let responsePayload: unknown = null;
    if (response.Payload) {
      try {
        responsePayload = JSON.parse(Buffer.from(response.Payload).toString());
      } catch {
        // Unreadable payload proves nothing — fall through as before.
      }
    }
    const refusal = rejectedDetails(responsePayload, targetStatus);
    if (refusal) {
      console.warn(`[transition] ${ticketId}: tickets Lambda refused the transition to ${targetStatus}: ${refusal}`);
      let completionRecordReverted = false;
      if (evidenceWrite) {
        // Best-effort and strictly scoped to what THIS call wrote — a failed revert
        // must not change the answer the caller gets about the transition.
        try {
          completionRecordReverted = await revertCompletionRecord(ticketId, evidenceWrite);
        } catch (revertErr) {
          console.warn(
            `[transition] ${ticketId}: evidence revert threw: ${revertErr instanceof Error ? revertErr.message : revertErr}`
          );
        }
      }
      return NextResponse.json(
        {
          error: "Ticket transition rejected",
          details: refusal,
          ticketId,
          targetStatus,
          ...(wantsEvidenceRecord ? { completionRecordWritten: false, completionRecordReverted } : {}),
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true, ticketId, newStatus: targetStatus,
      ...(decisionDefaulted ? { decisionDefaulted } : {}),
      // Only when evidence was supplied, so the console UI's response shape is
      // byte-identical to before (same idiom as decisionDefaulted above).
      ...(wantsEvidenceRecord ? { completionRecordWritten } : {}),
    });
  } catch (err: unknown) {
    // TEAM-4282: same reasoning as the FunctionError branch above — the invoke
    // itself throwing (e.g. a network timeout) is AMBIGUOUS about whether the
    // Lambda applied the transition before we lost the response, so the evidence
    // record is left as is rather than reverted on a guess.
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      {
        error: "Lambda invocation failed",
        // TEAM-4286: same as the FunctionError branch — the record is left on
        // purpose, so the answer says so.
        ...(wantsEvidenceRecord ? { completionRecordWritten, completionRecordReverted: false } : {}),
        details: errorMessage,
      },
      { status: 500 }
    );
  }
}
