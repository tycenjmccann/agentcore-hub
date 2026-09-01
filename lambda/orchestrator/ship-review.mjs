/**
 * Ship-review convergence arithmetic — the orchestrator (Lambda) port of
 * src/lib/workflow/ship-review.ts.
 *
 * TEAM-3619 D2c. The orchestrator is plain .mjs with no build step, so it
 * cannot import the TS module the web app and the blueprint contract share.
 * This is a HAND PORT and must agree with the TS original bit-for-bit — a
 * drift means the orchestrator's cap enforcement and the release manager's own
 * round accounting disagree about when the loop is over, which is exactly the
 * runaway-rework bug the cap closes.
 *
 * Same hand-port pattern (and same obligation) as lease.mjs ↔ lease.ts from
 * TEAM-3618; parity is asserted by src/lib/workflow/ship-review-parity.test.ts,
 * which feeds identical fixtures through both copies.
 *
 * Keep the two files' comments and structure aligned too — the next person to
 * change the arithmetic needs to see immediately that there is a twin.
 */

/**
 * Effective ship-review round count. Pure; input order-insensitive.
 *
 * Tolerant of malformed ledger entries (written by an LLM, not this code):
 * a missing/non-array `findings`, or non-object finding entries, are treated
 * as a plain round rather than throwing. Ledgers may also contain duplicate
 * round numbers if a caller wrote an entry without going through mergeRound;
 * rounds are deduped by round number (last entry per round wins) before
 * filtering/reducing.
 *
 * `opts.regressionCountsDouble` mirrors the gate config field of the same
 * name: true (the default) weighs a regression round 2, false weighs every
 * CHANGES-NEEDED round 1 regardless of regressions.
 */
export function effectiveRoundCount(rounds, authorizations = [], opts = {}) {
  const regressionCountsDouble = opts.regressionCountsDouble ?? true;
  const lastReset = Math.max(
    0,
    ...authorizations.filter((a) => a.decision === "continue").map((a) => a.resetAtRound)
  );
  const dedupedByRound = new Map();
  for (const r of rounds) dedupedByRound.set(r.round, r);
  return [...dedupedByRound.values()]
    .filter((r) => r.round > lastReset && r.verdict === "CHANGES-NEEDED")
    .reduce(
      (n, r) =>
        n +
        (regressionCountsDouble &&
        Array.isArray(r.findings) &&
        r.findings.some((f) => f?.regressionOf != null)
          ? 2
          : 1),
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
export function mergeRound(rounds, entry) {
  const i = rounds.findIndex((r) => r.round === entry.round);
  if (i === -1) return [...rounds, entry];
  const next = rounds.slice();
  next[i] = entry; // re-run of the same round: overwrite in place
  return next;
}
