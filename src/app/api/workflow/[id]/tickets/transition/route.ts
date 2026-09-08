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
  try {
    const put = await s3.send(
      new PutObjectCommand({
        Bucket: ARTIFACT_BUCKET,
        Key: key,
        Body: JSON.stringify(record, null, 2),
        ContentType: "application/json",
        IfNoneMatch: "*",
      })
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
      // Raced with a delete between our PUT and this GET. Nothing to inspect and
      // nothing was written — treat as "kept" rather than guessing.
      console.log(`[transition] ${ticketId}: ${key} vanished between the create-only PUT and the read — nothing written`);
      return { outcome: "kept" };
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
    const put = await s3.send(
      new PutObjectCommand({
        Bucket: ARTIFACT_BUCKET,
        Key: key,
        Body: JSON.stringify(merged, null, 2),
        ContentType: "application/json",
        // Conditional on what we just read: an agent's authoritative record landing
        // in between makes this 412 and IT wins.
        IfMatch: previousEtag,
      })
    );
    console.log(`[transition] ${ticketId}: filled the evidence-less completion record s3://${ARTIFACT_BUCKET}/${key}`);
    return { outcome: "filled", key, etag: put.ETag, previousBody };
  } catch (err) {
    if (is412(err)) {
      console.log(`[transition] ${ticketId}: ${key} changed while filling it — keeping the newer record`);
      return { outcome: "kept" };
    }
    console.error(
      `[transition] ${ticketId}: completion evidence refill failed: ${err instanceof Error ? err.message : err}`
    );
    return { outcome: "failed", message: err instanceof Error ? err.message : String(err) };
  }
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
    if (write.outcome === "created") {
      await s3.send(
        new DeleteObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: write.key, IfMatch: write.etag })
      );
      console.log(`[transition] ${ticketId}: transition refused — removed the evidence record this call created`);
    } else {
      await s3.send(
        new PutObjectCommand({
          Bucket: ARTIFACT_BUCKET,
          Key: write.key,
          Body: write.previousBody,
          ContentType: "application/json",
          IfMatch: write.etag,
        })
      );
      console.log(`[transition] ${ticketId}: transition refused — restored the record this call had filled`);
    }
    return true;
  } catch (err) {
    if (is412(err)) {
      console.log(`[transition] ${ticketId}: evidence record changed since this call wrote it — left as is`);
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
      const errorMessage = response.Payload
        ? Buffer.from(response.Payload).toString()
        : "Unknown error";
      return NextResponse.json(
        { error: "Lambda invocation failed", details: errorMessage },
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
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Lambda invocation failed", details: errorMessage },
      { status: 500 }
    );
  }
}
