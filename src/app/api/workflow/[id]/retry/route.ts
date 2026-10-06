/**
 * POST /api/workflow/[id]/retry
 *
 * Restarts a stuck/failed agent by transitioning its ticket back to "Ready"
 * and updating the workflow's agentTasks status.
 *
 * Eligible: the agent's running/in_progress or error task, or any task of the
 * agent's the orchestrator PARKED (DL-035). A parked ticket is un-parked first —
 * parkedTickets and redispatchCounts both cleared — because the orchestrator's
 * claim CAS refuses a parked ticket, so the Ready below would otherwise
 * dispatch nothing (TEAM-5323). 404 TASK_NOT_FOUND when nothing is eligible.
 *
 * TEAM-5338 F1: clearing a park is a human decision (the orchestrator parked the
 * ticket so an agent loop stops), so a PARKED target needs a real human caller
 * (requireHumanIdentity): under AUTH_MODE=none, or for a svc: identity, it is
 * 403 human_identity_required before any lease, park or status write. A retry of
 * an unparked running/errored ticket stays open to any caller, so the Workflow
 * Manager's intervene.py retry keeps working; it can no longer un-park.
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
import { isParked } from "@/lib/workflow/park";
// TEAM-5347 F6: the one lease-first release both retry and the targeted nudge use.
import { releaseClaimGated } from "@/lib/workflow/claim-release";
import {
  HumanIdentityRequiredError,
  assertMayUnpark,
  humanIdentityRequiredBody,
  requireHumanIdentity,
  type HumanIdentityResult,
} from "@/lib/auth/human";

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";

/** Thrown when the agent has no retryable task — surfaced as HTTP 404. */
class TaskNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskNotFoundError";
  }
}

type Task = Record<string, unknown>;
type WorkflowRow = { agentTasks?: Record<string, Task>; parkedTickets?: Record<string, unknown> };

const LIVE_STATUSES = new Set(["running", "in_progress"]);
/** Never reset these — finished work or a human-owned review. */
const SETTLED_STATUSES = new Set(["done", "complete", "in_review", "cancelled"]);

/**
 * The agent's retryable ticket: an active or errored task, or a parked one.
 * Never a settled task, parked or not.
 */
function retryableTicket(workflow: WorkflowRow, agentId: string): { ticketId: string; parked: boolean } | null {
  const agentTasks = workflow.agentTasks || {};
  const mine = Object.keys(agentTasks).filter((key) => {
    const t = agentTasks[key];
    return (t.agentId === agentId || t.assignee === agentId) && !SETTLED_STATUSES.has(String(t.status));
  });
  const ticketId = mine.find((key) => {
    const status = String(agentTasks[key].status);
    return LIVE_STATUSES.has(status) || status === "error" || isParked(workflow, key);
  });
  return ticketId ? { ticketId, parked: isParked(workflow, ticketId) } : null;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const dynamic = "force-dynamic";

// ─── Retry via Jira ─────────────────────────────────────────────────────────

async function retryJira(workflowId: string, agentId: string, workflow: WorkflowRow, force: boolean, human: HumanIdentityResult) {
  const target = retryableTicket(workflow, agentId);
  if (!target) {
    throw new TaskNotFoundError(`No retryable (running, error or parked) ticket found for agent ${agentId}`);
  }
  const { ticketId, parked } = target;

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

  // Un-park + lease-gated steal BEFORE the transition. The orchestrator's
  // idempotency lock is agentTasks[ticketId].status — the "ready" webhook can
  // arrive before a post-transition write lands, and a still-"running" status
  // (or a park) would make the orchestrator skip the retry.
  const { unparked } = await releaseClaimGated({
    ddb, workflowsTable: WORKFLOWS_TABLE, eventsTable: EVENTS_TABLE, workflowId, ticketId, agentId,
    task: workflow.agentTasks![ticketId], parked, force, human, verb: "retrying",
  });

  // Transition Jira ticket back to Ready, falling back to To Do (some boards
  // don't have a "Ready" state).
  try {
    await jira.transitionIssue(ticketId, "Ready");
  } catch {
    await jira.transitionIssue(ticketId, "To Do");
  }

  return { ticketId, unparked };
}

// ─── Retry via DynamoDB ─────────────────────────────────────────────────────

async function retryDynamoDB(workflowId: string, agentId: string, workflow: WorkflowRow, force: boolean, human: HumanIdentityResult) {
  // Never reset a done/in_review/cancelled ticket — that would clobber completed
  // work or a human review gate. (Same guard as retryJira; relied on by the
  // Workflow Manager's watch mode.)
  const target = retryableTicket(workflow, agentId);
  if (!target) {
    throw new TaskNotFoundError(`No retryable (running, error or parked) ticket found for agent ${agentId}`);
  }
  const { ticketId, parked } = target;

  // Un-park + lease-gated steal FIRST (see retryJira) — the stream event from
  // the ticket write below races the agentTasks update otherwise.
  const { unparked } = await releaseClaimGated({
    ddb, workflowsTable: WORKFLOWS_TABLE, eventsTable: EVENTS_TABLE, workflowId, ticketId, agentId,
    task: workflow.agentTasks![ticketId], parked, force, human, verb: "retrying",
  });

  // Reset ticket to "ready" in the tickets table
  await ddb.send(new UpdateCommand({
    TableName: TICKETS_TABLE,
    Key: { ticketId },
    UpdateExpression: "SET #s = :s, #u = :u",
    ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
    ExpressionAttributeValues: { ":s": "ready", ":u": new Date().toISOString() },
  }));

  return { ticketId, unparked };
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

    const workflow = wfResult.Item as WorkflowRow;
    const ticketProvider = process.env.TICKET_PROVIDER || "dynamodb";

    // 2. Execute retry based on TICKET_PROVIDER env var (set at deploy time)
    const human = requireHumanIdentity(req);
    const { ticketId, unparked } = ticketProvider === "jira"
      ? await retryJira(workflowId, agentId, workflow, force === true, human)
      : await retryDynamoDB(workflowId, agentId, workflow, force === true, human);

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
          unparked,
        },
      },
    }));

    return NextResponse.json({
      success: true,
      ticketId,
      agentId,
      unparked,
      message: `Restarting ${agentId} — ticket ${ticketId}${unparked ? " un-parked and" : ""} transitioned to Ready`,
    });
  } catch (err) {
    if (err instanceof HumanIdentityRequiredError) {
      return NextResponse.json(humanIdentityRequiredBody(err.reason, err.ticketId), { status: 403 });
    }
    console.error("[retry] Error:", err);
    const leaseLive = (err as Error).name === "LeaseLiveError";
    if ((err as Error).name === "TaskNotFoundError") {
      return NextResponse.json({ error: "TASK_NOT_FOUND", message: (err as Error).message }, { status: 404 });
    }
    return NextResponse.json(
      { error: (err as Error).message, ...(leaseLive ? { code: "LEASE_LIVE" } : {}) },
      { status: leaseLive ? 409 : 500 }
    );
  }
}
