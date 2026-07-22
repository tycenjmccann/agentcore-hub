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
