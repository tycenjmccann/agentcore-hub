import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DiscoveredModel } from "./discovery";
import {
  discoverModels,
  familyFor,
  isSupportedRegion,
  listInferenceProfiles,
  listMantleModels,
  mantleRegions,
  mergeDiscovered,
  REGION_RE,
} from "./discovery";
import { BUNDLED_REGISTRY } from "@/lib/models-registry";
import type { ModelsRegistry } from "@/lib/models-registry";

/**
 * `mergeDiscovered` is the risky half of discovery — it is the one function that
 * can change the live document from a background sweep — so the tests here are
 * mostly about what it MUST NOT do: touch routing, delete a row, price a row, or
 * retire something a successful sweep would never have listed anyway.
 */

const h = vi.hoisted(() => ({
  signedFetch: vi.fn(),
  mintBedrockBearerToken: vi.fn(),
}));

vi.mock("./sigv4", () => ({
  signedFetch: h.signedFetch,
  mintBedrockBearerToken: h.mintBedrockBearerToken,
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function seed(): ModelsRegistry {
  return JSON.parse(JSON.stringify(BUNDLED_REGISTRY)) as ModelsRegistry;
}

function discovered(overrides: Partial<DiscoveredModel> & { modelId: string }): DiscoveredModel {
  return {
    label: overrides.modelId,
    vendor: "anthropic",
    family: familyFor(overrides.modelId),
    endpoint: "bedrock-runtime",
    region: "us-east-1",
    api: "converse",
    ...overrides,
  };
}

/** Both planes answered — the state every merge test below assumes unless it is
 *  specifically about a plane that did not (TEAM-5008 finding 4). */
const BOTH_PLANES: ReadonlySet<string> = new Set(["bedrock-runtime", "bedrock-mantle"]);

/** Everything the seed already knows, so a merge sees no departures. */
function allSeedIds(reg: ModelsRegistry): DiscoveredModel[] {
  return reg.catalog.map((r) => discovered({ modelId: r.modelId, vendor: r.vendor }));
}

describe("region validation", () => {
  it("accepts commercial regions", () => {
    for (const r of ["us-east-1", "us-east-2", "eu-west-1", "ap-southeast-2"]) {
      expect(isSupportedRegion(r)).toBe(true);
      expect(REGION_RE.test(r)).toBe(true);
    }
  });

  it("rejects gov, cn and malformed regions", () => {
    // A partition region would sign against a commercial host that is not there.
    expect(isSupportedRegion("us-gov-west-1")).toBe(false);
    expect(REGION_RE.test("us-gov-west-1")).toBe(false);
    for (const r of ["cn-north-1x", "us-east", "US-EAST-1", "", "us-east-1;rm -rf /", "../us-east-1"]) {
      expect(isSupportedRegion(r)).toBe(false);
    }
  });

  it("refuses to list against an unsupported region", async () => {
    await expect(listInferenceProfiles("us-gov-west-1")).rejects.toThrow(/unsupported region/);
    await expect(listMantleModels("nope")).rejects.toThrow(/unsupported region/);
    expect(h.signedFetch).not.toHaveBeenCalled();
  });
});

describe("mantleRegions", () => {
  it("derives the pair from BEDROCK_MANTLE_REGION by default", () => {
    expect(mantleRegions({})).toEqual(["us-east-2", "us-east-1"]);
    expect(mantleRegions({ BEDROCK_MANTLE_REGION: "eu-west-1" })).toEqual(["eu-west-1", "us-east-1"]);
  });

  it("honours BEDROCK_MANTLE_REGIONS, de-duped and validated", () => {
    expect(
      mantleRegions({ BEDROCK_MANTLE_REGIONS: " us-east-1 , us-east-1 ,us-gov-west-1, us-west-2 ,," })
    ).toEqual(["us-east-1", "us-west-2"]);
  });
});

describe("familyFor", () => {
  it("strips vendor prefix, the claude- prefix, versions and dates", () => {
    expect(familyFor("us.anthropic.claude-opus-5-5")).toBe("opus");
    expect(familyFor("us.anthropic.claude-opus-4-8")).toBe("opus");
    expect(familyFor("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("haiku");
    expect(familyFor("us.openai.gpt-6-astra")).toBe("astra");
    expect(familyFor("us.openai.gpt-5.6-terra")).toBe("terra");
    expect(familyFor("openai.gpt-5.5-codex")).toBe("codex");
  });
});

describe("listInferenceProfiles", () => {
  beforeEach(() => {
    h.signedFetch.mockReset();
  });

  it("pages, keeps only ACTIVE ids we recognise, and derives the api per vendor", async () => {
    h.signedFetch
      .mockResolvedValueOnce(
        json({
          inferenceProfileSummaries: [
            { inferenceProfileId: "us.anthropic.claude-opus-9", inferenceProfileName: "Claude Opus 9", status: "ACTIVE" },
            { inferenceProfileId: "us.anthropic.claude-broken", status: "INACTIVE" },
            { inferenceProfileId: "arn:aws:bedrock:::app-profile/abc", status: "ACTIVE" },
            { inferenceProfileId: "", status: "ACTIVE" },
          ],
          nextToken: "page2",
        })
      )
      .mockResolvedValueOnce(
        json({
          inferenceProfileSummaries: [
            { inferenceProfileId: "us.openai.gpt-9-nova", inferenceProfileName: "GPT-9 Nova" },
          ],
        })
      );

    const models = await listInferenceProfiles("us-east-1");

    expect(models.map((m) => m.modelId)).toEqual(["us.anthropic.claude-opus-9", "us.openai.gpt-9-nova"]);
    expect(models[0]).toMatchObject({
      vendor: "anthropic",
      api: "converse",
      endpoint: "bedrock-runtime",
      region: "us-east-1",
      family: "opus",
      label: "Claude Opus 9",
      pricingModelName: "Claude Opus 9",
    });
    // An *.openai.* inference profile still speaks the Responses API.
    expect(models[1]).toMatchObject({ vendor: "openai", api: "responses" });

    expect(h.signedFetch).toHaveBeenCalledTimes(2);
    const first = h.signedFetch.mock.calls[0][0];
    expect(first).toMatchObject({ service: "bedrock", region: "us-east-1", method: "GET" });
    expect(first.url).toContain("https://bedrock.us-east-1.amazonaws.com/inference-profiles?");
    expect(first.url).toContain("typeEquals=SYSTEM_DEFINED");
    expect(h.signedFetch.mock.calls[1][0].url).toContain("nextToken=page2");
  });

  it("throws on a non-2xx so the sweep records the region as failed", async () => {
    h.signedFetch.mockResolvedValueOnce(json({ message: "denied" }, 403));
    await expect(listInferenceProfiles("us-east-1")).rejects.toThrow(/HTTP 403/);
  });
});

describe("listMantleModels", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    h.mintBedrockBearerToken.mockReset().mockResolvedValue("bedrock-api-key-XYZ");
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses a Bearer token and keeps only openai.* ids", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ data: [{ id: "openai.gpt-9" }, { id: "anthropic.claude-x" }, {}] })
    );

    const models = await listMantleModels("us-east-2");

    expect(models).toEqual([
      {
        modelId: "openai.gpt-9",
        label: "openai.gpt-9",
        vendor: "openai",
        family: "gpt",
        endpoint: "bedrock-mantle",
        region: "us-east-2",
        api: "responses",
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://bedrock-mantle.us-east-2.api.aws/openai/v1/models");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer bedrock-api-key-XYZ");
  });

  it("throws on a non-2xx", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500));
    await expect(listMantleModels("us-east-2")).rejects.toThrow(/HTTP 500/);
  });
});

describe("discoverModels", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    h.signedFetch.mockReset();
    fetchMock.mockReset();
    h.mintBedrockBearerToken.mockReset().mockResolvedValue("bedrock-api-key-XYZ");
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ENV = { AWS_REGION: "us-east-1", BEDROCK_MANTLE_REGIONS: "us-east-2" };

  it("reports the endpoints that completed, not the ones it attempted", async () => {
    h.signedFetch.mockResolvedValueOnce(json({ message: "denied" }, 403));
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: "openai.gpt-9" }] }));

    const sweep = await discoverModels(ENV);

    expect(sweep.models.map((m) => m.modelId)).toEqual(["openai.gpt-9"]);
    expect([...sweep.scanned]).toEqual(["bedrock-mantle"]);
    expect(sweep.skippedEndpoints).toEqual(["bedrock-runtime"]);
    expect(sweep.errors).toEqual(["profiles:us-east-1: inference-profiles us-east-1 HTTP 403"]);
  });

  it("marks bedrock-mantle scanned when any one region answered", async () => {
    h.signedFetch.mockResolvedValueOnce(json({ inferenceProfileSummaries: [] }));
    fetchMock
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ data: [{ id: "openai.gpt-9" }] }));

    const sweep = await discoverModels({ AWS_REGION: "us-east-1", BEDROCK_MANTLE_REGIONS: "us-east-2,us-west-2" });

    expect([...sweep.scanned].sort()).toEqual(["bedrock-mantle", "bedrock-runtime"]);
    expect(sweep.skippedEndpoints).toEqual([]);
    expect(sweep.errors).toHaveLength(1);
  });

  it("scans nothing when both planes fail, so the merge can retire nothing", async () => {
    h.signedFetch.mockResolvedValueOnce(json({}, 500));
    fetchMock.mockResolvedValueOnce(json({}, 500));

    const sweep = await discoverModels(ENV);

    expect([...sweep.scanned]).toEqual([]);
    expect(sweep.skippedEndpoints.sort()).toEqual(["bedrock-mantle", "bedrock-runtime"]);
    expect(mergeDiscovered(seed(), sweep.models, { scanned: sweep.scanned }).retired).toEqual([]);
  });
});

describe("mergeDiscovered", () => {
  it("adds an unknown id as an unpriced candidate row", () => {
    const reg = seed();
    const { next, added, retired } = mergeDiscovered(reg, [
      ...allSeedIds(reg),
      discovered({ modelId: "us.anthropic.claude-opus-6", label: "Claude Opus 6" }),
    ], { scanned: BOTH_PLANES });

    expect(added).toEqual(["us.anthropic.claude-opus-6"]);
    expect(retired).toEqual([]);
    const row = next.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-6");
    expect(row).toMatchObject({
      label: "Claude Opus 6",
      vendor: "anthropic",
      family: "opus",
      endpoint: "bedrock-runtime",
      status: "candidate",
      contextWindow: 200_000,
      aliases: [],
    });
    // A candidate is never priced by discovery — pricing-api decides that.
    expect(row?.price).toBeUndefined();
    expect(next.catalog).toHaveLength(reg.catalog.length + 1);
  });

  it("retires a vanished row without deleting it", () => {
    const reg = seed();
    const sweep = allSeedIds(reg).filter((m) => m.modelId !== "us.anthropic.claude-opus-5-5");
    const { next, retired } = mergeDiscovered(reg, sweep, {
      scanned: BOTH_PLANES,
      now: new Date("2026-09-24T12:00:00Z"),
    });

    expect(retired).toEqual(["us.anthropic.claude-opus-5-5"]);
    const row = next.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5-5");
    expect(row?.status).toBe("retired");
    expect(row?.retiredAt).toBe("2026-09-24T12:00:00.000Z");
    // Still there, still priced: history must stay explainable.
    expect(row?.price?.input).toBe(BUNDLED_REGISTRY.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5-5")?.price?.input);
    expect(next.catalog).toHaveLength(reg.catalog.length);
  });

  it("never retires a readOnly row or a routing target, even on an empty sweep", () => {
    const reg = seed();
    const { next, retired } = mergeDiscovered(reg, [], { scanned: BOTH_PLANES });

    // The eval judge's foundation-model id is never an inference profile, so its
    // absence is not evidence of anything.
    expect(retired).not.toContain("anthropic.claude-opus-5");
    expect(next.catalog.find((r) => r.modelId === "anthropic.claude-opus-5")?.status).toBe("active");
    // Retiring a routed row would make the live doc fail validation on save.
    for (const id of ["us.anthropic.claude-fable-5-1", "us.anthropic.claude-sonnet-5", "openai.gpt-5.5"]) {
      expect(retired).not.toContain(id);
      expect(next.catalog.find((r) => r.modelId === id)?.status).toBe("active");
    }
    // The unrouted global.* rows are listable, so they DO retire.
    expect(retired).toContain("global.anthropic.claude-opus-5");
  });

  it("leaves already-retired rows alone", () => {
    const reg = seed();
    const before = reg.catalog.filter((r) => r.status === "retired").map((r) => r.retiredAt);
    const { next, retired } = mergeDiscovered(reg, [], { scanned: BOTH_PLANES });
    expect(retired).not.toContain("us.anthropic.claude-opus-4-8");
    expect(next.catalog.filter((r) => r.status === "retired").map((r) => r.retiredAt)).toEqual(
      expect.arrayContaining(before.filter(Boolean) as string[])
    );
  });

  it("drops a dated duplicate whose base id is known", () => {
    const reg = seed();
    const { next, added } = mergeDiscovered(reg, [
      ...allSeedIds(reg),
      discovered({ modelId: "us.anthropic.claude-sonnet-5-20260101-v1:0" }),
    ], { scanned: BOTH_PLANES });
    expect(added).toEqual([]);
    expect(next.catalog.some((r) => r.modelId === "us.anthropic.claude-sonnet-5-20260101-v1:0")).toBe(false);
  });

  it("drops a dated duplicate whose base id is in the same sweep", () => {
    const reg = seed();
    const { added } = mergeDiscovered(reg, [
      ...allSeedIds(reg),
      discovered({ modelId: "us.anthropic.claude-opus-7-20270101" }),
      discovered({ modelId: "us.anthropic.claude-opus-7" }),
    ], { scanned: BOTH_PLANES });
    expect(added).toEqual(["us.anthropic.claude-opus-7"]);
  });

  it("keeps a dated id when nothing shares its base", () => {
    const reg = seed();
    const { added } = mergeDiscovered(reg, [
      ...allSeedIds(reg),
      discovered({ modelId: "us.anthropic.claude-zephyr-1-20270101-v1:0" }),
    ], { scanned: BOTH_PLANES });
    expect(added).toEqual(["us.anthropic.claude-zephyr-1-20270101-v1:0"]);
  });

  it("never touches defaults, tiers, agents, quarantine or aliases", () => {
    const reg = seed();
    const routingBefore = JSON.stringify({
      defaults: reg.defaults,
      tiers: reg.tiers,
      agents: reg.agents,
      quarantine: reg.quarantine,
      legacyAliases: reg.legacyAliases,
      autoAdopt: reg.autoAdopt,
    });

    const { next } = mergeDiscovered(reg, [discovered({ modelId: "us.anthropic.claude-opus-6" })], {
      scanned: BOTH_PLANES,
    });

    expect(
      JSON.stringify({
        defaults: next.defaults,
        tiers: next.tiers,
        agents: next.agents,
        quarantine: next.quarantine,
        legacyAliases: next.legacyAliases,
        autoAdopt: next.autoAdopt,
      })
    ).toBe(routingBefore);
  });

  it("does not mutate the input registry", () => {
    const reg = seed();
    const snapshot = JSON.stringify(reg);
    mergeDiscovered(reg, [discovered({ modelId: "us.anthropic.claude-opus-6" })], { scanned: BOTH_PLANES });
    expect(JSON.stringify(reg)).toBe(snapshot);
  });

  /**
   * TEAM-5008 finding 4. The sweep is two independent planes, and one of them
   * failing used to look exactly like "every model on it vanished".
   */
  it("retires nothing on a plane that did not answer", () => {
    const reg = seed();
    // Mantle answered, the inference-profile listing threw: the sweep holds only
    // `openai.*` ids, and every Claude row is absent for the wrong reason.
    const mantleOnly = reg.catalog
      .filter((r) => r.endpoint === "bedrock-mantle")
      .map((r) => discovered({ modelId: r.modelId, vendor: r.vendor, endpoint: "bedrock-mantle" }));
    const { next, retired } = mergeDiscovered(reg, mantleOnly, { scanned: new Set(["bedrock-mantle"]) });

    expect(retired).toEqual([]);
    expect(next.catalog.find((r) => r.modelId === "global.anthropic.claude-opus-5")?.status).toBe("active");

    // …and an absent row on the plane that DID answer is still retired.
    const { retired: gone } = mergeDiscovered(reg, [], { scanned: new Set(["bedrock-mantle"]) });
    expect(gone).toEqual([]);
    const withMantleRow = seed();
    withMantleRow.catalog.push({
      ...withMantleRow.catalog.find((r) => r.modelId === "openai.gpt-5.5")!,
      modelId: "openai.gpt-4.9",
      aliases: [],
    });
    const { retired: mantleGone } = mergeDiscovered(withMantleRow, [], { scanned: new Set(["bedrock-mantle"]) });
    expect(mantleGone).toEqual(["openai.gpt-4.9"]);
  });

  it("retires an absent inference profile when Mantle is the failed plane", () => {
    const reg = seed();
    const { next, retired } = mergeDiscovered(reg, [], { scanned: new Set(["bedrock-runtime"]) });
    // openai.gpt-5.5 lives on Mantle and is a routing target twice over: absent,
    // but on the plane that never answered.
    expect(retired).not.toContain("openai.gpt-5.5");
    expect(next.catalog.find((r) => r.modelId === "openai.gpt-5.5")?.status).toBe("active");
    expect(retired).toContain("global.anthropic.claude-opus-5");
  });

  it("retires nothing at all when neither plane answered", () => {
    const { retired } = mergeDiscovered(seed(), [], { scanned: new Set() });
    expect(retired).toEqual([]);
  });

  it("keeps harness lanes and probe results on rows it retires", () => {
    const reg = seed();
    const { next } = mergeDiscovered(reg, [], { scanned: BOTH_PLANES });
    const fable = next.catalog.find((r) => r.modelId === "us.anthropic.claude-fable-5-1");
    expect(fable?.harnessLanes?.[0]?.id).toBe("claude-fable-5-1");
    const opus55 = next.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5-5");
    expect(opus55?.status).toBe("retired");
    expect(opus55?.price).toBeDefined();
  });
});
