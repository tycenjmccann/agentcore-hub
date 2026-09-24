/**
 * The registry save sequence (TEAM-4997), shared by POST /registry and
 * POST /registry/rollback — a rollback IS a save whose body happens to be the
 * previous document, so it must go through the same validation, the same
 * conditional PUT and the same projection. Two copies of this order would
 * eventually disagree about which of them repins the harnesses.
 *
 * The order is the whole point, and each step is a different failure:
 *   1. normalize  — seed-owned fields are re-applied from the bundled catalog
 *   2. validate   — one 422 carrying every bad field at once
 *   3. compare    — a stale `baseVersion` is a 409 before anything is written
 *   4. prev       — only when ROUTING changed, so a rollback target is meaningful
 *   5. models     — conditional PUT; 412/409 is a 409, anything else a 503
 *   6. pricing    — projected from what we just saved; a failure is a 207, not
 *                   a rollback: the registry write already happened and lying
 *                   about it would be worse than reporting a partial success
 *   7. harnesses  — applied last, and a `failed` agent is also a 207
 *
 * This file is not a route (Next only serves `route.ts`), it is the module both
 * routes import.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getIdentity } from "@/lib/auth/identity";
import {
  BUNDLED_REGISTRY,
  MODELS_PREV_KEY,
  VersionConflictError,
  loadModelsRegistryMeta,
  loadPricingProjection,
  pricingProjection,
  saveModelsRegistry,
  savePricingProjection,
  validateRegistry,
} from "@/lib/models-registry";
import type { CatalogRow, ModelsRegistry } from "@/lib/models-registry";
import { applyHarnessModels } from "@/lib/models/harness-apply";

export const NO_STORE = { headers: { "Cache-Control": "no-store" } } as const;

/** Who to stamp on the document and name in the audit line. */
export function actorFor(req: NextRequest): string {
  try {
    const id = getIdentity(req);
    return id.email || id.userId || "console";
  } catch {
    return "console";
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const SEED_ROWS = new Map<string, CatalogRow>(BUNDLED_REGISTRY.catalog.map((r) => [r.modelId, r]));

/**
 * `harnessLanes` and `readOnly` are SEED-OWNED: a lane id is baked into deployed
 * harness configurations and `readOnly` marks a model we must never route to, so
 * neither is editable through the console. Whatever the body says about them is
 * dropped and the bundled catalog's answer re-applied by modelId. A row the seed
 * has never heard of (a discovered candidate) gets neither.
 *
 * This runs BEFORE validation rather than after the version check: validating
 * lanes the operator cannot edit would 422 a save on a field the UI does not
 * even render.
 */
export function applySeedOwnedFields(reg: ModelsRegistry): ModelsRegistry {
  const next = clone(reg);
  for (const row of next.catalog) {
    delete row.harnessLanes;
    delete row.readOnly;
    const seed = SEED_ROWS.get(row.modelId);
    if (!seed) continue;
    if (seed.harnessLanes?.length) row.harnessLanes = clone(seed.harnessLanes);
    if (seed.readOnly) row.readOnly = true;
  }
  return next;
}

/** Flatten the parts of a document a diff cares about into comparable strings. */
function flatten(reg: ModelsRegistry): Map<string, string> {
  const out = new Map<string, string>();
  out.set("defaults.persona", reg.defaults.persona);
  out.set("defaults.codingClaude", reg.defaults.codingClaude);
  out.set("defaults.codingCodex", reg.defaults.codingCodex);
  for (const cli of ["claude", "codex"] as const) {
    for (const [tier, id] of Object.entries(reg.tiers[cli] || {})) out.set(`tiers.${cli}.${tier}`, id);
  }
  for (const [agentId, id] of Object.entries(reg.agents || {})) out.set(`agents.${agentId}`, id);
  for (const [alias, id] of Object.entries(reg.legacyAliases || {})) out.set(`legacyAliases.${alias}`, id);
  out.set("quarantine", [...(reg.quarantine || [])].sort().join(","));
  out.set("autoAdopt", JSON.stringify(reg.autoAdopt || {}));
  out.set("catalog", JSON.stringify(reg.catalog));
  return out;
}

/** Field paths that differ between two documents, for the audit line. */
export function changedFields(live: ModelsRegistry, next: ModelsRegistry): string[] {
  const a = flatten(live);
  const b = flatten(next);
  const changed: string[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(key) !== b.get(key)) changed.push(key);
  }
  return changed.sort();
}

/**
 * Did ROUTING change? Only a routing change earns a `models.prev.json` write:
 * rollback exists to undo "the wrong model is live", and a prev document written
 * for a relabelled catalog row would make the one-step history useless.
 */
export function routingChanged(changed: readonly string[]): boolean {
  return changed.some((f) => f.startsWith("defaults.") || f.startsWith("tiers.") || f.startsWith("agents."));
}

export interface PricingOutcome {
  status: "projected" | "failed";
  version?: number;
  keys?: number;
  error?: string;
}

/**
 * Regenerate `config/pricing.json` from a saved document. Never throws: the
 * registry is already live at this point and the caller reports a 207.
 */
export async function projectPricing(reg: ModelsRegistry): Promise<PricingOutcome> {
  try {
    const previous = await loadPricingProjection({ force: true });
    const doc = pricingProjection(reg, previous);
    await savePricingProjection(doc);
    return { status: "projected", version: reg.version, keys: Object.keys(doc.models).length };
  } catch (err) {
    const error = (err as Error)?.message || "pricing write failed";
    console.warn(`[models] pricing.write_failed error=${error}`);
    return { status: "failed", error };
  }
}

export interface SaveOptions {
  candidate: ModelsRegistry;
  baseVersion: number;
  actor: string;
  /** Labels the audit line: a plain save, or a rollback. */
  reason?: string;
  now?: Date;
}

/** Run steps 1-7. Always returns the response the route should send. */
export async function runSaveSequence(opts: SaveOptions): Promise<NextResponse> {
  const candidate = applySeedOwnedFields(opts.candidate);

  const verdict = validateRegistry(candidate);
  if (!verdict.ok) {
    return NextResponse.json(
      { error: "invalid_registry", fields: verdict.errors, warnings: verdict.warnings },
      { status: 422, ...NO_STORE }
    );
  }

  const live = await loadModelsRegistryMeta({ force: true });
  if (live.registry.version !== opts.baseVersion) {
    return NextResponse.json(
      {
        error: "version_conflict",
        live: {
          version: live.registry.version,
          updatedAt: live.registry.updatedAt,
          updatedBy: live.registry.updatedBy,
        },
      },
      { status: 409, ...NO_STORE }
    );
  }

  const changed = changedFields(live.registry, candidate);
  const next: ModelsRegistry = {
    ...candidate,
    version: live.registry.version + 1,
    updatedAt: (opts.now ?? new Date()).toISOString(),
    updatedBy: opts.actor,
  };

  if (routingChanged(changed)) {
    try {
      await saveModelsRegistry(live.registry, { key: MODELS_PREV_KEY });
    } catch (err) {
      // Refuse the save rather than lose the only rollback target.
      const error = (err as Error)?.message || "prev write failed";
      console.warn(`[models] prev.write_failed error=${error}`);
      return NextResponse.json({ error: "prev_write_failed", detail: error }, { status: 503, ...NO_STORE });
    }
  }

  try {
    await saveModelsRegistry(next, { ifMatch: live.etag });
  } catch (err) {
    if (err instanceof VersionConflictError) {
      return NextResponse.json({ error: "version_conflict", detail: err.message }, { status: 409, ...NO_STORE });
    }
    const error = (err as Error)?.message || "registry write failed";
    return NextResponse.json({ error: "registry_write_failed", detail: error }, { status: 503, ...NO_STORE });
  }

  console.log(
    `[models] registry.saved email=${opts.actor} base=${opts.baseVersion} version=${next.version}` +
      ` changed=[${changed.join(",")}]${opts.reason ? ` reason=${opts.reason}` : ""}`
  );

  const pricing = await projectPricing(next);
  // The harnesses follow the document we just saved even when the projection
  // failed — the routing IS live, and leaving the harnesses behind would add a
  // second inconsistency to the one we are already reporting.
  const agents = await applyHarnessModels(live.registry, next);
  const degraded = pricing.status === "failed" || agents.some((a) => a.status === "failed");

  return NextResponse.json(
    { ok: !degraded, registry: next, pricing, agents },
    { status: degraded ? 207 : 200, ...NO_STORE }
  );
}
