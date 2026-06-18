/**
 * Cloud Code — types for the standalone resumable coding agent.
 *
 * A "session" is one conversation with a cloud-hosted coding CLI (Claude Code or
 * Codex) running on the AgentCore coding runtime. It maps 1:1 to a
 * runtimeSessionId (which selects the warm microVM + /mnt/workspace) and carries
 * the claude_session_id used to resume the CLI's own conversation.
 */

export type CloudCodeCli = "claude" | "codex";

/** Liveness of the underlying microVM, derived from last activity. */
export type SessionWarmth = "warm" | "idle" | "cold";

export interface CloudCodeTurn {
  role: "user" | "agent";
  text: string;
  at: string; // ISO timestamp
}

export interface CloudCodeSession {
  sessionId: string; // runtimeSessionId — the resume handle
  userId: string; // "default" until app-wide SSO lands
  title: string;
  cli: CloudCodeCli;
  repo?: string; // owner/name or clone URL
  claudeSessionId?: string; // CLI conversation id, for --resume
  createdAt: string;
  updatedAt: string;
  turns: CloudCodeTurn[];
}

/** Trimmed shape for the sidebar list (no full turn history). */
export interface CloudCodeSessionSummary {
  sessionId: string;
  title: string;
  cli: CloudCodeCli;
  repo?: string;
  createdAt: string;
  updatedAt: string;
  warmth: SessionWarmth;
}
