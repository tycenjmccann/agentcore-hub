/**
 * POST /api/models/registry/reapply (TEAM-4997) — redo the side effects of the
 * live document without writing it again.
 *
 * This is the recovery path for a 207: the registry write landed but the pricing
 * projection or a harness update did not. Re-POSTing the whole document would
 * bump the version for no reason (and fail the version check the operator's page
 * is now holding), so reapply takes the document as-is, regenerates
 * `config/pricing.json` from it and pushes it at the harnesses again.
 *
 * `version` is required and must be the live one — a reapply against a document
 * the operator is no longer looking at is exactly the surprise this refuses.
 * `agentId` narrows the harness apply to one agent; the projection always runs,
 * because it is a single idempotent write.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAdmin } from "@/lib/auth/identity";
import { loadModelsRegistryMeta } from "@/lib/models-registry";
import { APPLY_HARNESS_AGENT_IDS, applyHarnessModels } from "@/lib/models/harness-apply";
import { assertSameOrigin } from "@/lib/models/request-guard";
import { NO_STORE, projectPricing } from "../save";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAdmin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403, ...NO_STORE });
  const crossOrigin = assertSameOrigin(req);
  if (crossOrigin) return crossOrigin;

  let body: { version?: unknown; agentId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400, ...NO_STORE });
  }

  const version = Number(body.version);
  if (!Number.isFinite(version)) {
    return NextResponse.json({ error: "bad_request", detail: "version is required" }, { status: 400, ...NO_STORE });
  }
  const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
  if (agentId && !APPLY_HARNESS_AGENT_IDS.includes(agentId as (typeof APPLY_HARNESS_AGENT_IDS)[number])) {
    return NextResponse.json({ error: "unknown_agent", agentId }, { status: 400, ...NO_STORE });
  }

  const live = await loadModelsRegistryMeta({ force: true });
  if (live.registry.version !== version) {
    return NextResponse.json(
      {
        error: "version_conflict",
        live: { version: live.registry.version, updatedAt: live.registry.updatedAt },
      },
      { status: 409, ...NO_STORE }
    );
  }

  const pricing = await projectPricing(live.registry);
  // `liveReg` and `nextReg` are the same document on purpose: nothing changed, so
  // the only reason to touch a harness is that it is asked for BY NAME. Without
  // an agentId a divergence reports as `drift` instead of being taken over.
  const agents = await applyHarnessModels(live.registry, live.registry, agentId ? [agentId] : undefined);
  const degraded = pricing.status === "failed" || agents.some((a) => a.status === "failed");

  console.log(
    `[models] registry.reapplied version=${version} agentId=${agentId || "all"}` +
      ` pricing=${pricing.status} agents=[${agents.map((a) => `${a.agentId}:${a.status}`).join(",")}]`
  );

  return NextResponse.json(
    { ok: !degraded, registry: live.registry, pricing, agents },
    { status: degraded ? 207 : 200, ...NO_STORE }
  );
}
