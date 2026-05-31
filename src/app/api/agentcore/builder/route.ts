import { NextRequest } from "next/server";
import { invokeHarnessAgent, DEFAULT_REGION } from "@/lib/agentcore-sdk";

/**
 * POST /api/agentcore/builder
 * Agent builder chat — invokes the Builder Agent harness.
 * Requires BUILDER_AGENT_ID env var (see deploy/setup-builder-agent.mjs).
 */

const BUILDER_AGENT_ID = process.env.BUILDER_AGENT_ID;


export async function POST(req: NextRequest) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { prompt, sessionId, history } = body;

  if (!prompt) {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }

  if (!BUILDER_AGENT_ID) {
    return Response.json(
      { error: "Builder agent not configured. Set BUILDER_AGENT_ID environment variable. See deploy/setup-builder-agent.mjs for setup instructions." },
      { status: 503 }
    );
  }

  try {
    return await invokeBuilderHarness(prompt, sessionId, history, region);
  } catch (error) {
    console.error("Builder error:", error);
    return Response.json(
      { error: `Builder failed: ${error instanceof Error ? error.message : "Unknown"}` },
      { status: 500 }
    );
  }
}

/**
 * Invoke the Builder Agent harness — has access to list_agents, list_gateway_tools,
 * create_harness, list_memories, get_agent_detail tools via gateway.
 */
// Instructions prepended to the first user message to guide the builder agent
const BUILDER_INSTRUCTIONS = `IMPORTANT INSTRUCTIONS FOR AGENT CREATION:

1. Use your tools freely to discover available gateways, tools, agents, and memories.
2. When ready to create an agent, try using your create_harness tool first.
3. ALWAYS output the complete agent configuration as a JSON code block with the language tag "agent-config". This is CRITICAL — it populates the Deploy panel in the UI so the user can one-click deploy.

Example — you MUST output the config like this:
\`\`\`agent-config
{
  "agent_name": "my_agent",
  "model_id": "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "system_prompt": "You are...",
  "tools": ["tool1", "tool2"],
  "gateway_id": "gatewayId"
}
\`\`\`

This block is parsed by the UI to enable the Deploy button. Without it, the user cannot deploy.

---
User request: `;

async function invokeBuilderHarness(prompt: string, sessionId: string | undefined, history: Array<{ role: string; content: string }> | undefined, region: string) {
  const sid = sessionId || `builder-${crypto.randomUUID()}-${Date.now()}`;

  // Build history for the harness — prepend instructions to first user message
  const harnessHistory = history?.map((msg) => ({
    role: msg.role as "user" | "assistant",
    content: msg.content,
  }));

  // If this is the first message (no history), prepend builder instructions
  const effectivePrompt = (!history || history.length === 0)
    ? BUILDER_INSTRUCTIONS + prompt
    : prompt;

  // Resolve harness ARN — we need the full ARN
  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const sts = new STSClient({ region });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account;
  const harnessArn = `arn:aws:bedrock-agentcore:${region}:${accountId}:harness/${BUILDER_AGENT_ID}`;

  const stream = await invokeHarnessAgent({
    harnessArn,
    prompt: effectivePrompt,
    sessionId: sid,
    history: harnessHistory,
    region,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

