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
function evalRecord({ sessionId, evaluatorName = 'builtin.correctness', score, scoreLabel, errorType, errorMessage, requestId }) {
  const attributes = { 'session.id': sessionId, 'gen_ai.evaluation.name': evaluatorName };
  if (requestId) attributes['aws.request_id'] = requestId;
  if (score !== undefined && score !== null) attributes['gen_ai.evaluation.score.value'] = score;
  if (scoreLabel) attributes['gen_ai.evaluation.score.label'] = scoreLabel;
  if (score !== undefined && score !== null) {
    attributes['gen_ai.evaluation.explanation'] = 'The agent addressed the ticket.';
  }
  if (errorType) attributes['error.type'] = errorType;
  if (errorMessage) attributes['error.message'] = errorMessage;
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
  };

  ddbSend.mockReset();
  ddbSend.mockImplementation(async (cmd) => {
    const name = cmd.constructor.name;
    if (name === 'GetCommand') return { Item: ddbState.config };
    if (name === 'UpdateCommand') {
      // appendToBuffer asks for ALL_NEW; mirror DDB's list_append so the flush
      // sees the delivery that was just appended.
      if (cmd.input.ReturnValues === 'ALL_NEW') {
        const appended = cmd.input.ExpressionAttributeValues[':new'] || [];
        return {
          Attributes: {
            sessionBuffer: [...ddbState.priorBuffer, ...appended],
            bufferSessions: ddbState.bufferSessions,
          },
        };
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

  beforeAll(async () => {
    // index.mjs reads all of this at MODULE scope and throws without a bucket,
    // so it must be set before the dynamic import.
    process.env.ARTIFACTS_BUCKET = 'agentcore-hub-artifacts-123456789012-us-east-1';
    process.env.EVAL_CONFIG_TABLE = 'agentcore-hub-eval-config';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ACCOUNT_ID = '123456789012';
    process.env.IMPROVEMENT_AGENT_ARN = IMPROVER_ARN;
    vi.resetModules();
    ({ handler } = await import('./index.mjs'));
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

  it('one EMF record carries all metrics with Count units', () => {
    emitEvalMetrics('agentcore_hub_backend_dev', {
      total: 5, spanMissing: 1, errors: 2, throttles: 3, duplicates: 4, depChainExcluded: 1,
    });
    const records = emfLines('EvalSessionsTotal');
    expect(records).toHaveLength(1);
    const [record] = records;
    const [directive] = record._aws.CloudWatchMetrics;
    expect(directive.Namespace).toBe('AgentCoreHub/Evaluations');
    expect(directive.Dimensions).toEqual([['AgentName']]);
    expect(directive.Metrics.every((m) => m.Unit === 'Count')).toBe(true);
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
