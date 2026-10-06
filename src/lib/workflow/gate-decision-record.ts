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
