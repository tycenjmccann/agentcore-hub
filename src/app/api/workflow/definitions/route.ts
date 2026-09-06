import { NextResponse } from "next/server";
import { DEFAULT_WORKFLOW_DEF_ID } from "@/lib/workflow/workflow-defs";
import { loadWorkflowDefs } from "@/lib/workflow/defs-loader";

/**
 * GET /api/workflow/definitions
 * Returns the available workflow definitions (shapes) for the intake selector and
 * the workflow board's phase rendering. Reads the LIVE S3-backed def set (same
 * source /api/workflow/start executes from) so S3-only routine defs like
 * `dead-code-sweep` render with THEIR phases instead of falling back to the
 * bundled `software-delivery` template.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const defs = await loadWorkflowDefs();
  return NextResponse.json({
    defaultWorkflowDefId: DEFAULT_WORKFLOW_DEF_ID,
    workflows: defs.map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      icon: w.icon,
      requiresRepo: w.requiresRepo,
      sdlcFramework: w.sdlcFramework || "standard",
      artifactChain: w.artifactChain,
      // Framework overlays the intake form offers as a toggle (Standard / Playbook).
      // Each carries its own gate set so the form shows the right opt-ins.
      frameworks: Object.fromEntries(
        Object.entries(w.frameworks || {}).map(([id, o]) => [
          id,
          {
            label: o?.label || id,
            description: o?.description,
            artifactChain: o?.artifactChain,
            reviewGates: (o?.reviewGates || []).map((g) => ({
              afterPhase: g.afterPhase, name: g.name, blocking: g.blocking, condition: g.condition,
            })),
          },
        ])
      ),
      phases: w.phases.map((p) => ({ id: p.id, name: p.name, type: p.type })),
      // Surface flagged review gates so the intake form can offer them as opt-ins.
      reviewGates: (w.reviewGates || []).map((g) => ({
        afterPhase: g.afterPhase,
        name: g.name,
        blocking: g.blocking,
        condition: g.condition,
      })),
    })),
  });
}
