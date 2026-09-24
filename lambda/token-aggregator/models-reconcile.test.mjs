/**
 * The nightly model reconcile (TEAM-4995, DL-033).
 *
 * Every AWS call is injected, so these run with no network and no clock: the
 * harness below is an in-memory S3 with real ETag semantics (a conditional PUT
 * whose `ifMatch` does not match the stored ETag throws PreconditionFailed, as
 * the service does), plus canned discovery and Pricing API answers.
 *
 * The cases are chosen around the three rules that keep the registry safe:
 * nothing is deleted, only autoAdopt writes tiers, and every write is
 * conditional.
 */
import { describe, it, expect } from 'vitest';
import { reconcileModels, MODELS_KEY, PREV_KEY, PRICING_KEY, mantleRegions, rateFromProduct } from './models-reconcile.mjs';

// ─── harness ────────────────────────────────────────────────────────────────

/** A Pricing API product carrying `usd` per 1M tokens, expressed the way the
 *  service does: a rate per 1K tokens. */
const product = (usdPerMillion) => ({
  terms: {
    OnDemand: {
      'x.y': {
        priceDimensions: {
          'x.y.z': { unit: '1K tokens', pricePerUnit: { USD: String(usdPerMillion / 1000) } },
        },
      },
    },
  },
});

const baseDoc = () => ({
  version: 4,
  updatedAt: '2026-09-01T00:00:00Z',
  updatedBy: 'human',
  models: [
    {
      modelId: 'us.anthropic.claude-opus-5',
      label: 'Opus 5',
      vendor: 'anthropic',
      family: 'claude-opus',
      endpoint: 'bedrock-runtime',
      region: 'us-east-1',
      api: 'converse',
      status: 'active',
      pricing: { input: 5.5, output: 27.5, state: 'published', source: 'operator' },
    },
    {
      modelId: 'openai.gpt-5.5',
      label: 'GPT-5.5',
      vendor: 'openai',
      family: 'gpt',
      endpoint: 'bedrock-mantle',
      region: 'us-east-2',
      api: 'responses',
      status: 'active',
      pricing: { input: 1.25, output: 10, state: 'published', source: 'operator' },
    },
  ],
  tiers: { claude: { opus: 'us.anthropic.claude-opus-5' }, codex: { sol: 'openai.gpt-5.5' } },
  agents: { agentcore_hub_backend_dev: 'us.anthropic.claude-opus-5' },
  defaults: { persona: 'us.anthropic.claude-opus-5', codingCodex: 'openai.gpt-5.5' },
  autoAdopt: {},
});

const livePricing = () => ({
  models: {},
  default: { input: 5.5, output: 27.5 },
  cachedInputDiscount: 0.1,
  cacheWriteMultiplier: { '5m': 1.25, '1h': 2, default: 1.25 },
  kiro: { usdPerCredit: 0.04 },
  agentcore: { runtimeGbHourUsd: 0.0895 },
});

/** Discovery that returns exactly the rows already in `baseDoc()`, so a test
 *  only has to describe what it is CHANGING. */
const sameAsBase = {
  profiles: [{ inferenceProfileId: 'us.anthropic.claude-opus-5', status: 'ACTIVE', inferenceProfileName: 'Opus 5' }],
  mantle: [{ id: 'openai.gpt-5.5' }],
};

function harness(opts = {}) {
  const store = new Map();
  store.set(MODELS_KEY, { body: JSON.stringify(opts.doc || baseDoc()), etag: '"m1"' });
  if (opts.pricing !== null) store.set(PRICING_KEY, { body: JSON.stringify(opts.pricing || livePricing()), etag: '"p1"' });
  const puts = [];
  const logs = [];
  let reads = 0;

  const deps = {
    env: { AWS_REGION: 'us-east-1', BEDROCK_MANTLE_REGIONS: 'us-east-2', ...(opts.env || {}) },
    log: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
    now: () => new Date('2026-09-24T03:00:00.000Z'),
    uuid: () => 'u-u-i-d',
    async s3Get(key) {
      if (key === MODELS_KEY) {
        reads += 1;
        if (opts.onModelsRead) opts.onModelsRead(reads, store);
      }
      const hit = store.get(key);
      return hit ? { ...hit } : null;
    },
    async s3Put(key, body, o = {}) {
      puts.push({ key, body, ifMatch: o.ifMatch });
      if (o.ifMatch && store.get(key)?.etag !== o.ifMatch) {
        const e = new Error('At least one of the pre-conditions you specified did not hold');
        e.name = 'PreconditionFailed';
        throw e;
      }
      store.set(key, { body, etag: `"${key}-${puts.length}"` });
    },
    listInferenceProfiles: async () => {
      if (opts.profilesThrow) throw new Error('AccessDeniedException');
      return opts.profiles ?? sameAsBase.profiles;
    },
    mantleModels: async () => {
      if (opts.mantleThrow) throw new Error('http 500');
      return opts.mantle ?? sameAsBase.mantle;
    },
    getProducts: async (_service, filters) => {
      const rate = (opts.products || {})[filters[0].Value];
      return rate ? [product(rate)] : [];
    },
    probeCli: opts.probeCli || (async () => ({ ok: true, at: '2026-09-24T03:00:00.000Z', seconds: 12 })),
  };

  return {
    deps, puts, logs, store,
    written: (key) => JSON.parse(store.get(key).body),
    putsFor: (key) => puts.filter((p) => p.key === key),
  };
}

const row = (doc, id) => doc.models.find((m) => m.modelId === id);

// ─── cases ──────────────────────────────────────────────────────────────────

describe('reconcileModels', () => {
  it('reports failed when the registry is missing, and writes nothing', async () => {
    const h = harness();
    h.store.delete(MODELS_KEY);
    const s = await reconcileModels({ mode: 'reconcile' }, h.deps);
    expect(s).toMatchObject({ outcome: 'failed', reason: 'registry_missing', added: 0 });
    expect(h.puts).toEqual([]);
    expect(h.logs.join('\n')).toContain('reconcile.summary added=0 retired=0 promoted=0 repriced=0 '
      + 'autoAdopted=0 pinged=0 outcome=failed');
  });

  it('adds a newly discovered model as a candidate awaiting a human ping', async () => {
    const h = harness({
      profiles: [
        ...sameAsBase.profiles,
        { inferenceProfileId: 'us.anthropic.claude-opus-6', status: 'ACTIVE', inferenceProfileName: 'Opus 6' },
        // Not ACTIVE, GovCloud, another vendor, and a dated snapshot of a known
        // id: none of these may enter the catalog.
        { inferenceProfileId: 'us.anthropic.claude-opus-7', status: 'CREATING' },
        { inferenceProfileId: 'us-gov.anthropic.claude-opus-5', status: 'ACTIVE' },
        { inferenceProfileId: 'us.meta.llama-4', status: 'ACTIVE' },
        { inferenceProfileId: 'us.anthropic.claude-opus-5-20251001-v1:0', status: 'ACTIVE' },
      ],
      products: { 'USE1-MP:USE1_input_tokens_standard-Units': 11, 'USE1-MP:USE1_output_tokens_standard-Units': 55 },
    });
    const s = await reconcileModels({}, h.deps);
    expect(s.outcome).toBe('ok');
    expect(s.added).toBe(1);
    expect(s.pinged).toBe(1);

    const doc = h.written(MODELS_KEY);
    expect(doc.version).toBe(5);
    expect(doc.updatedBy).toBe('reconcile');
    expect(doc.models.map((m) => m.modelId)).toEqual([
      'us.anthropic.claude-opus-5', 'openai.gpt-5.5', 'us.anthropic.claude-opus-6',
    ]);
    expect(row(doc, 'us.anthropic.claude-opus-6')).toMatchObject({
      status: 'candidate',
      endpoint: 'bedrock-runtime',
      region: 'us-east-1',
      api: 'converse',
      contextWindow: 200000,
      notify: { requestedAt: '2026-09-24T03:00:00.000Z' },
    });
  });

  it('never writes defaults, tiers or agents when nothing is auto-adopted', async () => {
    const before = baseDoc();
    const h = harness({
      doc: before,
      profiles: [
        ...sameAsBase.profiles,
        { inferenceProfileId: 'us.anthropic.claude-opus-6', status: 'ACTIVE' },
      ],
      // A tier is opted in, but the candidate has neither a price nor an api
      // probe, so autoAdopt must not fire.
      products: {},
    });
    const doc = { ...before, autoAdopt: { 'claude.opus': true } };
    h.store.set(MODELS_KEY, { body: JSON.stringify(doc), etag: '"m1"' });

    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', autoAdopted: 0 });
    const after = h.written(MODELS_KEY);
    expect(after.tiers).toEqual(before.tiers);
    expect(after.agents).toEqual(before.agents);
    expect(after.defaults).toEqual(before.defaults);
    expect(h.putsFor(PREV_KEY)).toEqual([]);
  });

  it('retires a vanished row and never deletes it', async () => {
    const h = harness({ profiles: [], products: {} });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', retired: 1 });
    const doc = h.written(MODELS_KEY);
    expect(doc.models).toHaveLength(2);
    expect(row(doc, 'us.anthropic.claude-opus-5')).toMatchObject({
      status: 'retired', retiredAt: '2026-09-24T03:00:00.000Z',
    });
    // The Mantle row survives: its scan succeeded and still lists it.
    expect(row(doc, 'openai.gpt-5.5').status).toBe('active');
  });

  it('retires nothing when the discovery call for that endpoint failed', async () => {
    const h = harness({ profilesThrow: true, products: {} });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', retired: 0, added: 0 });
    expect(h.putsFor(MODELS_KEY)).toEqual([]);
    expect(h.logs.join('\n')).toContain('reconcile.discover-failed endpoint=bedrock-runtime');
  });

  it('brings a returning model back as a candidate', async () => {
    const doc = baseDoc();
    row(doc, 'us.anthropic.claude-opus-5').status = 'retired';
    row(doc, 'us.anthropic.claude-opus-5').retiredAt = '2026-08-01T00:00:00Z';
    const h = harness({ doc, products: {} });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', pinged: 1, added: 0 });
    const after = row(h.written(MODELS_KEY), 'us.anthropic.claude-opus-5');
    expect(after.status).toBe('candidate');
    expect(after.retiredAt).toBeUndefined();
    expect(after.notify.requestedAt).toBe('2026-09-24T03:00:00.000Z');
  });

  it('promotes an interim price to the published rate', async () => {
    const doc = baseDoc();
    // The INPUT document carries the older `pricing` spelling on purpose: the
    // reconcile reads either through priceBlockOf() and rewrites as `price`, so
    // no row is left holding two rate blocks.
    row(doc, 'us.anthropic.claude-opus-5').pricing = {
      input: 9, output: 45, state: 'interim', source: 'predecessor:us.anthropic.claude-opus-4-8',
    };
    const h = harness({
      doc,
      products: {
        'USE1-MP:USE1_input_tokens_standard-Units': 11,
        'USE1-MP:USE1_output_tokens_standard-Units': 55,
        'USE1-MP:USE1_cache_read_tokens_standard-Units': 1.1,
      },
    });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', promoted: 1 });
    const written = row(h.written(MODELS_KEY), 'us.anthropic.claude-opus-5');
    expect(written.price).toEqual({
      input: 11, output: 55, cacheReadInput: 1.1,
      state: 'published', source: 'pricing-api', asOf: '2026-09-24T03:00:00.000Z',
    });
    // One rate block per row: the stale spelling is removed, not left alongside.
    expect(written.pricing).toBeUndefined();
    // The projection follows it into pricing.json, carrying the other blocks.
    const pricing = h.written(PRICING_KEY);
    expect(pricing.models['us.anthropic.claude-opus-5']).toEqual({ input: 11, output: 55, cacheReadInput: 1.1 });
    expect(pricing.kiro).toEqual({ usdPerCredit: 0.04 });
  });

  it('gives an unpriced row its predecessor rate as interim, and leaves a row with no predecessor unpriced', async () => {
    const doc = baseDoc();
    doc.models.push({
      modelId: 'us.anthropic.claude-opus-6', vendor: 'anthropic', family: 'claude-opus',
      endpoint: 'bedrock-runtime', region: 'us-east-1', status: 'candidate',
    });
    doc.models.push({
      modelId: 'us.anthropic.claude-nova-1', vendor: 'anthropic', family: 'claude-nova',
      endpoint: 'bedrock-runtime', region: 'us-east-1', status: 'candidate',
    });
    const h = harness({
      doc,
      profiles: [
        ...sameAsBase.profiles,
        { inferenceProfileId: 'us.anthropic.claude-opus-6', status: 'ACTIVE' },
        { inferenceProfileId: 'us.anthropic.claude-nova-1', status: 'ACTIVE' },
      ],
      products: {},
    });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', repriced: 1 });
    const after = h.written(MODELS_KEY);
    expect(row(after, 'us.anthropic.claude-opus-6').price).toEqual({
      input: 5.5, output: 27.5, state: 'interim',
      source: 'predecessor:us.anthropic.claude-opus-5', asOf: '2026-09-24T03:00:00.000Z',
    });
    // The predecessor rate was read off the older `pricing` spelling in baseDoc().
    expect(row(after, 'us.anthropic.claude-nova-1').price).toBeUndefined();
    expect(row(after, 'us.anthropic.claude-nova-1').pricing).toBeUndefined();
    expect(h.logs.join('\n')).toContain('pricing.unpriced modelId=us.anthropic.claude-nova-1');
  });

  it('records a price drift and does NOT apply it', async () => {
    const h = harness({
      products: {
        // The listing disagrees with the operator-verified published rate.
        'USE1-MP:USE1_input_tokens_standard-Units': 7.5,
        'USE1-MP:USE1_output_tokens_standard-Units': 30,
      },
    });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', promoted: 0, repriced: 0 });
    expect(s.drifts).toContain('us.anthropic.claude-opus-5');
    const pricing = row(h.written(MODELS_KEY), 'us.anthropic.claude-opus-5').price;
    expect(pricing).toMatchObject({ input: 5.5, output: 27.5, state: 'published' });
    expect(pricing.priceDrift).toEqual({ input: 7.5, output: 30, seenAt: '2026-09-24T03:00:00.000Z' });
    expect(h.logs.join('\n')).toContain('pricing.drift modelId=us.anthropic.claude-opus-5');
    // The card keeps billing the carried rate, not the drift.
    expect(h.written(PRICING_KEY).models['us.anthropic.claude-opus-5']).toEqual({ input: 5.5, output: 27.5 });
  });

  it('moves a tier only after a green cli probe, and writes models.prev.json', async () => {
    const doc = baseDoc();
    doc.autoAdopt = { 'claude.opus': true };
    doc.models.push({
      modelId: 'us.anthropic.claude-opus-6', vendor: 'anthropic', family: 'claude-opus',
      endpoint: 'bedrock-runtime', region: 'us-east-1', status: 'candidate',
      pricing: { input: 11, output: 55, state: 'published' },
      probe: { api: { ok: true, at: '2026-09-23T00:00:00Z' } },
    });
    const probed = [];
    const h = harness({
      doc,
      profiles: [...sameAsBase.profiles, { inferenceProfileId: 'us.anthropic.claude-opus-6', status: 'ACTIVE' }],
      products: {},
      probeCli: async (r) => {
        probed.push(r.modelId);
        return { ok: true, at: '2026-09-24T03:00:00.000Z', seconds: 41.2 };
      },
    });

    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', autoAdopted: 1 });
    expect(probed).toEqual(['us.anthropic.claude-opus-6']);
    const after = h.written(MODELS_KEY);
    expect(after.tiers.claude.opus).toBe('us.anthropic.claude-opus-6');
    expect(row(after, 'us.anthropic.claude-opus-6')).toMatchObject({
      status: 'active',
      probe: { cli: { ok: true, seconds: 41.2 } },
      notify: { requestedAt: '2026-09-24T03:00:00.000Z' },
    });
    // The pre-change document is preserved for the operator to diff/restore.
    expect(h.putsFor(PREV_KEY)).toHaveLength(1);
    expect(JSON.parse(h.putsFor(PREV_KEY)[0].body).tiers.claude.opus).toBe('us.anthropic.claude-opus-5');
    expect(h.logs.join('\n')).toContain('autoAdopt.moved tier=claude.opus modelId=us.anthropic.claude-opus-6');
  });

  it('blocks the tier move when the cli probe fails, recording the failure', async () => {
    const doc = baseDoc();
    doc.autoAdopt = { 'claude.opus': true };
    doc.models.push({
      modelId: 'us.anthropic.claude-opus-6', vendor: 'anthropic', family: 'claude-opus',
      endpoint: 'bedrock-runtime', region: 'us-east-1', status: 'candidate',
      pricing: { input: 11, output: 55, state: 'published' },
      probe: { api: { ok: true, at: '2026-09-23T00:00:00Z' } },
    });
    const h = harness({
      doc,
      profiles: [...sameAsBase.profiles, { inferenceProfileId: 'us.anthropic.claude-opus-6', status: 'ACTIVE' }],
      products: {},
      probeCli: async () => ({ ok: false, at: '2026-09-24T03:00:00.000Z', error: 'hello.txt is ""' }),
    });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', autoAdopted: 0 });
    const after = h.written(MODELS_KEY);
    expect(after.tiers.claude.opus).toBe('us.anthropic.claude-opus-5');
    expect(row(after, 'us.anthropic.claude-opus-6').status).toBe('candidate');
    expect(row(after, 'us.anthropic.claude-opus-6').probe.cli.ok).toBe(false);
    expect(h.putsFor(PREV_KEY)).toEqual([]);
    expect(h.logs.join('\n')).toContain('autoAdopt.blocked tier=claude.opus');
  });

  it('retries once when the version moved under it, then reports conflict', async () => {
    // A human saves on /models between our read and our write: the second read
    // (the pre-write check) shows version 5, so the whole pass is replayed
    // against THEIR document and the outcome is reported as a conflict.
    const theirs = baseDoc();
    theirs.version = 5;
    theirs.models[0].label = 'Opus 5 (renamed by a human)';
    const h = harness({
      profiles: [...sameAsBase.profiles, { inferenceProfileId: 'us.anthropic.claude-opus-6', status: 'ACTIVE' }],
      products: {},
      onModelsRead: (n, store) => {
        if (n === 2) store.set(MODELS_KEY, { body: JSON.stringify(theirs), etag: '"m2"' });
      },
    });

    const s = await reconcileModels({}, h.deps);
    expect(s.outcome).toBe('conflict');
    expect(s.added).toBe(1);
    const after = h.written(MODELS_KEY);
    expect(after.version).toBe(6);
    expect(row(after, 'us.anthropic.claude-opus-5').label).toBe('Opus 5 (renamed by a human)');
    expect(h.putsFor(MODELS_KEY)[0].ifMatch).toBe('"m2"');
    expect(h.logs.join('\n')).toContain('reconcile.retry reason=version_moved');
    expect(h.logs.join('\n')).toContain('outcome=conflict');
  });

  it('reports conflict when the conditional write is rejected', async () => {
    const h = harness({
      profiles: [...sameAsBase.profiles, { inferenceProfileId: 'us.anthropic.claude-opus-6', status: 'ACTIVE' }],
      products: {},
    });
    // The version is unchanged but the ETag we read is not the ETag S3 holds:
    // someone wrote the same version twice, which is exactly the case IfMatch
    // exists to catch and `version` alone cannot.
    const original = h.deps.s3Get;
    h.deps.s3Get = async (key) => {
      const got = await original(key);
      if (key === MODELS_KEY && got) return { ...got, etag: '"gone"' };
      return got;
    };
    const s = await reconcileModels({}, h.deps);
    expect(s.outcome).toBe('conflict');
    expect(h.logs.join('\n')).toContain('reconcile.write-rejected reason=precondition_failed');
  });

  it('skips the pricing write when the live pricing document is unreadable', async () => {
    const h = harness({
      pricing: null,
      profiles: [...sameAsBase.profiles, { inferenceProfileId: 'us.anthropic.claude-opus-6', status: 'ACTIVE' }],
      products: {},
    });
    const s = await reconcileModels({}, h.deps);
    expect(s.outcome).toBe('ok');
    expect(h.putsFor(PRICING_KEY)).toEqual([]);
    expect(h.logs.join('\n')).toContain('pricing.projected skipped reason=prev_unreadable');
  });

  it('writes nothing at all when the catalog and the projection are both unchanged', async () => {
    // Byte-identical to what the projection produces, key order included — that
    // is the comparison `projectPricing` makes before it spends a PUT.
    const base = livePricing();
    const pricing = {
      _comment: 'Generated from config/models.json version 4 at 2026-09-01T00:00:00Z by human. '
        + 'Do not edit; edit the catalog on /models.',
      models: {
        'us.anthropic.claude-opus-5': { input: 5.5, output: 27.5 },
        'openai.gpt-5.5': { input: 1.25, output: 10 },
      },
      default: base.default,
      cachedInputDiscount: base.cachedInputDiscount,
      cacheWriteMultiplier: base.cacheWriteMultiplier,
      kiro: base.kiro,
      agentcore: base.agentcore,
    };
    const h = harness({ pricing, products: {} });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', added: 0, retired: 0, repriced: 0 });
    expect(h.puts).toEqual([]);
  });
});

// ─── helpers worth their own cases ──────────────────────────────────────────

describe('mantleRegions', () => {
  it('defaults to the configured region plus us-east-1, deduped', () => {
    expect(mantleRegions({})).toEqual(['us-east-2', 'us-east-1']);
    expect(mantleRegions({ BEDROCK_MANTLE_REGION: 'us-east-1' })).toEqual(['us-east-1']);
    expect(mantleRegions({ BEDROCK_MANTLE_REGIONS: 'us-east-2, us-west-2 ,us-east-2' }))
      .toEqual(['us-east-2', 'us-west-2']);
  });

  it('drops anything that is not a region rather than interpolating it into a host', () => {
    const logs = [];
    expect(mantleRegions({ BEDROCK_MANTLE_REGIONS: 'us-east-2,evil.com/x,us-gov-west-1' },
      { warn: (m) => logs.push(m) })).toEqual(['us-east-2']);
    expect(logs.join('\n')).toContain('reconcile.bad-region');
  });
});

describe('rateFromProduct', () => {
  it('normalises the unit to USD per 1M tokens', () => {
    expect(rateFromProduct(product(11))).toBeCloseTo(11, 6);
    expect(rateFromProduct({
      terms: { OnDemand: { a: { priceDimensions: { b: { unit: 'tokens', pricePerUnit: { USD: '0.000011' } } } } } },
    })).toBeCloseTo(11, 6);
  });

  it('returns null rather than guessing an unknown unit or a zero rate', () => {
    expect(rateFromProduct({
      terms: { OnDemand: { a: { priceDimensions: { b: { unit: 'requests', pricePerUnit: { USD: '0.011' } } } } } },
    })).toBeNull();
    expect(rateFromProduct({
      terms: { OnDemand: { a: { priceDimensions: { b: { unit: '1K tokens', pricePerUnit: { USD: '0' } } } } } },
    })).toBeNull();
    expect(rateFromProduct({})).toBeNull();
  });
});
