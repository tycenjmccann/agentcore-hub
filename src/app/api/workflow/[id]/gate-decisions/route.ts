/**
 * GET /api/workflow/[id]/gate-decisions — TEAM-5367 / DL-036; TEAM-5397 F4.
 *
 * The human-gate decisions of one run, VERIFIED, for readers that hold no key
 * (the workflow-manager toolkit: pull_dossier.py). For each human gate on the
 * roster it reads `pipeline-artifacts/gate-decisions/<wf>/gates/<tid>.json` and
 * runs gateDecisionStands (sig, workflowId, ticketId, the gate's live cycle, its
 * live scope). A record that does not stand is listed under `unverified` with
 * why; an absent record is simply not listed. Read-only: no writes, no backfill,
 * and the response carries no sig or key material.
 *
 * TEAM-5397 F4: a standing record is not necessarily a COMMITTED decision. Both
 * twins claim the record BEFORE the status write and never delete it if that
 * write fails (TEAM-5387), so a record can stand while the ticket is still, say,
 * In Review. Every listed decision therefore also carries the ticket's live
 * status and `pending`, true unless the live status equals the record's status
 * (gateDecisionCommitted) — fails closed: an unreadable live status is pending.
 *
 *   200 { keyAvailable, decisions: { [tid]: { status, decision:{option}, decidedAt,
 *         verifiedBy:"hub", liveStatus, pending } }, unverified: [{ ticketId, why }] }
 *   400 invalid workflow id   404 unknown workflow   502 tickets unreadable
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getTicketsForWorkflowFromDynamo } from "@/lib/workflow/dynamo-read";
import { getTicketsForWorkflowFromJira } from "@/lib/workflow/jira-read";
import { isHumanGateTicket } from "@/lib/workflow/completion-evidence";
import { gateDecisionCommitted, gateDecisionRecordKey, gateDecisionStands } from "@/lib/workflow/gate-decision-record";
import { liveGate } from "@/lib/workflow/gate-live";
import { loadDecisionKeys } from "@/lib/workflow/decision-keys";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";

const WORKFLOW_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

export const dynamic = "force-dynamic";

type S3Error = { name?: string; $metadata?: { httpStatusCode?: number } };
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

type Ticket = { ticketId?: string; assignee?: unknown; labels?: unknown };
type Decision = {
  status: string;
  decision: { option: string };
  decidedAt: string;
  verifiedBy: "hub";
  liveStatus: string | null;
  pending: boolean;
};

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const workflowId = params.id;
  if (!WORKFLOW_ID_RE.test(workflowId)) return NextResponse.json({ error: "invalid workflow id" }, { status: 400 });
  if (!ARTIFACT_BUCKET) return NextResponse.json({ error: "ARTIFACT_BUCKET is not configured" }, { status: 500 });

  const got = await ddb.send(new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId } }));
  if (!got.Item) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });

  const keys = await loadDecisionKeys();
  if (!keys.ok || keys.keys.length === 0) return NextResponse.json({ keyAvailable: false, decisions: {}, unverified: [] });

  let tickets: Ticket[];
  try {
    tickets = (
      TICKET_PROVIDER === "jira"
        ? await getTicketsForWorkflowFromJira(workflowId, { requireComplete: true })
        : await getTicketsForWorkflowFromDynamo(workflowId)
    ) as Ticket[];
  } catch (err) {
    return NextResponse.json({ error: `Could not load tickets: ${(err as Error).message}` }, { status: 502 });
  }

  const decisions: Record<string, Decision> = {};
  const unverified: Array<{ ticketId: string; why: string }> = [];
  for (const t of tickets) {
    const ticketId = String(t.ticketId || "");
    if (!ticketId || !isHumanGateTicket(t as Parameters<typeof isHumanGateTicket>[0])) continue;
    let rec: unknown;
    try {
      rec = await readArtifactJson(gateDecisionRecordKey(workflowId, ticketId));
    } catch {
      unverified.push({ ticketId, why: "record_unreadable" });
      continue;
    }
    if (rec === null) continue;
    const live = await liveGate(ticketId).catch(() => null);
    const stands = gateDecisionStands(rec, keys.keys, { workflowId, ticketId, live });
    if (!stands.ok) {
      unverified.push({ ticketId, why: stands.why });
      continue;
    }
    const r = stands.record;
    decisions[ticketId] = {
      status: r.status,
      decision: { option: r.decision.option },
      decidedAt: r.decidedAt,
      verifiedBy: "hub",
      liveStatus: live?.status ?? null,
      pending: !gateDecisionCommitted(r, live),
    };
  }
  return NextResponse.json({ keyAvailable: true, decisions, unverified });
}
