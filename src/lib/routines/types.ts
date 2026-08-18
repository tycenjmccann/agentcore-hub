/**
 * Routines — scheduled, user-defined workflows.
 *
 * A Routine binds three things together:
 *   1. a workflow definition (its SHAPE — phases + agent roster), stored in the
 *      hub's config/workflows.json + config/agents.json in S3 (so the orchestrator
 *      picks it up with no redeploy — see lambda/orchestrator/index.mjs),
 *   2. a schedule (an EventBridge Scheduler cron/rate expression), and
 *   3. an input template — the payload POSTed to /api/workflow/start on each fire.
 *
 * Routines are set up conversationally by the Routine Builder harness, which
 * writes the workflow def + any new persona blueprints and then saves the routine
 * record. The routines-runner Lambda is the scheduled trigger: it loads a routine
 * by id and POSTs its input template to the workflow API. No public endpoint —
 * EventBridge Scheduler → internal Lambda (satisfies the no-public-Lambda rule).
 */

/** Repo config carried through to /api/workflow/start (matches WorkflowInput). */
export interface RoutineRepoConfig {
  layout?: "monorepo" | "multi-repo";
  repos: Array<{ url: string; defaultBranch?: string; platform?: string }>;
}

/**
 * The payload a routine POSTs to /api/workflow/start on each fire. Mirrors
 * WorkflowInput (src/lib/workflow/types.ts) minus the id fields the API assigns.
 * `titleTemplate` may contain {date} — the runner substitutes the fire time.
 */
export interface RoutineInputTemplate {
  titleTemplate: string;
  description: string;
  workflowDefId: string;
  repoConfig?: RoutineRepoConfig;
  sources?: Array<Record<string, unknown>>;
  modelOverride?: string;
  /** Connector ids the routine's agents get at run time (routine-scoped, applied
   *  via the per-invoke payload override the runtime supports). See src/lib/connectors. */
  connectors?: string[];
}

export interface RoutineSchedule {
  /** EventBridge Scheduler expression: rate(7 days) | cron(0 9 ? * MON *). */
  expression: string;
  /** IANA timezone the cron is evaluated in (default UTC). */
  timezone?: string;
}

export interface RoutineLastRun {
  at: string;
  workflowId?: string;
  status: "started" | "failed";
  error?: string;
}

export interface Routine {
  routineId: string;
  tenantId: string;
  name: string;
  description?: string;
  /** The routine's own workflow def id (1:1). Lives in config/workflows.json (S3). */
  workflowDefId: string;
  schedule: RoutineSchedule;
  /** ARN of the EventBridge schedule created for this routine (for update/delete). */
  scheduleArn?: string;
  input: RoutineInputTemplate;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastRun?: RoutineLastRun;
  /** Optimistic-concurrency version (see mutateRoutine). */
  rev?: number;
}

/** Trimmed shape for the list view. */
export interface RoutineSummary {
  routineId: string;
  tenantId: string;
  name: string;
  description?: string;
  workflowDefId: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRun?: RoutineLastRun;
}
