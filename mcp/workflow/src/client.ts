import { config } from "./config.js";

const DEFAULT_TIMEOUT_MS = 30_000;

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

type ClientResult<T = unknown> = ClientResponse<T> | ClientError;

export type { ClientError, ClientResult };

export async function request<T = unknown>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ClientResult<T>> {
  const url = `${config.deploymentUrl}${path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (config.authToken) {
    headers["Authorization"] = `Bearer ${config.authToken}`;
  }

  // Cloudflare Access service token: the mode the Hub's middleware actually
  // accepts (AUTH_MODE=cloudflare-access). Access validates these at the edge
  // and injects the Cf-Access-Jwt-Assertion the middleware verifies.
  if (config.cfAccessClientId && config.cfAccessClientSecret) {
    headers["CF-Access-Client-Id"] = config.cfAccessClientId;
    headers["CF-Access-Client-Secret"] = config.cfAccessClientSecret;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const truncated = text.length > 1000 ? text.slice(0, 1000) + "..." : text;
      return {
        ok: false,
        status: res.status,
        message: `HTTP ${res.status}: ${truncated}`,
      };
    }

    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err: unknown) {
    clearTimeout(timeout);

    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        status: 0,
        message: `Request timed out after ${timeoutMs}ms: ${method} ${path}`,
      };
    }

    const message =
      err instanceof Error ? err.message : "Unknown network error";
    return {
      ok: false,
      status: 0,
      message: `Network error: ${message}`,
    };
  }
}
