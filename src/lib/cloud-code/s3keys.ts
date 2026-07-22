/**
 * Cloud Code — S3 key layout (single source of truth).
 *
 * Every object lives under a per-tenant prefix so a future per-tenant IAM role
 * can be scoped to `…/cloud-code/t/<tenantId>/*` — a tenant's compute then
 * physically cannot read another tenant's bytes even if a key leaked. The prefix
 * is the thing that makes that policy expressible.
 *
 *   cloud-code/t/<tenantId>/configs/<userId>/<version>.zip   — CLI config bundle
 *   cloud-code/t/<tenantId>/resume/<sessionId>/<cid>.jsonl   — ported transcript
 *   cloud-code/t/<tenantId>/checkpoint/<sid>/<sid>.jsonl     — pulled-home transcript
 *
 * Backward-compat: the "default" tenant (AUTH_MODE=none, the pre-tenant single
 * user) keeps the LEGACY unprefixed layout (`cloud-code/configs/...`), so every
 * object written before tenancy still resolves with zero migration. Real tenants
 * get the `t/<tenantId>/` prefix.
 *
 * The runtime (deploy/coding-agent-runtime/main.py) rebuilds the config +
 * checkpoint keys from tenant_id; keep its `_tenant_root` in sync with this.
 */

import { DEFAULT_TENANT_ID } from "@/lib/auth/identity";

/** Per-tenant root. `default` → legacy unprefixed path (no migration). */
export function tenantRoot(tenantId: string = DEFAULT_TENANT_ID): string {
  return tenantId === DEFAULT_TENANT_ID ? "cloud-code" : `cloud-code/t/${tenantId}`;
}

export function configKey(tenantId: string, userId: string, version: string): string {
  return `${tenantRoot(tenantId)}/configs/${userId}/${version}.zip`;
}

export function resumeTranscriptKey(
  tenantId: string,
  sessionId: string,
  claudeSessionId: string
): string {
  return `${tenantRoot(tenantId)}/resume/${sessionId}/${claudeSessionId}.jsonl`;
}

/** Prefix a session's artifacts (touched-but-untracked deliverables — generated
 *  media, exports, datasets — plus files the user uploads) live under. Keyed by
 *  the cloud sessionId; the port/upload leg writes here and the runtime restores
 *  it into the workspace's .cloud-code/artifacts/ on warm. */
export function artifactPrefix(tenantId: string, sessionId: string): string {
  return `${tenantRoot(tenantId)}/resume/${sessionId}/artifacts/`;
}

/** S3 key for one artifact by its workspace-relative path. `rel` MUST be
 *  validated with safeRelPath (no leading slash, no `..`) before this is called. */
export function artifactKey(tenantId: string, sessionId: string, rel: string): string {
  return `${artifactPrefix(tenantId, sessionId)}${rel}`;
}

/** Prefix cloud-generated artifacts land under at checkpoint time (the runtime's
 *  _checkpoint_artifacts uploads here). Keyed by the conversation's RESUME id (the
 *  transcript filename id) — what the runtime checkpoints under, not the sessionId.
 *  Distinct from the resume/upload prefix, so the web listing reads both. */
export function checkpointArtifactPrefix(tenantId: string, resumeId: string): string {
  return `${tenantRoot(tenantId)}/checkpoint/${resumeId}/artifacts/`;
}

/** Validate an artifact's workspace-relative path: reject absolute paths and any
 *  `..` traversal so a malicious/buggy path can't write outside the session's
 *  artifact prefix. Returns a POSIX rel path, or null if unsafe. */
export function safeRelPath(rel: string): string | null {
  if (typeof rel !== "string" || !rel) return null;
  const norm = rel.replace(/\\/g, "/");
  if (norm.startsWith("/")) return null;
  if (norm.split("/").some((seg) => seg === ".." || seg === "")) return null;
  return norm;
}
