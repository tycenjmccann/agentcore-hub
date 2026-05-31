import { NextRequest, NextResponse } from "next/server";
import { listArtifacts } from "@/lib/workflow/workspace";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const workflowId = searchParams.get("workflowId");
  const agentId = searchParams.get("agentId");

  if (!workflowId) {
    return NextResponse.json({ error: "workflowId is required" }, { status: 400 });
  }

  try {
    const results = await listArtifacts({ workflowId, agentId: agentId || undefined });
    const artifacts = results
      .filter((item) => item.key && !item.key.endsWith("/"))
      .map((item) => ({
        key: item.key,
        filename: item.key.split("/").pop() || item.key,
        size: item.size,
        lastModified: item.lastModified?.toISOString() || null,
      }));
    return NextResponse.json({ artifacts });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to list artifacts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
