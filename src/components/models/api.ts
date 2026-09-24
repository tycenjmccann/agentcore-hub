/**
 * EVERY network call the Models page makes. Nothing else in the page or its
 * components calls `fetch`.
 *
 * Two reasons it is all in one module:
 *
 *  - The status code IS the outcome here. A registry save has seven meaningful
 *    responses (200 saved, 207 saved-but-pricing-failed, 400 malformed, 403 not
 *    admin, 409 version conflict, 422 illegal registry, 503 S3 unreachable), and
 *    each one drives different UI. `cachedFetch` throws on any non-2xx, so it
 *    cannot express them — these calls return `{ status, body }` and let the page
 *    branch. (The initial read still goes through `cachedFetch`, in
 *    src/lib/models-registry-client.ts, because there a failure really is just
 *    an error.)
 *  - The security review may turn catalog refresh from a GET into a POST. With
 *    every verb and path in this file that is a one-line change instead of a
 *    hunt through the components.
 *
 * Every call carries `x-aws-region`, because the registry is per-region like the
 * rest of the console, and every successful write drops the client cache for
 * `/api/models` so the next reader (this page, an agent card, the board) does not
 * serve the pre-write document.
 */

import { getClientRegion, invalidateCachePrefix } from "@/lib/client-cache";
import type {
  CatalogRefreshResponse,
  CatalogRow,
  ProbeAcceptedResponse,
  ProbeMode,
  RegistryDraft,
  RegistryResponse,
} from "./types";

const BASE = "/api/models";

/**
 * A response the caller is expected to branch on. `body` is whatever JSON came
 * back, or `null` when the response had no parseable body; `status` 0 means the
 * request never reached the server (offline, DNS, aborted), which the page
 * reports with the same copy as a 503 — the save did not land, the draft is
 * still here.
 */
export interface ApiResult<T> {
  status: number;
  body: T | null;
}

function headers(): Record<string, string> {
  return { "content-type": "application/json", "x-aws-region": getClientRegion() };
}

async function call<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, { ...init, headers: headers(), cache: "no-store" });
    let body: T | null = null;
    try {
      body = (await res.json()) as T;
    } catch {
      // A 204, an HTML error page from a proxy, a truncated response: the status
      // is still the answer, so keep it and let the caller decide.
    }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

/** Every write invalidates the read cache, so no consumer keeps a stale document. */
function invalidate() {
  invalidateCachePrefix(BASE);
}

// ─── Registry ───────────────────────────────────────────────────────────────

/**
 * Read the registry. The page loads with `fresh` so an operator arriving to fix
 * something is never handed a cached document; the cheap consumers (agent cards,
 * the board) go through the cached hook instead.
 */
export function getRegistry(opts?: { fresh?: boolean }): Promise<ApiResult<RegistryResponse>> {
  return call<RegistryResponse>(`${BASE}/registry${opts?.fresh ? "?fresh=1" : ""}`);
}

/**
 * Save the draft. `baseVersion` is what was loaded — the server compares it and
 * answers 409 rather than letting two editors overwrite each other. The body
 * carries the registry WITHOUT version/updatedAt/updatedBy: those are the
 * server's to assign, and sending them back would invite a client to forge them.
 */
export async function saveRegistry<T>(baseVersion: number, registry: RegistryDraft): Promise<ApiResult<T>> {
  const result = await call<T>(`${BASE}/registry`, {
    method: "POST",
    body: JSON.stringify({ baseVersion, registry }),
  });
  if (result.status === 200 || result.status === 207) invalidate();
  return result;
}

/** Re-pin one harness that has drifted from the registry. */
export async function reapplyAgent<T>(version: number, agentId: string): Promise<ApiResult<T>> {
  const result = await call<T>(`${BASE}/registry/reapply`, {
    method: "POST",
    body: JSON.stringify({ version, agentId }),
  });
  if (result.status === 200 || result.status === 207) invalidate();
  return result;
}

/** Re-run the pricing projection after a 207 left cost math on the old prices. */
export async function reapplyPricing<T>(version: number): Promise<ApiResult<T>> {
  const result = await call<T>(`${BASE}/registry/reapply`, {
    method: "POST",
    body: JSON.stringify({ version, pricing: true }),
  });
  if (result.status === 200 || result.status === 207) invalidate();
  return result;
}

/** Write a previous version's content forward as a new version. */
export async function rollbackRegistry<T>(toVersion: number, baseVersion: number): Promise<ApiResult<T>> {
  const result = await call<T>(`${BASE}/registry/rollback`, {
    method: "POST",
    body: JSON.stringify({ toVersion, baseVersion }),
  });
  if (result.status === 200 || result.status === 207) invalidate();
  return result;
}

// ─── Catalog ────────────────────────────────────────────────────────────────

/**
 * Re-discover models and republish prices. This rewrites the catalog on the
 * server, which is why the page makes the operator save or discard first.
 *
 * NOTE: a GET today, and a GET that mutates — the API ticket's security review
 * may move it to POST. When it does, this is the line that changes.
 */
export function refreshCatalog(): Promise<ApiResult<CatalogRefreshResponse>> {
  return call<CatalogRefreshResponse>(`${BASE}/catalog`);
}

/** Add a model seen in spans but absent from the catalog, as an unpriced candidate. */
export async function addCatalogRow<T>(modelId: string): Promise<ApiResult<T>> {
  const result = await call<T>(`${BASE}/catalog`, {
    method: "POST",
    body: JSON.stringify({ modelId }),
  });
  if (result.status === 200 || result.status === 201) invalidate();
  return result;
}

// ─── Probes ─────────────────────────────────────────────────────────────────

/**
 * Start a probe. Returns 202 with the server's own `pollAfterMs` — the cli probe
 * runs a real turn and takes 60 to 120 seconds, so the wait is the server's to
 * set, never a constant here.
 */
export function startProbe(modelId: string, mode: ProbeMode): Promise<ApiResult<ProbeAcceptedResponse>> {
  return call<ProbeAcceptedResponse>(`${BASE}/probe`, {
    method: "POST",
    body: JSON.stringify({ modelId, mode }),
  });
}

/**
 * Probe results live on the catalog row, so polling a probe is just re-reading
 * the registry. Returned narrowed to the row the caller is watching.
 */
export async function pollProbe(modelId: string): Promise<ApiResult<CatalogRow | null>> {
  const { status, body } = await getRegistry({ fresh: true });
  if (status !== 200 || !body) return { status, body: null };
  return { status, body: body.registry.catalog.find((r) => r.modelId === modelId) ?? null };
}

// ─── Evidence from real runs ────────────────────────────────────────────────

/**
 * The narrowest possible view of the fleet performance response: the completion
 * time to sort by, and the model ids the cost report could not price.
 *
 * `/api/workflow/performance` belongs to the Workflow module, and this page is
 * core — so it is reached by URL STRING and typed locally, never by importing
 * `@/lib/workflow/*`. The caller (UnpricedStrip) also checks the module is present
 * before asking. A missing route is a non-answer, not an error: the strip simply
 * has no evidence to show.
 */
export interface FleetRunSummary {
  workflowId?: string;
  completedAt?: string | null;
  cost?: { unpricedModels?: string[] };
}

export function getFleetPerformance(): Promise<ApiResult<{ runs?: FleetRunSummary[] }>> {
  return call<{ runs?: FleetRunSummary[] }>("/api/workflow/performance");
}
