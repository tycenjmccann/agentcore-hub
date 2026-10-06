/**
 * TEAM-5347 F9 — test fixture: the
 * identity headers middleware stamps for a signed-in SSO admin, and for a signed-in
 * human who is NOT in the admin group. Routes gated by requireHumanAdmin refuse
 * AUTH_MODE=none outright (every caller is "default" there), so a test exercising an
 * admin write sets AUTH_MODE=SSO_AUTH_MODE and sends ADMIN_HEADERS.
 */
export const SSO_AUTH_MODE = "cloudflare-access";

export const ADMIN_HEADERS: Record<string, string> = {
  "x-agentcore-user": "u-admin",
  "x-agentcore-tenant": "default",
  "x-agentcore-email": "admin@example.com",
  "x-agentcore-groups": "admin",
};

/** A real human, signed in, without the admin group. */
export const NON_ADMIN_HEADERS: Record<string, string> = {
  "x-agentcore-user": "u-alice",
  "x-agentcore-tenant": "default",
  "x-agentcore-email": "alice@example.com",
  "x-agentcore-groups": "",
};

/** A service identity (a Cloudflare Access service token, an agent's token). */
export const SVC_HEADERS: Record<string, string> = {
  "x-agentcore-user": "svc:workflow-manager",
  "x-agentcore-tenant": "default",
};
