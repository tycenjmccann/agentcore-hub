import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getProducts,
  lookupPublishedRate,
  predecessorOf,
  refreshPrices,
  serviceCodeFor,
  usagetypeFor,
  versionKey,
} from "./pricing-api";
import type { CatalogRow, ModelsRegistry, Price } from "@/lib/models-registry";

/**
 * The three rules under test are the ones that decide whether a cost card is
 * honest: an interim guess is promoted when the real rate lands, a moved
 * published rate is RECORDED and never applied, and a brand-new candidate
 * inherits its predecessor rather than silently billing at the pricing default.
 */

const h = vi.hoisted(() => ({ signedFetch: vi.fn() }));
vi.mock("./sigv4", () => ({ signedFetch: h.signedFetch }));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function row(overrides: Partial<CatalogRow> & { modelId: string }): CatalogRow {
  return {
    label: overrides.modelId,
    vendor: "anthropic",
    family: "opus",
    endpoint: "bedrock-runtime",
    region: "us-east-1",
    api: "converse",
    contextWindow: 200_000,
    aliases: [],
    status: "active",
    ...overrides,
  };
}

function registry(rows: CatalogRow[]): ModelsRegistry {
  return {
    version: 1,
    updatedAt: "2026-09-24T00:00:00Z",
    updatedBy: "test",
    defaults: { persona: rows[0].modelId, codingClaude: rows[0].modelId, codingCodex: rows[0].modelId },
    tiers: { claude: {}, codex: {} },
    agents: {},
    autoAdopt: {},
    quarantine: [],
    legacyAliases: {},
    catalog: rows,
  };
}

/** A GetProducts page carrying one on-demand dimension at `usd` per `unit`. */
function productPage(usd: string, unit = "1K tokens") {
  return {
    PriceList: [
      JSON.stringify({
        terms: {
          OnDemand: {
            "term-1": {
              priceDimensions: { "dim-1": { unit, pricePerUnit: { USD: usd } } },
            },
          },
        },
      }),
    ],
  };
}

describe("usagetypeFor / serviceCodeFor", () => {
  it("builds the Mantle meter for an openai.* row", () => {
    const mantle = row({
      modelId: "openai.gpt-5.5",
      vendor: "openai",
      family: "gpt",
      endpoint: "bedrock-mantle",
      api: "responses",
      region: "us-east-2",
    });
    expect(serviceCodeFor(mantle)).toBe("AmazonBedrock");
    expect(usagetypeFor(mantle, "input")).toBe("USE1-openai.gpt-5.5-mantle-input-tokens-standard");
    expect(usagetypeFor(mantle, "output")).toBe("USE1-openai.gpt-5.5-mantle-output-tokens-standard");
    expect(usagetypeFor(mantle, "cache_read")).toBe("USE1-openai.gpt-5.5-mantle-cache_read-tokens-standard");
  });

  it("builds the global_standard meter for a global.* profile", () => {
    const global = row({ modelId: "global.anthropic.claude-opus-5" });
    expect(serviceCodeFor(global)).toBe("AmazonBedrockFoundationModels");
    expect(usagetypeFor(global, "input")).toBe("USE1-MP:USE1_input_tokens_global_standard-Units");
    expect(usagetypeFor(global, "output")).toBe("USE1-MP:USE1_output_tokens_global_standard-Units");
  });

  it("builds the standard meter for anything else", () => {
    const us = row({ modelId: "us.anthropic.claude-opus-5" });
    expect(usagetypeFor(us, "input")).toBe("USE1-MP:USE1_input_tokens_standard-Units");
    expect(usagetypeFor(us, "cache_read")).toBe("USE1-MP:USE1_cache_read_tokens_standard-Units");
  });
});

describe("getProducts", () => {
  beforeEach(() => {
    h.signedFetch.mockReset();
  });

  it("posts a signed JSON-1.1 GetProducts and parses the string entries", async () => {
    h.signedFetch.mockResolvedValueOnce(
      json({ PriceList: [JSON.stringify({ sku: "A" }), "{not json", { sku: "B" }] })
    );

    const products = await getProducts("AmazonBedrock", [{ Field: "usagetype", Value: "X" }]);

    expect(products).toEqual([{ sku: "A" }, { sku: "B" }]);
    const call = h.signedFetch.mock.calls[0][0];
    expect(call).toMatchObject({
      service: "pricing",
      region: "us-east-1",
      method: "POST",
      url: "https://api.pricing.us-east-1.amazonaws.com/",
    });
    expect(call.headers["x-amz-target"]).toBe("AWSPriceListService.GetProducts");
    expect(call.headers["content-type"]).toBe("application/x-amz-json-1.1");
    expect(JSON.parse(call.body)).toEqual({
      ServiceCode: "AmazonBedrock",
      Filters: [{ Type: "TERM_MATCH", Field: "usagetype", Value: "X" }],
      FormatVersion: "aws_v1",
      MaxResults: 100,
    });
  });

  it("follows NextToken and stops at maxPages", async () => {
    // A Response body reads once, so every call needs its own instance.
    h.signedFetch.mockImplementation(async () =>
      json({ PriceList: [JSON.stringify({ sku: "A" })], NextToken: "more" })
    );
    const products = await getProducts("AmazonBedrock", [], { maxPages: 3 });
    expect(products).toHaveLength(3);
    expect(h.signedFetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(h.signedFetch.mock.calls[1][0].body).NextToken).toBe("more");
  });

  it("throws on a non-2xx", async () => {
    h.signedFetch.mockResolvedValueOnce(json({}, 400));
    await expect(getProducts("AmazonBedrock", [])).rejects.toThrow(/HTTP 400/);
  });
});

describe("lookupPublishedRate", () => {
  beforeEach(() => {
    h.signedFetch.mockReset();
  });

  it("normalizes per-1K, per-1M and per-token dimensions to per-million", async () => {
    h.signedFetch
      .mockResolvedValueOnce(json(productPage("0.011", "1K tokens")))
      .mockResolvedValueOnce(json(productPage("55", "1M tokens")));
    expect(await lookupPublishedRate(row({ modelId: "us.anthropic.claude-fable-5-1" }))).toEqual({
      input: 11,
      output: 55,
    });

    h.signedFetch
      .mockResolvedValueOnce(json(productPage("0.000011", "tokens")))
      .mockResolvedValueOnce(json(productPage("0.000055", "tokens")));
    expect(await lookupPublishedRate(row({ modelId: "us.anthropic.claude-fable-5-1" }))).toEqual({
      input: 11,
      output: 55,
    });
  });

  it("adds the model attribute filter when the row carries a pricing name", async () => {
    h.signedFetch.mockImplementation(async () => json(productPage("0.001")));
    await lookupPublishedRate(row({ modelId: "us.anthropic.claude-opus-5", pricingModelName: "Claude Opus 5" }));
    expect(JSON.parse(h.signedFetch.mock.calls[0][0].body).Filters).toEqual([
      { Type: "TERM_MATCH", Field: "usagetype", Value: "USE1-MP:USE1_input_tokens_standard-Units" },
      { Type: "TERM_MATCH", Field: "model", Value: "Claude Opus 5" },
    ]);
  });

  it("returns null when either side has no price", async () => {
    h.signedFetch
      .mockResolvedValueOnce(json(productPage("0.011")))
      .mockResolvedValueOnce(json({ PriceList: [] }));
    expect(await lookupPublishedRate(row({ modelId: "us.anthropic.claude-opus-5" }))).toBeNull();
  });
});

describe("versionKey / predecessorOf", () => {
  it("reads the numeric version tokens out of an id", () => {
    expect(versionKey("us.anthropic.claude-opus-5-5")).toEqual([5, 5]);
    expect(versionKey("us.openai.gpt-5.6-terra")).toEqual([5, 6]);
    expect(versionKey("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toEqual([4, 5, 20251001, 1, 0]);
  });

  it("picks the highest priced older row of the same vendor and family", () => {
    const reg = registry([
      row({ modelId: "us.openai.gpt-6-sol", vendor: "openai", family: "sol", status: "candidate" }),
      row({
        modelId: "us.openai.gpt-5-sol",
        vendor: "openai",
        family: "sol",
        price: { input: 1, output: 2, source: "published", asOf: "2026-01-01" },
      }),
      row({
        modelId: "us.openai.gpt-5.6-sol",
        vendor: "openai",
        family: "sol",
        price: { input: 3, output: 4, source: "published", asOf: "2026-01-01" },
      }),
      row({
        modelId: "us.openai.gpt-5.9-luna",
        vendor: "openai",
        family: "luna",
        price: { input: 9, output: 9, source: "published", asOf: "2026-01-01" },
      }),
      // Unpriced rows and newer rows are not predecessors.
      row({ modelId: "us.openai.gpt-5.7-sol", vendor: "openai", family: "sol" }),
      row({
        modelId: "us.openai.gpt-7-sol",
        vendor: "openai",
        family: "sol",
        price: { input: 8, output: 8, source: "published", asOf: "2026-01-01" },
      }),
    ]);

    expect(predecessorOf(reg, reg.catalog[0])?.modelId).toBe("us.openai.gpt-5.6-sol");
  });

  it("returns null when nothing older of that family is priced", () => {
    const reg = registry([row({ modelId: "us.anthropic.claude-zephyr-1", family: "zephyr", status: "candidate" })]);
    expect(predecessorOf(reg, reg.catalog[0])).toBeNull();
  });
});

describe("refreshPrices", () => {
  const NOW = new Date("2026-09-24T12:00:00Z");

  it("promotes an interim rate to published and clears any recorded drift", async () => {
    const interim: Price = {
      input: 10,
      output: 50,
      cacheReadInput: 1,
      source: "interim",
      asOf: "2026-01-01",
      sourceNote: "guessed",
      priceDrift: { input: 1, output: 1, seenAt: "2026-02-02T00:00:00Z" },
    };
    const reg = registry([row({ modelId: "us.anthropic.claude-opus-5", price: interim })]);

    const res = await refreshPrices(reg, { now: NOW, lookup: async () => ({ input: 11, output: 55 }) });

    expect(res.repriced).toEqual(["us.anthropic.claude-opus-5"]);
    expect(res.drifted).toEqual([]);
    const price = res.next.catalog[0].price!;
    expect(price.input).toBe(11);
    expect(price.output).toBe(55);
    expect(price.source).toBe("published");
    expect(price.asOf).toBe("2026-09-24");
    expect(price.sourceNote).toMatch(/Promoted from interim/);
    expect(price.priceDrift).toBeUndefined();
    // Fields the Price List does not publish are carried, not dropped.
    expect(price.cacheReadInput).toBe(1);
  });

  it("prices a previously unpriced row straight to published", async () => {
    const reg = registry([row({ modelId: "us.anthropic.claude-opus-6", status: "candidate" })]);
    const res = await refreshPrices(reg, { now: NOW, lookup: async () => ({ input: 4.4, output: 22 }) });
    expect(res.repriced).toEqual(["us.anthropic.claude-opus-6"]);
    expect(res.next.catalog[0].price).toEqual({
      input: 4.4,
      output: 22,
      source: "published",
      asOf: "2026-09-24",
      sourceNote: "Promoted from unpriced to the published Price List rate on 2026-09-24.",
    });
  });

  it("records a moved published rate as drift and never applies it", async () => {
    const reg = registry([
      row({
        modelId: "us.anthropic.claude-opus-5",
        price: { input: 11, output: 55, source: "published", asOf: "2026-01-01" },
      }),
    ]);

    const res = await refreshPrices(reg, { now: NOW, lookup: async () => ({ input: 12, output: 60 }) });

    expect(res.drifted).toEqual(["us.anthropic.claude-opus-5"]);
    expect(res.repriced).toEqual([]);
    const price = res.next.catalog[0].price!;
    // The rate the cards already rendered with is untouched.
    expect(price.input).toBe(11);
    expect(price.output).toBe(55);
    expect(price.asOf).toBe("2026-01-01");
    expect(price.priceDrift).toEqual({ input: 12, output: 60, seenAt: NOW.toISOString() });
  });

  it("clears a stale drift once the published rate agrees again", async () => {
    const reg = registry([
      row({
        modelId: "us.anthropic.claude-opus-5",
        price: {
          input: 11,
          output: 55,
          source: "published",
          asOf: "2026-01-01",
          priceDrift: { input: 12, output: 60, seenAt: "2026-02-02T00:00:00Z" },
        },
      }),
    ]);
    const res = await refreshPrices(reg, { now: NOW, lookup: async () => ({ input: 11, output: 55 }) });
    expect(res.drifted).toEqual([]);
    expect(res.repriced).toEqual([]);
    expect(res.next.catalog[0].price?.priceDrift).toBeUndefined();
  });

  it("gives an unpublished candidate its predecessor's rate as interim", async () => {
    const reg = registry([
      row({
        modelId: "us.openai.gpt-5.6-sol",
        vendor: "openai",
        family: "sol",
        price: {
          input: 1.25,
          output: 10,
          cacheReadInput: 0.125,
          source: "published",
          asOf: "2026-01-01",
          longContext: { thresholdInputTokens: 272_000, input: 2.5, output: 20, cacheReadInput: 0.25 },
        },
      }),
      row({ modelId: "us.openai.gpt-6-sol", vendor: "openai", family: "sol", status: "candidate" }),
    ]);

    const res = await refreshPrices(reg, { now: NOW, lookup: async () => null });

    expect(res.repriced).toEqual(["us.openai.gpt-6-sol"]);
    expect(res.next.catalog[1].price).toEqual({
      input: 1.25,
      output: 10,
      cacheReadInput: 0.125,
      longContext: { thresholdInputTokens: 272_000, input: 2.5, output: 20, cacheReadInput: 0.25 },
      source: "interim",
      sourceNote: "Interim: inherited from us.openai.gpt-5.6-sol until this model's rate publishes.",
      asOf: "2026-09-24",
    });
    // The predecessor's own longContext object is copied, not shared.
    expect(res.next.catalog[1].price?.longContext).not.toBe(res.next.catalog[0].price?.longContext);
  });

  it("leaves an unpublished candidate unpriced when it has no predecessor", async () => {
    const reg = registry([row({ modelId: "us.anthropic.claude-zephyr-1", family: "zephyr", status: "candidate" })]);
    const res = await refreshPrices(reg, { now: NOW, lookup: async () => null });
    expect(res.repriced).toEqual([]);
    expect(res.next.catalog[0].price).toBeUndefined();
  });

  it("does not inherit for an ACTIVE unpriced row — only a candidate", async () => {
    const reg = registry([
      row({
        modelId: "us.anthropic.claude-opus-4-8",
        price: { input: 5, output: 25, source: "published", asOf: "2026-01-01" },
      }),
      row({ modelId: "us.anthropic.claude-opus-5", status: "active" }),
    ]);
    const res = await refreshPrices(reg, { now: NOW, lookup: async () => null });
    expect(res.repriced).toEqual([]);
    expect(res.next.catalog[1].price).toBeUndefined();
  });

  it("skips retired rows entirely", async () => {
    const looked: string[] = [];
    const reg = registry([
      row({ modelId: "us.anthropic.claude-opus-5" }),
      row({ modelId: "us.anthropic.claude-opus-4-8", status: "retired" }),
    ]);
    await refreshPrices(reg, {
      now: NOW,
      lookup: async (r) => {
        looked.push(r.modelId);
        return { input: 1, output: 2 };
      },
    });
    // A retired row costs neither a Price List call nor a reprice.
    expect(looked).toEqual(["us.anthropic.claude-opus-5"]);
  });

  it("collects a lookup failure per row and keeps going", async () => {
    const reg = registry([
      row({ modelId: "us.anthropic.claude-opus-5" }),
      row({ modelId: "us.anthropic.claude-sonnet-5", family: "sonnet" }),
    ]);
    const res = await refreshPrices(reg, {
      now: NOW,
      lookup: async (r) => {
        if (r.modelId.includes("opus")) throw new Error("HTTP 429");
        return { input: 3, output: 15 };
      },
    });
    expect(res.errors).toEqual(["us.anthropic.claude-opus-5: HTTP 429"]);
    expect(res.repriced).toEqual(["us.anthropic.claude-sonnet-5"]);
    expect(res.next.catalog[0].price).toBeUndefined();
  });

  it("never mutates the input registry", async () => {
    const reg = registry([
      row({
        modelId: "us.anthropic.claude-opus-5",
        price: { input: 11, output: 55, source: "interim", asOf: "2026-01-01" },
      }),
    ]);
    const snapshot = JSON.stringify(reg);
    await refreshPrices(reg, { now: NOW, lookup: async () => ({ input: 12, output: 60 }) });
    expect(JSON.stringify(reg)).toBe(snapshot);
  });
});
