/**
 * Simple in-memory client-side cache with TTL.
 * Persists across page navigations (lives in module scope).
 * Uses stale-while-revalidate: returns cached data immediately,
 * then refreshes in the background.
 */

interface CacheEntry<T> {
  data: T;
  ts: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

// Default TTL: 2 minutes (data is still fresh enough to display instantly)
const DEFAULT_TTL = 120_000;

/**
 * Get the active AWS region from localStorage (client-side only).
 */
export function getClientRegion(): string {
  if (typeof window === "undefined") return "us-east-1";
  return localStorage.getItem("aws-region") || "us-east-1";
}

/**
 * Build default headers for API requests (includes region).
 */
function defaultHeaders(): Record<string, string> {
  return { "x-aws-region": getClientRegion() };
}

/**
 * Fetch with client-side caching. Returns cached data immediately if available,
 * and revalidates in the background after TTL expires.
 *
 * @param url - Fetch URL (used as cache key)
 * @param opts - Optional: ttl (ms), forceRefresh
 */
export async function cachedFetch<T>(
  url: string,
  opts?: { ttl?: number; forceRefresh?: boolean }
): Promise<T> {
  const ttl = opts?.ttl ?? DEFAULT_TTL;
  const entry = cache.get(url) as CacheEntry<T> | undefined;

  // If we have fresh cached data, return it
  if (entry && !opts?.forceRefresh && Date.now() - entry.ts < ttl) {
    return entry.data;
  }

  // If we have stale data, return it immediately but revalidate
  if (entry && !opts?.forceRefresh) {
    // Background revalidate (fire-and-forget)
    fetchAndCache<T>(url).catch(() => {});
    return entry.data;
  }

  // No cache or force refresh — fetch fresh
  return fetchAndCache<T>(url);
}

/**
 * Get cached data synchronously (for instant rendering on mount).
 * Returns null if nothing is cached.
 */
export function getCached<T>(url: string): T | null {
  const entry = cache.get(url) as CacheEntry<T> | undefined;
  return entry ? entry.data : null;
}

/**
 * Invalidate a specific cache entry (e.g., after a mutation).
 */
export function invalidateCache(url: string) {
  cache.delete(url);
}

/**
 * Invalidate all entries matching a prefix.
 */
export function invalidateCachePrefix(prefix: string) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

async function fetchAndCache<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: defaultHeaders() });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const data = (await res.json()) as T;
  cache.set(url, { data, ts: Date.now() });
  return data;
}
