/**
 * GET/POST /api/models/catalog (TEAM-4997) — the catalog, and its refresh.
 *
 * GET is read-only and cheap. A refresh sweeps inference profiles and Mantle,
 * re-prices against the Price List and writes the document, so it is a POST:
 * `GET ?refresh=1` answers **405 `use_post`** rather than doing the work, because
 * a GET that mutates is a GET a browser prefetch, a link preview or a retry can
 * fire on the operator's behalf.
 *
 * A refresh never changes routing. `mergeDiscovered` only adds `candidate` rows
 * and retires vanished ones, and `refreshPrices` records a moved published rate
 * as drift instead of applying it — so the worst a refresh can do is show the
 * operator something new.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAdmin } from "@/lib/auth/identity";
import {
  RegistryFallbackError,
  VersionConflictError,
  fatalReadErrors,
  loadModelsRegistryMeta,
  requireLiveRegistry,
  saveModelsRegistry,
  validateRegistry,
} from "@/lib/models-registry";
import type { ModelsRegistry } from "@/lib/models-registry";
import { discoverModels, mergeDiscovered } from "@/lib/models/discovery";
import { refreshPrices } from "@/lib/models/pricing-api";
import { assertSameOrigin } from "@/lib/models/request-guard";
import { NO_STORE, projectPricing } from "../registry/save";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  if (url.searchParams.has("refresh")) {
    return NextResponse.json({ error: "use_post" }, { status: 405, ...NO_STORE });
  }
  const meta = await loadModelsRegistryMeta({ force: url.searchParams.has("fresh") });
  return NextResponse.json(
    { catalog: meta.registry.catalog, version: meta.registry.version, source: meta.source },
    NO_STORE
  );
}

/** One conflict retry: a concurrent save is a race worth losing exactly once. */
const SAVE_ATTEMPTS = 2;

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAdmin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403, ...NO_STORE });
  const crossOrigin = assertSameOrigin(req);
  if (crossOrigin) return crossOrigin;

  let body: { refresh?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400, ...NO_STORE });
  }
  if (body.refresh !== true) {
    return NextResponse.json({ error: "bad_request", detail: "expected {refresh:true}" }, { status: 400, ...NO_STORE });
  }

  const discovery = await discoverModels();
  // Nothing came back and something failed: that is an outage, not an empty
  // account, and merging it would retire the entire catalog.
  if (!discovery.models.length && discovery.errors.length) {
    console.warn(`[models] discovery.failed errors=[${discovery.errors.join("; ")}]`);
    return NextResponse.json(
      { error: "discovery_failed", errors: discovery.errors },
      { status: 502, ...NO_STORE }
    );
  }

  let saved: ModelsRegistry | null = null;
  let added: string[] = [];
  let retired: string[] = [];
  let repriced: string[] = [];
  let drifted: string[] = [];
  let priceErrors: string[] = [];

  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
    // Only the live S3 document may be merged into and written back (TEAM-5052):
    // a forced read that comes back `cache` or `seed` means the live document is
    // missing, unreadable or refused, and writing the seed + this sweep over it
    // would replace the operator's catalog wholesale.
    let live;
    try {
      live = requireLiveRegistry(await loadModelsRegistryMeta({ force: true }));
    } catch (err) {
      if (!(err instanceof RegistryFallbackError)) throw err;
      console.warn(`[models] discovery.write_refused reason=registry_fallback source=${err.source}`);
      return NextResponse.json(
        { error: "registry_unavailable", source: err.source, fallback: err.fallback ?? null },
        { status: 503, ...NO_STORE }
      );
    }
    const merged = mergeDiscovered(live.registry, discovery.models, { scanned: discovery.scanned });
    const priced = await refreshPrices(merged.next);
    added = merged.added;
    retired = merged.retired;
    repriced = priced.repriced;
    drifted = priced.drifted;
    priceErrors = priced.errors;

    const next: ModelsRegistry = {
      ...priced.next,
      version: live.registry.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: "discovery",
    };

    // The verdict the reconcile's pass() applies (TEAM-5073): a document the read
    // gate would refuse is never written, because every reader would then fall
    // back on the whole catalog. Nothing is saved and pricing is not projected.
    const fatal = fatalReadErrors(validateRegistry(next).errors);
    if (Object.keys(fatal).length) {
      const errors = Object.entries(fatal).map(([k, v]) => `${k}=${v}`).join(",");
      console.warn(`[models] discovery.invalid-document errors=${errors}`);
      return NextResponse.json(
        { error: "invalid_registry", fields: fatal, discovered: { added, retired, repriced, drifted } },
        { status: 422, ...NO_STORE }
      );
    }

    try {
      await saveModelsRegistry(next, { ifMatch: live.etag });
      saved = next;
      break;
    } catch (err) {
      if (err instanceof VersionConflictError && attempt < SAVE_ATTEMPTS - 1) continue;
      if (err instanceof VersionConflictError) {
        return NextResponse.json({ error: "version_conflict", detail: err.message }, { status: 409, ...NO_STORE });
      }
      const error = (err as Error)?.message || "registry write failed";
      return NextResponse.json({ error: "registry_write_failed", detail: error }, { status: 503, ...NO_STORE });
    }
  }
  if (!saved) {
    return NextResponse.json({ error: "version_conflict" }, { status: 409, ...NO_STORE });
  }

  // A reprice that never reaches config/pricing.json is the drift this epic
  // exists to kill, so the projection runs here too — non-fatally, since the
  // catalog itself is already saved.
  const pricing = await projectPricing(saved);
  const degraded = pricing.status === "failed";

  console.log(
    `[models] discovery.merged version=${saved.version} added=${added.length} retired=${retired.length}` +
      ` repriced=${repriced.length} drifted=${drifted.length}`
  );

  return NextResponse.json(
    {
      ok: !degraded,
      catalog: saved.catalog,
      version: saved.version,
      discovered: {
        added,
        retired,
        repriced,
        drifted,
        // Which planes this refresh actually saw. A partial sweep retires nothing
        // on the plane it missed, so saying so is what makes the result legible.
        scanned: [...discovery.scanned].sort(),
        skippedEndpoints: discovery.skippedEndpoints,
        errors: [...discovery.errors, ...priceErrors],
      },
      pricing,
    },
    { status: degraded ? 207 : 200, ...NO_STORE }
  );
}
