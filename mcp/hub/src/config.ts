/**
 * Unified configuration for the AgentCore Hub MCP server.
 *
 * One base URL serves every domain — the deployed hub app hosts both
 * /api/workflow/* and /api/cloud-code/*. HUB_URL is the canonical variable;
 * DEPLOYMENT_URL (the old workflow-mcp name) and CLOUD_CODE_URL (the old
 * port-session-mcp name) are accepted as fallbacks so existing registrations
 * keep working unchanged.
 */

const HUB_URL = (
  process.env.HUB_URL ||
  process.env.DEPLOYMENT_URL ||
  process.env.CLOUD_CODE_URL ||
  ""
).replace(/\/$/, "");

if (!HUB_URL) {
  process.stderr.write(
    "FATAL: HUB_URL environment variable is required (DEPLOYMENT_URL / CLOUD_CODE_URL also accepted).\n"
  );
  process.exit(1);
}

if (!/^https?:\/\/.+/.test(HUB_URL)) {
  process.stderr.write("FATAL: HUB_URL must be a valid HTTP(S) URL.\n");
  process.exit(1);
}

export const config = {
  hubUrl: HUB_URL,
  // Legacy bearer token (pre-Cloudflare deploys).
  authToken: process.env.AUTH_TOKEN || undefined,
} as const;
