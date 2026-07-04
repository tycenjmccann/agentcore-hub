/**
 * POST /api/workflow-manager/chat
 *
 * Body: { conversationId, message, workflowId? }
 * Streams the Workflow Manager harness (agentcore_hub_workflow_manager) CHAT
 * response as SSE. Reuses the shared harness invoker (invokeHarnessAgent) so the
 * event schema matches every other streaming surface — the client parses it with
 * the shared sseData reader.
 *
 * The harness has persistent memory (actorId "workflow-manager"), so each
 * conversation is a session (sessionId = wmchat-{conversationId}); prior context
 * carries across sessions via memory — the client sends only the new message.
 */

import { NextRequest } from "next/server";
import { invokeHarnessAgent, DEFAULT_REGION } from "@/lib/agentcore-sdk";
import {
  BedrockAgentCoreControlClient,
  ListHarnessesCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HARNESS_NAME = "agentcore_hub_workflow_manager";
const ACTOR_ID = "workflow-manager";

let cachedHarnessArn: string | null = process.env.WORKFLOW_MANAGER_ARN || null;

async function resolveHarnessArn(region: string): Promise<string | null> {
  if (cachedHarnessArn) return cachedHarnessArn;
  const control = new BedrockAgentCoreControlClient({ region });
  const page = await control.send(new ListHarnessesCommand({}));
  const match = (page.harnesses || []).find((h) => h.harnessName === HARNESS_NAME);
  cachedHarnessArn = match?.arn || null;
  return cachedHarnessArn;
}

export async function POST(req: NextRequest) {
  const region = process.env.AWS_REGION || DEFAULT_REGION;
  const { conversationId, message, workflowId } = await req.json().catch(() => ({}));
  if (!conversationId || !message) {
    return Response.json(
      { error: "conversationId and message are required" },
      { status: 400 },
    );
  }

  const harnessArn = await resolveHarnessArn(region);
  if (!harnessArn) {
    return Response.json(
      { error: "Workflow Manager harness not found. Deploy it first." },
      { status: 503 },
    );
  }

  // sessionId must be >= 33 chars for AgentCore.
  const sessionId = `wmchat-${conversationId}`.padEnd(33, "0");
  const prompt = workflowId
    ? `Context: currently viewing workflow ${workflowId}\n\n${message}`
    : message;

  const stream = await invokeHarnessAgent({
    harnessArn,
    prompt,
    sessionId,
    actorId: ACTOR_ID,
    timeoutSeconds: 600,
    maxIterations: 40,
    region,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
