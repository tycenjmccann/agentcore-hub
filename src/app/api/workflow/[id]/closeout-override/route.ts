/**
 * POST /api/workflow/[id]/closeout-override — TEAM-5358 FR-2 / F1 / F6.
 *
 * How a human lets a refused run complete over named offenders. The offenders are
 * computed here, server-side, by the same closeoutState() POST /complete acts on
 * (src/lib/workflow/closeout-offenders.ts); the body names only the reason. The
 * record is written to workflows/<id>/shared/closeout-override.json, the key every
 * TEAM-5359 reader already parses ({by, reason, offenders, at}), and signed with
 * the gate-decision key (src/lib/workflow/closeout-override.ts). /complete accepts
 * only a record that verifies.
 *
 * Who may write it: a provable human (requireHumanIdentity). `by` is that identity,
 * never a body field. Under AUTH_MODE=none nobody can.
 *
 * Create-once, with one exception (F1 pre-creation squat): agents can still put
 * that key through IAM, so an object already there that does NOT verify is no
 * override. It is overwritten with IfMatch:<its etag> (and logged); an object that
 * verifies is a real override and the answer is 409 override_exists.
 *
 *   201 { status:"created", record, offenders, replacedUnverifiable }
 *   400 reason_required | reason_too_long
 *   403 human_identity_required
 *   409 nothing_to_override | workflow_terminal | override_exists | override_contended
 *   503 decision_key_unavailable
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getTicketsForWorkflowFromDynamo } from "@/lib/workflow/dynamo-read";
import { getTicketsForWorkflowFromJira } from "@/lib/workflow/jira-read";
import { SHIP_BLOCKED_OUTCOMES } from "@/lib/workflow/types";
import { closeoutState, type CloseoutStateDeps } from "@/lib/workflow/closeout-offenders";
import {
  CLOSEOUT_OVERRIDE_KEY,
  CLOSEOUT_OVERRIDE_REASON_MAX,
  buildCloseoutOverride,
  verifyCloseoutOverride,
} from "@/lib/workflow/closeout-override";
import { loadDecisionKeys } from "@/lib/workflow/decision-keys";
import { humanIdentityRequiredBody, requireHumanIdentity } from "@/lib/auth/human";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";

const WORKFLOW_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** The same terminal set /complete guards on. */
const TERMINAL_PHASES = new Set<string>(["complete", "error", "cancelled", ...SHIP_BLOCKED_OUTCOMES]);
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/** One squatter overwrite per attempt; a real override landing in between wins. */
const MAX_WRITE_ATTEMPTS = 3;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({ region: REGION });

export const dynamic = "force-dynamic";

type S3Error = { name?: string; $metadata?: { httpStatusCode?: number } };
const is412 = (err: unknown) => (err as S3Error)?.name === "PreconditionFailed" || (err as S3Error)?.$metadata?.httpStatusCode === 412;
const is404 = (err: unknown) =>
  (err as S3Error)?.name === "NoSuchKey" || (err as S3Error)?.name === "NotFound" || (err as S3Error)?.$metadata?.httpStatusCode === 404;

async function readArtifactJson(key: string): Promise<unknown> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: key }));
    const body = await obj.Body?.transformToString();
    return body ? JSON.parse(body) : null;
  } catch (err) {
    if (is404(err)) return null;
    throw err;
  }
}

type WriteResult = { ok: true; replacedUnverifiable: boolean } | { ok: false; error: "override_exists" | "override_contended" };

/**
 * Create-once put of the signed record, treating an unverifiable object at the key
 * as absent (F1): 412 → read it → verifies ? override_exists : overwrite IfMatch.
 */
async function writeOverride(workflowId: string, body: string, keys: readonly string[]): Promise<WriteResult> {
  const Key = CLOSEOUT_OVERRIDE_KEY(workflowId);
  const put = (cond: { IfNoneMatch?: string; IfMatch?: string }) =>
    s3.send(new PutObjectCommand({ Bucket: ARTIFACT_BUCKET, Key, Body: body, ContentType: "application/json", ...cond }));
  let replaced = false;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    try {
      await put({ IfNoneMatch: "*" });
      return { ok: true, replacedUnverifiable: replaced };
    } catch (err) {
      if (!is412(err)) throw err;
    }
    let existing: string | null = null;
    let etag: string | undefined;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key }));
      existing = (await obj.Body?.transformToString()) ?? "";
      etag = obj.ETag;
    } catch (err) {
      if (is404(err)) continue; // deleted in between: create again
      throw err;
    }
    if (verifyCloseoutOverride(existing, keys, workflowId)) return { ok: false, error: "override_exists" };
    if (!etag) return { ok: false, error: "override_contended" };
    console.warn(
      `[closeout-override] ${workflowId}: unverifiable object squatting ${Key} (etag ${etag}, ${existing.length} bytes) - overwriting: ` +
        JSON.stringify(existing.replace(CONTROL_CHARS, "").slice(0, 300))
    );
    try {
      await put({ IfMatch: etag });
      return { ok: true, replacedUnverifiable: true };
    } catch (err) {
      if (!is412(err) && !is404(err)) throw err;
      replaced = true; // someone else wrote first: judge what is there now
    }
  }
  return { ok: false, error: "override_contended" };
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const workflowId = params.id;
  if (!WORKFLOW_ID_RE.test(workflowId)) {
    return NextResponse.json({ error: "Invalid workflow ID" }, { status: 400 });
  }

  const human = requireHumanIdentity(request);
  if (!human.ok) {
    return NextResponse.json(
      {
        ...humanIdentityRequiredBody(human.reason),
        hint: "Overriding a refused close-out is a human decision: use the hub console signed in through SSO.",
      },
      { status: 403 }
    );
  }

  let reqBody: { reason?: unknown } = {};
  try {
    reqBody = (await request.json()) as { reason?: unknown };
  } catch {
    /* empty or non-JSON body: reason_required below */
  }
  const reason = (typeof reqBody?.reason === "string" ? reqBody.reason : "").replace(CONTROL_CHARS, "").trim();
  if (!reason) return NextResponse.json({ error: "reason_required" }, { status: 400 });
  if (reason.length > CLOSEOUT_OVERRIDE_REASON_MAX) {
    return NextResponse.json({ error: "reason_too_long", max: CLOSEOUT_OVERRIDE_REASON_MAX }, { status: 400 });
  }

  if (!ARTIFACT_BUCKET) return NextResponse.json({ error: "ARTIFACT_BUCKET is not configured" }, { status: 500 });
  const keys = await loadDecisionKeys();
  if (!keys.ok || keys.keys.length === 0) {
    return NextResponse.json(
      { error: "decision_key_unavailable", detail: keys.ok ? "no keys" : keys.detail },
      { status: 503 }
    );
  }

  try {
    const got = await ddb.send(new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId }, ConsistentRead: true }));
    const workflow = got.Item as Record<string, unknown> | undefined;
    if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    if (workflow.cancelledAt || TERMINAL_PHASES.has(String(workflow.phase || ""))) {
      return NextResponse.json({ error: "workflow_terminal", phase: workflow.phase }, { status: 409 });
    }

    let tickets: CloseoutStateDeps["tickets"];
    try {
      tickets = (
        TICKET_PROVIDER === "jira"
          ? await getTicketsForWorkflowFromJira(workflowId, { requireComplete: true })
          : await getTicketsForWorkflowFromDynamo(workflowId, { consistentRead: true })
      ) as CloseoutStateDeps["tickets"];
    } catch (err) {
      return NextResponse.json(
        { error: `Could not load tickets to compute offenders: ${(err as Error).message}` },
        { status: 502 }
      );
    }

    // The SAME verdict /complete acts on; no backfill (read-only here).
    const state = await closeoutState({
      workflowId,
      workflow,
      tickets,
      readJson: readArtifactJson,
      decisionKeys: keys.keys,
      log: console.warn,
    });
    if (!state.blockedBefore && state.offenderIds.length === 0) {
      return NextResponse.json(
        { error: "nothing_to_override", detail: "The run has no close-out offenders and was never refused." },
        { status: 409 }
      );
    }

    const record = buildCloseoutOverride(
      { workflowId, by: human.by, reason, offenders: state.offenderIds },
      keys.keys[0]
    );
    const written = await writeOverride(workflowId, JSON.stringify(record, null, 2), keys.keys);
    if (!written.ok) {
      return NextResponse.json(
        {
          error: written.error,
          key: CLOSEOUT_OVERRIDE_KEY(workflowId),
          hint:
            written.error === "override_exists"
              ? "A verified override is already recorded for this run; it is create-once."
              : "The override key kept changing under this write; retry.",
        },
        { status: 409 }
      );
    }

    try {
      await ddb.send(
        new PutCommand({
          TableName: EVENTS_TABLE,
          Item: {
            workflowId,
            eventId: `${Date.now()}-closeout-override-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: record.at,
            type: "workflow.closeout_override",
            detail: {
              workflowId,
              by: record.by,
              reason: record.reason,
              offenders: record.offenders,
              offenderSetHash: record.offenderSetHash,
              replacedUnverifiable: written.replacedUnverifiable,
            },
          },
        })
      );
    } catch {
      /* event publish is non-fatal */
    }

    console.log(
      `[closeout-override] ${workflowId}: ${record.by} overrode [${record.offenders.join(", ")}]` +
        (written.replacedUnverifiable ? " (replaced an unverifiable object)" : "")
    );
    return NextResponse.json(
      {
        status: "created",
        record,
        offenders: state.offenders,
        missingEvidence: state.missing,
        replacedUnverifiable: written.replacedUnverifiable,
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("[closeout-override] Error:", err);
    return NextResponse.json({ error: `Failed to record the override: ${(err as Error).message}` }, { status: 500 });
  }
}
