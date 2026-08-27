import { NextRequest, NextResponse } from "next/server";
import { getEvalConfig, updateEvalConfig, bufferRunCount } from "@/lib/eval-config";

export const dynamic = "force-dynamic";

const REGION = process.env.AWS_REGION || "us-east-1";

/**
 * The DDB `enabled` flag only gates the eval-packager Lambda (buffering +
 * PRD synthesis). The judge itself is the AgentCore online evaluation config:
 * it evaluates every sampled session with the judge model regardless of the
 * DDB flag — that's where the cost is. A toggle that doesn't flip the config's
 * executionStatus leaves the loop "off" in the UI while the judge keeps
 * running. Best-effort: agents without an online config (packager-only) just
 * skip this step.
 */
async function setOnlineEvalExecution(agentId: string, enabled: boolean): Promise<string | null> {
  const {
    BedrockAgentCoreControlClient,
    ListOnlineEvaluationConfigsCommand,
    UpdateOnlineEvaluationConfigCommand,
  } = await import("@aws-sdk/client-bedrock-agentcore-control");

  const client = new BedrockAgentCoreControlClient({ region: REGION });

  // Config ids are "eval_<agentId>-<suffix>"; match on the name prefix.
  const prefix = `eval_${agentId}-`;
  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListOnlineEvaluationConfigsCommand({ nextToken }));
    for (const cfg of page.onlineEvaluationConfigs || []) {
      if (!cfg.onlineEvaluationConfigId?.startsWith(prefix)) continue;
      await client.send(new UpdateOnlineEvaluationConfigCommand({
        onlineEvaluationConfigId: cfg.onlineEvaluationConfigId,
        executionStatus: enabled ? "ENABLED" : "DISABLED",
      }));
      return cfg.onlineEvaluationConfigId;
    }
    nextToken = page.nextToken;
  } while (nextToken);

  return null;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { agentId: string } }
) {
  const { agentId } = params;
  const body = await req.json();

  const { enabled, sampleRate, batchSize } = body;

  if (sampleRate !== undefined && (typeof sampleRate !== "number" || sampleRate < 0 || sampleRate > 100)) {
    return NextResponse.json(
      { error: "sampleRate must be a number between 0 and 100" },
      { status: 400 }
    );
  }

  if (batchSize !== undefined && (typeof batchSize !== "number" || batchSize < 1 || batchSize > 100 || !Number.isInteger(batchSize))) {
    return NextResponse.json(
      { error: "batchSize must be an integer between 1 and 100" },
      { status: 400 }
    );
  }

  const existing = await getEvalConfig(agentId);
  if (!existing) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const updates: Record<string, unknown> = {
    lastUpdatedAt: new Date().toISOString(),
    lastUpdatedBy: "console-user",
  };

  if (enabled !== undefined) updates.enabled = enabled;
  if (sampleRate !== undefined) updates.sampleRate = sampleRate;
  if (batchSize !== undefined) updates.batchSize = batchSize;

  await updateEvalConfig(agentId, updates);

  let onlineEvalConfigId: string | null = null;
  let onlineEvalError: string | null = null;
  if (enabled !== undefined) {
    try {
      onlineEvalConfigId = await setOnlineEvalExecution(agentId, enabled);
      if (onlineEvalConfigId) {
        console.log(
          `[eval-config] online eval ${onlineEvalConfigId} executionStatus → ${enabled ? "ENABLED" : "DISABLED"}`
        );
      }
    } catch (err) {
      // Surface but don't fail the toggle — the DDB flag still gates the packager.
      onlineEvalError = (err as Error).message;
      console.error(`[eval-config] failed to update online eval for ${agentId}:`, onlineEvalError);
    }
  }

  if (sampleRate !== undefined && sampleRate !== existing.sampleRate) {
    console.log(`[eval-config] sampleRate changed for ${agentId}: ${existing.sampleRate} → ${sampleRate}`);
  }

  if (enabled !== undefined && enabled !== existing.enabled) {
    console.log(`[eval-config] enabled changed for ${agentId}: ${existing.enabled} → ${enabled}`);
  }
  if (batchSize !== undefined && batchSize !== existing.batchSize) {
    console.log(`[eval-config] batchSize changed for ${agentId}: ${existing.batchSize} → ${batchSize}`);
  }

  return NextResponse.json({
    agentId,
    enabled: updates.enabled ?? existing.enabled,
    sampleRate: updates.sampleRate ?? existing.sampleRate,
    batchSize: updates.batchSize ?? existing.batchSize,
    currentBufferLen: bufferRunCount(existing),
    lastFlushedAt: existing.lastFlushedAt,
    lastUpdatedAt: updates.lastUpdatedAt,
    lastUpdatedBy: updates.lastUpdatedBy,
    onlineEvalConfigId,
    ...(onlineEvalError ? { onlineEvalWarning: `online eval config not updated: ${onlineEvalError}` } : {}),
  });
}
