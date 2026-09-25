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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reconcileModels, MODELS_KEY, PREV_KEY, PRICING_KEY, mantleRegions, rateFromProduct } from './models-reconcile.mjs';
import { validateRegistry, fatalReadErrors } from './models-registry.mjs';
// The hub's read gate — the canonical the mjs twin mirrors. A document this job
// writes must pass BOTH, or the hub and the fleet disagree about what is live.
import {
  parseModelsRegistry as parseTs,
  validateRegistry as validateTs,
  fatalReadErrors as fatalTs,
} from '../../src/lib/models-registry.ts';

// The real documents this job read-modify-writes in production. Rows live under
// `catalog` — the one document key (TEAM-5022) — and `pricing.json` is a pure
// projection of them, which is why the seed-backed cases at the bottom of this
// file compare against it rather than against a hand-written expectation.
const seed = (rel) => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));
const SEED_MODELS = seed('../../src/config/models.json');
const SEED_PRICING = seed('../../src/config/pricing.json');

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
  catalog: [
    {
      modelId: 'us.anthropic.claude-opus-5',
      label: 'Opus 5',
      vendor: 'anthropic',
      family: 'claude-opus',
      endpoint: 'bedrock-runtime',
      region: 'us-east-1',
      api: 'converse',
      status: 'active',
      pricing: { input: 5.5, output: 27.5, source: 'published' },
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
      pricing: { input: 1.25, output: 10, source: 'published' },
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
  agentcore: { runtimeGbHourUsd: 0.00945, runtimeVcpuHourUsd: 0.0895 },
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
  const serviceCodes = [];
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
    mantleModels: async (region) => {
      // `mantleByRegion` answers (or throws) PER REGION, for the retirement-scope
      // cases; the older `mantle`/`mantleThrow` knobs answer every region alike.
      if (opts.mantleByRegion) {
        const v = opts.mantleByRegion[region];
        if (v instanceof Error) throw v;
        if (v === undefined) throw new Error(`no mantle stub for ${region}`);
        return v;
      }
      if (opts.mantleThrow) throw new Error('http 500');
      return opts.mantle ?? sameAsBase.mantle;
    },
    getProducts: async (serviceCode, filters) => {
      // The Price List files Mantle usagetypes under AmazonBedrock and the
      // marketplace `MP:` units under AmazonBedrockFoundationModels (TEAM-5029).
      // An ASSERTING stub: a lookup under the wrong service throws, which makes
      // publishedRates() return null and every promote/drift case below fail,
      // so a regression to one hardcoded ServiceCode cannot pass this file.
      const usagetype = filters[0].Value;
      const want = /-mantle-/.test(usagetype) ? 'AmazonBedrock' : 'AmazonBedrockFoundationModels';
      if (serviceCode !== want) throw new Error(`ServiceCode ${serviceCode} for ${usagetype}; expected ${want}`);
      serviceCodes.push([serviceCode, usagetype]);
      const rate = (opts.products || {})[usagetype];
      return rate ? [product(rate)] : [];
    },
    probeCli: opts.probeCli || (async () => ({ ok: true, at: '2026-09-24T03:00:00.000Z', seconds: 12 })),
  };

  return {
    deps, puts, logs, store, serviceCodes,
    written: (key) => JSON.parse(store.get(key).body),
    putsFor: (key) => puts.filter((p) => p.key === key),
  };
}

const row = (doc, id) => doc.catalog.find((m) => m.modelId === id);

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
    expect(doc.catalog.map((m) => m.modelId)).toEqual([
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
    // The vanished row is one nothing routes at: retiring a routing target makes
    // a document the validators refuse, which pass() does not write (TEAM-5052;
    // see the TEAM-5017 cases below).
    const doc = baseDoc();
    doc.catalog.push({
      ...doc.catalog[0], modelId: 'us.anthropic.claude-sonnet-4-5', label: 'Sonnet 4.5', family: 'claude-sonnet',
    });
    const h = harness({ doc, products: {} });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', retired: 1 });
    const written = h.written(MODELS_KEY);
    expect(written.catalog).toHaveLength(3);
    expect(row(written, 'us.anthropic.claude-sonnet-4-5')).toMatchObject({
      status: 'retired', retiredAt: '2026-09-24T03:00:00.000Z',
    });
    // The rows discovery still lists survive.
    expect(row(written, 'us.anthropic.claude-opus-5').status).toBe('active');
    expect(row(written, 'openai.gpt-5.5').status).toBe('active');
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

  it('promotes an interim rate to published, naming the promotion', async () => {
    const doc = baseDoc();
    // The INPUT document carries the older `pricing` spelling on purpose: the
    // reconcile reads either through priceBlockOf() and rewrites as `price`, so
    // no row is left holding two rate blocks.
    row(doc, 'us.anthropic.claude-opus-5').pricing = {
      input: 9, output: 45, source: 'interim',
      sourceNote: "Interim: inherited from us.anthropic.claude-opus-4-8 until this model's rate publishes.",
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
      source: 'published', asOf: '2026-09-24T03:00:00.000Z',
      sourceNote: 'Promoted from interim to the published Price List rate on 2026-09-24.',
    });
    // The canonical vocabulary and nothing else: no `state`, no `predecessor:`.
    expect(written.price.state).toBeUndefined();
    expect(JSON.stringify(written.price)).not.toContain('predecessor:');
    // One rate block per row: the stale spelling is removed, not left alongside.
    expect(written.pricing).toBeUndefined();
    // The projection follows it into pricing.json, carrying the other blocks.
    const pricing = h.written(PRICING_KEY);
    expect(pricing.models['us.anthropic.claude-opus-5']).toEqual({ input: 11, output: 55, cacheReadInput: 1.1 });
    expect(pricing.kiro).toEqual({ usdPerCredit: 0.04 });
  });

  it('inherits a predecessor rate as interim, naming the predecessor; a row with no predecessor stays unpriced', async () => {
    const doc = baseDoc();
    doc.catalog.push({
      modelId: 'us.anthropic.claude-opus-6', vendor: 'anthropic', family: 'claude-opus',
      endpoint: 'bedrock-runtime', region: 'us-east-1', status: 'candidate',
    });
    doc.catalog.push({
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
    const inherited = row(after, 'us.anthropic.claude-opus-6').price;
    expect(inherited).toEqual({
      input: 5.5, output: 27.5, source: 'interim',
      sourceNote: "Interim: inherited from us.anthropic.claude-opus-5 until this model's rate publishes.",
      asOf: '2026-09-24T03:00:00.000Z',
    });
    // `source` is the canonical enum, so parsePrice() keeps it `interim` and the
    // next pass CAN promote it; `predecessor:<id>` would have read as `manual`.
    expect(inherited.state).toBeUndefined();
    expect(JSON.stringify(inherited)).not.toContain('predecessor:');
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
    expect(pricing).toMatchObject({ input: 5.5, output: 27.5, source: 'published' });
    expect(pricing.priceDrift).toEqual({ input: 7.5, output: 30, seenAt: '2026-09-24T03:00:00.000Z' });
    expect(h.logs.join('\n')).toContain('pricing.drift modelId=us.anthropic.claude-opus-5');
    // The card keeps billing the carried rate, not the drift.
    expect(h.written(PRICING_KEY).models['us.anthropic.claude-opus-5']).toEqual({ input: 5.5, output: 27.5 });
  });

  it('moves a tier only after a green cli probe, and writes models.prev.json', async () => {
    const doc = baseDoc();
    doc.autoAdopt = { 'claude.opus': true };
    doc.catalog.push({
      modelId: 'us.anthropic.claude-opus-6', vendor: 'anthropic', family: 'claude-opus',
      endpoint: 'bedrock-runtime', region: 'us-east-1', status: 'candidate',
      pricing: { input: 11, output: 55, source: 'published' },
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
    doc.catalog.push({
      modelId: 'us.anthropic.claude-opus-6', vendor: 'anthropic', family: 'claude-opus',
      endpoint: 'bedrock-runtime', region: 'us-east-1', status: 'candidate',
      pricing: { input: 11, output: 55, source: 'published' },
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
    theirs.catalog[0].label = 'Opus 5 (renamed by a human)';
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

  // ─── TEAM-5029 F2: the Price List is asked under the endpoint's ServiceCode ──

  it("asks the Pricing API under the endpoint's own ServiceCode", async () => {
    // baseDoc has one Bedrock Runtime row and one Mantle row. The stub above
    // already throws on a mismatch; this is the positive assertion that both
    // services were actually consulted, with the usagetype shape each one files.
    const h = harness({ products: {} });
    await reconcileModels({}, h.deps);
    expect(h.serviceCodes).toContainEqual(['AmazonBedrockFoundationModels', 'USE1-MP:USE1_input_tokens_standard-Units']);
    expect(h.serviceCodes).toContainEqual(['AmazonBedrock', 'USE1-openai.gpt-5.5-mantle-input-tokens-standard']);
    expect(h.serviceCodes.some(([code, u]) => code === 'AmazonBedrock' && u.startsWith('USE1-MP:'))).toBe(false);
  });

  // ─── TEAM-5029 F3: provenance is price.source ─────────────────────────────

  it('never overwrites a published rate the Price List disagrees with — it records the drift', async () => {
    // The Mantle row this time, so the drift path is exercised on the other
    // ServiceCode as well; the Runtime row's listing agrees, so it is untouched.
    const h = harness({
      products: {
        'USE1-MP:USE1_input_tokens_standard-Units': 5.5,
        'USE1-MP:USE1_output_tokens_standard-Units': 27.5,
        'USE1-openai.gpt-5.5-mantle-input-tokens-standard': 5.5,
        'USE1-openai.gpt-5.5-mantle-output-tokens-standard': 33,
      },
    });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', promoted: 0, repriced: 0 });
    expect(s.drifts).toEqual(['openai.gpt-5.5']);
    const written = h.written(MODELS_KEY);
    expect(row(written, 'openai.gpt-5.5').price).toEqual({
      input: 1.25, output: 10, source: 'published',
      priceDrift: { input: 5.5, output: 33, seenAt: '2026-09-24T03:00:00.000Z' },
    });
    // The Runtime row's listing agrees, so the pass never touches it — down to
    // leaving baseDoc's older `pricing` spelling in place (a no-op stays a no-op).
    expect(row(written, 'us.anthropic.claude-opus-5').pricing).toEqual({ input: 5.5, output: 27.5, source: 'published' });
    expect(row(written, 'us.anthropic.claude-opus-5').price).toBeUndefined();
    // The card keeps billing the carried rates.
    expect(h.written(PRICING_KEY).models['openai.gpt-5.5']).toEqual({ input: 1.25, output: 10 });
  });

  it('treats a manual rate exactly like a published one: drift recorded, nothing applied', async () => {
    const doc = baseDoc();
    row(doc, 'us.anthropic.claude-opus-5').pricing = { input: 5.5, output: 27.5, source: 'manual' };
    const h = harness({
      doc,
      products: {
        'USE1-MP:USE1_input_tokens_standard-Units': 7.5,
        'USE1-MP:USE1_output_tokens_standard-Units': 30,
      },
    });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', promoted: 0, repriced: 0, drifts: ['us.anthropic.claude-opus-5'] });
    expect(row(h.written(MODELS_KEY), 'us.anthropic.claude-opus-5').price).toEqual({
      input: 5.5, output: 27.5, source: 'manual',
      priceDrift: { input: 7.5, output: 30, seenAt: '2026-09-24T03:00:00.000Z' },
    });
  });

  it('an unknown source string is read as manual: drift, not overwrite', async () => {
    // parsePrice() in the TS canonical normalises anything outside
    // published|interim|manual to `manual`; the reconcile must read it the same
    // way, or an operator's typo in `source` becomes a licence to overwrite.
    const doc = baseDoc();
    row(doc, 'us.anthropic.claude-opus-5').pricing = { input: 5.5, output: 27.5, source: 'operator' };
    const h = harness({
      doc,
      products: {
        'USE1-MP:USE1_input_tokens_standard-Units': 7.5,
        'USE1-MP:USE1_output_tokens_standard-Units': 30,
      },
    });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', promoted: 0, repriced: 0, drifts: ['us.anthropic.claude-opus-5'] });
    expect(row(h.written(MODELS_KEY), 'us.anthropic.claude-opus-5').price).toMatchObject({
      input: 5.5, output: 27.5, source: 'operator',
    });
  });

  it('prices an unpriced row from the Price List as published', async () => {
    const doc = baseDoc();
    doc.catalog.push({
      modelId: 'us.anthropic.claude-opus-6', vendor: 'anthropic', family: 'claude-opus',
      endpoint: 'bedrock-runtime', region: 'us-east-1', status: 'candidate',
    });
    const h = harness({
      doc,
      profiles: [...sameAsBase.profiles, { inferenceProfileId: 'us.anthropic.claude-opus-6', status: 'ACTIVE' }],
      products: {
        // The listing agrees with opus-5's carried rate, so only opus-6 changes.
        'USE1-MP:USE1_input_tokens_standard-Units': 5.5,
        'USE1-MP:USE1_output_tokens_standard-Units': 27.5,
      },
    });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', promoted: 0, repriced: 1, drifts: [] });
    expect(row(h.written(MODELS_KEY), 'us.anthropic.claude-opus-6').price).toEqual({
      input: 5.5, output: 27.5, source: 'published', asOf: '2026-09-24T03:00:00.000Z',
      sourceNote: 'Promoted from unpriced to the published Price List rate on 2026-09-24.',
    });
  });

  it('clears a stale priceDrift once the listing agrees again', async () => {
    const doc = baseDoc();
    row(doc, 'us.anthropic.claude-opus-5').pricing = {
      input: 5.5, output: 27.5, source: 'published',
      priceDrift: { input: 7.5, output: 30, seenAt: '2026-09-01T00:00:00.000Z' },
    };
    const h = harness({
      doc,
      products: {
        'USE1-MP:USE1_input_tokens_standard-Units': 5.5,
        'USE1-MP:USE1_output_tokens_standard-Units': 27.5,
      },
    });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', promoted: 0, repriced: 0, drifts: [] });
    expect(row(h.written(MODELS_KEY), 'us.anthropic.claude-opus-5').price).toEqual({
      input: 5.5, output: 27.5, source: 'published',
    });
    expect(h.logs.join('\n')).toContain('pricing.drift-cleared modelId=us.anthropic.claude-opus-5');
  });

  it('ignores a float hair between the listing and the carried rate (the TS 1e-6 tolerance)', async () => {
    const h = harness({
      products: {
        'USE1-MP:USE1_input_tokens_standard-Units': 5.5 + 1e-9,
        'USE1-MP:USE1_output_tokens_standard-Units': 27.5 - 1e-9,
      },
    });
    const s = await reconcileModels({}, h.deps);
    expect(s.drifts).toEqual([]);
    expect(h.putsFor(MODELS_KEY)).toEqual([]);
  });

  // ─── TEAM-5029 F4: Mantle retirement is scoped to the regions that answered ──

  const TWO_REGIONS = { BEDROCK_MANTLE_REGIONS: 'us-east-2,us-east-1' };

  it('does not retire a Mantle row whose own region failed to answer, even when another region did', async () => {
    // The production shape: the default sweep is us-east-2 then us-east-1;
    // openai.gpt-5.5 lives in us-east-2 and is defaults.codingCodex. us-east-2
    // is down, us-east-1 answers and (correctly) does not list it.
    const h = harness({
      env: TWO_REGIONS,
      mantleByRegion: { 'us-east-2': new Error('http 500'), 'us-east-1': [] },
      products: {},
    });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', retired: 0, added: 0, changed: false });
    expect(h.putsFor(MODELS_KEY)).toEqual([]);
    const logs = h.logs.join('\n');
    expect(logs).toContain('reconcile.discover-failed endpoint=bedrock-mantle region=us-east-2');
    expect(logs).not.toContain('reconcile.retired');
    expect(logs).not.toContain('reconcile.invalid-document');
  });

  it('retires an absent Mantle row whose region did answer, in the same pass', async () => {
    const doc = baseDoc();
    doc.catalog.push({
      modelId: 'openai.gpt-5.5-mini', label: 'GPT-5.5 mini', vendor: 'openai', family: 'gpt',
      endpoint: 'bedrock-mantle', region: 'us-east-1', api: 'responses', status: 'active',
      price: { input: 0.5, output: 2, source: 'published' },
    });
    const h = harness({
      doc,
      env: TWO_REGIONS,
      mantleByRegion: { 'us-east-2': new Error('http 500'), 'us-east-1': [] },
      products: {},
    });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', retired: 1, added: 0 });
    const written = h.written(MODELS_KEY);
    expect(row(written, 'openai.gpt-5.5-mini')).toMatchObject({ status: 'retired', retiredAt: '2026-09-24T03:00:00.000Z' });
    expect(row(written, 'openai.gpt-5.5').status).toBe('active');
    expect(written.defaults.codingCodex).toBe('openai.gpt-5.5');
    expect(h.logs.join('\n')).not.toContain('reconcile.invalid-document');
  });

  it('retires a Mantle row when every region in the sweep answered without it', async () => {
    // Both regions were listed and neither has it, so the pass retires it. The
    // row is defaults.codingCodex, so that document is one the fleet refuses —
    // the TEAM-5017 hazard. It must stay LOUD in the log, and since TEAM-5052 it
    // is also not written: the summary says `invalid` and the live row stands.
    const h = harness({
      env: TWO_REGIONS,
      mantleByRegion: { 'us-east-2': [], 'us-east-1': [] },
      products: {},
    });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'invalid', retired: 1 });
    expect(h.putsFor(MODELS_KEY)).toEqual([]);
    expect(row(h.written(MODELS_KEY), 'openai.gpt-5.5').status).toBe('active');
    const logs = h.logs.join('\n');
    expect(logs).toContain('reconcile.retired modelId=openai.gpt-5.5 reason=not_discovered');
    expect(logs).toContain('reconcile.invalid-document');
    expect(logs).toContain('defaults.codingCodex=inactive');
  });

  it('never retires a Mantle row that records no region', async () => {
    // A sweep is a list of regions; a row that names none is one no sweep could
    // ever have proved absent — same philosophy as retirable().
    const doc = baseDoc();
    doc.catalog.push({
      modelId: 'openai.gpt-5.5-nano', label: 'GPT-5.5 nano', vendor: 'openai', family: 'gpt',
      endpoint: 'bedrock-mantle', api: 'responses', status: 'active',
      price: { input: 0.1, output: 0.4, source: 'published' },
    });
    const h = harness({
      doc,
      env: TWO_REGIONS,
      mantleByRegion: { 'us-east-2': [{ id: 'openai.gpt-5.5' }], 'us-east-1': [] },
      products: {},
    });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', retired: 0, changed: false });
    expect(h.putsFor(MODELS_KEY)).toEqual([]);
  });

  // ─── TEAM-5029 F1: no pricing.json with a hole ────────────────────────────

  it('skips the pricing write, naming the hole, when a carried block fails the shared rule', async () => {
    // cacheWriteMultiplier without `default` fails carriedValid() in the TS
    // canonical; this Lambda ships no seed to fall back on, so it must leave the
    // last good pricing.json in place instead of publishing one with a hole.
    const pricing = { ...livePricing(), cacheWriteMultiplier: { '5m': 1.25, '1h': 2 } };
    const h = harness({ pricing, products: {} });
    const s = await reconcileModels({}, h.deps);
    expect(s.outcome).toBe('ok');
    expect(h.putsFor(PRICING_KEY)).toEqual([]);
    expect(h.logs.join('\n')).toContain('pricing.projected skipped reason=missing:cacheWriteMultiplier');
  });
});

// ─── the real registry ──────────────────────────────────────────────────────

/**
 * Every case above builds its own small document, which is exactly how TEAM-5022
 * hid: the fixtures put their rows under `models`, the real
 * `src/config/models.json` has only ever had `catalog`, and against the real file
 * this job appended a SECOND, unpriced catalog under `models` and then published
 * `pricing.json` with an empty `models` map — all 32 priced ids gone. So these two
 * cases run the reconcile against the bundled seed itself. They assert the
 * negative that matters: the pass must never introduce a `models` key, and it
 * must never publish a pricing document that has lost the catalog's prices.
 */
/** A pricing write is allowed; LOSING the catalog's prices is not. `models: {}`
 *  is precisely what the pre-fix projection published. */
function expectPricingIntact(h) {
  const puts = h.putsFor(PRICING_KEY);
  if (!puts.length) return;
  expect(JSON.parse(puts[puts.length - 1].body).models).toEqual(SEED_PRICING.models);
}

describe('reconcileModels — against the bundled seed', () => {
  // The ticket's literal acceptance scenario: BOTH planes answer and report
  // exactly the account state the seed already describes. Before TEAM-5022 this
  // still wrote a `models` key (the F1 bug) — and, found while writing THIS
  // case, the un-guarded retirement loop then retired the eval judge's bare
  // foundation-model row (`readOnly: true`, no `us.`/`global.`/`openai.`
  // prefix) on every run, because it can never appear in an inference-profile
  // listing. A healthy night against unchanged reality must be a complete no-op.
  it('is a complete no-op when discovery reports exactly what the seed already has', async () => {
    const profiles = SEED_MODELS.catalog
      .filter((r) => (r.endpoint || 'bedrock-runtime') === 'bedrock-runtime'
        && ['active', 'candidate'].includes(r.status || 'active'))
      .map((r) => ({ inferenceProfileId: r.modelId, status: 'ACTIVE', inferenceProfileName: r.label }));
    const mantle = SEED_MODELS.catalog
      .filter((r) => r.endpoint === 'bedrock-mantle')
      .map((r) => ({ id: r.modelId }));

    const h = harness({
      doc: SEED_MODELS,
      pricing: SEED_PRICING,
      profiles,
      mantle,
      products: {},
      probeCli: async () => ({ ok: false }),
    });
    const s = await reconcileModels({}, h.deps);

    expect(s).toMatchObject({
      outcome: 'ok', added: 0, retired: 0, repriced: 0, promoted: 0, autoAdopted: 0,
    });
    expect(h.putsFor(MODELS_KEY)).toEqual([]);
    expect(JSON.parse(h.store.get(MODELS_KEY).body).models).toBeUndefined();
    expectPricingIntact(h);
  });

  it('writes nothing when discovery cannot reach either plane', async () => {
    // A failed scan proves nothing, so no row may be retired — and with every
    // seed row already priced there is nothing to reprice either. The whole pass
    // is a no-op, which is the shape a healthy night has.
    const h = harness({ doc: SEED_MODELS, pricing: SEED_PRICING, profilesThrow: true, mantleThrow: true, products: {} });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', added: 0, retired: 0, repriced: 0, changed: false });
    expect(h.putsFor(MODELS_KEY)).toEqual([]);
    expect(h.logs.join('\n')).not.toContain('reconcile.invalid-document');
    expectPricingIntact(h);
  });

  it('adds a discovered model to catalog, never to a new models array', async () => {
    // Only the Mantle plane answers, so only Mantle rows are eligible for
    // retirement — and `openai.gpt-5.5`, the seed's one Mantle row, is in the
    // answer. The 20 Bedrock Runtime rows are untouched because their plane was
    // never scanned.
    const before = JSON.parse(JSON.stringify(SEED_MODELS));
    const h = harness({
      doc: SEED_MODELS,
      pricing: SEED_PRICING,
      profilesThrow: true,
      mantle: [{ id: 'openai.gpt-5.5' }, { id: 'openai.gpt-6-nova' }],
      products: {},
    });
    const s = await reconcileModels({}, h.deps);
    expect(s).toMatchObject({ outcome: 'ok', added: 1, retired: 0, autoAdopted: 0 });

    const doc = h.written(MODELS_KEY);
    expect(doc.models).toBeUndefined();
    expect(doc.catalog).toHaveLength(before.catalog.length + 1);
    expect(doc.catalog.slice(0, before.catalog.length)).toEqual(before.catalog);
    expect(row(doc, 'openai.gpt-6-nova')).toMatchObject({ status: 'candidate', endpoint: 'bedrock-mantle' });
    expectPricingIntact(h);
  });

  it('refuses to publish pricing from a document it could not validate', async () => {
    // `defaults.persona` points at a Runtime row, and this time the Runtime plane
    // IS scanned and comes back without it: the pass retires a current routing
    // target, so the document it would write is one the fleet will refuse.
    // Neither models.json nor pricing.json goes out (TEAM-5052), and the summary
    // says `invalid` rather than `ok`. Whether the pass should propose that
    // retirement at all is still TEAM-5017's.
    const doc = JSON.parse(JSON.stringify(SEED_MODELS));
    const persona = doc.defaults.persona;
    const h = harness({
      doc,
      pricing: SEED_PRICING,
      profiles: doc.catalog
        .filter((r) => (r.endpoint || 'bedrock-runtime') === 'bedrock-runtime' && r.modelId !== persona)
        .map((r) => ({ inferenceProfileId: r.modelId, status: 'ACTIVE' })),
      mantleThrow: true,
      products: {},
    });
    const s = await reconcileModels({}, h.deps);
    expect(s.outcome).toBe('invalid');
    expect(s.errors).toContain('defaults.persona=inactive');
    expect(s.changed).toBe(false);
    expect(h.putsFor(MODELS_KEY)).toEqual([]);
    expect(row(h.written(MODELS_KEY), persona).status ?? 'active').toBe('active');
    expect(h.putsFor(PRICING_KEY)).toEqual([]);
    const logs = h.logs.join('\n');
    expect(logs).toContain('reconcile.invalid-document');
    expect(logs).toContain('defaults.persona=inactive');
    expect(logs).toContain('pricing.projected skipped reason=invalid_registry');
    expect(logs).toMatch(/reconcile\.summary .* outcome=invalid errors=.*defaults\.persona=inactive/);
  });
});

// TEAM-5052 — the production night: the seed's retired `us.anthropic.claude-opus-4-6`
// carries `aliases: ["us.anthropic.claude-opus-4-6-v1"]`, discovery lists that
// alias as an inference profile, and mergeDiscovery() (keyed on modelId only)
// added it as a new candidate row. The written document then failed every
// validator on `duplicate_alias`, yet the pass PUT it and reported `ok`.
describe('reconcileModels — a discovered id that is already a row alias (TEAM-5052)', () => {
  const ALIAS = 'us.anthropic.claude-opus-4-6-v1';
  const OWNER = 'us.anthropic.claude-opus-4-6';

  /** The seed's live Runtime rows, exactly as the no-op case above lists them,
   *  plus the retired row's alias as a live profile. */
  const seedProfilesPlusAlias = () => [
    ...SEED_MODELS.catalog
      .filter((r) => (r.endpoint || 'bedrock-runtime') === 'bedrock-runtime'
        && ['active', 'candidate'].includes(r.status || 'active'))
      .map((r) => ({ inferenceProfileId: r.modelId, status: 'ACTIVE', inferenceProfileName: r.label })),
    { inferenceProfileId: ALIAS, status: 'ACTIVE', inferenceProfileName: 'Claude Opus 4.6' },
  ];

  const fatalOf = (body) => fatalReadErrors(validateRegistry(JSON.parse(body)).errors);

  it('the precondition: the seed row owns the alias and the seed itself validates', () => {
    expect(row(SEED_MODELS, OWNER)).toMatchObject({ status: 'retired', aliases: [ALIAS] });
    expect(validateRegistry(SEED_MODELS).registry).not.toBeNull();
  });

  it('writes a models.json the shared validator accepts', async () => {
    const h = harness({
      doc: SEED_MODELS, pricing: SEED_PRICING, profiles: seedProfilesPlusAlias(), mantleThrow: true, products: {},
    });
    await reconcileModels({ mode: 'reconcile' }, h.deps);

    for (const put of h.putsFor(MODELS_KEY)) {
      const verdict = validateRegistry(JSON.parse(put.body));
      expect(fatalReadErrors(verdict.errors)).toEqual({});
      expect(verdict.registry).not.toBeNull();
    }
    // Whatever the fix does with the alias, it must not mint a second row that
    // claims the same id.
    const live = JSON.parse(h.store.get(MODELS_KEY).body);
    const claimants = live.catalog.filter((r) => r.modelId === ALIAS || (r.aliases || []).includes(ALIAS));
    expect(claimants.map((r) => r.modelId)).toHaveLength(1);
  });

  it('never reports ok after PUTting a document the validators refuse', async () => {
    const h = harness({
      doc: SEED_MODELS, pricing: SEED_PRICING, profiles: seedProfilesPlusAlias(), mantleThrow: true, products: {},
    });
    const s = await reconcileModels({ mode: 'reconcile' }, h.deps);

    const invalidPuts = h.putsFor(MODELS_KEY).filter((p) => Object.keys(fatalOf(p.body)).length);
    // Either no refused document goes out at all, or the summary says so.
    if (invalidPuts.length) expect(s.outcome).not.toBe('ok');
    expect(invalidPuts).toEqual([]);
  });

  it('moves the alias of an ACTIVE row to the new candidate row', async () => {
    const doc = baseDoc();
    doc.catalog[0].aliases = ['us.anthropic.claude-opus-5-v1'];
    const h = harness({
      doc,
      profiles: [...sameAsBase.profiles, { inferenceProfileId: 'us.anthropic.claude-opus-5-v1', status: 'ACTIVE' }],
      products: {},
    });
    const s = await reconcileModels({}, h.deps);
    expect(s.outcome).toBe('ok');
    expect(s.added).toBe(1);
    for (const put of h.putsFor(MODELS_KEY)) expect(fatalOf(put.body)).toEqual({});
    const live = h.written(MODELS_KEY);
    expect(row(live, 'us.anthropic.claude-opus-5').aliases).toEqual([]);
    expect(row(live, 'us.anthropic.claude-opus-5').status).toBe('active');
    expect(row(live, 'us.anthropic.claude-opus-5-v1')).toMatchObject({ status: 'candidate', aliases: [] });
  });

  it('the TS validator accepts the written document too', async () => {
    const h = harness({
      doc: SEED_MODELS, pricing: SEED_PRICING, profiles: seedProfilesPlusAlias(), mantleThrow: true, products: {},
    });
    const s = await reconcileModels({ mode: 'reconcile' }, h.deps);
    expect(s.outcome).toBe('ok');
    expect(h.putsFor(MODELS_KEY)).toHaveLength(1);
    const body = h.store.get(MODELS_KEY).body;
    const { registry } = parseTs(body);
    expect(fatalTs(validateTs(registry).errors)).toEqual({});
    // Same verdict as the mjs twin, not merely "both happen to pass".
    expect(fatalOf(body)).toEqual({});
  });

  it("the released alias's row carries the owner's price as interim", async () => {
    const h = harness({
      doc: SEED_MODELS, pricing: SEED_PRICING, profiles: seedProfilesPlusAlias(), mantleThrow: true, products: {},
    });
    await reconcileModels({ mode: 'reconcile' }, h.deps);
    const owner = row(SEED_MODELS, OWNER);
    const fresh = row(h.written(MODELS_KEY), ALIAS);
    expect(fresh).toMatchObject({ status: 'candidate', aliases: [] });
    expect(fresh.price).toMatchObject({
      input: owner.price.input,
      output: owner.price.output,
      source: 'interim',
      asOf: '2026-09-24T03:00:00.000Z',
    });
    expect(fresh.price.sourceNote).toContain(OWNER);
    expect(fresh.pricing).toBeUndefined();
  });

  it('leaves the retired owner retired and logs reconcile.alias-released', async () => {
    const h = harness({
      doc: SEED_MODELS, pricing: SEED_PRICING, profiles: seedProfilesPlusAlias(), mantleThrow: true, products: {},
    });
    const s = await reconcileModels({ mode: 'reconcile' }, h.deps);
    expect(s.added).toBe(1);
    const owner = row(h.written(MODELS_KEY), OWNER);
    expect(owner.status).toBe('retired');
    expect(owner.aliases).toEqual([]);
    expect(h.logs.join('\n')).toContain(`reconcile.alias-released modelId=${ALIAS} owner=${OWNER}`);
  });

  it('heals a live document that already claims an id as both row and alias', async () => {
    // What the pre-fix reconcile actually wrote (S3 v2): the candidate row
    // exists AND the retired owner still lists it as an alias.
    const doc = JSON.parse(JSON.stringify(SEED_MODELS));
    doc.version = 2;
    doc.catalog.push({ ...row(doc, OWNER), modelId: ALIAS, aliases: [], status: 'candidate' });
    expect(Object.values(fatalOf(JSON.stringify(doc)))).toContain('duplicate_alias');

    const h = harness({ doc, pricing: SEED_PRICING, profiles: seedProfilesPlusAlias(), mantleThrow: true, products: {} });
    const s = await reconcileModels({ mode: 'reconcile' }, h.deps);
    expect(s.outcome).toBe('ok');
    const body = h.store.get(MODELS_KEY).body;
    expect(fatalOf(body)).toEqual({});
    const live = JSON.parse(body);
    expect(live.version).toBe(3);
    expect(row(live, OWNER).aliases).toEqual([]);
    expect(live.catalog.filter((r) => r.modelId === ALIAS)).toHaveLength(1);
    expect(h.logs.join('\n')).toContain(`reconcile.alias-dropped modelId=${ALIAS} owner=${OWNER} reason=existing_row`);
  });

  it('keeps an alias that routing points at, and adds no candidate for it', async () => {
    const doc = baseDoc();
    doc.catalog[0].aliases = ['us.anthropic.claude-opus-5-v1'];
    doc.agents.agentcore_hub_backend_dev = 'us.anthropic.claude-opus-5-v1';
    const h = harness({
      doc,
      profiles: [...sameAsBase.profiles, { inferenceProfileId: 'us.anthropic.claude-opus-5-v1', status: 'ACTIVE' }],
      products: {},
    });
    const s = await reconcileModels({}, h.deps);
    expect(s.outcome).toBe('ok');
    expect(s.added).toBe(0);
    for (const put of h.putsFor(MODELS_KEY)) expect(fatalOf(put.body)).toEqual({});
    const live = h.written(MODELS_KEY);
    expect(row(live, 'us.anthropic.claude-opus-5').aliases).toEqual(['us.anthropic.claude-opus-5-v1']);
    expect(row(live, 'us.anthropic.claude-opus-5-v1')).toBeUndefined();
    expect(h.logs.join('\n')).toContain('reconcile.skipped modelId=us.anthropic.claude-opus-5-v1 '
      + 'reason=alias_of=us.anthropic.claude-opus-5 routing_target=true');
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

// TEAM-5073 — a routing target that is an ALIAS keeps its owner alive. The skip
// leaves the routed alias on its owner, so retiring that owner on absence makes
// the agent resolve to a retired row: `outcome=invalid` every night. Only alias
// owners are protected — a DIRECTLY routed row is still TEAM-5017's (see
// 'refuses to publish pricing from a document it could not validate').
// Same case names as discovery.test.ts.
describe('reconcileModels — a routed alias protects its owner from retirement (TEAM-5073)', () => {
  const OWNER = 'us.anthropic.claude-opus-5-5';
  const ALIAS = `${OWNER}-v1`;
  const AGENT = 'agentcore_hub_backend_dev';
  const fatalOf = (body) => fatalReadErrors(validateRegistry(JSON.parse(body)).errors);

  const routedThroughAlias = () => {
    const doc = JSON.parse(JSON.stringify(SEED_MODELS));
    row(doc, OWNER).aliases.push(ALIAS);
    doc.agents = { ...doc.agents, [AGENT]: ALIAS };
    return doc;
  };
  /** Every live Runtime row EXCEPT the owner, optionally plus the routed alias. */
  const profilesWithoutOwner = (doc, withAlias) => [
    ...doc.catalog
      .filter((r) => (r.endpoint || 'bedrock-runtime') === 'bedrock-runtime'
        && ['active', 'candidate'].includes(r.status || 'active') && r.modelId !== OWNER)
      .map((r) => ({ inferenceProfileId: r.modelId, status: 'ACTIVE' })),
    ...(withAlias ? [{ inferenceProfileId: ALIAS, status: 'ACTIVE' }] : []),
  ];

  it('the precondition: nothing but the alias routes at the owner, and the document validates', () => {
    const doc = routedThroughAlias();
    const direct = [
      ...Object.values(doc.defaults), ...Object.values(doc.tiers.claude), ...Object.values(doc.tiers.codex),
      ...Object.values(doc.legacyAliases),
      ...Object.entries(doc.agents).filter(([k]) => k !== AGENT).map(([, v]) => v),
    ];
    expect(direct).not.toContain(OWNER);
    expect(fatalReadErrors(validateRegistry(doc).errors)).toEqual({});
  });

  for (const withAlias of [true, false]) {
    it(`keeps the owner when the sweep ${withAlias ? 'lists the routed alias but not the owner' : 'lists neither the owner nor the alias'}`, async () => {
      const doc = routedThroughAlias();
      const h = harness({
        doc, pricing: SEED_PRICING, profiles: profilesWithoutOwner(doc, withAlias), mantleThrow: true, products: {},
      });
      const s = await reconcileModels({ mode: 'reconcile' }, h.deps);
      expect(s.outcome).toBe('ok');
      expect(s.errors).toBeUndefined();
      expect(s.retired).toBe(0);
      for (const put of h.putsFor(MODELS_KEY)) expect(fatalOf(put.body)).toEqual({});
      const live = h.written(MODELS_KEY);
      expect(row(live, OWNER).status ?? 'active').toBe('active');
      expect(row(live, OWNER).aliases).toContain(ALIAS);
      expect(row(live, ALIAS)).toBeUndefined();
      expect(h.logs.join('\n')).toContain(`reconcile.retire-skipped modelId=${OWNER} reason=routed_alias=${ALIAS}`);
    });
  }

  it('still retires an unrouted row that vanished', async () => {
    const doc = JSON.parse(JSON.stringify(SEED_MODELS));
    const h = harness({
      doc, pricing: SEED_PRICING, profiles: profilesWithoutOwner(doc, false), mantleThrow: true, products: {},
    });
    const s = await reconcileModels({ mode: 'reconcile' }, h.deps);
    expect(s.outcome).toBe('ok');
    expect(s.retired).toBe(1);
    expect(row(h.written(MODELS_KEY), OWNER).status).toBe('retired');
  });
});
