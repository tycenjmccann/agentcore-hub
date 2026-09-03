/**
 * POST /api/workflow/[id]/analyze
 *
 * Manually triggers (or re-runs) a Workflow Manager analysis for a terminal run.
 * Async-invokes the agentcore-hub-workflow-analyzer Lambda and returns 202 —
 * the harness does the work and persists the result; poll GET /analysis for it.
 */

import { NextRequest, NextResponse } from "next/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "agentcore-hub-workflows";
const ANALYZER_FUNCTION = process.env.WORKFLOW_ANALYZER_FUNCTION || "agentcore-hub-workflow-analyzer";
// TEAM-3747 D2: a run closed on a lifecycle-integrity ship outcome
// (deploy-blocked / static-ci-only) is terminal and analyzable, exactly like
// complete/error/cancelled. Additive; parity with completion.mjs SHIP_BLOCKED_OUTCOMES.
const TERMINAL_PHASES = new Set(["complete", "cancelled", "error", "deploy-blocked", "static-ci-only"]);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const workflowId = params.id;
  try {
    const wf = await ddb.send(new GetCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
      ProjectionExpression: "phase",
    }));
    if (!wf.Item) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
    if (!TERMINAL_PHASES.has(wf.Item.phase as string)) {
      return NextResponse.json(
        { error: "Workflow is still running — analyze a completed, cancelled, or errored run", phase: wf.Item.phase },
        { status: 409 }
      );
    }

    const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
    const lambda = new LambdaClient({ region: REGION });
    await lambda.send(new InvokeCommand({
      FunctionName: ANALYZER_FUNCTION,
      InvocationType: "Event", // async — do not wait for the harness
      Payload: Buffer.from(JSON.stringify({ workflowId, trigger: "manual" })),
    }));

    return NextResponse.json(
      { status: "analyzing", workflowId, message: "Analysis started — poll GET /analysis for the result." },
      { status: 202 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[analyze] ${workflowId}:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
