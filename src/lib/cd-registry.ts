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
  /**
   * CodeBuild PR-check PROJECT for this repo (TEAM-4122 FR-5) — a different
   * resource from `pipeline`, which names a CodePipeline. Read by the
   * orchestrator's CI reachability check; absent → CI_PROJECT_NAME →
   * `agentcore-hub-ci`.
   */
  ciProject?: string;
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
/**
 * Registry cache TTL. Aligned with every other reader of this document
 * (requirements §3.1): the orchestrator (lambda/orchestrator/index.mjs) and the
 * Pipeline___* tools Lambda (lambda/agentcore-hub-pipeline-tools/index.mjs) both
 * read CD_REGISTRY_TTL_MS with a 60000 default; the deploy-gate bridge
 * (deploy/telegram-bug-intake/index.mjs) pins the same 60s. The app used 15s —
 * and the app is the reader whose job is to DESCRIBE what the other three will
 * do, so a shorter window meant the console could show a registry state the
 * enforcers had not adopted yet.
 *
 * A zero/negative/NaN/Infinity override falls back to 60s instead of through:
 * same rule as firstNum() in src/lib/workflow/watchdog.ts and resolveTtlMs() in
 * src/lib/workflow/lease.ts. Here a nonpositive TTL would mean an S3 GET on
 * every request, and an infinite one would pin a stale registry for the life of
 * the server process.
 *
 * The env is a parameter (defaulting to process.env) purely so the unit test
 * needs no process.env mutation and no module reset — same shape as
 * resolveWatchdogFrom() in src/lib/workflow/watchdog.ts.
 */
export function resolveRegistryTtlMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.CD_REGISTRY_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

const TTL_MS = resolveRegistryTtlMs();
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
      for (const f of ["pipeline", "region", "ciProject", "deployDoc", "notes"] as const) {
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

export interface PipelineProjects {
  /** The CodePipeline that deploys the repo (the entry's `pipeline`). */
  pipeline: string;
  region: string;
  ciProject: string;
  buildProject: string;
  deployProject: string;
}

/**
 * The AWS project names implied by an entry's `pipeline`, by convention:
 * `hub-<slug>-deploy` → `hub-<slug>-ci` / `hub-<slug>-build` / `hub-<slug>-deploy`
 * (the hub's own resources keep the `agentcore-hub-*` names: `agentcore-hub-deploy`
 * → `agentcore-hub-ci` / `agentcore-hub-build`).
 *
 * TS mirror of pipelineProjects() in lambda/orchestrator/cd-registry.mjs — same
 * derivation, so the UI names the same resources the tools Lambda drives. An
 * explicit `ciProject` on the entry always wins (a repo whose PR-check project
 * predates the convention). No pipeline → null (that repo has no CD target).
 */
export function pipelineProjectsFor(entry: CdRegistryEntry): PipelineProjects | null {
  const pipeline = (entry.pipeline || "").trim();
  if (!pipeline) return null;
  const SUFFIX = "-deploy";
  const base = pipeline.endsWith(SUFFIX) ? pipeline.slice(0, -SUFFIX.length) : pipeline;
  return {
    pipeline,
    // Definite string: every caller here has to hand it to an AWS client. The
    // canonical Lambda helper may instead leave an absent region to its caller's
    // default — the resolved value is the same (AWS_REGION, else us-east-1).
    region: entry.region || REGION,
    ciProject: entry.ciProject || `${base}-ci`,
    buildProject: `${base}-build`,
    deployProject: pipeline,
  };
}

/**
 * Every form of a deployDoc a consumer could end up resolving: the value as
 * typed, plus up to 3 decodeURIComponent passes (stopping as soon as decoding
 * changes nothing). `%2e%2e/x` and `%252e%252e/x` are traversals wearing one or
 * two layers of percent-encoding, so the path rules have to see through them.
 *
 * A malformed escape (`docs/100%/DEPLOY.md`, `%zz`) makes decodeURIComponent
 * throw — that is NOT a rejection, it just means the raw string is the final
 * form. A literal `%` is legal in a repo path and stays legal here.
 */
function deployDocForms(value: string): string[] {
  const forms = [value];
  let current = value;
  for (let pass = 0; pass < 3; pass++) {
    let decoded: string;
    try { decoded = decodeURIComponent(current); } catch { break; }
    if (decoded === current) break;
    forms.push(decoded);
    current = decoded;
  }
  return forms;
}

/**
 * Shape-validate a POST /api/workflow/cd-registry body before it ever reaches
 * upsertCdEntry/S3 — a typo here (`us-eat-1`, a pipeline name with spaces, a
 * deployDoc of `../../etc`) would otherwise be stored as-is and only fail later
 * inside a Lambda with an opaque AWS error (the registry is a runtime
 * allow-list read by the tools Lambda, the Telegram deploy-gate bridge and the
 * orchestrator — see docs/agents-own-cd.md).
 *
 * Returns null when the payload is fine, else every failing field's reason at
 * once (field name → reason), so the caller can report them all in one 400.
 *
 * An optional field that is blank/whitespace-only is NOT validated: that is
 * upsertCdEntry's "clear this field" signal (see the loop below it), not a
 * value, and parseCdRegistry trims + drops blanks anyway — so this validates
 * the exact (trimmed) bytes that would end up stored, and never rejects a
 * payload that is valid today.
 */
export function validateCdEntryInput(body: unknown): Record<string, string> | null {
  const fields: Record<string, string> = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { repo: "must be owner/repo or a GitHub URL" };
  }
  const o = body as Record<string, unknown>;

  if (!normalizeRepoKey(o.repo)) fields.repo = "must be owner/repo or a GitHub URL";

  const RULES: Record<string, { re: RegExp; reason: string }> = {
    region: { re: /^[a-z]{2}(-gov)?-[a-z]+-\d$/, reason: "must be an AWS region like us-east-1 or us-gov-west-1" },
    pipeline: { re: /^[A-Za-z0-9.@_-]{1,100}$/, reason: "must be a valid CodePipeline name (1-100 chars of [A-Za-z0-9.@_-])" },
    ciProject: { re: /^[A-Za-z0-9_-]{2,150}$/, reason: "must be a valid CodeBuild project name (2-150 chars of [A-Za-z0-9_-])" },
  };
  for (const f of ["pipeline", "region", "ciProject", "deployDoc", "notes"] as const) {
    const v = o[f];
    if (v === undefined) continue;
    if (typeof v !== "string") { fields[f] = "must be a string"; continue; }
    const trimmed = v.trim();
    if (!trimmed) continue; // blank = clear, not a value to validate
    const rule = RULES[f];
    if (rule && !rule.re.test(trimmed)) fields[f] = rule.reason;
  }
  if (typeof o.deployDoc === "string") {
    const trimmed = o.deployDoc.trim();
    if (trimmed && !fields.deployDoc) {
      if (trimmed.length > 200) fields.deployDoc = "must be at most 200 characters";
      // The two path rules are applied to the value as typed AND to each decoded
      // form of it, so an encoded traversal (`%2e%2e/x`, `..%2f`) is caught
      // without outlawing a literal `%` in a filename (`docs/100%/DEPLOY.md`).
      else for (const form of deployDocForms(trimmed)) {
        if (form.startsWith("/") || form.startsWith("\\")) { fields.deployDoc = "must be a relative path (no leading slash)"; break; }
        if (form.split(/[\\/]+/).includes("..")) { fields.deployDoc = "must not contain a .. path segment"; break; }
      }
    }
  }
  if (typeof o.notes === "string") {
    const trimmed = o.notes.trim();
    if (trimmed && !fields.notes && trimmed.length > 2000) fields.notes = "must be at most 2000 characters";
  }

  return Object.keys(fields).length ? fields : null;
}

/** Upsert by repo key (returns a new registry). */
export function upsertCdEntry(registry: CdRegistry, input: Partial<Omit<CdRegistryEntry, "repo">> & { repo: unknown }): CdRegistry {
  const key = normalizeRepoKey(input.repo);
  if (!key) throw new Error("repo must be owner/repo or a GitHub URL");
  const clean = parseCdRegistry({ repos: [{ ...input, repo: key }] }).repos[0];
  const existing = registry.repos.find((e) => e.repo === key);
  const merged: CdRegistryEntry = { ...(existing || {}), ...clean, repo: key, addedAt: existing?.addedAt || new Date().toISOString() };
  // An explicitly blank field clears it (the UI sends "" to unset a pipeline).
  for (const f of ["pipeline", "region", "ciProject", "deployDoc", "notes"] as const) {
    if (typeof input[f] === "string" && !(input[f] as string).trim()) delete merged[f];
  }
  return { version: registry.version || 1, repos: [...registry.repos.filter((e) => e.repo !== key), merged].sort((a, b) => a.repo.localeCompare(b.repo)) };
}

export function removeCdEntry(registry: CdRegistry, repo: unknown): CdRegistry {
  const key = normalizeRepoKey(repo);
  return { version: registry.version || 1, repos: registry.repos.filter((e) => e.repo !== key) };
}

const BUNDLED: CdRegistry = parseCdRegistry(bundled);

/**
 * Live registry from S3, cached 60s (env `CD_REGISTRY_TTL_MS`) — the same window
 * the orchestrator, the Pipeline___* tools Lambda and the deploy-gate bridge use.
 * `force: true` bypasses the cache, so a UI edit is visible immediately.
 *
 *   missing key  → EMPTY registry, cached as such (a fresh install has registered
 *                  nothing; that IS the registry, not an outage).
 *   read error   → the LAST GOOD cached copy.
 *   bundled seed → only on a cold start with no cache (no ARTIFACT_BUCKET, or the
 *                  process's first read failed).
 */
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
