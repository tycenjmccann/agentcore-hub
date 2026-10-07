/**
 * TEAM-5347 F4 — the hub's TypeScript mirror of the gate-label grammar in
 * `lambda/orchestrator/fix-contract.mjs` (GATE_KINDS, GATE_LABEL_RE, labelList,
 * gateKindsOf, isTypedGate). The four .mjs copies are byte-compared by
 * scripts/check-fix-kinds-parity.sh and cannot be imported by a Next route (lambda/
 * is not part of the app), so the hub carries this mirror the way it carries
 * decision-contract.ts for decision-contract.mjs. Parity with every copy is pinned
 * by src/lib/workflow/fix-contract-parity.test.ts: a drift here is a webhook that
 * waves through a gate kind the twins would probe.
 *
 * A gate is TYPED when it carries a GATE_KINDS label in either spelling (`gate:x`,
 * or `gate-x` after sanitizeUserLabels). A typed gate closes only on external
 * evidence the ticket twins verify, so nothing in the hub may treat it as "binds no
 * requirement" just because it declares no DECISION OPTIONS. Every other
 * `gate:<slug>` (Merge Approval included) is an ordinary review gate.
 */

export const GATE_KINDS = [
  "approval",
  "deploy-approval",
  "blocker",
  "ci-unavailable",
  "awaiting-console",
  "loop-broken",
] as const;

export type GateKind = (typeof GATE_KINDS)[number];

export const GATE_LABEL_RE =
  /^gate[:-](approval|deploy-approval|blocker|ci-unavailable|awaiting-console|loop-broken)$/;

/**
 * A ticket's labels as a normalized list: an array or a comma-joined string in;
 * trimmed, lowercased, blanks dropped out.
 */
export function labelList(labels: unknown): string[] {
  const list: unknown[] = Array.isArray(labels) ? labels : typeof labels === "string" ? labels.split(",") : [];
  return list.map((l) => String(l ?? "").trim().toLowerCase()).filter(Boolean);
}

/** The gate kinds a label list carries, deduped, in GATE_KINDS order. */
export function gateKindsOf(labels: unknown): GateKind[] {
  const found = new Set<string>();
  for (const l of labelList(labels)) {
    const m = GATE_LABEL_RE.exec(l);
    if (m) found.add(m[1]);
  }
  return GATE_KINDS.filter((k) => found.has(k));
}

/** The ONE typed-gate rule (TEAM-5336 F4): a GATE_KINDS label in either spelling. */
export function isTypedGate(labels: unknown): boolean {
  return gateKindsOf(labels).length > 0;
}
