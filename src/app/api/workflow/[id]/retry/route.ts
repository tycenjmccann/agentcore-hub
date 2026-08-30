/**
 * POST /api/workflow/[id]/retry
 *
 * Restarts a stuck/failed agent by transitioning its ticket back to "Ready"
 * and updating the workflow's agentTasks status.
 *
 * Supports both DynamoDB and Jira ticket providers — reads the workflow record
 * to determine which provider to use (same as nudge endpoint).
 *
 * Body: { agentId: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { JiraClient, mapJiraStatusToInternal } from "@/lib/workflow/jira-client";
import { isLeaseLive, lastAgentActivity, stealClaim, LEASE_TTL_MS } from "@/lib/workflow/lease";

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";

/** Thrown when the target's lease is live — surfaced as HTTP 409. */
class LeaseLiveError extends Error {
  constructor(agentId: string, lastActivity: string | null) {
    super(
      `Agent ${agentId} holds a LIVE lease (last activity ${lastActivity || "at claim"}, ` +
      `TTL ${Math.round(LEASE_TTL_MS / 60000)}m). It is likely still working — retrying now would ` +
      `spawn a second agent on the same ticket (duplicate PRs). Pass force=true only with ` +
      `evidence the session is dead (dossier, session logs).`
    );
    this.name = "LeaseLiveError";
  }
}

/**
 * Lease gate + atomic steal (R3 — docs/race-condition-study.md). The old
 * release was unconditional: a retry against a slow-but-alive agent released
 * its claim and re-invoked, putting two agents on one ticket. Now:
 *  1. refuse while the lease is live (any event from the agent within TTL),
 *     unless force;
 *  2. steal via CAS on the claim's startedAt generation — one winner under
 *     concurrent stealers, never clobbers a re-issued claim.
 */
async function leaseAwareRelease(
  workflowId: string,
  ticketId: string,
  agentId: string,
  task: Record<string, unknown>,
  force: boolean
) {
  if (!force) {
    const lastActivity = await lastAgentActivity(ddb, EVENTS_TABLE, workflowId, agentId);
    if (isLeaseLive(task, lastActivity, Date.now())) {
      throw new LeaseLiveError(agentId, lastActivity);
    }
  }
  const stolen = await stealClaim(
    ddb, WORKFLOWS_TABLE, workflowId, ticketId, task.startedAt as string | undefined
  );
  if (!stolen) {
    throw new Error(
      `Claim on ${ticketId} moved while retrying (completed or re-claimed) — nothing to retry.`
    );
  }
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const dynamic = "force-dynamic";

// ─── Retry via Jira ─────────────────────────────────────────────────────────

async function retryJira(workflowId: string, agentId: string, agentTasks: Record<string, Record<string, unknown>>, force: boolean) {
  // Only an actively-running task is retryable (never reset done/in_review work).
  const ticketId = Object.keys(agentTasks).find((key) => {
    const t = agentTasks[key];
    return (t.agentId === agentId || t.assignee === agentId) &&
      (t.status === "running" || t.status === "in_progress");
  });

  if (!ticketId) {
    throw new Error(`No active ticket found for agent ${agentId}`);
  }

  // Check the LIVE Jira status, not just the cached agentTasks entry. The
  // webhook has no in_review case, so a ticket a human moved to In Review can
  // still show "running" in agentTasks — retrying it would yank a human-owned
  // review back to Ready.
  const jira = JiraClient.fromEnv();
  const issue = await jira.getIssue(ticketId, ["status"]);
  const live = mapJiraStatusToInternal(issue.fields.status?.name || "To Do");
  if (live === "done" || live === "in_review" || live === "cancelled") {
    throw new Error(`Ticket ${ticketId} is ${live} in Jira — not retryable`);
  }

  // Lease-gated steal BEFORE the transition. The orchestrator's idempotency
  // lock is agentTasks[ticketId].status — the "ready" webhook can arrive
  // before a post-transition write lands, and a still-"running" status would
  // make the orchestrator skip the retry as a duplicate.
  await leaseAwareRelease(workflowId, ticketId, agentId, agentTasks[ticketId], force);

  // Transition Jira ticket back to Ready, falling back to To Do (some boards
  // don't have a "Ready" state).
  try {
    await jira.transitionIssue(ticketId, "Ready");
  } catch {
    await jira.transitionIssue(ticketId, "To Do");
  }

  return ticketId;
}

// ─── Retry via DynamoDB ─────────────────────────────────────────────────────

async function retryDynamoDB(workflowId: string, agentId: string, agentTasks: Record<string, Record<string, unknown>>, force: boolean) {
  // Only an actively-running task is retryable. Never reset a done/in_review/
  // cancelled ticket — that would clobber completed work or a human review gate.
  // (Same guard as retryJira; relied on by the Workflow Manager's watch mode.)
  const ticketId = Object.keys(agentTasks).find((key) => {
    const t = agentTasks[key];
    return (t.agentId === agentId || t.assignee === agentId) &&
      (t.status === "running" || t.status === "in_progress");
  });

  if (!ticketId) {
    throw new Error(`No active (running) ticket found for agent ${agentId}`);
  }

  // Lease-gated steal FIRST (see retryJira) — the stream event from the
  // ticket write below races the agentTasks update otherwise.
  await leaseAwareRelease(workflowId, ticketId, agentId, agentTasks[ticketId], force);

  // Reset ticket to "ready" in the tickets table
  await ddb.send(new UpdateCommand({
    TableName: TICKETS_TABLE,
    Key: { ticketId },
    UpdateExpression: "SET #s = :s, #u = :u",
    ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
    ExpressionAttributeValues: { ":s": "ready", ":u": new Date().toISOString() },
  }));

  return ticketId;
}

// ─── Route Handler ──────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;
  const { agentId, force } = await req.json();

  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  try {
    // 1. Get workflow record to determine ticket provider
    const wfResult = await ddb.send(new GetCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
    }));
    if (!wfResult.Item) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }

    const workflow = wfResult.Item;
    const ticketProvider = process.env.TICKET_PROVIDER || "dynamodb";
    const agentTasks = workflow.agentTasks || {};

    // 2. Execute retry based on TICKET_PROVIDER env var (set at deploy time)
    let ticketId: string;
    if (ticketProvider === "jira") {
      ticketId = await retryJira(workflowId, agentId, agentTasks, force === true);
    } else {
      ticketId = await retryDynamoDB(workflowId, agentId, agentTasks, force === true);
    }

    // 4. Publish retry event
    await ddb.send(new PutCommand({
      TableName: EVENTS_TABLE,
      Item: {
        workflowId,
        eventId: `${Date.now()}-retry-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        type: "agent.retry",
        detail: {
          agentId,
          ticketId,
          reason: "manual_restart",
        },
      },
    }));

    return NextResponse.json({
      success: true,
      ticketId,
      agentId,
      message: `Restarting ${agentId} — ticket ${ticketId} transitioned to Ready`,
    });
  } catch (err) {
    console.error("[retry] Error:", err);
    const status = (err as Error).name === "LeaseLiveError" ? 409 : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
