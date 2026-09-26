// Hermetic unit tests for the token-aggregator's record parsing + bucketing.
// No AWS: the module's clients are constructed but never sent to here.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// The model modes (TEAM-4995) are stubbed out: this file's job is the ROUTING —
// that `{"mode":"reconcile"}` reaches the reconcile instead of being swallowed by
// the "no awslogs data" early return. `./models-deps.mjs` is mocked as well
// because the real one imports the Bedrock/Pricing/AgentCore SDKs, which are
// dependencies of the Lambda's own package.json and not of the repo root.
const { reconcileModels, probeModel, buildDeps } = vi.hoisted(() => ({
  reconcileModels: vi.fn(async () => ({ outcome: 'ok', added: 0 })),
  probeModel: vi.fn(async () => ({ statusCode: 200, ok: true })),
  buildDeps: vi.fn(async () => ({ marker: 'deps' })),
}));
vi.mock('./models-reconcile.mjs', () => ({ reconcileModels }));
vi.mock('./models-probe.mjs', () => ({ probeModel }));
vi.mock('./models-deps.mjs', () => ({ buildDeps }));

let mod;
beforeAll(async () => {
  process.env.ARTIFACTS_BUCKET = 'test-bucket';
  mod = await import('./index.mjs');
});

const strandsSpan = (attrs, extra = {}) =>
  JSON.stringify({
    scope: { name: 'strands.telemetry.tracer', version: '' },
    traceId: 't', spanId: 's', name: 'chat', kind: 'INTERNAL',
    endTimeUnixNano: Date.UTC(2026, 8, 7, 18, 28, 55) * 1e6,
    attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'us.anthropic.claude-fable-5-1', ...attrs },
    ...extra,
  });

const botocoreSpan = () =>
  JSON.stringify({
    scope: { name: 'opentelemetry.instrumentation.botocore.bedrock-runtime' },
    spanId: 'b', name: 'chat us.anthropic.claude-fable-5-1',
    endTimeUnixNano: Date.UTC(2026, 8, 7) * 1e6,
    attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 2, 'gen_ai.usage.output_tokens': 282 },
  });

const emf = (type, sum, count = 1) =>
  JSON.stringify({
    _aws: { Timestamp: Date.UTC(2026, 8, 6, 23, 59), CloudWatchMetrics: [] },
    'gen_ai.client.token.usage': { Sum: sum, Count: count },
    'gen_ai.request.model': 'us.anthropic.claude-opus-4-8',
    'gen_ai.token.type': type,
  });

const ccEvent = (attrs) =>
  JSON.stringify({
    body: 'claude_code.api_request',
    timeUnixNano: Date.UTC(2026, 8, 7, 1) * 1e6,
    attributes: { 'event.name': 'api_request', model: 'claude-opus-4-8', ...attrs },
  });

describe('parseUsageRecord', () => {
  it('reads the cache-inclusive Strands chat span', () => {
    const r = mod.parseUsageRecord(strandsSpan({
      'gen_ai.usage.input_tokens': 208625,
      'gen_ai.usage.output_tokens': 282,
      'gen_ai.usage.cache_read_input_tokens': 206580,
      'gen_ai.usage.cache_write_input_tokens': 2043,
      'hub.cache_ttl': '1h',
    }));
    expect(r).toMatchObject({ kind: 'span', input: 208625, output: 282, cacheRead: 206580, cacheWrite: 2043, cacheWrite1h: 2043, calls: 1 });
    expect(mod.dayKey(r.ts)).toBe('2026-09-07');
  });

  it('adds cache tokens when the span reports only the uncached remainder', () => {
    const r = mod.parseUsageRecord(strandsSpan({
      'gen_ai.usage.input_tokens': 4, 'gen_ai.usage.cache_read_input_tokens': 56703, 'gen_ai.usage.cache_write_input_tokens': 2623,
    }));
    expect(r.input).toBe(59330);
    expect(r.cacheWrite1h).toBe(0);
  });

  it('skips botocore chat spans and invoke_agent roll-ups', () => {
    expect(mod.parseUsageRecord(botocoreSpan())).toBeNull();
    expect(mod.parseUsageRecord(strandsSpan({ 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.usage.input_tokens': 8200407 }, { name: 'invoke_agent x' }))).toBeNull();
  });

  it('reads EMF metric records (harnesses) and counts calls on the input record', () => {
    expect(mod.parseUsageRecord(emf('input', 115046, 5))).toMatchObject({ kind: 'metric', input: 115046, output: 0, calls: 5, model: 'us.anthropic.claude-opus-4-8' });
    expect(mod.parseUsageRecord(emf('output', 1333, 5))).toMatchObject({ input: 0, output: 1333, calls: 0 });
    expect(mod.parseUsageRecord(emf('cache_read', 10))).toBeNull();
  });

  it('reads Claude Code api_request events with full input', () => {
    const r = mod.parseUsageRecord(ccEvent({ input_tokens: 12, output_tokens: 25, cache_read_tokens: 50000, cache_creation_tokens: 1000, cost_usd: 0.01054 }));
    expect(r).toMatchObject({ kind: 'cc', input: 51012, output: 25, cacheRead: 50000, cacheWrite: 1000, costUsd: 0.01054, model: 'claude-opus-4-8' });
  });

  // TEAM-5159: the coding-runtime OTel collector's transform/normalize now also
  // copies Claude Code's cache_read_tokens/cache_creation_tokens down to the flat
  // gen_ai.usage.cache_*_input_tokens names (deploy/coding-agent-runtime/
  // otel-collector-config.yaml). This pins that this reader's `??` fallback still
  // resolves cache tokens when an event carries ONLY the normalized names — the
  // shape events emit going forward — not just the raw Claude Code names above.
  it('reads Claude Code api_request events normalized to gen_ai.usage.* names', () => {
    const r = mod.parseUsageRecord(ccEvent({
      'gen_ai.usage.input_tokens': 12, 'gen_ai.usage.output_tokens': 25,
      'gen_ai.usage.cache_read_input_tokens': 50000, 'gen_ai.usage.cache_write_input_tokens': 1000,
      'gen_ai.usage.cost': 0.01054, 'gen_ai.request.model': 'claude-opus-4-8',
    }));
    expect(r).toMatchObject({ kind: 'cc', input: 51012, output: 25, cacheRead: 50000, cacheWrite: 1000, costUsd: 0.01054, model: 'claude-opus-4-8' });
  });

  it('ignores non-usage lines', () => {
    expect(mod.parseUsageRecord('plain text')).toBeNull();
    expect(mod.parseUsageRecord('{"foo":1}')).toBeNull();
    expect(mod.parseUsageRecord(strandsSpan({}))).toBeNull();
  });
});

// TEAM-5152: codex usage reached neither cost total. The records sit in the EC2
// coding runtime's log group wrapped as {"log":"<json>"}; this is the same
// real-data fixture the cost-report tests bill.
const CODEX_5038 = JSON.parse(readFileSync(new URL('../cost-report/fixtures/codex-5038-usage.json', import.meta.url), 'utf8'));
const codingUsage = (fields) => JSON.stringify({
  timestamp: '2026-09-25T20:58:56.609Z', level: 'INFO', logger: 'coding-agent-runtime', message: 'coding_usage', ...fields,
});

describe('parseUsageRecord — codex coding_usage (TEAM-5152)', () => {
  it('reads a {"log":…}-wrapped codex record; input already includes cached', () => {
    const r = mod.parseUsageRecord(CODEX_5038.messages[2]);
    expect(r).toMatchObject({
      kind: 'coding', model: 'us.openai.gpt-5.6-terra', input: 99552, output: 2526, cacheRead: 78809,
      cacheWrite: 0, cacheWrite1h: 0, costUsd: 0, calls: 1,
    });
    expect(r.ts).toBe(Date.parse('2026-09-25T20:58:56.609Z'));
  });

  it('reads the same record unwrapped (microVM runtime)', () => {
    const inner = JSON.parse(CODEX_5038.messages[2]).log;
    expect(mod.parseUsageRecord(inner)).toEqual(mod.parseUsageRecord(CODEX_5038.messages[2]));
  });

  it('peels the wrapper off Claude Code events too', () => {
    const wrapped = JSON.stringify({ log: ccEvent({ input_tokens: 12, output_tokens: 25, cache_read_tokens: 50000 }) });
    expect(mod.parseUsageRecord(wrapped)).toMatchObject({ kind: 'cc', input: 50012, output: 25, cacheRead: 50000 });
  });

  it('skips kiro credit-only records, other app logs and junk wrappers', () => {
    expect(mod.parseUsageRecord(codingUsage({ cli: 'kiro', coding_session_id: 'cc-k', model: 'auto', credits: 3 }))).toBeNull();
    expect(mod.parseUsageRecord(JSON.stringify({ log: JSON.stringify({ message: 'turn_done', cli: 'codex' }) }))).toBeNull();
    expect(mod.parseUsageRecord(JSON.stringify({ log: 'plain stdout line' }))).toBeNull();
    expect(mod.parseUsageRecord(JSON.stringify({ log: '{not json' }))).toBeNull();
  });

  it('buckets the wf_bug_TEAM-5038 codex session by day and model with no double-counted cache', () => {
    const byDay = mod.aggregateLogEvents(CODEX_5038.messages.map((message) => ({ message })));
    expect(Object.keys(byDay)).toEqual(['2026-09-25']);
    expect(byDay['2026-09-25']['us.openai.gpt-6-astra']).toMatchObject({ input: 5528650, output: 29662, cacheRead: 5278693, calls: 2 });
    expect(byDay['2026-09-25']['us.openai.gpt-5.6-terra']).toMatchObject({ input: 99552, output: 2526, cacheRead: 78809, calls: 1 });
    const expr = mod.buildAddExpression('2026-09-25', byDay['2026-09-25'], 'now');
    expect(expr.ExpressionAttributeValues[':t_input']).toBe(5628202);
    expect(expr.ExpressionAttributeValues[':t_cacheRead']).toBe(5357502);
  });
});

describe('aggregateLogEvents', () => {
  it('buckets by UTC day and model', () => {
    const byDay = mod.aggregateLogEvents([
      { message: strandsSpan({ 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 10 }) },
      { message: strandsSpan({ 'gen_ai.usage.input_tokens': 50, 'gen_ai.usage.output_tokens': 5, 'gen_ai.request.model': 'us.anthropic.claude-sonnet-5' }) },
      { message: emf('input', 999) }, // 09-06, but dropped: spans present in batch
      { message: ccEvent({ input_tokens: 7, output_tokens: 3 }) },
    ]);
    expect(Object.keys(byDay)).toEqual(['2026-09-07']);
    expect(byDay['2026-09-07']['us.anthropic.claude-fable-5-1']).toMatchObject({ input: 100, output: 10, calls: 1 });
    expect(byDay['2026-09-07']['us.anthropic.claude-sonnet-5']).toMatchObject({ input: 50, output: 5 });
    expect(byDay['2026-09-07']['claude-opus-4-8']).toMatchObject({ input: 7, output: 3 });
  });

  it('keeps EMF metrics when no spans are in the batch', () => {
    const byDay = mod.aggregateLogEvents([{ message: emf('input', 100, 2) }, { message: emf('output', 9, 2) }]);
    expect(byDay['2026-09-06']['us.anthropic.claude-opus-4-8']).toMatchObject({ input: 100, output: 9, calls: 2 });
  });
});

describe('buildAddExpression', () => {
  it('adds per-model and bucket totals in one ADD clause on flat attribute names', () => {
    const expr = mod.buildAddExpression('2026-09-07', {
      'us.anthropic.claude-fable-5-1': { ...mod.zeroModel(), input: 100, output: 10, cacheRead: 80, calls: 1 },
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0': { ...mod.zeroModel(), input: 7, output: 3, costUsd: 0.5, calls: 1 },
    }, 'now');
    expect(expr.empty).toBe(false);
    expect(expr.UpdateExpression).toMatch(/^SET #updatedAt = :now ADD /);
    expect(expr.UpdateExpression).toContain('#m0_input :m0_input');
    expect(expr.UpdateExpression).toContain('#t_input :t_input');
    expect(expr.UpdateExpression).not.toContain(':t_cacheWrite1h'); // zero deltas omitted
    // Only placeholders in the expression: `input` is a DynamoDB reserved word.
    expect(expr.UpdateExpression).not.toMatch(/\b(input|output|tokensIn|calls)\b/);
    expect(expr.ExpressionAttributeNames).toMatchObject({
      '#t_input': 'tokensIn', '#t_output': 'tokensOut', '#t_cacheRead': 'cacheRead', '#t_calls': 'calls',
      '#m0_input': 'm|us.anthropic.claude-fable-5-1|input',
      '#m1_costUsd': 'm|us.anthropic.claude-sonnet-4-5-20250929-v1:0|costUsd',
    });
    expect(expr.ExpressionAttributeValues[':t_input']).toBe(107);
    expect(expr.ExpressionAttributeValues[':t_calls']).toBe(2);
  });

  it('stamps no TTL — day buckets are permanent', () => {
    const expr = mod.buildAddExpression('2026-09-07', {
      'us.anthropic.claude-fable-5-1': { ...mod.zeroModel(), input: 100, calls: 1 },
    }, 'now');
    expect(expr.UpdateExpression).not.toContain(':ttl');
    expect(expr.UpdateExpression).not.toContain('#expiresAt');
    expect(expr.ExpressionAttributeNames).not.toHaveProperty('#expiresAt');
    expect(expr.ExpressionAttributeValues).not.toHaveProperty(':ttl');
    expect(mod.expiresAtFor).toBeUndefined();
  });
});

describe('resolveAgentId', () => {
  it('matches runtime and harness log groups, longest id first', () => {
    const agents = [{ agentId: 'agentcore_hub_agent' }, { agentId: 'agentcore_hub_agent_x' }, { agentId: 'personal_assistant_agent' }];
    expect(mod.resolveAgentId('/aws/bedrock-agentcore/runtimes/agentcore_hub_agent-ITPP0eBToO-DEFAULT', agents)).toBe('agentcore_hub_agent');
    expect(mod.resolveAgentId('/aws/bedrock-agentcore/runtimes/agentcore_hub_agent_x-abc-DEFAULT', agents)).toBe('agentcore_hub_agent_x');
    expect(mod.resolveAgentId('/aws/bedrock-agentcore/runtimes/harness_personal_assistant_agent-nQbmlnB3cI-DEFAULT', agents)).toBe('personal_assistant_agent');
    expect(mod.resolveAgentId('/aws/bedrock-agentcore/runtimes/FixItAgent_Agent-96xckb2RqK-DEFAULT', agents)).toBeNull();
  });

  it('books both coding runtimes (microVM and _ec2 Instances) to the one coding agent row', () => {
    const agents = [{ agentId: 'agentcore_hub_coding_runtime' }, { agentId: 'agentcore_hub_agent' }];
    expect(mod.resolveAgentId('/aws/bedrock-agentcore/runtimes/agentcore_hub_coding_runtime-infasNCWad-DEFAULT', agents)).toBe('agentcore_hub_coding_runtime');
    expect(mod.resolveAgentId('/aws/bedrock-agentcore/runtimes/agentcore_hub_coding_runtime_ec2-C56zwJ3QQ5-DEFAULT', agents)).toBe('agentcore_hub_coding_runtime');
    expect(mod.resolveAgentId('/aws/bedrock-agentcore/runtimes/agentcore_hub_coding_runtime_ec3-x-DEFAULT', agents)).toBeNull();
  });
});

describe('handler routing', () => {
  it('routes mode=reconcile and mode=probe before the awslogs check', async () => {
    expect(await mod.handler({ mode: 'reconcile' })).toEqual({ outcome: 'ok', added: 0 });
    expect(reconcileModels).toHaveBeenCalledWith({ mode: 'reconcile' }, { marker: 'deps' });

    const probeEvent = { mode: 'probe', modelId: 'us.anthropic.claude-opus-5', probe: 'api' };
    expect(await mod.handler(probeEvent)).toEqual({ statusCode: 200, ok: true });
    expect(probeModel).toHaveBeenCalledWith(probeEvent, { marker: 'deps' });
    expect(buildDeps).toHaveBeenCalledTimes(2);
  });

  it('leaves the aggregation path alone: no model work for an event with no awslogs data', async () => {
    reconcileModels.mockClear();
    probeModel.mockClear();
    expect(await mod.handler({})).toEqual({ statusCode: 200 });
    expect(await mod.handler({ action: 'reset' })).toEqual({ statusCode: 200, body: 'reset-ignored' });
    expect(reconcileModels).not.toHaveBeenCalled();
    expect(probeModel).not.toHaveBeenCalled();
  });
});
