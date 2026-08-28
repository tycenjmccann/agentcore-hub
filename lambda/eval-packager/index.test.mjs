/**
 * lambda/eval-packager/index.test.mjs
 *
 * Integration tests for the eval-packager HANDLER — the wiring classify.test.mjs
 * can't reach. classify.test.mjs proves the classifiers are right in isolation;
 * these tests prove the Lambda actually calls them, on a real gzipped
 * CloudWatch Logs subscription payload, and that what comes out the other side
 * (EMF metric lines, the S3 batch archive, the PRD write) is what the alarms and
 * prd-submitter expect.
 *
 * Hermetic: every AWS client, the SigV4 signer and `https` are mocked, so there
 * is no network, no credentials and no IMDS probe. index.mjs throws at module
 * scope without ARTIFACTS_BUCKET, so the env is stubbed BEFORE the dynamic
 * `await import('./index.mjs')`.
 *
 * The two regressions these lock:
 *   - a session whose invoke_agent span never arrived must page exactly once,
 *     as a telemetry failure, not average into the score as a 0/10; and
 *   - a batch with no evidence in it (nothing scored, or everything failed) must
 *     NOT be handed to the improver, which would hallucinate quality findings
 *     out of a broken pipeline and open a PR against a phantom.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'zlib';
import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import { computeBatchSummary } from './lib/classify.mjs';

// vi.hoisted so the spies exist before the hoisted vi.mock factories run.
const { ddbSend, s3Send, httpsRequest } = vi.hoisted(() => ({
  ddbSend: vi.fn(),
  s3Send: vi.fn(),
  httpsRequest: vi.fn(),
}));

/** Commands are identified in the fake `send` by constructor name. */
class FakeCommand {
  constructor(input) {
    this.input = input;
  }
}

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class DynamoDBClient {},
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (cmd) => ddbSend(cmd) }) },
  GetCommand: class GetCommand extends FakeCommand {},
  UpdateCommand: class UpdateCommand extends FakeCommand {},
  PutCommand: class PutCommand extends FakeCommand {},
  // TEAM-3385: the seen-set CHECK phase reads with BatchGetItem.
  BatchGetCommand: class BatchGetCommand extends FakeCommand {},
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class S3Client {
    send(cmd) {
      return s3Send(cmd);
    }
  },
  GetObjectCommand: class GetObjectCommand extends FakeCommand {},
  PutObjectCommand: class PutObjectCommand extends FakeCommand {},
}));

// The improver invoke path: signed HTTPS to the AgentCore runtime. Mocked down
// to the socket so nothing resolves credentials or opens a connection.
vi.mock('@smithy/signature-v4', () => ({
  SignatureV4: class SignatureV4 {
    async sign(request) {
      return { ...request, headers: { ...request.headers, authorization: 'AWS4-HMAC-SHA256 test' } };
    }
  },
}));
vi.mock('@aws-crypto/sha256-js', () => ({ Sha256: class Sha256 {} }));
vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: () => async () => ({ accessKeyId: 'AKIATEST', secretAccessKey: 'shh' }),
}));
vi.mock('https', () => {
  const request = (...args) => httpsRequest(...args);
  return { default: { request }, request };
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

const AGENT_ID = 'agentcore_hub_backend_dev';
const EVAL_CONFIG_NAME = 'eval_backend_dev';
const LOG_GROUP = `/aws/bedrock-agentcore/evaluations/results/${EVAL_CONFIG_NAME}-FO0D1sFZfY`;
const AGENTS = [
  { agentId: AGENT_ID, evalConfigName: EVAL_CONFIG_NAME },
  { agentId: 'agentcore_hub_qa_verifier', evalConfigName: 'eval_qa_verifier' },
];
const IMPROVER_ARN = `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/agentcore_hub_fleet_improver-AbCdEf`;

/** The evaluator's real words when the invoke_agent span never reached it. */
const MISSING_SPAN_MESSAGE =
  'Evaluation failed because none of the spans contain the required agent invocation ' +
  '(gen_ai.operation.name=invoke_agent)';

/**
 * One eval result as the evaluator actually logs it: an OTEL log record whose
 * payload lives entirely in `attributes` under gen_ai.* keys. Reading
 * top-level .score/.evidence instead is what produced all-null batches.
 */
function evalRecord({ sessionId, evaluatorName = 'builtin.correctness', score, scoreLabel, errorType, errorMessage, requestId, extraAttrs }) {
  const attributes = { 'session.id': sessionId, 'gen_ai.evaluation.name': evaluatorName };
  if (requestId) attributes['aws.request_id'] = requestId;
  if (score !== undefined && score !== null) attributes['gen_ai.evaluation.score.value'] = score;
  if (scoreLabel) attributes['gen_ai.evaluation.score.label'] = scoreLabel;
  if (score !== undefined && score !== null) {
    attributes['gen_ai.evaluation.explanation'] = 'The agent addressed the ticket.';
  }
  if (errorType) attributes['error.type'] = errorType;
  if (errorMessage) attributes['error.message'] = errorMessage;
  if (extraAttrs) Object.assign(attributes, extraAttrs);
  return { severityText: errorType ? 'ERROR' : 'INFO', body: 'evaluation result', attributes };
}

/**
 * A real CloudWatch Logs subscription-filter payload: the JSON envelope,
 * gzipped, base64'd, under event.awslogs.data — byte-for-byte the shape the
 * handler is invoked with in production.
 */
function awslogsEvent(messages, logGroup = LOG_GROUP) {
  const envelope = {
    messageType: 'DATA_MESSAGE',
    owner: '123456789012',
    logGroup,
    logStream: '2026/08/27/[$LATEST]abcdef0123456789',
    subscriptionFilters: ['eval-to-packager'],
    logEvents: messages.map((message, i) => ({
      id: `3765${i}`,
      timestamp: 1_700_000_000_000 + i,
      message: typeof message === 'string' ? message : JSON.stringify(message),
    })),
  };
  return { awslogs: { data: gzipSync(Buffer.from(JSON.stringify(envelope))).toString('base64') } };
}

// ─── Mock state + log capture ───────────────────────────────────────────────

let ddbState;
let logSpy;
let warnSpy;
let errorSpy;

/** Every console.log argument that parsed as a JSON object (the structured lines). */
const jsonLogs = () =>
  logSpy.mock.calls
    .map((call) => call[0])
    .filter((arg) => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => {
      try {
        return JSON.parse(arg);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

/** Structured lines that publish `metricName` via EMF. */
const emfLines = (metricName) =>
  jsonLogs().filter((line) =>
    (line._aws?.CloudWatchMetrics || []).some((d) => (d.Metrics || []).some((m) => m.Name === metricName))
  );

/** All plain-text console output, for the human-readable breadcrumbs. */
const textLogs = () =>
  [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
    .map((call) => call.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    .join('\n');

const sentCommands = (spy, name) => spy.mock.calls.map((c) => c[0]).filter((cmd) => cmd.constructor.name === name);
const putsUnder = (prefix) => sentCommands(s3Send, 'PutObjectCommand').filter((cmd) => cmd.input.Key.startsWith(prefix));

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  ddbState = {
    // batchSize 1 + cooldown 0 → every delivery flushes, so a single handler
    // call exercises the whole ingest → flush → synthesis path.
    config: {
      agentId: AGENT_ID,
      enabled: true,
      sampleRate: 100,
      batchSize: 1,
      flushCooldownMinutes: 0,
    },
    bufferSessions: new Set(['sess-from-an-earlier-delivery']),
    priorBuffer: [],
    // TEAM-3376 seen-set table, TEAM-3385 two-phase (check-then-claim).
    // `seenItems` is the fake table: dedupKey → { dedupKey, outcome, expiresAt }.
    // Reads and conditional-write semantics are only HONOURED when
    // seenSetPersistent is set, so suites that replay the same request ids across
    // handler calls (e.g. the duplicate-aggregation tests) aren't
    // cross-delivery-deduped. Puts and gets are always recorded.
    seenItems: new Map(),
    seenPuts: [],
    seenGets: [],
    seenSetPersistent: false,
    // TEAM-3385 finding 2: make the next N buffer appends throw the way a real
    // DDB throttle / 400KB-item rejection does, so a test can prove that a
    // failed invocation claimed nothing and its re-delivery is processed.
    appendFailures: 0,
    // TEAM-3385 finding 6: every conditional buffer-reset ("flush claim") the
    // handler attempts, won or lost. `stealFlushClaim` makes a rival invocation
    // move lastFlushedAt between our config read and our claim (see GetCommand).
    flushResets: [],
    stealFlushClaim: false,
    // TEAM-3385 finding 7: the scorecard merge is optimistic-locked on
    // evalAggVersion. `aggWrites` records the accepted writes; setting
    // `aggConflicts` makes the next N merge writes lose the version check the way
    // a concurrent invocation would — the fake applies that invocation's write
    // (bumping the version and merging `concurrentAggDelta`) and *then* throws, so
    // a retry that fails to re-read is visible as a lost delta.
    aggWrites: [],
    aggConflicts: 0,
    concurrentAggDelta: {},
    // Persisting the merged scorecard back into `config` is opt-in: the
    // duplicate-aggregation suites replay the same delivery and assert on the raw
    // per-call deltas, which a stateful scorecard would compound.
    aggPersist: false,
  };

  // Evaluate the two conditional-write shapes index.mjs uses against the fake
  // item. Anything else is unconditional.
  const conditionHolds = (cond, values) => {
    if (cond.includes('attribute_not_exists(lastFlushedAt)')) return ddbState.config.lastFlushedAt === undefined;
    if (cond.includes('lastFlushedAt = :expected')) return ddbState.config.lastFlushedAt === values[':expected'];
    if (cond.includes('attribute_not_exists(evalAggVersion)')) return ddbState.config.evalAggVersion === undefined;
    if (cond.includes('evalAggVersion = :expectedVersion')) {
      return ddbState.config.evalAggVersion === values[':expectedVersion'];
    }
    return true;
  };
  const conditionalCheckFailed = () => {
    const err = new Error('The conditional request failed');
    err.name = 'ConditionalCheckFailedException';
    return err;
  };

  ddbSend.mockReset();
  ddbSend.mockImplementation(async (cmd) => {
    const name = cmd.constructor.name;
    if (name === 'GetCommand') {
      const snapshot = ddbState.config;
      // TEAM-3385 finding 6: model the race itself. A concurrent invocation wins
      // the flush AFTER this read and BEFORE our claim, so the value we based the
      // cooldown decision on is already stale by the time we compare-and-swap.
      if (ddbState.stealFlushClaim) {
        ddbState.config = { ...snapshot, lastFlushedAt: '2026-08-28T00:00:00.000Z' };
      }
      // Cloned, because a real Get deserializes a fresh object every call: handing
      // out the stored reference would let a caller's in-place merge mutate the
      // "table" and make a retried read see its own half-applied write.
      return { Item: structuredClone(snapshot) };
    }
    if (name === 'BatchGetCommand') {
      // Real BatchGetItem returns only the keys that exist, in no guaranteed
      // order, and rejects a request that repeats a key.
      const [table, request] = Object.entries(cmd.input.RequestItems)[0];
      const keys = request.Keys.map((k) => k.dedupKey);
      ddbState.seenGets.push({ table, keys });
      if (new Set(keys).size !== keys.length) {
        const err = new Error('Provided list of item keys contains duplicates');
        err.name = 'ValidationException';
        throw err;
      }
      const items = ddbState.seenSetPersistent
        ? keys.filter((k) => ddbState.seenItems.has(k)).map((k) => ddbState.seenItems.get(k))
        : [];
      return { Responses: { [table]: items }, UnprocessedKeys: {} };
    }
    if (name === 'PutCommand') {
      const key = cmd.input.Item?.dedupKey;
      ddbState.seenPuts.push(cmd.input);
      if (ddbState.seenSetPersistent) {
        const existing = ddbState.seenItems.get(key);
        // The claim's condition is `attribute_not_exists(dedupKey)`, optionally
        // `OR #outcome = :error` when the incoming row is scored.
        const supersedesError = (cmd.input.ConditionExpression || '').includes('#outcome = :error');
        if (existing && !(supersedesError && existing.outcome === 'error')) {
          const err = new Error('The conditional request failed');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }
        ddbState.seenItems.set(key, { ...cmd.input.Item });
      }
      return {};
    }
    if (name === 'UpdateCommand') {
      // appendToBuffer asks for ALL_NEW; mirror DDB's list_append so the flush
      // sees the delivery that was just appended.
      if (cmd.input.ReturnValues === 'ALL_NEW') {
        if (ddbState.appendFailures > 0) {
          ddbState.appendFailures -= 1;
          const err = new Error('ProvisionedThroughputExceededException: buffer append throttled');
          err.name = 'ProvisionedThroughputExceededException';
          throw err;
        }
        const appended = cmd.input.ExpressionAttributeValues[':new'] || [];
        return {
          Attributes: {
            sessionBuffer: [...ddbState.priorBuffer, ...appended],
            bufferSessions: ddbState.bufferSessions,
          },
        };
      }

      const values = cmd.input.ExpressionAttributeValues || {};
      const cond = cmd.input.ConditionExpression || '';

      // flushBuffer's flush claim: reset the buffer iff lastFlushedAt still holds
      // the value the cooldown decision was made from (TEAM-3385 finding 6).
      if (values[':empty']) {
        ddbState.flushResets.push(cmd.input);
        if (!conditionHolds(cond, values)) throw conditionalCheckFailed();
        ddbState.config = { ...ddbState.config, lastFlushedAt: values[':ts'] };
        ddbState.priorBuffer = [];
        return {};
      }

      // aggregateScoresToDdb's optimistic-locked scorecard merge (finding 7).
      if (values[':scores']) {
        if (ddbState.aggConflicts > 0) {
          ddbState.aggConflicts -= 1;
          ddbState.config = {
            ...ddbState.config,
            evalAggVersion: (ddbState.config.evalAggVersion ?? 0) + 1,
            evalScores: { ...(ddbState.config.evalScores || {}), ...ddbState.concurrentAggDelta },
          };
          throw conditionalCheckFailed();
        }
        if (!conditionHolds(cond, values)) throw conditionalCheckFailed();
        ddbState.aggWrites.push(cmd.input);
        // The version always persists — that is what makes the compare-and-swap
        // real across handler calls. The merged data only when aggPersist is set.
        ddbState.config = { ...ddbState.config, evalAggVersion: values[':nextVersion'] };
        if (ddbState.aggPersist) {
          ddbState.config = {
            ...ddbState.config,
            evalScores: values[':scores'],
            evalSessionCount: values[':sc'],
            evalStatusCounts: values[':statusCounts'],
          };
        }
        return {};
      }
      return {};
    }
    throw new Error(`unexpected DynamoDB command: ${name}`);
  });

  s3Send.mockReset();
  s3Send.mockImplementation(async (cmd) => {
    const name = cmd.constructor.name;
    if (name === 'GetObjectCommand') {
      return { Body: { transformToString: async () => JSON.stringify({ agents: AGENTS }) } };
    }
    if (name === 'PutObjectCommand') return { ETag: '"deadbeef"' };
    throw new Error(`unexpected S3 command: ${name}`);
  });

  // The improver answers with a well-formed JSON PRD over SSE frames.
  httpsRequest.mockReset();
  httpsRequest.mockImplementation((options, callback) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
    const body =
      frame({
        event: {
          contentBlockDelta: {
            delta: {
              text: JSON.stringify({
                title: 'Fix backend_dev telemetry gaps',
                description: 'The batch shows repeated unscored runs. Export the invoke_agent span.',
              }),
            },
          },
        },
      });
    const req = {
      on() {
        return req;
      },
      write() {},
      end() {
        process.nextTick(() => {
          res.emit('data', Buffer.from(body));
          res.emit('end');
        });
      },
    };
    callback(res);
    return req;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── With the improver configured (the full loop) ────────────────────────────

describe('handler (IMPROVEMENT_AGENT_ARN configured)', () => {
  let handler;
  // extractSessionData builds the prior-delivery buffer entries the
  // cross-delivery dedup test seeds DDB with, so those entries are exactly the
  // shape appendToBuffer really stores.
  let extractSessionData;

  beforeAll(async () => {
    // index.mjs reads all of this at MODULE scope and throws without a bucket,
    // so it must be set before the dynamic import.
    process.env.ARTIFACTS_BUCKET = 'agentcore-hub-artifacts-123456789012-us-east-1';
    process.env.EVAL_CONFIG_TABLE = 'agentcore-hub-eval-config';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCOUNT_ID = '123456789012';
    process.env.IMPROVEMENT_AGENT_ARN = IMPROVER_ARN;
    vi.resetModules();
    ({ handler, extractSessionData } = await import('./index.mjs'));
  });

  describe('raw CloudWatch Logs decode + missing-span preflight', () => {
    it('decodes the gzipped payload, classifies the missing-span record as error, and pages ONCE per session', async () => {
      const sessionId = 'sess-no-invoke-agent-span';
      const event = awslogsEvent([
        // The production missing-span shape.
        evalRecord({
          sessionId,
          score: null,
          errorType: 'ValidationException',
          errorMessage: MISSING_SPAN_MESSAGE,
        }),
        // A SECOND record for the same session — the page must not double-fire.
        evalRecord({ sessionId, evaluatorName: 'builtin.helpfulness', score: null }),
      ]);

      const result = await handler(event);
      expect(result).toEqual({ statusCode: 200, body: 'ok' });

      // 1. extractSessionData → classifyEntry glue: the entry that reaches the
      //    buffer carries status/statusReason, not just the raw attributes.
      const append = sentCommands(ddbSend, 'UpdateCommand').find((c) => c.input.ReturnValues === 'ALL_NEW');
      const entries = append.input.ExpressionAttributeValues[':new'][0].evaluatorResults;
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        sessionId,
        score: null,
        errorType: 'ValidationException',
        errorMessage: MISSING_SPAN_MESSAGE,
        status: 'error',
        statusReason: `ValidationException: ${MISSING_SPAN_MESSAGE}`,
      });
      // The second record has no score and no error — still pending, not an error.
      expect(entries[1].status).toBe('pending');

      // 2. Exactly ONE missing-span EMF line, for that one session.
      const spans = emfLines('eval.preflight.missing_span');
      expect(spans).toHaveLength(1);
      const [span] = spans;
      const [directive] = span._aws.CloudWatchMetrics;
      expect(directive.Namespace).toBe('AgentCoreHub/Evaluations');
      expect(directive.Dimensions).toEqual([['agentId'], []]);
      expect(directive.Metrics).toEqual([{ Name: 'eval.preflight.missing_span', Unit: 'Count' }]);
      expect(span['eval.preflight.missing_span']).toBe(1);
      expect(typeof span._aws.Timestamp).toBe('number');

      // 3. The same line is the structured, greppable error record for the session.
      expect(span).toMatchObject({
        level: 'error',
        event: 'eval.preflight.missing_span',
        agentId: AGENT_ID,
        sessionId,
        // Confirmed by the evaluator's own message → NOT the suspected prefix.
        statusReason: MISSING_SPAN_MESSAGE,
      });
      expect(span.statusReason).not.toMatch(/^missing_span_suspected/);

      // 4. And the human-readable breadcrumb that says where to look.
      expect(textLogs()).toContain('1 session(s) missing the invoke_agent span');
    });

    it('pages once per affected session and leaves healthy sessions alone', async () => {
      const event = awslogsEvent([
        evalRecord({ sessionId: 'sess-broken-a', score: null, errorType: 'ValidationException', errorMessage: MISSING_SPAN_MESSAGE }),
        evalRecord({ sessionId: 'sess-broken-b', score: null, errorType: 'ValidationException', errorMessage: MISSING_SPAN_MESSAGE }),
        evalRecord({ sessionId: 'sess-healthy', score: 8, scoreLabel: 'pass' }),
      ]);

      await handler(event);

      const spans = emfLines('eval.preflight.missing_span');
      expect(spans.map((s) => s.sessionId).sort()).toEqual(['sess-broken-a', 'sess-broken-b']);
    });

    it('emits no missing-span metric for a fully healthy delivery', async () => {
      await handler(
        awslogsEvent([
          evalRecord({ sessionId: 'sess-ok', score: 9, scoreLabel: 'pass' }),
          evalRecord({ sessionId: 'sess-ok', evaluatorName: 'builtin.helpfulness', score: 7, scoreLabel: 'pass' }),
        ])
      );
      expect(emfLines('eval.preflight.missing_span')).toEqual([]);
    });

    it('marks the all-null-plus-errorType heuristic as SUSPECTED, not confirmed', async () => {
      // An unrelated failure with no score is a *suspected* missing span. It must
      // still page, but must never be misattributed as confirmed.
      await handler(
        awslogsEvent([
          evalRecord({ sessionId: 'sess-throttled', score: null, errorType: 'ThrottlingException', errorMessage: 'Rate exceeded' }),
        ])
      );
      const [span] = emfLines('eval.preflight.missing_span');
      expect(span.statusReason).toBe('missing_span_suspected: Rate exceeded');
    });

    it('ignores a log group that matches no agent, without touching DynamoDB', async () => {
      const result = await handler(awslogsEvent([evalRecord({ sessionId: 's', score: 5 })], '/aws/lambda/some-other-fn'));
      expect(result).toEqual({ statusCode: 200, body: 'no-match' });
      expect(ddbSend).not.toHaveBeenCalled();
    });

    it('survives non-JSON platform lines in the same subscription stream', async () => {
      const result = await handler(
        awslogsEvent(['START RequestId: abc Version: $LATEST', 'REPORT RequestId: abc Duration: 42 ms'])
      );
      expect(result).toEqual({ statusCode: 200, body: 'ok' });
      const append = sentCommands(ddbSend, 'UpdateCommand').find((c) => c.input.ReturnValues === 'ALL_NEW');
      const entries = append.input.ExpressionAttributeValues[':new'][0].evaluatorResults;
      // Unreadable, so they must not dilute the rate: error, not skipped.
      expect(entries.map((e) => e.status)).toEqual(['error', 'error']);
      expect(entries.map((e) => e.statusReason)).toEqual(['unparseable_message', 'unparseable_message']);
    });
  });

  describe('flush: batch summary, EMF placement and the archive', () => {
    it('archives a batch whose summary is computeBatchSummary and emits the rate metric', async () => {
      const event = awslogsEvent([
        evalRecord({ sessionId: 'sess-1', score: 8, scoreLabel: 'pass' }),
        evalRecord({ sessionId: 'sess-1', evaluatorName: 'builtin.helpfulness', score: 6, scoreLabel: 'pass' }),
        evalRecord({ sessionId: 'sess-2', score: 9, scoreLabel: 'pass' }),
        evalRecord({ sessionId: 'sess-2', evaluatorName: 'builtin.faithfulness', score: null, errorType: 'InternalServerException', errorMessage: 'judge crashed' }),
      ]);

      await handler(event);

      // 1. The archive lands under batches/ — NOT prd/, which would trigger
      //    prd-submitter on an un-synthesized batch.
      const [archive] = putsUnder('fleet-imp-agent/batches/');
      expect(archive).toBeDefined();
      expect(archive.input.Key).toMatch(
        new RegExp(`^fleet-imp-agent/batches/batch-${AGENT_ID}-\\d{4}-\\d{2}-\\d{2}T.*\\.json$`)
      );
      expect(archive.input.ContentType).toBe('application/json');

      const payload = JSON.parse(archive.input.Body);
      const entries = payload.sessions.flatMap((s) => s.evaluatorResults || []);
      // 2. The batch summary IS computeBatchSummary over the flattened entries.
      expect(payload.summary).toEqual(computeBatchSummary(entries));
      expect(payload.summary).toMatchObject({
        successCount: 3,
        errorCount: 1,
        skippedCount: 0,
        scoredTotal: 4,
        nullOrErrorRate: 25,
      });
      expect(payload).toMatchObject({ agentId: AGENT_ID, batchSize: expect.any(Number) });

      // 3. The rate metric the alarms watch, with the dimensions they need.
      const rates = emfLines('eval.batch.null_or_error_rate');
      expect(rates).toHaveLength(1);
      const [rate] = rates;
      const [directive] = rate._aws.CloudWatchMetrics;
      expect(directive.Namespace).toBe('AgentCoreHub/Evaluations');
      // Per-agent series + the dimensionless rollup: the per-agent alarms in
      // deploy/continuous-improvement/deploy.sh need the agentId dimension.
      expect(directive.Dimensions).toEqual([['agentId'], []]);
      expect(directive.Metrics).toEqual([{ Name: 'eval.batch.null_or_error_rate', Unit: 'Percent' }]);
      expect(rate.agentId).toBe(AGENT_ID);
      expect(rate['eval.batch.null_or_error_rate']).toBe(payload.summary.nullOrErrorRate);
      expect(rate).toMatchObject({ successCount: 3, errorCount: 1, scoredTotal: 4, totalCount: 4 });
    });

    it('synthesizes and writes a PRD when the batch carries real evidence', async () => {
      await handler(
        awslogsEvent([
          evalRecord({ sessionId: 'sess-1', score: 4, scoreLabel: 'fail' }),
          evalRecord({ sessionId: 'sess-1', evaluatorName: 'builtin.helpfulness', score: 6, scoreLabel: 'pass' }),
        ])
      );

      // The improver was actually invoked, once, against the runtime.
      expect(httpsRequest).toHaveBeenCalledTimes(1);
      const [options] = httpsRequest.mock.calls[0];
      expect(options.hostname).toBe('bedrock-agentcore.us-east-1.amazonaws.com');
      expect(options.path).toContain('/runtimes/agentcore_hub_fleet_improver-AbCdEf/invocations');

      const [prd] = putsUnder('fleet-imp-agent/prd/');
      expect(prd).toBeDefined();
      const body = JSON.parse(prd.input.Body);
      expect(body.title).toBe('Fix backend_dev telemetry gaps');
      expect(body.description).toContain('invoke_agent span');
      expect(body.agentId).toBe(AGENT_ID);
      // IntakeSource shape — { type, value, label }, not a bare string, or the
      // workflow-start validator crashes reading source.value.
      expect(body.sources[0]).toMatchObject({ type: 's3', label: `eval batch for ${AGENT_ID}` });
      expect(body.sources[0].value).toMatch(/^s3:\/\/.+\/fleet-imp-agent\/batches\/batch-/);
      expect(jsonLogs().some((l) => l.event === 'eval.prd.synthesis_suppressed')).toBe(false);
    });

    it('SUPPRESSES synthesis when nothing in the batch was scored (scoredTotal 0)', async () => {
      // Every record well-formed, none scored, none errored → the evaluator
      // attempted nothing. Worst case, and zero evidence to synthesize from.
      await handler(
        awslogsEvent([
          evalRecord({ sessionId: 'sess-pending-1', score: null }),
          evalRecord({ sessionId: 'sess-pending-2', evaluatorName: 'builtin.helpfulness', score: null }),
        ])
      );

      const [archive] = putsUnder('fleet-imp-agent/batches/');
      const payload = JSON.parse(archive.input.Body);
      expect(payload.summary).toMatchObject({ scoredTotal: 0, nullCount: 2, nullOrErrorRate: 100 });

      const [suppressed] = jsonLogs().filter((l) => l.event === 'eval.prd.synthesis_suppressed');
      expect(suppressed).toMatchObject({
        level: 'warn',
        agentId: AGENT_ID,
        scoredTotal: 0,
        nullOrErrorRate: 100,
        nullCount: 2,
      });
      expect(suppressed.reason).toContain('scoredTotal=0');
      expect(suppressed.archivedKey).toBe(archive.input.Key);

      // No improver invoke, no PRD → no workflow off a broken pipeline. The
      // archive above stays, so the batch is still there to debug.
      expect(httpsRequest).not.toHaveBeenCalled();
      expect(putsUnder('fleet-imp-agent/prd/')).toEqual([]);
      expect(emfLines('eval.batch.null_or_error_rate')[0]['eval.batch.null_or_error_rate']).toBe(100);
    });

    it('SUPPRESSES synthesis when every scored entry failed (rate at 100)', async () => {
      await handler(
        awslogsEvent([
          evalRecord({ sessionId: 'sess-a', score: null, errorType: 'ValidationException', errorMessage: MISSING_SPAN_MESSAGE }),
          evalRecord({ sessionId: 'sess-b', score: null, errorType: 'ValidationException', errorMessage: MISSING_SPAN_MESSAGE }),
        ])
      );

      const payload = JSON.parse(putsUnder('fleet-imp-agent/batches/')[0].input.Body);
      expect(payload.summary).toMatchObject({ errorCount: 2, scoredTotal: 2, nullOrErrorRate: 100 });

      const [suppressed] = jsonLogs().filter((l) => l.event === 'eval.prd.synthesis_suppressed');
      expect(suppressed.reason).toContain('nullOrErrorRate at maximum');
      expect(httpsRequest).not.toHaveBeenCalled();
      expect(putsUnder('fleet-imp-agent/prd/')).toEqual([]);
    });

    it('holds the batch instead of flushing while the cooldown is unexpired', async () => {
      ddbState.config = { ...ddbState.config, flushCooldownMinutes: 60, lastFlushedAt: new Date().toISOString() };
      const result = await handler(awslogsEvent([evalRecord({ sessionId: 'sess-1', score: 8, scoreLabel: 'pass' })]));
      expect(result).toEqual({ statusCode: 200, body: 'cooldown' });
      expect(putsUnder('fleet-imp-agent/batches/')).toEqual([]);
      expect(httpsRequest).not.toHaveBeenCalled();
    });

    it('does not flush before batchSize distinct runs have accumulated', async () => {
      ddbState.config = { ...ddbState.config, batchSize: 10 };
      const result = await handler(awslogsEvent([evalRecord({ sessionId: 'sess-1', score: 8, scoreLabel: 'pass' })]));
      expect(result).toEqual({ statusCode: 200, body: 'ok' });
      expect(putsUnder('fleet-imp-agent/batches/')).toEqual([]);
    });

    it('skips a disabled agent entirely', async () => {
      ddbState.config = { ...ddbState.config, enabled: false };
      const result = await handler(awslogsEvent([evalRecord({ sessionId: 'sess-1', score: 8 })]));
      expect(result).toEqual({ statusCode: 200, body: 'disabled' });
      expect(s3Send.mock.calls.every((c) => c[0].constructor.name === 'GetObjectCommand')).toBe(true);
    });
  });

  // ─── Delivery dedup through the shipped pipeline (TEAM-3367) ──────────────
  // CW Logs subscription delivery is at-least-once and the evaluator retries,
  // so one evaluation attempt can appear in a delivery N times. Pre-fix, the
  // aggregation re-parsed the raw logEvents and double-counted every dup into
  // the rolling scorecard; classification and the buffered batch saw them too.
  describe('duplicate records: aggregation + classification (TEAM-3367)', () => {
    const scoresUpdate = () =>
      sentCommands(ddbSend, 'UpdateCommand').find((c) => c.input.UpdateExpression.includes('evalScores'));

    it('aggregation totals are unchanged when every record arrives duplicated 8×', async () => {
      // batchSize 10 → no flush; this test is about the aggregation write only.
      ddbState.config = { ...ddbState.config, batchSize: 10 };
      const records = () => [
        evalRecord({ sessionId: 'sess-1', score: 8, scoreLabel: 'pass', requestId: 'req-corr-1' }),
        evalRecord({ sessionId: 'sess-2', evaluatorName: 'builtin.helpfulness', score: 6, scoreLabel: 'pass', requestId: 'req-help-1' }),
      ];

      await handler(awslogsEvent(records()));
      const clean = scoresUpdate();
      const cleanScores = clean.input.ExpressionAttributeValues[':scores'];
      const cleanSessions = clean.input.ExpressionAttributeValues[':sc'];
      expect(cleanScores).toEqual({
        'builtin.correctness': { sum: 8, count: 1 },
        'builtin.helpfulness': { sum: 6, count: 1 },
      });
      expect(cleanSessions).toBe(2);

      // Same delivery, but each record repeated 9× (8 injected duplicates).
      // awslogsEvent gives every copy a distinct timestamp, so only the shared
      // request id can collapse them.
      ddbSend.mockClear();
      await handler(awslogsEvent(records().flatMap((r) => Array(9).fill(r))));
      const dup = scoresUpdate();
      expect(dup.input.ExpressionAttributeValues[':scores']).toEqual(cleanScores);
      expect(dup.input.ExpressionAttributeValues[':sc']).toBe(cleanSessions);
    });

    it('classifySessions sees deduped input: a throttled session with 8 duplicates is ONE error session', async () => {
      ddbState.config = { ...ddbState.config, batchSize: 10 };
      const throttled = evalRecord({
        sessionId: 'sess-throttled',
        score: null,
        errorType: 'ThrottlingException',
        errorMessage: 'Rate exceeded',
        requestId: 'req-throttle-1',
      });

      await handler(awslogsEvent(Array(9).fill(throttled)));

      // The buffered batch carries ONE row, not nine.
      const append = sentCommands(ddbSend, 'UpdateCommand').find((c) => c.input.ReturnValues === 'ALL_NEW');
      const sessionData = append.input.ExpressionAttributeValues[':new'][0];
      expect(sessionData.evaluatorResults).toHaveLength(1);
      expect(sessionData.duplicatesDropped).toBe(8);
      expect(sessionData.sessionStatus).toEqual({ 'sess-throttled': 'error' });

      // And the fleet tally counts one session — an error one, not span_missing.
      const [metrics] = emfLines('EvalSessionsTotal');
      expect(metrics.EvalSessionsTotal).toBe(1);
      expect(metrics.EvalSessionsSpanMissing).toBe(0);
    });
  });

  // ─── Cross-delivery dedup at flush (TEAM-3381 FR-2.1 AC-1/AC-2) ───────────
  // Per-delivery dedup cannot see a request id whose copies arrived in TWO
  // CloudWatch Logs deliveries: each delivery is individually clean, and the
  // duplicate only exists in the MERGED buffer. Pre-fix the flushed payload
  // carried that record twice and the batch summary counted it twice.
  describe('cross-delivery duplicates at flush (TEAM-3381)', () => {
    /** A parsed CW Logs delivery (pre-decode), as extractSessionData consumes it. */
    const parsedDelivery = (messages, logStream) => ({
      logGroup: LOG_GROUP,
      logStream,
      logEvents: messages.map((message, i) => ({
        id: `earlier${i}`,
        timestamp: 1_699_999_000_000 + i,
        message: JSON.stringify(message),
      })),
    });

    it('flushes ONE record for a request id split across two deliveries', async () => {
      // The SAME evaluation attempt, delivered twice by at-least-once delivery.
      const duplicated = evalRecord({
        sessionId: 'sess-cross',
        score: 8,
        scoreLabel: 'pass',
        requestId: 'req-cross-1',
      });
      // Delivery 1 is already in the buffer (a previous invocation appended it).
      ddbState.priorBuffer = [extractSessionData(parsedDelivery([duplicated], 'earlier-stream'))];

      // Delivery 2 re-carries it, plus one genuinely new record. batchSize 1 →
      // this invocation flushes the merged buffer.
      await handler(
        awslogsEvent([
          duplicated,
          evalRecord({ sessionId: 'sess-fresh', evaluatorName: 'builtin.helpfulness', score: 6, scoreLabel: 'pass', requestId: 'req-fresh-1' }),
        ])
      );

      const [archive] = putsUnder('fleet-imp-agent/batches/');
      const payload = JSON.parse(archive.input.Body);

      // Both buffer entries survive (provenance kept), but the duplicate is gone.
      expect(payload.sessions).toHaveLength(2);
      const flat = payload.sessions.flatMap((s) => s.evaluatorResults || []);
      expect(flat.filter((r) => r.requestId === 'req-cross-1')).toHaveLength(1);
      expect(flat.filter((r) => r.requestId === 'req-fresh-1')).toHaveLength(1);
      expect(flat).toHaveLength(2);

      // The drop is counted, observable in the payload AND logged — not silent.
      expect(payload.crossDeliveryDuplicatesDropped).toBe(1);
      const [dropped] = jsonLogs().filter((l) => l.event === 'eval.batch.cross_delivery_duplicates_dropped');
      expect(dropped).toMatchObject({
        level: 'warn',
        agentId: AGENT_ID,
        crossDeliveryDuplicatesDropped: 1,
        bufferEntries: 2,
      });

      // And the summary the improver reads is built over the DEDUPED batch: two
      // successes, not three.
      expect(payload.summary).toEqual(computeBatchSummary(flat));
      expect(payload.summary).toMatchObject({ successCount: 2, scoredTotal: 2, errorCount: 0 });
    });

    it('leaves a duplicate-free buffer untouched and reports zero drops', async () => {
      ddbState.priorBuffer = [
        extractSessionData(
          parsedDelivery(
            [evalRecord({ sessionId: 'sess-earlier', score: 9, scoreLabel: 'pass', requestId: 'req-earlier' })],
            'earlier-stream'
          )
        ),
      ];

      await handler(
        awslogsEvent([evalRecord({ sessionId: 'sess-now', score: 7, scoreLabel: 'pass', requestId: 'req-now' })])
      );

      const payload = JSON.parse(putsUnder('fleet-imp-agent/batches/')[0].input.Body);
      expect(payload.crossDeliveryDuplicatesDropped).toBe(0);
      expect(payload.sessions.flatMap((s) => s.evaluatorResults || [])).toHaveLength(2);
      expect(jsonLogs().some((l) => l.event === 'eval.batch.cross_delivery_duplicates_dropped')).toBe(false);
    });
  });
});

// ─── Without the improver configured ────────────────────────────────────────

describe('handler (IMPROVEMENT_AGENT_ARN unset)', () => {
  let handler;

  beforeAll(async () => {
    process.env.ARTIFACTS_BUCKET = 'agentcore-hub-artifacts-123456789012-us-east-1';
    process.env.AWS_REGION = 'us-east-1';
    delete process.env.IMPROVEMENT_AGENT_ARN;
    delete process.env.IMPROVEMENT_AGENT_ID;
    vi.resetModules();
    ({ handler } = await import('./index.mjs'));
  });

  it('reaches synthesis on a healthy batch and reports the missing ARN', async () => {
    await handler(awslogsEvent([evalRecord({ sessionId: 'sess-1', score: 7, scoreLabel: 'pass' })]));
    expect(textLogs()).toContain('skipping PRD synthesis');
    expect(putsUnder('fleet-imp-agent/prd/')).toEqual([]);
  });

  it('suppresses an evidence-free batch BEFORE the ARN check', async () => {
    // The guard must not hide behind IMPROVER_ARN: with no ARN configured the
    // suppression is still the reason nothing was synthesized, and the
    // "ARN not set" warning must never be reached.
    await handler(awslogsEvent([evalRecord({ sessionId: 'sess-1', score: null })]));
    expect(jsonLogs().some((l) => l.event === 'eval.prd.synthesis_suppressed')).toBe(true);
    expect(textLogs()).not.toContain('skipping PRD synthesis');
    expect(putsUnder('fleet-imp-agent/batches/')).toHaveLength(1);
    expect(putsUnder('fleet-imp-agent/prd/')).toEqual([]);
  });
});

// ─── Session classification + fleet EMF metrics (TEAM-3103 AC4.1–4.4) ────────
// Ported from the node:test suite that shipped with TEAM-3096 (d2f3c06) —
// same assertions, run under vitest like the rest of this file.

describe('classifySessions / emitEvalMetrics / extractSessionData (TEAM-3103)', () => {
  let classifySessions;
  let emitEvalMetrics;
  let extractSessionData;

  beforeAll(async () => {
    process.env.ARTIFACTS_BUCKET ??= 'test-bucket';
    process.env.AWS_REGION ??= 'us-east-1';
    vi.resetModules();
    ({ classifySessions, emitEvalMetrics, extractSessionData } = await import('./index.mjs'));
  });

  // Minimal evaluatorResults row as extractSessionData produces it.
  const row = (sessionId, score, extra = {}) => ({
    timestamp: 1756250000000,
    sessionId,
    evaluatorName: 'Builtin.Correctness',
    score,
    scoreLabel: null,
    evidence: null,
    errorType: null,
    errorMessage: null,
    ...extra,
  });

  const data = (evaluatorResults) => ({ evaluatorResults });

  // Minimal parsed CW Logs delivery, as extractSessionData consumes it: each
  // logEvent.message is a JSON OTEL log record with gen_ai.* attributes.
  const delivery = (logEvents) => ({
    logGroup: '/aws/bedrock-agentcore/evaluations/results/eval_requirements_analyst-test',
    logStream: 'test-stream',
    logEvents,
  });

  const logEvent = (sessionId, scoreValue, extraAttrs = {}) => ({
    timestamp: 1756250000000,
    message: JSON.stringify({
      attributes: {
        'session.id': sessionId,
        'gen_ai.evaluation.name': 'Builtin.Correctness',
        'gen_ai.evaluation.score.value': scoreValue,
        ...extraAttrs,
      },
    }),
  });

  it('all-null scores with no errorType → span_missing', () => {
    const { statuses, total, spanMissing } = classifySessions(
      data([row('s1', null), row('s1', null), row('s1', null)])
    );
    expect(statuses.get('s1')).toBe('span_missing');
    expect(total).toBe(1);
    expect(spanMissing).toBe(1);
  });

  it('numeric scores → scored, spanMissing=0', () => {
    const { statuses, total, spanMissing } = classifySessions(
      data([row('s1', 1.0), row('s1', 0.5), row('s2', 0.75)])
    );
    expect(statuses.get('s1')).toBe('scored');
    expect(statuses.get('s2')).toBe('scored');
    expect(total).toBe(2);
    expect(spanMissing).toBe(0);
  });

  it('score of 0 is a real score, not missing', () => {
    const { statuses, spanMissing } = classifySessions(data([row('s1', 0)]));
    expect(statuses.get('s1')).toBe('scored');
    expect(spanMissing).toBe(0);
  });

  it('mixed batch: scored / span_missing / error classified per session', () => {
    const { statuses, total, spanMissing } = classifySessions(
      data([
        row('a', 0.9),
        row('a', null),
        row('b', null),
        row('b', null),
        row('c', null, { errorType: 'JudgeTimeout' }),
        row('c', null),
      ])
    );
    expect(statuses.get('a')).toBe('scored');
    expect(statuses.get('b')).toBe('span_missing');
    expect(statuses.get('c')).toBe('error');
    // The error session counts toward total but NOT toward spanMissing.
    expect(total).toBe(3);
    expect(spanMissing).toBe(1);
  });

  it('all-null WITH errorType → error, excluded from spanMissing', () => {
    const { statuses, total, spanMissing } = classifySessions(
      data([row('s1', null, { errorType: 'AccessDenied' })])
    );
    expect(statuses.get('s1')).toBe('error');
    expect(total).toBe(1);
    expect(spanMissing).toBe(0);
  });

  it('empty evaluatorResults → total=0, spanMissing=0, no throw', () => {
    const { statuses, total, spanMissing } = classifySessions(data([]));
    expect(total).toBe(0);
    expect(spanMissing).toBe(0);
    expect(statuses.size).toBe(0);
  });

  it('parseError rows and rows without sessionId are ignored', () => {
    const { total, spanMissing } = classifySessions(
      data([
        { timestamp: 1, rawMessage: 'not json', parseError: true },
        row(null, null),
        row('', 0.9),
      ])
    );
    expect(total).toBe(0);
    expect(spanMissing).toBe(0);
  });

  it('non-numeric garbage score with no errorType → span_missing, not scored (TEAM-3315)', () => {
    const sessionData = extractSessionData(
      delivery([logEvent('s1', 'not-a-number'), logEvent('s1', 'NaN')])
    );
    const { statuses, total, spanMissing } = classifySessions(sessionData);
    expect(statuses.get('s1')).toBe('span_missing');
    expect(total).toBe(1);
    expect(spanMissing).toBe(1);
  });

  it('session with some null and some numeric scores → scored', () => {
    const { statuses, spanMissing } = classifySessions(
      data([row('s1', null), row('s1', 0.8), row('s1', null)])
    );
    expect(statuses.get('s1')).toBe('scored');
    expect(spanMissing).toBe(0);
  });

  it('emitEvalMetrics emits a single EMF record carrying all health metrics', () => {
    emitEvalMetrics('agentcore_hub_backend_dev', { total: 4, spanMissing: 0 });

    const records = emfLines('EvalSessionsTotal');
    expect(records).toHaveLength(1);
    const record = records[0];
    const emf = record._aws.CloudWatchMetrics;
    expect(emf).toHaveLength(1);
    expect(emf[0].Namespace).toBe('AgentCoreHub/Evaluations');
    expect(emf[0].Dimensions).toEqual([['AgentName']]);
    expect(emf[0].Metrics.map((m) => m.Name).sort()).toEqual([
      'EvalDepChainExcludedCount',
      'EvalDuplicateResultCount',
      'EvalSessionsError',
      'EvalSessionsSpanMissing',
      'EvalSessionsTotal',
      'EvalThrottleCount',
      'EvalThrottleRate',
      'EvalValidationExceptionRate',
    ]);
    expect(typeof record._aws.Timestamp).toBe('number');
    expect(record.AgentName).toBe('agentcore_hub_backend_dev');
    expect(record.EvalSessionsTotal).toBe(4);
    // Explicit 0 must be emitted (healthy fleet still writes a datapoint).
    expect(record.EvalSessionsSpanMissing).toBe(0);
  });

  it('emitEvalMetrics carries non-zero spanMissing through', () => {
    emitEvalMetrics('agentcore_hub_qa_verifier', { total: 7, spanMissing: 3 });
    const [record] = emfLines('EvalSessionsTotal');
    expect(record.EvalSessionsTotal).toBe(7);
    expect(record.EvalSessionsSpanMissing).toBe(3);
  });
});

// ─── extractSessionData dedup (TEAM-3367) ────────────────────────────────────
// Request-id extraction chain, ranked: (a) OTEL envelope traceId+spanId,
// (b) attributes['aws.request_id'], (c) attributes['gen_ai.response.id'];
// content-key fallback when a record carries none of them.

describe('extractSessionData dedup (TEAM-3367)', () => {
  let extractSessionData;
  let dedupeResults;

  beforeAll(async () => {
    process.env.ARTIFACTS_BUCKET ??= 'test-bucket';
    process.env.AWS_REGION ??= 'us-east-1';
    vi.resetModules();
    ({ extractSessionData, dedupeResults } = await import('./index.mjs'));
  });

  const delivery = (logEvents) => ({
    logGroup: '/aws/bedrock-agentcore/evaluations/results/eval_backend_dev-test',
    logStream: 'test-stream',
    logEvents,
  });

  /** OTEL eval log record with full control over envelope ids and timestamps. */
  const otelEvent = ({
    sessionId = 'sess-1',
    evaluatorName = 'Builtin.Correctness',
    score,
    timestamp = 1_756_250_000_000,
    envelope = {},
    attrs = {},
  }) => ({
    timestamp,
    message: JSON.stringify({
      ...envelope,
      attributes: {
        'session.id': sessionId,
        'gen_ai.evaluation.name': evaluatorName,
        ...(score !== undefined && score !== null ? { 'gen_ai.evaluation.score.value': score } : {}),
        ...attrs,
      },
    }),
  });

  it('collapses 9 records sharing a request id (aws.request_id) to one', () => {
    // Distinct timestamps on every copy: only the shared id can collapse them.
    const events = Array.from({ length: 9 }, (_, i) =>
      otelEvent({ score: 8, timestamp: 1_756_250_000_000 + i, attrs: { 'aws.request_id': 'req-abc' } })
    );
    const sessionData = extractSessionData(delivery(events));
    expect(sessionData.evaluatorResults).toHaveLength(1);
    expect(sessionData.duplicatesDropped).toBe(8);
    expect(sessionData.evaluatorResults[0]).toMatchObject({ requestId: 'req-abc', score: 8 });
  });

  it('envelope traceId+spanId identify duplicates and outrank aws.request_id', () => {
    const sessionData = extractSessionData(
      delivery([
        // Same evaluated span, two delivery copies — the differing aws.request_id
        // must not keep them apart, because the envelope ids rank first.
        otelEvent({ score: 7, timestamp: 1, envelope: { traceId: 'trace-1', spanId: 'span-1' }, attrs: { 'aws.request_id': 'req-1' } }),
        otelEvent({ score: 7, timestamp: 2, envelope: { traceId: 'trace-1', spanId: 'span-1' }, attrs: { 'aws.request_id': 'req-2' } }),
        // Same span ids but a DIFFERENT evaluator: a distinct result, kept.
        otelEvent({ evaluatorName: 'Builtin.Helpfulness', score: 5, timestamp: 3, envelope: { traceId: 'trace-1', spanId: 'span-1' } }),
      ])
    );
    expect(sessionData.evaluatorResults).toHaveLength(2);
    expect(sessionData.duplicatesDropped).toBe(1);
    expect(sessionData.evaluatorResults[0].requestId).toBe('trace-1:span-1');
  });

  it('falls back to gen_ai.response.id when the envelope carries no ids', () => {
    const sessionData = extractSessionData(
      delivery([
        otelEvent({ score: 9, timestamp: 1, attrs: { 'gen_ai.response.id': 'resp-1' } }),
        otelEvent({ score: 9, timestamp: 2, attrs: { 'gen_ai.response.id': 'resp-1' } }),
      ])
    );
    expect(sessionData.evaluatorResults).toHaveLength(1);
    expect(sessionData.duplicatesDropped).toBe(1);
  });

  it('preserves distinct records: same session, different evaluators/scores/request ids', () => {
    const sessionData = extractSessionData(
      delivery([
        otelEvent({ score: 8, timestamp: 1, attrs: { 'aws.request_id': 'req-1' } }),
        otelEvent({ evaluatorName: 'Builtin.Helpfulness', score: 6, timestamp: 2, attrs: { 'aws.request_id': 'req-2' } }),
        otelEvent({ evaluatorName: 'Builtin.Faithfulness', score: 4, timestamp: 3, attrs: { 'aws.request_id': 'req-3' } }),
      ])
    );
    expect(sessionData.evaluatorResults).toHaveLength(3);
    expect(sessionData.duplicatesDropped).toBe(0);
  });

  it('content-key fallback: identical no-id rows collapse; rows differing only in timestamp do not', () => {
    // Two byte-identical retry writes (no request id anywhere) → one row.
    const identical = extractSessionData(
      delivery([otelEvent({ score: 8, timestamp: 42 }), otelEvent({ score: 8, timestamp: 42 })])
    );
    expect(identical.evaluatorResults).toHaveLength(1);
    expect(identical.duplicatesDropped).toBe(1);

    // Same score, DIFFERENT timestamps → genuinely distinct evaluations, kept.
    const distinct = extractSessionData(
      delivery([otelEvent({ score: 8, timestamp: 42 }), otelEvent({ score: 8, timestamp: 43 })])
    );
    expect(distinct.evaluatorResults).toHaveLength(2);
    expect(distinct.duplicatesDropped).toBe(0);
  });

  it('dedupeResults is exported and keeps first occurrence', () => {
    const rows = [
      { requestId: 'r1', evaluatorName: 'e', score: 1, timestamp: 1 },
      { requestId: 'r1', evaluatorName: 'e', score: 2, timestamp: 2 },
    ];
    expect(dedupeResults(rows)).toEqual([rows[0]]);
  });
});

// ─── dedup fail-open + content fingerprint (TEAM-3381) ───────────────────────
// AC-1 requires records with missing/null dedup-key fields to FAIL OPEN. Two
// failure modes the content key had:
//   1. a record with NO key at all (no request id, and sessionId/evaluatorName/
//      evaluationName/score all null) collapsed into any other such record that
//      shared the delivery's millisecond timestamp — one record silently lost
//      AND wrongly counted as a duplicate; and
//   2. logEvent.timestamp is per-batch-millisecond, not per-record, so two
//      DISTINCT results with identical metadata in the same ms collapsed too.

describe('dedup fail-open + content fingerprint (TEAM-3381)', () => {
  let extractSessionData;
  let dedupeResults;
  let dedupeBufferedSessions;
  let hasNoDedupKey;
  let contentFingerprint;
  let dedupKeyFor;

  beforeAll(async () => {
    process.env.ARTIFACTS_BUCKET ??= 'test-bucket';
    process.env.AWS_REGION ??= 'us-east-1';
    vi.resetModules();
    ({
      extractSessionData,
      dedupeResults,
      dedupeBufferedSessions,
      hasNoDedupKey,
      contentFingerprint,
      dedupKeyFor,
    } = await import('./index.mjs'));
  });

  const delivery = (logEvents) => ({
    logGroup: '/aws/bedrock-agentcore/evaluations/results/eval_backend_dev-test',
    logStream: 'test-stream',
    logEvents,
  });

  /** A well-formed JSON row carrying NO dedup-key field at all. */
  const keylessEvent = (timestamp, attrs = {}) => ({
    timestamp,
    message: JSON.stringify({ body: 'evaluation result', attributes: attrs }),
  });

  it('two DISTINCT all-null-key records sharing a timestamp are BOTH retained', () => {
    const sessionData = extractSessionData(
      delivery([
        keylessEvent(1_756_250_000_000, { 'error.message': 'judge crashed on run A' }),
        keylessEvent(1_756_250_000_000, { 'error.message': 'judge crashed on run B' }),
      ])
    );
    expect(sessionData.evaluatorResults).toHaveLength(2);
    // Never mis-reported as a duplicate (it would inflate EvalDuplicateResultCount).
    expect(sessionData.duplicatesDropped).toBe(0);
  });

  it('IDENTICAL all-null-key records are retained too — no key means no provable duplicate', () => {
    // Fail-open beats collapsing: with every discriminator null there is nothing
    // to key on, so dropping one is a silent data loss we refuse to take.
    const sessionData = extractSessionData(
      delivery([keylessEvent(1_756_250_000_000), keylessEvent(1_756_250_000_000)])
    );
    expect(sessionData.evaluatorResults).toHaveLength(2);
    expect(sessionData.duplicatesDropped).toBe(0);
  });

  it('hasNoDedupKey: only an entirely key-less parsed row qualifies', () => {
    const keyless = { requestId: null, sessionId: null, evaluatorName: null, score: null, timestamp: 1 };
    expect(hasNoDedupKey(keyless)).toBe(true);
    expect(hasNoDedupKey({ ...keyless, requestId: 'req-1' })).toBe(false);
    expect(hasNoDedupKey({ ...keyless, sessionId: 'sess-1' })).toBe(false);
    expect(hasNoDedupKey({ ...keyless, evaluatorName: 'Builtin.Correctness' })).toBe(false);
    expect(hasNoDedupKey({ ...keyless, evaluationName: 'eval-1' })).toBe(false);
    // A score of 0 is a real score, so it IS a discriminator.
    expect(hasNoDedupKey({ ...keyless, score: 0 })).toBe(false);
    // Unparseable rows key on their raw text — they are not key-less.
    expect(hasNoDedupKey({ ...keyless, parseError: true, rawMessage: 'START RequestId: abc' })).toBe(false);
  });

  it('one key-less row plus a keyed duplicate pair: the pair collapses, the key-less row stays', () => {
    const rows = [
      { timestamp: 7, sessionId: null, evaluatorName: null, score: null },
      { timestamp: 7, sessionId: 's1', evaluatorName: 'e', score: 5, contentHash: 'aaaa' },
      { timestamp: 7, sessionId: 's1', evaluatorName: 'e', score: 5, contentHash: 'aaaa' },
    ];
    expect(dedupeResults(rows)).toEqual([rows[0], rows[1]]);
  });

  // ── No-request-id content path ────────────────────────────────────────────
  const otelEvent = ({ sessionId = 'sess-1', evaluatorName = 'Builtin.Correctness', score, timestamp, evidence }) => ({
    timestamp,
    message: JSON.stringify({
      attributes: {
        'session.id': sessionId,
        'gen_ai.evaluation.name': evaluatorName,
        ...(score !== undefined && score !== null ? { 'gen_ai.evaluation.score.value': score } : {}),
        ...(evidence ? { 'gen_ai.evaluation.explanation': evidence } : {}),
      },
    }),
  });

  it('identical retry writes (same content, same ms) still collapse to one', () => {
    const sessionData = extractSessionData(
      delivery([
        otelEvent({ score: 8, timestamp: 42, evidence: 'The agent addressed the ticket.' }),
        otelEvent({ score: 8, timestamp: 42, evidence: 'The agent addressed the ticket.' }),
      ])
    );
    expect(sessionData.evaluatorResults).toHaveLength(1);
    expect(sessionData.duplicatesDropped).toBe(1);
    expect(sessionData.evaluatorResults[0].contentHash).toBe(
      contentFingerprint(JSON.stringify({
        attributes: {
          'session.id': 'sess-1',
          'gen_ai.evaluation.name': 'Builtin.Correctness',
          'gen_ai.evaluation.score.value': 8,
          'gen_ai.evaluation.explanation': 'The agent addressed the ticket.',
        },
      }))
    );
  });

  it('distinct results with identical metadata and the SAME ms are BOTH retained', () => {
    // Same session/evaluator/score/timestamp — only the evaluator's explanation
    // differs, i.e. two real evaluations CloudWatch stamped in the same
    // millisecond. Pre-fix these collapsed into one.
    const sessionData = extractSessionData(
      delivery([
        otelEvent({ score: 8, timestamp: 42, evidence: 'Cited the ticket AC directly.' }),
        otelEvent({ score: 8, timestamp: 42, evidence: 'Missed the dependency chain note.' }),
      ])
    );
    expect(sessionData.evaluatorResults).toHaveLength(2);
    expect(sessionData.duplicatesDropped).toBe(0);
    expect(new Set(sessionData.evaluatorResults.map((r) => r.contentHash)).size).toBe(2);
  });

  it('dedupeBufferedSessions keeps the buffer shape: emptied entries stay, provenance intact', () => {
    const dup = { timestamp: 1, requestId: 'req-1', evaluatorName: 'e', sessionId: 's1', score: 8 };
    const { sessions, crossDeliveryDuplicatesDropped } = dedupeBufferedSessions([
      { logStream: 'stream-a', sessionIds: ['s1'], evaluatorResults: [dup] },
      // Delivery 2 carried nothing but the duplicate: the entry survives with an
      // empty result list (the improver payload reads sessions[].*).
      { logStream: 'stream-b', sessionIds: ['s1'], evaluatorResults: [dup] },
      // A malformed/legacy entry with no evaluatorResults is passed through as-is.
      { logStream: 'stream-c' },
    ]);
    expect(crossDeliveryDuplicatesDropped).toBe(1);
    expect(sessions).toHaveLength(3);
    expect(sessions[0].evaluatorResults).toEqual([dup]);
    expect(sessions[1]).toEqual({ logStream: 'stream-b', sessionIds: ['s1'], evaluatorResults: [] });
    expect(sessions[2]).toEqual({ logStream: 'stream-c' });
  });

  // ── dedupKey size bound (TEAM-3385 finding 4) ─────────────────────────────
  // dedupKey is the seen-set table's PARTITION KEY, and DynamoDB caps a partition
  // key at 2048 bytes. The parseError path used to embed the whole raw log line,
  // so any line over ~2KB made every conditional PutItem throw
  // ValidationException — the seen-set then failed OPEN forever and dedup was
  // silently inert. The fingerprint keeps the same identity guarantees at a
  // constant size.
  describe('dedupKey stays inside the DynamoDB 2048-byte partition-key limit', () => {
    /** A log line that is not JSON, so extractSessionData takes the parseError path. */
    const unparseableEvent = (timestamp, rawMessage) => ({ timestamp, message: rawMessage });

    it('a >4KB unparseable line produces a dedupKey under 256 chars', () => {
      const huge = `START RequestId: ${'x'.repeat(4096)}`;
      const [row] = extractSessionData(delivery([unparseableEvent(1_756_250_000_000, huge)]))
        .evaluatorResults;

      expect(row.parseError).toBe(true);
      expect(row.dedupKey.length).toBeLessThan(256);
      // The raw text itself must not ride along in the key.
      expect(row.dedupKey).not.toContain('xxxx');
      expect(row.dedupKey).toBe(`raw|1756250000000|${contentFingerprint(huge)}`);
    });

    it('two DIFFERENT raw messages sharing a timestamp still get distinct keys', () => {
      const rows = extractSessionData(
        delivery([
          unparseableEvent(1_756_250_000_000, `REPORT Duration: 1 ms ${'a'.repeat(5000)}`),
          unparseableEvent(1_756_250_000_000, `REPORT Duration: 2 ms ${'a'.repeat(5000)}`),
        ])
      ).evaluatorResults;

      expect(rows).toHaveLength(2);
      expect(rows[0].dedupKey).not.toBe(rows[1].dedupKey);
    });

    it('the IDENTICAL raw message re-delivered gets the SAME key (so it still collapses)', () => {
      const line = `START RequestId: ${'y'.repeat(3000)}`;
      const first = extractSessionData(delivery([unparseableEvent(1_756_250_000_000, line)]));
      // A second CloudWatch delivery of the same log event: same ms, same bytes.
      const second = extractSessionData(delivery([unparseableEvent(1_756_250_000_000, line)]));

      expect(first.evaluatorResults[0].dedupKey).toBe(second.evaluatorResults[0].dedupKey);
      // And within ONE delivery the pair collapses in the in-memory pass.
      const sameDelivery = extractSessionData(
        delivery([
          unparseableEvent(1_756_250_000_000, line),
          unparseableEvent(1_756_250_000_000, line),
        ])
      );
      expect(sameDelivery.evaluatorResults).toHaveLength(1);
      expect(sameDelivery.duplicatesDropped).toBe(1);
    });

    it('no dedupKey variant exceeds the limit, even with pathological field values', () => {
      const long = 'z'.repeat(9000);
      const keys = [
        // request-id path
        dedupKeyFor({ timestamp: 1, requestId: long, evaluatorName: long }),
        // content path
        dedupKeyFor({
          timestamp: 1,
          sessionId: long,
          evaluatorName: long,
          evaluationName: long,
          score: 8,
          contentHash: 'abcd',
        }),
        // unparseable path
        dedupKeyFor({ timestamp: 1, parseError: true, rawMessage: long }),
      ];
      for (const key of keys) {
        expect(Buffer.byteLength(key, 'utf8')).toBeLessThanOrEqual(2048);
      }
      // Truncation is fingerprint-suffixed, so two over-long keys sharing a
      // prefix stay distinct instead of colliding into one.
      const a = dedupKeyFor({ timestamp: 1, requestId: `${long}-a`, evaluatorName: 'e' });
      const b = dedupKeyFor({ timestamp: 1, requestId: `${long}-b`, evaluatorName: 'e' });
      expect(a).not.toBe(b);
    });
  });

  it('records carrying a request id get no fingerprint (nothing added to the buffer payload)', () => {
    const sessionData = extractSessionData(
      delivery([
        {
          timestamp: 1,
          message: JSON.stringify({
            attributes: {
              'session.id': 'sess-1',
              'gen_ai.evaluation.name': 'Builtin.Correctness',
              'gen_ai.evaluation.score.value': 8,
              'aws.request_id': 'req-1',
            },
          }),
        },
      ])
    );
    expect(sessionData.evaluatorResults[0].requestId).toBe('req-1');
    expect(sessionData.evaluatorResults[0].contentHash).toBeUndefined();
  });
});

// ─── dependency-chain role scoping (TEAM-3368) ───────────────────────────────
// The custom dependency_chain_compliance evaluator is scoped to
// requirements_analyst (setup-evaluations.sh); this guard drops rows the live
// configs may still emit for other roles (config drift). FAIL-OPEN: an
// unparseable session id or a non-dep-chain evaluator never costs a record.

describe('dependency-chain role scoping (TEAM-3368)', () => {
  let extractSessionData;
  let classifySessions;
  let roleFromSessionId;
  let isOutOfScopeDepChain;

  beforeAll(async () => {
    process.env.ARTIFACTS_BUCKET ??= 'test-bucket';
    process.env.AWS_REGION ??= 'us-east-1';
    vi.resetModules();
    ({ extractSessionData, classifySessions, roleFromSessionId, isOutOfScopeDepChain } =
      await import('./index.mjs'));
  });

  const delivery = (logEvents) => ({
    logGroup: '/aws/bedrock-agentcore/evaluations/results/eval_backend_dev-test',
    logStream: 'test-stream',
    logEvents,
  });

  const otelEvent = ({ sessionId, evaluatorName, score, timestamp, attrs = {} }) => ({
    timestamp,
    message: JSON.stringify({
      attributes: {
        'session.id': sessionId,
        'gen_ai.evaluation.name': evaluatorName,
        ...(score !== undefined && score !== null ? { 'gen_ai.evaluation.score.value': score } : {}),
        ...attrs,
      },
    }),
  });

  const DEP_CHAIN_EVALUATOR = 'dependency_chain_compliance_online-mbLh2kEFhw';
  const BACKEND_SID = 'wf_1756240000000_ab12cd-agentcore_hub_backend_dev-1756240012345';
  const ANALYST_SID = 'TEAM-3201_wf_1756240000000_ab12cd-agentcore_hub_requirements_analyst-1756240012345';

  it('roleFromSessionId parses orchestrator session ids, with and without ticket prefix', () => {
    expect(
      roleFromSessionId('TEAM-3200_wf_1756240000000_ab12cd-agentcore_hub_frontend_dev-1756240012345')
    ).toBe('agentcore_hub_frontend_dev');
    expect(roleFromSessionId(BACKEND_SID)).toBe('agentcore_hub_backend_dev');
  });

  it('roleFromSessionId returns null on malformed/absent/non-workflow ids', () => {
    expect(roleFromSessionId('si-agentcore_hub_backend_dev-123')).toBe(null); // short ms suffix
    expect(roleFromSessionId('cc-b46ff2c0237e4516ab3eaefbd724f9d9')).toBe(null);
    expect(roleFromSessionId(null)).toBe(null);
    expect(roleFromSessionId('')).toBe(null);
  });

  it('isOutOfScopeDepChain fails open on a null role', () => {
    expect(
      isOutOfScopeDepChain({ evaluatorName: DEP_CHAIN_EVALUATOR, sessionId: 'si-something-123' })
    ).toBe(false);
    expect(isOutOfScopeDepChain({ evaluatorName: DEP_CHAIN_EVALUATOR, sessionId: null })).toBe(false);
  });

  it('isOutOfScopeDepChain never touches non-dep-chain evaluators, whatever the role', () => {
    expect(isOutOfScopeDepChain({ evaluatorName: 'Builtin.Correctness', sessionId: BACKEND_SID })).toBe(false);
    expect(isOutOfScopeDepChain({ evaluatorName: null, sessionId: BACKEND_SID })).toBe(false);
    expect(isOutOfScopeDepChain({ sessionId: BACKEND_SID })).toBe(false);
  });

  it('flags a dep-chain row for an out-of-scope role, keeps one for requirements_analyst', () => {
    expect(isOutOfScopeDepChain({ evaluatorName: DEP_CHAIN_EVALUATOR, sessionId: BACKEND_SID })).toBe(true);
    expect(isOutOfScopeDepChain({ evaluatorName: DEP_CHAIN_EVALUATOR, sessionId: ANALYST_SID })).toBe(false);
  });

  it('extractSessionData excludes an out-of-scope dep-chain row and leaves the rest intact', () => {
    const sessionData = extractSessionData(
      delivery([
        otelEvent({
          sessionId: BACKEND_SID,
          evaluatorName: DEP_CHAIN_EVALUATOR,
          score: 0,
          timestamp: 1,
          attrs: { 'aws.request_id': 'req-dep' },
        }),
        otelEvent({
          sessionId: BACKEND_SID,
          evaluatorName: 'Builtin.Correctness',
          score: 8,
          timestamp: 2,
          attrs: { 'aws.request_id': 'req-corr' },
        }),
      ])
    );
    expect(sessionData.evaluatorResults).toHaveLength(1);
    expect(sessionData.evaluatorResults[0]).toMatchObject({
      evaluatorName: 'Builtin.Correctness',
      score: 8,
    });
    expect(sessionData.depChainExcluded).toBe(1);
    expect(sessionData.duplicatesDropped).toBe(0); // scope removals don't count as dupes

    // Classification sees only the retained row: one scored session, no noise.
    const { statuses, total, spanMissing } = classifySessions(sessionData);
    expect(total).toBe(1);
    expect(spanMissing).toBe(0);
    expect(statuses.get(BACKEND_SID)).toBe('scored');
  });

  it('extractSessionData retains a dep-chain row for requirements_analyst', () => {
    const sessionData = extractSessionData(
      delivery([
        otelEvent({
          sessionId: ANALYST_SID,
          evaluatorName: DEP_CHAIN_EVALUATOR,
          score: 7,
          timestamp: 1,
          attrs: { 'aws.request_id': 'req-dep-ra' },
        }),
      ])
    );
    expect(sessionData.evaluatorResults).toHaveLength(1);
    expect(sessionData.evaluatorResults[0]).toMatchObject({
      evaluatorName: DEP_CHAIN_EVALUATOR,
      score: 7,
    });
    expect(sessionData.depChainExcluded).toBe(0);
  });
});

// ─── eval health metrics (TEAM-3368 §4) ──────────────────────────────────────
// emitEvalMetrics extended to Error/Throttle/Duplicate (+ DepChainExcluded) in
// the SAME single EMF record; classifySessions grows an `errors` count; the
// success-rate alarm's metric math is restated in pure JS against its JSON.

describe('eval health metrics (TEAM-3368 §4)', () => {
  let classifySessions;
  let emitEvalMetrics;
  let extractSessionData;
  let countThrottles;

  beforeAll(async () => {
    process.env.ARTIFACTS_BUCKET ??= 'test-bucket';
    process.env.AWS_REGION ??= 'us-east-1';
    vi.resetModules();
    ({ classifySessions, emitEvalMetrics, extractSessionData, countThrottles } =
      await import('./index.mjs'));
  });

  const delivery = (logEvents) => ({
    logGroup: '/aws/bedrock-agentcore/evaluations/results/eval_backend_dev-test',
    logStream: 'test-stream',
    logEvents,
  });

  const otelEvent = ({ sessionId = 'sess-1', evaluatorName = 'Builtin.Correctness', score, timestamp, attrs = {} }) => ({
    timestamp,
    message: JSON.stringify({
      attributes: {
        'session.id': sessionId,
        'gen_ai.evaluation.name': evaluatorName,
        ...(score !== undefined && score !== null ? { 'gen_ai.evaluation.score.value': score } : {}),
        ...attrs,
      },
    }),
  });

  it('one EMF record carries all metrics: counts as Count, rates as None', () => {
    emitEvalMetrics('agentcore_hub_backend_dev', {
      total: 5, spanMissing: 1, errors: 2, throttles: 3, duplicates: 4, depChainExcluded: 1,
    });
    const records = emfLines('EvalSessionsTotal');
    expect(records).toHaveLength(1);
    const [record] = records;
    const [directive] = record._aws.CloudWatchMetrics;
    expect(directive.Namespace).toBe('AgentCoreHub/Evaluations');
    expect(directive.Dimensions).toEqual([['AgentName']]);
    // TEAM-3376 adds the two dimensionless session-rate metrics; everything
    // else stays a Count.
    expect(
      directive.Metrics.every((m) => m.Unit === (m.Name.endsWith('Rate') ? 'None' : 'Count'))
    ).toBe(true);
    expect(record.EvalSessionsTotal).toBe(5);
    expect(record.EvalSessionsSpanMissing).toBe(1);
    expect(record.EvalSessionsError).toBe(2);
    expect(record.EvalThrottleCount).toBe(3);
    expect(record.EvalDuplicateResultCount).toBe(4);
    expect(record.EvalDepChainExcludedCount).toBe(1);
  });

  it('throttled delivery: throttle records count AND their session classifies error', () => {
    const sessionData = extractSessionData(
      delivery([
        otelEvent({ sessionId: 's-throttled', timestamp: 1, attrs: { 'error.type': 'ThrottlingException' } }),
        otelEvent({ sessionId: 's-throttled', evaluatorName: 'Builtin.Helpfulness', timestamp: 2, attrs: { 'error.type': 'ThrottlingException' } }),
        otelEvent({ sessionId: 's-ok', score: 0.9, timestamp: 3 }),
      ])
    );
    const { total, spanMissing, errors } = classifySessions(sessionData);
    const throttles = countThrottles(sessionData.evaluatorResults);
    expect(throttles).toBe(2);
    expect(errors).toBe(1);

    emitEvalMetrics('agentcore_hub_backend_dev', {
      total, spanMissing, errors, throttles, duplicates: sessionData.duplicatesDropped,
    });
    const [record] = emfLines('EvalSessionsTotal');
    expect(record.EvalSessionsTotal).toBe(2);
    expect(record.EvalSessionsError).toBe(1);
    expect(record.EvalThrottleCount).toBe(2);
    expect(record.EvalSessionsSpanMissing).toBe(0);
  });

  it('namespaced throttle form still counts; other error types do not', () => {
    expect(
      countThrottles([
        { errorType: 'com.amazonaws#ThrottlingException' },
        { errorType: 'ThrottlingException' },
        { errorType: 'AccessDenied' },
        { errorType: null },
        {},
      ])
    ).toBe(2);
  });

  it('duplicated delivery: duplicatesDropped flows to EvalDuplicateResultCount', () => {
    const sessionData = extractSessionData(
      delivery([
        otelEvent({ score: 8, timestamp: 1, attrs: { 'aws.request_id': 'req-dup' } }),
        otelEvent({ score: 8, timestamp: 2, attrs: { 'aws.request_id': 'req-dup' } }),
        otelEvent({ score: 8, timestamp: 3, attrs: { 'aws.request_id': 'req-dup' } }),
      ])
    );
    expect(sessionData.duplicatesDropped).toBe(2);

    const { total, spanMissing, errors } = classifySessions(sessionData);
    emitEvalMetrics('agentcore_hub_backend_dev', {
      total, spanMissing, errors, throttles: 0, duplicates: sessionData.duplicatesDropped,
    });
    const [record] = emfLines('EvalSessionsTotal');
    expect(record.EvalDuplicateResultCount).toBe(2);
  });

  it('healthy delivery emits explicit zeros for SpanMissing/Error/Throttle/Duplicate', () => {
    const sessionData = extractSessionData(
      delivery([
        otelEvent({ sessionId: 'h-1', score: 0.9, timestamp: 1, attrs: { 'aws.request_id': 'r1' } }),
        otelEvent({ sessionId: 'h-2', score: 0.7, timestamp: 2, attrs: { 'aws.request_id': 'r2' } }),
      ])
    );
    const { total, spanMissing, errors } = classifySessions(sessionData);
    emitEvalMetrics('agentcore_hub_backend_dev', {
      total, spanMissing, errors,
      throttles: countThrottles(sessionData.evaluatorResults),
      duplicates: sessionData.duplicatesDropped,
    });
    const [record] = emfLines('EvalSessionsTotal');
    expect(record.EvalSessionsTotal).toBe(2);
    expect(record.EvalSessionsSpanMissing).toBe(0);
    expect(record.EvalSessionsError).toBe(0);
    expect(record.EvalThrottleCount).toBe(0);
    expect(record.EvalDuplicateResultCount).toBe(0);
  });

  it('classifySessions counts error sessions', () => {
    const evRow = (sessionId, score, extra = {}) => ({
      timestamp: 1, sessionId, evaluatorName: 'Builtin.Correctness', score,
      errorType: null, ...extra,
    });
    const { total, spanMissing, errors } = classifySessions({
      evaluatorResults: [
        evRow('a', 0.9),
        evRow('b', null, { errorType: 'ThrottlingException' }),
        evRow('c', null, { errorType: 'JudgeTimeout' }),
        evRow('d', null),
      ],
    });
    expect(total).toBe(4);
    expect(errors).toBe(2);
    expect(spanMissing).toBe(1);
  });

  it('success-rate alarm math: healthy stays quiet, broken batch fires', () => {
    // Pure-JS restatement of eval-success-rate-alarm.json's metric math,
    // reading Threshold/operator from the JSON so drift breaks this test.
    const alarm = JSON.parse(
      readFileSync(new URL('../../deploy/evaluations/eval-success-rate-alarm.json', import.meta.url), 'utf8')
    );
    expect(alarm.AlarmName).toBe('agentcore-hub-eval-success-rate');
    expect(alarm.ComparisonOperator).toBe('LessThanThreshold');
    expect(alarm.Metrics.find((m) => m.ReturnData).Expression).toBe('(total - missing - errors) / total');

    const rate = (total, missing, errors) => (total - missing - errors) / total;
    const fires = (r) => r < alarm.Threshold;

    expect(rate(10, 0, 0)).toBe(1.0);
    expect(fires(rate(10, 0, 0))).toBe(false); // healthy batch: no fire
    expect(rate(10, 3, 4)).toBeCloseTo(0.3);
    expect(fires(rate(10, 3, 4))).toBe(true); // broken batch: 0.3 < 0.8 fires
  });
});

// ─── invokeImprover retry (TEAM-3367) ────────────────────────────────────────
// Exponential backoff with FULL jitter (base 2s, cap 60s, 3 attempts), retrying
// only transient failures, deadline-aware under the Lambda's 600s timeout.

describe('invokeImprover retry (TEAM-3367)', () => {
  let invokeImprover;
  let improverBackoffDelayMs;
  let isRetryableImproverError;

  beforeAll(async () => {
    process.env.ARTIFACTS_BUCKET ??= 'test-bucket';
    process.env.AWS_REGION ??= 'us-east-1';
    vi.resetModules();
    ({ invokeImprover, improverBackoffDelayMs, isRetryableImproverError } = await import('./index.mjs'));
  });

  const ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/improver-Test01';

  /** An attempt answered with `statusCode` and an optional SSE body. */
  const respondWith = (statusCode, body = '') => (options, callback) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    const req = {
      on() { return req; },
      write() {},
      end() {
        process.nextTick(() => {
          if (body) res.emit('data', Buffer.from(body));
          res.emit('end');
        });
      },
    };
    callback(res);
    return req;
  };

  /** An attempt that dies at the socket with `code` before any response. */
  const failSocket = (code) => (options) => {
    const handlers = {};
    const req = {
      on(evt, fn) { handlers[evt] = fn; return req; },
      write() {},
      end() {
        process.nextTick(() => {
          const err = new Error(`socket hang up`);
          err.code = code;
          handlers.error?.(err);
        });
      },
    };
    return req;
  };

  const sseBody = `data: ${JSON.stringify({ event: { contentBlockDelta: { delta: { text: 'hello' } } } })}\n\n`;

  it('retries a 5xx with full-jitter backoff, then gives up after 3 attempts', async () => {
    httpsRequest.mockImplementation(respondWith(500));
    const sleeps = [];
    const deps = { sleep: async (ms) => sleeps.push(ms), random: () => 0.5 };

    await expect(invokeImprover(ARN, 'p', 'agent-x', deps)).rejects.toThrow(/improver returned 500/);

    expect(httpsRequest).toHaveBeenCalledTimes(3);
    // random()=0.5 → half of min(60s, 2s·2^attempt): 1s before retry 1, 2s before retry 2.
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('retries a 429 throttle', async () => {
    httpsRequest.mockImplementation(respondWith(429));
    await expect(invokeImprover(ARN, 'p', 'agent-x', { sleep: async () => {}, random: () => 0 }))
      .rejects.toThrow(/improver returned 429/);
    expect(httpsRequest).toHaveBeenCalledTimes(3);
  });

  it('retries a connection reset and succeeds on the second attempt', async () => {
    httpsRequest
      .mockImplementationOnce(failSocket('ECONNRESET'))
      .mockImplementationOnce(respondWith(200, sseBody));
    const sleeps = [];

    const text = await invokeImprover(ARN, 'p', 'agent-x', { sleep: async (ms) => sleeps.push(ms), random: () => 0.5 });

    expect(text).toBe('hello');
    expect(httpsRequest).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1000]);
  });

  it('does NOT retry a 4xx validation error', async () => {
    httpsRequest.mockImplementation(respondWith(400));
    const sleep = vi.fn();

    await expect(invokeImprover(ARN, 'p', 'agent-x', { sleep })).rejects.toThrow(/improver returned 400/);

    expect(httpsRequest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('abandons a retry that could not finish inside the 520s deadline', async () => {
    httpsRequest.mockImplementation(respondWith(500));
    // start=0; by the first retry check 300s have elapsed → 300+240 > 520.
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(300_000);
    const sleep = vi.fn();

    await expect(invokeImprover(ARN, 'p', 'agent-x', { now, sleep })).rejects.toThrow(/deadline/);

    expect(httpsRequest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('backoff calculator: full jitter over min(cap, base·2^attempt)', () => {
    expect(improverBackoffDelayMs(0, () => 1)).toBe(2000);
    expect(improverBackoffDelayMs(1, () => 1)).toBe(4000);
    expect(improverBackoffDelayMs(10, () => 1)).toBe(60_000); // capped
    expect(improverBackoffDelayMs(0, () => 0)).toBe(0); // jitter floor is zero
  });

  it('classifies retryability: throttle/5xx/socket-reset yes, 4xx no', () => {
    expect(isRetryableImproverError(Object.assign(new Error('x'), { statusCode: 429 }))).toBe(true);
    expect(isRetryableImproverError(Object.assign(new Error('x'), { statusCode: 503 }))).toBe(true);
    expect(isRetryableImproverError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryableImproverError(new Error('ThrottlingException: rate exceeded'))).toBe(true);
    expect(isRetryableImproverError(Object.assign(new Error('x'), { statusCode: 400 }))).toBe(false);
    expect(isRetryableImproverError(Object.assign(new Error('x'), { statusCode: 403 }))).toBe(false);
    expect(isRetryableImproverError(new Error('improver returned empty output'))).toBe(false);
  });
});

// ─── TEAM-3376: dedup fail-open, seen-set, role guard, error split ───────────
// Layered on the TEAM-3367/3368 behavior above: rows with NO usable identity
// fail OPEN through dedup (retained + counted), a DynamoDB seen-set extends
// dedup across deliveries/concurrent invocations, and error sessions split
// into throttle/validation/generic for the EMF rate metrics.

describe('TEAM-3376: dedup fail-open + seen-set + error split (pure helpers)', () => {
  let extractSessionData;
  let checkSeenSet;
  let claimSeenSet;
  let classifySessions;
  let setSeenSetClient;
  let applyRoleGuard;

  beforeAll(async () => {
    process.env.ARTIFACTS_BUCKET ??= 'test-bucket';
    process.env.AWS_REGION ??= 'us-east-1';
    vi.resetModules();
    ({
      extractSessionData,
      checkSeenSet,
      claimSeenSet,
      classifySessions,
      setSeenSetClient,
      applyRoleGuard,
    } = await import('./index.mjs'));
  });

  afterEach(() => {
    setSeenSetClient(null); // back to the module's own (mocked) doc client
  });

  const deliveryOf = (logEvents) => ({ logGroup: LOG_GROUP, logStream: 'test-stream', logEvents });
  const otelEvent = ({ timestamp = 1_756_250_000_000, sessionId, evaluatorName = 'Builtin.Correctness', score, errorType, errorMessage, requestId }) => ({
    timestamp,
    message: JSON.stringify({
      attributes: {
        ...(sessionId ? { 'session.id': sessionId } : {}),
        ...(evaluatorName ? { 'gen_ai.evaluation.name': evaluatorName } : {}),
        ...(score !== undefined && score !== null ? { 'gen_ai.evaluation.score.value': score } : {}),
        ...(errorType ? { 'error.type': errorType } : {}),
        ...(errorMessage ? { 'error.message': errorMessage } : {}),
        ...(requestId ? { 'aws.request_id': requestId } : {}),
      },
    }),
  });

  it('fails open when every dedup-key field is null/missing: retained + counted', () => {
    const bare = (ts) => ({ timestamp: ts, message: JSON.stringify({ attributes: {} }) });
    const sessionData = extractSessionData(deliveryOf([bare(null), bare(null)]));
    expect(sessionData.evaluatorResults).toHaveLength(2);
    expect(sessionData.duplicatesDropped).toBe(0);
    expect(sessionData.dedupMissingKeyCount).toBe(2);
    expect(sessionData.evaluatorResults.every((r) => r.dedupKey === null)).toBe(true);
  });

  it('fails open on a seen-set hard error (non-conditional): record retained', async () => {
    setSeenSetClient({
      send: async () => {
        throw new Error('ProvisionedThroughputExceededException: table on fire');
      },
    });
    const sessionData = extractSessionData(
      deliveryOf([otelEvent({ sessionId: 's1', score: 8, requestId: 'req-hard-error' })])
    );
    await checkSeenSet(sessionData, AGENT_ID);
    expect(sessionData.evaluatorResults).toHaveLength(1);
    expect(sessionData.duplicatesDropped).toBe(0);
    expect(textLogs()).toContain('failed open');
  });

  it('a failing CLAIM never throws into the handler: the delivery is already durable', async () => {
    setSeenSetClient({
      send: async () => {
        throw new Error('AccessDeniedException: no PutItem on the seen table');
      },
    });
    const sessionData = extractSessionData(
      deliveryOf([otelEvent({ sessionId: 's1', score: 8, requestId: 'req-claim-denied' })])
    );
    await expect(claimSeenSet(sessionData, AGENT_ID)).resolves.toBeUndefined();
    expect(textLogs()).toContain('seen-set claim failed open');
  });

  it('dedup never flips classification: 8 duplicates of a throttled session classify like the duplicate-free delivery', () => {
    const throttledEvent = (i = 0) =>
      otelEvent({
        timestamp: 1_756_250_000_000 + i,
        sessionId: 'sess-throttled',
        score: null,
        errorType: 'ThrottlingException',
        errorMessage: 'Rate exceeded',
        requestId: 'req-2222',
      });

    const deduped = classifySessions(
      extractSessionData(deliveryOf(Array.from({ length: 9 }, (_, i) => throttledEvent(i))))
    );
    const clean = classifySessions(extractSessionData(deliveryOf([throttledEvent()])));

    expect(deduped.statuses.get('sess-throttled')).toBe('error');
    expect(deduped.total).toBe(1);
    expect(deduped.throttled).toBe(1);
    expect(deduped).toEqual(clean);
  });

  it('classifySessions splits throttled / validation / generic errors by error.type suffix, span_missing untouched', () => {
    const row = (sessionId, score, errorType = null) => ({
      sessionId,
      evaluatorName: 'Builtin.Correctness',
      score,
      errorType,
      errorMessage: null,
    });
    const { statuses, total, spanMissing, errors, throttled, validationErrors, genericErrors } =
      classifySessions({
        evaluatorResults: [
          row('s-throttled', null, 'ThrottlingException'),
          // Namespaced variant must also count as throttle.
          row('s-throttled-ns', null, 'com.amazonaws.bedrock#ThrottlingException'),
          row('s-validation', null, 'ValidationException'),
          row('s-generic', null, 'JudgeTimeout'),
          row('s-missing', null),
          row('s-scored', 9),
        ],
      });

    expect(throttled).toBe(2);
    expect(validationErrors).toBe(1);
    expect(genericErrors).toBe(1);
    expect(errors).toBe(4);
    // The coarse statuses map and span_missing/total semantics are unchanged.
    expect(statuses.get('s-throttled')).toBe('error');
    expect(statuses.get('s-validation')).toBe('error');
    expect(statuses.get('s-generic')).toBe('error');
    expect(statuses.get('s-missing')).toBe('span_missing');
    expect(statuses.get('s-scored')).toBe('scored');
    expect(total).toBe(6);
    expect(spanMissing).toBe(1);
  });

  it('applyRoleGuard drops out-of-scope dep-chain rows only, keeps siblings and in-scope rows', () => {
    const backendSid = 'TEAM-3200_wf_1756240000000_ab12cd-agentcore_hub_backend_dev-1756240012345';
    const analystSid = 'wf_1756240000000_xy34zz-agentcore_hub_requirements_analyst-1756240099999';
    const row = (sessionId, evaluatorName, score) => ({
      sessionId,
      evaluatorName,
      score,
      errorType: null,
      errorMessage: null,
    });
    const depBackend = row(backendSid, 'dependency_chain_compliance_online_v1', 2);
    const sibling = row(backendSid, 'Builtin.Correctness', 8);
    const depAnalyst = row(analystSid, 'dependency_chain_compliance_online_v1', 9);

    const guarded = applyRoleGuard([depBackend, sibling, depAnalyst]);
    expect(guarded.excluded).toBe(1);
    expect(guarded.records).toEqual([sibling, depAnalyst]);

    // The exclusion flips no session's classification.
    const after = classifySessions({ evaluatorResults: guarded.records });
    expect(after.statuses.get(backendSid)).toBe('scored');
    expect(after.total).toBe(2);
    expect(after.spanMissing).toBe(0);
  });
});

// ─── TEAM-3376: handler wiring — seen-set, dedup metrics, aggregation ────────

describe('TEAM-3376: handler wiring (seen-set dedup, EMF rates, aggregation)', () => {
  let handler;

  beforeAll(async () => {
    process.env.ARTIFACTS_BUCKET = 'agentcore-hub-artifacts-123456789012-us-east-1';
    process.env.EVAL_CONFIG_TABLE = 'agentcore-hub-eval-config';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCOUNT_ID = '123456789012';
    process.env.IMPROVEMENT_AGENT_ARN = IMPROVER_ARN;
    process.env.EVAL_SEEN_TABLE = 'agentcore-hub-eval-seen-test';
    vi.resetModules();
    ({ handler } = await import('./index.mjs'));
  });

  beforeEach(() => {
    // No flush in these tests: they assert the ingest path, not synthesis.
    ddbState.config = { ...ddbState.config, batchSize: 10 };
  });

  const aggregateWrites = () =>
    sentCommands(ddbSend, 'UpdateCommand').filter((c) => c.input.ExpressionAttributeValues?.[':scores']);
  const appendWrites = () =>
    sentCommands(ddbSend, 'UpdateCommand').filter((c) => c.input.ReturnValues === 'ALL_NEW');
  const lastEvalMetrics = () => emfLines('EvalSessionsTotal').at(-1);

  it('drops a duplicate split across two deliveries via the seen-set (1 retained overall)', async () => {
    ddbState.seenSetPersistent = true; // the fake table really remembers claims
    const event = awslogsEvent([
      evalRecord({ sessionId: 'sess-x', score: 8, scoreLabel: 'pass', requestId: 'req-shared' }),
    ]);

    await handler(event); // delivery A: check finds nothing → claimed after append
    await handler(event); // delivery B: check finds the claim → dropped

    const appends = appendWrites();
    expect(appends).toHaveLength(2);
    expect(appends[0].input.ExpressionAttributeValues[':new'][0].evaluatorResults).toHaveLength(1);
    expect(appends[1].input.ExpressionAttributeValues[':new'][0].evaluatorResults).toHaveLength(0);

    // Only delivery A claimed: B had no surviving keyed row left to claim.
    expect(ddbState.seenPuts).toHaveLength(1);
    expect(ddbState.seenPuts[0].ConditionExpression).toBe(
      'attribute_not_exists(dedupKey) OR #outcome = :error'
    );
    expect(ddbState.seenPuts[0].Item.outcome).toBe('scored');
    expect(typeof ddbState.seenPuts[0].Item.expiresAt).toBe('number');
    // Both deliveries READ the table — the check phase is what does the dropping.
    expect(ddbState.seenGets).toHaveLength(2);

    // Delivery B's EMF: the drop is counted, and rates guard divide-by-zero
    // (all rows gone → total 0 → rates 0, not NaN).
    const emf = lastEvalMetrics();
    expect(emf.EvalDuplicateResultCount).toBe(1);
    expect(emf.EvalSessionsTotal).toBe(0);
    expect(emf.EvalThrottleRate).toBe(0);
    expect(emf.EvalValidationExceptionRate).toBe(0);

    // Nothing aggregated twice: delivery B contributed no score deltas.
    expect(aggregateWrites()).toHaveLength(1);
  });

  it('aggregation deltas are identical for a clean delivery and the same delivery duplicated 8×, across handler calls', async () => {
    const rows = (prefix) => [
      { sessionId: 'sess-1', evaluatorName: 'builtin.correctness', score: 8, requestId: `${prefix}-1` },
      { sessionId: 'sess-1', evaluatorName: 'builtin.helpfulness', score: 6, requestId: `${prefix}-2` },
      { sessionId: 'sess-2', evaluatorName: 'builtin.correctness', score: 9, requestId: `${prefix}-3` },
    ];
    const toRecord = (r) =>
      evalRecord({
        sessionId: r.sessionId,
        evaluatorName: r.evaluatorName,
        score: r.score,
        scoreLabel: 'pass',
        requestId: r.requestId,
      });

    await handler(awslogsEvent(rows('a').map(toRecord)));
    const clean = aggregateWrites().at(-1).input.ExpressionAttributeValues;

    // Same shape, but every record delivered 9 times (8 injected duplicates),
    // with fresh request ids so the seen-set doesn't interfere.
    const duplicated = rows('b').flatMap((r) => Array.from({ length: 9 }, () => toRecord(r)));
    await handler(awslogsEvent(duplicated));
    const deduped = aggregateWrites().at(-1).input.ExpressionAttributeValues;

    expect(deduped[':scores']).toEqual(clean[':scores']);
    expect(deduped[':scores']).toEqual({
      'builtin.correctness': { sum: 17, count: 2 },
      'builtin.helpfulness': { sum: 6, count: 1 },
    });
    expect(deduped[':sc']).toEqual(clean[':sc']);
    expect(deduped[':statusCounts']).toEqual(clean[':statusCounts']);
  });

  it('EMF for a THROTTLED delivery: throttle rate 1, validation 0, duplicates 0', async () => {
    await handler(
      awslogsEvent([
        evalRecord({ sessionId: 'sess-t', score: null, errorType: 'ThrottlingException', errorMessage: 'Rate exceeded' }),
      ])
    );
    const emf = lastEvalMetrics();
    const [directive] = emf._aws.CloudWatchMetrics;
    expect(directive.Namespace).toBe('AgentCoreHub/Evaluations');
    expect(directive.Dimensions).toEqual([['AgentName']]);
    expect(emf.AgentName).toBe(AGENT_ID);
    expect(emf.EvalSessionsTotal).toBe(1);
    expect(emf.EvalThrottleRate).toBe(1);
    expect(emf.EvalValidationExceptionRate).toBe(0);
    expect(emf.EvalDuplicateResultCount).toBe(0);
    expect(emf.EvalSessionsError).toBe(1);
  });

  // The errorMessage matters, not just the errorType: a ValidationException whose
  // message is the missing-span text is a TELEMETRY failure and is counted under
  // EvalSessionsSpanMissing instead (TEAM-3385 finding 5, asserted below).
  it('EMF for a VALIDATION-FAILED delivery: validation rate 1, throttle 0', async () => {
    await handler(
      awslogsEvent([
        evalRecord({
          sessionId: 'sess-v',
          score: null,
          errorType: 'ValidationException',
          errorMessage: 'The value at judgeModelId failed to satisfy constraint: member must not be blank',
        }),
      ])
    );
    const emf = lastEvalMetrics();
    expect(emf.EvalSessionsTotal).toBe(1);
    expect(emf.EvalThrottleRate).toBe(0);
    expect(emf.EvalValidationExceptionRate).toBe(1);
    expect(emf.EvalDuplicateResultCount).toBe(0);
    expect(emf.EvalSessionsError).toBe(1);
    expect(emf.EvalSessionsSpanMissing).toBe(0);
  });

  it('EMF for a DUPLICATED delivery: healthy rates, dropped count surfaced', async () => {
    const nine = Array.from({ length: 9 }, () =>
      evalRecord({ sessionId: 'sess-d', score: 8, scoreLabel: 'pass', requestId: 'req-dup-emf' })
    );
    await handler(awslogsEvent(nine));
    const emf = lastEvalMetrics();
    expect(emf.EvalSessionsTotal).toBe(1);
    expect(emf.EvalThrottleRate).toBe(0);
    expect(emf.EvalValidationExceptionRate).toBe(0);
    expect(emf.EvalDuplicateResultCount).toBe(8);
    expect(emf.EvalSessionsError).toBe(0);
  });

  it('EMF for a HEALTHY delivery: all rate/duplicate metrics present and zero', async () => {
    await handler(
      awslogsEvent([
        evalRecord({ sessionId: 'sess-h1', score: 9, scoreLabel: 'pass', requestId: 'req-h1' }),
        evalRecord({ sessionId: 'sess-h2', score: 7, scoreLabel: 'pass', requestId: 'req-h2' }),
      ])
    );
    const emf = lastEvalMetrics();
    const [directive] = emf._aws.CloudWatchMetrics;
    expect(directive.Namespace).toBe('AgentCoreHub/Evaluations');
    expect(directive.Dimensions).toEqual([['AgentName']]);
    expect(directive.Metrics.map((m) => m.Name)).toContain('EvalThrottleRate');
    expect(emf.EvalSessionsTotal).toBe(2);
    expect(emf.EvalThrottleRate).toBe(0);
    expect(emf.EvalValidationExceptionRate).toBe(0);
    expect(emf.EvalDuplicateResultCount).toBe(0);
    expect(emf.EvalSessionsError).toBe(0);
  });
});

// ─── TEAM-3385: check-then-claim seen-set + keep-best dedup ──────────────────
// Two adversarial-review findings against the TEAM-3376 seen-set, fixed as one
// redesign because both change its semantics:
//   finding 2 — the claim ran BEFORE anything durable, so an invocation that
//               threw afterwards poisoned its own CloudWatch re-delivery and the
//               rows were lost for good.
//   finding 3 — first-occurrence-wins dedup on an outcome-blind key let a
//               throttled ERROR record shadow the SCORED record for the same
//               evaluation attempt, flipping the session's classification.

describe('TEAM-3385: seen-set check-then-claim + keep-best dedup', () => {
  let handler;
  let extractSessionData;
  let dedupeResults;
  let dedupeBufferedSessions;
  let classifySessions;
  let recordOutcome;

  beforeAll(async () => {
    process.env.ARTIFACTS_BUCKET = 'agentcore-hub-artifacts-123456789012-us-east-1';
    process.env.EVAL_CONFIG_TABLE = 'agentcore-hub-eval-config';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCOUNT_ID = '123456789012';
    process.env.IMPROVEMENT_AGENT_ARN = IMPROVER_ARN;
    process.env.EVAL_SEEN_TABLE = 'agentcore-hub-eval-seen-test';
    vi.resetModules();
    ({ handler, extractSessionData, dedupeResults, dedupeBufferedSessions, classifySessions, recordOutcome } =
      await import('./index.mjs'));
  });

  beforeEach(() => {
    // No flush in these tests: they assert the ingest path, not synthesis.
    ddbState.config = { ...ddbState.config, batchSize: 10 };
  });

  const appendWrites = () =>
    sentCommands(ddbSend, 'UpdateCommand').filter((c) => c.input.ReturnValues === 'ALL_NEW');
  /** The evaluator rows one appendToBuffer call carried. */
  const rowsOf = (append) => append.input.ExpressionAttributeValues[':new'][0].evaluatorResults;

  const deliveryOf = (records) => ({
    logGroup: LOG_GROUP,
    logStream: 'team-3385-stream',
    logEvents: records.map((r, i) => ({
      timestamp: 1_756_250_000_000 + i,
      message: JSON.stringify(r),
    })),
  });
  const throttled = (requestId, sessionId) =>
    evalRecord({ sessionId, score: null, errorType: 'ThrottlingException', errorMessage: 'Rate exceeded', requestId });
  const scored = (requestId, sessionId, score = 8) =>
    evalRecord({ sessionId, score, scoreLabel: 'pass', requestId });

  // ── recordOutcome ─────────────────────────────────────────────────────────
  it('recordOutcome: a score with no error is scored, an errorType is error, neither is other', () => {
    expect(recordOutcome({ score: 8, errorType: null })).toBe('scored');
    expect(recordOutcome({ score: 0, errorType: null })).toBe('scored'); // 0 is a score
    expect(recordOutcome({ score: null, errorType: 'ThrottlingException' })).toBe('error');
    // A score alongside an error is not trustworthy — the error wins.
    expect(recordOutcome({ score: 8, errorType: 'ValidationException' })).toBe('error');
    expect(recordOutcome({ score: null, errorType: null })).toBe('other');
    expect(recordOutcome({})).toBe('other');
  });

  // ── finding 3: within one delivery ────────────────────────────────────────
  it('within a delivery, a scored row beats an error row on the same key whichever order they arrive (finding 3)', () => {
    const err = throttled('req-w3', 'sess-w3');
    const ok = scored('req-w3', 'sess-w3');

    for (const order of [[err, ok], [ok, err]]) {
      const sessionData = extractSessionData(deliveryOf(order));
      expect(sessionData.evaluatorResults).toHaveLength(1);
      expect(sessionData.duplicatesDropped).toBe(1);
      expect(sessionData.evaluatorResults[0].score).toBe(8);
      expect(sessionData.evaluatorResults[0].errorType).toBeFalsy();
      // AC-3: the classification matches a delivery that held no duplicates.
      expect(classifySessions(sessionData).statuses.get('sess-w3')).toBe('scored');
    }

    // And it matches the duplicate-FREE delivery exactly, which is the invariant.
    const clean = classifySessions(extractSessionData(deliveryOf([ok])));
    expect(classifySessions(extractSessionData(deliveryOf([err, ok])))).toEqual(clean);
  });

  it('keep-best does not regress plain dedup: identical duplicates collapse first-wins, distinct rows survive', () => {
    const first = { sessionId: 's', evaluatorName: 'e', score: 8, errorType: null, dedupKey: 'k1' };
    const retry = { ...first }; // a byte-identical re-delivery
    const other = { sessionId: 's', evaluatorName: 'e2', score: 5, errorType: null, dedupKey: 'k2' };

    const kept = dedupeResults([first, retry, other]);
    expect(kept).toEqual([first, other]);
    expect(kept[0]).toBe(first); // ties → the FIRST instance is the one kept

    // A later upgrade replaces the kept row IN PLACE, so order is preserved.
    const err = { sessionId: 's', evaluatorName: 'e', score: null, errorType: 'ThrottlingException', dedupKey: 'k3' };
    const ok = { sessionId: 's', evaluatorName: 'e', score: 9, errorType: null, dedupKey: 'k3' };
    expect(dedupeResults([err, other, ok])).toEqual([ok, other]);
    // Downgrades are ignored.
    expect(dedupeResults([ok, other, err])).toEqual([ok, other]);
  });

  // ── finding 3: flush time ─────────────────────────────────────────────────
  it('at flush time the scored row wins across buffer entries, and the loser entry keeps its provenance (finding 3)', () => {
    const err = { sessionId: 's', evaluatorName: 'e', score: null, errorType: 'ThrottlingException', dedupKey: 'req|k|e' };
    const ok = { sessionId: 's', evaluatorName: 'e', score: 8, errorType: null, dedupKey: 'req|k|e' };

    const { sessions, crossDeliveryDuplicatesDropped } = dedupeBufferedSessions([
      { logStream: 'delivery-a', sessionIds: ['s'], evaluatorResults: [err] },
      { logStream: 'delivery-b', sessionIds: ['s'], evaluatorResults: [ok] },
    ]);

    expect(crossDeliveryDuplicatesDropped).toBe(1);
    expect(sessions[0].evaluatorResults).toEqual([]);
    expect(sessions[0].logStream).toBe('delivery-a'); // entry shape preserved
    expect(sessions[1].evaluatorResults).toEqual([ok]);
  });

  // ── finding 2: the claim is ordered after durable persistence ─────────────
  it('a failed buffer append claims NOTHING, so the re-delivery processes the rows in full (finding 2)', async () => {
    ddbState.seenSetPersistent = true;
    ddbState.appendFailures = 1;
    const event = awslogsEvent([scored('req-f2', 'sess-f2')]);

    await expect(handler(event)).rejects.toThrow(/ProvisionedThroughputExceeded/);

    // The check phase is read-only: the failed invocation read the table and
    // wrote nothing. Under the old claim-first ordering this was one claimed key.
    expect(ddbState.seenGets).toHaveLength(1);
    expect(ddbState.seenPuts).toEqual([]);
    expect(ddbState.seenItems.size).toBe(0);

    // CloudWatch Logs re-delivers the batch. The row must be processed, NOT
    // dropped as a "duplicate" of the invocation that failed.
    await handler(event);
    const appends = appendWrites();
    expect(appends).toHaveLength(2); // the failed attempt + the successful retry
    expect(rowsOf(appends[1])).toHaveLength(1);
    expect(rowsOf(appends[1])[0].score).toBe(8);

    // Only now, with the rows durable, is the key claimed.
    expect(ddbState.seenPuts).toHaveLength(1);
    expect(ddbState.seenPuts[0].Item.outcome).toBe('scored');
    expect(ddbState.seenPuts[0].Item.dedupKey).toMatch(/^req\|req-f2\|/);
    expect(typeof ddbState.seenPuts[0].Item.expiresAt).toBe('number');
  });

  it('the sample-rate skip still claims: the delivery was finally discarded, not deferred', async () => {
    ddbState.seenSetPersistent = true;
    ddbState.config = { ...ddbState.config, sampleRate: 0 };
    const event = awslogsEvent([scored('req-sampled', 'sess-sampled')]);

    const res = await handler(event);
    expect(res.body).toBe('sampled-out');
    expect(appendWrites()).toHaveLength(0);
    expect(ddbState.seenPuts).toHaveLength(1);
    expect(ddbState.seenPuts[0].Item.dedupKey).toMatch(/^req\|req-sampled\|/);
  });

  // ── finding 3: across deliveries, through the real seen-set ───────────────
  it('a scored record supersedes an ERROR claim from an earlier delivery; its own re-delivery is then dropped (finding 3)', async () => {
    ddbState.seenSetPersistent = true;
    const errEvent = awslogsEvent([throttled('req-x3', 'sess-x3')]);
    const okEvent = awslogsEvent([scored('req-x3', 'sess-x3')]);

    await handler(errEvent); // claims the key with outcome 'error'
    await handler(okEvent); // retained: a success supersedes an error claim
    await handler(okEvent); // now a genuine duplicate of a scored claim → dropped

    const appends = appendWrites();
    expect(appends).toHaveLength(3);
    expect(rowsOf(appends[0])).toHaveLength(1);
    expect(rowsOf(appends[0])[0].errorType).toBe('ThrottlingException');
    expect(rowsOf(appends[1])).toHaveLength(1);
    expect(rowsOf(appends[1])[0].score).toBe(8);
    expect(rowsOf(appends[2])).toHaveLength(0);

    // The stored claim was upgraded in place, error → scored.
    expect([...ddbState.seenItems.values()].map((i) => i.outcome)).toEqual(['scored']);
    // Only the scored claim asks to supersede; the error claim can't.
    expect(ddbState.seenPuts.map((p) => p.ConditionExpression)).toEqual([
      'attribute_not_exists(dedupKey)',
      'attribute_not_exists(dedupKey) OR #outcome = :error',
    ]);
  });

  it('the check phase reads with BatchGetItem — one round-trip for many rows, distinct keys only', async () => {
    ddbState.seenSetPersistent = true;
    await handler(
      awslogsEvent([
        scored('req-b1', 'sess-b1'),
        scored('req-b2', 'sess-b2'),
        scored('req-b1', 'sess-b1'), // an in-delivery duplicate of the first
      ])
    );

    expect(ddbState.seenGets).toHaveLength(1);
    // Two distinct keys, and no repeat — BatchGetItem rejects repeated keys.
    expect(ddbState.seenGets[0].keys).toHaveLength(2);
    expect(new Set(ddbState.seenGets[0].keys).size).toBe(2);
    expect(ddbState.seenGets[0].table).toBe('agentcore-hub-eval-seen-test');
  });
});

// ─── TEAM-3376: setRetryHooks injection for invokeImprover ───────────────────
// The deps-param injection is covered above (TEAM-3367); these pin the
// module-level hook layer for callers that can't thread deps through.

describe('TEAM-3376: invokeImprover setRetryHooks injection', () => {
  let invokeImprover;
  let setRetryHooks;

  beforeAll(async () => {
    process.env.ARTIFACTS_BUCKET ??= 'test-bucket';
    process.env.AWS_REGION ??= 'us-east-1';
    vi.resetModules();
    ({ invokeImprover, setRetryHooks } = await import('./index.mjs'));
  });

  /** An https.request mock that answers with `statusCode` and raw `bodyText`. */
  const respondWith = (statusCode, bodyText = '') => (options, callback) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    const req = {
      on() {
        return req;
      },
      write() {},
      end() {
        process.nextTick(() => {
          if (bodyText) res.emit('data', Buffer.from(bodyText));
          res.emit('end');
        });
      },
    };
    callback(res);
    return req;
  };
  const sseSuccess = respondWith(
    200,
    `data: ${JSON.stringify({ event: { contentBlockDelta: { delta: { text: 'the PRD' } } } })}\n\n`
  );

  it('retries a throttle (429) once with full-jitter backoff, then succeeds', async () => {
    const sleeps = [];
    setRetryHooks({
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
      now: (() => {
        let t = 0;
        return () => (t += 1000);
      })(),
    });
    httpsRequest
      .mockReset()
      .mockImplementationOnce(respondWith(429, 'data: {"message":"ThrottlingException"}\n\n'))
      .mockImplementationOnce(sseSuccess);

    const text = await invokeImprover(IMPROVER_ARN, 'synthesize', AGENT_ID);

    expect(text).toBe('the PRD');
    expect(httpsRequest).toHaveBeenCalledTimes(2);
    // One sleep, deterministic under random()=0.5: 0.5 · min(60000, 2000·2⁰) = 1000,
    // inside the first retry's full-jitter bound [0, 2000).
    expect(sleeps).toEqual([1000]);
  });

  it('never retries a non-throttle 4xx', async () => {
    const sleeps = [];
    setRetryHooks({
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
      now: () => 0,
    });
    httpsRequest.mockReset().mockImplementation(respondWith(400, ''));

    await expect(invokeImprover(IMPROVER_ARN, 'synthesize', AGENT_ID)).rejects.toThrow(
      /improver returned 400/
    );
    expect(httpsRequest).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('stops before attempt 3 when the 520s budget cannot fit another 240s attempt', async () => {
    const sleeps = [];
    // now(): start=0; before attempt 2: 100s elapsed (retry fits: 100+240 ≤ 520);
    // before attempt 3: 300s elapsed (300+240 > 520 → abandon).
    const ticks = [0, 100_000, 300_000];
    setRetryHooks({
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
      now: () => (ticks.length > 1 ? ticks.shift() : ticks[0]),
    });
    httpsRequest.mockReset().mockImplementation(respondWith(429, ''));

    await expect(invokeImprover(IMPROVER_ARN, 'synthesize', AGENT_ID)).rejects.toThrow(
      /improver retry abandoned/
    );
    expect(httpsRequest).toHaveBeenCalledTimes(2); // attempt 3 never started
    expect(sleeps).toHaveLength(1); // only the first retry slept
  });
});

// ─── TEAM-3385: span-missing classification + concurrency claims ──────────────
// Three more adversarial-review findings, all about a decision made from stale or
// unguarded state:
//   finding 5 — a missing-span failure arrives as errorType=ValidationException,
//               so classifySessions filed the fleet's single largest failure class
//               under EvalValidationExceptionRate and left EvalSessionsSpanMissing
//               at 0 while spans were still missing.
//   finding 6 — the flush's buffer reset was unconditional and the cooldown was
//               decided from a config read that is stale by the whole per-record
//               loop, so two concurrent invocations could both flush the same
//               sessions (duplicate PRD, duplicate workflow) and the second reset
//               wiped whatever was appended between the two.
//   finding 7 — the scorecard merge was a plain Get-then-Set, so two concurrent
//               deliveries raced and one delivery's score deltas vanished.

describe('TEAM-3385: span-missing classification + concurrency claims', () => {
  let handler;
  let extractSessionData;
  let classifySessions;
  let setRetryHooks;

  beforeAll(async () => {
    process.env.ARTIFACTS_BUCKET = 'agentcore-hub-artifacts-123456789012-us-east-1';
    process.env.EVAL_CONFIG_TABLE = 'agentcore-hub-eval-config';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCOUNT_ID = '123456789012';
    process.env.IMPROVEMENT_AGENT_ARN = IMPROVER_ARN;
    process.env.EVAL_SEEN_TABLE = 'agentcore-hub-eval-seen-test';
    vi.resetModules();
    ({ handler, extractSessionData, classifySessions, setRetryHooks } = await import('./index.mjs'));
  });

  beforeEach(() => {
    // Deterministic, instant retry timing for the finding-7 optimistic-locking
    // loop (the module's own hooks, same as the invokeImprover suite uses).
    setRetryHooks({ sleep: () => Promise.resolve(), random: () => 0.5 });
  });

  const deliveryOf = (records) => ({
    logGroup: LOG_GROUP,
    logStream: 'team-3385-concurrency-stream',
    logEvents: records.map((r, i) => ({
      timestamp: 1_756_260_000_000 + i,
      message: JSON.stringify(r),
    })),
  });
  const classify = (records) => classifySessions(extractSessionData(deliveryOf(records)));
  const lastEvalMetrics = () => emfLines('EvalSessionsTotal').at(-1);
  const flushClaims = () => ddbState.flushResets;
  const appendWrites = () =>
    sentCommands(ddbSend, 'UpdateCommand').filter((c) => c.input.ReturnValues === 'ALL_NEW');

  // ── finding 5: a ValidationException that is really a missing span ─────────
  it('a ValidationException carrying the missing-span message is span_missing, not a validation error', () => {
    const result = classify([
      evalRecord({
        sessionId: 'sess-ms',
        score: null,
        errorType: 'ValidationException',
        errorMessage: MISSING_SPAN_MESSAGE,
        requestId: 'req-ms-1',
      }),
    ]);

    expect(result.statuses.get('sess-ms')).toBe('span_missing');
    expect(result.spanMissing).toBe(1);
    // Excluded from EVERY error subtotal: it is a telemetry failure, and counting
    // it as a validation error is what hid the 38.4% failure class.
    expect(result.validationErrors).toBe(0);
    expect(result.throttled).toBe(0);
    expect(result.genericErrors).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.total).toBe(1);
  });

  it('a genuine ValidationException (any other message) still counts as a validation error', () => {
    const result = classify([
      evalRecord({
        sessionId: 'sess-gv',
        score: null,
        errorType: 'ValidationException',
        errorMessage: 'The value at judgeModelId failed to satisfy constraint: member must not be blank',
        requestId: 'req-gv-1',
      }),
    ]);

    expect(result.statuses.get('sess-gv')).toBe('error');
    expect(result.validationErrors).toBe(1);
    expect(result.spanMissing).toBe(0);
    expect(result.errors).toBe(1);
  });

  it('an allNull session with no errorType at all is still span_missing (unchanged)', () => {
    const result = classify([evalRecord({ sessionId: 'sess-quiet', score: null, requestId: 'req-q-1' })]);
    expect(result.statuses.get('sess-quiet')).toBe('span_missing');
    expect(result.spanMissing).toBe(1);
    expect(result.errors).toBe(0);
  });

  // Pins the documented tie-break: THROTTLE WINS. A throttled judge is a
  // plausible source of missing-span-shaped noise, the throttle is the actionable
  // signal, and it keeps `throttled` continuous with the pre-fix metric.
  it('throttle beats missing-span when a session has both rows (documented tie-break)', () => {
    const result = classify([
      evalRecord({
        sessionId: 'sess-both',
        evaluatorName: 'builtin.correctness',
        score: null,
        errorType: 'ThrottlingException',
        errorMessage: 'Rate exceeded',
        requestId: 'req-both-1',
      }),
      evalRecord({
        sessionId: 'sess-both',
        evaluatorName: 'builtin.helpfulness',
        score: null,
        errorType: 'ValidationException',
        errorMessage: MISSING_SPAN_MESSAGE,
        requestId: 'req-both-2',
      }),
    ]);

    expect(result.statuses.get('sess-both')).toBe('error');
    expect(result.throttled).toBe(1);
    expect(result.spanMissing).toBe(0);
    expect(result.validationErrors).toBe(0);
    expect(result.errors).toBe(1);
  });

  it('EMF wiring: the handler publishes the corrected span_missing / validation split', async () => {
    await handler(
      awslogsEvent([
        evalRecord({
          sessionId: 'sess-emf-ms',
          score: null,
          errorType: 'ValidationException',
          errorMessage: MISSING_SPAN_MESSAGE,
          requestId: 'req-emf-ms',
        }),
        evalRecord({
          sessionId: 'sess-emf-gv',
          score: null,
          errorType: 'ValidationException',
          errorMessage: 'judgeModelId must not be blank',
          requestId: 'req-emf-gv',
        }),
      ])
    );

    const emf = lastEvalMetrics();
    expect(emf.EvalSessionsTotal).toBe(2);
    expect(emf.EvalSessionsSpanMissing).toBe(1);
    expect(emf.EvalSessionsError).toBe(1);
    expect(emf.EvalValidationExceptionRate).toBe(0.5);
    expect(emf.EvalThrottleRate).toBe(0);
  });

  // ── finding 6: the flush claim ─────────────────────────────────────────────
  it('the losing invocation of a concurrent double-flush archives nothing and synthesizes nothing', async () => {
    ddbState.config = { ...ddbState.config, lastFlushedAt: '2026-08-27T00:00:00.000Z' };
    ddbState.stealFlushClaim = true; // a rival flushes between our read and our claim

    const result = await handler(
      awslogsEvent([evalRecord({ sessionId: 'sess-lost', score: 8, scoreLabel: 'pass', requestId: 'req-lost' })])
    );

    // It tried to claim, on exactly the value its cooldown decision was made from.
    expect(flushClaims()).toHaveLength(1);
    expect(flushClaims()[0].ConditionExpression).toBe('lastFlushedAt = :expected');
    expect(flushClaims()[0].ExpressionAttributeValues[':expected']).toBe('2026-08-27T00:00:00.000Z');

    // ...and having lost it, produced no side effects at all beyond that write.
    expect(putsUnder('fleet-imp-agent/batches/')).toEqual([]);
    expect(putsUnder('fleet-imp-agent/prd/')).toEqual([]);
    expect(httpsRequest).not.toHaveBeenCalled();
    // No batch datapoint either: a Maximum-statistic alarm on a double-counted
    // batch is a false page.
    expect(emfLines('eval.batch.null_or_error_rate')).toEqual([]);
    // The delivery itself succeeded — the rows are buffered for the winner.
    expect(result).toEqual({ statusCode: 200, body: 'ok' });

    const claimLost = jsonLogs().filter((l) => l.event === 'eval.flush.claim_lost');
    expect(claimLost).toHaveLength(1);
    expect(claimLost[0].agentId).toBe(AGENT_ID);
    expect(claimLost[0].expectedLastFlushedAt).toBe('2026-08-27T00:00:00.000Z');
  });

  it('the winning invocation still archives, meters and synthesizes (claim path unchanged)', async () => {
    const result = await handler(
      awslogsEvent([evalRecord({ sessionId: 'sess-won', score: 8, scoreLabel: 'pass', requestId: 'req-won' })])
    );

    // Never flushed before → the claim guards on absence rather than a value.
    expect(flushClaims()).toHaveLength(1);
    expect(flushClaims()[0].ConditionExpression).toBe('attribute_not_exists(lastFlushedAt)');
    expect(flushClaims()[0].ExpressionAttributeValues[':expected']).toBeUndefined();

    expect(putsUnder('fleet-imp-agent/batches/')).toHaveLength(1);
    expect(putsUnder('fleet-imp-agent/prd/')).toHaveLength(1);
    expect(emfLines('eval.batch.null_or_error_rate')).toHaveLength(1);
    expect(result).toEqual({ statusCode: 200, body: 'ok' });
    expect(jsonLogs().filter((l) => l.event === 'eval.flush.claim_lost')).toEqual([]);
  });

  // ── finding 7: the optimistic-locked scorecard merge ───────────────────────
  it('a lost version check re-reads and re-merges, so no delivery’s score deltas are dropped', async () => {
    ddbState.config = { ...ddbState.config, batchSize: 10 }; // no flush; aggregation only
    ddbState.aggPersist = true;

    await handler(
      awslogsEvent([
        evalRecord({
          sessionId: 'sess-agg-a',
          evaluatorName: 'builtin.correctness',
          score: 8,
          scoreLabel: 'pass',
          requestId: 'req-agg-a',
        }),
      ])
    );
    expect(ddbState.config.evalScores).toEqual({ 'builtin.correctness': { sum: 8, count: 1 } });
    expect(ddbState.config.evalAggVersion).toBe(1);

    // Delivery B loses the version check once. The rival's write lands first and
    // carries its own delta, which B can only preserve by RE-READING.
    ddbState.aggConflicts = 1;
    ddbState.concurrentAggDelta = { 'builtin.groundedness': { sum: 5, count: 1 } };

    await handler(
      awslogsEvent([
        evalRecord({
          sessionId: 'sess-agg-b',
          evaluatorName: 'builtin.helpfulness',
          score: 6,
          scoreLabel: 'pass',
          requestId: 'req-agg-b',
        }),
      ])
    );

    // All three deltas survive: A's, the rival's, and B's.
    expect(ddbState.config.evalScores).toEqual({
      'builtin.correctness': { sum: 8, count: 1 },
      'builtin.groundedness': { sum: 5, count: 1 },
      'builtin.helpfulness': { sum: 6, count: 1 },
    });
    expect(ddbState.config.evalSessionCount).toBe(2);
    // v1 (A) → v2 (rival) → v3 (B's retry).
    expect(ddbState.config.evalAggVersion).toBe(3);
    expect(ddbState.aggWrites).toHaveLength(2);
    expect(ddbState.aggWrites[1].ConditionExpression).toBe('evalAggVersion = :expectedVersion');
    expect(ddbState.aggWrites[1].ExpressionAttributeValues[':expectedVersion']).toBe(2);
    expect(textLogs()).toMatch(/lost the version check \(attempt 1\/3\)/);
  });

  it('the first-ever merge guards on the version being absent', async () => {
    ddbState.config = { ...ddbState.config, batchSize: 10 };

    await handler(
      awslogsEvent([evalRecord({ sessionId: 'sess-first', score: 7, scoreLabel: 'pass', requestId: 'req-first' })])
    );

    expect(ddbState.aggWrites).toHaveLength(1);
    expect(ddbState.aggWrites[0].ConditionExpression).toBe('attribute_not_exists(evalAggVersion)');
    expect(ddbState.aggWrites[0].ExpressionAttributeValues[':nextVersion']).toBe(1);
  });

  it('exhausting the aggregation retries is non-fatal: the delivery is still buffered and flushed', async () => {
    ddbState.aggConflicts = 3; // every attempt loses

    const result = await handler(
      awslogsEvent([evalRecord({ sessionId: 'sess-hot', score: 9, scoreLabel: 'pass', requestId: 'req-hot' })])
    );

    expect(ddbState.aggWrites).toEqual([]); // nothing was ever accepted
    expect(textLogs()).toMatch(/score aggregation failed after 3 contended attempts/);
    // The scorecard is a dashboard tally; the batch is the pipeline. It still ran.
    expect(appendWrites()).toHaveLength(1);
    expect(putsUnder('fleet-imp-agent/batches/')).toHaveLength(1);
    expect(result).toEqual({ statusCode: 200, body: 'ok' });
  });
});
