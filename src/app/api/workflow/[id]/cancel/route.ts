/**
 * POST /api/workflow/[id]/cancel
 *
 * Cancels a running workflow by:
 * 1. Setting workflow phase to "cancelled" via conditional write
 * 2. Cancelling all non-done tickets (best-effort, parallel batched)
 * 3. Publishing a workflow.cancelled event
 *
 * Supports both DynamoDB and Jira ticket providers.
 * The orchestrator's cancel guard prevents any new agent invocations
 * after the phase is set. In-flight agents are NOT interrupted.
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";

const TERMINAL_PHASES = ["complete", "error", "cancelled"] as const;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const dynamic = "force-dynamic";

// ─── Jira helpers ───────────────────────────────────────────────────────────

function getJiraAuth() {
  const siteUrl = process.env.JIRA_SITE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;
  if (!siteUrl || !email || !apiToken) return null;
  return {
    baseUrl: `https://${siteUrl}`,
    authHeader: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
  };
}

// ─── DynamoDB Ticket Cancellation ───────────────────────────────────────────

async function cancelTicketsDynamoDB(epicId: string) {
  // 1. Query all tickets for this epic
  const result = await ddb.send(
    new QueryCommand({
      TableName: TICKETS_TABLE,
      IndexName: "parentId-index",
      KeyConditionExpression: "parentId = :pid",
      ExpressionAttributeValues: { ":pid": epicId },
    })
  );

  const tickets = result.Items || [];
  let cancelled = 0,
    skipped = 0,
    failed = 0;

  // 2. Filter out already-done tickets and cancel the rest in parallel (batch of 10)
  const toCancel = tickets.filter((t) => t.status !== "done");
  skipped = tickets.length - toCancel.length;

  const batchSize = 10;
  for (let i = 0; i < toCancel.length; i += batchSize) {
    const batch = toCancel.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((ticket) =>
        ddb.send(
          new UpdateCommand({
            TableName: TICKETS_TABLE,
            Key: { ticketId: ticket.ticketId },
            UpdateExpression:
              "SET #s = :cancelled, cancelledAt = :ts, #u = :u",
            ConditionExpression: "#s <> :done",
            ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
            ExpressionAttributeValues: {
              ":cancelled": "cancelled",
              ":done": "done",
              ":ts": new Date().toISOString(),
              ":u": new Date().toISOString(),
            },
          })
        )
      )
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        cancelled++;
      } else if (
        r.reason?.name === "ConditionalCheckFailedException"
      ) {
        skipped++;
      } else {
        failed++;
        console.warn(
          `[cancel] Failed to cancel ticket: ${r.reason?.message || "unknown"}`
        );
      }
    }
  }

  return { cancelled, skipped, failed };
}

// ─── Jira Ticket Cancellation ───────────────────────────────────────────────

async function cancelTicketsJira(epicId: string) {
  const jiraAuth = getJiraAuth();
  if (!jiraAuth) return { cancelled: 0, skipped: 0, failed: 0 };

  // 1. Search for non-done child tickets
  const jql = encodeURIComponent(
    `parent = ${epicId} AND status != Done`
  );
  const searchUrl = `${jiraAuth.baseUrl}/rest/api/3/search/jql?jql=${jql}&fields=status&maxResults=100`;
  let data: { issues?: Array<{ key: string }> };
  try {
    const resp = await fetch(searchUrl, {
      headers: {
        Authorization: jiraAuth.authHeader,
        Accept: "application/json",
      },
    });
    data = await resp.json();
  } catch (err) {
    console.error(`[cancel] Jira search failed:`, err);
    return { cancelled: 0, skipped: 0, failed: 0 };
  }

  const issues = data.issues || [];
  let cancelled = 0,
    failed = 0;

  // 2. Transition each to "Won't Do" / "Cancelled" (concurrency: 5 for Jira rate limits)
  const batchSize = 5;
  for (let i = 0; i < issues.length; i += batchSize) {
    const batch = issues.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (issue) => {
        const transUrl = `${jiraAuth.baseUrl}/rest/api/3/issue/${issue.key}/transitions`;
        const transResp = await fetch(transUrl, {
          headers: {
            Authorization: jiraAuth.authHeader,
            Accept: "application/json",
          },
        });
        const transData = await transResp.json();

        // Look for cancel/won't do transition
        const cancelTrans = (transData.transitions || []).find(
          (t: { name: string; to?: { name?: string; statusCategory?: { key?: string } } }) =>
            t.name === "Won't Do" ||
            t.name === "Cancelled" ||
            t.name === "Cancel" ||
            t.to?.name === "Won't Do" ||
            t.to?.name === "Cancelled"
        );

        if (!cancelTrans) {
          // Fallback: look for any "Done" category transition
          const doneTrans = (transData.transitions || []).find(
            (t: { to?: { statusCategory?: { key?: string } } }) =>
              t.to?.statusCategory?.key === "done"
          );
          if (!doneTrans) {
            throw new Error(`No cancel transition for ${issue.key}`);
          }
          await fetch(transUrl, {
            method: "POST",
            headers: {
              Authorization: jiraAuth.authHeader,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              transition: { id: doneTrans.id },
              fields: { resolution: { name: "Won't Do" } },
            }),
          });
          return;
        }

        await fetch(transUrl, {
          method: "POST",
          headers: {
            Authorization: jiraAuth.authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            transition: { id: cancelTrans.id },
            fields: { resolution: { name: "Won't Do" } },
          }),
        });
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        cancelled++;
      } else {
        failed++;
        console.warn(
          `[cancel] Jira ticket cancel failed: ${r.reason?.message || "unknown"}`
        );
      }
    }
  }

  return { cancelled, skipped: 0, failed };
}

// ─── Route Handler ──────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;

  // Input validation
  if (!workflowId || typeof workflowId !== "string") {
    return NextResponse.json(
      { error: "Invalid workflow ID" },
      { status: 400 }
    );
  }

  // Optional audit reason. Body is optional, so tolerate an empty/absent one.
  let reason: string | undefined;
  try {
    const body = await request.json();
    if (body && typeof body.reason === "string" && body.reason.trim()) {
      reason = body.reason.trim().slice(0, 500);
    }
  } catch {
    /* no body — reason stays undefined */
  }

  try {
    // 1. Read current workflow with ConsistentRead
    const wfResult = await ddb.send(
      new GetCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        ConsistentRead: true,
      })
    );

    if (!wfResult.Item) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    const workflow = wfResult.Item;

    // 2. Terminal state guard
    if (TERMINAL_PHASES.includes(workflow.phase as typeof TERMINAL_PHASES[number])) {
      return NextResponse.json(
        {
          error: "Workflow already in terminal state",
          phase: workflow.phase,
        },
        { status: 409 }
      );
    }

    // 3. Conditional write — set phase to "cancelled"
    const cancelledAt = new Date().toISOString();
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: WORKFLOWS_TABLE,
          Key: { workflowId },
          UpdateExpression:
            "SET #phase = :cancelled, cancelledAt = :ts, previousPhase = :prev" +
            (reason ? ", cancelReason = :reason" : ""),
          ConditionExpression:
            "#phase <> :complete AND #phase <> :error AND #phase <> :alreadyCancelled",
          ExpressionAttributeNames: { "#phase": "phase" },
          ExpressionAttributeValues: {
            ":cancelled": "cancelled",
            ":ts": cancelledAt,
            ":prev": workflow.phase,
            ":complete": "complete",
            ":error": "error",
            ":alreadyCancelled": "cancelled",
            ...(reason ? { ":reason": reason } : {}),
          },
        })
      );
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        return NextResponse.json(
          {
            error: "Workflow already in terminal state",
            phase: workflow.phase,
          },
          { status: 409 }
        );
      }
      throw err;
    }

    // 4. Cancel non-done tickets (best-effort with error capture)
    let ticketResults = { cancelled: 0, skipped: 0, failed: 0 };
    if (TICKET_PROVIDER === "jira") {
      ticketResults = await cancelTicketsJira(workflow.epicId);
    } else {
      ticketResults = await cancelTicketsDynamoDB(workflow.epicId);
    }

    console.log(
      `[cancel] Workflow ${workflowId} cancelled (was: ${workflow.phase}). Tickets: ${ticketResults.cancelled} cancelled, ${ticketResults.skipped} skipped, ${ticketResults.failed} failed`
    );

    // 5. Publish event (non-fatal)
    try {
      await ddb.send(
        new PutCommand({
          TableName: EVENTS_TABLE,
          Item: {
            workflowId,
            eventId: `${Date.now()}-cancel-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: cancelledAt,
            type: "workflow.cancelled",
            detail: {
              workflowId,
              cancelledAt,
              previousPhase: workflow.phase,
              ...(reason ? { reason } : {}),
              ticketsCancelled: ticketResults.cancelled,
              ticketsSkipped: ticketResults.skipped,
              ticketsFailed: ticketResults.failed,
            },
          },
        })
      );
    } catch {
      /* event publish is non-fatal */
    }

    return NextResponse.json(
      { status: "cancelled", cancelledAt, ...(reason ? { reason } : {}) },
      { status: 200 }
    );
  } catch (err) {
    console.error("[cancel] Error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
