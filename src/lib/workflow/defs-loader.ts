/**
 * Server-side workflow-def loader — reads the LIVE config/workflows.json from S3
 * (the same document the orchestrator runs from), so defs created by the Routine
 * Builder resolve here too. The bundled `WORKFLOW_DEFS` is only a fallback for
 * when S3 is unreachable AND the id is one of the checked-in defs.
 *
 * Why this exists: /api/workflow/start used to resolve defs against the bundled
 * list only, silently falling back to `software-delivery` for any S3-only routine
 * def. That routed every chat-built routine through the 14-agent dev pipeline with
 * the wrong intake agent. This loader + a hard 400 on unknown ids is the fix.
 */

import { WORKFLOW_DEFS, lintWorkflowDefShape, type WorkflowDef } from "@/lib/workflow/workflow-defs";

const REGION = process.env.AWS_REGION || "us-east-1";
const ARTIFACT_BUCKET = process.env.ARTIFACT_BUCKET || "";

// Short-lived cache so a burst of starts doesn't hammer S3, while still picking up
// newly-created defs within seconds (mirrors the orchestrator's cold-start reload
// contract — acceptable staleness).
const TTL_MS = 15_000;
let _cache: { defs: WorkflowDef[]; at: number } | null = null;

/** Merge bundled + S3 defs, S3 winning on id collision. This keeps newly-shipped
 *  built-in defs (present in the app build but not yet re-synced to S3) resolvable,
 *  while still surfacing S3-only routine defs. */
function merge(s3Defs: WorkflowDef[]): WorkflowDef[] {
  const byId = new Map<string, WorkflowDef>();
  for (const d of WORKFLOW_DEFS) byId.set(d.id, d);
  for (const d of s3Defs) if (d?.id) byId.set(d.id, d); // S3 overrides bundled
  return [...byId.values()];
}

export async function loadWorkflowDefs(): Promise<WorkflowDef[]> {
  const now = Date.now();
  if (_cache && now - _cache.at < TTL_MS) return _cache.defs;

  // Resolve the def set: live S3 (merged over bundled) when reachable, else the
  // bundled defs. ONLY the S3-fetch failure falls back here — the honesty lint
  // below is deliberately OUTSIDE this catch so a dishonest ship gate throws
  // instead of being swallowed into a silent bundled fallback.
  let defs: WorkflowDef[];
  // Only a successful S3 load is cached. The fetch-FAILURE fallback stays
  // UNCACHED (as before this change) so the next call retries S3 rather than
  // serving bundled for the whole TTL after one transient blip.
  let cacheable = true;
  if (!ARTIFACT_BUCKET) {
    defs = WORKFLOW_DEFS;
  } else {
    try {
      const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
      const s3 = new S3Client({ region: REGION });
      const obj = await s3.send(
        new GetObjectCommand({ Bucket: ARTIFACT_BUCKET, Key: "config/workflows.json" })
      );
      const doc = JSON.parse(await obj.Body!.transformToString());
      const s3Defs: WorkflowDef[] = Array.isArray(doc) ? doc : doc.workflows || [];
      defs = merge(s3Defs);
    } catch {
      // S3 unavailable → bundled defs so checked-in workflows still resolve.
      // S3-only routine defs will be absent → the caller 400s (correct).
      defs = WORKFLOW_DEFS;
      cacheable = false;
    }
  }

  // Load-time honesty lint (repo-agnostic, D3a). Applies to EVERY def — bundled
  // and S3-only alike — so a checked-in OR routine-authored dishonest ship gate
  // fails loudly at load. Throws; not caught by the fetch fallback above.
  for (const d of defs) lintWorkflowDefShape(d);

  if (cacheable) _cache = { defs, at: now };
  return defs;
}

/** Resolve one def by id from the live (S3) set. Returns null for unknown ids —
 *  callers MUST treat null as a hard error, never fall back to a default def. */
export async function resolveWorkflowDef(id?: string | null): Promise<WorkflowDef | null> {
  if (!id) return null;
  const defs = await loadWorkflowDefs();
  return defs.find((w) => w.id === id) || null;
}
