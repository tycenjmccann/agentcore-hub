/**
 * The closeout override record (TEAM-5358 FR-2, F1) — how a human lets a refused
 * run complete over named offenders.
 *
 * Location and field names are the ones TEAM-5359 shipped: `{by, reason, offenders, at}`
 * at `workflows/<id>/shared/closeout-override.json`. The hub adds a signature on top:
 * `v`, `kind`, `workflowId`, `offenderSetHash` and `sig` = HMAC (gate-decision key)
 * of canonicalJson(record minus sig). Every reader accepts only a record that verifies
 * (TEAM-5367 / DL-036: the orchestrator and cost-report through
 * lambda/orchestrator/proof-record-verify.mjs, pinned by closeout-override-parity.test.ts);
 * anything unverifiable is treated as absent, i.e. no override.
 */

import { createHash } from "node:crypto";
import { canonicalJson, signVerifyRecord, verifyRecordSig } from "./decision-contract";
import { parseCloseoutOverride, type CloseoutOverride } from "./performance";

export const CLOSEOUT_OVERRIDE_VERSION = 1;
export const CLOSEOUT_OVERRIDE_KIND = "closeout-override";
export const CLOSEOUT_OVERRIDE_REASON_MAX = 1000;

export function CLOSEOUT_OVERRIDE_KEY(workflowId: string): string {
  return `workflows/${workflowId}/shared/closeout-override.json`;
}

export type CloseoutOverrideRecord = CloseoutOverride & {
  v: typeof CLOSEOUT_OVERRIDE_VERSION;
  kind: typeof CLOSEOUT_OVERRIDE_KIND;
  workflowId: string;
  offenderSetHash: string;
  sig: string;
};

/** Offender ids as recorded: strings, de-duplicated, sorted. */
function normalizeOffenders(offenders: readonly unknown[]): string[] {
  return [...new Set(offenders.map((o) => String(o)))].sort();
}

export function offenderSetHash(offenders: readonly unknown[]): string {
  return createHash("sha256").update(canonicalJson(normalizeOffenders(offenders))).digest("hex");
}

/**
 * Build and sign a record. `by` must be the server-verified identity, never a body
 * field. Throws when the key is missing or the reason is empty.
 */
export function buildCloseoutOverride(
  input: { workflowId: string; by: string; reason: string; offenders: readonly unknown[]; at?: string },
  key: string
): CloseoutOverrideRecord {
  const reason = String(input.reason ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, CLOSEOUT_OVERRIDE_REASON_MAX);
  if (!reason) throw new Error("closeout override needs a reason");
  if (!input.by || !input.workflowId) throw new Error("closeout override needs by and workflowId");
  const offenders = normalizeOffenders(input.offenders);
  const unsigned = {
    by: input.by,
    reason,
    offenders,
    at: input.at || new Date().toISOString(),
    v: CLOSEOUT_OVERRIDE_VERSION,
    kind: CLOSEOUT_OVERRIDE_KIND,
    workflowId: input.workflowId,
    offenderSetHash: offenderSetHash(offenders),
  } as const;
  return { ...unsigned, sig: signVerifyRecord([canonicalJson(unsigned)], key) };
}

/**
 * The override for `workflowId` as the shared readers parse it, or null when `raw`
 * is absent, unparseable, unsigned, signed with another key, edited after signing,
 * or written for another run. Never throws.
 */
export function verifyCloseoutOverride(
  raw: string | null | undefined,
  keys: readonly string[] | null | undefined,
  workflowId: string
): (CloseoutOverride & { offenderSetHash: string }) | null {
  const parsed = parseCloseoutOverride(raw);
  if (!parsed) return null;
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(raw as string) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (r.v !== CLOSEOUT_OVERRIDE_VERSION || r.kind !== CLOSEOUT_OVERRIDE_KIND || r.workflowId !== workflowId) return null;
  if (r.offenderSetHash !== offenderSetHash(parsed.offenders)) return null;
  const { sig, ...rest } = r;
  if (!verifyRecordSig([canonicalJson(rest)], sig, keys)) return null;
  return { ...parsed, offenderSetHash: r.offenderSetHash as string };
}

/**
 * The override names EXACTLY `offenderIds` (TEAM-5367 / DL-036): equality on
 * offenderSetHash, order and duplicates ignored. A superset or subset override is
 * stale: the offender set changed since a human signed it. PARITY with
 * proof-record-verify.mjs closeoutOverrideMatches.
 */
export function closeoutOverrideMatches(override: { offenderSetHash?: unknown } | null | undefined, offenderIds: readonly unknown[]): boolean {
  return Boolean(override) && override!.offenderSetHash === offenderSetHash(offenderIds);
}
