/**
 * GET/POST /api/models/registry (TEAM-4997) — the registry document itself.
 *
 * GET answers three questions in one round trip, because the /models page needs
 * all three to render a row honestly:
 *   • what the document says (`registry`),
 *   • what it RESOLVES to per agent (`resolved`) — the chain, not the raw pin,
 *   • and what the live harness is actually running (`harnessModel`), which is
 *     the only way a console-vs-deploy divergence becomes visible.
 *
 * The third one talks to AWS, so it is strictly best-effort: cached 60s per
 * agent, each lookup bounded at 5s, and a miss omits the field rather than
 * failing the page. `getHarnessDetail` never throws but has no timeout of its
 * own (src/lib/agentcore-sdk.ts) — the race is what keeps a hung control-plane
 * call from hanging the whole GET.
 *
 * POST is the save sequence in ./save.ts.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import agentsConfig from "@/config/agents.json";
import { DEFAULT_REGION, getHarnessDetail, discoverAgents } from "@/lib/agentcore-sdk";
import { isAdmin } from "@/lib/auth/identity";
import {
  deployableAgentIds,
  loadModelsRegistryMeta,
  loadPreviousModelsRegistry,
  parseModelsRegistry,
  resolveAgentModel,
} from "@/lib/models-registry";
import type { ModelsRegistry } from "@/lib/models-registry";
import { assertSameOrigin } from "@/lib/models/request-guard";
import { NO_STORE, actorFor, runSaveSequence } from "./save";

export const dynamic = "force-dynamic";

/** Same TTL as discoverAgents, so the two caches expire on the same rhythm. */
const HARNESS_DETAIL_TTL_MS = 60_000;
/** A control-plane call that has not answered in 5s is not going to help. */
const HARNESS_DETAIL_TIMEOUT_MS = 5_000;
/** An `interim` rate older than this is a reminder, not an error. */
const INTERIM_OVERDUE_DAYS = 14;

/** Positive answers only — a timeout must not be remembered for a minute. */
const detailCache = new Map<string, { model?: string; at: number }>();

/** Harness agents are the only ones with a deployed model to compare against. */
function harnessAgentIds(): string[] {
  return (agentsConfig as { agents: Array<{ agentId?: string; type?: string }> }).agents
    .filter((a) => a.type === "harness" && a.agentId)
    .map((a) => a.agentId as string);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

async function harnessModelFor(agentId: string, region: string): Promise<string | undefined> {
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

function interimOverdue(reg: ModelsRegistry, now: Date): string[] {
  const cutoff = now.getTime() - INTERIM_OVERDUE_DAYS * 86_400_000;
  return reg.catalog
    .filter((row) => {
      if (row.price?.source !== "interim") return false;
      const asOf = Date.parse(row.price.asOf || "");
      return Number.isFinite(asOf) && asOf < cutoff;
    })
    .map((row) => row.modelId);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const force = url.searchParams.has("fresh");
  const wantPrevious = url.searchParams.get("withPrevious") === "1";

  const meta = await loadModelsRegistryMeta({ force });
  const registry = meta.registry;
  const region = DEFAULT_REGION;

  const harnessIds = new Set(harnessAgentIds());
  const agentIds = deployableAgentIds();
  const details = await Promise.allSettled(
    agentIds.filter((id) => harnessIds.has(id)).map(async (id) => [id, await harnessModelFor(id, region)] as const)
  );
  const harnessModels = new Map<string, string>();
  for (const settled of details) {
    if (settled.status === "fulfilled" && settled.value[1]) harnessModels.set(settled.value[0], settled.value[1]);
  }

  const resolved: Record<string, { modelId: string; source: string; via?: string; harnessModel?: string }> = {};
  for (const agentId of agentIds) {
    const r = resolveAgentModel(registry, agentId);
    const harnessModel = harnessModels.get(agentId);
    resolved[agentId] = {
      modelId: r.modelId,
      source: r.source,
      ...(r.via ? { via: r.via } : {}),
      ...(harnessModel ? { harnessModel } : {}),
    };
  }

  // Always read the prev document: `previous` tells the page whether rollback is
  // offerable at all, and `?withPrevious=1` only decides whether the whole doc
  // comes back with it (the diff view wants it; the header does not).
  const previous = await loadPreviousModelsRegistry();

  return NextResponse.json(
    {
      registry,
      source: meta.source,
      previous: previous
        ? { version: previous.version, updatedAt: previous.updatedAt, updatedBy: previous.updatedBy }
        : null,
      ...(wantPrevious ? { previousRegistry: previous } : {}),
      resolved,
      interimOverdue: interimOverdue(registry, new Date()),
    },
    NO_STORE
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAdmin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403, ...NO_STORE });
  const crossOrigin = assertSameOrigin(req);
  if (crossOrigin) return crossOrigin;

  let body: { baseVersion?: unknown; registry?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400, ...NO_STORE });
  }

  const baseVersion = Number(body.baseVersion);
  if (!Number.isFinite(baseVersion)) {
    return NextResponse.json({ error: "bad_request", detail: "baseVersion is required" }, { status: 400, ...NO_STORE });
  }
  if (!body.registry || typeof body.registry !== "object") {
    return NextResponse.json({ error: "bad_request", detail: "registry is required" }, { status: 400, ...NO_STORE });
  }

  // The same tolerant parse the loader uses: a body is no more trustworthy than
  // an S3 object, and both must reach `validateRegistry` in the same shape.
  const parsed = parseModelsRegistry(body.registry as Record<string, unknown>);

  return runSaveSequence({ candidate: parsed.registry, baseVersion, actor: actorFor(req) });
}
