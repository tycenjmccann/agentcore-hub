/**
 * POST /api/workflow/webhook — Webhook Handler (Lambda mode)
 *
 * THIN handler — writes status to DynamoDB only.
 * The DynamoDB Stream triggers the Orchestration Lambda for all downstream logic.
 *
 * TEAM-6010: a `→ done` status NEVER lands with a raw UpdateCommand. It is sent
 * through Tickets___transition_ticket on the tickets Lambda — the same call
 * src/app/api/workflow/[id]/tickets/transition/route.ts makes — so the completion-
 * record / brief-hold guard and the doneIntent fence (gate-contract.mjs) see it,
 * exactly as they would a console-driven or agent-driven Done.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { rejectedDetails } from "@/lib/workflow/ticket-transition-refusal";

const REGION = process.env.AWS_REGION || "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE || "agentcore-hub-tickets";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const TICKET_TOOLS_LAMBDA = process.env.TICKET_TOOLS_LAMBDA || "agentcore-hub-tickets";
// TEAM-6010: no default. Unset/blank, or the old "dev-secret" placeholder every
// deploy used to ship unset as, disables the route — fail closed, not open.
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || "").trim();
const WEBHOOK_DISABLED = !WEBHOOK_SECRET || WEBHOOK_SECRET === "dev-secret";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});
const lambda = new LambdaClient({ region: REGION });

// Same idiom as src/app/api/workflow/start/route.ts's secretMatches: equal-length
// buffers only, so a length mismatch never reaches timingSafeEqual (which throws
// on unequal lengths rather than returning false).
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (WEBHOOK_DISABLED) {
    return NextResponse.json(
      { error: "webhook disabled: WEBHOOK_SECRET not configured" },
      { status: 503 }
    );
  }
  if (!secretMatches(req.headers.get("x-webhook-secret") || "", WEBHOOK_SECRET)) {
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
      case "agent_completion": {
        const workflowId = body.workflow_id as string;
        const agentId = body.agent_id as string;
        if (!workflowId || !agentId) {
          return NextResponse.json({ error: "workflow_id and agent_id required" }, { status: 400 });
        }

        // Prefer the ticket_id carried on the request — with fix-ticket
        // fan-out one agent can hold several concurrent entries and the
        // newest-active heuristic below can pick a sibling.
        let ticketId = (body.ticket_id as string) || null;
        if (ticketId) {
          const wf = await getWorkflowFromDynamo(workflowId);
          if (!wf?.agentTasks?.[ticketId]) ticketId = null;
        }
        if (!ticketId) ticketId = await findTicketForAgent(workflowId, agentId);
        if (!ticketId) {
          return NextResponse.json({ received: true, warning: "Ticket not found" });
        }

        // TEAM-6010: the Done goes through the tickets Lambda's guard, not a raw
        // UpdateCommand — see the header comment.
        const refused = await transitionDoneViaLambda(ticketId, `agent_completion from ${agentId}`);
        if (refused) return refused;

        if (body.branch || body.commit_sha || body.pr_url) {
          await updateWorkflowTaskMetadata(workflowId, ticketId, {
            branch: body.branch as string,
            commitSha: body.commit_sha as string,
            prUrl: body.pr_url as string,
            output: (body.output as string)?.slice(0, 10000),
          });
        }

        console.log(`[webhook:lambda] Transitioned ${ticketId} to "done" via tickets Lambda (agent: ${agentId}). Stream handles cascade.`);
        return NextResponse.json({ received: true, ticketId, mode: "lambda", via: "tickets-lambda" });
      }

      case "jira_transition":
      case undefined: {
        const issueKey = (body.issue_key as string) || (body.issue as { key?: string })?.key;
        const changelog = body.changelog as { items?: Array<{ field: string; toString: string }> };
        const statusChange = changelog?.items?.find((i: { field: string }) => i.field === "status");

        if (issueKey && statusChange) {
          const mappedStatus = mapJiraStatus(statusChange.toString.toLowerCase());
          // TEAM-6010: a Done goes through the tickets Lambda's guard — see the
          // header comment. Every other mapped status is still a direct write;
          // only `done` can skip the completion-record / brief-hold gate.
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
 * TEAM-6010: a `→ done` is sent through Tickets___transition_ticket on the tickets
 * Lambda — the same invoke src/app/api/workflow/[id]/tickets/transition/route.ts
 * makes — instead of a raw UpdateCommand, so the completion-record / brief-hold
 * guard and the doneIntent fence (gate-contract.mjs) see every Done this route
 * reports, not just ones that went through the console or an agent's own
 * report_completion. Returns the error response to send back, or null on success
 * (nothing left to do — the Lambda already wrote the status).
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
    return NextResponse.json(
      { error: "tickets Lambda invocation failed", details: (err as Error).message },
      { status: 502 }
    );
  }

  const text = response.Payload ? Buffer.from(response.Payload).toString() : "";
  if (response.FunctionError) {
    return NextResponse.json(
      { error: "tickets Lambda invocation failed", details: text || response.FunctionError },
      { status: 502 }
    );
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Unreadable payload proves nothing — rejectedDetails fails open on it below.
  }
  const refusal = rejectedDetails(parsed, "done");
  if (refusal) {
    console.warn(`[webhook:lambda] ${ticketId}: tickets Lambda refused the transition to done: ${refusal}`);
    return NextResponse.json(
      { error: "Ticket transition rejected", details: refusal, ticketId },
      { status: 409 }
    );
  }
  return null;
}

/**
 * agentTasks is keyed by TICKET id (the orchestrator's claim key). Resolve the
 * agent's ACTIVE ticket — with fix-ticket fan-out one agent can hold several
 * entries, and "any entry for this agent" picks the wrong one.
 */
async function findTicketForAgent(workflowId: string, agentId: string): Promise<string | null> {
  const wf = await getWorkflowFromDynamo(workflowId);
  const tasks: Record<string, Record<string, unknown>> = wf?.agentTasks || {};
  const candidates = Object.values(tasks)
    .filter((t) => t.agentId === agentId && t.ticketId)
    .sort((a, b) => {
      const active = (t: Record<string, unknown>) => (t.status === "running" || t.status === "in_progress" ? 0 : 1);
      if (active(a) !== active(b)) return active(a) - active(b);
      return String(b.startedAt || "").localeCompare(String(a.startedAt || ""));
    });
  return (candidates[0]?.ticketId as string) || null;
}

async function getWorkflowFromDynamo(workflowId: string) {
  const result = await ddb.send(new GetCommand({ TableName: WORKFLOWS_TABLE, Key: { workflowId } }));
  return result.Item || null;
}

/**
 * Scoped per-field merge into agentTasks[ticketId]. The previous version
 * rewrote the ENTIRE agentTasks map from a read snapshot (keyed by agentId,
 * doubly wrong) — resurrecting pre-claim state over concurrent sibling
 * invocation claims (study P1).
 */
async function updateWorkflowTaskMetadata(workflowId: string, ticketId: string, metadata: Record<string, unknown>) {
  const names: Record<string, string> = { "#tid": ticketId, "#u": "updatedAt" };
  const values: Record<string, unknown> = { ":u": new Date().toISOString() };
  const sets = ["#u = :u"];
  let i = 0;
  for (const [k, v] of Object.entries({
    ...metadata,
    status: "complete",
    completedAt: new Date().toISOString(),
  })) {
    if (v === undefined || v === null) continue;
    i++;
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    sets.push(`agentTasks.#tid.#f${i} = :v${i}`);
  }
  try {
    await ddb.send(new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: "attribute_exists(agentTasks.#tid)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
  } catch (err) {
    // Entry not tracked yet — drop the metadata rather than materializing a
    // partial entry the orchestrator's claim path doesn't own. Anything else
    // (throttle, auth, service error) must propagate so the delivery retries.
    if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
    console.warn(`[webhook:lambda] task metadata skipped for ${ticketId}: no tracked entry`);
  }
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
