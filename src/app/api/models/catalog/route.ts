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
 *
 * No add-row intake (TEAM-5011). Discovery is the ONLY way a model id becomes a
 * catalog row — `POST {add:<modelId>}` is refused with 400, not implemented as
 * a second path. Three reasons: (1) TEAM-4994 finding 9 (High) named the
 * frontend's former "Add to catalog" button — a span-derived string staged as a
 * candidate row — as an injection origin, since a model id reaches a Codex
 * config.toml (merge-codex-config.py) and a shell `eval` in the coding runtime;
 * the guard is that a catalog row originates from an account sweep, never from
 * a string out of telemetry. (2) a row's endpoint/region/api/contextWindow
 * cannot be trusted from a bare id — discovery reads them from the source
 * (listInferenceProfiles / listMantleModels), a heuristic row would guess. (3)
 * every id that emitted a span on a live model is discoverable by a Refresh;
 * the residual gap (a bare CLI short name Claude Code emits as
 * gen_ai.request.model) is an ALIAS on an existing `us.*` row, not a new one —
 * and /models has no alias editor yet, so that gap stays a documented follow-up
 * rather than a second intake path.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAdmin } from "@/lib/auth/identity";
import { VersionConflictError, loadModelsRegistryMeta, saveModelsRegistry } from "@/lib/models-registry";
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

  let body: { refresh?: unknown; add?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400, ...NO_STORE });
  }

  // NO ADD-ROW INTAKE (TEAM-5011, see header). Checked on the KEY, not its
  // value, and before the refresh check below, so `{refresh:true, add:…}`
  // is refused too rather than quietly discovering while ignoring `add`.
  // `body` is only ever `null` or an object here (a JSON array/primitive would
  // fail the refresh check the same way `body.refresh !== true` always has),
  // but `"add" in null` throws, so that case is excluded explicitly.
  if (typeof body === "object" && body !== null && "add" in body) {
    return NextResponse.json(
      {
        error: "bad_request",
        detail: "no add-row intake: a model enters the catalog through discovery (refresh), never from a caller-supplied id (TEAM-5011)",
      },
      { status: 400, ...NO_STORE }
    );
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
    const live = await loadModelsRegistryMeta({ force: true });
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
