/**
 * Agentic Team Workflow — Core Types
 *
 * The workflow is ticket-driven: requirements agent creates tickets for
 * relevant agents only, and status transitions trigger invocations.
 */

// ─── Jira Mock System ────────────────────────────────────────────────────────

export type TicketType = "epic" | "story" | "task";

export type TicketStatus =
  | "backlog"
  | "todo"
  | "ready"       // agent should pick this up
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

export interface JiraTicket {
  id: string;                    // e.g., "TEAM-1"
  type: TicketType;
  title: string;
  description: string;
  status: TicketStatus;
  assignee?: string;             // agent ID (e.g., "agentcore_hub_ios_designer")
  parent?: string;               // parent ticket ID
  children: string[];            // child ticket IDs
  blockedBy: string[];           // tickets that must be "done" before this can start
  comments: JiraComment[];
  artifacts: Artifact[];
  createdAt: string;
  updatedAt: string;
  /**
   * TEAM-3619 D4c: the agent phase this ticket's work belongs to. Stamped on a
   * spawned fix ticket with its originating upstream phase (so a ship-review fix
   * filed against a dev still gates the SHIP phase); for ordinary agent tickets
   * the phase is derived from the assignee's roster entry instead. Optional —
   * legacy/unstamped tickets fall back to assignee-derived phase.
   */
  phase?: string;
  /**
   * TEAM-3619 D4c: marks a fix/rework ticket so completion re-verify
   * (completion.mjs condition iii) refuses to close the run while the fix is
   * open. `kind` records which pipeline spawned it; the accompanying id names
   * the originating ticket. Two producer paths write this: the orchestrator's
   * review-gate rework path (kind "review_fix", gateTicketId — see index.mjs
   * handleReviewRejection), and agent-filed fix tickets created through the
   * Tickets API create_ticket pass-through (kind "qa_fix"/qaTicketId from the QA
   * verifier, "codex_fix"/codexTicketId from the code reviewer — validated
   * lambda-side, see agentcore-hub-tickets sanitizeSpawnedBy).
   */
  spawnedBy?: {
    kind: "review_fix" | "qa_fix" | "codex_fix";
    gateTicketId?: string;
    qaTicketId?: string;
    codexTicketId?: string;
  };
}

export interface JiraComment {
  id: string;
  author: string;                // agent ID or "human"
  content: string;
  timestamp: string;
}

export interface Artifact {
  id: string;
  type: "requirements" | "design" | "code" | "review" | "pr" | "other";
  title: string;
  content: string;               // inline content or S3 URI
  producedBy: string;            // agent ID
  timestamp: string;
}

// ─── Agent Definitions ───────────────────────────────────────────────────────

export type AgentPhase = "requirements" | "design" | "development" | "verification" | "review" | "ship";

// ─── Workflow State ──────────────────────────────────────────────────────────

// TEAM-3747 D2 — lifecycle-integrity terminal outcomes ("no green close over
// unshipped work"). A run whose ship/CD work did not actually ship closes on one
// of these HONEST terminal verdicts instead of a green "complete":
//   - "deploy-blocked"  : a deploy/preflight was attempted and blocked.
//   - "static-ci-only"  : CI was green but nothing was merged/deployed.
// These are ADDITIVE members of WorkflowPhase; legacy records (which never carry
// them, and older runs with no such phase) deserialize/render exactly as before.
//
// PARITY — this list is the single source of truth. Mirror ANY change in:
//   - lambda/orchestrator/completion.mjs           (SHIP_BLOCKED_OUTCOMES)
//   - deploy/workflow-manager/toolkit/save_analysis.py (RUN_OUTCOMES)
// (.mjs cannot import this TS module, and the toolkit is Python — hence mirrors.)
export const SHIP_BLOCKED_OUTCOMES = ["deploy-blocked", "static-ci-only"] as const;
export type ShipBlockedOutcome = (typeof SHIP_BLOCKED_OUTCOMES)[number];

export type WorkflowPhase =
  | "intake"
  | "requirements"
  | "design"
  | "development"
  | "verification"
  | "review"
  | "ship"
  | "complete"
  | "error"
  | "cancelled"
  | ShipBlockedOutcome;

// Every phase in which a run is FINISHED — the shared definition of "not open".
// TEAM-3747 D2 folds the ship-blocked outcomes in additively, so a deploy-blocked
// / static-ci-only run reads as terminal everywhere isTerminalPhase is used
// (workflow list running/past split, etc.). The .mjs fleet (anomaly-watcher,
// workflow-analyzer) and the /complete route keep their own literal mirrors of
// this set — see the PARITY note above.
export const TERMINAL_PHASES = ["complete", "error", "cancelled", ...SHIP_BLOCKED_OUTCOMES] as const;

/** Whether a workflow phase is terminal (the run is finished). Unknown/legacy
 *  values are treated as non-terminal, exactly as before this helper existed. */
export function isTerminalPhase(phase: string | null | undefined): boolean {
  return !!phase && (TERMINAL_PHASES as readonly string[]).includes(phase);
}

export type AgentTaskStatus =
  | "pending"
  | "running"
  | "waiting_response"
  | "complete"
  | "error";

export interface AgentTask {
  id: string;
  agentId: string;
  ticketId: string;
  status: AgentTaskStatus;
  input: string;                 // prompt/context sent to agent
  output?: string;               // agent response
  branch?: string;               // git branch created (dev agents)
  commitSha?: string;            // final commit SHA (dev agents)
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface StoredEvent {
  timestamp: string;
  event: WorkflowEvent;
}

export type WorkflowType = "feature" | "bug";

export interface WorkflowState {
  id: string;                    // workflow run ID
  phase: WorkflowPhase;
  epicId: string;                // root Jira epic ticket ID
  repoConfig: RepoConfig;
  /** Submit-time repo URL pre-flight. Present only when a URL did NOT verify
   *  (see src/lib/workflow/repo-check.ts); the orchestrator re-checks and
   *  warns every persona until it resolves. */
  repoCheck?: import("./repo-check").RepoCheck;
  input: WorkflowInput;
  agentTasks: Record<string, AgentTask>;  // keyed by agent ID
  messages: AgentMessage[];
  humanNotifications: HumanNotification[];
  startedAt: string;
  completedAt?: string;
  error?: string;
  /** Workflow classification — "feature" (default) or "bug" */
  workflowType?: WorkflowType;
  /** SDLC framework the run follows — "playbook" (default) or "aidlc" */
  sdlcFramework?: "playbook" | "aidlc";
  /** Shared feature branch — all dev agents commit to this single branch */
  featureBranch?: string;
  /** QA verification retry counter (max 3 fix cycles before human escalation) */
  qaRetryCount?: number;
  /**
   * Per-ticket dead-session auto-retry counter (TEAM-3618 D1.2). The
   * orchestrator's dead-session detector re-dispatches a crashed session ONCE;
   * a second detected death for the same ticket escalates instead of looping.
   * Keyed by ticketId, incremented independently of qaRetryCount.
   */
  deadSessionRetries?: Record<string, number>;
  /** Routine-scoped connector ids forwarded to agent invocations for this run. */
  connectors?: string[];
  /** Persisted event log for replay (populated during live runs) */
  eventLog?: StoredEvent[];
  /** Timestamp when workflow was cancelled */
  cancelledAt?: string;
  /** Phase the workflow was in before cancellation (for audit) */
  previousPhase?: WorkflowPhase;
}

// ─── Repo Configuration ──────────────────────────────────────────────────────

export type RepoLayout = "monorepo" | "multi-repo";

export interface RepoConfig {
  layout: RepoLayout;
  repos: RepoTarget[];
}

export interface RepoTarget {
  url: string;                   // git remote URL
  defaultBranch: string;         // "main"
  pathPrefix?: string;           // for monorepo: "ios/", "backend/", etc.
  platform: "ios" | "backend" | "android" | "shared";
}

// ─── Agent-to-Agent Messages ─────────────────────────────────────────────────

export type MessageType = "question" | "answer" | "notification";

export interface AgentMessage {
  id: string;
  from: string;                  // agent ID
  to: string;                    // agent ID
  type: MessageType;
  content: string;
  timestamp: string;
  resolved: boolean;
}

// ─── Intake ──────────────────────────────────────────────────────────────────

export type IntakeSourceType = "url" | "upload" | "s3";

export interface IntakeSource {
  type: IntakeSourceType;
  value: string;                 // URL, file path, or s3://bucket/key
  contentType?: string;          // MIME type hint
  label?: string;                // user-provided label
}

export interface ModelOverride {
  bedrockModelConfig?: { modelId: string };
  openAiModelConfig?: { modelId: string; apiKeyArn: string };
}

export interface WorkflowInput {
  title: string;
  description: string;
  repoConfig: RepoConfig;
  sources: IntakeSource[];
  /** Per-invocation model override for dev agents (e.g., Opus for complex tasks) */
  modelOverride?: ModelOverride;
  /** Connector ids (routine-scoped) forwarded to each agent invoke so the runtime
   *  loads their creds/tools for this run only. See src/lib/connectors. */
  connectors?: string[];
  /** Workflow classification — "feature" (default) or "bug" */
  workflowType?: WorkflowType;
  /** SDLC framework the run follows — "playbook" (default) or "aidlc" */
  sdlcFramework?: "playbook" | "aidlc";
  /**
   * Which workflow definition (shape) to run. Resolved against workflows.json.
   * Absent → default ("software-delivery"), preserving legacy behavior.
   */
  workflowDefId?: string;
  /**
   * Agent phases the requester wants a human-review gate after. Activates any
   * def reviewGates whose condition is "flagged". "always" gates apply regardless.
   */
  reviewGates?: string[];
  /**
   * A laptop coding session shipped to this workflow (ship_session_to_workflow).
   * The session's branch becomes the run's shared integration branch, and
   * pipeline personas resume the session (claude_code resume_session) instead
   * of starting cold — the requester's research/plan travels in the transcript.
   */
  portedSession?: PortedSession;
  /**
   * Who opened this run, for fleet accounting — e.g. "anomaly-detector" for
   * anomaly-watcher filings. Persisted on the workflow row and indexed
   * (intakeChannel-index) so an automated filer can cap its own open runs.
   * Absent → attribute omitted entirely; human/API callers are unaffected.
   */
  intakeChannel?: string;
  /**
   * Submit even though a repoConfig URL definitively failed the GitHub
   * pre-flight (authenticated 404). The intake agent is told the URL did not
   * resolve and must find the right repo or escalate. Default false → 422.
   */
  allowUnresolvedRepo?: boolean;
  /**
   * The upstream ticket that triggered this run (e.g. a Bug being auto-filed, or
   * an anomaly ticket). When present, POST /api/workflow/start is idempotent on
   * (sourceTicket, workflowDefId): a redelivery for the same pair coalesces onto
   * the still-running canonical workflow instead of forking a duplicate run.
   * Absent → no dedup (human/API callers keep the mint-a-new-run behavior).
   */
  sourceTicket?: string;
}

export interface PortedSession {
  /** Cloud Code session id (cc-…) the personas resume via resume_session. */
  sessionId: string;
  /** The CLI conversation id inside the transcript (claude --resume <id>). */
  claudeSessionId: string;
  /** Which CLI recorded the transcript. */
  cli: "claude" | "codex";
  /** owner/name of the repo the session worked in. */
  repo?: string;
  /** Branch the in-flight work was pushed to — the run builds on it. */
  branch: string;
}

// ─── Human Notifications ─────────────────────────────────────────────────────

export type NotificationType =
  | "phase_complete"
  | "blocker"
  | "review_needed"
  | "pr_ready"
  | "error";

/** Curated link in a review package — artifactKey opens the hub's artifact
 *  viewer (/workflow?id=X&artifact=<key>), url is external (PR, preview). */
export interface ReviewPackageLink {
  label: string;
  url?: string;
  artifactKey?: string;
}

export interface HumanNotification {
  id: string;
  type: NotificationType;
  title: string;
  details: string;
  timestamp: string;
  acknowledged: boolean;
  /** review_needed only — set when the pre-gate agent wrote a review package
   *  (blueprints/review-package.md); consumers fall back to `details`. */
  ticketId?: string;
  reviewer?: string;
  gate?: string;
  summary?: string;
  bullets?: string[];
  links?: ReviewPackageLink[];
}

// One dispatch of an agent within a workflow — its own ticket, streamed text,
// and completion summary. Returned by GET /api/workflow/[id]/agent-output.
export interface AgentRun {
  ticketId: string;
  stream: string;
  summary: string;
  startedAt: string;
  endedAt: string;
  chunks: number;
}

// ─── SSE Events ──────────────────────────────────────────────────────────────

export type WorkflowEvent = (
  | { type: "phase_change"; phase: WorkflowPhase }
  | { type: "agent_status"; agentId: string; status: AgentTaskStatus; ticketId?: string }
  | { type: "agent_output"; agentId: string; chunk: string; ticketId?: string }
  | { type: "tool_use"; agentId: string; toolName: string }
  | { type: "tool_end"; agentId: string; toolName: string; durationMs?: number }
  | { type: "token_usage"; agentId: string; inputTokens: number; outputTokens: number }
  | { type: "agent_complete"; agentId: string; output: string; branch?: string; commitSha?: string }
  | { type: "message"; message: AgentMessage }
  | { type: "ticket_created"; ticket: JiraTicket }
  | { type: "ticket_update"; ticketId: string; status: TicketStatus }
  | { type: "notification"; notification: HumanNotification }
  | { type: "workflow_complete"; summary: string }
  | { type: "error"; agentId?: string; error: string }
  | { type: "nudge"; nudged: string[]; ticketsScanned?: number }
  | { type: "manager_intervention"; action?: string; ticketId?: string; note?: string }
  | { type: "manager_escalation"; message?: string }
) & { timestamp?: string; eventId?: string };
