/**
 * CD registry (app side) — WHICH repos the hub merges + deploys.
 *
 * Mirror of lambda/orchestrator/cd-registry.mjs (the orchestrator is the
 * enforcer; this module is the reader/editor the UI and API use). The live
 * document is s3://<ARTIFACT_BUCKET>/config/cd-registry.json; the bundled
 * src/config/cd-registry.json is the first-deploy seed and the offline fallback.
 *
 *   registered   → CD: full ship phase (final-PR review → human Merge Approval →
 *                  merge + deploy via `pipeline` or the repo's DEPLOY.md).
 *   unregistered → HANDOFF: run ends after review/QA/CI; the orchestrator opens
 *                  the unified PR and leaves it open for the owning team.
 *
 * Core lib: no module imports (Workflow + Pipeline modules may both use it).
 */

import bundled from "@/config/cd-registry.json";

export interface CdRegistryEntry {
  /** Canonical lower-case `owner/repo`. */
  repo: string;
  /** CodePipeline that deploys the repo (enables Pipeline Mode for its agents). */
  pipeline?: string;
  /** Region of that pipeline. */
  region?: string;
  /** Path of the deploy contract the release manager follows when no pipeline is named. */
  deployDoc?: string;
  notes?: string;
  addedAt?: string;
}

export interface CdRegistry {
  version: number;
  repos: CdRegistryEntry[];
}

export type DeliveryMode = "cd" | "handoff";

export const CD_REGISTRY_KEY = "config/cd-registry.json";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";
const TTL_MS = 15_000;
let _cache: { registry: CdRegistry; at: number } | null = null;

/** `https://github.com/O/R.git` | `git@github.com:O/R.git` | `O/R` → `o/r`; null if not a repo ref. */
export function normalizeRepoKey(value: unknown): string | null {
  let s = String(value ?? "").trim();
  if (!s) return null;
  s = s.replace(/^git@[^:]+:/, "").replace(/^[a-z]+:\/\/[^/]+\//i, "");
  s = s.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const parts = s.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return `${parts[0]}/${parts[1]}`.toLowerCase();
}

/** Tolerant parse: malformed/duplicate entries are dropped, never thrown (same as the orchestrator). */
export function parseCdRegistry(raw: unknown): CdRegistry {
  let doc: unknown = raw;
  if (typeof raw === "string") {
    try { doc = JSON.parse(raw); } catch { return { version: 1, repos: [] }; }
  }
  if (!doc || typeof doc !== "object") return { version: 1, repos: [] };
  const d = doc as { version?: unknown; repos?: unknown };
  const list = Array.isArray(d.repos) ? d.repos : [];
  const seen = new Set<string>();
  const repos: CdRegistryEntry[] = [];
  for (const e of list) {
    const ref = typeof e === "string" ? e : (e as { repo?: unknown })?.repo;
    const key = normalizeRepoKey(ref);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry: CdRegistryEntry = { repo: key };
    if (e && typeof e === "object") {
      const o = e as Record<string, unknown>;
      for (const f of ["pipeline", "region", "deployDoc", "notes"] as const) {
        const v = typeof o[f] === "string" ? (o[f] as string).trim() : "";
        if (v) entry[f] = v;
      }
      if (typeof o.addedAt === "string") entry.addedAt = o.addedAt;
    }
    repos.push(entry);
  }
  return { version: Number(d.version) || 1, repos };
}

export function findCdEntry(registry: CdRegistry, repoUrl: unknown): CdRegistryEntry | null {
  const key = normalizeRepoKey(repoUrl);
  if (!key) return null;
  return registry.repos.find((e) => e.repo === key) || null;
}

export function deliveryModeFor(registry: CdRegistry, repoUrl: unknown): DeliveryMode {
  return findCdEntry(registry, repoUrl) ? "cd" : "handoff";
}

/** Upsert by repo key (returns a new registry). */
export function upsertCdEntry(registry: CdRegistry, input: Partial<Omit<CdRegistryEntry, "repo">> & { repo: unknown }): CdRegistry {
  const key = normalizeRepoKey(input.repo);
  if (!key) throw new Error("repo must be owner/repo or a GitHub URL");
  const clean = parseCdRegistry({ repos: [{ ...input, repo: key }] }).repos[0];
  const existing = registry.repos.find((e) => e.repo === key);
  const merged: CdRegistryEntry = { ...(existing || {}), ...clean, repo: key, addedAt: existing?.addedAt || new Date().toISOString() };
  // An explicitly blank field clears it (the UI sends "" to unset a pipeline).
  for (const f of ["pipeline", "region", "deployDoc", "notes"] as const) {
    if (typeof input[f] === "string" && !(input[f] as string).trim()) delete merged[f];
  }
  return { version: registry.version || 1, repos: [...registry.repos.filter((e) => e.repo !== key), merged].sort((a, b) => a.repo.localeCompare(b.repo)) };
}

export function removeCdEntry(registry: CdRegistry, repo: unknown): CdRegistry {
  const key = normalizeRepoKey(repo);
  return { version: registry.version || 1, repos: registry.repos.filter((e) => e.repo !== key) };
}

const BUNDLED: CdRegistry = parseCdRegistry(bundled);

/** Live registry from S3 (15s cache); bundled seed when S3 is unreachable or the key is absent. */
export async function loadCdRegistry(opts: { force?: boolean } = {}): Promise<CdRegistry> {
  const now = Date.now();
  if (!opts.force && _cache && now - _cache.at < TTL_MS) return _cache.registry;
  if (!ARTIFACT_BUCKET) return BUNDLED;
  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: REGION });
    const obj = await s3.send(new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: CD_REGISTRY_KEY }));
    const registry = parseCdRegistry(await obj.Body!.transformToString());
    _cache = { registry, at: now };
    return registry;
  } catch (err) {
    const name = (err as { name?: string })?.name || "";
    // Absent key = a fresh install that has registered nothing yet: that IS the
    // registry (empty), not an outage — don't fall back to the bundled seed.
    if (name === "NoSuchKey" || name === "NotFound") {
      const registry = { version: 1, repos: [] };
      _cache = { registry, at: now };
      return registry;
    }
    return _cache?.registry || BUNDLED;
  }
}

/** Persist the registry to S3 (the orchestrator re-reads it within its TTL). */
export async function saveCdRegistry(registry: CdRegistry): Promise<void> {
  if (!ARTIFACT_BUCKET) throw new Error("ARTIFACT_BUCKET is not configured");
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: REGION });
  const body = JSON.stringify({ version: registry.version || 1, repos: registry.repos }, null, 2) + "\n";
  await s3.send(new PutObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: CD_REGISTRY_KEY, Body: body, ContentType: "application/json" }));
  _cache = { registry, at: Date.now() };
}
