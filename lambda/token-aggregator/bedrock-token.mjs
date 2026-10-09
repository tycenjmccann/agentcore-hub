/**
 * Bedrock bearer token (TEAM-4995).
 *
 * The OpenAI-shaped endpoints — Bedrock Runtime's `/openai/v1` and Bedrock
 * Mantle's — authenticate with `Authorization: Bearer <token>`, not SigV4
 * headers. The token is a SigV4 QUERY-presigned request that the service
 * re-verifies, so no long-lived key exists anywhere; this Lambda mints one from
 * its own execution role for the duration of a probe.
 *
 * The algorithm is NOT invented here. It is a line-for-line port of the
 * official `aws-bedrock-token-generator` Python package, confirmed against the
 * copy installed in this workspace
 * (`/usr/local/lib/python3.13/site-packages/aws_bedrock_token_generator/token_generator.py`,
 * read 2026-09-24):
 *
 *     request = AWSRequest(method="POST", url="https://bedrock.amazonaws.com/",
 *                          headers={"host": "bedrock.amazonaws.com"},
 *                          params={"Action": "CallWithBearerToken"})
 *     auth = SigV4QueryAuth(credentials, "bedrock", region, expires=43200)
 *     auth.add_auth(request)
 *     token = "bedrock-api-key-" + b64(request.url.replace("https://", "") + "&Version=1")
 *
 * Two details are load-bearing and easy to get wrong:
 *   - the method is **POST**, even though the credential travels in the query
 *     string. The canonical request the service recomputes includes the method,
 *     so signing a GET produces a token that is rejected.
 *   - the service is `bedrock` and the signing region is the TARGET region (the
 *     host stays the global `bedrock.amazonaws.com`).
 *
 * Deps are the Lambda's own (`package.json`): @smithy/signature-v4 for the
 * presign, @smithy/protocol-http for the request shape, node:crypto for the
 * hash so nothing pulls in @aws-crypto.
 */

import { createHash, createHmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

export const TOKEN_PREFIX = 'bedrock-api-key-';
export const TOKEN_VERSION = '&Version=1';
export const TOKEN_DURATION_SECONDS = 43200; // 12 hours, as the reference package
const SIGNING_HOST = 'bedrock.amazonaws.com';

/** The @aws-crypto/sha256 contract (hash when constructed bare, HMAC with a
 *  secret) over node:crypto, so the signer needs no extra dependency. */
class Sha256 {
  constructor(secret) {
    this.impl = secret ? createHmac('sha256', secret) : createHash('sha256');
  }

  update(data) {
    this.impl.update(data);
  }

  async digest() {
    return new Uint8Array(this.impl.digest());
  }
}

/** RFC 3986, which is what botocore's percent_encode uses: `+`, `=` and `/` in
 *  a signature must be escaped or the presigned query does not verify. */
const enc = (s) => encodeURIComponent(String(s))
  .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Deterministic (key-sorted) query string. The transmitted order is free — the
 *  signature covers the canonical, sorted form — and sorting makes the token
 *  assertable in a test. */
export function queryString(query) {
  return Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join('&');
}

/**
 * A bearer token for `region`, valid 12 hours.
 *
 * @param {string} region target region (signing region; the host is global)
 * @param {object} [credentials] resolved credentials; defaults to the Lambda's
 *   execution role via the standard provider chain
 */
export async function mintBedrockBearerToken(region, credentials = null) {
  const creds = credentials || (await defaultProvider()());
  const signer = new SignatureV4({ service: 'bedrock', region, credentials: creds, sha256: Sha256 });
  const presigned = await signer.presign(
    new HttpRequest({
      method: 'POST',
      protocol: 'https:',
      hostname: SIGNING_HOST,
      path: '/',
      query: { Action: 'CallWithBearerToken' },
      headers: { host: SIGNING_HOST },
    }),
    { expiresIn: TOKEN_DURATION_SECONDS },
  );
  const url = `${SIGNING_HOST}${presigned.path}?${queryString(presigned.query || {})}${TOKEN_VERSION}`;
  return `${TOKEN_PREFIX}${Buffer.from(url, 'utf8').toString('base64')}`;
}

/** The token's payload, for tests and for logging a token's expiry without
 *  logging the token. */
export function decodeBearerToken(token) {
  const raw = String(token || '');
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  return Buffer.from(raw.slice(TOKEN_PREFIX.length), 'base64').toString('utf8');
}
