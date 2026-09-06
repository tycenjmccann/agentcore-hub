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
  /**
   * Additional agents.json `phase` values that roll up into this pipeline phase
   * for DISPLAY purposes only (e.g. software-delivery's "review" agents — code
   * reviewer + CI — live on the QA card). The orchestrator's phase-advancement
   * order is derived solely from `agentPhase`, so these never affect it.
   */
  extraAgentPhases?: string[];
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
  /**
   * Max effective review rounds before onCapReached fires. Default 3, clamped to
   * {@link REVIEW_GATE_MAX_ROUNDS_CEILING} (20) — a larger value cannot be used
   * to disable the cap.
   */
  maxRounds?: number;
  /** A rework round that REGRESSES previously-passing findings counts as 2 rounds. Default true (matches ship-review.ts behavior). */
  regressionCountsDouble?: boolean;
  /** Behavior at the cap. Only "escalate" is defined: emit review.cap_reached, reassign the gate ticket to a human, stop the rework loop. Default "escalate". */
  onCapReached?: "escalate";
  /**
   * Playbook defs: a gate that guards ONE ticket inside a phase rather than the
   * whole phase (e.g. "plan" = the Plan ticket of the development phase).
   */
  scope?: "plan";
  /**
   * Verbatim instruction handed to the intake agent instead of the generated
   * "create a ticket blocked_by ALL <phase> tickets" line. Used when the gate
   * is created by the hub itself (Intent Acceptance) or guards one ticket.
   */
  instructions?: string;
}

/** One committed artifact in a playbook run's chain (see WorkflowDef.artifactChain). */
export interface ArtifactChainEntry {
  /** File name inside the chain dir, e.g. "spec.md". */
  name: string;
  /**
   * Who produces it: "intake" (the hub, from the originator's words),
   * an agent phase ("requirements", "review"), or "plan" (the Plan ticket).
   */
  owner: string;
  /** The human gate that accepts it, if any. */
  gate?: string;
}

/**
 * The committed-artifact chain of a playbook run. Every artifact is committed
 * to `dir` on the run's shared feature branch before the producing ticket may
 * close; the orchestrator verifies the file exists on the branch.
 */
export interface ArtifactChain {
  /** Directory in the target repo; "{workflowId}" is substituted. */
  dir: string;
  artifacts: ArtifactChainEntry[];
}

/** Which SDLC methodology a def implements. Drives the board badge and the artifact chain. */
export type SdlcFramework = "standard" | "playbook" | "aidlc";

/** Defaults for the convergence-cap fields of {@link ReviewGate}. */
export const REVIEW_GATE_CAP_DEFAULTS: {
  maxRounds: number;
  regressionCountsDouble: boolean;
  onCapReached: "escalate";
} = { maxRounds: 3, regressionCountsDouble: true, onCapReached: "escalate" };

/**
 * Hard ceiling on an honored `maxRounds`. Pairs with
 * {@link REVIEW_GATE_CAP_DEFAULTS}: keep both in sync with the twin constants in
 * lambda/orchestrator/review-cap.mjs.
 */
export const REVIEW_GATE_MAX_ROUNDS_CEILING = 20;

/**
 * Resolve a review gate's convergence-cap settings, applying the defaults
 * (3 / true / "escalate"). Every consumer — the orchestrator's cap enforcement,
 * the release manager's prose contract, and `effectiveRoundCount`'s `opts` —
 * MUST resolve through here so a config change lands identically everywhere.
 *
 * `maxRounds` is only honored when it is a finite number >= 1; anything else
 * (0, negative, NaN, a non-number from hand-edited JSON) falls back to the
 * default rather than producing a cap that fires immediately or never.
 *
 * An honored value is additionally CLAMPED to
 * {@link REVIEW_GATE_MAX_ROUNDS_CEILING} (20). The lower guard caught the
 * obvious ways to disable the cap but not `maxRounds: 1e9`, which is the same
 * unbounded rework loop wearing a config that reads as deliberate. Over-ceiling
 * values clamp DOWN to 20 rather than falling back to 3: "a lot of rounds" is
 * closer to 20 than to 3, so the intent survives and only the unboundedness
 * is removed.
 */
export function resolveReviewGateCap(gate: ReviewGate): {
  maxRounds: number;
  regressionCountsDouble: boolean;
  onCapReached: "escalate";
} {
  const raw = gate.maxRounds;
  const maxRounds =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 1
      ? Math.min(Math.floor(raw), REVIEW_GATE_MAX_ROUNDS_CEILING)
      : REVIEW_GATE_CAP_DEFAULTS.maxRounds;
  return {
    maxRounds,
    regressionCountsDouble:
      gate.regressionCountsDouble ?? REVIEW_GATE_CAP_DEFAULTS.regressionCountsDouble,
    onCapReached: gate.onCapReached ?? REVIEW_GATE_CAP_DEFAULTS.onCapReached,
  };
}

export interface WorkflowDef {
  id: string;
  /**
   * TEAM-3832: run-classification label this def derives — "bug" for the
   * bug-fix pipeline, "feature" otherwise (default when absent). The stored
   * workflow row's `workflowType` is DERIVED from the resolved def via
   * `workflowTypeForDef` so the label can never contradict `workflowDefId`,
   * which is the SOLE pipeline selector.
   */
  type?: "feature" | "bug";
  name: string;
  /** Short label for the workflow-list badge, e.g. "Dead-Code", "Bug-Fix", "SDLC". Falls back to `name` when absent. */
  displayName?: string;
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
  /** SDLC methodology this def implements. Absent → "standard". */
  sdlcFramework?: SdlcFramework;
  /** Playbook defs only: the committed artifact chain (intent → spec → plan → findings). */
  artifactChain?: ArtifactChain;
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
 * TEAM-3832: derive the workflow-row `workflowType` label from a resolved def.
 * `workflowDefId` is the SOLE pipeline selector; this label is display/query
 * metadata (board BugIcon badge, crash-rca workflowType=bug query) and must be
 * derived from the def — never copied from caller input — so it can never
 * contradict the pipeline actually running.
 */
export function workflowTypeForDef(def: WorkflowDef): "feature" | "bug" {
  return def.type === "bug" ? "bug" : "feature";
}


/** The SDLC framework a def runs under ("standard" when the def does not say). */
export function sdlcFrameworkForDef(def: WorkflowDef): SdlcFramework {
  return def.sdlcFramework === "playbook" || def.sdlcFramework === "aidlc" ? def.sdlcFramework : "standard";
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
