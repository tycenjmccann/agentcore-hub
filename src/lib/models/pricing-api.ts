/**
 * AWS Price List → catalog prices (TEAM-4997).
 *
 * `@aws-sdk/client-pricing` is not in node_modules and this ticket adds no
 * dependency, so `GetProducts` is called as what it is: a JSON-1.1 POST to
 * `api.pricing.us-east-1.amazonaws.com`, signed by `signedFetch`.
 *
 * Three rules encode the thing that actually goes wrong with model pricing:
 *   1. An `interim` rate (a guess we wrote down) is PROMOTED the moment the real
 *      one publishes.
 *   2. A `published` rate that has since moved is RECORDED as `priceDrift` and
 *      never auto-applied — a silent reprice would rewrite the cost history of
 *      every card that already rendered.
 *   3. A brand-new `candidate` with no published rate inherits its predecessor's
 *      rate as `interim`, because the alternative is the pricing `default`, and
 *      billing a new model at the default is exactly the invisible wrongness
 *      this epic exists to remove.
 */

import type { CatalogRow, ModelsRegistry, Price } from "@/lib/models-registry";
import { signedFetch } from "./sigv4";

const PRICING_HOST = "api.pricing.us-east-1.amazonaws.com";
/** The Price List API lives only in us-east-1 (and ap-south-1); use us-east-1. */
const PRICING_REGION = "us-east-1";

export interface PriceFilter {
  Type?: "TERM_MATCH";
  Field: string;
  Value: string;
}

/** One parsed `PriceList` entry. The shape is deep and mostly irrelevant here. */
export type PriceProduct = Record<string, unknown>;

/**
 * `GetProducts`, paginated. Each `PriceList` element arrives as a JSON STRING
 * and is parsed; an unparseable element is skipped rather than failing the page.
 */
export async function getProducts(
  serviceCode: string,
  filters: PriceFilter[],
  opts: { maxPages?: number } = {}
): Promise<PriceProduct[]> {
  const maxPages = opts.maxPages ?? 10;
  const out: PriceProduct[] = [];
  let nextToken: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const body = JSON.stringify({
      ServiceCode: serviceCode,
      Filters: filters.map((f) => ({ Type: f.Type || "TERM_MATCH", Field: f.Field, Value: f.Value })),
      FormatVersion: "aws_v1",
      MaxResults: 100,
      ...(nextToken ? { NextToken: nextToken } : {}),
    });

    const res = await signedFetch({
      service: "pricing",
      region: PRICING_REGION,
      method: "POST",
      url: `https://${PRICING_HOST}/`,
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSPriceListService.GetProducts",
      },
      body,
    });
    if (!res.ok) throw new Error(`GetProducts ${serviceCode} HTTP ${res.status}`);
    const parsed = (await res.json()) as { PriceList?: unknown[]; NextToken?: string };

    for (const entry of parsed.PriceList || []) {
      if (typeof entry === "string") {
        try {
          out.push(JSON.parse(entry) as PriceProduct);
        } catch {
          /* one malformed entry must not lose the page */
        }
      } else if (entry && typeof entry === "object") {
        out.push(entry as PriceProduct);
      }
    }
    nextToken = parsed.NextToken;
    if (!nextToken) break;
  }
  return out;
}

export type PriceKind = "input" | "output" | "cache_read";

/** Mantle usage rolls up under AmazonBedrock; profiles under the FM service. */
export function serviceCodeFor(row: CatalogRow): string {
  return row.endpoint === "bedrock-mantle" ? "AmazonBedrock" : "AmazonBedrockFoundationModels";
}

/**
 * The `usagetype` attribute that carries this row's rate. Three shapes, because
 * the three planes bill through three different meters:
 *   • Mantle (`openai.*`)  → `USE1-openai.<bare>-mantle-<kind>-tokens-standard`
 *   • a `global.*` profile → `USE1-MP:USE1_<kind>_tokens_global_standard-Units`
 *   • anything else        → `USE1-MP:USE1_<kind>_tokens_standard-Units`
 */
export function usagetypeFor(row: CatalogRow, kind: PriceKind): string {
  if (row.endpoint === "bedrock-mantle") {
    const bare = row.modelId.replace(/^openai\./, "");
    return `USE1-openai.${bare}-mantle-${kind}-tokens-standard`;
  }
  const tier = row.modelId.startsWith("global.") ? "global_standard" : "standard";
  return `USE1-MP:USE1_${kind}_tokens_${tier}-Units`;
}

/**
 * Per-MILLION-token USD from one price dimension. The catalog is per 1M; the
 * Price List publishes Bedrock token meters per 1K (and occasionally per token),
 * so the conversion is driven by the dimension's own `unit` rather than a
 * hardcoded factor.
 */
function perMillion(dim: { pricePerUnit?: { USD?: string }; unit?: string }): number | null {
  const usd = Number(dim?.pricePerUnit?.USD);
  if (!Number.isFinite(usd) || usd <= 0) return null;
  const unit = String(dim?.unit || "");
  if (/1m|m[-_ ]?token|million/i.test(unit)) return usd;
  if (/1k|k[-_ ]?token|thousand/i.test(unit)) return usd * 1_000;
  return usd * 1_000_000;
}

/** Cheapest on-demand dimension in a product list, normalized to per-1M. */
function rateFromProducts(products: PriceProduct[]): number | null {
  let best: number | null = null;
  for (const product of products) {
    const onDemand = (product as { terms?: { OnDemand?: Record<string, unknown> } }).terms?.OnDemand || {};
    for (const term of Object.values(onDemand)) {
      const dims = (term as { priceDimensions?: Record<string, unknown> })?.priceDimensions || {};
      for (const dim of Object.values(dims)) {
        const rate = perMillion(dim as { pricePerUnit?: { USD?: string }; unit?: string });
        if (rate !== null && (best === null || rate < best)) best = rate;
      }
    }
  }
  return best;
}

export interface PublishedRate {
  input: number;
  output: number;
}

/** A row's published input+output rate, or null when the meter has no price. */
export async function lookupPublishedRate(row: CatalogRow): Promise<PublishedRate | null> {
  const serviceCode = serviceCodeFor(row);
  const modelFilter: PriceFilter[] = row.pricingModelName
    ? [{ Field: "model", Value: row.pricingModelName }]
    : [];

  const [inputProducts, outputProducts] = await Promise.all([
    getProducts(serviceCode, [{ Field: "usagetype", Value: usagetypeFor(row, "input") }, ...modelFilter]),
    getProducts(serviceCode, [{ Field: "usagetype", Value: usagetypeFor(row, "output") }, ...modelFilter]),
  ]);

  const input = rateFromProducts(inputProducts);
  const output = rateFromProducts(outputProducts);
  if (input === null || output === null) return null;
  return { input, output };
}

export type PriceLookup = (row: CatalogRow) => Promise<PublishedRate | null>;

/** Numeric version tokens in an id, for "which model came before this one". */
export function versionKey(modelId: string): number[] {
  return (modelId.match(/\d+/g) || []).map((n) => Number(n));
}

function versionCompare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const priced = (p?: Price): boolean => !!p && Number.isFinite(p.input) && Number.isFinite(p.output);

/**
 * The highest-versioned priced row of the same vendor+family that is OLDER than
 * `row` — "GPT-6 Sol inherits GPT-5.6 Sol's rate", not some unrelated model's.
 */
export function predecessorOf(reg: ModelsRegistry, row: CatalogRow): CatalogRow | null {
  const mine = versionKey(row.modelId);
  let best: CatalogRow | null = null;
  for (const other of reg.catalog) {
    if (other.modelId === row.modelId) continue;
    if (other.vendor !== row.vendor || other.family !== row.family) continue;
    if (!priced(other.price)) continue;
    if (versionCompare(versionKey(other.modelId), mine) >= 0) continue;
    if (!best || versionCompare(versionKey(other.modelId), versionKey(best.modelId)) > 0) best = other;
  }
  return best;
}

const differs = (a: number, b: number) => Math.abs(a - b) > 1e-6;

export interface RefreshResult {
  next: ModelsRegistry;
  /** Rows whose own rate changed (interim promoted, or predecessor inherited). */
  repriced: string[];
  /** Rows where a published rate moved; recorded as `priceDrift`, not applied. */
  drifted: string[];
  errors: string[];
}

/**
 * Re-price the catalog against the Price List. Pure apart from `lookup`, which
 * is injectable precisely so this logic is testable without a network or an
 * account. Never mutates the input registry.
 */
export async function refreshPrices(
  reg: ModelsRegistry,
  opts: { lookup?: PriceLookup; now?: Date } = {}
): Promise<RefreshResult> {
  const lookup = opts.lookup ?? lookupPublishedRate;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);

  const next: ModelsRegistry = JSON.parse(JSON.stringify(reg)) as ModelsRegistry;
  const repriced: string[] = [];
  const drifted: string[] = [];
  const errors: string[] = [];

  for (const row of next.catalog) {
    if (row.status === "retired") continue;

    let rate: PublishedRate | null = null;
    try {
      rate = await lookup(row);
    } catch (err) {
      errors.push(`${row.modelId}: ${(err as Error)?.message || "lookup failed"}`);
      continue;
    }

    if (rate) {
      const price = row.price;
      if (!price || price.source === "interim") {
        row.price = {
          ...(price || { source: "published", asOf: today }),
          input: rate.input,
          output: rate.output,
          source: "published",
          asOf: today,
          sourceNote: `Promoted from ${price ? "interim" : "unpriced"} to the published Price List rate on ${today}.`,
        };
        delete row.price.priceDrift;
        repriced.push(row.modelId);
      } else if (differs(price.input, rate.input) || differs(price.output, rate.output)) {
        // Recorded, never applied: repricing history silently is the bug.
        price.priceDrift = { input: rate.input, output: rate.output, seenAt: nowIso };
        drifted.push(row.modelId);
      } else if (price.priceDrift) {
        delete price.priceDrift;
      }
      continue;
    }

    if (!priced(row.price) && row.status === "candidate") {
      const pred = predecessorOf(next, row);
      if (pred?.price) {
        row.price = {
          input: pred.price.input,
          output: pred.price.output,
          ...(typeof pred.price.cacheReadInput === "number" ? { cacheReadInput: pred.price.cacheReadInput } : {}),
          ...(pred.price.longContext ? { longContext: { ...pred.price.longContext } } : {}),
          source: "interim",
          sourceNote: `Interim: inherited from ${pred.modelId} until this model's rate publishes.`,
          asOf: today,
        };
        repriced.push(row.modelId);
      }
    }
  }

  console.log(
    `[models] pricing.refreshed repriced=${repriced.length} drifted=${drifted.length} errors=${errors.length}`
  );
  return { next, repriced, drifted, errors };
}
