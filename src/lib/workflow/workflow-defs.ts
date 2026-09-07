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
  /**
   * When this gate is inserted into the run:
   *   "always"       → inserted on every run of this def, regardless of repo.
   *   "flagged"      → inserted only when the run explicitly requests it.
   *   "cdRegistered" → inserted only when the target repo is CD-registered, so a
   *                    ship gate is AUTO-ABSENT on a handoff run — no strip, no
   *                    phantom human expectation (D3a option B). This is the
   *                    honest declaration for any ship-phase gate.
   */
  condition: "always" | "flagged" | "cdRegistered";
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

/** Which SDLC methodology a run follows. Drives the board badge and the artifact chain. */
export type SdlcFramework = "standard" | "playbook" | "aidlc";

/**
 * A framework OVERLAY on a def (e.g. software-delivery's "playbook"): the same
 * phases and personas, but different committed artifacts and human gates. A run
 * selects it with `input.sdlcFramework`; `applyFramework` produces the
 * effective def every consumer (start route, board, orchestrator) reads.
 * Fields present in the overlay REPLACE the def's (gates are a full set, not a
 * merge) so a flavor is readable in one place.
 */
export interface FrameworkOverlay {
  /** Short label for the intake toggle, e.g. "Playbook". */
  label?: string;
  description?: string;
  featureBranchPhase?: string | null;
  artifactChain?: ArtifactChain;
  reviewGates?: ReviewGate[];
  completionRequiresAgentPhases?: string[];
}

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

/**
 * Agent phases whose review gate is a SHIP gate — a human merge/deploy approval
 * that only makes sense on a CD-registered repo. On a handoff run the ship phase
 * carries no work and is stripped, so a ship gate that ignores delivery mode
 * (condition:"always") becomes an unreachable, phantom human expectation. Keep
 * in sync with the orchestrator's ship-phase set (lambda/orchestrator passes
 * ["ship"] to stripShipPhases in cd-registry.mjs).
 */
export const SHIP_PHASES: readonly string[] = ["ship"];

/**
 * Repo-AGNOSTIC honesty lint for a def's SHAPE: a ship-phase gate must never be
 * condition:"always", because "always" ignores delivery mode and turns into a
 * phantom human expectation on any handoff run of the def. The honest choices
 * are "cdRegistered" (present only when the repo is registered) or "flagged"
 * (opt-in per run).
 *
 * Validates the def's own reviewGates AND every framework overlay's reviewGates
 * — overlays REPLACE the gate set (a framework's reviewGates fully substitute
 * the base def's), and the playbook overlay is exactly where a dishonest ship
 * gate can hide even when the base def is clean. Throws on the first offender,
 * naming the def, the framework (if any), and the gate.
 *
 * This is the load-time gate (defs-loader) — it needs no repo, so it can fail a
 * checked-in or S3-only def the moment it is loaded.
 */
export function lintWorkflowDefShape(def: WorkflowDef): void {
  const check = (gates: ReviewGate[] | undefined, where: string) => {
    for (const gate of gates || []) {
      if (SHIP_PHASES.includes(gate.afterPhase) && gate.condition === "always") {
        const label = gate.name ?? gate.afterPhase;
        throw new Error(
          `Workflow def "${def.id}"${where}: ship gate "${label}" has condition:"always"; ` +
            `ship gates must be condition:"cdRegistered" or "flagged".`
        );
      }
    }
  };
  check(def.reviewGates, "");
  for (const [name, overlay] of Object.entries(def.frameworks || {})) {
    check(overlay?.reviewGates, ` (framework "${name}")`);
  }
}

/** Soft findings from {@link validateWorkflowDef} the caller should log. */
export interface ValidateWorkflowDefResult {
  warnings: string[];
}

/**
 * Repo-AWARE validation of a resolved (framed) def against ONE run's delivery
 * mode. Called at run creation, before any epic/ticket exists, so a misconfig
 * fails as an HTTP 400 rather than a wedged run.
 *
 * THROWS (hard errors):
 *   - a ship-phase gate with condition:"always" on a repo that is NOT
 *     CD-registered — the ship phase is stripped on handoff, so the gate is
 *     unreachable (a phantom human expectation that would wedge the run).
 *   - any reviewGate.afterPhase that is not a known phase of this def
 *     (getPhaseOrder) — a gate guarding a phase that never runs.
 *
 * RETURNS warnings (does NOT throw):
 *   - completionRequiresAgentPhases lists a ship phase but no ship gate survives
 *     on a CD-registered repo — completion hinges on a phase with no human gate.
 *
 * Pure: no AWS, no clock. The caller supplies cdRegistered (computed the same
 * way the orchestrator resolves delivery mode: primary repo vs the CD registry).
 */
export function validateWorkflowDef(
  def: WorkflowDef,
  opts: { cdRegistered: boolean }
): ValidateWorkflowDefResult {
  const warnings: string[] = [];
  // A gate may guard a display-only rollup phase (software-delivery's "ship" and
  // "review" are extraAgentPhases folded onto the QA card, not standalone
  // getPhaseOrder entries), so the known-phase set is the phase ORDER plus every
  // phase's extraAgentPhases — the same universe completionRequiresAgentPhases
  // draws from.
  const order = getPhaseOrder(def);
  const known = new Set([...order, ...def.phases.flatMap((p) => p.extraAgentPhases || [])]);
  const gates = def.reviewGates || [];

  for (const gate of gates) {
    const label = gate.name ?? gate.afterPhase;
    if (!known.has(gate.afterPhase)) {
      throw new Error(
        `Workflow def "${def.id}" declares review gate "${label}" with afterPhase="${gate.afterPhase}", ` +
          `which is not a phase of this def (known phases: ${[...known].join(", ")}).`
      );
    }
    if (SHIP_PHASES.includes(gate.afterPhase) && gate.condition === "always" && !opts.cdRegistered) {
      throw new Error(
        `Workflow def "${def.id}" declares review gate "${label}" (afterPhase="ship", condition="always") ` +
          `but the target repo is not CD-registered. A ship gate on a handoff run is unreachable — ` +
          `set condition:"cdRegistered" (auto-absent on handoff) or register the repo. See docs/agents-own-cd.md.`
      );
    }
  }

  // A ship phase in the completion set with no surviving ship gate on a
  // registered repo: a warning, not a throw. "flagged" gates do not survive by
  // default, so they don't count; "always"/"cdRegistered" do.
  const requiresShip = (def.completionRequiresAgentPhases || []).some((p) => SHIP_PHASES.includes(p));
  if (requiresShip && opts.cdRegistered) {
    const surviving = gates.some((g) => SHIP_PHASES.includes(g.afterPhase) && g.condition !== "flagged");
    if (!surviving) {
      warnings.push(
        `Workflow def "${def.id}" requires a ship phase for completion but declares no ship review gate ` +
          `on a CD-registered repo — completion will not wait on any human merge approval.`
      );
    }
  }

  return { warnings };
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
  /** SDLC methodology this def implements when no overlay is selected. Absent → "standard". */
  sdlcFramework?: SdlcFramework;
  /** The committed artifact chain (set by a framework overlay, e.g. playbook). */
  artifactChain?: ArtifactChain;
  /** Selectable framework overlays keyed by SdlcFramework id (e.g. { playbook: {...} }). */
  frameworks?: Partial<Record<SdlcFramework, FrameworkOverlay>>;
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
export function getWorkflowDef(id?: string | null, framework?: string | null): WorkflowDef {
  const found = id ? WORKFLOW_DEFS.find((w) => w.id === id) : undefined;
  const def = found || WORKFLOW_DEFS.find((w) => w.id === DEFAULT_WORKFLOW_DEF_ID) || WORKFLOW_DEFS[0];
  return framework ? applyFramework(def, framework) : def;
}

/**
 * The framework a run follows: the requested overlay when the def offers it,
 * else the def's own framework, else "standard". Never throws on junk input.
 */
export function resolveFramework(def: WorkflowDef, requested?: unknown): SdlcFramework {
  if (typeof requested === "string" && requested !== "standard" && def.frameworks && requested in def.frameworks) {
    return requested as SdlcFramework;
  }
  return sdlcFrameworkForDef(def);
}

/**
 * The effective def for a framework: the def with the overlay's fields laid on
 * top and `sdlcFramework` set. Unknown / "standard" → the def unchanged (same
 * object, so identity checks and bundled-def tests keep working).
 */
export function applyFramework(def: WorkflowDef, framework?: string | null): WorkflowDef {
  const overlay = framework && framework !== "standard" ? def.frameworks?.[framework as SdlcFramework] : undefined;
  if (!overlay) return def;
  const { label: _label, description: _description, ...fields } = overlay;
  return { ...def, ...fields, sdlcFramework: framework as SdlcFramework };
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
