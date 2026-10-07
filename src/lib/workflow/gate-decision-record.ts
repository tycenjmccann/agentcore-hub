/**
 * The gate decision record, read side (TEAM-5358 FR-6, F10) — TS port of
 * verifyGateDecisionRecord in lambda/agentcore-hub-tickets/gate-contract.mjs.
 *
 * A twin writes one to `pipeline-artifacts/gate-decisions/<wf>/gates/<ticket>.json` for every
 * decided human gate. The hub routes (/complete, cancel, stop) read it to tell a
 * gate a human closed (`done`) or stopped (`cancelled`) from one an agent moved.
 * Only v3 is accepted here: the hub reads records the twins write from now on, and
 * a v2 record can never say `cancelled`. The .mjs still verifies v2 for the
 * residual-acceptance reader. gate-contract-parity.test.ts cross-verifies a record
 * the .mjs builds against this function.
 */

import { canonicalJson, verifyRecordSig } from "./decision-contract";
import { parseGateScope, type GateScope } from "./decision-grammar";

export const GATE_DECISION_RECORD_VERSION = 3;

/** Same key as gateDecisionRecordKey in the .mjs. */
export function gateDecisionRecordKey(workflowId: string, ticketId: string): string {
  return `pipeline-artifacts/gate-decisions/${workflowId}/gates/${ticketId}.json`;
}

export type GateDecisionRecordV3 = {
  v: 3;
  ticketId: string;
  workflowId: string;
  kind: "gate-decision";
  status: "done" | "cancelled";
  decision: { option: string; override: boolean; channel: string; by: string; note?: string };
  decidedAt: string;
  scope: { round: number; headSha: string; findingIds: string[] } | null;
  cycle: string | null;
  labels: string[];
  sig: string;
};

/** `stopped` cancels the gate; every other option closes it done. */
export function gateDecisionStatusOf(option: unknown): "done" | "cancelled" {
  return option === "stopped" ? "cancelled" : "done";
}

/**
 * True iff `record` is a v3 gate-decision record whose sig verifies (HMAC of
 * canonicalJson(record minus sig) under one of `keys`) and whose status is the
 * one its option implies. Never throws.
 */
export function verifyGateDecisionRecord(
  record: unknown,
  keys: readonly string[] | null | undefined
): record is GateDecisionRecordV3 {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  const r = record as Record<string, unknown>;
  if (r.kind !== "gate-decision" || r.v !== GATE_DECISION_RECORD_VERSION) return false;
  const decision = r.decision as Record<string, unknown> | null | undefined;
  if (!decision || typeof decision !== "object") return false;
  if (r.status !== gateDecisionStatusOf(decision.option)) return false;
  const { sig, ...rest } = r;
  return verifyRecordSig([canonicalJson(rest)], sig, keys);
}

// ─── Bound to the LIVE gate (TEAM-5367, DL-036) ────────────────────────────────
// PARITY with lambda/orchestrator/proof-record-verify.mjs (liveGateOf,
// gateDecisionStands); closeout-override-parity.test.ts runs both on one matrix.

/** The gate as get_issue reports it now. `cycle` undefined = the twin omitted `gateCycle` (unknown, never "never reset"). */
export type LiveGate = { ticketId: string; cycle: string | null | undefined; scope: GateScope | null };

/**
 * Either twin's Tickets___get_issue answer (raw bytes, text or object) → LiveGate,
 * or null when it is unreadable or a refusal.
 */
export function liveGateOf(payload: unknown): LiveGate | null {
  let p: unknown = payload;
  try {
    if (p instanceof Uint8Array) p = new TextDecoder().decode(p);
    if (typeof p === "string") p = JSON.parse(p || "null");
  } catch {
    return null;
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const r = p as Record<string, unknown>;
  const ticketId = r.key || r.ticketId;
  if (r.error || typeof ticketId !== "string" || !ticketId) return null;
  const fields = r.fields as Record<string, unknown> | undefined;
  const description = fields && typeof fields.description === "string" ? fields.description : r.description;
  return {
    ticketId,
    cycle: "gateCycle" in r ? ((r.gateCycle as string | null) ?? null) : undefined,
    scope: parseGateScope(typeof description === "string" ? description : null),
  };
}

export type GateDecisionVerdict =
  | { ok: true; record: GateDecisionRecordV3 }
  | { ok: false; why: "unverified" | "wrong_run" | "cycle_unknown" | "stale_cycle" | "scope_moved" };

/**
 * Does `record` stand for THIS run, THIS ticket and the gate as it is NOW? Its sig
 * verifies, it names both, it was signed in the gate's current decision cycle and
 * over the gate's current scope line. An unknown cycle refuses.
 */
export function gateDecisionStands(
  record: unknown,
  keys: readonly string[] | null | undefined,
  ctx: { workflowId: string; ticketId: string; live: LiveGate | null }
): GateDecisionVerdict {
  if (!verifyGateDecisionRecord(record, keys)) return { ok: false, why: "unverified" };
  if (!ctx.workflowId || record.workflowId !== ctx.workflowId || record.ticketId !== ctx.ticketId) return { ok: false, why: "wrong_run" };
  const live = ctx.live;
  if (!live || live.ticketId !== ctx.ticketId || live.cycle === undefined) return { ok: false, why: "cycle_unknown" };
  if ((live.cycle ?? null) !== (record.cycle ?? null)) return { ok: false, why: "stale_cycle" };
  if (canonicalJson(record.scope ?? null) !== canonicalJson(live.scope ?? null)) return { ok: false, why: "scope_moved" };
  return { ok: true, record };
}
