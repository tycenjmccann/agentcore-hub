/**
 * AgentCore Hub — request identity (pluggable, BYO-auth).
 *
 * The hub gets cloned by companies that ALREADY run their own SSO (e.g. one
 * deploy sits behind Cloudflare Access). Rather than bake in one auth vendor,
 * `middleware.ts` runs a pluggable resolver (selected by AUTH_MODE), verifies the
 * request once, and stamps the verified claims onto forwarded headers. Route
 * handlers read them back here.
 *
 * Routes NEVER trust a header they could set themselves — middleware is the only
 * writer and it strips any inbound copy before forwarding (stripIdentityHeaders),
 * so a client cannot spoof identity.
 *
 * `tenantId` is the company/isolation boundary; `userId` is the individual. When
 * AUTH_MODE=none (our own single-tenant deploy) both fall back to "default" — the
 * exact value the pre-auth code hardcoded — so existing "default"-keyed rows,
 * S3 config bundles, and sessions keep resolving with zero migration.
 */

import type { NextRequest } from "next/server";

export const USER_HEADER = "x-agentcore-user";
export const TENANT_HEADER = "x-agentcore-tenant";
export const EMAIL_HEADER = "x-agentcore-email";
export const GROUPS_HEADER = "x-agentcore-groups";

/** Single-tenant fallback used when AUTH_MODE=none. Matches all legacy rows. */
export const DEFAULT_TENANT_ID = "default";
export const DEFAULT_USER_ID = "default";

export interface Identity {
  userId: string;
  tenantId: string;
  email?: string;
  groups: string[];
}

/**
 * An auth adapter. One per SSO vendor. `resolve` verifies the request and returns
 * the caller's identity, or null if the request is unauthenticated (middleware
 * turns null into a 401/redirect). Adapters must be edge-safe (no Node built-ins)
 * so middleware can run them in the edge runtime — use `jose` for JWTs.
 */
export interface IdentityResolver {
  mode: string;
  resolve(req: NextRequest): Promise<Identity | null>;
}

/** True when the deploy intentionally runs without auth (our own / dev mode). */
export function authDisabled(): boolean {
  return (process.env.AUTH_MODE || "none") === "none";
}

/**
 * Read the verified identity middleware stamped onto the request. Throws if auth
 * is enabled but the headers are absent — that only happens if a route was
 * reached without passing middleware (a config bug); failing closed is correct
 * for a security boundary.
 */
export function getIdentity(req: NextRequest): Identity {
  const userId = req.headers.get(USER_HEADER);
  const tenantId = req.headers.get(TENANT_HEADER);

  if (userId && tenantId) {
    return {
      userId,
      tenantId,
      email: req.headers.get(EMAIL_HEADER) || undefined,
      groups: (req.headers.get(GROUPS_HEADER) || "").split(",").map((g) => g.trim()).filter(Boolean),
    };
  }

  if (authDisabled()) {
    return { userId: DEFAULT_USER_ID, tenantId: DEFAULT_TENANT_ID, groups: [] };
  }

  throw new Error(
    "Missing verified identity headers. A route was reached without auth middleware."
  );
}

/**
 * True when the caller may perform operator-level actions (creating the shared
 * GitHub App, which writes the deploy-level master credential). With AUTH_MODE=none
 * there is one operator running the whole deploy, so they ARE the admin. Under a
 * real SSO, membership in the `admin` group (stamped by the adapter) grants it.
 */
export function isAdmin(req: NextRequest): boolean {
  if (authDisabled()) return true;
  const groups = req.headers.get(GROUPS_HEADER) || "";
  return groups.split(",").map((g) => g.trim()).includes("admin");
}
