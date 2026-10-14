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
 *
 * TEAM-6094 (TEAM-6097): the route fails CLOSED. There is no default secret: an
 * unset/blank WEBHOOK_SECRET, or the old "dev-secret" placeholder that used to
 * switch the check OFF, answers 503 before any DynamoDB or Lambda call; otherwise
 * x-webhook-secret is compared in constant time (401 on mismatch). And a `→ done`
 * NEVER lands with a raw UpdateCommand: it goes through Tickets___transition_ticket
 * on the tickets Lambda — the same invoke src/app/api/workflow/[id]/tickets/transition
 * makes — so the completion-record / brief-hold guard and the doneIntent fence
 * (gate-contract.mjs) see it like any other Done. Every other status is still a
 * direct write; only `done` has a guard to skip.
 *
 * TEAM-6123: a 200 for that `done` invoke requires positive proof the ticket
 * moved (provesTransitioned), not just the absence of a recognized refusal —
 * see transitionDoneViaLambda below.
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { secretMatches } from "@/lib/auth/secret-match";
import { rejectedDetails, provesTransitioned } from "@/lib/workflow/ticket-transition-refusal";

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const TICKET_TOOLS_LAMBDA = process.env.TICKET_TOOLS_LAMBDA || "agentcore-hub-tickets";
/** The placeholder every deploy used to ship unset as — a configured value of it is no secret. */
const PLACEHOLDER_SECRET = "dev-secret";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const lambda = new LambdaClient({ region: REGION });

export async function POST(req: NextRequest) {
  // TEAM-6094: fail closed — no secret configured means no caller is authenticated.
  const expected = (process.env.WEBHOOK_SECRET || "").trim();
  if (!expected || expected === PLACEHOLDER_SECRET) {
    return NextResponse.json({ error: "webhook disabled: WEBHOOK_SECRET not configured" }, { status: 503 });
  }
  if (!secretMatches(req.headers.get("x-webhook-secret") || "", expected)) {
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
          // TEAM-6094: a Done goes through the tickets Lambda's guard — see the header.
          if (mappedStatus === "done") {
            const refused = await transitionDoneViaLambda(issueKey, "Jira webhook transition to Done");
            if (refused) return refused;
            console.log(`[webhook:lambda] Jira: ${issueKey} → done via tickets Lambda. Stream handles cascade.`);
            return NextResponse.json({ received: true, processed: true, mode: "lambda", via: "tickets-lambda" });
          }
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

/**
 * TEAM-6094: `→ done` through Tickets___transition_ticket, the same invoke as
 * src/app/api/workflow/[id]/tickets/transition/route.ts. Returns the error response
 * to send back, or null when the Lambda PROVED it moved the ticket (it wrote the
 * status; the Stream does the rest). An invoke failure or FunctionError is 502; a
 * refusal the Lambda reported inside a 200 (rejectedDetails — e.g. a brief hold) is
 * 409; TEAM-6123: anything else — unparseable, "null", "{}", or any shape that does
 * not positively prove the move (provesTransitioned) — is also 502, since nothing
 * here proves the ticket actually transitioned.
 */
async function transitionDoneViaLambda(ticketId: string, reason: string): Promise<NextResponse | null> {
  let response;
  try {
    response = await lambda.send(new InvokeCommand({
      FunctionName: TICKET_TOOLS_LAMBDA,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify({
        tool_name: "Tickets___transition_ticket",
        parameters: { ticket_id: ticketId, transition_id: "done", reason },
      })),
    }));
  } catch (err) {
    return NextResponse.json({ error: "tickets Lambda invocation failed", details: (err as Error).message }, { status: 502 });
  }

  const text = response.Payload ? Buffer.from(response.Payload).toString() : "";
  if (response.FunctionError) {
    return NextResponse.json({ error: "tickets Lambda invocation failed", details: text || response.FunctionError }, { status: 502 });
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // An unreadable payload proves nothing — falls through to the unproven 502 below.
  }
  const refusal = rejectedDetails(parsed, "done");
  if (refusal) {
    console.warn(`[webhook:lambda] ${ticketId}: tickets Lambda refused the transition to done: ${refusal}`);
    return NextResponse.json({ error: "Ticket transition rejected", details: refusal, ticketId }, { status: 409 });
  }
  if (!provesTransitioned(parsed, "done")) {
    console.warn(`[webhook:lambda] ${ticketId}: tickets Lambda did not confirm the transition to done: ${text.slice(0, 500)}`);
    return NextResponse.json(
      { error: "tickets Lambda did not confirm the transition", details: text.slice(0, 500), ticketId },
      { status: 502 }
    );
  }
  return null;
}

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
