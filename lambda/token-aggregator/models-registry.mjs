/**
 * One model registry — the JavaScript twin (TEAM-4995, DL-033).
 *
 * The behavioural mirror of `deploy/runtime-agent/models_registry.py`: same
 * precedence, same validation, same literals, same log prefixes. Two languages
 * cannot share code, so they share a FIXTURE
 * (`src/config/__fixtures__/models-registry.case.json`, authored by TEAM-4997)
 * and this comment. Change one side and the fixture fails on the other.
 *
 * ZERO IMPORTS, PURE. Nothing here touches AWS, the filesystem or the clock: the
 * caller reads `config/models.json` and passes the parsed document in. That is
 * what lets the same file be byte-copied to `deploy/telegram-bug-intake/` and be
 * `cmp`-pinned against `src/lib/models/models-registry.mjs` by
 * `scripts/check-models-registry-parity.sh` — the established pattern for
 * cross-target modules (cd-registry.mjs x3, si-ledger.mjs x2, fix-contract.mjs).
 * Edit ONE copy and copy it across, never both by hand.
 *
 * Beyond the resolvers, this module owns the arithmetic the nightly reconcile
 * needs — model-version ordering, the Cost Explorer usage types, and the
 * projection of `config/models.json` onto `config/pricing.json` — because those
 * rules are statements about the catalog, and the catalog has one home.
 *
 * Every resolution failure is LOUD and then falls back to a literal: a registry
 * that cannot be read must never silently change which model runs.
 *
 * @typedef {{modelId:string,label?:string,vendor?:string,family?:string,
 *   endpoint?:string,region?:string,api?:string,contextWindow?:number,
 *   aliases?:string[],status?:string,pricing?:ModelPrice,probe?:object,
 *   notify?:{requestedAt?:string}}} ModelRow
 * @typedef {{input?:number,output?:number,cacheReadInput?:number,
 *   longContext?:object,state?:string,asOf?:string,source?:string,
 *   priceDrift?:object}} ModelPrice
 */

// ─── Contracts (identical to the Python twin) ────────────────────────────────

/** A model id is validated, never sanitized — it reaches a shell eval, a TOML
 *  file and a URL. Anything not this shape is rejected outright. */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;

/** us-east-1 / us-gov-west-1 / ap-southeast-2. Same treat-as-hostile rule. */
export const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

/** `...-20251001`, optionally `-v1` / `-v1:0`: a provider snapshot id published
 *  alongside the rolling one. Both name the same model. */
export const DATED_DUPLICATE_RE = /^(.*)-\d{8}(-v\d+(:\d+)?)?$/;

/** The last line of defence, used when there is no registry AND no env var.
 *  One per ROLE — not a tier map, which is exactly the drift DL-033 deletes. */
export const LITERAL_PERSONA_DEFAULT = 'us.anthropic.claude-fable-5-1';
export const LITERAL_CODING_CLAUDE = 'us.anthropic.claude-fable-5-1';
export const LITERAL_CODING_CODEX = 'openai.gpt-5.5';

/** Agents that legitimately appear in `agents` but not in src/config/agents.json:
 *  the Telegram bug-intake bridge is a Lambda, not a fleet runtime, so it has no
 *  roster row — but it does pick a model, so it needs a pin. */
export const EXEMPT_AGENT_IDS = ['telegram_intake'];

export const RESOLVABLE_STATUSES = ['active', 'candidate'];
const ROW_STATUSES = ['active', 'candidate', 'retired', 'quarantined'];

const DEFAULT_CLAUDE_ENDPOINT = 'bedrock-runtime';
const DEFAULT_CLAUDE_API = 'converse';
const DEFAULT_CODEX_ENDPOINT = 'bedrock-mantle';
const DEFAULT_CODEX_API = 'responses';
const DEFAULT_CONTEXT_WINDOW = 400000;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isPositive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

// ─── Validation ──────────────────────────────────────────────────────────────

function rowOk(row) {
  if (!isPlainObject(row)) return false;
  if (typeof row.modelId !== 'string' || !MODEL_ID_RE.test(row.modelId)) return false;
  if (!ROW_STATUSES.includes(row.status ?? 'active')) return false;
  if (row.region != null && !(typeof row.region === 'string' && REGION_RE.test(row.region))) return false;
  if (row.aliases != null && !Array.isArray(row.aliases)) return false;
  return true;
}

/** The base id a dated snapshot folds into, or null. */
export function datedDuplicateBase(id) {
  const m = DATED_DUPLICATE_RE.exec(String(id ?? ''));
  return m && m[1] ? m[1] : null;
}

/** Is `id` a dated snapshot of an id already in `idSet`? */
export function isDatedDuplicate(id, idSet) {
  const base = datedDuplicateBase(id);
  if (!base || base === id) return false;
  const has = idSet instanceof Set ? (v) => idSet.has(v) : (v) => Array.isArray(idSet) && idSet.includes(v);
  return has(base);
}

/**
 * Tolerant parse of a registry document → `{registry|null, warnings, errors}`.
 *
 * A malformed ROW is dropped with a warning — one bad candidate must not take
 * the fleet down. But a document whose `defaults`, `tiers` or `agents` point AT
 * a dropped row is internally inconsistent: resolving through it would hand
 * back something other than what the operator wrote, so the WHOLE document is
 * an error and the caller falls back to env/literal instead. That asymmetry is
 * the point (finding 13).
 *
 * @param {object} doc
 * @param {{agentIds?:string[]|Set<string>}} [opts] roster from
 *   src/config/agents.json. Omitted → the roster check is skipped entirely,
 *   which is the normal case at runtime (agents.json is not shipped everywhere).
 */
export function validateRegistry(doc, opts = {}) {
  const warnings = [];
  const errors = [];
  if (!isPlainObject(doc)) return { registry: null, warnings, errors: ['not an object'] };

  const rawModels = doc.models ?? doc.catalog;
  if (!Array.isArray(rawModels)) {
    return { registry: null, warnings, errors: ['models[] missing or not an array'] };
  }

  const rows = [];
  const seenIds = new Set();
  const aliasOwner = {};
  rawModels.forEach((row, idx) => {
    if (!rowOk(row)) return void warnings.push(`row ${idx} dropped (malformed)`);
    if (seenIds.has(row.modelId)) {
      return void warnings.push(`row ${idx} dropped (duplicate modelId ${row.modelId})`);
    }
    seenIds.add(row.modelId);
    rows.push({ ...row });
  });

  // Aliases must be unambiguous ACROSS namespaces: an alias that is also a
  // modelId, or that two rows both claim, makes resolution order observable.
  // Such an alias is dropped (not the row) — the row still resolves by id.
  const legacy = isPlainObject(doc.legacyAliases) ? doc.legacyAliases : {};
  for (const row of rows) {
    const kept = [];
    for (const alias of row.aliases || []) {
      if (typeof alias !== 'string' || !MODEL_ID_RE.test(alias)) {
        warnings.push(`alias ${JSON.stringify(alias)} dropped (malformed)`);
        continue;
      }
      if (seenIds.has(alias) || alias in aliasOwner || alias in legacy) {
        warnings.push(`alias ${JSON.stringify(alias)} dropped (ambiguous)`);
        continue;
      }
      aliasOwner[alias] = row.modelId;
      kept.push(alias);
    }
    row.aliases = kept;
  }

  // A dated snapshot of a model already in the catalog is the same model: keep
  // the base id canonical and let the dated form resolve to it as an alias.
  for (const row of [...rows]) {
    const base = datedDuplicateBase(row.modelId);
    if (!base || base === row.modelId || !seenIds.has(base)) continue;
    const target = rows.find((r) => r.modelId === base);
    if (!(row.modelId in aliasOwner)) {
      target.aliases = [...(target.aliases || []), row.modelId];
      aliasOwner[row.modelId] = target.modelId;
    }
    warnings.push(`row ${row.modelId} folded into ${base} (dated duplicate)`);
    rows.splice(rows.indexOf(row), 1);
    seenIds.delete(row.modelId);
  }

  const known = new Set([...seenIds, ...Object.keys(aliasOwner)]);

  // Anything the document POINTS AT must exist. `defaults` and `tiers` are how
  // every caller lands somewhere when it was given nothing, so a dangling
  // pointer there is not a warning.
  const defaults = isPlainObject(doc.defaults) ? doc.defaults : {};
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === 'string' && value && !known.has(value)) {
      errors.push(`defaults.${key} -> unknown model ${JSON.stringify(value)}`);
    }
  }

  const tiers = isPlainObject(doc.tiers) ? doc.tiers : {};
  for (const [cli, mapping] of Object.entries(tiers)) {
    if (!isPlainObject(mapping)) {
      errors.push(`tiers.${cli} is not an object`);
      continue;
    }
    for (const [tier, value] of Object.entries(mapping)) {
      if (typeof value !== 'string' || !known.has(value)) {
        errors.push(`tiers.${cli}.${tier} -> unknown model ${JSON.stringify(value)}`);
      }
    }
  }

  const agents = isPlainObject(doc.agents) ? doc.agents : {};
  for (const [agentId, value] of Object.entries(agents)) {
    if (typeof value !== 'string' || !known.has(value)) {
      errors.push(`agents.${agentId} -> unknown model ${JSON.stringify(value)}`);
    }
  }

  for (const [alias, value] of Object.entries(legacy)) {
    if (typeof value !== 'string' || !known.has(value)) {
      warnings.push(`legacyAliases.${alias} -> unknown model ${JSON.stringify(value)} (ignored)`);
    }
  }

  // Every pinned agent must be a real agent — only when a roster was supplied.
  const roster = opts.agentIds instanceof Set ? opts.agentIds
    : Array.isArray(opts.agentIds) ? new Set(opts.agentIds) : null;
  if (roster) {
    for (const agentId of Object.keys(agents)) {
      if (!roster.has(agentId) && !EXEMPT_AGENT_IDS.includes(agentId)) {
        errors.push(`agents.${agentId} is not in agents.json`);
      }
    }
  }

  if (errors.length) return { registry: null, warnings, errors };
  return { registry: { ...doc, models: rows, _aliasOwner: aliasOwner }, warnings, errors };
}

// ─── Resolution ──────────────────────────────────────────────────────────────

const rowsOf = (registry) => (isPlainObject(registry) && Array.isArray(registry.models) ? registry.models : []);

/** The catalog row whose modelId or alias is `name`, else null. */
export function rowFor(registry, name) {
  for (const row of rowsOf(registry)) {
    if (row.modelId === name) return row;
    if ((row.aliases || []).includes(name)) return row;
  }
  return null;
}

const quarantinedIn = (registry, name) => {
  const q = isPlainObject(registry) ? registry.quarantine : null;
  return Array.isArray(q) && q.includes(name);
};

/**
 * Resolve a tier name, alias or raw id to a model id. null when unknown.
 *
 * Order, and the reason each step is where it is:
 *   1. `quarantine` — an operator kill switch has to beat every other source,
 *      including an explicit pin, or it is not a kill switch.
 *   2. `tiers[cli]` — tiers are CLI-scoped: "sol" means a Codex model to codex
 *      and nothing to claude, so an unscoped map would cross the wires.
 *   3. `legacyAliases` — yesterday's names ("claude-sonnet-45") keep working.
 *   4. the catalog, by modelId or alias, when the row is active/candidate.
 *   5. a retired/quarantined row: warn and return null so the CALLER falls
 *      through to its next precedence step. Resolving it anyway would keep a
 *      withdrawn model silently in service, which is the bug DL-033 replaces.
 *   6. passthrough for anything that looks like a model id (contains "."), so
 *      an id published after the last reconcile is still usable.
 *
 * @param {object|null} registry
 * @param {string} value tier name, alias or raw model id
 * @param {{cli?:string,log?:function}} [ctx]
 */
export function resolveModel(registry, value, ctx = {}) {
  const log = ctx.log || console;
  let name = trimmed(value);
  if (!name) return null;

  if (quarantinedIn(registry, name)) {
    log.warn?.(`[models] registry.quarantined ${name}`);
    return null;
  }

  const tiers = isPlainObject(registry) ? registry.tiers : null;
  if (isPlainObject(tiers)) {
    const scoped = tiers[ctx.cli === 'codex' ? 'codex' : 'claude'];
    if (isPlainObject(scoped) && name.toLowerCase() in scoped) name = scoped[name.toLowerCase()];
  }

  const legacy = isPlainObject(registry) ? registry.legacyAliases : null;
  if (isPlainObject(legacy) && name in legacy) name = legacy[name];

  const row = rowFor(registry, name);
  if (row) {
    if (RESOLVABLE_STATUSES.includes(row.status ?? 'active')) return row.modelId;
    log.warn?.(`[models] registry.retired ${row.modelId} (status=${row.status})`);
    return null;
  }

  if (name.includes('.') && MODEL_ID_RE.test(name)) return name;
  return null;
}

/** An env-var model id we could not resolve, honoured as-is — unless it is
 *  quarantined. The env var is an operator override and outranks the catalog,
 *  but `quarantine` is a kill switch and outranks the operator. */
function rawEnv(registry, value) {
  const name = trimmed(value);
  if (!name || !MODEL_ID_RE.test(name) || quarantinedIn(registry, name)) return null;
  return name;
}

const pinFor = (registry, agentId) => {
  const agents = isPlainObject(registry) ? registry.agents : null;
  return isPlainObject(agents) && agentId ? agents[agentId] : null;
};

const defaultFor = (registry, key) => {
  const defaults = isPlainObject(registry) ? registry.defaults : null;
  return isPlainObject(defaults) ? defaults[key] : null;
};

/**
 * The persona/board model for one agent → `{modelId, source}`.
 *
 * override -> agents[agentId] -> defaults.persona -> $MODEL_ID -> literal.
 * Each step goes through `resolveModel`, so a tier name, a legacy alias or a
 * retired id at any level falls through to the next rather than pinning
 * something that no longer exists. `source` is what the caller logs — a model
 * chosen by the literal fallback must be distinguishable from a pinned one.
 */
export function resolveAgentModel(registry, agentId, override = '', env = {}, ctx = {}) {
  const steps = [
    ['override', override],
    ['pin', pinFor(registry, agentId)],
    ['defaults.persona', defaultFor(registry, 'persona')],
  ];
  for (const [source, candidate] of steps) {
    const modelId = resolveModel(registry, candidate, ctx);
    if (modelId) return { modelId, source };
  }
  const fromEnv = trimmed(env.MODEL_ID);
  if (fromEnv) {
    const modelId = resolveModel(registry, fromEnv, ctx) || rawEnv(registry, fromEnv);
    if (modelId) return { modelId, source: 'env:MODEL_ID' };
  }
  return { modelId: LITERAL_PERSONA_DEFAULT, source: 'literal' };
}

/**
 * Resolve a coding-CLI model →
 * `{modelId, endpoint, region, api, contextWindow, baseUrl, source}`.
 *
 * argument -> defaults.codingClaude|codingCodex -> $ANTHROPIC_MODEL/$CLAUDE_MODEL
 * (claude) or $CODEX_MODEL (codex) -> literal.
 *
 * The endpoint fields are what make Codex work on BOTH of its homes: Bedrock
 * Runtime serves the inference-profile ids (`us.openai.gpt-…`) on `/openai/v1`,
 * Mantle serves the bare ids on a different host, and only the catalog row
 * knows which. Past the catalog there is no row to ask, so each role gets its
 * documented default home — Claude/Converse on Bedrock Runtime, Codex/Responses
 * on Mantle (the literal gpt-5.5 is Mantle-only).
 */
export function resolveCodingModel(registry, tierOrId, cli, env = {}, ctx = {}) {
  const codex = cli === 'codex';
  const rctx = { ...ctx, cli };
  const steps = [
    ['argument', tierOrId],
    [`defaults.${codex ? 'codingCodex' : 'codingClaude'}`, defaultFor(registry, codex ? 'codingCodex' : 'codingClaude')],
  ];
  for (const [source, candidate] of steps) {
    const modelId = resolveModel(registry, candidate, rctx);
    if (modelId) return withEndpoint(registry, modelId, codex, env, source, rctx);
  }
  for (const name of codex ? ['CODEX_MODEL'] : ['ANTHROPIC_MODEL', 'CLAUDE_MODEL']) {
    const value = trimmed(env[name]);
    if (!value) continue;
    const modelId = resolveModel(registry, value, rctx) || rawEnv(registry, value);
    if (modelId) return withEndpoint(registry, modelId, codex, env, `env:${name}`, rctx);
  }
  const literal = codex ? LITERAL_CODING_CODEX : LITERAL_CODING_CLAUDE;
  return withEndpoint(registry, literal, codex, env, 'literal', rctx);
}

function withEndpoint(registry, modelId, codex, env, source, ctx) {
  const log = ctx.log || console;
  const row = rowFor(registry, modelId);
  const endpoint = (row && row.endpoint) || (codex ? DEFAULT_CODEX_ENDPOINT : DEFAULT_CLAUDE_ENDPOINT);
  const api = (row && row.api) || (codex ? DEFAULT_CODEX_API : DEFAULT_CLAUDE_API);
  let region = row ? row.region : null;
  if (!(typeof region === 'string' && REGION_RE.test(region))) {
    if (region) log.warn?.(`[models] registry.bad-region ${JSON.stringify(region)} for ${modelId}`);
    region = fallbackRegion(endpoint, env, log);
  }
  const ctxWindow = row && Number.isInteger(row.contextWindow) && row.contextWindow > 0
    ? row.contextWindow : DEFAULT_CONTEXT_WINDOW;
  const id = row ? row.modelId : modelId;
  return { modelId: id, endpoint, region, api, contextWindow: ctxWindow, baseUrl: baseUrlFor(endpoint, region), source };
}

/** Region when the row does not say. Mantle has its own env var — and it is
 *  MANTLE-ONLY: a bedrock-runtime model must never be handed the Mantle region,
 *  which is why this branches on the ENDPOINT, not on the CLI. */
function fallbackRegion(endpoint, env, log = console) {
  const mantle = endpoint === 'bedrock-mantle';
  const safe = mantle ? 'us-east-2' : 'us-east-1';
  const region = mantle
    ? (trimmed(env.BEDROCK_MANTLE_REGION) || safe)
    : (trimmed(env.AWS_REGION) || safe);
  if (!REGION_RE.test(region)) {
    log.warn?.(`[models] registry.bad-region ${JSON.stringify(region)} — using ${safe}`);
    return safe;
  }
  return region;
}

/** The OpenAI-compatible base URL for an endpoint + region. */
export function baseUrlFor(endpoint, region) {
  if (endpoint === 'bedrock-mantle') return `https://bedrock-mantle.${region}.api.aws/openai/v1`;
  return `https://bedrock-runtime.${region}.amazonaws.com/openai/v1`;
}

// ─── Model version ordering (reconcile) ──────────────────────────────────────

const PREFIX_RE = /^(us|eu|apac|global)\./;

/**
 * Split a model id into `{prefix, vendor, family, version, base}` or null.
 *
 *   openai.gpt-5.5            -> vendor openai,    family gpt,          version [5,5]
 *   us.anthropic.claude-opus-5-> vendor anthropic, family claude-opus,  version [5]
 *   us.anthropic.claude-fable-5-1 ->               family claude-fable, version [5,1]
 *
 * `version` is compared component-wise, which is what makes gpt-6 newer than
 * gpt-5.6 ([6] > [5,6] on the first component) and gpt-5.6 newer than gpt-5.5.
 * A string compare would order "gpt-5.5" after "gpt-10" and quietly pick the
 * wrong predecessor to price a new model from.
 */
export function parseModelVersion(id) {
  const raw = trimmed(id);
  if (!raw) return null;
  const pm = PREFIX_RE.exec(raw);
  const prefix = pm ? pm[1] : null;
  const rest = pm ? raw.slice(pm[0].length) : raw;
  const dot = rest.indexOf('.');
  const vendor = dot > 0 ? rest.slice(0, dot) : null;
  const tail = dot > 0 ? rest.slice(dot + 1) : rest;
  const vm = /^(.*?)[-.]?(\d+(?:[.-]\d+)*)$/.exec(tail);
  if (!vm) return { prefix, vendor, family: tail, version: [], base: raw };
  const version = vm[2].split(/[.-]/).map(Number);
  return { prefix, vendor, family: vm[1], version, base: raw };
}

/** -1 / 0 / 1 over `parseModelVersion().version` arrays. */
export function compareVersions(a = [], b = []) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The newest catalog row of the SAME vendor+family with a strictly lower
 * version — the row whose price is the best interim guess for a model the
 * Pricing API has not published yet. Retired rows count: a withdrawn
 * predecessor's rate is still the closest real number, and an interim price is
 * marked as such on the row. Quarantined rows do not (an operator killed them).
 */
export function predecessorRow(registry, row) {
  const me = parseModelVersion(row?.modelId);
  if (!me || !me.version.length) return null;
  let best = null;
  let bestV = null;
  for (const other of rowsOf(registry)) {
    if (other.modelId === row.modelId) continue;
    if ((other.status ?? 'active') === 'quarantined') continue;
    const v = parseModelVersion(other.modelId);
    if (!v || v.vendor !== me.vendor || v.family !== me.family) continue;
    if (compareVersions(v.version, me.version) >= 0) continue;
    if (!bestV || compareVersions(v.version, bestV) > 0) {
      best = other;
      bestV = v.version;
    }
  }
  return best;
}

// ─── Tiers and usage types (reconcile) ───────────────────────────────────────

const CLAUDE_TIER_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
const CODEX_TIER_FAMILIES = ['astra', 'sol', 'terra', 'luna'];

/**
 * The tier a newly discovered model would occupy, as `"<cli>.<tier>"`, or null
 * when its family names no tier. Anthropic's families ARE the tier names
 * (claude-opus-6 is next year's "opus"); OpenAI's are not (`gpt` is one family
 * across all four Codex tiers), so only an explicitly tier-named openai family
 * maps — anything else needs a human on /models. This is the ONLY inference
 * `autoAdopt` is allowed to make.
 */
export function tierForFamily(vendor, family) {
  const word = String(family ?? '').split('-').pop().toLowerCase();
  if (vendor === 'anthropic' && CLAUDE_TIER_FAMILIES.includes(word)) return `claude.${word}`;
  if (vendor === 'openai' && CODEX_TIER_FAMILIES.includes(word)) return `codex.${word}`;
  return null;
}

/**
 * The Cost Explorer / Pricing API usagetype for one row and one token kind
 * (`input` | `output` | `cache_read`).
 *
 * Two shapes, because the two endpoints bill through different products:
 * Mantle meters OpenAI models under their own per-model usagetype, while
 * everything on Bedrock Runtime bills through the marketplace `MP:` units,
 * where a `global.` inference profile is a different unit from a regional one.
 * USE1 is the us-east-1 prefix; other regions are not metered by this Lambda.
 */
export function usagetypeFor(row, kind) {
  const id = String(row?.modelId ?? '');
  const vendor = row?.vendor || parseModelVersion(id)?.vendor;
  if (vendor === 'openai' && row?.endpoint === 'bedrock-mantle') {
    const bare = id.replace(PREFIX_RE, '').replace(/^openai\./, '');
    return `USE1-openai.${bare}-mantle-${kind}-tokens-standard`;
  }
  const tier = id.startsWith('global.') ? 'global_standard' : 'standard';
  return `USE1-MP:USE1_${kind}_tokens_${tier}-Units`;
}

// ─── Pricing projection (reconcile) ──────────────────────────────────────────

/** The per-model rate fields the card Lambda reads. `cacheWrite` is NEVER one of
 *  them: a cache write is priced as a MULTIPLE of the input rate
 *  (`cacheWriteMultiplier`, keyed by the span's ttl), so a per-model cacheWrite
 *  column would be a second, disagreeing source for the same number. */
export const PRICE_FIELDS = ['input', 'output', 'cacheReadInput'];

/** The blocks `config/pricing.json` carries that the catalog knows nothing
 *  about — discounts, multipliers, Kiro credits, AgentCore compute, the default
 *  rate. They are CARRIED FORWARD from the live document, never regenerated. */
export const CARRIED_PRICING_KEYS = ['default', 'cachedInputDiscount', 'cacheWriteMultiplier', 'kiro', 'agentcore'];

function priceOf(row) {
  const p = row?.pricing;
  if (!isPlainObject(p) || !isPositive(p.input) || !isPositive(p.output)) return null;
  const out = { input: p.input, output: p.output };
  if (isPositive(p.cacheReadInput)) out.cacheReadInput = p.cacheReadInput;
  if (isPlainObject(p.longContext)) {
    const lc = {};
    for (const f of PRICE_FIELDS) if (isPositive(p.longContext[f])) lc[f] = p.longContext[f];
    if (isPositive(p.longContext.thresholdInputTokens)) lc.thresholdInputTokens = p.longContext.thresholdInputTokens;
    if (Object.keys(lc).length) out.longContext = lc;
  }
  return out;
}

function carriedBlockOk(key, value) {
  if (key === 'default') return isPlainObject(value) && isPositive(value.input) && isPositive(value.output);
  if (key === 'cachedInputDiscount') return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  if (key === 'cacheWriteMultiplier') {
    if (!isPlainObject(value)) return false;
    const rates = Object.entries(value).filter(([k]) => !k.startsWith('_'));
    return rates.length > 0 && rates.every(([, v]) => typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 10);
  }
  if (key === 'kiro') return isPlainObject(value) && isPositive(value.usdPerCredit);
  if (key === 'agentcore') return isPlainObject(value) && isPositive(value.runtimeGbHourUsd);
  return false;
}

/**
 * Project `config/models.json` onto `config/pricing.json` →
 * `{pricing, prevSourceNotes}`.
 *
 * The catalog owns the PER-MODEL rates and nothing else. Every other block is
 * carried forward from the live pricing document, validated block by block: a
 * corrupted `kiro` must not take the whole file down to a seed, and a silently
 * wrong multiplier must not survive either. A block that fails validation falls
 * back to `seedPricing` (when one was supplied) and is named in
 * `prevSourceNotes` as `seed:<key>` so the reconcile summary can say so.
 *
 * Aliases are emitted as their own price rows — the card Lambda looks a model up
 * by the id the span reported, which may be an alias. `legacyAliases` keys are
 * NOT emitted: they are a resolution courtesy, never a billed id, and pricing a
 * name nothing can invoke invites a typo becoming a rate.
 *
 * @param {object} registry validated registry (post-validateRegistry)
 * @param {object|null} previousPricing the live config/pricing.json
 * @param {object|null} seedPricing src/config/pricing.json, when available
 */
export function pricingProjection(registry, previousPricing, seedPricing = null) {
  const prev = isPlainObject(previousPricing) ? previousPricing : {};
  const seed = isPlainObject(seedPricing) ? seedPricing : {};
  const prevSourceNotes = [];
  const models = {};

  for (const row of rowsOf(registry)) {
    const price = priceOf(row);
    if (!price) continue;
    // Retired rows keep their price: a run that finished an hour before the
    // retirement still has to be costed, and the card reads the LIVE document.
    models[row.modelId] = price;
    for (const alias of row.aliases || []) {
      if (!(alias in models)) models[alias] = { ...price };
    }
  }

  const pricing = { _comment: projectionComment(registry), models };
  for (const key of CARRIED_PRICING_KEYS) {
    if (carriedBlockOk(key, prev[key])) {
      pricing[key] = prev[key];
    } else if (carriedBlockOk(key, seed[key])) {
      pricing[key] = seed[key];
      prevSourceNotes.push(`seed:${key}`);
    } else {
      prevSourceNotes.push(`missing:${key}`);
    }
  }
  return { pricing, prevSourceNotes };
}

function projectionComment(registry) {
  const version = isPlainObject(registry) ? registry.version ?? 0 : 0;
  const at = (isPlainObject(registry) && registry.updatedAt) || 'unknown';
  const by = (isPlainObject(registry) && registry.updatedBy) || 'unknown';
  return `Generated from config/models.json version ${version} at ${at} by ${by}. `
    + 'Do not edit; edit the catalog on /models.';
}
