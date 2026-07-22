/**
 * AgentCore Hub auth gate (BYO-auth, multi-tenant).
 *
 * Runs on every request except static assets. Selects an identity adapter from
 * AUTH_MODE, verifies the request once, and forwards the verified identity to
 * route handlers via x-agentcore-user / -tenant / -email / -groups headers. Those
 * headers are the ONLY trusted identity source downstream; we strip any
 * client-supplied copy first so they cannot be spoofed.
 *
 *   AUTH_MODE=none               → no gate; stamp the "default" identity (legacy behavior)
 *   AUTH_MODE=cloudflare-access  → verify Cf-Access-Jwt-Assertion, else reject
 *
 *   unauthenticated + /api/* → 401 JSON
 *   unauthenticated + page   → 403 (Cloudflare Access owns the login redirect at
 *                              its edge; a page 302 here would loop behind it)
 *
 * Edge-safe: adapters use `jose`, no Node built-ins.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  USER_HEADER,
  TENANT_HEADER,
  EMAIL_HEADER,
  GROUPS_HEADER,
  DEFAULT_USER_ID,
  DEFAULT_TENANT_ID,
} from "@/lib/auth/identity";
import { activeResolver } from "@/lib/auth/resolver";

// Paths reachable without a session. Health check stays open for load balancers.
const PUBLIC_PREFIXES = ["/_next/", "/favicon", "/api/health"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

function stripIdentityHeaders(req: NextRequest): Headers {
  const h = new Headers(req.headers);
  h.delete(USER_HEADER);
  h.delete(TENANT_HEADER);
  h.delete(EMAIL_HEADER);
  h.delete(GROUPS_HEADER);
  return h;
}

function unauthenticated(req: NextRequest): NextResponse {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // The SSO in front (Cloudflare Access) owns the login flow; if we got here
  // unauthenticated on a page, the edge gate is misconfigured. Fail closed.
  return new NextResponse("Forbidden", { status: 403 });
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  let resolver;
  try {
    resolver = activeResolver();
  } catch (err) {
    // Unknown AUTH_MODE → fail closed rather than run unguarded.
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  const headers = stripIdentityHeaders(req);

  // AUTH_MODE=none: single-tenant, stamp the legacy default identity and pass.
  if (!resolver) {
    headers.set(USER_HEADER, DEFAULT_USER_ID);
    headers.set(TENANT_HEADER, DEFAULT_TENANT_ID);
    return NextResponse.next({ request: { headers } });
  }

  const identity = await resolver.resolve(req);
  if (!identity) return unauthenticated(req);

  headers.set(USER_HEADER, identity.userId);
  headers.set(TENANT_HEADER, identity.tenantId);
  if (identity.email) headers.set(EMAIL_HEADER, identity.email);
  if (identity.groups.length) headers.set(GROUPS_HEADER, identity.groups.join(","));
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Match everything; isPublic() handles the allowlist. Static files skipped via
  // the negative lookahead for performance.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
