/**
 * The JS twin of the model registry (TEAM-4995, DL-033).
 *
 * Two layers, for the same reason the Python twin's tests have two:
 *   1. the SHARED fixture (src/config/__fixtures__/models-registry.case.json),
 *      which pins this resolver and the Python one to the same answers, case for
 *      case. TEAM-4997 authors it; until it lands that one test skips. It is
 *      never forked or copied here — a second copy would be a second source of
 *      truth, which is the bug this ticket removes.
 *   2. fixture-INDEPENDENT tests over small inline registries, which carry the
 *      real coverage on this branch: precedence, the quarantine kill switch,
 *      retirement falling through, the reconcile's arithmetic (versions, usage
 *      types) and the pricing projection.
 *
 * The module is pure, so there is nothing to mock.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MODEL_ID_RE,
  LITERAL_PERSONA_DEFAULT,
  LITERAL_CODING_CODEX,
  validateRegistry,
  resolveModel,
  resolveAgentModel,
  resolveCodingModel,
  baseUrlFor,
  isDatedDuplicate,
  parseModelVersion,
  compareVersions,
  predecessorRow,
  tierForFamily,
  usagetypeFor,
  pricingProjection,
} from './models-registry.mjs';

const FIXTURE = fileURLToPath(new URL('../../src/config/__fixtures__/models-registry.case.json', import.meta.url));

// ─── a registry small enough to read, big enough to be interesting ──────────

const registryDoc = () => ({
  version: 3,
  updatedAt: '2026-09-24T00:00:00Z',
  updatedBy: 'tester',
  models: [
    {
      modelId: 'us.anthropic.claude-fable-5-1',
      vendor: 'anthropic',
      family: 'claude-fable',
      aliases: ['fable-5'],
      endpoint: 'bedrock-runtime',
      region: 'us-east-1',
      api: 'converse',
      contextWindow: 500000,
      pricing: { input: 11, output: 55, cacheReadInput: 0.275, state: 'published' },
    },
    { modelId: 'us.anthropic.claude-opus-5', vendor: 'anthropic', family: 'claude-opus', status: 'active' },
    { modelId: 'us.anthropic.claude-sonnet-5', vendor: 'anthropic', family: 'claude-sonnet', status: 'candidate' },
    { modelId: 'us.anthropic.claude-opus-4-1', vendor: 'anthropic', family: 'claude-opus', status: 'retired' },
    {
      modelId: 'us.openai.gpt-6-sol',
      vendor: 'openai',
      family: 'gpt-sol',
      endpoint: 'bedrock-runtime',
      region: 'us-east-1',
      api: 'responses',
      contextWindow: 300000,
    },
    {
      modelId: 'openai.gpt-5.5',
      vendor: 'openai',
      family: 'gpt',
      endpoint: 'bedrock-mantle',
      region: 'us-east-2',
      api: 'responses',
    },
  ],
  tiers: {
    claude: {
      fable: 'us.anthropic.claude-fable-5-1',
      opus: 'us.anthropic.claude-opus-5',
      sonnet: 'us.anthropic.claude-sonnet-5',
    },
    codex: { sol: 'us.openai.gpt-6-sol' },
  },
  legacyAliases: { 'claude-sonnet-45': 'us.anthropic.claude-sonnet-5' },
  agents: { agentcore_hub_backend_dev: 'us.anthropic.claude-opus-5' },
  defaults: {
    persona: 'us.anthropic.claude-fable-5-1',
    codingClaude: 'us.anthropic.claude-fable-5-1',
    codingCodex: 'openai.gpt-5.5',
  },
});

function validated(doc = registryDoc()) {
  const { registry, errors } = validateRegistry(doc);
  expect(errors).toEqual([]);
  return registry;
}

/** A logger the resolvers can warn into without polluting the test output. */
const quiet = () => ({ warn: () => {}, log: () => {} });

// ─── 1. the shared fixture (skipped until TEAM-4997 lands it) ───────────────

describe('shared fixture', () => {
  it.skipIf(!existsSync(FIXTURE))('gives the same answer as the Python twin, case for case', () => {
    const doc = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const cases = doc.cases || doc.resolveCases || [];
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const reg = c.registry ? validated(c.registry) : null;
      const env = c.env || {};
      const ctx = { cli: c.cli, log: quiet() };
      let got;
      if (c.kind === 'agent') got = resolveAgentModel(reg, c.agentId || '', c.override || '', env, ctx).modelId;
      else if (c.kind === 'coding') got = resolveCodingModel(reg, c.input || '', c.cli || 'claude', env, ctx).modelId;
      else got = resolveModel(reg, c.input || '', ctx);
      expect(got, c.name).toBe(c.expected);
    }
  });
});

// ─── 2. resolveModel precedence ────────────────────────────────────────────

describe('resolveModel', () => {
  it('resolves a tier per cli, and never across clis', () => {
    const reg = validated();
    expect(resolveModel(reg, 'opus', { cli: 'claude' })).toBe('us.anthropic.claude-opus-5');
    expect(resolveModel(reg, 'sol', { cli: 'codex' })).toBe('us.openai.gpt-6-sol');
    // "sol" is a Codex tier: asking as claude must not cross the wires.
    expect(resolveModel(reg, 'sol', { cli: 'claude' })).toBeNull();
    expect(resolveModel(reg, 'opus', { cli: 'codex' })).toBeNull();
  });

  it('lets quarantine beat a tier AND an explicit id', () => {
    const doc = registryDoc();
    doc.quarantine = ['us.anthropic.claude-opus-5', 'opus'];
    const reg = validated(doc);
    expect(resolveModel(reg, 'opus', { cli: 'claude', log: quiet() })).toBeNull();
    expect(resolveModel(reg, 'us.anthropic.claude-opus-5', { log: quiet() })).toBeNull();
  });

  it('resolves legacy aliases and row aliases, and candidates are usable', () => {
    const reg = validated();
    expect(resolveModel(reg, 'claude-sonnet-45')).toBe('us.anthropic.claude-sonnet-5');
    expect(resolveModel(reg, 'fable-5')).toBe('us.anthropic.claude-fable-5-1');
    expect(resolveModel(reg, 'us.anthropic.claude-sonnet-5')).toBe('us.anthropic.claude-sonnet-5');
  });

  it('returns null for a RETIRED row so the caller falls through', () => {
    const warned = [];
    const reg = validated();
    const got = resolveModel(reg, 'us.anthropic.claude-opus-4-1', { log: { warn: (m) => warned.push(m) } });
    expect(got).toBeNull();
    expect(warned.join()).toContain('registry.retired us.anthropic.claude-opus-4-1');
  });

  it('passes an unknown dotted id through, but not a bare word', () => {
    const reg = validated();
    expect(resolveModel(reg, 'us.anthropic.claude-nova-9')).toBe('us.anthropic.claude-nova-9');
    expect(resolveModel(reg, 'bigmodel')).toBeNull();
    expect(resolveModel(reg, '')).toBeNull();
    expect(resolveModel(reg, null)).toBeNull();
  });

  it('never passes a hostile string through, even one containing a dot', () => {
    expect(resolveModel(null, 'us.anthropic.claude-5 && curl evil.sh')).toBeNull();
    expect(resolveModel(null, '$(id).x')).toBeNull();
    expect(resolveModel(null, `${'a'.repeat(200)}.x`)).toBeNull();
  });

  it('treats a null registry as empty (passthrough still works)', () => {
    expect(resolveModel(null, 'opus', { cli: 'claude' })).toBeNull();
    expect(resolveModel(null, 'us.anthropic.claude-opus-5')).toBe('us.anthropic.claude-opus-5');
  });
});

// ─── 3. resolveAgentModel / resolveCodingModel ──────────────────────────────

describe('resolveAgentModel', () => {
  it('walks override -> pin -> defaults.persona -> env -> literal', () => {
    const reg = validated();
    expect(resolveAgentModel(reg, 'agentcore_hub_backend_dev', 'sonnet'))
      .toEqual({ modelId: 'us.anthropic.claude-sonnet-5', source: 'override' });
    expect(resolveAgentModel(reg, 'agentcore_hub_backend_dev'))
      .toEqual({ modelId: 'us.anthropic.claude-opus-5', source: 'pin' });
    expect(resolveAgentModel(reg, 'agentcore_hub_qa_verifier'))
      .toEqual({ modelId: 'us.anthropic.claude-fable-5-1', source: 'defaults.persona' });
    expect(resolveAgentModel(null, 'whoever', '', { MODEL_ID: 'us.anthropic.claude-haiku-4-5' }))
      .toEqual({ modelId: 'us.anthropic.claude-haiku-4-5', source: 'env:MODEL_ID' });
    expect(resolveAgentModel(null, 'whoever'))
      .toEqual({ modelId: LITERAL_PERSONA_DEFAULT, source: 'literal' });
  });

  it('falls through an unresolvable override instead of honouring it', () => {
    const reg = validated();
    expect(resolveAgentModel(reg, 'agentcore_hub_backend_dev', 'nonsense').modelId)
      .toBe('us.anthropic.claude-opus-5');
  });

  it('lets quarantine beat even the env var', () => {
    const doc = registryDoc();
    doc.quarantine = ['us.anthropic.claude-opus-5'];
    doc.defaults = {};
    const reg = validated(doc);
    const got = resolveAgentModel(reg, 'nobody', '', { MODEL_ID: 'us.anthropic.claude-opus-5' }, { log: quiet() });
    expect(got).toEqual({ modelId: LITERAL_PERSONA_DEFAULT, source: 'literal' });
  });
});

describe('resolveCodingModel', () => {
  it('carries the row endpoint, region, api and context window', () => {
    const reg = validated();
    expect(resolveCodingModel(reg, 'fable', 'claude')).toMatchObject({
      modelId: 'us.anthropic.claude-fable-5-1', endpoint: 'bedrock-runtime',
      region: 'us-east-1', api: 'converse', contextWindow: 500000,
    });
    // Codex on Bedrock Runtime keeps ITS region — the whole point of the row.
    expect(resolveCodingModel(reg, 'sol', 'codex')).toMatchObject({
      modelId: 'us.openai.gpt-6-sol', endpoint: 'bedrock-runtime', region: 'us-east-1', api: 'responses',
    });
    expect(resolveCodingModel(reg, '', 'codex')).toMatchObject({
      modelId: 'openai.gpt-5.5', endpoint: 'bedrock-mantle', region: 'us-east-2',
      baseUrl: 'https://bedrock-mantle.us-east-2.api.aws/openai/v1',
    });
  });

  it('reads the per-cli env names, then the literal', () => {
    expect(resolveCodingModel(null, '', 'claude', { ANTHROPIC_MODEL: 'us.anthropic.claude-opus-5' }).modelId)
      .toBe('us.anthropic.claude-opus-5');
    expect(resolveCodingModel(null, '', 'claude', { CLAUDE_MODEL: 'us.anthropic.claude-sonnet-5' }).modelId)
      .toBe('us.anthropic.claude-sonnet-5');
    expect(resolveCodingModel(null, '', 'codex', { CODEX_MODEL: 'openai.gpt-5.4' }).modelId).toBe('openai.gpt-5.4');
    expect(resolveCodingModel(null, '', 'codex').modelId).toBe(LITERAL_CODING_CODEX);
  });

  it('keeps BEDROCK_MANTLE_REGION mantle-only', () => {
    const env = { BEDROCK_MANTLE_REGION: 'eu-west-1', AWS_REGION: 'us-west-2' };
    expect(resolveCodingModel(null, '', 'codex', env).region).toBe('eu-west-1');
    expect(resolveCodingModel(null, '', 'claude', env).region).toBe('us-west-2');
  });

  it('builds the base url per endpoint', () => {
    expect(baseUrlFor('bedrock-runtime', 'us-east-1')).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1');
    expect(baseUrlFor('bedrock-mantle', 'us-east-2')).toBe('https://bedrock-mantle.us-east-2.api.aws/openai/v1');
  });
});

// ─── 4. validateRegistry ────────────────────────────────────────────────────

describe('validateRegistry', () => {
  it('drops a malformed row with a warning', () => {
    const doc = registryDoc();
    doc.models.push({ nope: 1 });
    const { registry, warnings, errors } = validateRegistry(doc);
    expect(errors).toEqual([]);
    expect(registry).not.toBeNull();
    expect(warnings.join()).toContain('dropped');
  });

  it('invalidates the WHOLE document when a dropped row is referenced', () => {
    const doc = registryDoc();
    doc.models = doc.models.filter((m) => m.modelId !== 'us.anthropic.claude-opus-5');
    doc.models.push({ modelId: 'us.anthropic.claude-opus-5', status: 'banana' });
    const { registry, warnings, errors } = validateRegistry(doc);
    expect(registry).toBeNull();
    expect(warnings.join()).toContain('dropped');
    expect(errors.join()).toContain('tiers.claude.opus');
  });

  it('invalidates the document for a dangling default or agent pin', () => {
    const a = registryDoc();
    a.defaults.persona = 'us.anthropic.claude-does-not-exist';
    expect(validateRegistry(a).registry).toBeNull();
    const b = registryDoc();
    b.agents.agentcore_hub_backend_dev = 'gone';
    expect(validateRegistry(b).registry).toBeNull();
  });

  it('drops a row whose region is hostile, and invalidates when it is referenced', () => {
    const ok = registryDoc();
    ok.models.push({ modelId: 'us.openai.gpt-6-luna', region: 'us-east-1; rm -rf /' });
    expect(validated(ok).models.some((m) => m.modelId === 'us.openai.gpt-6-luna')).toBe(false);
    const bad = registryDoc();
    bad.models[0].region = 'us-east-1; rm -rf /';
    expect(validateRegistry(bad).errors.join()).toContain('defaults.persona');
  });

  it('drops an ambiguous alias but keeps the row', () => {
    const doc = registryDoc();
    doc.models[1].aliases = ['fable-5'];
    const { registry, warnings } = validateRegistry(doc);
    expect(warnings.join()).toContain('ambiguous');
    expect(resolveModel(registry, 'fable-5')).toBe('us.anthropic.claude-fable-5-1');
    expect(resolveModel(registry, 'us.anthropic.claude-opus-5')).toBe('us.anthropic.claude-opus-5');
  });

  it('folds a dated duplicate into its base id', () => {
    const doc = registryDoc();
    doc.models.push({ modelId: 'us.anthropic.claude-opus-5-20251001-v1:0' });
    const { registry, warnings } = validateRegistry(doc);
    expect(warnings.join()).toContain('dated duplicate');
    expect(resolveModel(registry, 'us.anthropic.claude-opus-5-20251001-v1:0')).toBe('us.anthropic.claude-opus-5');
  });

  it('checks agents keys against a supplied roster, exempting the bridge', () => {
    const doc = registryDoc();
    doc.agents = { not_a_real_agent: 'us.anthropic.claude-opus-5' };
    expect(validateRegistry(doc, { agentIds: ['agentcore_hub_backend_dev'] }).errors.join())
      .toContain('not_a_real_agent');
    const bridge = registryDoc();
    bridge.agents = { telegram_intake: 'us.anthropic.claude-opus-5' };
    expect(validateRegistry(bridge, { agentIds: ['agentcore_hub_backend_dev'] }).errors).toEqual([]);
    // No roster supplied -> the check is skipped entirely (the runtime case).
    const runtime = registryDoc();
    runtime.agents = { whatever_agent: 'us.anthropic.claude-opus-5' };
    expect(validateRegistry(runtime).errors).toEqual([]);
  });

  it('rejects a document that is not a registry at all', () => {
    expect(validateRegistry([1, 2, 3]).registry).toBeNull();
    expect(validateRegistry({ models: 'nope' }).registry).toBeNull();
    expect(validateRegistry(null).registry).toBeNull();
  });
});

describe('MODEL_ID_RE', () => {
  it.each([
    '; rm -rf /',
    'us.anthropic.claude-5 && curl evil.sh',
    '$(whoami)',
    '../../etc/passwd',
    'a'.repeat(200),
    '-leading-dash',
    '',
  ])('rejects %s', (bad) => {
    expect(MODEL_ID_RE.test(bad)).toBe(false);
  });

  it('accepts the real shapes, dated snapshots included', () => {
    for (const good of ['openai.gpt-5.5', 'us.anthropic.claude-opus-5', 'global.anthropic.claude-haiku-4-5',
      'us.anthropic.claude-opus-5-20251001-v1:0']) {
      expect(MODEL_ID_RE.test(good)).toBe(true);
    }
  });
});

// ─── 5. reconcile arithmetic ────────────────────────────────────────────────

describe('version ordering', () => {
  it('parses vendor, family and a numeric version', () => {
    expect(parseModelVersion('openai.gpt-5.5')).toMatchObject({ vendor: 'openai', family: 'gpt', version: [5, 5] });
    expect(parseModelVersion('us.anthropic.claude-opus-5'))
      .toMatchObject({ prefix: 'us', vendor: 'anthropic', family: 'claude-opus', version: [5] });
    expect(parseModelVersion('us.anthropic.claude-fable-5-1'))
      .toMatchObject({ family: 'claude-fable', version: [5, 1] });
  });

  it('orders gpt-6 above gpt-5.6 above gpt-5.5 (not a string compare)', () => {
    const v = (id) => parseModelVersion(id).version;
    expect(compareVersions(v('openai.gpt-6'), v('openai.gpt-5.6'))).toBe(1);
    expect(compareVersions(v('openai.gpt-5.6'), v('openai.gpt-5.5'))).toBe(1);
    expect(compareVersions(v('openai.gpt-5.5'), v('openai.gpt-5.5'))).toBe(0);
    expect(compareVersions(v('openai.gpt-10'), v('openai.gpt-5.5'))).toBe(1);
  });

  it('picks the newest strictly-lower row of the same family as predecessor', () => {
    const reg = validated({
      models: [
        { modelId: 'openai.gpt-6', vendor: 'openai', family: 'gpt' },
        { modelId: 'openai.gpt-5.6', vendor: 'openai', family: 'gpt' },
        { modelId: 'openai.gpt-5.5', vendor: 'openai', family: 'gpt' },
        { modelId: 'openai.gpt-5.4', vendor: 'openai', family: 'gpt', status: 'quarantined' },
        { modelId: 'us.anthropic.claude-opus-5', vendor: 'anthropic', family: 'claude-opus' },
      ],
    });
    const row = (id) => reg.models.find((m) => m.modelId === id);
    expect(predecessorRow(reg, row('openai.gpt-6')).modelId).toBe('openai.gpt-5.6');
    expect(predecessorRow(reg, row('openai.gpt-5.6')).modelId).toBe('openai.gpt-5.5');
    // A quarantined predecessor is skipped, and the oldest row has none.
    expect(predecessorRow(reg, row('openai.gpt-5.5'))).toBeNull();
    // Never across families.
    expect(predecessorRow(reg, row('us.anthropic.claude-opus-5'))).toBeNull();
  });
});

describe('isDatedDuplicate', () => {
  it('folds a dated snapshot only when the base id is known', () => {
    const ids = new Set(['us.anthropic.claude-opus-5']);
    expect(isDatedDuplicate('us.anthropic.claude-opus-5-20251001', ids)).toBe(true);
    expect(isDatedDuplicate('us.anthropic.claude-opus-5-20251001-v1:0', ids)).toBe(true);
    expect(isDatedDuplicate('us.anthropic.claude-sonnet-5-20251001', ids)).toBe(false);
    expect(isDatedDuplicate('us.anthropic.claude-opus-5', ids)).toBe(false);
  });
});

describe('tierForFamily', () => {
  it('maps the four Anthropic and four Codex families, and nothing else', () => {
    expect(tierForFamily('anthropic', 'claude-opus')).toBe('claude.opus');
    expect(tierForFamily('anthropic', 'claude-fable')).toBe('claude.fable');
    expect(tierForFamily('openai', 'gpt-luna')).toBe('codex.luna');
    expect(tierForFamily('openai', 'gpt')).toBeNull();
    expect(tierForFamily('anthropic', 'claude')).toBeNull();
    expect(tierForFamily('meta', 'llama-opus')).toBeNull();
  });
});

describe('usagetypeFor', () => {
  it('uses the Mantle per-model shape for OpenAI on Mantle', () => {
    const row = { modelId: 'openai.gpt-5.5', vendor: 'openai', endpoint: 'bedrock-mantle' };
    expect(usagetypeFor(row, 'input')).toBe('USE1-openai.gpt-5.5-mantle-input-tokens-standard');
    expect(usagetypeFor(row, 'output')).toBe('USE1-openai.gpt-5.5-mantle-output-tokens-standard');
  });

  it('uses the marketplace units on Bedrock Runtime, with global as its own tier', () => {
    const regional = { modelId: 'us.anthropic.claude-opus-5', vendor: 'anthropic', endpoint: 'bedrock-runtime' };
    expect(usagetypeFor(regional, 'input')).toBe('USE1-MP:USE1_input_tokens_standard-Units');
    expect(usagetypeFor(regional, 'cache_read')).toBe('USE1-MP:USE1_cache_read_tokens_standard-Units');
    const global = { modelId: 'global.anthropic.claude-opus-5', vendor: 'anthropic', endpoint: 'bedrock-runtime' };
    expect(usagetypeFor(global, 'output')).toBe('USE1-MP:USE1_output_tokens_global_standard-Units');
  });

  it('bills an OpenAI model on Bedrock Runtime through the marketplace, not Mantle', () => {
    const row = { modelId: 'us.openai.gpt-6-sol', vendor: 'openai', endpoint: 'bedrock-runtime' };
    expect(usagetypeFor(row, 'input')).toBe('USE1-MP:USE1_input_tokens_standard-Units');
  });
});

// ─── 6. pricing projection ──────────────────────────────────────────────────

const livePricing = () => ({
  _comment: 'hand-written, somewhere else',
  models: { 'openai.gpt-legacy': { input: 1, output: 2 } },
  default: { input: 5.5, output: 27.5 },
  cachedInputDiscount: 0.1,
  cacheWriteMultiplier: { '5m': 1.25, '1h': 2, default: 1.25, _basis: 'multiple of input' },
  kiro: { usdPerCredit: 0.04 },
  agentcore: { runtimeGbHourUsd: 0.0895 },
});

describe('pricingProjection', () => {
  it('emits a row per priced model AND per alias, never a legacyAliases key', () => {
    const doc = registryDoc();
    doc.models[1].pricing = { input: 5.5, output: 27.5 };
    const { pricing } = pricingProjection(validated(doc), livePricing());
    expect(pricing.models['us.anthropic.claude-fable-5-1']).toEqual({ input: 11, output: 55, cacheReadInput: 0.275 });
    expect(pricing.models['fable-5']).toEqual({ input: 11, output: 55, cacheReadInput: 0.275 });
    expect(pricing.models['claude-sonnet-45']).toBeUndefined();
    // A row without a usable price is left OUT, which is what makes the card
    // Lambda report it as a gap instead of pricing it at the default rate.
    expect(pricing.models['us.openai.gpt-6-sol']).toBeUndefined();
    // The hand-written row is gone: the catalog owns per-model rates outright.
    expect(pricing.models['openai.gpt-legacy']).toBeUndefined();
  });

  it('never emits a cacheWrite field (it is a multiplier, not a rate)', () => {
    const doc = registryDoc();
    doc.models[0].pricing = { input: 11, output: 55, cacheWrite: 13.75, cacheWriteTtl: { '1h': 22 } };
    const { pricing } = pricingProjection(validated(doc), livePricing());
    const row = pricing.models['us.anthropic.claude-fable-5-1'];
    expect(Object.keys(row).sort()).toEqual(['input', 'output']);
  });

  it('carries the five non-catalog blocks forward byte for byte', () => {
    const prev = livePricing();
    const { pricing, prevSourceNotes } = pricingProjection(validated(), prev);
    for (const key of ['default', 'cachedInputDiscount', 'cacheWriteMultiplier', 'kiro', 'agentcore']) {
      expect(JSON.stringify(pricing[key]), key).toBe(JSON.stringify(prev[key]));
    }
    expect(prevSourceNotes).toEqual([]);
    expect(pricing._comment).toContain('Generated from config/models.json version 3');
    expect(pricing._comment).toContain('edit the catalog on /models');
  });

  it('falls back to the seed per block, naming it, when a block is corrupted', () => {
    const prev = livePricing();
    prev.kiro = { usdPerCredit: 0 };                       // not a positive rate
    prev.cacheWriteMultiplier = { '5m': 40 };              // outside [1, 10]
    delete prev.cachedInputDiscount;
    const seed = { kiro: { usdPerCredit: 0.04 }, cacheWriteMultiplier: { '5m': 1.25 } };
    const { pricing, prevSourceNotes } = pricingProjection(validated(), prev, seed);
    expect(pricing.kiro).toEqual({ usdPerCredit: 0.04 });
    expect(pricing.cacheWriteMultiplier).toEqual({ '5m': 1.25 });
    expect(prevSourceNotes).toContain('seed:kiro');
    expect(prevSourceNotes).toContain('seed:cacheWriteMultiplier');
    expect(prevSourceNotes).toContain('missing:cachedInputDiscount');
    expect(pricing.cachedInputDiscount).toBeUndefined();
  });

  it('keeps a retired row priced (finished runs still have to be costed)', () => {
    const doc = registryDoc();
    doc.models[3].pricing = { input: 15, output: 75 };
    const { pricing } = pricingProjection(validated(doc), livePricing());
    expect(pricing.models['us.anthropic.claude-opus-4-1']).toEqual({ input: 15, output: 75 });
  });

  it('carries a long-context block when the row has one', () => {
    const doc = registryDoc();
    doc.models[0].pricing = {
      input: 11, output: 55,
      longContext: { input: 22, output: 110, thresholdInputTokens: 272000 },
    };
    const { pricing } = pricingProjection(validated(doc), livePricing());
    expect(pricing.models['us.anthropic.claude-fable-5-1'].longContext)
      .toEqual({ input: 22, output: 110, thresholdInputTokens: 272000 });
  });
});
