import { NextResponse } from "next/server";
import { WORKFLOW_DEFS, DEFAULT_WORKFLOW_DEF_ID } from "@/lib/workflow/workflow-defs";

/**
 * GET /api/workflow/definitions
 * Returns the available workflow definitions (shapes) for the intake selector.
 */
export async function GET() {
  return NextResponse.json({
    defaultWorkflowDefId: DEFAULT_WORKFLOW_DEF_ID,
    workflows: WORKFLOW_DEFS.map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      icon: w.icon,
      requiresRepo: w.requiresRepo,
      phases: w.phases.map((p) => ({ id: p.id, name: p.name, type: p.type })),
    })),
  });
}
