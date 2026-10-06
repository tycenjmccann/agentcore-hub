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

import type { NextRequest } from "next/server";
import { DEFAULT_USER_ID, authDisabled, getIdentity } from "./identity";

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
