/**
 * GET /api/workflow/[id]/events — Fetch ALL events for a workflow (for replay)
 *
 * Returns events as a JSON array, ordered by eventId (timestamp-based).
 * Used by the frontend to replay completed workflows with a scrubber.
 *
 * POST /api/workflow/[id]/events — append ONE `escalation.reminded` event
 * (TEAM-5423). The Telegram bridge re-pages an open escalation gate and needs
 * the reminder on the run's own stream, so compute_metrics / the card can count
 * it and the next scan can tell which tier already went out. The bridge has no
 * events-table grant; this route is its only write path. Deliberately closed:
 * any other type is a 400 — this is not a generic event sink (an `agent.*` or
 * `manager.intervention` written here would skew the run's metrics). Same auth
 * as the GET (src/middleware.ts gates every /api/* path identically).
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { transformEvent } from "@/lib/workflow/transform-event";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;
  const allEvents: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  // Paginate through all events
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: EVENTS_TABLE,
      KeyConditionExpression: "workflowId = :wid",
      ExpressionAttributeValues: { ":wid": workflowId },
      ScanIndexForward: true,
      ExclusiveStartKey: lastKey,
    }));

    for (const item of result.Items || []) {
      const transformed = transformEvent(item, { includeEventId: true });
      if (transformed) {
        allEvents.push(transformed);
      }
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return NextResponse.json({ events: allEvents, count: allEvents.length }, {
    headers: { "Cache-Control": "no-store" },
  });
}

/** The ONLY type POST accepts. */
const REMINDER_EVENT_TYPE = "escalation.reminded";
/** Raw body cap — the payload is a handful of scalars. */
const MAX_POST_BYTES = 2048;
const MAX_TIER = 500;
const MAX_ELAPSED_MS = 90 * 24 * 3600 * 1000;
const GATE_TICKET_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const WORKFLOW_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

type ReminderDetail = {
  gateTicketId: string;
  notifId: string | null;
  tier: number;
  dueAt: string | null;
  elapsedMs: number;
  heldFrom?: string;
  liveCheck?: boolean;
  producer: string;
};

const isIso = (v: unknown) => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const isBoundedInt = (v: unknown, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

/** Validate a POST body. Returns the detail to store, or an error string. */
function parseReminderBody(body: unknown): ReminderDetail | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (b.type !== REMINDER_EVENT_TYPE) return `type must be "${REMINDER_EVENT_TYPE}"`;
  if (typeof b.gateTicketId !== "string" || !GATE_TICKET_RE.test(b.gateTicketId)) return "gateTicketId must be a ticket key";
  if (b.notifId !== undefined && (typeof b.notifId !== "string" || !b.notifId || b.notifId.length > 200)) {
    return "notifId must be a non-empty string of at most 200 chars";
  }
  // tier is optional only for a liveCheck write (the operator's smallest real round-trip).
  const tier = b.tier === undefined && b.liveCheck === true ? 0 : b.tier;
  if (!isBoundedInt(tier, MAX_TIER)) return `tier must be an integer 0-${MAX_TIER}`;
  if (b.dueAt !== undefined && !isIso(b.dueAt)) return "dueAt must be an ISO timestamp";
  if (b.heldFrom !== undefined && !isIso(b.heldFrom)) return "heldFrom must be an ISO timestamp";
  const elapsedMs = b.elapsedMs === undefined && b.liveCheck === true ? 0 : b.elapsedMs;
  if (!isBoundedInt(elapsedMs, MAX_ELAPSED_MS)) return "elapsedMs must be a non-negative integer (max 90 days)";
  if (b.liveCheck !== undefined && typeof b.liveCheck !== "boolean") return "liveCheck must be a boolean";
  return {
    gateTicketId: b.gateTicketId,
    notifId: (b.notifId as string | undefined) ?? null,
    tier: tier as number,
    dueAt: (b.dueAt as string | undefined) ?? null,
    elapsedMs: elapsedMs as number,
    ...(b.heldFrom ? { heldFrom: b.heldFrom as string } : {}),
    ...(b.liveCheck !== undefined ? { liveCheck: b.liveCheck as boolean } : {}),
    producer: "telegram-bug-intake",
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;
  if (!WORKFLOW_ID_RE.test(workflowId)) {
    return NextResponse.json({ error: "invalid workflowId" }, { status: 400 });
  }
  const raw = await req.text().catch(() => "");
  if (Buffer.byteLength(raw, "utf8") > MAX_POST_BYTES) {
    return NextResponse.json({ error: `body exceeds ${MAX_POST_BYTES} bytes` }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  const detail = parseReminderBody(body);
  if (typeof detail === "string") {
    return NextResponse.json({ error: detail }, { status: 400 });
  }

  // `<ms>-` prefix is load-bearing: the stream route's cursor is eventId > lastEventId.
  const now = Date.now();
  const eventId = `${now}-escrem-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await ddb.send(new PutCommand({
      TableName: EVENTS_TABLE,
      Item: {
        workflowId,
        eventId,
        type: REMINDER_EVENT_TYPE,
        detail,
        timestamp: new Date(now).toISOString(),
      },
    }));
  } catch (err) {
    console.error(`[events] ${REMINDER_EVENT_TYPE} write failed for ${workflowId}:`, err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
  return NextResponse.json({ written: true, workflowId, eventId });
}
