/**
 * Session-id parsing for eval results (TEAM-4688).
 *
 * The orchestrator mints one runtime session id per agent invocation
 * (lambda/orchestrator/index.mjs, invokeAgent):
 *
 *   `${ticketId ? ticketId + '_' : ''}${workflow.id}-${agentDef.agentId}-${Date.now()}`
 *
 * so a pipeline session id carries THREE facts the results store wants as
 * queryable dimensions: which run it belonged to (workflowId), which ticket
 * drove it (ticketId) and which persona ran (agentId — every pipeline persona
 * shares ONE runtime, `agentcore_hub_agent`, so the log group alone cannot tell
 * a requirements-analyst result from a code-reviewer one).
 *
 * Everything else that reaches the results log groups — the UI Invoke tab, the
 * canary (`canary-eval-<epoch>-<agentId>`), self-improvement (`si-…`), cloud
 * code (`cc-…`), the WM chat (`wmchat-…`) — has no run to attribute to and is
 * recorded against the runtime itself (persona `_runtime`, no workflowId).
 *
 * Kept in its own module so both the row mapper (results-store.mjs) and the
 * per-day bucket writer (daily.mjs) can parse ids without importing each other,
 * and so the parse is unit-testable with no AWS mocks at all.
 */

/** Persona bucket for a session that belongs to no pipeline run. */
export const RUNTIME_PERSONA = '_runtime';

/**
 * The persona suffix of a session id: `-<agentId>-<13-digit epoch ms>`.
 * Pre-dates TEAM-4688 (it drove the dependency-chain role guard) and stays the
 * single rule for "which persona ran this session".
 */
export const ROLE_RE = /-(agentcore_hub_[a-z0-9_]+)-\d{13}$/;

/**
 * Full pipeline session id.
 *
 *   [<TICKET>_]<workflowId>-<agentId>-<13-digit ms>
 *
 * - ticketId is `<PROJECT_KEY>-<n>` (default `TEAM-1234`; PROJECT_KEY is
 *   configurable, hence the generic uppercase class) and is separated from the
 *   rest by an UNDERSCORE, not a hyphen.
 * - workflowId is hub-minted `wf_<ms>_<slug>` — or `wf_bug_<TICKET>` for bug
 *   runs, which is why it may itself contain hyphens AND underscores. It is
 *   matched lazily so the `-<agentId>-<ts>` tail below wins the ambiguity.
 * - agentId is snake_case and always `agentcore_hub_*`.
 *
 * Anchored at both ends: a partial match must NOT produce a workflowId, or a
 * canary/si-/cc- session would be filed under a run that never existed.
 */
export const SESSION_RE =
  /^(?:(?<ticketId>[A-Z][A-Z0-9]*-\d+)_)?(?<workflowId>wf_[A-Za-z0-9_-]+?)-(?<agentId>agentcore_hub_[a-z0-9_]+)-(?<ts>\d{13})$/;

/**
 * Persona that produced a session, or null when the id carries no persona.
 */
export function roleFromSessionId(sid) {
  if (typeof sid !== 'string') return null;
  const match = ROLE_RE.exec(sid);
  return match ? match[1] : null;
}

/**
 * Parse a pipeline session id into its dimensions.
 *
 * Returns `{ ticketId, workflowId, agentId, startedAt }` for a pipeline id, and
 * `null` for anything else — the caller then files the row against the runtime.
 * `ticketId` is null when the run was started without a ticket prefix.
 */
export function parseSessionId(sid) {
  if (typeof sid !== 'string') return null;
  const m = SESSION_RE.exec(sid);
  if (!m) return null;
  return {
    ticketId: m.groups.ticketId ?? null,
    workflowId: m.groups.workflowId,
    agentId: m.groups.agentId,
    startedAt: Number(m.groups.ts),
  };
}

/**
 * Persona bucket for a session, relative to the runtime that hosts it.
 *
 * `_runtime` when the id names no persona OR names the hosting runtime itself
 * (`si-agentcore_hub_agent-<ms>` matches ROLE_RE with the runtime's own id — a
 * self-improvement session, not a pipeline persona, and filing it as a persona
 * would invent an `agentcore_hub_agent#agentcore_hub_agent` bucket).
 */
export function personaFor(sessionId, runtimeAgentId) {
  const role = roleFromSessionId(sessionId);
  if (!role || role === runtimeAgentId) return RUNTIME_PERSONA;
  return role;
}
