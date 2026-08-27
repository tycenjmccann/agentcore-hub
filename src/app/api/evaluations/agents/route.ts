import { NextResponse } from "next/server";
import { getAllEvalConfigs, bufferRunCount } from "@/lib/eval-config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const items = await getAllEvalConfigs();

    const agents = items.map((item) => ({
      agentId: item.agentId,
      enabled: item.enabled,
      sampleRate: item.sampleRate,
      batchSize: item.batchSize,
      // Runs, not deliveries — this is what the packager compares to batchSize.
      currentBufferLen: bufferRunCount(item),
      lastFlushedAt: item.lastFlushedAt,
      lastUpdatedAt: item.lastUpdatedAt,
      lastUpdatedBy: item.lastUpdatedBy,
    }));

    return NextResponse.json({ agents });
  } catch (err) {
    console.error("[eval-config] Failed to fetch agents:", (err as Error).message);
    return NextResponse.json(
      { error: `Failed to fetch eval configs: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
