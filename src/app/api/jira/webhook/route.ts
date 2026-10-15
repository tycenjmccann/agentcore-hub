/**
 * POST /api/jira/webhook — Jira Cloud Webhook Receiver
 *
 * Thin adapter: receives Jira webhook, extracts the status change, and
 * enqueues a command on the workflow FIFO queue (WORKFLOW_COMMAND_QUEUE_URL).
 * MessageGroupId = the workflow's root issue key, so all commands for one
 * workflow are processed strictly in order by the orchestrator — concurrent
 * webhook deliveries for the same run can no longer race each other
 * (R1 of docs/race-condition-study.md). Content-based dedup on
 * (issueKey, status, Jira event timestamp) absorbs at-least-once redeliveries.
 *
 * The orchestrator handles ALL logic (context building, agent invocation,
 * cascade, phase advancement). This route just translates the Jira event
 * into the orchestrator's input format.
 *
 * Fallback: when WORKFLOW_COMMAND_QUEUE_URL is unset, invokes the
 * orchestrator Lambda directly (pre-R1 behavior) so the app keeps working
 * against an install that hasn't created the queue yet.
 *
 * TEAM-6121: the route fails CLOSED. There is no default secret: an unset or
 * blank JIRA_WEBHOOK_SECRET answers 503 before any SQS/Lambda call. Otherwise
 * Jira's own admin-webhook signature (`X-Hub-Signature: sha256=<hex hmac of
 * the raw body>` — see src/lib/auth/hub-signature.ts) is verified before the
 * body is parsed; a missing/wrong/non-sha256 signature answers 401. Rollout
 * order matters: set JIRA_WEBHOOK_SECRET and re-register the Jira webhook
 * with that secret (deploy/apprunner/setup-jira-webhook.sh) BEFORE deploying
 * this check, or every Jira delivery gets a 503 until both are done.
 */

import { NextRequest, NextResponse } from "next/server";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { mapJiraStatusToInternal } from "@/lib/workflow/jira-client";
import { commandGroupId, commandDedupId } from "@/lib/workflow/command-queue";
import { verifyHubSignature } from "@/lib/auth/hub-signature";

const REGION = process.env.AWS_REGION || "us-east-1";
const ORCHESTRATOR_LAMBDA = process.env.ORCHESTRATOR_LAMBDA || "agentcore-hub-orchestrator";
const COMMAND_QUEUE_URL = process.env.WORKFLOW_COMMAND_QUEUE_URL || "";

const lambda = new LambdaClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });

interface JiraWebhookPayload {
  webhookEvent?: string;
  timestamp?: number;
  issue?: {
    key: string;
    fields: {
      summary: string;
      status: { name: string };
      parent?: { key: string };
      labels: string[];
      [key: string]: unknown;
    };
  };
  changelog?: {
    id?: string; // TEAM-5731: forwarded so the orchestrator can bind a self-park's claim release to THIS entry
    items: Array<{
      field: string;
      fromString: string;
      toString: string;
    }>;
  };
}

async function dispatchCommand(
  payload: JiraWebhookPayload,
  issueKey: string,
  newStatus: string,
  oldStatus: string
) {
  const command = {
    source: "jira-webhook",
    ticketId: issueKey,
    newStatus,
    oldStatus,
    // TEAM-5731: additive — only when Jira sent a changelog id; the orchestrator's newest-status-change rule decides alone without it.
    ...(payload.changelog?.id != null ? { changelogId: String(payload.changelog.id) } : {}),
  };

  if (COMMAND_QUEUE_URL) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: COMMAND_QUEUE_URL,
        MessageBody: JSON.stringify(command),
        MessageGroupId: commandGroupId(issueKey, payload.issue?.fields?.parent?.key),
        MessageDeduplicationId: commandDedupId(issueKey, newStatus, payload.timestamp),
      })
    );
    return;
  }

  // Legacy direct invoke (no queue configured).
  await lambda.send(
    new InvokeCommand({
      FunctionName: ORCHESTRATOR_LAMBDA,
      InvocationType: "Event",
      Payload: JSON.stringify(command),
    })
  );
}

export async function POST(req: NextRequest) {
  // TEAM-6121: fail closed — no secret configured means no caller is authenticated.
  const secret = (process.env.JIRA_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    return NextResponse.json({ error: "webhook disabled: JIRA_WEBHOOK_SECRET not configured" }, { status: 503 });
  }
  const raw = await req.text();
  if (!verifyHubSignature(raw, req.headers.get("x-hub-signature"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: JiraWebhookPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!payload.issue) {
    return NextResponse.json({ received: true, ignored: true, reason: "no issue" });
  }

  const issueKey = payload.issue.key;

  // Handle issue_created — new ticket, treat as status=todo with no old status
  if (payload.webhookEvent === "jira:issue_created") {
    const newStatus = mapJiraStatusToInternal(payload.issue.fields.status.name);
    console.log(`[jira-webhook] ${issueKey}: CREATED (${newStatus})`);

    try {
      await dispatchCommand(payload, issueKey, newStatus, "new");
      return NextResponse.json({ received: true, processed: true, issueKey, newStatus });
    } catch (err) {
      console.error(`[jira-webhook] Error dispatching command for ${issueKey}:`, err);
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  // Handle issue_updated — requires changelog with status change
  if (!payload.changelog) {
    return NextResponse.json({ received: true, ignored: true, reason: "no changelog" });
  }

  const statusChange = payload.changelog.items.find(
    (item) => item.field === "status"
  );
  if (!statusChange) {
    return NextResponse.json({ received: true, ignored: true, reason: "no status change" });
  }

  const newStatus = mapJiraStatusToInternal(statusChange.toString || "");
  const oldStatus = mapJiraStatusToInternal(statusChange.fromString || "");

  console.log(`[jira-webhook] ${issueKey}: "${statusChange.fromString}" → "${statusChange.toString}" (${oldStatus} → ${newStatus})`);

  try {
    await dispatchCommand(payload, issueKey, newStatus, oldStatus);
    return NextResponse.json({
      received: true,
      processed: true,
      issueKey,
      newStatus,
    });
  } catch (err) {
    console.error(`[jira-webhook] Error dispatching command for ${issueKey}:`, err);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
