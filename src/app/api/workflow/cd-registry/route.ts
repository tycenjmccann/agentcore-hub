import { NextRequest, NextResponse } from "next/server";
import {
  loadCdRegistry,
  saveCdRegistry,
  findCdEntry,
  normalizeRepoKey,
  upsertCdEntry,
  removeCdEntry,
  type CdRegistryEntry,
} from "@/lib/cd-registry";

/**
 * CD registry — which repos the hub merges + deploys (Workflow module).
 *
 *   GET  /api/workflow/cd-registry             → the whole registry
 *   GET  /api/workflow/cd-registry?repo=<url>  → { repo, registered, mode, entry }
 *   POST /api/workflow/cd-registry             → upsert { repo, pipeline?, region?, deployDoc?, notes? }
 *   DELETE /api/workflow/cd-registry           → remove { repo }
 *
 * Writes go to s3://ARTIFACT_BUCKET/config/cd-registry.json; the orchestrator
 * re-reads it within CD_REGISTRY_TTL_MS (60s), so a change applies to the next
 * dispatch of every run. An unregistered repo is HANDOFF (PR left open, no
 * merge/deploy) — see lambda/orchestrator/cd-registry.mjs.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const repo = req.nextUrl.searchParams.get("repo");
  const registry = await loadCdRegistry({ force: req.nextUrl.searchParams.has("fresh") });
  if (repo !== null) {
    const key = normalizeRepoKey(repo);
    const entry = findCdEntry(registry, repo);
    return NextResponse.json(
      { repo: key, registered: entry !== null, mode: entry ? "cd" : "handoff", entry },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.json(registry, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!normalizeRepoKey(body.repo)) {
    return NextResponse.json({ error: "repo must be owner/repo or a GitHub URL" }, { status: 400 });
  }
  for (const f of ["pipeline", "region", "ciProject", "deployDoc", "notes"]) {
    if (body[f] !== undefined && typeof body[f] !== "string") {
      return NextResponse.json({ error: `${f} must be a string` }, { status: 400 });
    }
  }
  try {
    const current = await loadCdRegistry({ force: true });
    const next = upsertCdEntry(current, body as Partial<Omit<CdRegistryEntry, "repo">> & { repo: unknown });
    await saveCdRegistry(next);
    return NextResponse.json({ ok: true, entry: findCdEntry(next, body.repo), registry: next });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to update CD registry" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const key = normalizeRepoKey(body.repo);
  if (!key) return NextResponse.json({ error: "repo must be owner/repo or a GitHub URL" }, { status: 400 });
  try {
    const current = await loadCdRegistry({ force: true });
    const next = removeCdEntry(current, key);
    await saveCdRegistry(next);
    return NextResponse.json({ ok: true, removed: current.repos.length !== next.repos.length, registry: next });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to update CD registry" }, { status: 500 });
  }
}
