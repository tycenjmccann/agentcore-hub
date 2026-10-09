/**
 * Same-origin guard for the registry's state-changing routes (TEAM-4997).
 *
 * `isAdmin(req)` answers "is this person allowed to edit models"; it does not
 * answer "did this person mean to". A registry write repins live harnesses and
 * can trigger a deploy-relevant model change, so a cross-site POST that rides
 * an admin's session cookie is worth one header check.
 *
 * Two independent signals, either of which is enough to refuse:
 *   • `Sec-Fetch-Site` — sent by every current browser and NOT settable by page
 *     JS. Anything other than `same-origin` / `same-site` / `none` is a
 *     cross-site request. A missing header is NOT treated as hostile: server-side
 *     callers and curl don't send it, and they are not the threat here.
 *   • `Origin` vs `Host` — a browser always sends `Origin` on a POST; if its host
 *     is not ours, the request came from somebody else's page.
 *
 * GET is never refused: it has no side effects, and the registry GET is what the
 * console renders from.
 */

import { NextResponse } from "next/server";

const ALLOWED_FETCH_SITES = new Set(["same-origin", "same-site", "none"]);

/** Returns a 403 to return immediately, or `null` when the request may proceed. */
export function assertSameOrigin(req: Request): NextResponse | null {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return null;

  const site = req.headers.get("sec-fetch-site");
  if (site && !ALLOWED_FETCH_SITES.has(site.toLowerCase())) {
    console.warn(`[models] request.cross_origin reason=sec-fetch-site value=${site}`);
    return NextResponse.json({ error: "cross_origin" }, { status: 403 });
  }

  const origin = req.headers.get("origin");
  if (origin && origin !== "null") {
    const host = req.headers.get("host") || "";
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      console.warn("[models] request.cross_origin reason=bad-origin");
      return NextResponse.json({ error: "cross_origin" }, { status: 403 });
    }
    if (!host || originHost !== host) {
      console.warn(`[models] request.cross_origin reason=origin-host origin=${originHost} host=${host}`);
      return NextResponse.json({ error: "cross_origin" }, { status: 403 });
    }
  }

  return null;
}
