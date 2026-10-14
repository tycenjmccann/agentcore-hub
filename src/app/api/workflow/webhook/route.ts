/**
 * POST /api/workflow/webhook — Webhook Handler (Lambda mode)
 *
 * THIN handler — writes status to DynamoDB only.
 * The DynamoDB Stream triggers the Orchestration Lambda for all downstream logic.
 *
 * Only live caller: Jira status-change webhooks (`jira_transition` / no
 * event_type — see docs/architecture.md "Jira Integration"). The `agent_completion`
 * case was removed (TEAM-5953): it wrote ticket status "done" straight to
 * DynamoDB, bypassing the tickets Lambda's transition_ticket (judgeCompletionRecord
 * + the TEAM-5941 doneIntent fence), and nothing in the repo ever posted it.
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "dev-secret";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function POST(req: NextRequest) {
  // Validate webhook secret
  const secret = req.headers.get("x-webhook-secret");
  if (WEBHOOK_SECRET !== "dev-secret" && secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  return handleLambdaMode(body);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAMBDA MODE — Thin handler: write to DynamoDB, Stream handles cascade
// ═══════════════════════════════════════════════════════════════════════════════

async function handleLambdaMode(body: Record<string, unknown>): Promise<NextResponse> {
  const eventType = body.event_type as string;

  try {
    switch (eventType) {
      case "jira_transition":
      case undefined: {
        const issueKey = (body.issue_key as string) || (body.issue as { key?: string })?.key;
        const changelog = body.changelog as { items?: Array<{ field: string; toString: string }> };
        const statusChange = changelog?.items?.find((i: { field: string }) => i.field === "status");

        if (issueKey && statusChange) {
          const mappedStatus = mapJiraStatus(statusChange.toString.toLowerCase());
          await ddb.send(new UpdateCommand({
            TableName: TICKETS_TABLE,
            Key: { ticketId: issueKey },
            UpdateExpression: "SET #s = :s, #u = :u",
            ExpressionAttributeNames: { "#s": "status", "#u": "updatedAt" },
            ExpressionAttributeValues: { ":s": mappedStatus, ":u": new Date().toISOString() },
          }));
          console.log(`[webhook:lambda] Jira: ${issueKey} → ${mappedStatus}. Stream handles cascade.`);
          return NextResponse.json({ received: true, processed: true, mode: "lambda" });
        }
        return NextResponse.json({ received: true, ignored: true });
      }

      default:
        return NextResponse.json({ received: true, ignored: true });
    }
  } catch (err) {
    console.error("[webhook:lambda] Error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────────

function mapJiraStatus(jiraStatus: string): string {
  const map: Record<string, string> = {
    "to do": "todo",
    "in progress": "in_progress",
    "done": "done",
    "blocked": "blocked",
    "in review": "in_review",
  };
  return map[jiraStatus] || jiraStatus;
}
