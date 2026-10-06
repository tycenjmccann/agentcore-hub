/**
 * TEAM-5338 F1 — "is this request a human?", answered once for every hub route
 * that acts on a human's behalf at a human-only gate: minting a decision token
 * (tickets/transition) and clearing a park (retry, nudge). Those are the DL-028
 * guarantees, and agents can reach the hub (the fleet has http_request and shell),
 * so anything that is not provably a person is refused:
 *   - no verified identity (getIdentity throws)        → "unauthenticated"
 *   - AUTH_MODE=none, or the single-tenant default user → "default_identity"
 *     (with auth off every caller, agents included, is "default")
 *   - a service identity (`svc:*`, e.g. a Cloudflare Access service token)
 *                                                       → "service_identity"
 * With AUTH_MODE=none the hub therefore cannot decide or un-park; the Telegram
 * bridge (which mints its own token for a listed chat) is the human channel.
 */

import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_USER_ID, authDisabled, getIdentity, isAdmin } from "./identity";

export type HumanIdentityRefusal = "unauthenticated" | "default_identity" | "service_identity";

export type HumanIdentityResult =
  | { ok: true; by: string; userId: string }
  | { ok: false; reason: HumanIdentityRefusal };

export function requireHumanIdentity(req: NextRequest): HumanIdentityResult {
  let who;
  try {
    who = getIdentity(req);
  } catch {
    return { ok: false, reason: "unauthenticated" };
  }
  if (authDisabled() || who.userId === DEFAULT_USER_ID) return { ok: false, reason: "default_identity" };
  if (who.userId.startsWith("svc:")) return { ok: false, reason: "service_identity" };
  return { ok: true, by: who.email || who.userId, userId: who.userId };
}

/**
 * Thrown by a route about to clear a park for a non-human, BEFORE any write;
 * the route's catch turns it into 403 humanIdentityRequiredBody.
 */
export class HumanIdentityRequiredError extends Error {
  readonly reason: HumanIdentityRefusal;
  readonly ticketId: string;
  constructor(reason: HumanIdentityRefusal, ticketId: string) {
    super(`Ticket ${ticketId} is parked; un-parking it needs a human identity (${reason})`);
    this.name = "HumanIdentityRequiredError";
    this.reason = reason;
    this.ticketId = ticketId;
  }
}

/** Throws HumanIdentityRequiredError when a parked ticket would be un-parked by a non-human. */
export function assertMayUnpark(parked: boolean, ticketId: string, human: HumanIdentityResult): void {
  if (parked && !human.ok) throw new HumanIdentityRequiredError(human.reason, ticketId);
}

/** The 403 body retry/nudge answer when a park clear is asked for by a non-human. */
export function humanIdentityRequiredBody(reason: HumanIdentityRefusal, ticketId?: string) {
  return {
    error: "human_identity_required",
    reason,
    ...(ticketId ? { ticketId } : {}),
    hint: "Clearing a parked ticket is a human decision: use the hub console signed in through SSO, or the Telegram gate message.",
  };
}

// ─── TEAM-5347 F9: human AND admin ────────────────────────────────────────────
//
// `isAdmin(req)` alone is true under AUTH_MODE=none, where every caller — the fleet's
// agents included — is "default". Registry writes (CD registry = deploy-trigger
// authority; models registry = which model every harness runs) and the GitHub App
// master credential are operator actions, so they need a provable human who is ALSO
// in the admin group. Under AUTH_MODE=none that means no hub route can do them; the
// CLIs (scripts/cd-registry.sh, a redeploy) are the operator's channel there.

export type HumanAdminRefusal = HumanIdentityRefusal | "not_admin";

export type HumanAdminResult =
  | { ok: true; by: string; userId: string }
  | { ok: false; reason: HumanAdminRefusal };

export function requireHumanAdmin(req: NextRequest): HumanAdminResult {
  const human = requireHumanIdentity(req);
  if (!human.ok) return human;
  if (!isAdmin(req)) return { ok: false, reason: "not_admin" };
  return human;
}

/** The 403 an admin-gated route answers. `error` stays "forbidden" for every caller that keys on it. */
export function forbidden(result: { ok: false; reason: HumanAdminRefusal }, init: ResponseInit = {}): NextResponse {
  return NextResponse.json(
    {
      error: "forbidden",
      reason: result.reason,
      hint:
        result.reason === "not_admin"
          ? "This action needs the admin group."
          : "This action needs a human operator signed in through SSO; it is not available to agents, service tokens, or with auth disabled.",
    },
    { ...init, status: 403 }
  );
}

// ─── TEAM-5358 F8: who to record as having closed or cancelled a run ─────────
//
// `x-hub-caller` is a header any caller can set, so it is never the actor. The
// actor is the verified identity: a human's email/userId, or a `svc:*` service
// identity as-is. Anything else (auth off, the default user, no identity) is
// recorded as `unauthenticated:<route>`. The header is kept beside it as
// `claimedCaller`, for audit only.

export const CLAIMED_CALLER_HEADER = "x-hub-caller";
const CLAIMED_CALLER_MAX = 100;

export function verifiedActor(req: NextRequest, route: string): string {
  const human = requireHumanIdentity(req);
  if (human.ok) return human.by;
  if (human.reason === "service_identity") return getIdentity(req).userId;
  return `unauthenticated:${route}`;
}

/** The self-declared caller (`x-hub-caller`), trimmed and clamped; undefined when absent. */
export function claimedCallerOf(req: NextRequest): string | undefined {
  const raw = (req.headers.get(CLAIMED_CALLER_HEADER) || "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  return raw ? raw.slice(0, CLAIMED_CALLER_MAX) : undefined;
}
