import { NextRequest } from "next/server";
import { DEFAULT_REGION } from "@/lib/agentcore-sdk";

// Execution role for newly created harnesses — must have Bedrock model access
const HARNESS_EXECUTION_ROLE = process.env.HARNESS_EXECUTION_ROLE_ARN || "";

/**
 * POST /api/agentcore/deploy
 * Deploys a harness config as a new agent via CreateHarness.
 * Falls back to a "config saved" response if creation fails.
 */
export async function POST(req: NextRequest) {
  const region = req.headers.get("x-aws-region") || DEFAULT_REGION;
  let config;
  try {
    config = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!config.agent_name) {
    return Response.json({ error: "agent_name is required" }, { status: 400 });
  }

  try {
    const { BedrockAgentCoreControlClient, CreateHarnessCommand } = await import(
      "@aws-sdk/client-bedrock-agentcore-control"
    );

    const client = new BedrockAgentCoreControlClient({ region });

    // Resolve execution role: from config, env var, or error
    const executionRoleArn = config.execution_role_arn || HARNESS_EXECUTION_ROLE;
    if (!executionRoleArn) {
      return Response.json({
        error: "No execution role configured. Set HARNESS_EXECUTION_ROLE_ARN in .env.local or provide execution_role_arn in the config.",
        config,
      }, { status: 400 });
    }

    // Build the CreateHarness input
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const input: any = {
      harnessName: config.agent_name,
      executionRoleArn,
      foundation: {
        modelId: config.model_id || "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
        ...(config.system_prompt ? { instruction: config.system_prompt } : {}),
      },
    };

    // Add gateway tools if specified
    if (config.gateway_id && config.tools && config.tools.length > 0) {
      input.foundation.toolUse = {
        tools: config.tools.map((tool: string) => ({
          gatewayTool: {
            gatewayArn: config.gateway_id,
            toolName: tool,
          },
        })),
      };
    }

    const command = new CreateHarnessCommand(input);
    const response = await client.send(command);

    const harness = response.harness;
    return Response.json({
      agentId: harness?.harnessId || config.agent_name,
      agentName: config.agent_name,
      status: harness?.status || "CREATING",
      arn: harness?.arn,
      message: `Agent "${config.agent_name}" created successfully.`,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    console.error("Deploy error:", errMsg);

    // If it's an IAM/permissions issue, return useful info
    if (errMsg.includes("PassRole") || errMsg.includes("AccessDenied") || errMsg.includes("not authorized")) {
      return Response.json({
        error: "IAM permissions error — need iam:PassRole on the execution role",
        details: errMsg,
        config,
      }, { status: 403 });
    }

    return Response.json(
      { error: `Deploy failed: ${errMsg}`, config },
      { status: 500 }
    );
  }
}
