/**
 * POST /api/workflow/[id]/complete
 *
 * Honestly closes out a workflow whose work is actually finished but whose
 * bookkeeping never rolled up (the orchestrator missed the final phase_change,
 * or the last tickets were closed out-of-band). This is the write path the
 * Workflow Manager's watch-mode `complete` intervention calls.
 *
 * Guardrail — this NEVER fakes completion, and there is NO bypass:
 *   1. Reads every child ticket via the configured provider (Jira or DynamoDB).
 *   2. Refuses (409) unless ALL non-epic children are done/cancelled. There is
 *      deliberately no `force` flag — the manager toolkit is unauthenticated, so
 *      an unconditional bypass would let a mistaken diagnosis (or prompt
 *      injection) mark unfinished work complete. Genuinely-finished-but-
 *      unrecorded work is resolved by closing the child ticket, not bypassing.
 *   3. Transitions the epic ticket to Done (Jira) so the board rolls up.
 *   4. Conditional write: phase → "complete", completedAt, managerWatch=false,
 *      and compacts runaway escalation noise in the same write.
 *   5. Publishes workflow.complete on EventBridge (drives the ANALYZE trigger)
 *      AND to the events table under workflowId (clears the live SSE board).
 *
 * Body: { reason?: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { getTicketsForWorkflowFromDynamo } from "@/lib/workflow/dynamo-read";
import { getTicketsForWorkflowFromJira } from "@/lib/workflow/jira-read";
import { JiraClient } from "@/lib/workflow/jira-client";

const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";
const EVENT_BUS = process.env.EVENT_BUS || "default";
const TICKET_PROVIDER = process.env.TICKET_PROVIDER || "dynamodb";

const TERMINAL_PHASES = ["complete", "error", "cancelled"] as const;
const DONE_STATUSES = new Set(["done", "cancelled"]);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const eventBridge = new EventBridgeClient({ region: REGION });

export const dynamic = "force-dynamic";

type Ticket = Record<string, unknown>;
type Notification = Record<string, unknown>;

/** Non-epic children that are not yet in a terminal (done/cancelled) status. */
function openChildren(tickets: Ticket[]): Ticket[] {
  return tickets.filter((t) => {
    if (t.type === "epic") return false;
    const status = String(t.status || "").toLowerCase();
    return !DONE_STATUSES.has(status);
  });
}

/**
 * Compact humanNotifications so the terminal write SHRINKS the record instead
 * of growing it. Runaway `manager_escalation` entries are the bloat that pushes
 * a run's item toward the 400KB DynamoDB limit — the very thing that would make
 * the completion write fail (leaving the run stuck "open" forever). We drop the
 * no-op manager escalations (each is already mirrored as a manager.escalation
 * row in the events table) and keep genuine human-facing notifications
 * (review_needed, etc.), preserving the last few escalations for audit.
 */
function compactNotifications(notifs: Notification[]): Notification[] {
  if (!Array.isArray(notifs) || notifs.length === 0) return notifs || [];
  const kept: Notification[] = [];
  const recentEscalations: Notification[] = [];
  for (const n of notifs) {
    if (n?.type === "manager_escalation") {
      recentEscalations.push(n);
    } else {
      kept.push(n);
    }
  }
  // Keep the 3 most recent escalations for traceability; drop the rest.
  return [...kept, ...recentEscalations.slice(-3)];
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;
  if (!workflowId || typeof workflowId !== "string") {
    return NextResponse.json({ error: "Invalid workflow ID" }, { status: 400 });
  }

  let reason: string | undefined;
  try {
    const body = await request.json();
    if (body && typeof body.reason === "string" && body.reason.trim()) {
      reason = body.reason.trim().slice(0, 500);
    }
  } catch {
    /* no body */
  }

  try {
    // 1. Read current workflow (consistent — we're about to gate on its phase).
    const wfResult = await ddb.send(
      new GetCommand({
        TableName: WORKFLOWS_TABLE,
        Key: { workflowId },
        ConsistentRead: true,
      })
    );
    if (!wfResult.Item) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
    const workflow = wfResult.Item;

    if (TERMINAL_PHASES.includes(workflow.phase as (typeof TERMINAL_PHASES)[number])) {
      return NextResponse.json(
        { error: "Workflow already in terminal state", phase: workflow.phase },
        { status: 409 }
      );
    }

    // 2. Load children via the configured provider and enforce the gate.
    let tickets: Ticket[];
    try {
      tickets =
        TICKET_PROVIDER === "jira"
          ? await getTicketsForWorkflowFromJira(workflowId)
          : await getTicketsForWorkflowFromDynamo(workflowId);
    } catch (err) {
      return NextResponse.json(
        { error: `Could not load tickets to verify completion: ${(err as Error).message}` },
        { status: 502 }
      );
    }

    const open = openChildren(tickets);
    if (open.length > 0) {
      return NextResponse.json(
        {
          error: "Work not finished — refusing to complete",
          openTickets: open.map((t) => ({
            ticketId: t.ticketId,
            status: t.status,
            title: t.title,
          })),
          hint: "Finish or cancel these tickets first — completion has no bypass.",
        },
        { status: 409 }
      );
    }

    const completedAt = new Date().toISOString();

    // 3. Roll the epic up in Jira so the board reflects the closure. Best-effort:
    //    a board without a Done transition (or DynamoDB mode) just skips this.
    let epicRolledUp = false;
    if (TICKET_PROVIDER === "jira" && workflow.epicId) {
      try {
        await JiraClient.fromEnv().transitionIssue(String(workflow.epicId), "Done");
        epicRolledUp = true;
      } catch (err) {
        console.warn(`[complete] epic ${workflow.epicId} roll-up skipped: ${(err as Error).message}`);
      }
    }

    // 4. Conditional write — set terminal phase, stamp completion, stop the
    //    watch, AND compact runaway escalation noise in the SAME write so the
    //    item shrinks rather than grows. A bloated record (near the 400KB limit
    //    from thousands of no-op escalations) is exactly what makes this write
    //    fail; rewriting humanNotifications smaller guarantees it lands.
    const compacted = compactNotifications(
      (workflow.humanNotifications as Notification[]) || []
    );
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: WORKFLOWS_TABLE,
          Key: { workflowId },
          UpdateExpression:
            "SET #phase = :complete, completedAt = :ts, previousPhase = :prev, managerWatch = :false, humanNotifications = :notifs" +
            (reason ? ", completeReason = :reason" : ""),
          ConditionExpression:
            "#phase <> :complete AND #phase <> :error AND #phase <> :alreadyCancelled",
          ExpressionAttributeNames: { "#phase": "phase" },
          ExpressionAttributeValues: {
            ":complete": "complete",
            ":ts": completedAt,
            ":prev": workflow.phase,
            ":false": false,
            ":notifs": compacted,
            ":error": "error",
            ":alreadyCancelled": "cancelled",
            ...(reason ? { ":reason": reason } : {}),
          },
        })
      );
    } catch (err: unknown) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        return NextResponse.json(
          { error: "Workflow already in terminal state", phase: workflow.phase },
          { status: 409 }
        );
      }
      throw err;
    }

    // 5. Publish workflow.complete. Two sinks, matching the orchestrator's
    //    publishEvent: EventBridge (source agentcore-hub.orchestrator, detail
    //    type workflow.complete) drives the ANALYZE trigger; the events-table
    //    row is partitioned under workflowId so the live SSE board — which
    //    queries by workflowId — clears immediately. Both are non-fatal.
    const detail = {
      workflowId,
      completedAt,
      previousPhase: workflow.phase,
      closedBy: "workflow-manager",
      epicRolledUp,
      ...(reason ? { reason } : {}),
    };
    try {
      await eventBridge.send(
        new PutEventsCommand({
          Entries: [
            {
              Source: "agentcore-hub.orchestrator",
              DetailType: "workflow.complete",
              Detail: JSON.stringify({ ...detail, timestamp: completedAt }),
              EventBusName: EVENT_BUS,
            },
          ],
        })
      );
    } catch (err) {
      console.warn(`[complete] EventBridge publish failed: ${(err as Error).message}`);
    }
    try {
      await ddb.send(
        new PutCommand({
          TableName: EVENTS_TABLE,
          Item: {
            workflowId,
            eventId: `${Date.now()}-complete-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: completedAt,
            type: "workflow.complete",
            detail,
          },
        })
      );
    } catch {
      /* event publish is non-fatal */
    }

    console.log(
      `[complete] Workflow ${workflowId} completed (was: ${workflow.phase}, epicRolledUp=${epicRolledUp})`
    );
    return NextResponse.json(
      { status: "complete", completedAt, epicRolledUp, ...(reason ? { reason } : {}) },
      { status: 200 }
    );
  } catch (err) {
    console.error("[complete] Error:", err);
    return NextResponse.json(
      { error: `Failed to complete workflow: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
