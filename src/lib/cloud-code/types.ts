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
  // Files the user attached to this message (composer uploads). `path` is
  // relative to the session's artifact prefix; `url` is a transient presigned
  // GET added at read time (never persisted) so the chat renders image
  // attachments as inline thumbnails, others as a chip.
  attachments?: { path: string; name: string; contentType?: string; url?: string }[];
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
  // Optimistic-concurrency version. Incremented on every conditional write via
  // mutateSession; a write only lands if the stored rev still matches the one it
  // read, so two concurrent writers (e.g. the /message stream completing while
  // /stop persists the same interrupted turn) can't silently clobber each other.
  rev?: number;
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
  // Flexible git handoff — how the laptop shipped its code:
  //   pushed        — branch pushed to a writable origin; cloud clones + checks out
  //   bundle        — origin read-only; cloud clones the upstream and layers the
  //                   laptop's commits from a git bundle (resumeBundleKey)
  //   selfContained — no usable remote; cloud rebuilds a standalone repo from a
  //                   whole-repo `bundle --all` (resumeBundleKey)
  //   none          — nothing to ship; transcript-only resume in a bare workspace
  gitMode?: "pushed" | "bundle" | "selfContained" | "none";
  cloneUrl?: string; // explicit origin URL the cloud clones (SSH→HTTPS-normalized)
  resumeBundleKey?: string; // S3 key of the uploaded git bundle
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
