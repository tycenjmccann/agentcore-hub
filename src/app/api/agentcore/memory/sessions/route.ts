import { NextRequest, NextResponse } from "next/server";
import {
  BedrockAgentCoreClient,
  ListSessionsCommand,
  ListActorsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { findMemoryForAgent, DEFAULT_REGION } from "@/lib/agentcore-sdk";

// Per-region client cache
const clients = new Map<string, BedrockAgentCoreClient>();
function getClient(region: string) {
  let client = clients.get(region);
  if (!client) {
    client = new BedrockAgentCoreClient({ region });
    clients.set(region, client);
  }
  return client;
}

/**
 * GET /api/agentcore/memory/sessions?agent_id=xxx
 * Lists sessions for a given agent from AgentCore Memory
 */
export async function GET(req: NextRequest) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  const agentId = req.nextUrl.searchParams.get("agent_id");
  if (!agentId) {
    return NextResponse.json({ error: "agent_id required" }, { status: 400 });
  }

  const memoryId = await findMemoryForAgent(agentId, region);
  if (!memoryId) {
    return NextResponse.json({ sessions: [] });
  }

  try {
    const c = getClient(region);

    // Get actors
    const actorsRes = await c.send(new ListActorsCommand({ memoryId }));
    const actors = actorsRes.actorSummaries || [];

    // Collect sessions from all actors
    const allSessions: Array<{
      sessionId: string;
      actorId: string;
      createdAt: string;
    }> = [];

    const sessionResults = await Promise.all(
      actors
        .filter((actor) => actor.actorId)
        .map((actor) =>
          c.send(new ListSessionsCommand({ memoryId, actorId: actor.actorId!, maxResults: 20 }))
        )
    );
    for (const sessionsRes of sessionResults) {
      for (const s of sessionsRes.sessionSummaries || []) {
        allSessions.push({
          sessionId: s.sessionId || "",
          actorId: s.actorId || "",
          createdAt: s.createdAt?.toISOString() || "",
        });
      }
    }

    // Deduplicate by sessionId (same session can appear under multiple actors)
    // Keep the most recent entry for each session ID
    const deduped = new Map<string, typeof allSessions[0]>();
    for (const s of allSessions) {
      const existing = deduped.get(s.sessionId);
      if (!existing || new Date(s.createdAt) > new Date(existing.createdAt)) {
        deduped.set(s.sessionId, s);
      }
    }

    // Sort by createdAt descending
    const sorted = Array.from(deduped.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return NextResponse.json({ sessions: sorted });
  } catch (error) {
    console.error("Memory sessions error:", error);
    return NextResponse.json({ sessions: [] });
  }
}
