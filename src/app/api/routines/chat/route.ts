/**
 * POST /api/routines/chat
 *
 * Body: { conversationId, message }
 * Streams the Routine Builder harness (agentcore_hub_routine_builder) response as
 * SSE. Mirrors /api/workflow-manager/chat exactly — same shared invokeHarnessAgent
 * invoker + app-wide harness event schema, so the client parses it with sseData.
 *
 * The harness has persistent memory (actorId "routine-builder"): each conversation
 * is a session (sessionId = rtchat-{conversationId}) and prior context carries
 * across sessions via memory, so the client sends only the newest message.
 */

import { NextRequest } from "next/server";
import { invokeHarnessAgent, DEFAULT_REGION } from "@/lib/agentcore-sdk";
import {
  BedrockAgentCoreControlClient,
  ListHarnessesCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HARNESS_NAME = "agentcore_hub_routine_builder";
const ACTOR_ID = "routine-builder";

let cachedHarnessArn: string | null = process.env.ROUTINE_BUILDER_ARN || null;

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
  const { conversationId, message } = await req.json().catch(() => ({}));
  if (!conversationId || !message) {
    return Response.json(
      { error: "conversationId and message are required" },
      { status: 400 },
    );
  }

  const harnessArn = await resolveHarnessArn(region);
  if (!harnessArn) {
    return Response.json(
      { error: "Routine Builder harness not found. Deploy it first (deploy/routine-builder/setup-routine-builder.mjs)." },
      { status: 503 },
    );
  }

  // sessionId must be >= 33 chars for AgentCore.
  const sessionId = `rtchat-${conversationId}`.padEnd(33, "0");

  const stream = await invokeHarnessAgent({
    harnessArn,
    prompt: message,
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
