import { createHmac } from "node:crypto";
import { secretMatches } from "@/lib/auth/secret-match";

/**
 * TEAM-6324: verifies the Jira Cloud webhook signature header —
 * `X-Hub-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>` (Atlassian
 * docs, "Securing admin webhooks"). The raw body (pre-JSON.parse) must be
 * hashed, since re-serializing a parsed payload can reorder keys and change
 * whitespace, breaking the signature. Only sha256 is accepted; any other
 * algorithm, a missing/malformed header, or an empty secret is rejected.
 * secretMatches is constant-time but treats ("","") as a match, so an empty
 * secret or header is rejected here before it ever reaches that compare.
 * Node runtime only (node:crypto) — not for the edge middleware.
 *
 * TEAM-6344: pass the raw bytes the caller received (Buffer/Uint8Array), not
 * a decoded string — decoding first (e.g. via req.text()) strips a leading
 * UTF-8 BOM and replaces invalid UTF-8 sequences, which no longer reproduces
 * the exact bytes Jira signed.
 */
export function verifyHubSignature(
  rawBody: string | Buffer | Uint8Array,
  header: string | null | undefined,
  secret: string
): boolean {
  if (!secret || !header) return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!match) return false;
  const hmac = createHmac("sha256", secret);
  if (typeof rawBody === "string") {
    hmac.update(rawBody, "utf8");
  } else {
    hmac.update(rawBody);
  }
  const expected = hmac.digest("hex");
  return secretMatches(match[1].toLowerCase(), expected);
}
