/**
 * Connectors — a reusable primitive that gives fleet agents access to external
 * tools + credentials (Meta Ads, Slack, a private MCP server, a CLI that needs an
 * API key, etc.) without ever putting a secret in the roster, a routine, the
 * orchestrator, or a trace log.
 *
 * A connector is metadata + a POINTER to a secret. The bytes live only in AWS
 * Secrets Manager under `connectors/<id>`; the registry (config/connectors.json in
 * S3) holds everything BUT the secret. Agents bind connectors by id
 * (agents.json `connectors: [...]`), the orchestrator passes those ids through on
 * invoke, and the runtime resolves them itself: it reads the registry entry and
 * fetches the secret with its OWN role, then wires it in one of three ways by
 * `kind`. The LLM never sees the secret value.
 *
 * This mirrors the GitHub App pattern (src/lib/cloud-code/github-secrets.ts): the
 * master credential sits in Secrets Manager, which the artifact bucket-readable
 * runtime cannot otherwise reach, and is delivered just-in-time.
 */

/** How a connector's credential is delivered to the agent at invocation. */
export type ConnectorKind =
  /** Inject secret keys as environment variables — visible to http_request,
   *  claude_code, shell, and any tool that reads env. The simplest, most general
   *  form; use for REST APIs an agent calls directly (Meta Graph API, etc.). */
  | "env"
  /** Attach a streamable-HTTP MCP server, substituting secret values into the
   *  header template (e.g. Authorization: Bearer {TOKEN}). */
  | "mcp"
  /** Attach an AgentCore MCP gateway (SigV4-signed). No secret needed — the
   *  runtime role's IAM identity is the credential. */
  | "gateway";

export type ConnectorStatus = "active" | "needs_credentials";

export interface Connector {
  id: string;
  name: string;
  description?: string;
  kind: ConnectorKind;
  /** Secret JSON keys this connector expects (for the credential form + runtime
   *  env injection). Never holds values — only the key names. */
  secretKeys: string[];
  /** kind=mcp: URL of the MCP server. May contain {KEY} placeholders. */
  urlTemplate?: string;
  /** kind=mcp: header template; {KEY} placeholders are filled from the secret. */
  headerTemplate?: Record<string, string>;
  /** kind=gateway: the AgentCore gateway ARN/URL (SigV4). */
  gatewayUrl?: string;
  status: ConnectorStatus;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** The registry document shape in S3 (config/connectors.json). */
export interface ConnectorRegistry {
  connectors: Connector[];
}

/** List-view shape — the registry entry minus nothing sensitive (it never holds
 *  secrets), but trimmed for the UI. */
export type ConnectorSummary = Pick<
  Connector,
  "id" | "name" | "description" | "kind" | "secretKeys" | "status" | "updatedAt"
>;
