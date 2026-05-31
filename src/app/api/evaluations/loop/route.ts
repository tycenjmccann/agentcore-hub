/**
 * GET/POST /api/evaluations/loop — Toggle the continuous improvement loop
 *
 * Mechanism: Lambda reserved concurrency on agentcore-hub-eval-packager
 *   - concurrency = 0 → loop OFF (Lambda can't be invoked)
 *   - concurrency removed → loop ON (Lambda uses unreserved pool)
 *
 * No new tables, no new lambdas. Pure AWS API.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";
const FUNCTION_NAME = "agentcore-hub-eval-packager";

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

    return NextResponse.json({ enabled });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
