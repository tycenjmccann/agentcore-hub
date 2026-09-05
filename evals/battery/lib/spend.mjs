// Live spend ceiling (B5). `maxRunUsd` used to be a post-hoc verdict check:
// the suite spent whatever it spent and only afterwards noticed it had blown
// the budget. Here the ledger is consulted BEFORE every Converse call and
// before every unstarted case, so total spend is bounded by roughly
// maxRunUsd + the turns already in flight when the ceiling is crossed.

import { usageCostUsd } from "./agent-runner.mjs";

export class SpendCeilingExceededError extends Error {
  constructor(message) {
    super(message);
    // Deliberately NOT a retryable transport error name (see
    // isRetryableTransportError) — a ceiling breach must never be retried.
    this.name = "SpendCeilingExceeded";
    this.spendCeiling = true;
  }
}

/**
 * @param {{ maxUsd: number, cost?: (tier: string, usage: any) => number }} args
 */
export function createSpendLedger({ maxUsd, cost = usageCostUsd }) {
  let spentUsd = 0;
  /** @type {string[]} */
  const abortedCaseIds = [];

  const ledger = {
    get maxUsd() {
      return maxUsd;
    },
    get spentUsd() {
      return spentUsd;
    },
    /** Ceiling semantics match the verdict rule: exactly maxUsd is fine. */
    get exceeded() {
      return typeof maxUsd === "number" && spentUsd > maxUsd;
    },
    get abortedCaseIds() {
      return [...abortedCaseIds];
    },
    /** Record usage from one Converse response; returns the new total. */
    add(tier, usage) {
      spentUsd += cost(tier, usage || {});
      return spentUsd;
    },
    /** Record a case that was aborted or never started because of the ceiling. */
    noteAborted(caseId) {
      if (caseId && !abortedCaseIds.includes(caseId)) abortedCaseIds.push(caseId);
    },
    message(what) {
      return (
        `run spend ceiling reached — estimated $${spentUsd.toFixed(2)} > maxRunUsd ` +
        `$${Number(maxUsd).toFixed(2)}; ${what}`
      );
    },
    /** Called before spending more on `caseId`; throws once the ceiling is up. */
    assertWithinCeiling(caseId) {
      if (!ledger.exceeded) return;
      ledger.noteAborted(caseId);
      throw new SpendCeilingExceededError(ledger.message(`aborting case '${caseId}'`));
    },
    /**
     * Wrap a Converse transport so every response is metered and every call is
     * gated on the ceiling. `tier` keys into PRICING_PER_MTOK ('haiku' … or
     * 'judge').
     */
    meter(transport, tier, caseId) {
      return async (params, opts) => {
        ledger.assertWithinCeiling(caseId);
        const response = await transport(params, opts);
        ledger.add(tier, response?.usage);
        return response;
      };
    },
    /** Failure reasons for the suite verdict; empty when nothing was aborted. */
    failureReasons() {
      if (!ledger.exceeded) return [];
      const aborted = abortedCaseIds.length > 0 ? ` Aborted/unrun case(s): ${abortedCaseIds.join(", ")}.` : "";
      return [
        `FAIL: run spend ceiling exceeded — estimated $${spentUsd.toFixed(2)} > maxRunUsd ` +
          `$${Number(maxUsd).toFixed(2)}; remaining work was abandoned mid-suite.${aborted}`,
      ];
    },
  };
  return ledger;
}
