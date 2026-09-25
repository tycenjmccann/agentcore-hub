/**
 * Writing a probe outcome onto its catalog row (TEAM-4997, hardened in TEAM-5052).
 *
 * A sibling of `route.ts` rather than part of it: Next only allows the HTTP
 * method handlers as runtime exports of a route module, and the tests need the
 * write-deps seam below (same reason as `./detached.ts` and `../registry/save.ts`).
 *
 * Three rules, each one a way outcomes used to be lost or worse:
 *   • **Only the live document is written.** Every attempt re-reads with
 *     `force: true` and goes through `requireLiveRegistry`. A read that fell back
 *     to the cached copy or the bundled seed is refused (`probe.write_refused`):
 *     the cache's stale ETag 412s forever, and the seed has no ETag at all, so
 *     its PUT went out unconditionally and replaced the live document with
 *     seed + one probe result.
 *   • **One write at a time per instance.** Every outcome is chained on
 *     `writeChain`, so ten probes finishing in the same tick queue up instead of
 *     racing one another's ETags. Other instances (and operator saves) are still
 *     serialized by the conditional PUT.
 *   • **Losing a race is retried, with jitter.** Up to `WRITE_ATTEMPTS`, each
 *     backing off 100-500ms. After that the row gets one best-effort
 *     `{ok:false, error:"write_failed"}`, so the page shows the probe ran and was
 *     not recorded rather than silently keeping an older result.
 *   • **Neither a retry nor the write_failed marker outraces a newer outcome.**
 *     Every write is ordered by the ORIGINAL outcome's `at` (its finish time),
 *     never the marker's own fresh timestamp: if the row already holds a
 *     result newer than the one being written, the write is skipped
 *     (`probe.write_superseded` / `probe.write_failed_superseded`) instead of
 *     overwriting another instance's more recent result with a stale one.
 */

import {
  RegistryFallbackError,
  VersionConflictError,
  loadModelsRegistryMeta,
  requireLiveRegistry,
  saveModelsRegistry,
} from "@/lib/models-registry";
import type { CatalogRow, ModelsRegistry, ProbeOutcome } from "@/lib/models-registry";

export type ProbeMode = "api" | "cli";

const WRITE_ATTEMPTS = 5;

interface WriteDeps {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

const DEFAULT_DEPS: WriteDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};
let deps: WriteDeps = DEFAULT_DEPS;

/** Test seam: replace the backoff's clock and jitter. */
export function __setProbeWriteDeps(d: Partial<WriteDeps>): void {
  deps = { ...DEFAULT_DEPS, ...d };
}

export function __resetProbeWriteDeps(): void {
  deps = DEFAULT_DEPS;
}

let writeChain: Promise<void> = Promise.resolve();

type WriteResult = "written" | "refused" | "row_gone" | "conflict" | "superseded";

/** True only when `storedAt` is a real, later timestamp than `at`. Missing or
 *  unparsable input on either side is treated as "not later" (returns false),
 *  so an outcome with no comparable timestamp is never blocked from writing. */
function newerThan(storedAt: string | undefined, at: string): boolean {
  const stored = storedAt ? Date.parse(storedAt) : NaN;
  const candidate = Date.parse(at);
  if (Number.isNaN(stored) || Number.isNaN(candidate)) return false;
  return stored > candidate;
}

/**
 * One read-modify-conditional-PUT. Throws only for errors other than a lost
 * race. `orderAt` is the timestamp this write is ordered by — the ORIGINAL
 * outcome's `at`, not necessarily `outcome.at` itself (the write_failed
 * marker passes its predecessor's `at` here, see `write()` below). If the row
 * already holds a probe result newer than `orderAt`, the write is skipped
 * entirely: a slow retry (or a best-effort failure marker) must never
 * overwrite a result another instance recorded more recently.
 */
async function writeOnce(
  modelId: string,
  mode: ProbeMode,
  outcome: ProbeOutcome,
  orderAt: string = outcome.at,
  supersededTag: string = "probe.write_superseded"
): Promise<WriteResult> {
  let live;
  try {
    live = requireLiveRegistry(await loadModelsRegistryMeta({ force: true }));
  } catch (err) {
    if (!(err instanceof RegistryFallbackError)) throw err;
    console.warn(
      `[models] probe.write_refused modelId=${modelId} mode=${mode} reason=registry_fallback source=${err.source}`
    );
    return "refused";
  }
  const next: ModelsRegistry = JSON.parse(JSON.stringify(live.registry)) as ModelsRegistry;
  const row = next.catalog.find((r: CatalogRow) => r.modelId === modelId);
  if (!row) {
    console.warn(`[models] probe.row_gone modelId=${modelId} mode=${mode}`);
    return "row_gone";
  }
  const current = row.probe?.[mode];
  if (newerThan(current?.at, orderAt)) {
    console.warn(
      `[models] ${supersededTag} modelId=${modelId} mode=${mode} at=${orderAt} current=${current?.at}`
    );
    return "superseded";
  }
  row.probe = { ...(row.probe || {}), [mode]: outcome };
  next.version = live.registry.version + 1;
  next.updatedAt = new Date().toISOString();
  next.updatedBy = "probe";
  try {
    await saveModelsRegistry(next, { ifMatch: live.etag });
    return "written";
  } catch (err) {
    if (err instanceof VersionConflictError) return "conflict";
    throw err;
  }
}

async function write(modelId: string, mode: ProbeMode, outcome: ProbeOutcome): Promise<void> {
  let error = "version_conflict";
  let attempts = 0;
  try {
    while (attempts < WRITE_ATTEMPTS) {
      attempts++;
      const result = await writeOnce(modelId, mode, outcome);
      if (result !== "conflict") return;
      if (attempts < WRITE_ATTEMPTS) await deps.sleep(100 + deps.random() * 400);
    }
  } catch (err) {
    error = (err as Error)?.message || "error";
  }

  console.warn(`[models] probe.write_failed modelId=${modelId} mode=${mode} attempts=${attempts} error=${error}`);
  // Best effort, once, through the same guard and CAS: the row says the result
  // was lost rather than keeping whatever an older probe left there. Ordered
  // by the OUTCOME's own `at` (not this marker's fresh timestamp), so a
  // competing instance's result that landed newer than the outcome we lost is
  // left alone.
  try {
    await writeOnce(
      modelId,
      mode,
      { ok: false, at: new Date().toISOString(), error: "write_failed" },
      outcome.at,
      "probe.write_failed_superseded"
    );
  } catch {
    // Nothing further to do; the warning above is the record.
  }
}

/**
 * Write `probe.<mode>` onto the row. Reads the LIVE document first (never the
 * one the request saw), so a probe records a result onto whatever the catalog
 * has become while it ran. Never throws.
 */
export function recordOutcome(modelId: string, mode: ProbeMode, outcome: ProbeOutcome): Promise<void> {
  const run = () => write(modelId, mode, outcome);
  writeChain = writeChain.then(run, run);
  return writeChain;
}
