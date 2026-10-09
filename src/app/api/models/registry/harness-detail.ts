/**
 * The registry route's live-harness lookup (TEAM-4997; extracted TEAM-5028).
 *
 * `GET /api/models/registry` reports what each harness is ACTUALLY running,
 * which is the only way a console-vs-deploy divergence becomes visible. That
 * answer comes from the control plane, so it is strictly best-effort: cached 60s
 * per agent, each lookup bounded at 5s, and a miss omits the field rather than
 * failing the page. `getHarnessDetail` never throws but has no timeout of its
 * own (src/lib/agentcore-sdk.ts) — the race is what keeps a hung control-plane
 * call from hanging the whole GET.
 *
 * This is a sibling module rather than part of `./route.ts` for the same reason
 * `./save.ts` and `../probe/detached.ts` are: Next only allows the HTTP method
 * handlers (and a few config fields) as runtime exports of a route module, and a
 * stray export fails `next build`. The cache therefore lives here, where its
 * test seam (`__resetHarnessDetailCache`) is allowed to exist — a test that had
 * to reset the whole module registry to empty it is what made the route's suite
 * flaky (TEAM-5028).
 */

import { getHarnessDetail, discoverAgents } from "@/lib/agentcore-sdk";

/** Same TTL as discoverAgents, so the two caches expire on the same rhythm. */
const HARNESS_DETAIL_TTL_MS = 60_000;
/** A control-plane call that has not answered in 5s is not going to help. */
const HARNESS_DETAIL_TIMEOUT_MS = 5_000;

/** Positive answers only — a timeout must not be remembered for a minute. */
const detailCache = new Map<string, { model?: string; at: number }>();

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export async function harnessModelFor(agentId: string, region: string): Promise<string | undefined> {
  const key = `${region}#${agentId}`;
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.at < HARNESS_DETAIL_TTL_MS) return hit.model;
  try {
    const model = await withTimeout(
      (async () => {
        const agents = await discoverAgents(region);
        const harnessId = agents.find((a) => a.type === "harness" && a.name === agentId)?.id;
        if (!harnessId) return undefined;
        return (await getHarnessDetail(harnessId, region)).model;
      })(),
      HARNESS_DETAIL_TIMEOUT_MS
    );
    if (model) detailCache.set(key, { model, at: Date.now() });
    return model;
  } catch (err) {
    const reason = (err as Error)?.message === "timeout" ? "timeout" : "error";
    console.warn(`[models] harness.detail_failed agentId=${agentId} reason=${reason}`);
    return undefined;
  }
}

/** Test seam: drop the per-agent cache (same role as `__resetModelsCaches`). */
export function __resetHarnessDetailCache(): void {
  detailCache.clear();
}
