import { NextRequest } from "next/server";
import { invokeAgentRuntime, invokeHarnessAgent, getPayloadFormat, DEFAULT_REGION } from "@/lib/agentcore-sdk";

/**
 * POST /api/agentcore/invoke
 * Invokes a deployed AgentCore agent with streaming response.
 * Detects harness agents (name starts with "harness_") and routes accordingly.
 */
export async function POST(req: NextRequest) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { agentRuntimeArn, agentId, prompt, sessionId, isHarness, systemPrompt, history, payloadFormat, rawPayload } = body;

  const sid = sessionId || `sess-${crypto.randomUUID().replace(/-/g, "")}${Date.now()}`;

  try {
    let stream: ReadableStream;

    if (isHarness) {
      // Harness agents use InvokeHarness API with the full harness ARN
      if (!prompt) {
        return Response.json({ error: "prompt is required for harness agents" }, { status: 400 });
      }
      stream = await invokeHarnessAgent({
        harnessArn: agentRuntimeArn,
        prompt,
        sessionId: sid,
        systemPrompt,
        history,
        region,
      });
    } else if (agentRuntimeArn) {
      // Regular runtime agents use InvokeAgentRuntime
      const agentKey = agentId || agentRuntimeArn.split("/").pop() || "";
      const resolvedFormat = payloadFormat || getPayloadFormat(agentKey) || undefined;

      // rawPayload = exact JSON from Playground, sent directly to agent
      // prompt = text from Chat mode
      let effectivePrompt: string;
      if (rawPayload) {
        // Playground mode: send the exact payload as-is
        effectivePrompt = JSON.stringify(rawPayload);
      } else if (prompt) {
        effectivePrompt = prompt;
      } else {
        return Response.json({ error: "prompt or rawPayload required" }, { status: 400 });
      }

      stream = await invokeAgentRuntime({
        agentRuntimeArn,
        prompt: effectivePrompt,
        sessionId: sid,
        payloadFormat: resolvedFormat,
        region,
      });
    } else {
      return Response.json({ error: "agentRuntimeArn or isHarness required" }, { status: 400 });
    }

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("Invoke error:", error);
    return Response.json(
      { error: `Failed to invoke: ${error instanceof Error ? error.message : "Unknown"}` },
      { status: 500 }
    );
  }
}
