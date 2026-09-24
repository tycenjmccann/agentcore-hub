/**
 * Raw SigV4 for the two model APIs no installed SDK client covers (TEAM-4997).
 *
 * `@aws-sdk/client-bedrock` (inference-profile listing) and
 * `@aws-sdk/client-pricing` (the AWS Price List API) are BOTH absent from
 * node_modules, and this ticket adds no dependency. Both are plain JSON/REST
 * endpoints, so signing them by hand with the SigV4 primitives that are already
 * present (`@smithy/signature-v4` + `@aws-crypto/sha256-js` +
 * `@aws-sdk/credential-provider-node`) is the whole fix — same primitives the
 * repo already signs a PTY URL with (src/app/api/cloud-code/sessions/[id]/shell/route.ts:131)
 * and the eval-packager signs a runtime invoke with (lambda/eval-packager/index.mjs:2165).
 *
 * The Bedrock Mantle endpoints (`bedrock-mantle.<region>.api.aws`) do NOT accept
 * SigV4; they accept an OpenAI-style `Authorization: Bearer <key>`. AWS mints
 * that key from IAM credentials by presigning a `CallWithBearerToken` request:
 * the token IS the presigned URL, base64'd behind a fixed prefix. It is a live
 * credential for its whole lifetime, so it is held in memory only and never
 * logged, never returned in an API response, never written to the registry.
 */

import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";

/** Static credentials or a provider — a test passes the former, prod the latter. */
export type Credentials = AwsCredentialIdentity | AwsCredentialIdentityProvider;

export interface SignedFetchParams {
  service: string;
  region: string;
  method: "GET" | "POST";
  /** Absolute https URL; its query string is signed as-is. */
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Defaults to the task role via `defaultProvider()`. */
  credentials?: Credentials;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** `defaultProvider()` is memoized per process: it caches the role's creds. */
let _defaultCreds: AwsCredentialIdentityProvider | null = null;
function creds(explicit?: Credentials): Credentials {
  if (explicit) return explicit;
  if (!_defaultCreds) _defaultCreds = defaultProvider();
  return _defaultCreds;
}

function signer(service: string, region: string, explicit?: Credentials): SignatureV4 {
  return new SignatureV4({ service, region, credentials: creds(explicit), sha256: Sha256 });
}

/**
 * Sign a request with SigV4 and send it with `fetch`. Returns the raw Response —
 * callers decide what a non-2xx means (a 404 from the Price List API is "no such
 * usagetype", not an outage).
 */
export async function signedFetch(params: SignedFetchParams): Promise<Response> {
  const url = new URL(params.url);
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    query[k] = v;
  });

  const signed = await signer(params.service, params.region, params.credentials).sign({
    method: params.method,
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    query,
    headers: { host: url.host, ...(params.headers || {}) },
    ...(params.body !== undefined ? { body: params.body } : {}),
  });

  // `host` is derived by fetch from the URL; passing the signed copy through
  // would be redundant at best and rejected by some runtimes at worst.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(signed.headers || {})) {
    if (k.toLowerCase() === "host") continue;
    if (typeof v === "string") headers[k] = v;
  }

  return fetch(url.toString(), {
    method: params.method,
    headers,
    ...(params.body !== undefined ? { body: params.body } : {}),
    signal: AbortSignal.timeout(params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}

interface CachedToken {
  token: string;
  /** Epoch ms at which the presigned URL inside the token stops working. */
  expiresAtMs: number;
}

/** Per-region. In memory only — a bearer token is never persisted or logged. */
const _tokens = new Map<string, CachedToken>();

/** Re-mint this long before expiry so an in-flight request can't outlive it. */
const TOKEN_SKEW_MS = 60_000;
export const BEARER_TOKEN_PREFIX = "bedrock-api-key-";

/**
 * Mint a Bedrock bearer token for `region` from the caller's IAM credentials.
 *
 * The token is `"bedrock-api-key-" + base64(<presigned CallWithBearerToken URL
 * without its scheme> + "&Version=1")`. Cached per region until a minute before
 * it expires. Returned to the caller as a value and NEVER logged — the log line
 * records the region and expiry only.
 */
export async function mintBedrockBearerToken(
  region: string,
  opts: { expiresInSeconds?: number; credentials?: Credentials } = {}
): Promise<string> {
  const expiresIn = opts.expiresInSeconds ?? 3600;
  const cached = _tokens.get(region);
  if (cached && Date.now() < cached.expiresAtMs - TOKEN_SKEW_MS) return cached.token;

  const host = "bedrock.amazonaws.com";
  const signed = await signer("bedrock", region, opts.credentials).presign(
    {
      method: "POST",
      protocol: "https:",
      hostname: host,
      path: "/",
      query: { Action: "CallWithBearerToken" },
      headers: { host },
    },
    { expiresIn }
  );

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(signed.query || {})) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
    else if (v != null) qs.append(k, String(v));
  }
  // Scheme-less on purpose: that is the exact string AWS base64s into the key.
  const presigned = `${host}${signed.path}?${qs.toString()}&Version=1`;
  const token = BEARER_TOKEN_PREFIX + Buffer.from(presigned, "utf8").toString("base64");

  _tokens.set(region, { token, expiresAtMs: Date.now() + expiresIn * 1000 });
  console.log(`[models] bearer.minted region=${region} expiresIn=${expiresIn}`);
  return token;
}

/** Test seam: drop the per-region token cache. */
export function __resetBearerTokenCache(): void {
  _tokens.clear();
}
