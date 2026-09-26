/**
 * Model discovery (TEAM-4997): what models does this account actually have?
 *
 * Two sources, because they are two different planes:
 *   • Bedrock inference profiles (`us.*`, `global.*`) — GET /inference-profiles
 *     on `bedrock.<region>.amazonaws.com`, signed with SigV4.
 *   • Bedrock Mantle (`openai.*`) — the OpenAI-compatible model list on
 *     `bedrock-mantle.<region>.api.aws`, which takes a Bearer token, not SigV4.
 *
 * `mergeDiscovered` is PURE and deliberately timid: it may ADD a `candidate` row
 * and it may flip a vanished row to `retired`. It never deletes a row, never
 * prices one (beyond carrying a released alias's rate as `interim` — see
 * below), and never touches `defaults` / `tiers` / `agents` — routing is an
 * operator decision, and a discovery run that could repoint an agent would make
 * every model change invisible again, which is the failure this epic exists to
 * end.
 */

import type { CatalogRow, ModelApi, ModelEndpoint, ModelsRegistry, Vendor } from "@/lib/models-registry";
import { routingTargets } from "@/lib/models-registry";
import { assignBareAliases, DATED_ID_RE, isDiscoverableModelId, MANTLE_ID_RE, PROFILE_ID_RE } from "./model-id";
import { mintBedrockBearerToken, signedFetch } from "./sigv4";

export interface DiscoveredModel {
  modelId: string;
  label: string;
  vendor: Vendor;
  family: string;
  endpoint: ModelEndpoint;
  region: string;
  api: ModelApi;
  contextWindow?: number;
  /** Price List `model` attribute, when the source reports a display name. */
  pricingModelName?: string;
}

/**
 * A standard commercial region. Anchored, and three-segment regions
 * (`us-gov-west-1`, `cn-north-1` style partitions) are rejected: the endpoints
 * and the Price List offer file below are the commercial ones, so a partition
 * region would silently sign against a host that does not exist there.
 */
export const REGION_RE = /^[a-z]{2}-[a-z]+-\d$/;

export function isSupportedRegion(region: string): boolean {
  return REGION_RE.test(region) && !region.includes("-gov-");
}

function assertRegion(region: string): string {
  if (!isSupportedRegion(region)) throw new Error(`unsupported region ${region}`);
  return region;
}

/** Mantle regions to sweep. `BEDROCK_MANTLE_REGIONS` overrides the derived pair. */
export function mantleRegions(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const raw = env.BEDROCK_MANTLE_REGIONS || `${env.BEDROCK_MANTLE_REGION || "us-east-2"},us-east-1`;
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const region = part.trim();
    if (!region || !isSupportedRegion(region)) continue;
    if (!out.includes(region)) out.push(region);
  }
  return out;
}

/**
 * Family is the line a model belongs to, which is what carries a price forward
 * to its successor ("opus", "astra"). Version and date tokens are not part of
 * it, so `claude-opus-5-5` and `claude-opus-4-8` are both family "opus".
 */
export function familyFor(modelId: string): string {
  const bare = (modelId.split(".").pop() || modelId).replace(/^claude-/, "");
  const words = bare.split("-").filter((p) => p && !/^\d/.test(p) && !/^v\d/.test(p));
  return words.length ? words[words.length - 1] : bare;
}

function vendorOf(modelId: string): Vendor | null {
  if (modelId.includes(".anthropic.") || modelId.startsWith("anthropic.")) return "anthropic";
  if (modelId.includes(".openai.") || modelId.startsWith("openai.")) return "openai";
  return null;
}

function profileToModel(modelId: string, name: string | undefined, region: string): DiscoveredModel | null {
  const vendor = vendorOf(modelId);
  if (!vendor) return null;
  return {
    modelId,
    label: name || modelId,
    vendor,
    family: familyFor(modelId),
    endpoint: "bedrock-runtime",
    region,
    // An `*.openai.*` inference profile still speaks the Responses API.
    api: vendor === "openai" ? "responses" : "converse",
    ...(name ? { pricingModelName: name } : {}),
  };
}

interface ProfileSummary {
  inferenceProfileId?: string;
  inferenceProfileName?: string;
  status?: string;
}

/**
 * Every ACTIVE system-defined inference profile in `region` whose id is one of
 * ours (`us.*` / `global.*`, anthropic or openai). Account-owned APPLICATION
 * profiles are excluded by `typeEquals` — they are cost-allocation wrappers, not
 * models.
 */
export async function listInferenceProfiles(region: string): Promise<DiscoveredModel[]> {
  assertRegion(region);
  const out: DiscoveredModel[] = [];
  let nextToken: string | undefined;
  do {
    const url = new URL(`https://bedrock.${region}.amazonaws.com/inference-profiles`);
    url.searchParams.set("maxResults", "1000");
    url.searchParams.set("typeEquals", "SYSTEM_DEFINED");
    if (nextToken) url.searchParams.set("nextToken", nextToken);

    const res = await signedFetch({ service: "bedrock", region, method: "GET", url: url.toString() });
    if (!res.ok) throw new Error(`inference-profiles ${region} HTTP ${res.status}`);
    const body = (await res.json()) as { inferenceProfileSummaries?: ProfileSummary[]; nextToken?: string };

    for (const p of body.inferenceProfileSummaries || []) {
      const id = p.inferenceProfileId || "";
      if (!PROFILE_ID_RE.test(id)) continue;
      if ((p.status || "ACTIVE") !== "ACTIVE") continue;
      const model = profileToModel(id, p.inferenceProfileName, region);
      if (model) out.push(model);
    }
    nextToken = body.nextToken;
  } while (nextToken);
  return out;
}

/**
 * The Mantle model list for `region`. Mantle is OpenAI-compatible, so this is
 * `GET /openai/v1/models` with a Bearer token rather than a SigV4 signature.
 */
export async function listMantleModels(region: string): Promise<DiscoveredModel[]> {
  assertRegion(region);
  const token = await mintBedrockBearerToken(region);
  const res = await fetch(`https://bedrock-mantle.${region}.api.aws/openai/v1/models`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`mantle models ${region} HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };

  const out: DiscoveredModel[] = [];
  for (const m of body.data || []) {
    const id = m.id || "";
    if (!MANTLE_ID_RE.test(id)) continue;
    out.push({
      modelId: id,
      label: id,
      vendor: "openai",
      family: familyFor(id),
      endpoint: "bedrock-mantle",
      region,
      api: "responses",
    });
  }
  return out;
}

export interface Sweep {
  models: DiscoveredModel[];
  errors: string[];
  /**
   * The `endpoint` values a listing actually COMPLETED for. A plane that threw is
   * absent, and `mergeDiscovered` retires nothing on an absent plane: a failed
   * listing means we learned nothing, not that its models are gone.
   */
  scanned: Set<string>;
  /** Planes that were attempted and did not complete, for the response body. */
  skippedEndpoints: string[];
}

/**
 * Sweep every configured plane. One region's failure does not lose the others:
 * a partial listing is still better discovery than none, and `mergeDiscovered`
 * only retires ids it could plausibly have seen (see `retirable` and `scanned`).
 *
 * The endpoint bookkeeping mirrors `discover()` in
 * lambda/token-aggregator/models-reconcile.mjs — same keys, same "any one Mantle
 * region counts" rule — so the two sweeps cannot disagree about what was seen.
 */
export async function discoverModels(
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<Sweep> {
  const profileRegion = env.AWS_REGION || "us-east-1";
  const jobs: Array<Promise<DiscoveredModel[]>> = [];
  const labels: string[] = [];
  const endpoints: ModelEndpoint[] = [];
  if (isSupportedRegion(profileRegion)) {
    jobs.push(listInferenceProfiles(profileRegion));
    labels.push(`profiles:${profileRegion}`);
    endpoints.push("bedrock-runtime");
  }
  for (const region of mantleRegions(env)) {
    jobs.push(listMantleModels(region));
    labels.push(`mantle:${region}`);
    endpoints.push("bedrock-mantle");
  }

  const settled = await Promise.allSettled(jobs);
  const models: DiscoveredModel[] = [];
  const errors: string[] = [];
  const scanned = new Set<string>();
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      models.push(...r.value);
      // One successful region is enough to have seen the plane's catalog.
      scanned.add(endpoints[i]);
    } else {
      errors.push(`${labels[i]}: ${(r.reason as Error)?.message || "error"}`);
    }
  });
  const skippedEndpoints = [...new Set(endpoints)].filter((e) => !scanned.has(e));
  console.log(
    `[models] discovery.swept sources=${labels.length} models=${models.length} errors=${errors.length}` +
      ` scanned=[${[...scanned].sort().join(",")}]`
  );
  return { models, errors, scanned, skippedEndpoints };
}

export interface MergeResult {
  next: ModelsRegistry;
  added: string[];
  retired: string[];
}

function candidateRow(m: DiscoveredModel, alias?: string): CatalogRow {
  return {
    modelId: m.modelId,
    label: m.label || m.modelId,
    vendor: m.vendor,
    family: m.family,
    endpoint: m.endpoint,
    region: m.region,
    api: m.api,
    contextWindow: m.contextWindow ?? 200_000,
    aliases: alias ? [alias] : [],
    status: "candidate",
    ...(m.pricingModelName ? { pricingModelName: m.pricingModelName } : {}),
  };
}

/**
 * The rate a released alias's new row starts on: the owner's, as `interim`, so a
 * published listing promotes it rather than leaving the row unpriced (TEAM-5052).
 * Undefined when the owner has no usable rate.
 */
function interimPriceFrom(owner: CatalogRow, nowIso: string): CatalogRow["price"] | undefined {
  const p = owner.price;
  if (!p || !(p.input > 0) || !(p.output > 0)) return undefined;
  return {
    input: p.input,
    output: p.output,
    ...(p.cacheReadInput && p.cacheReadInput > 0 ? { cacheReadInput: p.cacheReadInput } : {}),
    ...(p.longContext ? { longContext: { ...p.longContext } } : {}),
    source: "interim",
    sourceNote: `Interim: carried from alias owner ${owner.modelId} until this model's rate publishes.`,
    asOf: nowIso,
  };
}

/**
 * Would a successful sweep have listed this id? Only then may its absence mean
 * "gone". `anthropic.claude-opus-5` (the eval judge's foundation-model id) is
 * never an inference profile, so retiring it on absence would be a lie; a row
 * the routing layer points at is likewise left alone, because retiring it would
 * make the live document fail validation on the operator's next save. That
 * includes a row routed at by one of its ALIASES: validation resolves a target
 * by id or alias, so the alias is just as `inactive` (TEAM-5017, TEAM-5073).
 */
function retirable(row: CatalogRow, targets: Set<string>): boolean {
  if (row.readOnly) return false;
  if (targets.has(row.modelId)) return false;
  if (row.aliases?.some((a) => targets.has(a))) return false;
  return isDiscoverableModelId(row.modelId);
}

/**
 * Pure merge. Adds unseen ids as unpriced `candidate` rows, flips vanished
 * `active`/`candidate` rows to `retired`, and leaves everything else — prices,
 * probes, lanes, and all of the routing block — exactly as it was.
 *
 * Discovery returns both the stable id and its dated snapshot
 * (`…-sonnet-5` and `…-sonnet-5-20260101-v1:0`); the dated one is noise and is
 * not added when the base id is already known or is in the same sweep.
 *
 * `opts.scanned` is REQUIRED (TEAM-5008 finding 4): retirement is scoped to the
 * planes whose listing completed. With the inference-profile call rejected and
 * Mantle fine, the sweep holds only `openai.*` ids, and an ungated merge would
 * retire every Claude row in the catalog on one transient 500.
 */
export function mergeDiscovered(
  reg: ModelsRegistry,
  discovered: DiscoveredModel[],
  opts: { scanned: ReadonlySet<string>; now?: Date }
): MergeResult {
  const next: ModelsRegistry = JSON.parse(JSON.stringify(reg)) as ModelsRegistry;
  const known = new Set(next.catalog.map((r) => r.modelId));
  const seen = new Set(discovered.map((m) => m.modelId));
  const targets = routingTargets(next);
  const added: string[] = [];
  const retired: string[] = [];
  const nowIso = (opts.now ?? new Date()).toISOString();

  // WHY (TEAM-5052): validateRegistry() treats an id claimed twice (a row's id
  // AND another row's alias) as a fatal `duplicate_alias`, and the read gate
  // then falls back on the whole document. So the alias map is part of "known":
  // a discovered id that is already some row's alias either moves to its own row
  // (below) or is left alone — never a second claim. A document that already
  // carries the double claim is healed first by dropping the alias; the row wins.
  // Same rule, same log names, as mergeDiscovery() in
  // lambda/token-aggregator/models-reconcile.mjs.
  const aliasOwner = new Map<string, CatalogRow>();
  for (const row of next.catalog) {
    const kept = row.aliases.filter((alias) => {
      if (alias === row.modelId || !known.has(alias)) return true;
      console.log(`[models] discovery.alias-dropped modelId=${alias} owner=${row.modelId} reason=existing_row`);
      return false;
    });
    if (kept.length !== row.aliases.length) row.aliases = kept;
    for (const alias of kept) if (!aliasOwner.has(alias)) aliasOwner.set(alias, row);
  }

  const fresh: Array<{ model: DiscoveredModel; carried?: CatalogRow["price"] }> = [];
  for (const m of discovered) {
    if (known.has(m.modelId)) continue;
    const base = DATED_ID_RE.exec(m.modelId)?.[1];
    if (base && (known.has(base) || seen.has(base))) continue;
    const owner = aliasOwner.get(m.modelId);
    if (owner && targets.has(m.modelId)) {
      // Routing resolves this id through its owner today; releasing the alias
      // would silently repoint that traffic at an unprobed candidate.
      console.log(
        `[models] discovery.skipped modelId=${m.modelId} reason=alias_of=${owner.modelId} routing_target=true`
      );
      continue;
    }
    if (owner) {
      // Discovery lists the alias as a model in its own right: it becomes its own
      // row (in the batch below) and keeps the owner's rate as `interim` (so a
      // published listing promotes it) rather than going unpriced. The owner's
      // status is untouched.
      owner.aliases = owner.aliases.filter((a) => a !== m.modelId);
      aliasOwner.delete(m.modelId);
      console.log(`[models] discovery.alias-released modelId=${m.modelId} owner=${owner.modelId}`);
    }
    fresh.push({ model: m, carried: owner ? interimPriceFrom(owner, nowIso) : undefined });
    known.add(m.modelId);
  }

  // Claude Code spans name a model by its bare CLI id, so a new `us.anthropic.*`
  // row needs that alias to be priced (TEAM-5065). Only NEW rows get one, and
  // only when nothing already resolves the name — existing aliases are curation.
  const taken = new Set<string>(Object.keys(next.legacyAliases ?? {}));
  for (const row of next.catalog) {
    taken.add(row.modelId);
    for (const a of row.aliases ?? []) taken.add(a);
  }
  const aliases = assignBareAliases(fresh.map((f) => f.model.modelId), taken);
  for (const { model: m, carried } of fresh) {
    const row = candidateRow(m, aliases.get(m.modelId));
    if (carried) row.price = carried;
    next.catalog.push(row);
    added.push(m.modelId);
  }

  // Which alias a kept owner is routed through, for the retire-skipped line.
  // retirable() already protects the owner (it checks aliases too); computed
  // after the add loop, so a released alias no longer protects the row it left.
  const routedOwners = new Map<string, string>();
  for (const t of targets) {
    if (known.has(t)) continue;
    const owner = aliasOwner.get(t);
    if (owner && !routedOwners.has(owner.modelId)) routedOwners.set(owner.modelId, t);
  }

  const retiredAt = nowIso;
  for (const row of next.catalog) {
    if (row.status !== "active" && row.status !== "candidate") continue;
    if (seen.has(row.modelId)) continue;
    // The row's own plane has to have answered before its absence means anything.
    if (!opts.scanned.has(row.endpoint || "bedrock-runtime")) continue;
    const alias = routedOwners.get(row.modelId);
    if (alias) {
      console.log(`[models] discovery.retire-skipped modelId=${row.modelId} reason=routed_alias=${alias}`);
      continue;
    }
    if (!retirable(row, targets)) continue;
    row.status = "retired";
    row.retiredAt = retiredAt;
    retired.push(row.modelId);
  }

  console.log(
    `[models] discovery.merged added=${added.length} retired=${retired.length} aliased=${aliases.size}`
  );
  return { next, added, retired };
}
