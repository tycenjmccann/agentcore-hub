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
  CHAIN_STEPS,
  NON_FATAL_READ_REASONS,
  fatalReadErrors,
  validateRegistry,
  parseRegistry,
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
  serviceCodeFor,
  CARRIED_PRICING_KEYS,
  pricingProjection,
} from './models-registry.mjs';

const SEED_PATH = fileURLToPath(new URL('../../src/config/models.json', import.meta.url));
const PRICING_PATH = fileURLToPath(new URL('../../src/config/pricing.json', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../src/config/__fixtures__/models-registry.case.json', import.meta.url));

// The fixture reads the BUNDLED SEED, so both paths have to be here for any of it
// to mean anything. When either is absent the fixture block skips with the missing
// path named IN THE DESCRIBE TITLE, so it prints in the vitest summary — never
// silently, because this block is the only proof the twins and the canonical
// agree, and a vacuous pass is the exact defect being fixed.
const MISSING = [
  ['src/config/models.json', SEED_PATH],
  ['src/config/__fixtures__/models-registry.case.json', FIXTURE],
].filter(([, path]) => !existsSync(path)).map(([rel]) => rel);

// ─── a registry small enough to read, big enough to be interesting ──────────

// Every row something ROUTES at carries a price, and the one candidate row
// carries both green probe planes: validateRegistry now refuses a document whose
// defaults/tiers/agents/legacyAliases point at an unpriced or half-probed row,
// exactly as the TS canonical does on its read path. A test registry without
// prices would be a document the hub itself would reject.
const registryDoc = () => ({
  version: 3,
  updatedAt: '2026-09-24T00:00:00Z',
  updatedBy: 'tester',
  catalog: [
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
    { modelId: 'us.anthropic.claude-opus-5', vendor: 'anthropic', family: 'claude-opus', status: 'active', price: { input: 3, output: 15 } },
    {
      modelId: 'us.anthropic.claude-sonnet-5',
      vendor: 'anthropic',
      family: 'claude-sonnet',
      status: 'candidate',
      price: { input: 3, output: 15 },
      // A candidate needs BOTH probe planes green to be a legal routing target
      // (tiers.claude.sonnet points here) — see targetReasonFor.
      probe: { api: { ok: true }, cli: { ok: true } },
    },
    { modelId: 'us.anthropic.claude-opus-4-1', vendor: 'anthropic', family: 'claude-opus', status: 'retired' },
    {
      modelId: 'us.openai.gpt-6-sol',
      vendor: 'openai',
      family: 'gpt-sol',
      endpoint: 'bedrock-runtime',
      region: 'us-east-1',
      api: 'responses',
      contextWindow: 300000,
      price: { input: 2, output: 8 },
    },
    {
      modelId: 'openai.gpt-5.5',
      vendor: 'openai',
      family: 'gpt',
      endpoint: 'bedrock-mantle',
      region: 'us-east-2',
      api: 'responses',
      price: { input: 2, output: 8 },
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
  expect(errors).toEqual({});
  return registry;
}

/** A logger the resolvers can warn into without polluting the test output. */
const quiet = () => ({ warn: () => {}, log: () => {} });

// ─── 1. the shared, language-neutral fixture ────────────────────────────────
//
// Reader for src/config/__fixtures__/models-registry.case.json. The real case
// shape is
//     {name, registry: "seed"|null, patch?, input: {kind, …}, expected: {…}}
// — `input` and `expected` are OBJECTS, and `registry` NAMES the bundled seed
// instead of carrying an inline document, so the rows under test are the ones
// production actually routes through. The first reader here guessed a flat
// `{registry:<object>, kind, input:<string>, expected:<string>}` schema and so
// passed while asserting nothing; every divergence below it was invisible.
//
// DELIBERATE NARROWING, stated here rather than hidden in a skip: resolveModel()
// in this twin returns a bare model id, so it reports no lookup kind — the
// fixture's `via` is asserted by the TS canonical, which has that channel. The
// chain resolvers DO carry `source`, and it is asserted against the fixture's
// closed enum.

// `src/config/pricing.json` is on this branch already, so it needs no guard; the
// seed is read lazily because it is not.
const SEED_PRICING = JSON.parse(
  readFileSync(new URL('../../src/config/pricing.json', import.meta.url), 'utf8')
);
const seedDoc = () => JSON.parse(readFileSync(SEED_PATH, 'utf8'));

const FIXTURE_CASES = MISSING.length ? [] : JSON.parse(readFileSync(FIXTURE, 'utf8')).cases;

// Named CASES that are a deliberate, documented behaviour difference rather than a
// missing kind. Empty: validateRegistry now mirrors the canonical's read-time
// verdict reason for reason, so every validate case is asserted here too. A
// silently skipped case is exactly how the previous reader stayed green while
// asserting nothing, so the accounting test below fails the moment this map and
// the fixture disagree. There is deliberately NO hardcoded case count — the API
// dev adds cases on their own branch, and a count here would turn every addition
// into a red build on this one.
const SKIPPED_CASES = {};

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * The case's input document — mirror of rawRegistryFor() in the TS test. Typed
 * patch ops rather than dotted paths: model ids contain dots, so
 * "catalog.us.anthropic.claude-opus-5.price" would be ambiguous.
 */
function rawRegistryFor(c) {
  if (c.registry === null || c.registry === undefined) return null;
  expect(c.registry, 'only the bundled seed is a named registry').toBe('seed');
  const raw = seedDoc();
  const p = c.patch || {};
  for (const key of ['defaults', 'agents', 'legacyAliases']) {
    if (p[key]) Object.assign((raw[key] ??= {}), p[key]);
  }
  for (const [cli, map] of Object.entries(p.tiers || {})) {
    Object.assign(((raw.tiers ??= {})[cli] ??= {}), map);
  }
  if (p.quarantine) raw.quarantine = clone(p.quarantine);
  if (p.addRows) raw.catalog.push(...clone(p.addRows));
  for (const drop of p.dropRowFields || []) {
    const row = raw.catalog.find((r) => r.modelId === drop.modelId);
    expect(row, `dropRowFields target ${drop.modelId} must exist in the seed`).toBeTruthy();
    for (const field of drop.fields) delete row[field];
  }
  return raw;
}

const DESCRIBE_TITLE = MISSING.length
  ? `shared fixture — SKIPPED, not on this branch yet: ${MISSING.join(', ')} are authored by the `
    + 'API dev\'s ticket (TEAM-4997) and present once that branch merges; the fixture-independent '
    + 'tests below carry the coverage until then'
  : 'shared fixture';

describe.skipIf(MISSING.length)(DESCRIBE_TITLE, () => {
  it('accounts for every case: asserted, or skipped by name', () => {
    const names = FIXTURE_CASES.map((c) => c.name);
    const kinds = new Set(FIXTURE_CASES.map((c) => c.input.kind));
    expect(new Set(names).size).toBe(names.length);
    expect(names.length, `the fixture looks truncated: ${names.length} cases`).toBeGreaterThanOrEqual(20);
    // A skip that outlives its case is a skip nobody will ever notice.
    expect(Object.keys(SKIPPED_CASES).filter((n) => !names.includes(n))).toEqual([]);
    // And a kind no branch of the reader handles must not slip through as a pass.
    const handled = ['resolveModel', 'resolveAgentModel', 'resolveCodingModel', 'parse', 'validate', 'projection'];
    expect([...kinds].filter((k) => !handled.includes(k))).toEqual([]);
    const asserted = names.filter((n) => !(n in SKIPPED_CASES));
    expect(asserted.length + Object.keys(SKIPPED_CASES).length).toBe(names.length);
    // A `reseeded` key the projection does not carry would be asserted against
    // nothing and pass; every one must be a real carried block.
    for (const c of FIXTURE_CASES) {
      if (c.input.kind !== 'projection' || !c.expected.reseeded) continue;
      expect(c.expected.reseeded.filter((k) => !CARRIED_PRICING_KEYS.includes(k)), c.name).toEqual([]);
    }
  });

  it('reads the bundled seed as-is', () => {
    // The TS canonical adds row fields this twin does not resolve on
    // (`harnessLanes`, `lanes`); a tolerant parser carries them through rather
    // than dropping the row. `price`, `readOnly`, `probe` and `status` ARE read
    // now — they are what validateRegistry checks a routing target against.
    const { registry, errors } = validateRegistry(seedDoc());
    expect(errors).toEqual({});
    expect(registry.models).toHaveLength(21);
    expect(registry.models.find((r) => r.modelId === 'us.anthropic.claude-fable-5-1').price.input).toBe(11);
    // `quarantine` is a resolution refusal, never a row drop; and `readOnly` bars
    // a row from being a ROUTING TARGET, not from being asked for by name — the
    // eval judge's read-only row still resolves when a caller names it.
    expect(resolveModel(registry, 'anthropic.claude-opus-5', { log: quiet() })).toBe('anthropic.claude-opus-5');
  });

  for (const c of FIXTURE_CASES) {
    const skip = SKIPPED_CASES[c.name];
    (skip ? it.skip : it)(`${c.name}${skip ? ` — ${skip}` : ''}`, () => {
      const raw = rawRegistryFor(c);
      const { kind } = c.input;
      const env = c.input.env || {};
      const ctx = { cli: c.input.cli, log: quiet() };

      if (kind === 'validate') {
        // Field path AND reason, not a substring: the reasons are the contract
        // (`unpriced` vs `inactive` decides what an operator goes and fixes), and
        // a substring match would pass on the right path with the wrong verdict.
        const { registry, errors } = validateRegistry(raw);
        expect(Object.keys(errors).length === 0, JSON.stringify(errors)).toBe(c.expected.ok);
        for (const [field, reason] of Object.entries(c.expected.errors)) {
          expect(errors[field], `${field} in ${JSON.stringify(errors)}`).toBe(reason);
        }
        // The READ-time verdict: a non-null registry is what the loaders serve.
        // Defaults to `ok` — only NON_FATAL_READ_REASONS make the two differ.
        expect(registry !== null, `${c.name} readable`).toBe(c.expected.readable ?? c.expected.ok);
        return;
      }

      // PARSE, not validate: the fixture's resolve cases are defined over a
      // normalized document, the same way the canonical's resolveModel() takes a
      // registry rather than a verdict. `quarantined-id` is only expressible that
      // way — a document that quarantines a model its own tier points at is one
      // the read gate refuses, and the case is about what the RESOLVER does with it.
      let registry = null;
      let warnings = [];
      if (raw) {
        const parsed = parseRegistry(raw);
        expect(parsed.registry, `${c.name}: this case's document must normalize`).not.toBeNull();
        registry = parsed.registry;
        warnings = parsed.warnings;
      }

      switch (kind) {
        case 'parse': {
          const ids = registry.models.map((r) => r.modelId);
          for (const id of c.expected.catalogIdsInclude) expect(ids, `${id} must stay`).toContain(id);
          for (const id of c.expected.catalogIdsExclude) expect(ids, `${id} must drop`).not.toContain(id);
          const dated = warnings.filter((w) => w.includes('dated duplicate'));
          const want = c.expected.warnings.filter((w) => w.reason === 'dated_duplicate');
          // Count, not just presence: a warning the fixture does not expect means
          // the twin dropped a row the canonical keeps.
          expect(dated, JSON.stringify(dated)).toHaveLength(want.length);
          for (const w of want) expect(dated.some((d) => d.includes(w.modelId))).toBe(true);
          break;
        }
        // `expected.modelId: null` means the resolver must REFUSE and fall through —
        // the caller's next precedence step, never a guess. `expected.rejected` names
        // WHY, which only a loader with a diagnostics channel can assert; this twin
        // returns a bare id from resolveModel, so the refusal itself is what is
        // pinned there, while the chain resolvers also assert `source`.
        case 'resolveModel':
          expect(resolveModel(registry, c.input.value ?? '', ctx), c.name).toBe(c.expected.modelId ?? null);
          break;
        case 'resolveAgentModel': {
          const got = resolveAgentModel(registry, c.input.agentId || '', c.input.override || '', env, ctx);
          expect(got.modelId, c.name).toBe(c.expected.modelId ?? null);
          expect(got.source, `${c.name}.source`).toBe(c.expected.source);
          expect(CHAIN_STEPS, `${c.name}.source`).toContain(got.source);
          break;
        }
        case 'resolveCodingModel': {
          const got = resolveCodingModel(registry, c.input.value ?? '', c.input.cli, env, ctx);
          expect(got.modelId, c.name).toBe(c.expected.modelId ?? null);
          if (c.expected.modelId != null) {
            expect(got.endpoint, `${c.name}.endpoint`).toBe(c.expected.endpoint);
            expect(got.region, `${c.name}.region`).toBe(c.expected.region);
            expect(got.api, `${c.name}.api`).toBe(c.expected.api);
          }
          expect(got.source, `${c.name}.source`).toBe(c.expected.source);
          expect(CHAIN_STEPS, `${c.name}.source`).toContain(got.source);
          break;
        }
        case 'projection': {
          // pricingProjection returns {pricing, prevSourceNotes}; the fixture
          // describes the DOCUMENT, which is the `pricing` half — plus, for the
          // carried-block boundary cases, WHICH blocks fell back (`reseeded`).
          const { pricing: doc, prevSourceNotes } = pricingProjection(registry, c.input.previousPricing ?? null, SEED_PRICING);
          if (c.expected.keyOrder) expect(Object.keys(doc.models)).toEqual(c.expected.keyOrder);
          if (c.expected.topLevelKeyOrder) expect(Object.keys(doc)).toEqual(c.expected.topLevelKeyOrder);
          for (const [id, entry] of Object.entries(c.expected.spot || {})) {
            expect(doc.models[id], `spot ${id}`).toEqual(entry);
          }
          for (const key of c.expected.carried || []) expect(doc[key], `carried ${key}`).toBeDefined();
          for (const key of c.expected.carriedEqualsPrevious || []) {
            expect(doc[key], `carried ${key}`).toEqual(c.input.previousPricing[key]);
          }
          for (const id of c.expected.modelsExclude || []) expect(doc.models[id]).toBeUndefined();
          // `reseeded`: the live block failed carriedValid()'s rule, so with the
          // bundled seed supplied the projection takes the seed's copy and says so…
          for (const key of c.expected.reseeded || []) {
            expect(prevSourceNotes, `reseeded ${key}`).toContain(`seed:${key}`);
            expect(doc[key], `reseeded ${key}`).toEqual(SEED_PRICING[key]);
          }
          if (c.expected.reseeded !== undefined) {
            const kept = CARRIED_PRICING_KEYS.filter((k) => !c.expected.reseeded.includes(k));
            expect(prevSourceNotes.filter((n) => !c.expected.reseeded.some((k) => n === `seed:${k}`))).toEqual([]);
            for (const key of kept) expect(doc[key], `kept ${key}`).toEqual(c.input.previousPricing[key]);
          }
          // …and WITHOUT a seed (the Lambda ships none) the same document must
          // report the hole rather than paper over it.
          if ((c.expected.reseeded || []).length) {
            const bare = pricingProjection(registry, c.input.previousPricing ?? null, null);
            for (const key of c.expected.reseeded) {
              expect(bare.prevSourceNotes, `missing ${key}`).toContain(`missing:${key}`);
              expect(bare.pricing[key], `missing ${key}`).toBeUndefined();
            }
          }
          break;
        }
        default:
          throw new Error(`${c.name}: unknown case kind ${kind} — teach the reader, do not skip it`);
      }
    });
  }
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
    // Only the MODEL ID is quarantined here, deliberately: the kill switch is a
    // list of models, and an operator must not have to also guess every tier word
    // and alias that reaches one. This used to pass only because 'opus' was in the
    // list too -- the re-check after resolution is what makes it real.
    //
    // The list is set AFTER validation on purpose. A document that ROUTES at a
    // quarantined model is now refused outright (see the validateRegistry tests
    // below), matching the hub, so the only way to observe the resolver's
    // re-check on the tier path is a registry quarantined after it was read —
    // which is exactly what a cached registry plus a fresh kill switch looks like.
    const reg = validated();
    reg.quarantine = ['us.anthropic.claude-opus-5'];
    expect(resolveModel(reg, 'opus', { cli: 'claude', log: quiet() })).toBeNull();
    expect(resolveModel(reg, 'us.anthropic.claude-opus-5', { log: quiet() })).toBeNull();
  });

  it('re-checks quarantine after tier and alias resolution', () => {
    const reg = validated();
    reg.quarantine = ['us.anthropic.claude-fable-5-1', 'us.anthropic.claude-sonnet-5'];
    expect(resolveModel(reg, 'fable', { cli: 'claude', log: quiet() })).toBeNull();        // via tiers
    expect(resolveModel(reg, 'fable-5', { log: quiet() })).toBeNull();                     // via a row alias
    expect(resolveModel(reg, 'claude-sonnet-45', { log: quiet() })).toBeNull();            // via legacyAliases
    expect(resolveModel(reg, 'us.anthropic.claude-fable-5-1', { log: quiet() })).toBeNull();
    // A quarantined ROW status is refused the same way, with or without the list.
    const byStatus = validated();
    byStatus.models.find((r) => r.modelId === 'us.anthropic.claude-opus-5').status = 'quarantined';
    expect(resolveModel(byStatus, 'opus', { cli: 'claude', log: quiet() })).toBeNull();
  });

  it('matches a tier word EXACTLY, never case-folded', () => {
    // Tier words are document KEYS, not user prose. Case-folding them made 'OPUS'
    // resolve here and not in the hub, whose resolver is exact-case.
    const reg = validated();
    expect(resolveModel(reg, 'opus', { cli: 'claude' })).toBe('us.anthropic.claude-opus-5');
    expect(resolveModel(reg, 'OPUS', { cli: 'claude' })).toBeNull();
    expect(resolveModel(reg, 'Opus', { cli: 'claude' })).toBeNull();
    expect(resolveModel(reg, 'SOL', { cli: 'codex' })).toBeNull();
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
  it('walks override -> agents -> defaults -> env -> literal', () => {
    // Every `source` here is a CHAIN_STEPS word — the vocabulary the fixture, the
    // canonical and the /models UI share. Which env var it was is detail, and
    // rides along in `envVar`.
    const reg = validated();
    expect(resolveAgentModel(reg, 'agentcore_hub_backend_dev', 'sonnet'))
      .toEqual({ modelId: 'us.anthropic.claude-sonnet-5', source: 'override' });
    expect(resolveAgentModel(reg, 'agentcore_hub_backend_dev'))
      .toEqual({ modelId: 'us.anthropic.claude-opus-5', source: 'agents' });
    expect(resolveAgentModel(reg, 'agentcore_hub_qa_verifier'))
      .toEqual({ modelId: 'us.anthropic.claude-fable-5-1', source: 'defaults' });
    expect(resolveAgentModel(null, 'whoever', '', { MODEL_ID: 'us.anthropic.claude-haiku-4-5' }))
      .toEqual({ modelId: 'us.anthropic.claude-haiku-4-5', source: 'env', envVar: 'MODEL_ID' });
    expect(resolveAgentModel(null, 'whoever'))
      .toEqual({ modelId: LITERAL_PERSONA_DEFAULT, source: 'literal' });
  });

  it('reports a source inside the closed enum for every chain step', () => {
    // A stray 'pin' / 'defaults.persona' / 'env:MODEL_ID' would describe the same
    // decision in a vocabulary the fixture and the Python twin do not have.
    const reg = validated();
    for (const got of [
      resolveAgentModel(reg, 'agentcore_hub_backend_dev', 'sonnet'),
      resolveAgentModel(reg, 'agentcore_hub_backend_dev'),
      resolveAgentModel(reg, 'agentcore_hub_qa_verifier'),
      resolveAgentModel(null, 'whoever', '', { MODEL_ID: 'us.anthropic.claude-haiku-4-5' }),
      resolveAgentModel(null, 'whoever'),
      resolveCodingModel(reg, 'opus', 'claude'),
      resolveCodingModel(reg, '', 'claude'),
      resolveCodingModel(null, '', 'codex', { CODEX_MODEL: 'openai.gpt-5.5' }),
      resolveCodingModel(null, '', 'codex'),
    ]) {
      expect(CHAIN_STEPS, JSON.stringify(got)).toContain(got.source);
    }
    expect(CHAIN_STEPS).toEqual(['override', 'agents', 'defaults', 'env', 'literal']);
  });

  it('falls through an unresolvable override instead of honouring it', () => {
    const reg = validated();
    expect(resolveAgentModel(reg, 'agentcore_hub_backend_dev', 'nonsense').modelId)
      .toBe('us.anthropic.claude-opus-5');
  });

  it('lets quarantine beat even the env var', () => {
    const doc = registryDoc();
    doc.defaults = {};
    doc.agents = {};
    doc.tiers = {};
    doc.legacyAliases = {};
    doc.quarantine = ['us.anthropic.claude-opus-5'];
    // Nothing routes at the quarantined model, so the document is still valid —
    // the kill switch alone is what refuses the operator's env var.
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
    doc.catalog.push({ nope: 1 });
    const { registry, warnings, errors } = validateRegistry(doc);
    expect(errors).toEqual({});
    expect(registry).not.toBeNull();
    expect(warnings.join()).toContain('dropped');
  });

  it('invalidates the WHOLE document when a dropped row is referenced', () => {
    const doc = registryDoc();
    doc.catalog = doc.catalog.filter((m) => m.modelId !== 'us.anthropic.claude-opus-5');
    doc.catalog.push({ modelId: 'us.anthropic.claude-opus-5', status: 'banana' });
    const { registry, warnings, errors } = validateRegistry(doc);
    expect(registry).toBeNull();
    expect(warnings.join()).toContain('dropped');
    // The row was dropped, so the tier points at nothing that EXISTS.
    expect(errors['tiers.claude.opus']).toBe('unknown_model');
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
    ok.catalog.push({ modelId: 'us.openai.gpt-6-luna', region: 'us-east-1; rm -rf /' });
    expect(validated(ok).models.some((m) => m.modelId === 'us.openai.gpt-6-luna')).toBe(false);
    const bad = registryDoc();
    bad.catalog[0].region = 'us-east-1; rm -rf /';
    expect(validateRegistry(bad).errors['defaults.persona']).toBe('unknown_model');
  });

  it('reports the canonical reason for every routing-target problem', () => {
    // One case per reason in targetReason(), same order, same vocabulary: the
    // reason is the contract, because `unpriced` and `inactive` send an operator
    // to two different fixes.
    const cases = {
      bad_model_id: (d) => { d.defaults.persona = 'us.anthropic.claude-opus-5; rm -rf /'; },
      unknown_model: (d) => { d.defaults.persona = 'us.anthropic.claude-nope'; },
      inactive: (d) => { d.defaults.persona = 'us.anthropic.claude-opus-4-1'; },
      unpriced: (d) => { delete d.catalog[0].pricing; },
      read_only: (d) => { d.catalog[0].readOnly = true; },
      quarantined: (d) => { d.quarantine = ['us.anthropic.claude-fable-5-1']; },
      unprobed: (d) => { d.catalog[0].status = 'candidate'; },
    };
    for (const [reason, mutate] of Object.entries(cases)) {
      const doc = registryDoc();
      mutate(doc);
      const { registry, errors } = validateRegistry(doc);
      expect(errors['defaults.persona'], reason).toBe(reason);
      // `unprobed` is reported but NOT fatal at read time (NON_FATAL_READ_REASONS):
      // a routed candidate that failed a re-probe must not drop every reader to
      // env/literal (TEAM-5016 finding 1). Every other reason refuses the document.
      if (NON_FATAL_READ_REASONS.includes(reason)) expect(registry, reason).not.toBeNull();
      else expect(registry, reason).toBeNull();
    }
  });

  it('read-time tolerance is exactly the two point-in-time reasons, same as the TS canonical', () => {
    expect(NON_FATAL_READ_REASONS).toEqual(['unknown_agent', 'unprobed']);
    expect(fatalReadErrors({
      'agents.gone_agent': 'unknown_agent',
      'defaults.persona': 'unprobed',
      'tiers.codex.luna': 'unpriced',
    })).toEqual({ 'tiers.codex.luna': 'unpriced' });
    expect(fatalReadErrors({})).toEqual({});
    expect(fatalReadErrors(undefined)).toEqual({});
  });

  it('serves a document whose only fault is a routed candidate that failed a re-probe', () => {
    const doc = registryDoc();
    doc.catalog[0].status = 'candidate';
    doc.catalog[0].probe = { api: { ok: true }, cli: { ok: false, error: 'turn failed' } };
    const { registry, errors } = validateRegistry(doc);
    // Every field that routes at the row reports it (defaults AND tiers.claude.fable).
    expect(errors['defaults.persona']).toBe('unprobed');
    expect(new Set(Object.values(errors))).toEqual(new Set(['unprobed']));
    expect(registry).not.toBeNull();
    expect(resolveAgentModel(registry, 'agentcore_hub_frontend_dev', '', {}, { log: quiet() }).modelId)
      .toBe('us.anthropic.claude-fable-5-1');
  });

  it('calls a half-probed candidate unprobed on EITHER plane', () => {
    // BOTH planes: a model that answers the API but not the coding CLI is
    // half-proven, and `||` here would let a single green probe adopt it.
    for (const probe of [
      { api: { ok: true }, cli: { ok: false } },
      { api: { ok: false }, cli: { ok: true } },
      { api: { ok: true } },
      {},
    ]) {
      const doc = registryDoc();
      doc.catalog[0].status = 'candidate';
      doc.catalog[0].probe = probe;
      const { registry, errors } = validateRegistry(doc);
      expect(errors['defaults.persona'], JSON.stringify(probe)).toBe('unprobed');
      expect(registry, 'reported, still readable').not.toBeNull();
    }
    const ok = registryDoc();
    ok.catalog[0].status = 'candidate';
    ok.catalog[0].probe = { api: { ok: true }, cli: { ok: true } };
    expect(validated(ok)).not.toBeNull();
  });

  it('refuses a quarantined routing target in every field family', () => {
    // The hub's read path refuses the document for ANY of these, so this twin
    // does too — a tier still pointing at a killed model is an operator error to
    // fix, not something to resolve through.
    const fields = {
      'defaults.persona': (d) => { d.defaults.persona = 'us.anthropic.claude-opus-5'; },
      'tiers.claude.opus': () => {},
      'agents.agentcore_hub_backend_dev': () => {},
      'legacyAliases.claude-sonnet-45': (d) => { d.legacyAliases['claude-sonnet-45'] = 'us.anthropic.claude-opus-5'; },
    };
    for (const [field, mutate] of Object.entries(fields)) {
      const doc = registryDoc();
      doc.quarantine = ['us.anthropic.claude-opus-5'];
      mutate(doc);
      const { registry, errors } = validateRegistry(doc);
      expect(registry, field).toBeNull();
      expect(errors[field], field).toBe('quarantined');
    }
  });

  it('judges a routing target through an ALIAS hop', () => {
    // The target is spelled as an alias of the offending row: resolving the alias
    // before judging it is what makes the twin agree with the canonical, which
    // indexes byId and byAlias alike.
    const ok = registryDoc();
    ok.defaults.persona = 'fable-5';
    expect(validated(ok)).not.toBeNull();
    const bad = registryDoc();
    bad.defaults.persona = 'fable-5';
    delete bad.catalog[0].pricing;
    expect(validateRegistry(bad).errors['defaults.persona']).toBe('unpriced');
  });

  it('errors on a malformed legacyAliases KEY', () => {
    const doc = registryDoc();
    doc.legacyAliases['nope; rm -rf /'] = 'us.anthropic.claude-opus-5';
    expect(validateRegistry(doc).errors['legacyAliases.nope; rm -rf /']).toBe('bad_model_id');
  });

  it('errors on an alias two rows claim', () => {
    // Resolution ORDER would otherwise decide which model — and therefore which
    // price — 'fable-5' means. The canonical errors on it, keyed by the row that
    // tried to claim it second, so this does too.
    const doc = registryDoc();
    doc.catalog[1].aliases = ['fable-5'];              // already owned by the fable row
    const { registry, warnings, errors } = validateRegistry(doc);
    expect(registry).toBeNull();
    expect(errors['catalog.us.anthropic.claude-opus-5.aliases.fable-5']).toBe('duplicate_alias');
    expect(warnings.join()).toContain('ambiguous');
  });

  it('drops an alias colliding with a legacyAliases key, without refusing the document', () => {
    // The one tolerated collision, and the reason is stated rather than hidden:
    // the canonical ignores legacyAliases when checking catalog aliases, and
    // dropping the alias leaves the row reachable by id — so refusing the whole
    // document over a compatibility shim would make this twin STRICTER than the
    // hub, which is the same divergence in the other direction.
    const doc = registryDoc();
    doc.catalog[1].aliases = ['claude-sonnet-45'];     // a legacyAliases key
    const { registry, warnings, errors } = validateRegistry(doc);
    expect(errors).toEqual({});
    expect(warnings.join()).toContain('ambiguous');
    expect(resolveModel(registry, 'claude-sonnet-45')).toBe('us.anthropic.claude-sonnet-5');
    expect(resolveModel(registry, 'us.anthropic.claude-opus-5')).toBe('us.anthropic.claude-opus-5');
  });

  it('errors on a malformed alias', () => {
    const doc = registryDoc();
    doc.catalog[1].aliases = ['opus; rm -rf /'];
    const { registry, errors } = validateRegistry(doc);
    expect(registry).toBeNull();
    expect(errors['catalog.us.anthropic.claude-opus-5.aliases.opus; rm -rf /']).toBe('bad_model_id');
  });

  it('folds a dated duplicate into its base id', () => {
    const doc = registryDoc();
    doc.catalog.push({ modelId: 'us.anthropic.claude-opus-5-20251001-v1:0' });
    const { registry, warnings } = parseRegistry(doc);
    expect(warnings.join()).toContain('dated duplicate');
    expect(resolveModel(registry, 'us.anthropic.claude-opus-5-20251001-v1:0')).toBe('us.anthropic.claude-opus-5');
  });

  it('keeps a dated duplicate that something ROUTES at', () => {
    // Routing outranks tidiness: folding a tier's target would make the tier
    // resolve to a DIFFERENT model than the operator wrote. Mirror of
    // routingTargets() in src/lib/models-registry.ts.
    const dated = 'us.anthropic.claude-opus-5-20251001-v1:0';
    const doc = registryDoc();
    doc.catalog.push({ modelId: dated, price: { input: 3, output: 15 } });
    doc.tiers.claude.opus = dated;
    const { registry, warnings, errors } = validateRegistry(doc);
    expect(errors).toEqual({});
    expect(warnings.join()).not.toContain('dated duplicate');
    expect(registry.models.map((r) => r.modelId)).toContain(dated);
    expect(resolveModel(registry, 'opus', { cli: 'claude' })).toBe(dated);
    expect(resolveModel(registry, dated)).toBe(dated);
  });

  it('checks agents keys against a supplied roster, exempting the bridge', () => {
    const doc = registryDoc();
    doc.agents = { not_a_real_agent: 'us.anthropic.claude-opus-5' };
    expect(validateRegistry(doc, { agentIds: ['agentcore_hub_backend_dev'] }).errors['agents.not_a_real_agent'])
      .toBe('unknown_agent');
    const bridge = registryDoc();
    bridge.agents = { telegram_intake: 'us.anthropic.claude-opus-5' };
    expect(validateRegistry(bridge, { agentIds: ['agentcore_hub_backend_dev'] }).errors).toEqual({});
    // No roster supplied -> the check is skipped entirely (the runtime case).
    const runtime = registryDoc();
    runtime.agents = { whatever_agent: 'us.anthropic.claude-opus-5' };
    expect(validateRegistry(runtime).errors).toEqual({});
  });

  it('rejects a document that is not a registry at all', () => {
    expect(validateRegistry([1, 2, 3]).registry).toBeNull();
    expect(validateRegistry([1, 2, 3]).errors).toEqual({ document: 'not_an_object' });
    expect(validateRegistry({ catalog: 'nope' }).registry).toBeNull();
    expect(validateRegistry({ catalog: 'nope' }).errors).toEqual({ catalog: 'missing_or_not_an_array' });
    // A document whose rows sit under `models` is NOT a registry (TEAM-5022):
    // there is one key, and reading a second one let the reconcile write a
    // shadow catalog these twins then preferred over the real one.
    expect(validateRegistry({ models: [{ modelId: 'us.anthropic.claude-opus-5' }] }).errors)
      .toEqual({ catalog: 'missing_or_not_an_array' });
    expect(validateRegistry(null).registry).toBeNull();
  });
});

// ─── 4b. parseRegistry: normalize without the verdict ───────────────────────

describe('parseRegistry', () => {
  it('normalizes a document the validator refuses', () => {
    // The two halves answer different questions. parseRegistry says what the
    // document SAYS (rows, aliases, folds); validateRegistry says whether the hub
    // may serve it. A registry that kills a model some tier still points at is
    // refused by the second and still readable by the first — which is how the
    // shared fixture can ask what the RESOLVER does with it.
    const doc = registryDoc();
    doc.quarantine = ['us.anthropic.claude-opus-5'];
    const verdict = validateRegistry(doc);
    expect(verdict.registry).toBeNull();
    expect(verdict.errors['tiers.claude.opus']).toBe('quarantined');
    const { registry, warnings } = parseRegistry(doc);
    expect(registry).not.toBeNull();
    // The kill switch still holds on the resolver, which is the point.
    expect(resolveModel(registry, 'opus', { cli: 'claude', log: quiet() })).toBeNull();
    expect(warnings).toEqual(verdict.warnings);
  });

  it('gives the same answer twice for the same document', () => {
    // The alias and dated-fold passes rewrite `aliases`, so the parser works on a
    // COPY of each row; without that, validating a document and then parsing it
    // gave two different catalogs.
    const doc = registryDoc();
    doc.catalog.push({ modelId: 'us.anthropic.claude-opus-5-20251001-v1:0' });
    const first = parseRegistry(doc).registry;
    const second = parseRegistry(doc).registry;
    expect(first.models.map((r) => r.modelId)).toEqual(second.models.map((r) => r.modelId));
    expect(first._aliasOwner).toEqual(second._aliasOwner);
    expect(doc.catalog[0].aliases).toEqual(['fable-5']);   // the caller's document is untouched
  });

  it('still refuses a structurally broken document', () => {
    expect(parseRegistry([1, 2, 3]).registry).toBeNull();
    expect(parseRegistry({ catalog: 'nope' }).registry).toBeNull();
    expect(parseRegistry({ models: [{ modelId: 'us.anthropic.claude-opus-5' }] }).registry).toBeNull();
    expect(parseRegistry(null).registry).toBeNull();
  });

  it('keeps a catalog-integrity problem readable', () => {
    // A duplicate alias is fatal to the VERDICT and not to the normalize: the
    // alias is dropped either way, so the rows are still usable.
    const doc = registryDoc();
    doc.catalog[1].aliases = ['fable-5'];
    expect(validateRegistry(doc).registry).toBeNull();
    const { registry, warnings } = parseRegistry(doc);
    expect(registry).not.toBeNull();
    expect(resolveModel(registry, 'fable-5')).toBe('us.anthropic.claude-fable-5-1');
    expect(warnings.join()).toContain('ambiguous');
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
      catalog: [
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

describe('serviceCodeFor', () => {
  it('bills Mantle under AmazonBedrock and everything else, endpoint missing included, under the FM service', () => {
    // Mirror of serviceCodeFor() in src/lib/models/pricing-api.ts — endpoint
    // alone decides, exactly like the TS (TEAM-5029). Before this the reconcile
    // asked for every row under AmazonBedrock and priced none of the 20 Runtime rows.
    expect(serviceCodeFor({ modelId: 'openai.gpt-5.5', vendor: 'openai', endpoint: 'bedrock-mantle' })).toBe('AmazonBedrock');
    expect(serviceCodeFor({ modelId: 'us.anthropic.claude-opus-5', vendor: 'anthropic', endpoint: 'bedrock-runtime' }))
      .toBe('AmazonBedrockFoundationModels');
    expect(serviceCodeFor({ modelId: 'us.openai.gpt-6-sol', vendor: 'openai', endpoint: 'bedrock-runtime' }))
      .toBe('AmazonBedrockFoundationModels');
    // No endpoint is a Bedrock Runtime row, same default the resolver applies.
    expect(serviceCodeFor({ modelId: 'anthropic.claude-opus-5' })).toBe('AmazonBedrockFoundationModels');
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
  agentcore: { runtimeGbHourUsd: 0.00945, runtimeVcpuHourUsd: 0.0895 },
});

describe('pricingProjection', () => {
  it('emits a row per priced model AND per alias, never a legacyAliases key', () => {
    const doc = registryDoc();
    doc.catalog[1].pricing = { input: 5.5, output: 27.5 };
    // An unpriced row NOTHING routes at: every routing target has to carry a
    // price now, so the projection's price gap is demonstrated on a spare row.
    doc.catalog.push({ modelId: 'us.openai.gpt-6-luna', vendor: 'openai', family: 'gpt-luna' });
    const { pricing } = pricingProjection(validated(doc), livePricing());
    expect(pricing.models['us.anthropic.claude-fable-5-1']).toEqual({ input: 11, output: 55, cacheReadInput: 0.275 });
    expect(pricing.models['fable-5']).toEqual({ input: 11, output: 55, cacheReadInput: 0.275 });
    expect(pricing.models['claude-sonnet-45']).toBeUndefined();
    // A row without a usable price is left OUT, which is what makes the card
    // Lambda report it as a gap instead of pricing it at the default rate.
    expect(pricing.models['us.openai.gpt-6-luna']).toBeUndefined();
    // The hand-written row is gone: the catalog owns per-model rates outright.
    expect(pricing.models['openai.gpt-legacy']).toBeUndefined();
  });

  it('never emits a cacheWrite field (it is a multiplier, not a rate)', () => {
    const doc = registryDoc();
    doc.catalog[0].pricing = { input: 11, output: 55, cacheWrite: 13.75, cacheWriteTtl: { '1h': 22 } };
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
    prev.cacheWriteMultiplier = { '5m': 1.25, '1h': 2 };   // no `default` — the TS requires it
    delete prev.cachedInputDiscount;
    const seed = { kiro: { usdPerCredit: 0.04 }, cacheWriteMultiplier: { '5m': 1.25, default: 1.25 } };
    const { pricing, prevSourceNotes } = pricingProjection(validated(), prev, seed);
    expect(pricing.kiro).toEqual({ usdPerCredit: 0.04 });
    expect(pricing.cacheWriteMultiplier).toEqual({ '5m': 1.25, default: 1.25 });
    expect(prevSourceNotes).toContain('seed:kiro');
    expect(prevSourceNotes).toContain('seed:cacheWriteMultiplier');
    expect(prevSourceNotes).toContain('missing:cachedInputDiscount');
    expect(pricing.cachedInputDiscount).toBeUndefined();
  });

  it('judges each carried block by the rule carriedValid() applies in the TS canonical', () => {
    // MIRROR, field for field (TEAM-5029). A block one writer keeps and the other
    // drops alternates pricing.json nightly, so the boundaries are pinned here
    // inline as well as in the shared fixture. No seed: a rejection is `missing:`.
    const project = (patch) => pricingProjection(validated(), { ...livePricing(), ...patch }, null);
    const rejected = (patch, key) => {
      const { pricing, prevSourceNotes } = project(patch);
      expect(prevSourceNotes, JSON.stringify(patch)).toContain(`missing:${key}`);
      expect(pricing[key], JSON.stringify(patch)).toBeUndefined();
    };
    const kept = (patch, key) => {
      const { pricing, prevSourceNotes } = project(patch);
      expect(prevSourceNotes, JSON.stringify(patch)).toEqual([]);
      expect(pricing[key], JSON.stringify(patch)).toEqual(patch[key]);
    };
    // cachedInputDiscount: a number in (0, 1], read WITHOUT coercion.
    rejected({ cachedInputDiscount: 0 }, 'cachedInputDiscount');
    rejected({ cachedInputDiscount: '0.1' }, 'cachedInputDiscount');
    rejected({ cachedInputDiscount: 1.5 }, 'cachedInputDiscount');
    kept({ cachedInputDiscount: 1 }, 'cachedInputDiscount');
    // cacheWriteMultiplier: every non-`_` key positive, `default` REQUIRED, no upper bound.
    rejected({ cacheWriteMultiplier: { '5m': 1.25, '1h': 2 } }, 'cacheWriteMultiplier');
    rejected({ cacheWriteMultiplier: { '5m': 0, default: 1.25 } }, 'cacheWriteMultiplier');
    kept({ cacheWriteMultiplier: { '5m': 1.25, '1h': 12, default: 1.25 } }, 'cacheWriteMultiplier');
    kept({ cacheWriteMultiplier: { '5m': 0.5, default: 0.5, _basis: 'note' } }, 'cacheWriteMultiplier');
    // agentcore: BOTH compute rates.
    rejected({ agentcore: { runtimeGbHourUsd: 0.01 } }, 'agentcore');
    rejected({ agentcore: { runtimeVcpuHourUsd: 0.09 } }, 'agentcore');
    // default / kiro / agentcore coerce like the TS posNum: numeric strings pass
    // and are carried as written.
    kept({ default: { input: '5.5', output: '27.5' } }, 'default');
    rejected({ default: { input: 0, output: 27.5 } }, 'default');
    kept({ kiro: { usdPerCredit: '0.04' } }, 'kiro');
    rejected({ kiro: { usdPerCredit: 'banana' } }, 'kiro');
  });

  it('keeps a retired row priced (finished runs still have to be costed)', () => {
    const doc = registryDoc();
    doc.catalog[3].pricing = { input: 15, output: 75 };
    const { pricing } = pricingProjection(validated(doc), livePricing());
    expect(pricing.models['us.anthropic.claude-opus-4-1']).toEqual({ input: 15, output: 75 });
  });

  it('carries a COMPLETE long-context block, in the canonical field order', () => {
    // Field ORDER is part of the contract, not cosmetics (TEAM-5022): the
    // reconcile only spends a PUT when its projection differs from the live
    // pricing.json by JSON.stringify, so a block emitted in a different order
    // than the hub's rewrote the file every single night for nothing.
    const doc = registryDoc();
    doc.catalog[0].pricing = {
      input: 11, output: 55,
      longContext: { input: 22, output: 110, cacheReadInput: 0.55, thresholdInputTokens: 272000 },
    };
    const { pricing } = pricingProjection(validated(doc), livePricing());
    const lc = pricing.models['us.anthropic.claude-fable-5-1'].longContext;
    expect(Object.keys(lc)).toEqual(['thresholdInputTokens', 'input', 'output', 'cacheReadInput']);
    expect(lc).toEqual({ thresholdInputTokens: 272000, input: 22, output: 110, cacheReadInput: 0.55 });
  });

  it('drops a PARTIAL long-context block rather than half-pricing a long prompt', () => {
    // All four fields or none, same as parsePrice() in the canonical: the card
    // Lambda reads the block as a unit, so a threshold with no cacheReadInput
    // would price the tail of a long prompt at a rate nobody published.
    for (const longContext of [
      { input: 22, output: 110, thresholdInputTokens: 272000 },     // no cacheReadInput
      { input: 22, output: 110, cacheReadInput: 0.55 },             // no threshold
      { thresholdInputTokens: 272000 },
      { input: 22, output: 110, cacheReadInput: 0.55, thresholdInputTokens: 0 },
    ]) {
      const doc = registryDoc();
      doc.catalog[0].pricing = { input: 11, output: 55, longContext };
      const { pricing } = pricingProjection(validated(doc), livePricing());
      expect(pricing.models['us.anthropic.claude-fable-5-1'], JSON.stringify(longContext))
        .toEqual({ input: 11, output: 55 });
    }
  });

  it('reproduces the committed src/config/pricing.json from the committed seed, byte for byte', () => {
    // The projection is what publishes `config/pricing.json`, and the hub's own
    // test (src/lib/models-registry.test.ts) pins the TS canonical to this same
    // file. Pinning the twin to it is the only assertion that catches a field
    // this module emits differently — a value, a rounding, or an order.
    const seedDoc = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
    const live = JSON.parse(readFileSync(PRICING_PATH, 'utf8'));
    const { registry, errors } = validateRegistry(seedDoc);
    expect(errors).toEqual({});
    const { pricing } = pricingProjection(registry, live, live);
    expect(`${JSON.stringify(pricing, null, 2)}\n`).toBe(readFileSync(PRICING_PATH, 'utf8'));
  });
});
