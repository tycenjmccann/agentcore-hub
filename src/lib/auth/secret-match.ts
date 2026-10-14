import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time shared-secret compare for header-authenticated routes
 * (workflow/start's x-intake-internal-secret, workflow/webhook's x-webhook-secret).
 * Equal-length buffers only: timingSafeEqual throws on unequal lengths rather than
 * returning false. Node runtime only (node:crypto) — not for the edge middleware.
 */
export function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
