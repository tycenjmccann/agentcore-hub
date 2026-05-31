/**
 * POST /api/jira/webhook — Jira Cloud Webhook Receiver
 *
 * Thin adapter: receives Jira webhook, extracts the status change,
 * and invokes the SAME orchestrator Lambda used by the DynamoDB path.
 *
 * The orchestrator handles ALL logic (context building, agent invocation,
 * cascade, phase advancement). This route just translates the Jira event
 * into the orchestrator's input format.
 */

import { NextRequest, NextResponse } from "next/server";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { mapJiraStatusToInternal } from "@/lib/workflow/jira-client";

const REGION = process.env.AWS_REGION || "us-east-1";
const ORCHESTRATOR_LAMBDA = process.env.ORCHESTRATOR_LAMBDA || "agentcore-hub-orchestrator";

const lambda = new LambdaClient({ region: REGION });

interface JiraWebhookPayload {
  webhookEvent?: string;
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
    items: Array<{
      field: string;
      fromString: string;
      toString: string;
    }>;
  };
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
      await lambda.send(
        new InvokeCommand({
          FunctionName: ORCHESTRATOR_LAMBDA,
          InvocationType: "Event",
          Payload: JSON.stringify({
            source: "jira-webhook",
            ticketId: issueKey,
            newStatus,
            oldStatus: "new",
          }),
        })
      );
      return NextResponse.json({ received: true, processed: true, issueKey, newStatus });
    } catch (err) {
      console.error(`[jira-webhook] Error invoking orchestrator for ${issueKey}:`, err);
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

  // Invoke the orchestrator Lambda with the status change — same Lambda,
  // same logic as DDB stream path. The orchestrator checks TICKET_PROVIDER
  // and reads from Jira or DynamoDB accordingly.
  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: ORCHESTRATOR_LAMBDA,
        InvocationType: "Event", // Async — don't block the webhook response
        Payload: JSON.stringify({
          source: "jira-webhook",
          ticketId: issueKey,
          newStatus,
          oldStatus,
        }),
      })
    );

    return NextResponse.json({
      received: true,
      processed: true,
      issueKey,
      newStatus,
    });
  } catch (err) {
    console.error(`[jira-webhook] Error invoking orchestrator for ${issueKey}:`, err);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}
