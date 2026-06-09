/**
 * Workflow Definitions — config-driven workflow shapes.
 *
 * A "workflow definition" describes the SHAPE of a pipeline: its ordered phases,
 * which agent kicks off intake, and a few orchestration flags (does it touch a
 * git repo, create a feature branch, open a PR, and which agent phases must
 * complete for the run to be considered done).
 *
 * This mirrors the agents.json single-source-of-truth pattern. The default
 * definition (`software-delivery`) reproduces the original hardcoded 14-agent
 * pipeline exactly, so anything that omits a workflowDefId behaves as before.
 *
 * The agent ROSTER for a workflow is derived from agents.json: every agent is
 * tagged with `workflowDefId` (missing → "software-delivery"). Phase membership
 * still comes from each agent's `phase` field.
 */

import workflowsConfig from "@/config/workflows.json";

export type WorkflowPhaseType = "app" | "agent";

export interface WorkflowDefPhase {
  /** Pipeline phase id (display + ordering key), e.g. "design", "qa" */
  id: string;
  /** Display name, e.g. "QA & Ship" */
  name: string;
  /** "app" = web app step (intake), "agent" = AgentCore agent step */
  type: WorkflowPhaseType;
  /** The agents.json `phase` value mapped to this pipeline phase */
  agentPhase: string;
}

export interface WorkflowDef {
  id: string;
  name: string;
  description: string;
  /** lucide-react icon name for the selector */
  icon: string;
  /** Agent that receives the first ticket and plans the rest of the run */
  intakeAgentId: string;
  /** Whether intake should require a target git repository */
  requiresRepo: boolean;
  /** Agent phase whose entry triggers shared feature-branch creation (or null) */
  featureBranchPhase: string | null;
  /** Whether the run opens a pull request on completion */
  createsPullRequest: boolean;
  /** Agent phases that must have a "done" ticket for the run to complete */
  completionRequiresAgentPhases: string[];
  phases: WorkflowDefPhase[];
}

interface WorkflowsConfig {
  defaultWorkflowDefId: string;
  workflows: WorkflowDef[];
}

const CONFIG = workflowsConfig as WorkflowsConfig;

export const DEFAULT_WORKFLOW_DEF_ID = CONFIG.defaultWorkflowDefId;

export const WORKFLOW_DEFS: WorkflowDef[] = CONFIG.workflows;

/**
 * Resolve a workflow definition by id. Falls back to the default definition
 * when the id is missing or unknown, so legacy/unspecified runs keep working.
 */
export function getWorkflowDef(id?: string | null): WorkflowDef {
  const found = id ? WORKFLOW_DEFS.find((w) => w.id === id) : undefined;
  return found || WORKFLOW_DEFS.find((w) => w.id === DEFAULT_WORKFLOW_DEF_ID) || WORKFLOW_DEFS[0];
}

/** The agentPhase ordering for a workflow, including terminal "complete". */
export function getPhaseOrder(def: WorkflowDef): string[] {
  const order = ["intake", ...def.phases.filter((p) => p.agentPhase !== "intake").map((p) => p.agentPhase)];
  // Dedup while preserving order, then append terminal state.
  const seen = new Set<string>();
  const deduped = order.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  deduped.push("complete");
  return deduped;
}
