/**
 * Hub API authentication + fetch helpers.
 *
 * Once a deploy flips AUTH_MODE=cloudflare-access, every /api/* call must carry
 * a verified identity or middleware 401s it. Browsers get that from the Access
 * login at the edge; this headless MCP authenticates with a Cloudflare Access
 * SERVICE TOKEN instead: Access validates the CF-Access-Client-Id/-Secret pair
 * at the edge and forwards a signed assertion whose `common_name` the hub maps
 * to a tenant (CF_ACCESS_SERVICE_TENANTS).
 *
 * Credential sources, in order:
 *   1. env CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (set in the MCP server
 *      registration — the normal path)
 *   2. ~/.cloud-code/service-token.json  { "clientId": "...", "clientSecret": "..." }
 *
 * Under AUTH_MODE=none neither is set and hubFetch sends plain requests —
 * exactly the pre-auth behavior. The credentials are sent ONLY to the hub
 * origin — never to presigned S3 URLs (their SigV4 query auth is
 * self-contained, and leaking a long-lived service secret to another host
 * would be a credential exposure).
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config.js";

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
 * fetch against the hub API, attaching the Access service-token headers when
 * configured (plus the legacy AUTH_TOKEN bearer, if set). A 401 WITHOUT
 * credentials gets a setup hint (the deploy has auth on but this MCP has no
 * token); a 401 WITH credentials means the token is wrong/revoked or unmapped —
 * surfaced distinctly.
 */
export async function hubFetch(
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
  if (config.authToken) {
    headers.set("Authorization", `Bearer ${config.authToken}`);
  }
  const res = await fetch(`${config.hubUrl}${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) {
    throw new Error(
      tok
        ? "The hub rejected the service token (401). Check the token is valid in " +
          "Cloudflare Access and that its name is mapped in CF_ACCESS_SERVICE_TENANTS."
        : "The hub requires authentication (401) and no service token is configured. " +
          "Set CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET in this MCP server's env " +
          `(or write ${TOKEN_FILE}).`
    );
  }
  return res;
}

// ── JSON request wrapper (the workflow tools' calling convention) ────────────

interface ClientResponse<T = unknown> {
  ok: true;
  status: number;
  data: T;
}

interface ClientError {
  ok: false;
  status: number;
  message: string;
}

export type ClientResult<T = unknown> = ClientResponse<T> | ClientError;
export type { ClientError };

export async function request<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs = 30_000
): Promise<ClientResult<T>> {
  try {
    const res = await hubFetch(
      path,
      {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      timeoutMs
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const truncated = text.length > 1000 ? text.slice(0, 1000) + "..." : text;
      return { ok: false, status: res.status, message: `HTTP ${res.status}: ${truncated}` };
    }

    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return {
        ok: false,
        status: 0,
        message: `Request timed out after ${timeoutMs}ms: ${method} ${path}`,
      };
    }
    const message = err instanceof Error ? err.message : "Unknown network error";
    return { ok: false, status: 0, message };
  }
}
