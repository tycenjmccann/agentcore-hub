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

/** Map verified Access claims → hub identity. */
function identityFrom(p: JWTPayload): Identity | null {
  const email = typeof p.email === "string" ? p.email : undefined;
  // Access always sets `sub`; prefer email as the human-facing userId, fall back
  // to sub when a service token (no email) hits the app.
  const sub = typeof p.sub === "string" ? p.sub : undefined;
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
