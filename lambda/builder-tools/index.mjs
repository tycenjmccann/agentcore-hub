/**
 * Builder Agent Tools Lambda — provides AgentCore management capabilities.
 * Called via MCP gateway as tools by the Builder Agent harness.
 *
 * Tools:
 *   - list_agents: List all deployed harnesses + runtimes
 *   - list_gateway_tools: List all available tools across gateways
 *   - list_memories: List all memory resources
 *   - create_harness: Deploy a new harness agent
 *   - get_agent_detail: Get detailed config for a specific agent
 */

import {
  BedrockAgentCoreControlClient,
  ListHarnessesCommand,
  ListAgentRuntimesCommand,
  ListMemoriesCommand,
  ListGatewaysCommand,
  ListGatewayTargetsCommand,
  GetHarnessCommand,
  GetAgentRuntimeCommand,
  CreateHarnessCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";

const REGION = process.env.AWS_REGION || "us-east-1";
const client = new BedrockAgentCoreControlClient({ region: REGION });

export const handler = async (event) => {
  console.log("Builder tools invoked:", JSON.stringify(event));

  // Gateway sends tool input directly — the tool name comes from the gateway routing
  // We use the _tool_name field injected by our multi-tool gateway target config
  const toolName = event._tool_name || event.tool_name || detectTool(event);

  try {
    switch (toolName) {
      case "list_agents":
        return await listAgents();
      case "list_gateway_tools":
        return await listGatewayTools();
      case "list_memories":
        return await listMemories();
      case "create_harness":
        return await createHarness(event);
      case "get_agent_detail":
        return await getAgentDetail(event);
      default:
        return textResult(`Unknown tool: "${toolName}". Available: list_agents, list_gateway_tools, list_memories, create_harness, get_agent_detail`);
    }
  } catch (err) {
    console.error("Tool execution error:", err);
    return textResult(`Error: ${err.message}`);
  }
};

/**
 * Detect which tool is being called based on event fields
 */
function detectTool(event) {
  if (event.harness_name || event.harnessName) return "create_harness";
  if (event.agent_id || event.agentId) return "get_agent_detail";
  if (event.resource === "memories") return "list_memories";
  if (event.resource === "tools" || event.resource === "gateway_tools") return "list_gateway_tools";
  return "list_agents";
}

/**
 * List all deployed harnesses and runtimes
 */
async function listAgents() {
  const [harnesses, runtimes] = await Promise.all([
    client.send(new ListHarnessesCommand({})),
    client.send(new ListAgentRuntimesCommand({})),
  ]);

  const harnessNames = new Set((harnesses.harnesses || []).map(h => h.harnessName));

  const agents = [];

  for (const h of harnesses.harnesses || []) {
    agents.push({
      type: "harness",
      id: h.harnessId,
      name: h.harnessName,
      status: h.status,
      created: h.createdAt,
    });
  }

  for (const r of runtimes.agentRuntimes || []) {
    // Skip harness-backing runtimes
    const name = r.agentRuntimeName || "";
    if (name.startsWith("harness_") && harnessNames.has(name.replace("harness_", ""))) continue;
    agents.push({
      type: "runtime",
      id: r.agentRuntimeId,
      name: r.agentRuntimeName,
      status: r.status,
      created: r.createdAt,
    });
  }

  return textResult(`## Deployed Agents (${agents.length} total)\n\n` +
    agents.map(a => `- **${a.name}** (${a.type}) — ${a.status} — ID: \`${a.id}\``).join("\n") +
    "\n\nUse get_agent_detail with an agent_id to see full configuration."
  );
}

/**
 * List all available tools across all gateways
 */
async function listGatewayTools() {
  const gateways = await client.send(new ListGatewaysCommand({}));
  const results = [];

  for (const gw of gateways.items || []) {
    const targets = await client.send(new ListGatewayTargetsCommand({
      gatewayIdentifier: gw.gatewayId,
    }));

    for (const target of targets.items || []) {
      results.push({
        gateway: gw.name,
        gatewayId: gw.gatewayId,
        tool: target.name,
        status: target.status,
        authType: gw.authorizerType,
      });
    }
  }

  return textResult(`## Available Gateway Tools (${results.length} total)\n\n` +
    `| Gateway | Tool | Status | Auth |\n|---------|------|--------|------|\n` +
    results.map(r => `| ${r.gateway} | ${r.tool} | ${r.status} | ${r.authType} |`).join("\n") +
    "\n\nThese tools can be attached to new agents via the gateway ARN."
  );
}

/**
 * List all memory resources
 */
async function listMemories() {
  const res = await client.send(new ListMemoriesCommand({}));
  const memories = res.memories || [];

  return textResult(`## Memory Resources (${memories.length} total)\n\n` +
    memories.map(m => `- **${m.id}** — ${m.status} — ARN: \`${m.arn}\``).join("\n") +
    "\n\nMemories provide persistent context across sessions. Attach to agents via the memory ARN."
  );
}

/**
 * Create a new harness agent
 */
async function createHarness(event) {
  const name = event.harness_name || event.harnessName;
  const systemPrompt = event.system_prompt || event.systemPrompt;
  const modelId = event.model_id || event.modelId || "us.anthropic.claude-sonnet-5";
  const gatewayId = event.gateway_id || event.gatewayId;
  const memoryArn = event.memory_arn || event.memoryArn;
  const roleArn = event.execution_role_arn || event.executionRoleArn || process.env.HARNESS_ROLE_ARN;

  if (!name) return textResult("Error: harness_name is required");
  if (!systemPrompt) return textResult("Error: system_prompt is required");
  if (!roleArn) return textResult("Error: execution_role_arn is required (or set HARNESS_ROLE_ARN env var)");

  // Build tools config
  const tools = [];
  if (gatewayId) {
    // Resolve gateway ARN
    const accountId = roleArn.split(":")[4];
    const gatewayArn = `arn:aws:bedrock-agentcore:${REGION}:${accountId}:gateway/${gatewayId}`;
    tools.push({
      type: "agentcore_gateway",
      name: "gateway_tools",
      config: { agentCoreGateway: { gatewayArn } },
    });
  }

  // Build memory config
  let memory;
  if (memoryArn) {
    memory = {
      agentCoreMemoryConfiguration: {
        arn: memoryArn,
        messagesCount: 20,
      },
    };
  }

  const params = {
    harnessName: name,
    executionRoleArn: roleArn,
    model: { bedrockModelConfig: { modelId } },
    systemPrompt: [{ text: systemPrompt }],
    tools: tools.length > 0 ? tools : undefined,
    memory,
    allowedTools: ["*"],
    truncation: { strategy: "sliding_window", config: { slidingWindow: { messagesCount: 150 } } },
    maxIterations: 75,
    timeoutSeconds: 3600,
  };

  const res = await client.send(new CreateHarnessCommand(params));
  const harnessId = res.harness?.harnessId;

  return textResult(
    `## Agent Created Successfully!\n\n` +
    `- **Name**: ${name}\n` +
    `- **ID**: \`${harnessId}\`\n` +
    `- **Model**: ${modelId}\n` +
    `- **Status**: CREATING (will be READY in ~30s)\n` +
    (gatewayId ? `- **Gateway**: ${gatewayId}\n` : "") +
    (memoryArn ? `- **Memory**: ${memoryArn}\n` : "") +
    `\nThe agent is being provisioned. It will appear in the Agents tab once READY.`
  );
}

/**
 * Get detailed configuration for a specific agent
 */
async function getAgentDetail(event) {
  const agentId = event.agent_id || event.agentId;
  if (!agentId) return textResult("Error: agent_id is required");

  try {
    // Try as harness first
    const h = await client.send(new GetHarnessCommand({ harnessId: agentId }));
    const harness = h.harness;
    return textResult(
      `## Harness: ${harness.harnessName}\n\n` +
      `- **ID**: \`${harness.harnessId}\`\n` +
      `- **Status**: ${harness.status}\n` +
      `- **Model**: ${JSON.stringify(harness.model)}\n` +
      `- **Tools**: ${JSON.stringify(harness.tools?.map(t => ({ type: t.type, name: t.name })))}\n` +
      `- **Memory**: ${JSON.stringify(harness.memory) || "None"}\n` +
      `- **System Prompt** (first 300 chars): ${harness.systemPrompt?.[0]?.text?.slice(0, 300)}...\n` +
      `- **Max Iterations**: ${harness.maxIterations}\n` +
      `- **Timeout**: ${harness.timeoutSeconds}s\n`
    );
  } catch {
    // Try as runtime
    try {
      const r = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: agentId }));
      const runtime = r.agentRuntime;
      return textResult(
        `## Runtime: ${runtime.agentRuntimeName}\n\n` +
        `- **ID**: \`${runtime.agentRuntimeId}\`\n` +
        `- **Status**: ${runtime.status}\n` +
        `- **ARN**: \`${runtime.agentRuntimeArn}\`\n`
      );
    } catch (e) {
      return textResult(`Error: Agent not found with ID "${agentId}". ${e.message}`);
    }
  }
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}
