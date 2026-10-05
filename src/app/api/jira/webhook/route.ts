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
 * TEAM-5322 F7 — the one exception to "thin": a human closing a gate to Done in the
 * Jira UI bypasses the ticket twin, so a decision-bound gate could close on no
 * decision. A human-gate Done made by anyone but the service account is RATIFIED
 * through the twin (Tickets___transition_ticket on an already-Done issue runs the
 * same guards and records what they admit). If the twin answers decision_required
 * the route reopens the gate to In Review, says why, re-pages it
 * (gate:awaiting-console) and forwards in_review instead of done. The decision
 * itself still lives in the twin; nothing here decides what work happens next.
 *
 * Fallback: when WORKFLOW_COMMAND_QUEUE_URL is unset, invokes the
 * orchestrator Lambda directly (pre-R1 behavior) so the app keeps working
 * against an install that hasn't created the queue yet.
 */

import { NextRequest, NextResponse } from "next/server";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { JiraClient, mapJiraStatusToInternal } from "@/lib/workflow/jira-client";
import { commandGroupId, commandDedupId } from "@/lib/workflow/command-queue";

const REGION = process.env.AWS_REGION || "us-east-1";
const ORCHESTRATOR_LAMBDA = process.env.ORCHESTRATOR_LAMBDA || "agentcore-hub-orchestrator";
const COMMAND_QUEUE_URL = process.env.WORKFLOW_COMMAND_QUEUE_URL || "";
const TICKET_TOOLS_LAMBDA = process.env.TICKET_TOOLS_LAMBDA || "agentcore-hub-tickets";

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
  // The Jira user who made the change (absent on some system events).
  user?: { accountId?: string };
  changelog?: {
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
  const command = { source: "jira-webhook", ticketId: issueKey, newStatus, oldStatus };

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

// The service account is the identity every twin/hub transition is made as. Cached
// per container: it never changes without a redeploy of the credentials.
let serviceAccountCache: string | null = null;
async function serviceAccountId(): Promise<string | null> {
  if (serviceAccountCache) return serviceAccountCache;
  try {
    serviceAccountCache = (await JiraClient.fromEnv().myself()).accountId || null;
  } catch (err) {
    console.warn(`[jira-webhook] could not resolve the service account: ${(err as Error).message}`);
  }
  return serviceAccountCache;
}

/** Human-review gates carry `reviewer:<who>` (jira-read.ts surfaces it as human:*). */
function isHumanGate(labels: unknown): boolean {
  return Array.isArray(labels) && labels.some((l) => typeof l === "string" && l.startsWith("reviewer:"));
}

async function invokeTicketTool(toolName: string, parameters: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const res = await lambda.send(
    new InvokeCommand({
      FunctionName: TICKET_TOOLS_LAMBDA,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({ tool_name: toolName, parameters })),
    })
  );
  if (res.FunctionError || !res.Payload) return null;
  try {
    return JSON.parse(Buffer.from(res.Payload).toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * TEAM-5322 F7 — ratify a human's Jira-UI Done through the twin. Returns the status
 * to forward: "done" when the twin admits it (or when nothing can be proven either
 * way — a ratify the twin could not answer leaves today's behaviour), "in_review"
 * when the gate was put back.
 */
async function ratifyJiraUiDone(issueKey: string, accountId: string): Promise<"done" | "in_review"> {
  let result: Record<string, unknown> | null;
  try {
    result = await invokeTicketTool("Tickets___transition_ticket", {
      ticket_id: issueKey,
      transition_id: "done",
      reason: `ratify: Jira UI close by ${accountId}`,
    });
  } catch (err) {
    console.warn(`[jira-webhook] ${issueKey}: ratify invoke failed (${(err as Error).name}) - forwarding done`);
    return "done";
  }
  // A held close (post-condition unmet): the twin already moved it back itself.
  if (result?.status === "verifying") return "in_review";
  if (result?.reason !== "decision_required") return "done";

  const options = Array.isArray(result.options) ? (result.options as string[]) : [];
  console.warn(`[jira-webhook] ${issueKey}: Jira-UI Done without a decision - reopening to In Review`);
  try {
    const jira = JiraClient.fromEnv();
    await jira.transitionToInternalStatus(issueKey, "in_review");
    await jira.addComment(
      issueKey,
      "gate-guard",
      `Reopened: this gate was closed in the Jira UI without a decision. ` +
        `Pick one of: ${options.join(" | ")} - from the hub console or the Telegram gate message.`
    );
  } catch (err) {
    console.error(`[jira-webhook] ${issueKey}: could not reopen the gate: ${(err as Error).message}`);
  }
  try {
    await invokeTicketTool("Tickets___labels_add", { ticket_id: issueKey, labels: ["gate:awaiting-console"] });
  } catch (err) {
    console.warn(`[jira-webhook] ${issueKey}: could not re-page the gate (${(err as Error).name})`);
  }
  return "in_review";
}

export async function POST(req: NextRequest) {
  let payload: JiraWebhookPayload;
  try {
    payload = await req.json();
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

  let newStatus = mapJiraStatusToInternal(statusChange.toString || "");
  const oldStatus = mapJiraStatusToInternal(statusChange.fromString || "");

  const actor = payload.user?.accountId;
  if (newStatus === "done" && actor && isHumanGate(payload.issue.fields.labels)) {
    const svc = await serviceAccountId();
    // Unknown service account ⇒ the twin's own close cannot be told apart from a
    // human's, and ratifying the twin's own (token-carrying) close without its token
    // would reopen it. Leave it alone rather than guess.
    if (svc && actor !== svc) newStatus = await ratifyJiraUiDone(issueKey, actor);
  }

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
