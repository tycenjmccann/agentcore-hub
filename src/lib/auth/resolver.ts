/**
 * Auth resolver registry — selects the identity adapter from AUTH_MODE.
 *
 *   AUTH_MODE=none               (default) single-tenant, no gate → "default" identity
 *   AUTH_MODE=cloudflare-access  verify the Cf-Access-Jwt-Assertion header
 *
 * Add a vendor by writing an IdentityResolver in ./adapters and registering it
 * here. Nothing else in the app references a specific auth vendor.
 */

import type { Identity, IdentityResolver } from "./identity";
import { cloudflareAccessResolver } from "./adapters/cloudflare-access";

/**
 * Tenants no outside identity may hold. `hub-pipeline` is the fleet's
 * CLOUD_CODE_TENANT_ID for the coding sessions the hub mints for its own runs
 * (TEAM-5599: those run as agentcore-hub-coding-pipeline-role); a human in it
 * could open those sessions' shells. Compared trimmed + case-folded.
 */
export const RESERVED_TENANTS = ["hub-pipeline"];

export function isReservedTenant(tenantId: string): boolean {
  return RESERVED_TENANTS.includes(tenantId.trim().toLowerCase());
}

/** Every adapter goes through this: a reserved tenant resolves as unauthenticated. */
function withReservedTenantsRejected(inner: IdentityResolver): IdentityResolver {
  return {
    mode: inner.mode,
    async resolve(req): Promise<Identity | null> {
      const identity = await inner.resolve(req);
      if (identity && isReservedTenant(identity.tenantId)) return null;
      return identity;
    },
  };
}

export function authMode(): string {
  return process.env.AUTH_MODE || "none";
}

/**
 * Resolver for the active AUTH_MODE, or null when AUTH_MODE=none (middleware
 * short-circuits to the default identity in that case). Throws on an unknown
 * mode so a typo fails loudly at boot rather than silently disabling auth.
 */
export function activeResolver(): IdentityResolver | null {
  const mode = authMode();
  switch (mode) {
    case "none":
      return null;
    case "cloudflare-access":
      return withReservedTenantsRejected(cloudflareAccessResolver);
    default:
      throw new Error(`Unknown AUTH_MODE "${mode}". Expected: none | cloudflare-access`);
  }
}
