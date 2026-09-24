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
 * prices one, and never touches `defaults` / `tiers` / `agents` — routing is an
 * operator decision, and a discovery run that could repoint an agent would make
 * every model change invisible again, which is the failure this epic exists to
 * end.
 */

import type { CatalogRow, ModelApi, ModelEndpoint, ModelsRegistry, Vendor } from "@/lib/models-registry";
import { routingTargets } from "@/lib/models-registry";
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

/** Only ids the two listings can actually return are candidates for retirement. */
const PROFILE_ID_RE = /^(us|global)\.(anthropic|openai)\.[A-Za-z0-9._:-]+$/;
const MANTLE_ID_RE = /^openai\.[A-Za-z0-9._:-]+$/;

/** `<base>-YYYYMMDD` with an optional `-vN[:M]` tail — the dated snapshot form. */
const DATED_ID_RE = /^(.*)-\d{8}(?:-v\d+(?::\d+)?)?$/;

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

function candidateRow(m: DiscoveredModel): CatalogRow {
  return {
    modelId: m.modelId,
    label: m.label || m.modelId,
    vendor: m.vendor,
    family: m.family,
    endpoint: m.endpoint,
    region: m.region,
    api: m.api,
    contextWindow: m.contextWindow ?? 200_000,
    aliases: [],
    status: "candidate",
    ...(m.pricingModelName ? { pricingModelName: m.pricingModelName } : {}),
  };
}

/**
 * Would a successful sweep have listed this id? Only then may its absence mean
 * "gone". `anthropic.claude-opus-5` (the eval judge's foundation-model id) is
 * never an inference profile, so retiring it on absence would be a lie; a row
 * the routing layer points at is likewise left alone, because retiring it would
 * make the live document fail validation on the operator's next save. That
 * includes a row routed at by one of its ALIASES: validation resolves a target
 * by id or alias, so the alias is just as `inactive` (TEAM-5017).
 */
function retirable(row: CatalogRow, targets: Set<string>): boolean {
  if (row.readOnly) return false;
  if (targets.has(row.modelId)) return false;
  if (row.aliases?.some((a) => targets.has(a))) return false;
  return PROFILE_ID_RE.test(row.modelId) || MANTLE_ID_RE.test(row.modelId);
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

  for (const m of discovered) {
    if (known.has(m.modelId)) continue;
    const base = DATED_ID_RE.exec(m.modelId)?.[1];
    if (base && (known.has(base) || seen.has(base))) continue;
    next.catalog.push(candidateRow(m));
    known.add(m.modelId);
    added.push(m.modelId);
  }

  const retiredAt = (opts.now ?? new Date()).toISOString();
  for (const row of next.catalog) {
    if (row.status !== "active" && row.status !== "candidate") continue;
    if (seen.has(row.modelId)) continue;
    // The row's own plane has to have answered before its absence means anything.
    if (!opts.scanned.has(row.endpoint || "bedrock-runtime")) continue;
    if (!retirable(row, targets)) continue;
    row.status = "retired";
    row.retiredAt = retiredAt;
    retired.push(row.modelId);
  }

  console.log(`[models] discovery.merged added=${added.length} retired=${retired.length}`);
  return { next, added, retired };
}
