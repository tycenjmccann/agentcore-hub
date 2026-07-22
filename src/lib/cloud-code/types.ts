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
  userId: string; // the individual (Cognito sub / SSO email); "default" in no-auth deploys
  tenantId?: string; // company/isolation boundary; "default" in no-auth deploys. The
  // security boundary is cross-tenant, not per-user — colleagues share a tenant.
  title: string;
  cli: CloudCodeCli;
  repo?: string; // owner/name or clone URL
  claudeSessionId?: string; // CLI conversation id, for --resume
  createdAt: string;
  updatedAt: string;
  turns: CloudCodeTurn[];
  // Set when a session is created by "port to cloud" (the MCP handoff): the
  // first prompt to auto-run on open. The real context comes from natively
  // resuming the ported transcript (resumeTranscriptKey + claudeSessionId), not
  // from this prompt. Cleared once it has been fired.
  pendingSeed?: string;
  branch?: string; // branch the local session pushed, for display + checkout
  // S3 key of the raw laptop transcript (.jsonl). The runtime downloads it and
  // runs `claude --resume claudeSessionId` for a lossless continuation.
  resumeTranscriptKey?: string;
  // Which surface this session opens in (sidebar tap restores it). Set at port
  // time; defaults to chat. A ported terminal session auto-runs `claude --resume`
  // in the PTY instead of firing the chat seed.
  defaultView?: "chat" | "terminal";
}

/** Trimmed shape for the sidebar list (no full turn history). */
export interface CloudCodeSessionSummary {
  sessionId: string;
  tenantId?: string;
  title: string;
  cli: CloudCodeCli;
  repo?: string;
  defaultView?: "chat" | "terminal";
  createdAt: string;
  updatedAt: string;
  warmth: SessionWarmth;
}
