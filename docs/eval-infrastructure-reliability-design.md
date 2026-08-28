# Eval Infrastructure Reliability — Design

Design record for the eval ingest path (`lambda/eval-packager/index.mjs`) and the
telemetry it depends on. Companion to the operator runbooks in
[`orchestration-tracing-guide.md`](./orchestration-tracing-guide.md) (judge-quota
change, eval health dashboard/alarm): this file records the *decisions*, that one
records the *procedures*.

Implementation history: TEAM-3366 (analysis), TEAM-3367 (anchor span, dedup,
improver retry), TEAM-3368 (dep-chain role scoping, eval health metrics),
TEAM-3381 (cross-delivery dedup at flush, dedup fail-open), TEAM-3376
(cross-invocation DynamoDB seen-set), TEAM-3385 (seen-set infrastructure —
table creation, TTL, IAM, env wiring — and the check-then-claim redesign).

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
| DDB rolling aggregates | duplicates within one delivery *and* across deliveries/concurrent invocations — the cross-delivery seen-set check runs before aggregation | in-memory `dedupeResults`, then `checkSeenSet` ahead of `aggregateScoresToDdb` (TEAM-3376 / TEAM-3385) |

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

**Decision rule for the cross-invocation seen-set — SUPERSEDED BY
IMPLEMENTATION.** The seen-set is now shipped: TEAM-3376 built it, TEAM-3385
added the infrastructure that made it live (table creation, TTL, IAM grants,
`EVAL_SEEN_TABLE` env wiring) and redesigned the write pattern. The decision was
made ahead of the 1-week measurement this section originally called for.

The shipped design (`checkSeenSet` / `claimSeenSet` in
`lambda/eval-packager/index.mjs`):

- table `agentcore-hub-eval-seen` (env `EVAL_SEEN_TABLE`; `''` disables), PK
  `dedupKey` (S), PAY_PER_REQUEST — created by
  `deploy/continuous-improvement/deploy-all.sh`, IAM in
  `deploy/setup-lambda-role.sh`, env set by
  `deploy/continuous-improvement/deploy.sh`;
- **two phases, not the single conditional-write probe originally planned.**
  The planned "condition failure *is* the duplicate signal" write claimed keys
  before anything was durable: if the buffer append then threw, the CW Logs
  re-delivery found its own keys claimed and every row was dropped for good
  (TEAM-3385 finding 2). Instead:
  - `checkSeenSet` — read-only `BatchGetItem` (100 distinct keys per request),
    run before classification, aggregation and buffering. A hit is a duplicate
    unless the incoming row is `scored` and the stored claim is anything but
    `scored` — a success supersedes every non-`scored` claim (`error`, `other`,
    or a legacy item with no `outcome` attribute at all) for the same attempt,
    mirroring `OUTCOME_RANK` (`scored` > `other` > `error`)
    (`lambda/eval-packager/index.mjs:805-813`). TEAM-3385 finding 3 established
    the original scored-beats-error rule; TEAM-3406 (F2) widened it from
    error-only to all non-scored claims, since a pending row or a sampled-out
    delivery also claims its keys with `other`, and under the old rule a later
    scored row for the same attempt was dropped as a duplicate instead of
    superseding it. Drops are filtered out of `evaluatorResults` and added to
    `duplicatesDropped`.
  - `claimSeenSet` — per-key conditional `PutItem`
    (`attribute_not_exists(dedupKey)` for a non-`scored` claim; a `scored`
    claim instead uses `attribute_not_exists(dedupKey) OR
    attribute_not_exists(#outcome) OR #outcome <> :scored`, so it may overwrite
    any existing non-`scored` claim — including a legacy claim with no
    `outcome` attribute, since DynamoDB treats a comparison against a missing
    attribute as false — `lambda/eval-packager/index.mjs:894-902`), storing
    `{dedupKey, expiresAt, outcome}`, run only after the delivery is durably
    buffered (or finally discarded by the sample-rate gate);
- TTL 24h on `expiresAt` (a duplicate arriving later than that is not a
  delivery artifact);
- **fail-open**, as originally specified: table unset/missing, SDK unavailable,
  any DDB error, or `UnprocessedKeys` → the record is retained and treated as
  fresh. Losing eval signal is worse than double-counting it.

*Historical record:* the original rule was "do not build the DDB seen-set on
suspicion — measure for 1 week with the verification query below; if more than
**1%** of evaluator-result records fall into cross-delivery duplicate groups,
implement it." The queries below remain useful for monitoring (see the
"Monitoring query" section).

### AC-2 DDB-aggregate disposition (TEAM-3381, closed by TEAM-3376/TEAM-3385)

*Superseded by implementation — this was recorded as a deferred gap when
TEAM-3381 shipped; the seen-set has since closed it.* TEAM-3381 fixed the
flushed batch payload only, and at that point the DDB rolling aggregates could
still double-count a duplicate that spanned two deliveries. At head,
`checkSeenSet` runs before `aggregateScoresToDdb` (step 5 of the handler), so
cross-delivery and concurrent-invocation duplicates are dropped before they can
reach the rolling aggregates. Two residual, deliberate exposures remain, both
fail-open by design (see the handler comments at the `aggregateScoresToDdb`
call site):

- the aggregates run *before* `claimSeenSet`, so if the buffer append throws,
  the re-delivery re-counts those rows — an over-count in a rolling aggregate
  is recoverable where a dropped evaluation is not (TEAM-3385 finding 2);
- two genuinely concurrent invocations can both pass the check before either
  claims, so both may count a copy.

**What `EvalDuplicateResultCount` now measures.** Seen-set drops feed
`duplicatesDropped`, so the metric counts drops from *both* dedup layers: the
in-memory `dedupeResults` pass (within one delivery) and the `checkSeenSet`
pass (across deliveries and concurrent invocations). A delivery whose every row
is a cross-delivery duplicate still emits the metric (the handler emits when
`duplicatesDropped > 0` even at `total = 0`). The earlier statement that this
metric "cannot measure" cross-delivery duplicates described the pre-seen-set
implementation and no longer holds. Caveat: because the seen-set fails open, a
zero series means "no duplicates *detected*" — to independently verify the
seen-set itself is working, use the Logs Insights query below grouped by
`logStream`.

Corroborating signal: the **`crossDeliveryDuplicatesDropped` field** on the
`eval.batch.cross_delivery_duplicates_dropped` warn line and in the archived
batch payload (TEAM-3381). The flush-time `dedupeBufferedSessions` pass remains
as defense-in-depth for the batch payload; it also catches records the
seen-set failed open on within one flush window.

**Monitoring query** (Logs Insights, one eval results log group at a time, or
all of them via the log-group prefix; window: 1 week). Originally the
measurement that would have triggered the seen-set decision; still useful to
verify the seen-set is doing its job — duplicate groups found here should show
up as `EvalDuplicateResultCount` drops, not as inflated aggregates:

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

Then compute the cross-delivery duplicate ratio — duplicate records over all
evaluator-result records, same window (this is the ratio the original 1%
decision rule was stated against; today it sizes how hard the seen-set is
working):

```
fields coalesce(concat(traceId, ':', spanId),
                attributes.`aws.request_id`,
                attributes.`gen_ai.response.id`) as dedupKey,
       attributes.`gen_ai.evaluation.name` as evaluator
| filter ispresent(evaluator)
| stats count(*) as copies by dedupKey, evaluator
| stats sum(copies) as totalRecords, sum(copies - 1) as duplicateRecords
```

These queries measure duplicates in the *log groups*, upstream of the packager
— the seen-set does not change what they return. A high ratio here with a flat
`EvalDuplicateResultCount` series is the signal that the seen-set is failing
open (check the `seen-set check failed open` / `seen-set claim failed open`
warn lines in the packager logs).

**Records with no dedup key are out of scope of this measurement** — they are
retained by design (fail-open, AC-1) and `ispresent(dedupKey)` excludes them
from the duplicate-group query.
