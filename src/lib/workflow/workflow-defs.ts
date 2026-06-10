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

/**
 * A human-review gate. When the named agent phase finishes, a review ticket
 * (assignee `human:<reviewer>`) is inserted into the dependency graph and the
 * next phase waits on it (blocking) or runs alongside it (advisory).
 */
export interface ReviewGate {
  /** Agent phase this gate guards — the gate fires once this phase's work is done. */
  afterPhase: string;
  /** Display name for the review ticket, e.g. "Design Review". */
  name?: string;
  /** true → downstream phases block until approved; false → advisory, non-blocking. */
  blocking: boolean;
  /**
   * Jira project ROLE that defines this gate's reviewer pool (e.g. "Designer",
   * "QA & CI"). The orchestrator fetches assignable users in that role from Jira
   * and the intake agent picks one — fully API-driven, no names in config.
   */
  reviewerRole?: string;
  /**
   * Fallback reviewer reference when no role roster is available (DynamoDB mode
   * or empty role). "human:<who>" — <who> may be an email/accountId (Jira) or a
   * free label. Omitted → "human:reviewer" (anyone watching the board).
   */
  assignee?: string;
  /** "always" → gate always inserted; "flagged" → only when the run requests it. */
  condition: "always" | "flagged";
  /** On "Request changes": "rework" re-opens the upstream work, "hold" just pauses. */
  onReject: "rework" | "hold";
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
  /** Optional human-review gates keyed by the agent phase they guard. */
  reviewGates?: ReviewGate[];
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

/**
 * Resolve which review gates are active for a run. "always" gates always apply;
 * "flagged" gates apply only when the run requested that phase (requestedPhases,
 * from the intake form). Returns gates keyed by the phase they guard.
 */
export function resolveActiveGates(
  def: WorkflowDef,
  requestedPhases?: string[]
): ReviewGate[] {
  const requested = new Set(requestedPhases || []);
  return (def.reviewGates || []).filter(
    (g) => g.condition === "always" || requested.has(g.afterPhase)
  );
}

/** Whether a ticket assignee refers to a human reviewer rather than an agent. */
export function isHumanAssignee(assignee?: string | null): boolean {
  return !!assignee && assignee.startsWith("human:");
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
