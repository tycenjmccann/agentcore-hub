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
function evalRecord({ sessionId, evaluatorName = 'builtin.correctness', score, scoreLabel, errorType, errorMessage }) {
  const attributes = { 'session.id': sessionId, 'gen_ai.evaluation.name': evaluatorName };
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

  it('emitEvalMetrics emits a single EMF record with all four metrics', () => {
    emitEvalMetrics('agentcore_hub_backend_dev', {
      total: 4,
      spanMissing: 0,
      resultsTotal: 12,
      resultsThrottled: 0,
    });

    const records = emfLines('EvalSessionsTotal');
    expect(records).toHaveLength(1);
    const record = records[0];
    const emf = record._aws.CloudWatchMetrics;
    // Two directives on the same record: per-agent (dashboards) plus a
    // dimensionless fleet-level rollup (alarms — SEARCH is rejected there).
    expect(emf).toHaveLength(2);
    const allMetricNames = [
      'EvalResultsThrottled',
      'EvalResultsTotal',
      'EvalSessionsSpanMissing',
      'EvalSessionsTotal',
    ];
    for (const directive of emf) {
      expect(directive.Namespace).toBe('AgentCoreHub/Evaluations');
      expect(directive.Metrics.map((m) => m.Name).sort()).toEqual(allMetricNames);
      expect(directive.Metrics.every((m) => m.Unit === 'Count')).toBe(true);
    }
    expect(emf.map((d) => d.Dimensions)).toEqual([[['AgentName']], [[]]]);
    expect(typeof record._aws.Timestamp).toBe('number');
    expect(record.AgentName).toBe('agentcore_hub_backend_dev');
    // Metric values live as top-level keys, shared by both directives.
    expect(record.EvalSessionsTotal).toBe(4);
    expect(record.EvalResultsTotal).toBe(12);
    // Explicit 0 must be emitted (healthy fleet still writes a datapoint).
    expect(record.EvalSessionsSpanMissing).toBe(0);
    expect(record.EvalResultsThrottled).toBe(0);
  });

  it('emitEvalMetrics carries non-zero spanMissing/throttled through', () => {
    emitEvalMetrics('agentcore_hub_qa_verifier', {
      total: 7,
      spanMissing: 3,
      resultsTotal: 20,
      resultsThrottled: 5,
    });
    const [record] = emfLines('EvalSessionsTotal');
    expect(record.EvalSessionsTotal).toBe(7);
    expect(record.EvalSessionsSpanMissing).toBe(3);
    expect(record.EvalResultsTotal).toBe(20);
    expect(record.EvalResultsThrottled).toBe(5);
  });

  it('emitEvalMetrics defaults the entry-level metrics to explicit zeros', () => {
    // Old call shape (no entry counts) must still write all four datapoints.
    emitEvalMetrics('agentcore_hub_backend_dev', { total: 2, spanMissing: 1 });
    const [record] = emfLines('EvalSessionsTotal');
    expect(record.EvalResultsTotal).toBe(0);
    expect(record.EvalResultsThrottled).toBe(0);
  });
});

// ─── Error classification, dedupe, N/A verdicts, throttle-aware matrix ───────
// (TEAM-3359) Fixtures mirror the VERIFIED live shapes from the results log
// group /aws/bedrock-agentcore/evaluations/results/eval_agentcore_hub_agent-*,
// inspected 2026-08-27: exact error strings, the per-tool-call throttle
// duplicate cluster, and legit distinct TOOL_CALL verdicts that share one
// timeUnixNano and score/label but differ in explanation.

describe('classifyError / isNotApplicable / dedupe / computeScoreDeltas (TEAM-3359)', () => {
  let classifyError;
  let isNotApplicable;
  let dedupeEntries;
  let computeScoreDeltas;
  let classifySessions;
  let extractSessionData;

  beforeAll(async () => {
    process.env.ARTIFACTS_BUCKET ??= 'test-bucket';
    process.env.AWS_REGION ??= 'us-east-1';
    vi.resetModules();
    ({
      classifyError,
      isNotApplicable,
      dedupeEntries,
      computeScoreDeltas,
      classifySessions,
      extractSessionData,
    } = await import('./index.mjs'));
  });

  const UUID_A = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
  const UUID_B = '11111111-2222-4333-8444-555555555555';

  /** The evaluator's verified exact strings (facts B). */
  const THROTTLE_MESSAGE = (uuid) => `Request ${uuid} is being throttled`;
  const VALIDATION_MESSAGE =
    'Evaluation failed because none of the spans contain the required agent invocation ' +
    '(gen_ai.operation.name=invoke_agent). TraceIds: [abc123def456]';
  const TOOL_SPAN_MESSAGE =
    'Failed to parse tool_output from tool-span with spanId: 0a1b2c3d4e5f6789 ' +
    'and scope: strands.telemetry.tracer';

  const delivery = (logEvents) => ({
    logGroup: '/aws/bedrock-agentcore/evaluations/results/eval_agentcore_hub_agent-wuNv8o5ZBa',
    logStream: 'eval-results-stream',
    logEvents,
  });

  /** One OTEL result logEvent as the online-evaluations service writes it. */
  const resultEvent = ({
    sessionId,
    evaluator = 'Builtin.Correctness',
    score,
    scoreLabel,
    explanation,
    errorType,
    errorMessage,
    errorFlag,
    throttleFlag,
    responseId,
    timeUnixNano = 1756250000000000000,
    timestamp = 1756250000000,
  }) => {
    const attributes = { 'session.id': sessionId, 'gen_ai.evaluation.name': evaluator };
    if (score !== undefined) attributes['gen_ai.evaluation.score.value'] = score;
    if (scoreLabel !== undefined) attributes['gen_ai.evaluation.score.label'] = scoreLabel;
    if (explanation !== undefined) attributes['gen_ai.evaluation.explanation'] = explanation;
    if (errorType) attributes['error.type'] = errorType;
    if (errorMessage) attributes['error.message'] = errorMessage;
    if (errorFlag !== undefined) attributes['error'] = errorFlag;
    if (throttleFlag !== undefined) attributes['throttle'] = throttleFlag;
    if (responseId) attributes['gen_ai.response.id'] = responseId;
    return {
      timestamp,
      message: JSON.stringify({
        traceId: 'trace-0001',
        name: 'gen_ai.evaluation.result',
        timeUnixNano,
        attributes,
      }),
    };
  };

  /** A throttled result entry, verified shape: throttle:1, error:0, no score. */
  const throttledEvent = (sessionId, uuid, extra = {}) =>
    resultEvent({
      sessionId,
      errorType: 'ThrottlingException',
      errorMessage: THROTTLE_MESSAGE(uuid),
      errorFlag: 0,
      throttleFlag: 1,
      ...extra,
    });

  describe('classifyError — one row per verified live error string', () => {
    it('ThrottlingException + throttle message → throttled', () => {
      expect(classifyError('ThrottlingException', THROTTLE_MESSAGE(UUID_A))).toBe('throttled');
    });

    it('ThrottlingException named only in the message → throttled', () => {
      expect(classifyError(null, 'ThrottlingException: rate exceeded')).toBe('throttled');
    });

    it('ValidationException + invoke_agent message → span_missing_validation', () => {
      expect(classifyError('ValidationException', VALIDATION_MESSAGE)).toBe(
        'span_missing_validation'
      );
    });

    it('ToolSpanMappingException → tool_span_mapping', () => {
      expect(classifyError('ToolSpanMappingException', TOOL_SPAN_MESSAGE)).toBe(
        'tool_span_mapping'
      );
    });

    it('ValidationException WITHOUT invoke_agent → other, never span_missing', () => {
      expect(classifyError('ValidationException', 'payload too large')).toBe('other');
    });

    it('any other non-null errorType → other', () => {
      expect(classifyError('InternalServerException', 'judge crashed')).toBe('other');
    });

    it('no error attributes → null', () => {
      expect(classifyError(null, null)).toBe(null);
      expect(classifyError(undefined, undefined)).toBe(null);
    });
  });

  describe('isNotApplicable', () => {
    it('matches the NotApplicable label variants', () => {
      expect(isNotApplicable({ scoreLabel: 'NotApplicable' })).toBe(true);
      expect(isNotApplicable({ scoreLabel: 'not_applicable' })).toBe(true);
      expect(isNotApplicable({ scoreLabel: 'Not Applicable' })).toBe(true);
      expect(isNotApplicable({ scoreLabel: 'not-applicable' })).toBe(true);
    });

    it('matches the numerical rubric sentinel score 2.0', () => {
      expect(isNotApplicable({ score: 2 })).toBe(true);
    });

    it('matches the NOT_APPLICABLE explanation sentinel', () => {
      expect(isNotApplicable({ evidence: 'NOT_APPLICABLE: run has no dependencies' })).toBe(true);
    });

    it('does not match real verdicts', () => {
      expect(isNotApplicable({ score: 1, scoreLabel: 'Yes', evidence: 'good' })).toBe(false);
      expect(isNotApplicable({ score: 0 })).toBe(false);
      expect(isNotApplicable({ scoreLabel: 'notably_applicable_rule' })).toBe(false);
    });
  });

  describe('per-delivery dedupe (the F4 throttle-cluster defect)', () => {
    it('collapses a 10-entry throttle cluster (one request uuid) to exactly one buffered entry', () => {
      const cluster = Array.from({ length: 10 }, () => throttledEvent('sess-c', UUID_A));
      const sessionData = extractSessionData(delivery(cluster));
      expect(sessionData.evaluatorResults).toHaveLength(1);
      // The key is stamped on the survivor for auditability.
      expect(sessionData.evaluatorResults[0].dedupeKey).toBe(
        `sess-c|Builtin.Correctness|req:${UUID_A}`
      );

      // Scorecard deltas identical to the 1-entry case (never double-counted).
      const many = computeScoreDeltas(delivery(cluster).logEvents);
      const one = computeScoreDeltas([throttledEvent('sess-c', UUID_A)]);
      expect(many.scoreDeltas).toEqual(one.scoreDeltas);

      // Entry counts see the cluster once, not ten times.
      const c = classifySessions(sessionData);
      expect(c.resultsTotal).toBe(1);
      expect(c.resultsThrottled).toBe(1);
    });

    it('does NOT collapse throttled entries with distinct request uuids', () => {
      const sessionData = extractSessionData(
        delivery([throttledEvent('sess-d', UUID_A), throttledEvent('sess-d', UUID_B)])
      );
      expect(sessionData.evaluatorResults).toHaveLength(2);
      expect(classifySessions(sessionData).resultsThrottled).toBe(2);
    });

    it('does NOT collapse legit distinct TOOL_CALL verdicts differing only in explanation', () => {
      // Verified fact D: same (session, evaluator), ONE timeUnixNano, identical
      // "Yes"/1.0 — only the explanation differs. Both must survive.
      const events = [
        resultEvent({
          sessionId: 'sess-tc',
          evaluator: 'Builtin.ToolSelectionAccuracy',
          score: 1.0,
          scoreLabel: 'Yes',
          explanation: 'Tool call 1: file_list was the correct tool for enumerating the repo.',
        }),
        resultEvent({
          sessionId: 'sess-tc',
          evaluator: 'Builtin.ToolSelectionAccuracy',
          score: 1.0,
          scoreLabel: 'Yes',
          explanation: 'Tool call 2: file_read was the correct tool for inspecting the diff.',
        }),
      ];
      const sessionData = extractSessionData(delivery(events));
      expect(sessionData.evaluatorResults).toHaveLength(2);

      const { scoreDeltas } = computeScoreDeltas(events);
      expect(scoreDeltas['Builtin.ToolSelectionAccuracy']).toMatchObject({ sum: 2, count: 2 });
    });

    it('collapses true content duplicates via the sha1 fallback (no request id)', () => {
      const twin = () =>
        resultEvent({
          sessionId: 'sess-x',
          score: 1.0,
          scoreLabel: 'Yes',
          explanation: 'Identical verdict text.',
        });
      const sessionData = extractSessionData(delivery([twin(), twin()]));
      expect(sessionData.evaluatorResults).toHaveLength(1);
      expect(sessionData.evaluatorResults[0].dedupeKey).toMatch(/^sha1:[0-9a-f]{40}$/);
    });

    it('never drops unparseable rows (no identity to hash)', () => {
      const entries = [
        { timestamp: 1, rawMessage: 'START RequestId: abc', parseError: true },
        { timestamp: 1, rawMessage: 'START RequestId: abc', parseError: true },
      ];
      expect(dedupeEntries(entries)).toHaveLength(2);
    });
  });

  describe('computeScoreDeltas (scorecard aggregation without DDB)', () => {
    it('hasError regression: a throttled entry carrying a numeric-looking score never enters sum/count', () => {
      const { scoreDeltas } = computeScoreDeltas([
        throttledEvent('sess-h', UUID_A, { score: 0.9 }),
      ]);
      expect(scoreDeltas).toEqual({});
    });

    it('N/A rows increment naCount only; other evaluators in the same delivery aggregate normally', () => {
      const events = [
        resultEvent({
          sessionId: 'sess-na',
          evaluator: 'Custom.DependencyChain',
          score: 2,
          scoreLabel: 'NotApplicable',
          explanation: 'NOT_APPLICABLE: run has no upstream dependencies.',
        }),
        resultEvent({
          sessionId: 'sess-na',
          evaluator: 'Custom.DependencyChain',
          score: 2,
          scoreLabel: 'NotApplicable',
          explanation: 'NOT_APPLICABLE: nothing to verify for this tool call.',
        }),
        resultEvent({
          sessionId: 'sess-scored',
          evaluator: 'Builtin.Correctness',
          score: 0.8,
          scoreLabel: 'Yes',
          explanation: 'The agent addressed the ticket.',
        }),
      ];
      const { scoreDeltas } = computeScoreDeltas(events);
      expect(scoreDeltas['Custom.DependencyChain']).toEqual({ sum: 0, count: 0, naCount: 2 });
      expect(scoreDeltas['Builtin.Correctness']).toMatchObject({ sum: 0.8, count: 1 });
    });

    it('maps categorical Correct/Partial/Failed labels only when score.value is absent — never Yes/No', () => {
      const { scoreDeltas } = computeScoreDeltas([
        resultEvent({ sessionId: 's', evaluator: 'Custom.Rubric', scoreLabel: 'Correct', explanation: 'a' }),
        resultEvent({ sessionId: 's', evaluator: 'Custom.Rubric', scoreLabel: 'Partial', explanation: 'b' }),
        resultEvent({ sessionId: 's', evaluator: 'Custom.Rubric', scoreLabel: 'Failed', explanation: 'c' }),
        resultEvent({ sessionId: 's', evaluator: 'Custom.YesNo', scoreLabel: 'Yes', explanation: 'd' }),
      ]);
      expect(scoreDeltas['Custom.Rubric']).toMatchObject({ sum: 1.5, count: 3 });
      // A bare Yes label has no defined numeric meaning — it must not aggregate.
      expect(scoreDeltas['Custom.YesNo']).toBeUndefined();
    });

    it('a delivered score.value wins over any categorical label', () => {
      const { scoreDeltas } = computeScoreDeltas([
        resultEvent({ sessionId: 's', evaluator: 'Custom.Rubric', score: 0.25, scoreLabel: 'Correct', explanation: 'e' }),
      ]);
      expect(scoreDeltas['Custom.Rubric']).toMatchObject({ sum: 0.25, count: 1 });
    });
  });

  describe('classifySessions — six-row first-match-wins matrix', () => {
    it('all-throttled session → throttled, not span_missing; resultsThrottled === resultsTotal', () => {
      const sessionData = extractSessionData(
        delivery([throttledEvent('sess-t', UUID_A), throttledEvent('sess-t', UUID_B)])
      );
      const c = classifySessions(sessionData);
      expect(c.statuses.get('sess-t')).toBe('throttled');
      expect(c.total).toBe(1);
      expect(c.spanMissing).toBe(0);
      expect(c.throttled).toBe(1);
      expect(c.resultsTotal).toBe(2);
      expect(c.resultsThrottled).toBe(c.resultsTotal);
    });

    it('mixed throttled + scored → scored; throttled entries still counted in resultsThrottled', () => {
      const sessionData = extractSessionData(
        delivery([
          throttledEvent('sess-m', UUID_A),
          resultEvent({
            sessionId: 'sess-m',
            evaluator: 'Builtin.Helpfulness',
            score: 0.75,
            scoreLabel: 'Yes',
            explanation: 'Helped with the task.',
          }),
        ])
      );
      const c = classifySessions(sessionData);
      expect(c.statuses.get('sess-m')).toBe('scored');
      expect(c.throttled).toBe(0);
      expect(c.resultsTotal).toBe(2);
      expect(c.resultsThrottled).toBe(1);
    });

    it('all-N/A session with no errors → na (not span_missing, not error)', () => {
      const sessionData = extractSessionData(
        delivery([
          resultEvent({
            sessionId: 'sess-n',
            evaluator: 'Custom.DependencyChain',
            score: 2,
            scoreLabel: 'NotApplicable',
            explanation: 'NOT_APPLICABLE: no dependencies declared.',
          }),
        ])
      );
      const c = classifySessions(sessionData);
      expect(c.statuses.get('sess-n')).toBe('na');
      expect(c.na).toBe(1);
      expect(c.spanMissing).toBe(0);
    });

    it('N/A + throttled mix → throttled (the throttle hid real work)', () => {
      const sessionData = extractSessionData(
        delivery([
          resultEvent({
            sessionId: 'sess-nt',
            evaluator: 'Custom.DependencyChain',
            score: 2,
            scoreLabel: 'NotApplicable',
            explanation: 'NOT_APPLICABLE: nothing to check.',
          }),
          throttledEvent('sess-nt', UUID_A),
        ])
      );
      const c = classifySessions(sessionData);
      expect(c.statuses.get('sess-nt')).toBe('throttled');
      expect(c.na).toBe(0);
    });

    it('ValidationException + invoke_agent message → span_missing', () => {
      const sessionData = extractSessionData(
        delivery([
          resultEvent({
            sessionId: 'sess-v',
            errorType: 'ValidationException',
            errorMessage: VALIDATION_MESSAGE,
            errorFlag: 1,
          }),
        ])
      );
      const c = classifySessions(sessionData);
      expect(c.statuses.get('sess-v')).toBe('span_missing');
      expect(c.spanMissing).toBe(1);
    });

    it('ToolSpanMappingException → error', () => {
      const sessionData = extractSessionData(
        delivery([
          resultEvent({
            sessionId: 'sess-ts',
            errorType: 'ToolSpanMappingException',
            errorMessage: TOOL_SPAN_MESSAGE,
            errorFlag: 1,
          }),
        ])
      );
      const c = classifySessions(sessionData);
      expect(c.statuses.get('sess-ts')).toBe('error');
      expect(c.spanMissing).toBe(0);
    });
  });
});
