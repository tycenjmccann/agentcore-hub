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
  | "cancelled";

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
  input: WorkflowInput;
  agentTasks: Record<string, AgentTask>;  // keyed by agent ID
  messages: AgentMessage[];
  humanNotifications: HumanNotification[];
  startedAt: string;
  completedAt?: string;
  error?: string;
  /** Workflow classification — "feature" (default) or "bug" */
  workflowType?: WorkflowType;
  /** Shared feature branch — all dev agents commit to this single branch */
  featureBranch?: string;
  /** QA verification retry counter (max 3 fix cycles before human escalation) */
  qaRetryCount?: number;
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

// ─── Agent Workspace ─────────────────────────────────────────────────────────

export interface AgentWorkspace {
  s3Bucket: string;
  s3Prefix: string;              // workflow-scoped prefix
  codeInterpreterSessionId?: string;
  gitBranch?: string;
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

export interface HumanNotification {
  id: string;
  type: NotificationType;
  title: string;
  details: string;
  timestamp: string;
  acknowledged: boolean;
}

// ─── SSE Events ──────────────────────────────────────────────────────────────

export type WorkflowEvent = (
  | { type: "phase_change"; phase: WorkflowPhase }
  | { type: "agent_status"; agentId: string; status: AgentTaskStatus; ticketId?: string }
  | { type: "agent_output"; agentId: string; chunk: string }
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
