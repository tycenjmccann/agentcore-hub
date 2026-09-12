/**
 * Is this run's cost unknown? (TEAM-4515 D-3)
 *
 * The hero KPI strip and the full performance card sit one above the other on a
 * terminal run, so they must answer this the SAME way: a strip reading
 * "$0 · no usage data" over a card reading "$0.00" contradicts itself, and the
 * card's number is the one that looks like a real bill.
 *
 * Three ways a card says cost was not measured:
 *  - `dataQuality.costMissing` — the Lambda said so outright;
 *  - a v5 `kpi.cost.usd === null` — the scorer nulled it (performance.ts computeKpi);
 *  - a v4 card has neither, so fall back to the test the lib and the Lambda use:
 *    a $0 total means the spans did not match, not a free run (hasCostData / NFR-5).
 */

import type { RunCard } from "./use-performance-card";

/**
 * The one permitted hand-written cost literal, shared by both surfaces.
 * formatKpi("usd", 0) is "$0.00" — a precise, real-looking bill — and
 * formatKpi("usd", null) is "—", which loses the fact that we KNOW spend was not
 * measured. Both surfaces read "$0 · no usage data" instead.
 */
export const COST_MISSING_VALUE = "$0";

export function isCostMissing(card: RunCard): boolean {
  const kpi = card.kpi;
  return (
    card.dataQuality?.costMissing === true ||
    (kpi ? kpi.cost.usd === null : !((card.cost?.totalUsd ?? 0) > 0))
  );
}
