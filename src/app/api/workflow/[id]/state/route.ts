import { NextRequest, NextResponse } from "next/server";
import { getWorkflowFromDynamo } from "@/lib/workflow/dynamo-read";

export const dynamic = "force-dynamic";

/**
 * Re-key agentTasks from ticketId-keyed (DDB storage) to agentId-keyed (UI expected).
 * The orchestrator stores tasks keyed by ticketId (e.g. "TEAM-462") but the UI
 * pipeline visualization expects them keyed by agentId (e.g. "agentcore_hub_requirements_analyst").
 */
function normalizeAgentTasks(
  agentTasks: Record<string, Record<string, unknown>> | undefined
): Record<string, Record<string, unknown>> {
  if (!agentTasks) return {};
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [key, task] of Object.entries(agentTasks)) {
    const agentId = (task.agentId as string) || key;
    const existing = normalized[agentId];
    if (existing) {
      // Same agent has multiple tickets — prefer the active/running one
      const existingStatus = existing.status as string;
      const newStatus = task.status as string;
      const activeStatuses = ["running", "pending", "waiting_response"];
      if (activeStatuses.includes(newStatus) && !activeStatuses.includes(existingStatus)) {
        normalized[agentId] = { ...task, agentId };
      }
      // Otherwise keep the existing (first active wins, or first complete)
    } else {
      normalized[agentId] = { ...task, agentId };
    }
  }
  return normalized;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const state = await getWorkflowFromDynamo(params.id);
    if (!state) {
      return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
    }
    // Normalize agentTasks keys from ticketId → agentId for UI consumption
    if (state.agentTasks) {
      state.agentTasks = normalizeAgentTasks(
        state.agentTasks as Record<string, Record<string, unknown>>
      );
    }
    return NextResponse.json(state, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error(`[state] Error fetching workflow ${params.id}:`, err);
    return NextResponse.json(
      { error: `Failed to fetch workflow state: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}
