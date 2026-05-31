import { NextRequest } from "next/server";
import { discoverAgents, getHarnessDetail, getRuntimeDetail, findMemoryForAgent, findLogGroupForAgent, DEFAULT_REGION } from "@/lib/agentcore-sdk";

/**
 * GET /api/agentcore/agents
 * Dynamically discovers all agents (harnesses + runtimes) in the account.
 *
 * GET /api/agentcore/agents?id=xxx
 * Returns enriched detail for a specific agent (memory, log group, model, tools).
 */
export async function GET(req: NextRequest) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  const agentId = req.nextUrl.searchParams.get("id");

  try {
    const agents = await discoverAgents(region);

    // If requesting a specific agent's detail
    if (agentId) {
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) {
        return Response.json({ error: "Agent not found" }, { status: 404 });
      }

      // Enrich with detail — harnesses and runtimes have different detail APIs
      const [logGroup, detail] = await Promise.all([
        findLogGroupForAgent(agentId, agent.name, region),
        agent.type === "harness" ? getHarnessDetail(agentId, region) : getRuntimeDetail(agentId, region),
      ]);

      // Memory ID comes from the agent config (programmatic, not name-guessing)
      // Fall back to findMemoryForAgent only if detail didn't provide one
      const memoryId = detail.memoryId || await findMemoryForAgent(agentId, region);

      // Spread detail first, then override with our resolved values
      // (detail.memoryId may be undefined even when findMemoryForAgent found one)
      return Response.json({
        ...agent,
        ...detail,
        memoryId,
        logGroup,
      });
    }

    return Response.json(agents);
  } catch (error) {
    console.error("List agents error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    // Surface useful info: credential issues, access denied, etc.
    let hint = "";
    if (message.includes("Could not load credentials") || message.includes("CredentialsProviderError")) {
      hint = "AWS credentials not found. Configure ~/.aws/credentials or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY environment variables.";
    } else if (message.includes("AccessDenied") || message.includes("not authorized")) {
      hint = "IAM permissions missing. Ensure your role/user has bedrock-agentcore:ListHarnesses and bedrock-agentcore:ListAgentRuntimes permissions.";
    } else if (message.includes("ExpiredToken") || message.includes("expired")) {
      hint = "AWS credentials have expired. Refresh your session (e.g., re-run aws sso login).";
    }
    return Response.json(
      { error: hint || message },
      { status: 500 }
    );
  }
}
