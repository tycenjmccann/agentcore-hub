import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time shared-secret compare for header-authenticated routes
 * (workflow/start's x-intake-internal-secret, workflow/webhook's x-webhook-secret).
 *
 * TEAM-6123 (P3): a prior version returned early when the two inputs' lengths
 * differed, before ever calling timingSafeEqual — which itself throws on unequal
 * lengths rather than returning false. That early return takes a different code
 * path (and a different amount of time) depending on whether provided.length ===
 * expected.length, which leaks the secret's length to a timing attacker. Both
 * inputs are hashed to a fixed-length (32-byte) SHA-256 digest first, so
 * timingSafeEqual always runs, on equal-length buffers, regardless of either
 * input's own length — ("","") still matches and a length mismatch still
 * returns false, just without the early exit. Node runtime only (node:crypto)
 * — not for the edge middleware.
 */
export function secretMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
