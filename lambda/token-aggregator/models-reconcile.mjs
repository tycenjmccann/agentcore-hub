/**
 * Nightly model reconcile (TEAM-4995, DL-033) — `{"mode":"reconcile"}`.
 *
 * `config/models.json` is the one place a model is named, which makes keeping it
 * TRUE a job. Once a day this walks what the account can actually reach, prices
 * what it finds, and writes the differences back:
 *
 *   1. read the registry (and its ETag — every write here is conditional)
 *   2. discover: Bedrock inference profiles + Mantle's model list
 *   3. reprice: the Pricing API, per row, per token kind
 *   4. autoAdopt: move a tier to a newer model, but only behind two green probes
 *   5. write: models.json (+ models.prev.json on a tier move) and pricing.json
 *
 * Three rules hold the whole design together:
 *
 *   - **Nothing is ever deleted.** A model that vanishes from discovery is marked
 *     `retired`, not removed: cards, traces and eval rows reference it forever,
 *     and a row that disappears turns a priced historical run into an unpriced
 *     one. Retirement is reversible (a returning model becomes a candidate
 *     again); deletion is not.
 *   - **`autoAdopt` is the ONLY writer of `tiers`**, and never of `defaults` or
 *     `agents`. A nightly job may promote "opus" to a newer opus once the model
 *     has proved it answers the API *and* drives the CLI. It may not decide which
 *     model an agent runs — that is a human edit on /models.
 *   - **Every write is optimistic.** The document is re-read immediately before
 *     the PUT and the PUT carries `IfMatch`; a version that moved under us means
 *     a human was editing, and the human wins. We retry the whole pass once
 *     against their document and report `conflict` either way, so the summary
 *     never claims a clean run when it raced one.
 *
 * Every AWS call is injected through `deps` so the tests are hermetic:
 *   s3Get(key) -> {body, etag} | null      s3Put(key, body, {ifMatch})
 *   listInferenceProfiles(region) -> [..]  mantleModels(region) -> [..]
 *   getProducts(serviceCode, filters) -> [product]   probeCli(row) -> {ok,..}
 *     (serviceCode is per row, via serviceCodeFor(): Mantle bills under
 *     AmazonBedrock, inference profiles under AmazonBedrockFoundationModels)
 *   now() -> Date    uuid() -> string    log    env
 */

import {
  MODEL_ID_RE,
  REGION_RE,
  assignBareAliases,
  RESOLVABLE_STATUSES,
  isDatedDuplicate,
  parseModelVersion,
  compareVersions,
  predecessorRow,
  tierForFamily,
  usagetypeFor,
  serviceCodeFor,
  priceBlockOf,
  pricingProjection,
  routingTargetsOf,
  validateRegistry,
} from './models-registry.mjs';

export const MODELS_KEY = 'config/models.json';
export const PREV_KEY = 'config/models.prev.json';
export const PRICING_KEY = 'config/pricing.json';

/** Bedrock inference profiles worth tracking: the US and global Anthropic/OpenAI
 *  profiles. Everything else in the account's profile list belongs to another
 *  vendor or another partition. */
export const PROFILE_ID_RE = /^(us|global)\.(anthropic|openai)\./;
/** Mantle serves the bare OpenAI ids. */
export const MANTLE_ID_RE = /^openai\./;
/** GovCloud is a different partition with different access and different rates;
 *  a `us-gov` id or region must never enter the commercial catalog. */
const GOV_RE = /(^|[.\-])us-gov([.\-]|$)/;

/** What a newly discovered row claims when the profile does not say. Distinct
 *  from the resolver's 400k fallback on purpose: 200k is the conservative floor
 *  every current model meets, and a human corrects it on /models. */
export const DISCOVERY_CONTEXT_WINDOW = 200000;

const PRICE_KINDS = [
  ['input', 'input'],
  ['output', 'output'],
  ['cache_read', 'cacheReadInput'],
];

/** The Pricing API reports a rate per unit; this file speaks USD per 1M tokens
 *  (`src/config/pricing.json`). An unrecognised unit is NOT guessed — it leaves
 *  the row unpriced, which REPORT_VERSION 7 surfaces as a gap on the card. */
const UNIT_TO_MILLION = new Map([
  ['tokens', 1e6],
  ['token', 1e6],
  ['1k tokens', 1e3],
  ['1000 tokens', 1e3],
  ['1m tokens', 1],
  ['1000000 tokens', 1],
]);

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isPositive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');
const clone = (v) => JSON.parse(JSON.stringify(v));
const errText = (e) => String((e && (e.message || e.name)) || e || 'error').slice(0, 300);
const statusOf = (row) => row?.status ?? 'active';
/** `validateRegistry().errors` as one log line — the same `path=reason; …` shape
 *  the Telegram bridge already logs, so a refusal reads the same in both places. */
const fmtErrors = (errors) => Object.entries(errors || {}).map(([p, r]) => `${p}=${r}`).join('; ');

// ─── Step 1: read ────────────────────────────────────────────────────────────

async function readJson(deps, key) {
  let got;
  try {
    got = await deps.s3Get(key);
  } catch (e) {
    deps.log.warn?.(`[models] reconcile.read-failed key=${key} error=${errText(e)}`);
    return null;
  }
  if (!got) return null;
  try {
    return { doc: JSON.parse(got.body), etag: got.etag };
  } catch (e) {
    deps.log.warn?.(`[models] reconcile.parse-failed key=${key} error=${errText(e)}`);
    return null;
  }
}

// ─── Step 2: discovery ───────────────────────────────────────────────────────

/** The regions to ask Mantle about: the configured one plus us-east-1, deduped.
 *  A region that is not a region is dropped with a warning rather than
 *  interpolated into a hostname. */
export function mantleRegions(env, log = console) {
  const raw = trimmed(env.BEDROCK_MANTLE_REGIONS)
    || `${trimmed(env.BEDROCK_MANTLE_REGION) || 'us-east-2'},us-east-1`;
  const out = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!REGION_RE.test(part) || GOV_RE.test(part)) {
      log.warn?.(`[models] reconcile.bad-region ${JSON.stringify(part)} skipped`);
      continue;
    }
    if (!out.includes(part)) out.push(part);
  }
  return out;
}

function candidateRow(found, now, alias = null) {
  const v = parseModelVersion(found.modelId);
  return {
    modelId: found.modelId,
    label: found.label || found.modelId,
    vendor: found.vendor || v?.vendor || null,
    family: found.family || v?.family || null,
    endpoint: found.endpoint,
    region: found.region,
    api: found.api,
    contextWindow: found.contextWindow || DISCOVERY_CONTEXT_WINDOW,
    aliases: alias ? [alias] : [],
    status: 'candidate',
    notify: { requestedAt: now },
  };
}

/**
 * Everything the account can reach right now, keyed by model id.
 *
 * Also returns which PLANES were successfully scanned: `bedrock-runtime`, and
 * `bedrock-mantle:<region>` for each Mantle region that answered. Retirement
 * below is scoped to those: if the Mantle call throws, every Mantle row would
 * otherwise "vanish" and the reconcile would retire the whole Codex catalog on a
 * transient 500. A failed scan means we learned nothing, not that the models are
 * gone — and that holds PER REGION (TEAM-5029): a Mantle row is only retirable
 * when the region it lives in was listed. A sweep that never reached us-east-2
 * has learned nothing about a us-east-2 row, however completely us-east-1
 * answered.
 */
async function discover(deps, env) {
  const found = new Map();
  const scanned = new Set();
  const region = trimmed(env.AWS_REGION) || 'us-east-1';

  try {
    for (const profile of (await deps.listInferenceProfiles(region)) || []) {
      const id = trimmed(profile?.inferenceProfileId || profile?.inferenceProfileArn?.split('/').pop());
      if ((profile?.status || 'ACTIVE') !== 'ACTIVE') continue;
      if (!id || !MODEL_ID_RE.test(id) || !PROFILE_ID_RE.test(id) || GOV_RE.test(id)) continue;
      const v = parseModelVersion(id);
      found.set(id, {
        modelId: id,
        label: trimmed(profile?.inferenceProfileName) || id,
        vendor: v?.vendor || null,
        family: v?.family || null,
        endpoint: 'bedrock-runtime',
        region,
        api: v?.vendor === 'openai' ? 'responses' : 'converse',
        contextWindow: Number.isInteger(profile?.contextWindow) ? profile.contextWindow : 0,
      });
    }
    scanned.add('bedrock-runtime');
  } catch (e) {
    deps.log.warn?.(`[models] reconcile.discover-failed endpoint=bedrock-runtime region=${region} error=${errText(e)}`);
  }

  for (const mregion of mantleRegions(env, deps.log)) {
    try {
      for (const model of (await deps.mantleModels(mregion)) || []) {
        const id = trimmed(model?.id || model?.model);
        if (!id || !MODEL_ID_RE.test(id) || !MANTLE_ID_RE.test(id) || GOV_RE.test(id)) continue;
        if (found.has(id)) continue; // first region wins; the row records one home
        const v = parseModelVersion(id);
        found.set(id, {
          modelId: id,
          label: trimmed(model?.display_name) || id,
          vendor: v?.vendor || 'openai',
          family: v?.family || null,
          endpoint: 'bedrock-mantle',
          region: mregion,
          api: 'responses',
          contextWindow: Number.isInteger(model?.context_window) ? model.context_window : 0,
        });
      }
      scanned.add(`bedrock-mantle:${mregion}`);
    } catch (e) {
      deps.log.warn?.(`[models] reconcile.discover-failed endpoint=bedrock-mantle region=${mregion} error=${errText(e)}`);
    }
  }

  return { found, scanned };
}

/** Fold discovery into the document: add, un-retire, retire. Returns nothing —
 *  `doc.catalog` and `counts` are mutated in place, which keeps the five steps
 *  reading as one transaction over one object.
 *
 *  `doc` here is the RAW S3 document, so the rows are under `catalog` — the one
 *  document key (TEAM-5022). Writing them under `models` instead put a second,
 *  unpriced catalog beside the real one and split the fleet from the hub. */
function mergeDiscovery(doc, discovered, counts, nowIso, log) {
  const rows = Array.isArray(doc.catalog) ? doc.catalog : (doc.catalog = []);
  const byId = new Map(rows.map((r) => [r?.modelId, r]));
  const known = new Set([...byId.keys(), ...discovered.found.keys()]);
  // Routing is read BEFORE anything below can move it, and nothing in this
  // function writes defaults/tiers/agents/legacyAliases anyway.
  const targets = routingTargetsOf(doc);
  const paths = routingPaths(doc);

  // Every name the document already resolves — the bare CLI alias a new row
  // derives must not steal one (TEAM-5065). Taken BEFORE any row is added.
  const taken = new Set(isPlainObject(doc.legacyAliases) ? Object.keys(doc.legacyAliases) : []);
  for (const r of rows) {
    if (typeof r?.modelId === 'string') taken.add(r.modelId);
    for (const a of Array.isArray(r?.aliases) ? r.aliases : []) taken.add(a);
  }
  const fresh = [];

  for (const [id, found] of discovered.found) {
    // A dated snapshot (`...-20260901`) of an id we already know is the same
    // model under a second name — the catalog keeps the rolling id canonical.
    if (isDatedDuplicate(id, known)) continue;
    const row = byId.get(id);
    if (!row) {
      fresh.push(found);
      continue;
    }
    if (statusOf(row) === 'retired') {
      // It came back. Back to candidate, and ping a human — a model returning
      // from retirement is exactly as much of a decision as a new one.
      row.status = 'candidate';
      delete row.retiredAt;
      row.notify = { ...(isPlainObject(row.notify) ? row.notify : {}), requestedAt: nowIso };
      counts.pinged += 1;
      log.log(`[models] reconcile.returned modelId=${id}`);
    }
    // Otherwise the row is left ALONE. Region, label, context window and aliases
    // are operator data; discovery confirms existence, it does not overwrite
    // curation.
  }

  // New rows go in as one batch, so two candidates deriving the same bare alias
  // are seen together and neither gets it.
  const aliases = assignBareAliases(fresh.map((f) => f.modelId), taken);
  for (const found of fresh) {
    const alias = aliases.get(found.modelId) || null;
    const row = candidateRow(found, nowIso, alias);
    rows.push(row);
    byId.set(found.modelId, row);
    counts.added += 1;
    counts.pinged += 1;
    log.log(`[models] reconcile.added modelId=${found.modelId} endpoint=${found.endpoint} `
      + `region=${found.region} alias=${alias || 'none'}`);
  }

  for (const row of rows) {
    if (!RESOLVABLE_STATUSES.includes(statusOf(row))) continue;
    if (discovered.found.has(row.modelId)) continue;
    // A failed scan proves nothing. A row with no endpoint is a Bedrock Runtime
    // row, same default the resolver applies. A Mantle row is gated on ITS OWN
    // region having answered; one with no region yields a key nothing scanned,
    // so it is never retirable on absence — same philosophy as retirable().
    const endpoint = row.endpoint || 'bedrock-runtime';
    const scanKey = endpoint === 'bedrock-mantle' ? `bedrock-mantle:${trimmed(row.region)}` : endpoint;
    if (!discovered.scanned.has(scanKey)) continue;
    if (!retirable(row, targets)) {
      // The one refusal the operator must hear about: gone from a plane that DID
      // answer, and still routed at. A row no listing could have returned
      // (readOnly / bare foundation id) is not evidence of anything, so it stays quiet.
      const routed = row.readOnly || !listableId(row) ? [] : routedNames(row, targets);
      if (routed.length) {
        counts.routingProtected += 1;
        log.warn?.(`[models] reconcile.retire-skipped modelId=${row.modelId} `
          + `reason=routing_target paths=${routed.flatMap((n) => paths.get(n) || []).join(',')}`);
      }
      continue;
    }
    row.status = 'retired';
    row.retiredAt = nowIso;
    counts.retired += 1;
    log.log(`[models] reconcile.retired modelId=${row.modelId} reason=not_discovered`);
  }
}

/** Could a listing ever have returned this id at all? */
const listableId = (row) => PROFILE_ID_RE.test(row.modelId) || MANTLE_ID_RE.test(row.modelId);

/** The row's own names — id, then aliases — that the document routes at. An
 *  alias counts: the read verdict resolves a target by id OR alias, so a tier
 *  pointing at an alias of a retired row is exactly as `inactive`. */
const routedNames = (row, targets) => [row.modelId, ...(Array.isArray(row.aliases) ? row.aliases : [])]
  .filter((n) => targets.has(n));

/** Every routing path, keyed by the id it points at — `defaults.codingCodex`,
 *  `tiers.codex.sol` — for the retire-skipped line. Same keys, same order as
 *  routingTargetsOf(), so the line names every reason a row was kept. */
function routingPaths(doc) {
  const out = new Map();
  const add = (target, path) => {
    if (typeof target !== 'string' || !target) return;
    if (!out.has(target)) out.set(target, []);
    out.get(target).push(path);
  };
  for (const key of ['defaults', 'agents', 'legacyAliases']) {
    if (!isPlainObject(doc[key])) continue;
    for (const [name, value] of Object.entries(doc[key])) add(value, `${key}.${name}`);
  }
  if (isPlainObject(doc.tiers)) {
    for (const [cli, mapping] of Object.entries(doc.tiers)) {
      if (!isPlainObject(mapping)) continue;
      for (const [tier, value] of Object.entries(mapping)) add(value, `tiers.${cli}.${tier}`);
    }
  }
  return out;
}

/**
 * May this row's absence from a scanned plane mean "gone"? Mirror of
 * `discovery.ts`'s `retirable()`.
 *
 * Never for a row the document routes at, by id or by alias (TEAM-5017).
 * `retired` reads as `inactive`, a FATAL read reason for the hub and every twin,
 * so retiring one routed row reverts the whole fleet's routing to env/literal on
 * the next cold start. The row is kept and its absence reported as
 * `reconcile.retire-skipped` instead: the model is gone from the account while
 * still being routed at, and repointing that routing is a human's call.
 *
 * Never, either, for an id no sweep could have listed. The eval judge's bare
 * foundation-model row (`readOnly: true`, no `us.`/`global.`/`openai.` prefix)
 * is never an inference profile, so `listInferenceProfiles`/`mantleModels`
 * could never have reported it either way — retiring it on absence, which the
 * un-guarded loop did until TEAM-5022, is a lie about what the sweep actually
 * saw, not a finding.
 */
function retirable(row, targets) {
  if (row.readOnly) return false;
  if (routedNames(row, targets).length) return false;
  return listableId(row);
}

// ─── Step 3: pricing ─────────────────────────────────────────────────────────

/** USD per 1M tokens out of one Pricing API product, or null when the product
 *  has no on-demand USD dimension in a unit we understand. */
export function rateFromProduct(product) {
  const terms = product?.terms?.OnDemand;
  if (!isPlainObject(terms)) return null;
  for (const term of Object.values(terms)) {
    for (const dim of Object.values(term?.priceDimensions || {})) {
      const usd = Number(dim?.pricePerUnit?.USD);
      const factor = UNIT_TO_MILLION.get(String(dim?.unit ?? '').trim().toLowerCase());
      if (!Number.isFinite(usd) || usd <= 0 || !factor) continue;
      return usd * factor;
    }
  }
  return null;
}

async function publishedRates(deps, row) {
  const rates = {};
  for (const [kind, field] of PRICE_KINDS) {
    const usagetype = usagetypeFor(row, kind);
    let products;
    try {
      products = await deps.getProducts(serviceCodeFor(row), [
        { Type: 'TERM_MATCH', Field: 'usagetype', Value: usagetype },
      ]);
    } catch (e) {
      deps.log.warn?.(`[models] pricing.lookup-failed modelId=${row.modelId} usagetype=${usagetype} error=${errText(e)}`);
      return null;
    }
    for (const product of products || []) {
      const rate = rateFromProduct(product);
      if (isPositive(rate)) {
        rates[field] = rate;
        break;
      }
    }
  }
  return isPositive(rates.input) && isPositive(rates.output) ? rates : null;
}

const usablePrice = (p) => isPlainObject(p) && isPositive(p.input) && isPositive(p.output);

/** Write the rate block under the one field everything reads, and drop the older
 *  `pricing` spelling if this document still carries it — two rate blocks on one
 *  row is the split-brain that made the projection publish no prices at all. */
function setPrice(row, price) {
  row.price = price;
  delete row.pricing;
}

/**
 * Bring every live row's price up to date.
 *
 * Provenance is `price.source`, in the canonical vocabulary the TS `parsePrice()`
 * reads — `published` | `interim` | `manual` — and nothing else (TEAM-5029: an
 * earlier version keyed on a `state` field no row has, so every listing
 * overwrote every rate). Anything outside that vocabulary is what the canonical
 * normalises it to: `manual`, i.e. an operator's number.
 *
 * The three outcomes are deliberately different in kind:
 *   - a row the API prices and we do not (or that we priced as `interim`) is
 *     PROMOTED to the published rate, with a `sourceNote` saying so;
 *   - a row the API prices DIFFERENTLY from a `published` or `manual` rate we
 *     already carry records `priceDrift` and changes nothing. A rate the
 *     operator verified against Cost Explorer is not silently overwritten by a
 *     product listing — every card ever written used the old number, and a
 *     human decides whether the listing or the bill is right. A drift that has
 *     since closed is cleared;
 *   - a row nothing prices borrows its predecessor's rate as `interim`, naming
 *     the predecessor in `sourceNote`, or stays unpriced. Unpriced is visible:
 *     REPORT_VERSION 7 makes it a gap on the card instead of a plausible guess.
 *
 * The rate lands on `row.price` — the one field the seed, the TS canonical's
 * `parsePrice(raw.price)` and the projection's priceOf() all read. A document
 * still carrying the older `pricing` spelling is read through priceBlockOf() and
 * then rewritten as `price`, so no row ends up holding two rate blocks.
 */
/** Same tolerance as the TS canonical's `differs`: a per-1K → per-1M
 *  conversion can land a float hair off the carried number. */
const rateDiffers = (a, b) => Math.abs(a - b) > 1e-6;

async function refreshPricing(doc, deps, counts, nowIso, drifts) {
  const rows = Array.isArray(doc.catalog) ? doc.catalog : [];
  const today = nowIso.slice(0, 10);
  // predecessorRow() reads a NORMALIZED registry (rows under `.models`), and this
  // is the raw document — hand it the rows in the shape it expects rather than
  // teaching the byte-copied twin a second one.
  const view = { models: rows };
  for (const row of rows) {
    if (!RESOLVABLE_STATUSES.includes(statusOf(row))) continue;
    const current = priceBlockOf(row);
    const rates = await publishedRates(deps, row);

    if (rates) {
      const source = current?.source;
      if (!usablePrice(current) || source === 'interim') {
        const from = source === 'interim' ? 'interim' : 'unpriced';
        setPrice(row, {
          ...(current || {}),
          ...rates,
          source: 'published',
          asOf: nowIso,
          sourceNote: `Promoted from ${from} to the published Price List rate on ${today}.`,
        });
        delete row.price.priceDrift;
        if (source === 'interim') counts.promoted += 1; else counts.repriced += 1;
        deps.log.log(`[models] pricing.published modelId=${row.modelId} input=${rates.input} output=${rates.output}`);
        continue;
      }
      // Usable and `published`, `manual`, or anything else parsePrice() would
      // read as manual: the operator's number stands; the listing is recorded.
      const differs = PRICE_KINDS.some(([, f]) => isPositive(rates[f]) && rateDiffers(rates[f], current[f] ?? 0));
      if (differs) {
        setPrice(row, { ...current, priceDrift: { ...rates, seenAt: nowIso } });
        drifts.push(row.modelId);
        deps.log.warn?.(`[models] pricing.drift modelId=${row.modelId} `
          + `carried=${current.input}/${current.output} listed=${rates.input}/${rates.output} applied=no`);
      } else if (current.priceDrift) {
        // The listing agrees again: a stale drift is noise on the /models page.
        setPrice(row, { ...current });
        delete row.price.priceDrift;
        deps.log.log(`[models] pricing.drift-cleared modelId=${row.modelId}`);
      }
      continue;
    }

    if (usablePrice(current)) continue;
    const pred = predecessorRow(view, row);
    const predPrice = priceBlockOf(pred);
    if (usablePrice(predPrice)) {
      setPrice(row, {
        input: predPrice.input,
        output: predPrice.output,
        ...(isPositive(predPrice.cacheReadInput) ? { cacheReadInput: predPrice.cacheReadInput } : {}),
        ...(isPlainObject(predPrice.longContext) ? { longContext: { ...predPrice.longContext } } : {}),
        source: 'interim',
        sourceNote: `Interim: inherited from ${pred.modelId} until this model's rate publishes.`,
        asOf: nowIso,
      });
      counts.repriced += 1;
      deps.log.log(`[models] pricing.interim modelId=${row.modelId} from=${pred.modelId}`);
      continue;
    }
    deps.log.warn?.(`[models] pricing.unpriced modelId=${row.modelId} reason=no_product_no_predecessor`);
  }
}

// ─── Step 4: autoAdopt ───────────────────────────────────────────────────────

/**
 * Move a tier onto a newer model — the one inference this job is allowed to
 * make, and only for a tier the operator opted in with `autoAdopt["claude.opus"]
 * === true`.
 *
 * The bar is deliberately high: a priced candidate, a green `api` probe already
 * on the row (someone, or a previous run, proved it answers), and a fresh `cli`
 * probe run right here. A tier is what every blueprint asks for by name, so
 * adopting a model that cannot drive a coding turn would break the fleet at the
 * next `claude_code(model="opus")` call, not at the next probe.
 */
async function autoAdopt(doc, deps, counts, nowIso) {
  const opted = isPlainObject(doc.autoAdopt) ? doc.autoAdopt : {};
  let tierMoved = false;

  for (const [tierKey, enabled] of Object.entries(opted)) {
    if (enabled !== true) continue;
    const [cli, tier] = String(tierKey).split('.');
    if (!cli || !tier) continue;

    const eligible = (doc.catalog || []).filter((row) => statusOf(row) === 'candidate'
      && tierForFamily(row.vendor, row.family) === `${cli}.${tier}`
      && usablePrice(priceBlockOf(row))
      && row.probe?.api?.ok === true);
    if (!eligible.length) continue;

    // Newest first: adopting an older candidate than one we also hold would be a
    // downgrade dressed up as an adoption.
    eligible.sort((a, b) => compareVersions(
      parseModelVersion(b.modelId)?.version || [],
      parseModelVersion(a.modelId)?.version || [],
    ));
    const row = eligible[0];
    if (doc.tiers?.[cli]?.[tier] === row.modelId) continue;

    let result;
    try {
      result = await deps.probeCli(row);
    } catch (e) {
      result = { ok: false, at: nowIso, error: errText(e) };
    }
    row.probe = { ...(isPlainObject(row.probe) ? row.probe : {}), cli: result };
    if (!result?.ok) {
      deps.log.warn?.(`[models] autoAdopt.blocked tier=${tierKey} modelId=${row.modelId} reason=cli_probe_failed`);
      continue;
    }

    doc.tiers = isPlainObject(doc.tiers) ? doc.tiers : {};
    doc.tiers[cli] = isPlainObject(doc.tiers[cli]) ? doc.tiers[cli] : {};
    doc.tiers[cli][tier] = row.modelId;
    row.status = 'active';
    row.notify = { ...(isPlainObject(row.notify) ? row.notify : {}), requestedAt: nowIso };
    counts.autoAdopted += 1;
    counts.pinged += 1;
    tierMoved = true;
    deps.log.log(`[models] autoAdopt.moved tier=${tierKey} modelId=${row.modelId}`);
  }
  return tierMoved;
}

// ─── Step 5: write ───────────────────────────────────────────────────────────

/** Everything except the fields a write itself moves — what "did this pass
 *  actually change anything?" has to compare. */
function stripVolatile(doc) {
  const { version, updatedAt, updatedBy, ...rest } = isPlainObject(doc) ? doc : {};
  return rest;
}

const isPreconditionFailed = (e) => {
  const name = String(e?.name || e?.Code || e?.code || '');
  return name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412;
};

/** One pass of steps 2-5 over `base`. Returns the summary; `outcome: 'stale'` is
 *  internal and means the document moved under us. */
async function pass(base, deps, env, nowIso) {
  const counts = { added: 0, retired: 0, promoted: 0, repriced: 0, autoAdopted: 0, pinged: 0, routingProtected: 0 };
  const drifts = [];
  const next = clone(base.doc);

  const discovered = await discover(deps, env);
  mergeDiscovery(next, discovered, counts, nowIso, deps.log);
  await refreshPricing(next, deps, counts, nowIso, drifts);
  const tierMoved = await autoAdopt(next, deps, counts, nowIso);

  // One verdict on the post-pass document, shared with projectPricing. The
  // reconcile no longer retires a routing target (see retirable()), but other
  // reasons — a hand-edited tier at an unknown id, an unpriced target — can still
  // make a document invalid. A fatal verdict does NOT stop the models.json write,
  // but it must never be silent, because the fleet is about to refuse it.
  const verdict = validateRegistry(next);
  if (!verdict.registry) {
    deps.log.warn?.(`[models] reconcile.invalid-document ${fmtErrors(verdict.errors)}`);
  }

  const changed = JSON.stringify(stripVolatile(next)) !== JSON.stringify(stripVolatile(base.doc));

  // Re-read immediately before writing. A version that moved is a human editing
  // on /models; their document wins and this pass is replayed on top of it.
  const fresh = await readJson(deps, MODELS_KEY);
  if (!fresh) return { ...counts, drifts, outcome: 'failed', reason: 'registry_missing' };
  if ((fresh.doc?.version ?? 0) !== (base.doc?.version ?? 0)) {
    return { ...counts, drifts, outcome: 'stale', fresh };
  }

  if (changed) {
    // `models.prev.json` exists for exactly one reason: a tier move changes what
    // the whole fleet runs on the next cold start, so the operator needs the
    // previous document to diff and to restore from. Nothing else earns a copy.
    if (tierMoved) {
      try {
        await deps.s3Put(PREV_KEY, JSON.stringify(base.doc, null, 2), {});
      } catch (e) {
        deps.log.warn?.(`[models] reconcile.prev-write-failed error=${errText(e)}`);
      }
    }
    const body = JSON.stringify({
      ...next,
      version: (Number(base.doc?.version) || 0) + 1,
      updatedAt: nowIso,
      updatedBy: 'reconcile',
    }, null, 2);
    try {
      await deps.s3Put(MODELS_KEY, body, { ifMatch: fresh.etag });
    } catch (e) {
      if (!isPreconditionFailed(e)) throw e;
      deps.log.warn?.('[models] reconcile.write-rejected reason=precondition_failed');
      return { ...counts, drifts, outcome: 'conflict' };
    }
  }

  await projectPricing(deps, counts, verdict);
  return { ...counts, drifts, outcome: 'ok', changed };
}

/**
 * Re-derive `config/pricing.json` from the catalog.
 *
 * The projection is the ONLY way per-model rates reach the card Lambda, so it
 * runs even when the catalog itself did not change — that is what re-converges a
 * pricing document someone hand-edited. The non-catalog blocks (default rate,
 * cache multipliers, Kiro, AgentCore) are carried forward from the live
 * document, so an unreadable previous pricing file means we would DROP them:
 * this Lambda ships no seed copy, so it writes nothing at all rather than
 * publish a pricing file with holes in it. The same holds block by block
 * (TEAM-5029): a live document whose carried block fails the shared rule
 * (`missing:<key>` in the projection's notes) is left in place too — a hole is
 * worse than a stale file.
 *
 * It projects from the VALIDATED registry or not at all. Projecting from the raw
 * document instead was the second half of TEAM-5022: a document the twins refuse
 * would have been published as `models: {}`, i.e. every priced id silently gone
 * from the card Lambda. A skipped projection leaves the last good pricing.json in
 * place, which is the safe direction to fail in.
 */
async function projectPricing(deps, counts, verdict) {
  if (!verdict.registry) {
    deps.log.warn?.('[models] pricing.projected skipped reason=invalid_registry '
      + `errors=${fmtErrors(verdict.errors)}`);
    return;
  }
  const live = await readJson(deps, PRICING_KEY);
  if (!live) {
    deps.log.warn?.('[models] pricing.projected skipped reason=prev_unreadable');
    return;
  }
  const { pricing, prevSourceNotes } = pricingProjection(verdict.registry, live.doc, null);
  const missing = prevSourceNotes.filter((n) => n.startsWith('missing:'));
  if (missing.length) {
    deps.log.warn?.(`[models] pricing.projected skipped reason=${missing.join(',')}`);
    return;
  }
  if (JSON.stringify(live.doc) === JSON.stringify(pricing)) return;
  try {
    await deps.s3Put(PRICING_KEY, JSON.stringify(pricing, null, 2), { ifMatch: live.etag });
    counts.pricingWritten = true;
    deps.log.log(`[models] pricing.projected models=${Object.keys(pricing.models).length} `
      + `notes=${prevSourceNotes.join(',') || 'none'}`);
  } catch (e) {
    deps.log.warn?.(`[models] pricing.projected skipped reason=write_failed error=${errText(e)}`);
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

function summaryLine(deps, s) {
  deps.log.log(`[models] reconcile.summary added=${s.added} retired=${s.retired} promoted=${s.promoted} `
    + `repriced=${s.repriced} autoAdopted=${s.autoAdopted} pinged=${s.pinged} `
    + `routingProtected=${s.routingProtected} outcome=${s.outcome}`);
}

const ZERO = { added: 0, retired: 0, promoted: 0, repriced: 0, autoAdopted: 0, pinged: 0, routingProtected: 0 };

/** `{"mode":"reconcile"}` — the daily EventBridge rule
 *  `agentcore-hub-models-reconcile` and nothing else. */
export async function reconcileModels(event, deps) {
  const env = deps.env || {};
  const nowIso = deps.now().toISOString();

  const base = await readJson(deps, MODELS_KEY);
  if (!base) {
    const summary = { ...ZERO, outcome: 'failed', reason: 'registry_missing' };
    summaryLine(deps, summary);
    return summary;
  }

  let result;
  try {
    result = await pass(base, deps, env, nowIso);
    if (result.outcome === 'stale') {
      // One replay against the document that beat us — and `conflict` either
      // way, because a summary that said `ok` would hide the race from the
      // operator who caused it.
      deps.log.warn?.('[models] reconcile.retry reason=version_moved');
      const retried = await pass(result.fresh, deps, env, nowIso);
      result = { ...retried, outcome: retried.outcome === 'failed' ? 'failed' : 'conflict' };
    }
  } catch (e) {
    deps.log.warn?.(`[models] reconcile.failed error=${errText(e)}`);
    result = { ...ZERO, outcome: 'failed', reason: errText(e) };
  }

  const { fresh, ...summary } = result;
  summaryLine(deps, summary);
  return summary;
}
