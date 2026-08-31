// Canonical executable spec of the ship-review convergence arithmetic.
//
// blueprints/release-manager.md Step 4 carries the IDENTICAL rules in prose.
// These two are a matched pair: a change to the convergence arithmetic here
// MUST be mirrored in that blueprint, and vice versa. If they drift, the
// release manager's behavior and this spec disagree — do not change one
// without updating the other.

export interface ShipRoundLike {
  round: number;
  verdict: "CHANGES-NEEDED" | "PASS" | "PASS-with-known-findings";
  findings: Array<{ regressionOf: Record<string, unknown> | null }>;
}
export interface AuthorizationLike {
  decision: "continue" | "merge-with-known-findings" | "cancel";
  resetAtRound: number;
}

/** Effective ship-review round count. Pure; input order-insensitive. */
export function effectiveRoundCount(
  rounds: ShipRoundLike[],
  authorizations: AuthorizationLike[] = []
): number {
  const lastReset = Math.max(
    0,
    ...authorizations.filter(a => a.decision === "continue").map(a => a.resetAtRound)
  );
  return rounds
    .filter(r => r.round > lastReset && r.verdict === "CHANGES-NEEDED")
    .reduce((n, r) => n + (r.findings.some(f => f.regressionOf !== null) ? 2 : 1), 0);
}

/** Idempotent round merge keyed by (round, reviewedHeadSha). */
export function mergeRound<T extends { round: number; reviewedHeadSha: string }>(
  rounds: T[], entry: T
): T[] {
  const i = rounds.findIndex(r => r.round === entry.round);
  if (i === -1) return [...rounds, entry];
  const next = rounds.slice();
  next[i] = entry; // same round: overwrite (same SHA = re-run; new SHA = supersede)
  return next;
}
