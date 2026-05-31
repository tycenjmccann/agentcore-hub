import { NextRequest, NextResponse } from "next/server";
import { getEvalConfig, updateEvalConfig } from "@/lib/eval-config";

export const dynamic = "force-dynamic";

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
    currentBufferLen: Array.isArray(existing.sessionBuffer) ? existing.sessionBuffer.length : 0,
    lastFlushedAt: existing.lastFlushedAt,
    lastUpdatedAt: updates.lastUpdatedAt,
    lastUpdatedBy: updates.lastUpdatedBy,
  });
}
