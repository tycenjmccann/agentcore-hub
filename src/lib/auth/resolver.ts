/**
 * Auth resolver registry — selects the identity adapter from AUTH_MODE.
 *
 *   AUTH_MODE=none               (default) single-tenant, no gate → "default" identity
 *   AUTH_MODE=cloudflare-access  verify the Cf-Access-Jwt-Assertion header
 *
 * Add a vendor by writing an IdentityResolver in ./adapters and registering it
 * here. Nothing else in the app references a specific auth vendor.
 */

import type { IdentityResolver } from "./identity";
import { cloudflareAccessResolver } from "./adapters/cloudflare-access";

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
      return cloudflareAccessResolver;
    default:
      throw new Error(`Unknown AUTH_MODE "${mode}". Expected: none | cloudflare-access`);
  }
}
