/**
 * POST /api/models/probe (TEAM-4997) — "does this model actually work?"
 *
 * A CLI probe clones a repo and runs a real coding turn; it can take minutes. So
 * this route **accepts** the work (202) and runs it detached, and the result
 * lands on the catalog row where the /models page reads it on its next poll. A
 * request that waited would be killed by an ALB idle timeout long before the
 * answer arrived, and the operator would learn nothing.
 *
 * Two guards make "detached" safe:
 *   • an in-flight map keyed `<modelId>#<mode>` refuses a duplicate for 10
 *     minutes — a double-click must not start two CLI sessions;
 *   • the write is read-before-write against the live document with one retry,
 *     because a probe finishing while an operator saves must not clobber the
 *     save (or be clobbered silently by it).
 *
 * The in-flight map is per-instance. With several hub tasks two probes of the
 * same model can still overlap; they are idempotent (each writes the same field)
 * and the conditional PUT serializes them, so the cost is a wasted probe, not a
 * corrupt row.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAdmin } from "@/lib/auth/identity";
import {
  MODEL_ID_RE,
  VersionConflictError,
  loadModelsRegistryMeta,
  resolveModel,
  saveModelsRegistry,
} from "@/lib/models-registry";
import type { CatalogRow, ModelsRegistry, ProbeOutcome } from "@/lib/models-registry";
import { runApiProbe, runCliProbe } from "@/lib/models/probe";
import { assertSameOrigin } from "@/lib/models/request-guard";
import { track } from "./detached";

export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "Cache-Control": "no-store" } } as const;

export type ProbeMode = "api" | "cli";
const MODES: readonly ProbeMode[] = ["api", "cli"];

/** Long enough to cover a 300s CLI turn plus its teardown, and then some. */
const IN_FLIGHT_TTL_MS = 10 * 60_000;
/** How soon the page should ask again. An API probe is usually done by then. */
const POLL_AFTER_MS = 15_000;

const inFlight = new Map<string, number>();

function claim(key: string): boolean {
  const started = inFlight.get(key);
  if (started !== undefined && Date.now() - started < IN_FLIGHT_TTL_MS) return false;
  inFlight.set(key, Date.now());
  return true;
}

/**
 * Write `probe.<mode>` onto the row. Reads the LIVE document first (never the
 * one the request saw), so a probe records a result onto whatever the catalog has
 * become while it ran.
 */
async function recordOutcome(modelId: string, mode: ProbeMode, outcome: ProbeOutcome): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const live = await loadModelsRegistryMeta({ force: true });
    const next: ModelsRegistry = JSON.parse(JSON.stringify(live.registry)) as ModelsRegistry;
    const row = next.catalog.find((r: CatalogRow) => r.modelId === modelId);
    if (!row) {
      console.warn(`[models] probe.row_gone modelId=${modelId} mode=${mode}`);
      return;
    }
    row.probe = { ...(row.probe || {}), [mode]: outcome };
    next.version = live.registry.version + 1;
    next.updatedAt = new Date().toISOString();
    next.updatedBy = "probe";

    try {
      await saveModelsRegistry(next, { ifMatch: live.etag });
      return;
    } catch (err) {
      if (err instanceof VersionConflictError && attempt === 0) continue;
      console.warn(
        `[models] probe.write_failed modelId=${modelId} mode=${mode} error=${(err as Error)?.message || "error"}`
      );
      return;
    }
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAdmin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403, ...NO_STORE });
  const crossOrigin = assertSameOrigin(req);
  if (crossOrigin) return crossOrigin;

  let body: { modelId?: unknown; mode?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400, ...NO_STORE });
  }

  const modelId = typeof body.modelId === "string" ? body.modelId : "";
  const mode = body.mode as ProbeMode;
  if (!MODEL_ID_RE.test(modelId)) {
    return NextResponse.json({ error: "bad_model_id" }, { status: 400, ...NO_STORE });
  }
  if (!MODES.includes(mode)) {
    return NextResponse.json({ error: "bad_mode", detail: 'mode is "api" or "cli"' }, { status: 400, ...NO_STORE });
  }

  const { registry } = await loadModelsRegistryMeta({});
  const row = registry.catalog.find((r) => r.modelId === modelId);
  if (!row) {
    return NextResponse.json({ error: "unknown_model", modelId }, { status: 404, ...NO_STORE });
  }

  // A row the resolver will not resolve to ITSELF must not be probed. The coding
  // runtime's `resolve_coding_model` gets null for a retired or quarantined id and
  // silently falls through to `defaults.coding*`, and the turn result carries no
  // model echo to catch it with — so a green result would be a green result for
  // some other model, and finding 2's adoption gate would then trust it. The
  // refusal IS the guard until the runtime echoes the model it ran
  // (deploy/coding-agent-runtime/models_registry.py, and see src/lib/models/probe.ts).
  const resolved = resolveModel(registry, modelId, { cli: row.vendor === "openai" ? "codex" : "claude" });
  if (!resolved || resolved.modelId !== row.modelId || resolved.source !== "catalog") {
    return NextResponse.json(
      {
        error: "not_probeable",
        modelId,
        status: registry.quarantine.includes(modelId) ? "quarantined" : row.status,
      },
      { status: 409, ...NO_STORE }
    );
  }

  const key = `${modelId}#${mode}`;
  if (!claim(key)) {
    return NextResponse.json({ error: "probe_in_flight", modelId, mode }, { status: 409, ...NO_STORE });
  }

  console.log(`[models] probe.accepted modelId=${modelId} mode=${mode}`);
  // Detached on purpose — see the module doc. The `finally` releases the claim so
  // a failed probe can be retried immediately rather than after the 10-minute TTL.
  // `track` lets the tests await the run instead of polling for its write.
  void track(
    (async () => {
      try {
        const outcome = mode === "api" ? await runApiProbe(row) : await runCliProbe(row);
        await recordOutcome(modelId, mode, outcome);
      } catch (err) {
        console.warn(`[models] probe.crashed modelId=${modelId} mode=${mode} error=${(err as Error)?.message || "error"}`);
      } finally {
        inFlight.delete(key);
      }
    })()
  );

  return NextResponse.json(
    { accepted: true, modelId, mode, pollAfterMs: POLL_AFTER_MS },
    { status: 202, ...NO_STORE }
  );
}
