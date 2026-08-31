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
  // The ledger-authoring prose only instructs setting `regressionOf` on
  // regression findings — ordinary findings omit the key entirely, they
  // don't carry `regressionOf: null`. Treat both as "not a regression."
  findings?: Array<{ regressionOf?: Record<string, unknown> | null } | null>;
}
export interface AuthorizationLike {
  decision: "continue" | "merge-with-known-findings" | "cancel";
  resetAtRound: number;
}

/**
 * Effective ship-review round count. Pure; input order-insensitive.
 *
 * Tolerant of malformed ledger entries (written by an LLM, not this code):
 * a missing/non-array `findings`, or non-object finding entries, are treated
 * as a plain round rather than throwing. Ledgers may also contain duplicate
 * round numbers if a caller wrote an entry without going through mergeRound;
 * rounds are deduped by round number (last entry per round wins) before
 * filtering/reducing.
 */
export function effectiveRoundCount(
  rounds: ShipRoundLike[],
  authorizations: AuthorizationLike[] = []
): number {
  const lastReset = Math.max(
    0,
    ...authorizations.filter(a => a.decision === "continue").map(a => a.resetAtRound)
  );
  const dedupedByRound = new Map<number, ShipRoundLike>();
  for (const r of rounds) dedupedByRound.set(r.round, r);
  return [...dedupedByRound.values()]
    .filter(r => r.round > lastReset && r.verdict === "CHANGES-NEEDED")
    .reduce(
      (n, r) =>
        n + (Array.isArray(r.findings) && r.findings.some(f => f?.regressionOf != null) ? 2 : 1),
      0
    );
}

/**
 * Idempotent round merge keyed by round number (reviewedHeadSha is carried
 * on the entry but not part of the key). Under the blueprint numbering rule
 * (release-manager.md Step 4.1) a round number is reused only when
 * re-running the same head SHA, so overwriting the entry for an existing
 * round is always a re-run replace; a new SHA always arrives as a new round
 * number, never as a same-round overwrite.
 */
export function mergeRound<T extends { round: number; reviewedHeadSha: string }>(
  rounds: T[], entry: T
): T[] {
  const i = rounds.findIndex(r => r.round === entry.round);
  if (i === -1) return [...rounds, entry];
  const next = rounds.slice();
  next[i] = entry; // re-run of the same round: overwrite in place
  return next;
}
