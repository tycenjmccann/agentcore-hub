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

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const EVENTS_TABLE = process.env.EVENTS_TABLE || "agentcore-hub-events";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const dynamic = "force-dynamic";

// ─── Jira helpers ───────────────────────────────────────────────────────────

function getJiraAuth() {
  const siteUrl = process.env.JIRA_SITE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;
  const projectKey = process.env.JIRA_PROJECT_KEY;
  if (!siteUrl || !email || !apiToken || !projectKey) return null;
  return {
    baseUrl: `https://${siteUrl}`,
    authHeader: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
    projectKey,
  };
}

async function jiraRequest(method: string, path: string, body?: unknown) {
  const auth = getJiraAuth();
  if (!auth) throw new Error("Jira not configured");
  const url = `${auth.baseUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth.authHeader,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Jira ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

const JIRA_STATUS_MAP: Record<string, string> = {
  "To Do": "todo",
  "Ready": "ready",
  "In Progress": "in_progress",
  "In Review": "in_review",
  "Blocked": "blocked",
  "Done": "done",
  "Backlog": "backlog",
};

async function jiraTransitionTo(issueKey: string, targetStatus: string) {
  const data = await jiraRequest("GET", `/rest/api/3/issue/${issueKey}/transitions`);
  const transitions = (data.transitions || []) as Array<{ id: string; name: string; to?: { name?: string } }>;
  const transition = transitions.find(
    (t) => t.name === targetStatus || t.to?.name === targetStatus
  );
  if (!transition) {
    console.warn(`[nudge] No transition to "${targetStatus}" for ${issueKey}`);
    return false;
  }
  await jiraRequest("POST", `/rest/api/3/issue/${issueKey}/transitions`, {
    transition: { id: transition.id },
  });
  return true;
}

// ─── Nudge via Jira ─────────────────────────────────────────────────────────

async function nudgeJira(epicId: string, workflowId: string) {
  const auth = getJiraAuth();
  if (!auth) throw new Error("Jira not configured");

  // Get all child issues of the epic
  const jql = encodeURIComponent(`parent = ${epicId} AND project = ${auth.projectKey}`);
  const data = await jiraRequest(
    "GET",
    `/rest/api/3/search/jql?jql=${jql}&fields=status,issuelinks,labels&maxResults=100`
  );
  const issues = (data.issues || []) as Array<Record<string, unknown>>;
  const nudged: string[] = [];

  // Build status map
  const statusMap = new Map<string, string>();
  for (const issue of issues) {
    const key = issue.key as string;
    const fields = issue.fields as Record<string, unknown>;
    const status = fields?.status as Record<string, unknown>;
    const statusName = (status?.name as string) || "To Do";
    statusMap.set(key, JIRA_STATUS_MAP[statusName] || "todo");
  }

  for (const issue of issues) {
    const key = issue.key as string;
    const fields = issue.fields as Record<string, unknown>;
    const status = fields?.status as Record<string, unknown>;
    const statusName = (status?.name as string) || "To Do";
    const internalStatus = JIRA_STATUS_MAP[statusName] || "todo";

    // Get blockers from issue links
    const issueLinks = (fields?.issuelinks as Array<Record<string, unknown>>) || [];
    const blockedBy: string[] = [];
    for (const link of issueLinks) {
      const linkType = link.type as Record<string, unknown>;
      if (linkType?.name === "Blocks" && link.inwardIssue) {
        blockedBy.push((link.inwardIssue as Record<string, unknown>).key as string);
      }
    }

    // Case 1: "todo" or "To Do" with no blockers — should be running
    if (internalStatus === "todo" && blockedBy.length === 0) {
      const ok = await jiraTransitionTo(key, "Ready");
      if (ok) nudged.push(`${key} (todo→ready)`);
    }

    // Case 2: "blocked" but all blockers are done
    if (internalStatus === "blocked") {
      const allDone = blockedBy.length === 0 || blockedBy.every(
        (b) => statusMap.get(b) === "done"
      );
      if (allDone) {
        const ok = await jiraTransitionTo(key, "Ready");
        if (ok) nudged.push(`${key} (unblocked→ready)`);
      }
    }
  }

  return { ticketsScanned: issues.length, nudged };
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
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const workflowId = params.id;

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

    let result: { ticketsScanned: number; nudged: string[] };

    if (ticketProvider === "jira") {
      if (!epicId) {
        return NextResponse.json({ error: "Workflow has no epicId — cannot query Jira" }, { status: 400 });
      }
      result = await nudgeJira(epicId, workflowId);
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
