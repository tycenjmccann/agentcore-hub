/**
 * POST /api/workflow/[id]/nudge
 *
 * Lightweight "unstick" endpoint. Scans tickets for the workflow and fixes:
 * 1. Tickets stuck at "todo" with empty blockedBy (stream event was missed)
 * 2. Tickets stuck at "blocked" whose blockers are already "done"
 *
 * Supports both DynamoDB and Jira ticket providers — reads the workflow record
 * to determine which provider to use.
 *
 * NOTE: We intentionally do NOT reset "in_progress" tickets. An in_progress
 * ticket means an agent Runtime session is actively running. Resetting it
 * causes duplicate invocations. If an agent truly crashes, the Runtime session
 * timeout (540s) will handle it, and the agent should report_completion/failure.
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { JiraClient, mapJiraStatusToInternal, blockersFromLinks } from "@/lib/workflow/jira-client";

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const dynamic = "force-dynamic";

// ─── Nudge via Jira ─────────────────────────────────────────────────────────

async function nudgeJira(epicId: string) {
  const jira = JiraClient.fromEnv();
  const issues = await jira.getChildIssues(epicId);
  const nudged: string[] = [];

  const statusMap = new Map<string, string>(
    issues.map((i) => [i.key, mapJiraStatusToInternal(i.fields.status?.name || "To Do")])
  );

  // Best-effort transition to Ready; a board without a "Ready" transition just
  // logs and moves on (mirrors the DynamoDB path's idempotent nudge).
  const toReady = async (key: string, label: string) => {
    try {
      await jira.transitionIssue(key, "Ready");
      nudged.push(`${key} (${label})`);
    } catch (err) {
      console.warn(`[nudge] ${key}: ${(err as Error).message}`);
    }
  };

  for (const issue of issues) {
    const internalStatus = statusMap.get(issue.key) || "todo";
    const blockedBy = blockersFromLinks(issue.fields.issuelinks);

    // Case 1: "todo" with no blockers — should be running
    if (internalStatus === "todo" && blockedBy.length === 0) {
      await toReady(issue.key, "todo→ready");
    }
    // Case 2: "blocked" but all blockers are done
    if (internalStatus === "blocked") {
      const allDone = blockedBy.length === 0 || blockedBy.every((b) => statusMap.get(b) === "done");
      if (allDone) await toReady(issue.key, "unblocked→ready");
    }
  }

  return { ticketsScanned: issues.length, nudged };
}

// ─── Targeted dispatch (Jira) ───────────────────────────────────────────────

/** Statuses that must never be reopened by a targeted dispatch. `cancelled` is
 *  terminal alongside `done` — reopening intentionally-cancelled work would run
 *  it again. */
const DISPATCH_TERMINAL = new Set(["done", "cancelled"]);

/**
 * Force a single ticket to Ready regardless of its current column, EXCEPT
 * terminal/human-gate states. This is the `dispatch` path: an orphan that a
 * missed stream/webhook left parked (e.g. "In Progress" with no agent ever
 * assigned) matches none of the scan's stuck-patterns, so the scan can't move
 * it. Never touches Done/Cancelled/In Review — those are terminal or human-owned.
 *
 * Ownership is verified against `epicId` (the ticket's parent must be this
 * workflow's epic) so `/workflow/A/nudge` can't move a ticket that belongs to
 * workflow B and mis-record the intervention against A.
 */
async function dispatchJira(ticketKey: string, epicId: string | undefined) {
  const jira = JiraClient.fromEnv();
  const issue = await jira.getIssue(ticketKey, ["status", "parent"]);
  const parentKey = (issue.fields.parent as { key?: string } | undefined)?.key;
  if (!epicId || parentKey !== epicId) {
    return { ticketsScanned: 0, nudged: [], skipped: `${ticketKey} does not belong to this workflow (parent=${parentKey ?? "none"})` };
  }
  const internal = mapJiraStatusToInternal(issue.fields.status?.name || "To Do");
  if (DISPATCH_TERMINAL.has(internal)) {
    return { ticketsScanned: 1, nudged: [], skipped: `${ticketKey} is ${internal} — terminal` };
  }
  if (internal === "in_review") {
    return { ticketsScanned: 1, nudged: [], skipped: `${ticketKey} is in review — human-owned` };
  }
  await jira.transitionIssue(ticketKey, "Ready");
  return { ticketsScanned: 1, nudged: [`${ticketKey} (dispatch→ready)`] };
}

async function dispatchDynamoDB(ticketId: string, workflowId: string, epicId: string | undefined) {
  const got = await ddb.send(new GetCommand({ TableName: TICKETS_TABLE, Key: { ticketId } }));
  const ticket = got.Item;
  if (!ticket) return { ticketsScanned: 0, nudged: [], skipped: `${ticketId} not found` };
  // Verify ownership: the ticket must be tagged with this workflow or parented
  // to its epic. Prevents a stale/confused ID from moving another run's ticket.
  const owns = ticket.workflowId === workflowId || (epicId && ticket.parentId === epicId);
  if (!owns) {
    return { ticketsScanned: 0, nudged: [], skipped: `${ticketId} does not belong to this workflow` };
  }
  const status = String(ticket.status || "");
  if (DISPATCH_TERMINAL.has(status)) {
    return { ticketsScanned: 1, nudged: [], skipped: `${ticketId} is ${status} — terminal` };
  }
  if (status === "in_review" || String(ticket.assignee || "").startsWith("human:")) {
    return { ticketsScanned: 1, nudged: [], skipped: `${ticketId} is human-owned` };
  }
  await ddb.send(new UpdateCommand({
    TableName: TICKETS_TABLE,
    Key: { ticketId },
    UpdateExpression: "SET #s = :s, #u = :u",
    ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
    ExpressionAttributeValues: { ":s": "ready", ":u": new Date().toISOString() },
  }));
  return { ticketsScanned: 1, nudged: [`${ticketId} (dispatch→ready)`] };
}

// ─── Nudge via DynamoDB ─────────────────────────────────────────────────────

async function nudgeDynamoDB(workflowId: string) {
  const result = await ddb.send(new ScanCommand({
    TableName: TICKETS_TABLE,
    FilterExpression: "workflowId = :wid",
    ExpressionAttributeValues: { ":wid": workflowId },
  }));
  const tickets = (result.Items || []).filter(t => t.ticketId !== "__COUNTER__");

  const statusMap = new Map(tickets.map(t => [t.ticketId, t.status]));
  const nudged: string[] = [];

  for (const ticket of tickets) {
    const { ticketId, status, blockedBy, assignee } = ticket;
    if (!assignee) continue;

    if (status === "todo" && (!blockedBy || blockedBy.length === 0)) {
      await ddb.send(new UpdateCommand({
        TableName: TICKETS_TABLE,
        Key: { ticketId },
        UpdateExpression: "SET #s = :s, #u = :u",
        ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
        ExpressionAttributeValues: { ":s": "ready", ":u": new Date().toISOString() },
      }));
      nudged.push(`${ticketId} (todo→ready)`);
    }

    if (status === "blocked") {
      const hasBlockers = blockedBy && blockedBy.length > 0;
      const allBlockersDone = !hasBlockers || blockedBy.every(
        (blockerId: string) => statusMap.get(blockerId) === "done"
      );
      if (allBlockersDone) {
        await ddb.send(new UpdateCommand({
          TableName: TICKETS_TABLE,
          Key: { ticketId },
          UpdateExpression: "SET #s = :s, #bb = :bb, #u = :u",
          ExpressionAttributeNames: { "#s": "status", "#bb": "blockedBy", "#u": "updatedAt" },
          ExpressionAttributeValues: { ":s": "ready", ":bb": [], ":u": new Date().toISOString() },
        }));
        nudged.push(`${ticketId} (${hasBlockers ? "unblocked" : "blocked-no-blockers"}→ready)`);
      }
    }
  }

  return { ticketsScanned: tickets.length, nudged };
}

// ─── Route Handler ──────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;

  // Optional targeted dispatch: { ticketId, force } forces one specific orphan
  // ticket to Ready. Bodyless POST keeps the original broad-scan behaviour.
  let targetTicketId: string | undefined;
  try {
    const body = await req.json();
    if (body && typeof body.ticketId === "string" && body.ticketId.trim()) {
      targetTicketId = body.ticketId.trim();
    }
  } catch {
    /* no body — broad scan */
  }

  try {
    // Get workflow record to determine ticket provider and epicId
    const wfResult = await ddb.send(new GetCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
    }));
    if (!wfResult.Item) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }

    const workflow = wfResult.Item;
    const ticketProvider = process.env.TICKET_PROVIDER || "dynamodb";
    const epicId = workflow.epicId;

    let result: { ticketsScanned: number; nudged: string[]; skipped?: string };

    if (targetTicketId) {
      result = ticketProvider === "jira"
        ? await dispatchJira(targetTicketId, epicId)
        : await dispatchDynamoDB(targetTicketId, workflowId, epicId);
    } else if (ticketProvider === "jira") {
      if (!epicId) {
        return NextResponse.json({ error: "Workflow has no epicId — cannot query Jira" }, { status: 400 });
      }
      result = await nudgeJira(epicId);
    } else {
      result = await nudgeDynamoDB(workflowId);
    }

    // Write nudge event to events table (for replay history)
    if (result.nudged.length > 0) {
      await ddb.send(new PutCommand({
        TableName: EVENTS_TABLE,
        Item: {
          workflowId,
          eventId: `${Date.now()}-nudge-${Math.random().toString(36).slice(2, 6)}`,
          type: "workflow.nudge",
          detail: { nudged: result.nudged, ticketsScanned: result.ticketsScanned },
          timestamp: new Date().toISOString(),
        },
      }));
    }

    return NextResponse.json({
      workflowId,
      ticketProvider,
      ticketsScanned: result.ticketsScanned,
      nudged: result.nudged,
      message: result.nudged.length > 0
        ? `Fixed ${result.nudged.length} stuck ticket(s)`
        : "All tickets healthy — nothing to fix",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[nudge] Error for workflow ${workflowId}:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
