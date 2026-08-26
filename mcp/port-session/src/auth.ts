/**
 * port-session-mcp — Cloud Code API authentication.
 *
 * Once a deploy flips AUTH_MODE=cloudflare-access, every /api/cloud-code/* call
 * must carry a verified identity or middleware 401s it. Browsers get that from
 * the Access login at the edge; this headless MCP authenticates with a
 * Cloudflare Access SERVICE TOKEN instead: Access validates the
 * CF-Access-Client-Id/-Secret pair at the edge and forwards a signed assertion
 * whose `common_name` the hub maps to a tenant (CF_ACCESS_SERVICE_TENANTS).
 *
 * Credential sources, in order:
 *   1. env CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (set in the MCP server
 *      registration — the normal path)
 *   2. ~/.cloud-code/service-token.json  { "clientId": "...", "clientSecret": "..." }
 *
 * Under AUTH_MODE=none neither is set and ccFetch sends plain requests — exactly
 * the pre-auth behavior. The credentials are sent ONLY to CLOUD_CODE_URL — never
 * to presigned S3 URLs (their SigV4 query auth is self-contained, and leaking a
 * long-lived service secret to another host would be a credential exposure).
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_FILE =
  process.env.CLOUD_CODE_SERVICE_TOKEN_FILE || join(homedir(), ".cloud-code", "service-token.json");

interface ServiceToken {
  clientId: string;
  clientSecret: string;
}

let _cached: ServiceToken | null | undefined; // undefined = not looked up yet

async function serviceToken(): Promise<ServiceToken | null> {
  if (_cached !== undefined) return _cached;
  const envId = process.env.CF_ACCESS_CLIENT_ID;
  const envSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (envId && envSecret) {
    _cached = { clientId: envId, clientSecret: envSecret };
    return _cached;
  }
  try {
    const raw = JSON.parse(await readFile(TOKEN_FILE, "utf8")) as Partial<ServiceToken>;
    _cached = raw.clientId && raw.clientSecret
      ? { clientId: raw.clientId, clientSecret: raw.clientSecret }
      : null;
  } catch {
    _cached = null;
  }
  return _cached;
}

/**
 * fetch against the Cloud Code API, attaching the Access service-token headers
 * when configured. A 401 WITHOUT credentials gets a setup hint (the deploy has
 * auth on but this MCP has no token); a 401 WITH credentials means the token is
 * wrong/revoked or unmapped — surface that distinctly.
 */
export async function ccFetch(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = 60_000
): Promise<Response> {
  const headers = new Headers(init.headers);
  const tok = await serviceToken();
  if (tok) {
    headers.set("CF-Access-Client-Id", tok.clientId);
    headers.set("CF-Access-Client-Secret", tok.clientSecret);
  }
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) {
    throw new Error(
      tok
        ? "Cloud Code rejected the service token (401). Check the token is valid in " +
          "Cloudflare Access and that its name is mapped in CF_ACCESS_SERVICE_TENANTS."
        : "Cloud Code requires authentication (401) and no service token is configured. " +
          "Set CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET in this MCP server's env " +
          `(or write ${TOKEN_FILE}).`
    );
  }
  return res;
}
