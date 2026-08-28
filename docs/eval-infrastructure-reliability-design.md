# Eval Infrastructure Reliability — Design

Design record for the eval ingest path (`lambda/eval-packager/index.mjs`) and the
telemetry it depends on. Companion to the operator runbooks in
[`orchestration-tracing-guide.md`](./orchestration-tracing-guide.md) (judge-quota
change, eval health dashboard/alarm): this file records the *decisions*, that one
records the *procedures*.

Implementation history: TEAM-3366 (analysis), TEAM-3367 (anchor span, dedup,
improver retry), TEAM-3368 (dep-chain role scoping, eval health metrics),
TEAM-3381 (cross-delivery dedup at flush, dedup fail-open).

---

## §2.2 Duplicate evaluator results

**Problem.** CloudWatch Logs subscription delivery is at-least-once, and the
evaluations service itself retries a judge call. Either way the SAME evaluation
attempt can reach the packager more than once and double-count downstream: the
rolling DDB scorecard (`evalScores`, `evalSessionCount`, `evalStatusCounts`), the
per-session classification, and the batch payload the Fleet Improver synthesizes
a PRD from.

**Dedup key**, ranked (`extractRequestId`, fallback chain because live
verification of which identifier production carries was IAM-blocked):

1. the OTEL log-record envelope `traceId` + `spanId` — copies of one evaluation
   attempt share the evaluated span's ids;
2. `attributes['aws.request_id']`;
3. `attributes['gen_ai.response.id']`;
4. no identifier → a content key
   (`sessionId | evaluatorName | evaluationName | score | timestamp |
   contentFingerprint(rawMessage)`).

**Shipped scope.**

| Consumer | Protected against | Where |
|---|---|---|
| Per-delivery rows (classification, EMF metrics, buffered entry) | duplicates *within* one delivery | `dedupeResults` via `extractSessionData` |
| Flushed batch payload + batch summary (what the improver reads) | duplicates *across* every delivery in the flush buffer | `dedupeBufferedSessions` in `flushBuffer` (TEAM-3381) |
| DDB rolling aggregates | duplicates within one delivery only — **cross-delivery gap remains, deferred** | see the disposition below |

**Fail-open rule (AC-1).** Dedup must never cost a record it cannot prove is a
duplicate. Two consequences, both load-bearing:

- A record with no identifier *and* no content-key discriminator (`sessionId`,
  `evaluatorName`, `evaluationName`, `score` all null/absent) is **always
  retained** and never counted as a duplicate — `hasNoDedupKey`. `timestamp` is
  `logEvent.timestamp`, i.e. per-delivery-millisecond and not unique per record,
  so keying such rows would silently destroy distinct results.
- The content key includes a 16-hex-char SHA-256 fingerprint of the raw message
  (`contentFingerprint`), so two distinct results that share metadata *and* the
  same millisecond stay apart, while a genuine retry write — identical bytes —
  still collapses.

**Decision rule for the cross-invocation seen-set.** Do not build the DDB
seen-set on suspicion. Measure for 1 week with the verification query below; if
more than **1%** of evaluator-result records fall into cross-delivery duplicate
groups, implement it:

- table `agentcore-hub-eval-seen`, PK `dedupKey`;
- conditional write, `ConditionExpression: attribute_not_exists(dedupKey)` — the
  condition failure *is* the duplicate signal;
- TTL 24h (a duplicate arriving later than that is not a delivery artifact);
- **fail-open**: any seen-set error (throttle, timeout, IAM) retains the record.
  Losing eval signal is worse than double-counting it.

### AC-2 DDB-aggregate deferral disposition (TEAM-3381)

TEAM-3381 fixed the flushed batch payload only. **The DDB rolling aggregates can
still double-count a duplicate that spans two deliveries**, because
`aggregateScoresToDdb` runs once per delivery on per-delivery-deduped rows
(`lambda/eval-packager/index.mjs`, step 5 of the handler, where this is also
flagged in-code). This is a known, accepted gap, deferred per the §2.2 decision
rule above — not an oversight, and not fixed by the flush-time dedup.

**The `EvalDuplicateResultCount` metric CANNOT measure this gap.** It counts
`dedupeResults` drops *within a single delivery*; a duplicate split across two
deliveries produces two individually-clean deliveries and therefore **zero**
duplicate drops. A flat or zero `EvalDuplicateResultCount` series is *not*
evidence the gap is harmless.

The instruments that can observe it:

1. **Primary — the Logs Insights verification query below**, run over the eval
   results log groups (`/aws/bedrock-agentcore/evaluations/results/*`) after
   1 week, grouped by `logStream`.
2. **Corroborating — the `crossDeliveryDuplicatesDropped` field** on the
   `eval.batch.cross_delivery_duplicates_dropped` warn line and in the archived
   batch payload (TEAM-3381). It counts cross-delivery duplicates *within one
   flush window*, so it is a **lower bound** on the aggregate exposure: the DDB
   aggregates are exposed to duplicates across any two deliveries, including two
   that land in different flush windows.

**Verification query** (Logs Insights, one eval results log group at a time, or
all of them via the log-group prefix; window: 1 week):

```
fields @timestamp, @logStream as stream,
       coalesce(concat(traceId, ':', spanId),
                attributes.`aws.request_id`,
                attributes.`gen_ai.response.id`) as dedupKey,
       attributes.`gen_ai.evaluation.name` as evaluator
| filter ispresent(dedupKey) and ispresent(evaluator)
| stats count(*) as copies,
        count_distinct(stream) as streams,
        earliest(@timestamp) as firstSeen,
        latest(@timestamp) as lastSeen
      by dedupKey, evaluator
| filter copies > 1
| sort copies desc
```

Read it as: each row is a duplicate group; `streams > 1` (or `lastSeen` far from
`firstSeen`) means the copies could not have shared one delivery, i.e. exactly
the case the per-delivery dedup misses.

Then compute the ratio the 1% rule is stated against — duplicate records over
all evaluator-result records, same window:

```
fields coalesce(concat(traceId, ':', spanId),
                attributes.`aws.request_id`,
                attributes.`gen_ai.response.id`) as dedupKey,
       attributes.`gen_ai.evaluation.name` as evaluator
| filter ispresent(evaluator)
| stats count(*) as copies by dedupKey, evaluator
| stats sum(copies) as totalRecords, sum(copies - 1) as duplicateRecords
```

`duplicateRecords / totalRecords > 0.01` → build the seen-set described above.
At or below 1%, re-record the measurement here and leave the gap deferred; the
flushed batch (what actually drives PRD synthesis) is already protected.

**Records with no dedup key are out of scope of this measurement** — they are
retained by design (fail-open, AC-1) and `ispresent(dedupKey)` excludes them
from the duplicate-group query.
