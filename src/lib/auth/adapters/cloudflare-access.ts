/**
 * Cloudflare Access identity adapter.
 *
 * Cloudflare Access sits in front of the app and injects a signed JWT on every
 * authenticated request via the `Cf-Access-Jwt-Assertion` header. We verify that
 * assertion against the team's public JWKS and read the caller's email + groups
 * from the verified claims — no login UI, no cookies, no token minting on our
 * side; Access already did all of it at the edge.
 *
 * Config (env):
 *   CF_ACCESS_TEAM_DOMAIN  e.g. https://acme.cloudflareaccess.com
 *   CF_ACCESS_AUD          the Access application's Audience (AUD) tag
 *
 * tenantId: derived from the verified email's domain by default (so everyone at
 * acme.com shares a tenant), overridable via a custom claim if the deployer maps
 * tenants explicitly. userId: the email (Access's stable subject).
 *
 * Edge-safe: only `jose`, no Node built-ins.
 */

import type { NextRequest } from "next/server";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Identity, IdentityResolver } from "../identity";

const CF_HEADER = "cf-access-jwt-assertion";

interface CfConfig {
  teamDomain: string; // https://<team>.cloudflareaccess.com
  aud: string;
}

function cfConfig(): CfConfig | null {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
  const aud = process.env.CF_ACCESS_AUD;
  if (!teamDomain || !aud) return null;
  return { teamDomain: teamDomain.replace(/\/$/, ""), aud };
}

// jose caches keys + handles rotation; keep one JWKS per team domain.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function jwks(cfg: CfConfig) {
  if (!_jwks) {
    _jwks = createRemoteJWKSet(new URL(`${cfg.teamDomain}/cdn-cgi/access/certs`));
  }
  return _jwks;
}

/**
 * Tenant for a SERVICE TOKEN (headless MCP/CI caller). Service-token JWTs carry
 * no email — only `common_name` (the token's name) and an empty/absent sub — so
 * the email-domain tenant derivation can't work. The deployer maps each token
 * name to its tenant via CF_ACCESS_SERVICE_TENANTS ("tokenName=tenantId,
 * other=acme.com"). An unmapped service token is REJECTED (fail closed): letting
 * it default would silently land a machine caller in the "default" tenant with
 * access to the pre-auth legacy rows.
 */
function serviceTenantFor(commonName: string): string | null {
  const raw = process.env.CF_ACCESS_SERVICE_TENANTS || "";
  for (const pair of raw.split(",")) {
    const [name, tenant] = pair.split("=").map((s) => s.trim());
    if (name && tenant && name === commonName) return tenant;
  }
  return null;
}

/** Map verified Access claims → hub identity. */
function identityFrom(p: JWTPayload): Identity | null {
  const email = typeof p.email === "string" ? p.email : undefined;
  const sub = typeof p.sub === "string" ? p.sub : undefined;

  // Service token (MCP / headless CLI caller): Access authenticated the request
  // with CF-Access-Client-Id/-Secret and issued an assertion carrying the token's
  // `common_name` but NO email. Identity = the token name; tenant = the explicit
  // mapping (required — see serviceTenantFor).
  const commonName = typeof p.common_name === "string" ? (p.common_name as string) : undefined;
  if (!email && commonName) {
    const tenantId = serviceTenantFor(commonName);
    if (!tenantId) return null; // unmapped machine caller → reject
    return { userId: `svc:${commonName}`, tenantId, groups: [] };
  }

  const userId = email || sub;
  if (!userId) return null;

  // A deployer that wants explicit tenant mapping can emit `custom:tenantId` from
  // an Access rule; otherwise partition by email domain (acme.com → "acme.com").
  const explicit = typeof p["custom:tenantId"] === "string" ? (p["custom:tenantId"] as string) : undefined;
  const domainTenant = email?.includes("@") ? email.split("@")[1] : undefined;
  const tenantId = explicit || domainTenant || sub || "default";

  // Access groups arrive as an array of email/identity-group strings under `groups`.
  const groups = Array.isArray(p.groups) ? p.groups.filter((g): g is string => typeof g === "string") : [];

  return { userId, tenantId, email, groups };
}

export const cloudflareAccessResolver: IdentityResolver = {
  mode: "cloudflare-access",
  async resolve(req: NextRequest): Promise<Identity | null> {
    const cfg = cfConfig();
    if (!cfg) {
      // Misconfigured: AUTH_MODE=cloudflare-access but env unset. Fail closed —
      // returning null makes middleware reject rather than silently allow.
      return null;
    }
    const token = req.headers.get(CF_HEADER);
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, jwks(cfg), {
        issuer: cfg.teamDomain,
        audience: cfg.aud,
      });
      return identityFrom(payload);
    } catch {
      return null;
    }
  },
};
