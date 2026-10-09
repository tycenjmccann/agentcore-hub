#!/usr/bin/env node
/**
 * deploy/continuous-improvement/backfill-daily.mjs — RETIRED (TEAM-4688).
 *
 * This script rebuilt the agentcore-hub-eval-daily buckets from CloudWatch Logs
 * Insights with its OWN copy of the parsing rules — a second implementation that
 * drifted from lambda/token-aggregator and lambda/eval-packager, had no dedup and
 * OVERWROTE day items (so a re-run raced the live Lambdas). Backfill now runs
 * through the eval-packager's `reconcile` mode, which is the same code path the
 * live ingest uses and dedupes with conditional writes.
 *
 * Kept as a stub so an old runbook line fails loudly instead of silently doing
 * the wrong thing.
 */

console.error(`backfill-daily.mjs is retired (TEAM-4688).

Use the eval-packager's reconcile mode instead:

  node deploy/continuous-improvement/backfill-results.mjs --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run]

or invoke the packager directly:

  aws lambda invoke --function-name agentcore-hub-eval-packager \\
    --payload '{"mode":"reconcile","days":2}' --cli-binary-format raw-in-base64-out /dev/stdout

The same reconcile runs daily on the agentcore-hub-eval-reconcile EventBridge
rule, so a dropped subscription delivery self-heals within 24h.`);
process.exit(1);
