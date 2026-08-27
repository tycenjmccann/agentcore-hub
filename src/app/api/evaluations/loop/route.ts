/**
 * GET/POST /api/evaluations/loop — Toggle the continuous improvement loop
 *
 * Two independent legs must flip together:
 *   1. eval-packager Lambda reserved concurrency (buffering + PRD synthesis)
 *        - concurrency = 0 → Lambda can't be invoked
 *        - concurrency removed → Lambda uses unreserved pool
 *   2. Online evaluation configs' executionStatus (the judge model itself).
 *      This is where the cost is — with only the Lambda off, the judge keeps
 *      evaluating every sampled session and the spend continues.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const FUNCTION_NAME = "agentcore-hub-eval-packager";

async function setAllOnlineEvalConfigs(enabled: boolean): Promise<{ updated: string[]; errors: string[] }> {
  const {
    BedrockAgentCoreControlClient,
    ListOnlineEvaluationConfigsCommand,
    UpdateOnlineEvaluationConfigCommand,
  } = await import("@aws-sdk/client-bedrock-agentcore-control");

  const client = new BedrockAgentCoreControlClient({ region: REGION });
  const target = enabled ? "ENABLED" : "DISABLED";
  const updated: string[] = [];
  const errors: string[] = [];

  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListOnlineEvaluationConfigsCommand({ nextToken }));
    for (const cfg of page.onlineEvaluationConfigs || []) {
      const id = cfg.onlineEvaluationConfigId;
      if (!id) continue;
      if (cfg.executionStatus === target) continue;
      try {
        await client.send(new UpdateOnlineEvaluationConfigCommand({
          onlineEvaluationConfigId: id,
          executionStatus: target,
        }));
        updated.push(id);
      } catch (err) {
        errors.push(`${id}: ${(err as Error).message}`);
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);

  return { updated, errors };
}

export async function GET() {
  try {
    const { LambdaClient, GetFunctionConcurrencyCommand } = await import("@aws-sdk/client-lambda");
    const lambda = new LambdaClient({ region: REGION });

    const result = await lambda.send(new GetFunctionConcurrencyCommand({
      FunctionName: FUNCTION_NAME,
    }));

    // If ReservedConcurrentExecutions is 0, loop is OFF
    // If undefined (no reservation), loop is ON
    const enabled = result.ReservedConcurrentExecutions !== 0;

    return NextResponse.json({ enabled });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { enabled } = body as { enabled: boolean };

    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }

    const { LambdaClient, PutFunctionConcurrencyCommand, DeleteFunctionConcurrencyCommand } = await import("@aws-sdk/client-lambda");
    const lambda = new LambdaClient({ region: REGION });

    if (enabled) {
      // Remove concurrency limit → Lambda can be invoked normally
      await lambda.send(new DeleteFunctionConcurrencyCommand({
        FunctionName: FUNCTION_NAME,
      }));
    } else {
      // Set concurrency to 0 → Lambda cannot be invoked
      await lambda.send(new PutFunctionConcurrencyCommand({
        FunctionName: FUNCTION_NAME,
        ReservedConcurrentExecutions: 0,
      }));
    }

    const judges = await setAllOnlineEvalConfigs(enabled);
    if (judges.errors.length > 0) {
      console.error("[eval-loop] online eval config updates failed:", judges.errors.join("; "));
    }

    return NextResponse.json({
      enabled,
      onlineEvalConfigsUpdated: judges.updated,
      ...(judges.errors.length > 0 ? { onlineEvalWarnings: judges.errors } : {}),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
