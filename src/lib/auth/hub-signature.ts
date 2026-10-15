import { createHmac } from "node:crypto";
import { secretMatches } from "./secret-match";

/**
 * Verifies Jira's admin-webhook "secret" field signature (TEAM-6121).
 *
 * Jira Cloud's legacy admin webhooks (POST /rest/webhooks/1.0/webhook with a
 * "secret") sign the raw request body per WebSub and send it as
 * `X-Hub-Signature: <method>=<hex hmac>` — currently always `sha256`
 * (Atlassian "Secure admin webhooks":
 * https://developer.atlassian.com/cloud/jira/platform/webhooks/). Published
 * test vector: secret "It's a Secret to Everybody", body "Hello World!" →
 * sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9.
 *
 * `rawBody` must be the exact bytes Jira signed — read via req.text(), never
 * a re-serialized JSON.parse() of it. Only `sha256` is accepted; any other
 * method (or a malformed header) fails closed. The digest compare goes
 * through secretMatches (constant-time, no length leak — TEAM-6123). Node
 * runtime only (node:crypto) — not for the edge middleware.
 */
export function verifyHubSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const eq = header.indexOf("=");
  if (eq < 0) return false;
  const method = header.slice(0, eq).trim().toLowerCase();
  const hex = header.slice(eq + 1).trim().toLowerCase();
  if (method !== "sha256" || !hex) return false;

  const expectedHex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return secretMatches(`sha256=${hex}`, `sha256=${expectedHex}`);
}
