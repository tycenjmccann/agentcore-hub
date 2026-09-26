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
import type { ModelsRegistry } from "@/lib/models-registry";
import { BUNDLED_REGISTRY, fatalReadErrors, validateRegistry } from "@/lib/models-registry";

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
      // The bare CLI name Claude Code reports in spans (TEAM-5065).
      aliases: ["claude-opus-6"],
    });
    // A candidate is never priced by discovery — pricing-api decides that.
    expect(row?.price).toBeUndefined();
    expect(next.catalog).toHaveLength(reg.catalog.length + 1);
  });

  describe("bare CLI alias (TEAM-5065)", () => {
    const merge = (reg: ModelsRegistry, ids: string[]) =>
      mergeDiscovered(reg, [...allSeedIds(reg), ...ids.map((modelId) => discovered({ modelId }))], {
        scanned: BOTH_PLANES,
      }).next;
    const aliasesOf = (reg: ModelsRegistry, id: string) => reg.catalog.find((r) => r.modelId === id)?.aliases;

    it("gives the us.* row the alias and leaves its global.* twin alias-free", () => {
      const next = merge(seed(), ["us.anthropic.claude-opus-6-v1:0", "global.anthropic.claude-opus-6-v1:0"]);
      expect(aliasesOf(next, "us.anthropic.claude-opus-6-v1:0")).toEqual(["claude-opus-6"]);
      expect(aliasesOf(next, "global.anthropic.claude-opus-6-v1:0")).toEqual([]);
      expect(validateRegistry(next).errors).not.toMatchObject({
        "catalog.us.anthropic.claude-opus-6-v1:0.aliases.claude-opus-6": expect.anything(),
      });
    });

    it("strips a date stamp as well as the version tail", () => {
      const next = merge(seed(), ["us.anthropic.claude-haiku-6-20270101-v1:0"]);
      expect(aliasesOf(next, "us.anthropic.claude-haiku-6-20270101-v1:0")).toEqual(["claude-haiku-6"]);
    });

    it("gives an alias two candidates in one batch both derive to neither", () => {
      const next = merge(seed(), ["us.anthropic.claude-opus-7", "us.anthropic.claude-opus-7-v2:0"]);
      expect(aliasesOf(next, "us.anthropic.claude-opus-7")).toEqual([]);
      expect(aliasesOf(next, "us.anthropic.claude-opus-7-v2:0")).toEqual([]);
    });

    it("never takes a name an existing row already owns, retired rows included", () => {
      // claude-fable-5 is the RETIRED us.anthropic.claude-fable-5 row's alias.
      const next = merge(seed(), ["us.anthropic.claude-fable-5-v1:0"]);
      expect(aliasesOf(next, "us.anthropic.claude-fable-5-v1:0")).toEqual([]);
    });

    it("never takes a legacyAliases key", () => {
      const reg = seed();
      reg.legacyAliases = { ...reg.legacyAliases, "claude-opus-6": "us.anthropic.claude-opus-5" };
      expect(aliasesOf(merge(reg, ["us.anthropic.claude-opus-6"]), "us.anthropic.claude-opus-6")).toEqual([]);
    });

    it("leaves every existing row's aliases exactly as they were", () => {
      const reg = seed();
      const next = merge(reg, ["us.anthropic.claude-opus-6"]);
      for (const row of reg.catalog) expect(aliasesOf(next, row.modelId), row.modelId).toEqual(row.aliases);
    });
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

  it("never retires a row routed at only by one of its aliases", () => {
    // us.anthropic.claude-opus-5-5 retires when nothing routes at it (above); an
    // alias in a tier protects it exactly as its id would, because validation
    // resolves a routing target by id or alias.
    const reg = seed();
    reg.tiers.claude.sonnet = "claude-opus-5-5";
    const { next, retired } = mergeDiscovered(reg, [], { scanned: BOTH_PLANES });
    expect(retired).not.toContain("us.anthropic.claude-opus-5-5");
    expect(next.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5-5")?.status).toBe("active");
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

// TEAM-5052 — the same night as the reconcile's (models-reconcile.test.mjs):
// the seed's retired `us.anthropic.claude-opus-4-6` owns the alias
// `us.anthropic.claude-opus-4-6-v1`, and a sweep lists that alias as a profile.
// Same case names as the reconcile's, so the two merges can be read side by side.
describe("mergeDiscovered — a discovered id that is already a row alias (TEAM-5052)", () => {
  const ALIAS = "us.anthropic.claude-opus-4-6-v1";
  const OWNER = "us.anthropic.claude-opus-4-6";
  const NOW = new Date("2026-09-24T03:00:00.000Z");

  const fatalOf = (reg: ModelsRegistry) => fatalReadErrors(validateRegistry(reg).errors);
  const sweepPlusAlias = (reg: ModelsRegistry) => [...allSeedIds(reg), discovered({ modelId: ALIAS })];

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a models.json the shared validator accepts", () => {
    const { next, added } = mergeDiscovered(seed(), sweepPlusAlias(seed()), { scanned: BOTH_PLANES, now: NOW });
    expect(added).toEqual([ALIAS]);
    expect(fatalOf(next)).toEqual({});
    const claimants = next.catalog.filter((r) => r.modelId === ALIAS || r.aliases.includes(ALIAS));
    expect(claimants).toHaveLength(1);
  });

  it("the released alias's row carries the owner's price as interim", () => {
    const owner = seed().catalog.find((r) => r.modelId === OWNER)!;
    const { next } = mergeDiscovered(seed(), sweepPlusAlias(seed()), { scanned: BOTH_PLANES, now: NOW });
    const fresh = next.catalog.find((r) => r.modelId === ALIAS)!;
    // Its bare CLI alias comes from TEAM-5065; the released id is not re-claimed.
    expect(fresh).toMatchObject({ status: "candidate", aliases: ["claude-opus-4-6"] });
    expect(fresh.price).toMatchObject({
      input: owner.price!.input,
      output: owner.price!.output,
      source: "interim",
      asOf: NOW.toISOString(),
    });
    expect(fresh.price!.sourceNote).toContain(OWNER);
  });

  it("leaves the retired owner retired and logs discovery.alias-released", () => {
    const { next } = mergeDiscovered(seed(), sweepPlusAlias(seed()), { scanned: BOTH_PLANES, now: NOW });
    const owner = next.catalog.find((r) => r.modelId === OWNER)!;
    expect(owner.status).toBe("retired");
    expect(owner.aliases).toEqual([]);
    const logs = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain(`discovery.alias-released modelId=${ALIAS} owner=${OWNER}`);
  });

  it("heals a live document that already claims an id as both row and alias", () => {
    const reg = seed();
    const owner = reg.catalog.find((r) => r.modelId === OWNER)!;
    // The candidate the pre-fix reconcile minted: the owner's shape, no lanes.
    const { harnessLanes: _lanes, ...shape } = JSON.parse(JSON.stringify(owner)) as typeof owner;
    reg.catalog.push({ ...shape, modelId: ALIAS, aliases: [], status: "candidate" });
    expect(Object.values(fatalOf(reg))).toContain("duplicate_alias");

    const { next, added } = mergeDiscovered(reg, allSeedIds(reg), { scanned: BOTH_PLANES, now: NOW });
    expect(added).toEqual([]);
    expect(fatalOf(next)).toEqual({});
    expect(next.catalog.find((r) => r.modelId === OWNER)!.aliases).toEqual([]);
    expect(next.catalog.filter((r) => r.modelId === ALIAS)).toHaveLength(1);
    const logs = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain(`discovery.alias-dropped modelId=${ALIAS} owner=${OWNER} reason=existing_row`);
  });

  it("keeps an alias that routing points at, and adds no candidate for it", () => {
    const reg = seed();
    const routed = reg.defaults.persona;
    const ownerRow = reg.catalog.find((r) => r.modelId === routed)!;
    const alias = `${routed}-v1`;
    ownerRow.aliases = [...ownerRow.aliases, alias];
    reg.agents = { ...reg.agents, agentcore_hub_backend_dev: alias };

    const { next, added } = mergeDiscovered(reg, [...allSeedIds(reg), discovered({ modelId: alias })], {
      scanned: BOTH_PLANES,
      now: NOW,
    });
    expect(added).toEqual([]);
    expect(next.catalog.find((r) => r.modelId === routed)!.aliases).toContain(alias);
    expect(next.catalog.find((r) => r.modelId === alias)).toBeUndefined();
    const logs = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain(`discovery.skipped modelId=${alias} reason=alias_of=${routed} routing_target=true`);
  });
});

// TEAM-5073 — a routing target that is an ALIAS keeps its owner alive. The skip
// above leaves the routed alias on its owner; retiring that owner on absence
// would then resolve the agent to a retired row (`inactive`), a document every
// validator refuses. Same case names as models-reconcile.test.mjs.
describe("mergeDiscovered — a routed alias protects its owner from retirement (TEAM-5073)", () => {
  const OWNER = "us.anthropic.claude-opus-5-5";
  const ALIAS = `${OWNER}-v1`;
  const AGENT = "agentcore_hub_backend_dev";
  const NOW = new Date("2026-09-25T03:00:00.000Z");
  const fatalOf = (reg: ModelsRegistry) => fatalReadErrors(validateRegistry(reg).errors);

  /** The seed, with an agent routed through an alias of an otherwise unrouted row. */
  function routedThroughAlias(): ModelsRegistry {
    const reg = seed();
    reg.catalog.find((r) => r.modelId === OWNER)!.aliases.push(ALIAS);
    reg.agents = { ...reg.agents, [AGENT]: ALIAS };
    return reg;
  }
  const sweepWithoutOwner = (reg: ModelsRegistry) => allSeedIds(reg).filter((m) => m.modelId !== OWNER);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the precondition: nothing but the alias routes at the owner, and the document validates", () => {
    const reg = routedThroughAlias();
    const direct = [
      ...Object.values(reg.defaults),
      ...Object.values(reg.tiers.claude),
      ...Object.values(reg.tiers.codex),
      ...Object.values(reg.legacyAliases),
      ...Object.entries(reg.agents).filter(([k]) => k !== AGENT).map(([, v]) => v),
    ];
    expect(direct).not.toContain(OWNER);
    expect(fatalOf(reg)).toEqual({});
  });

  it("keeps the owner when the sweep lists the routed alias but not the owner", () => {
    const reg = routedThroughAlias();
    const { next, retired, added } = mergeDiscovered(
      reg,
      [...sweepWithoutOwner(reg), discovered({ modelId: ALIAS })],
      { scanned: BOTH_PLANES, now: NOW }
    );
    expect(added).toEqual([]);
    expect(retired).not.toContain(OWNER);
    expect(next.catalog.find((r) => r.modelId === OWNER)!.status).toBe("active");
    expect(fatalOf(next)).toEqual({});
    const logs = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain(`discovery.retire-skipped modelId=${OWNER} reason=routed_alias=${ALIAS}`);
  });

  it("keeps the owner when the sweep lists neither the owner nor the alias", () => {
    const reg = routedThroughAlias();
    const { next, retired } = mergeDiscovered(reg, sweepWithoutOwner(reg), { scanned: BOTH_PLANES, now: NOW });
    expect(retired).not.toContain(OWNER);
    expect(next.catalog.find((r) => r.modelId === OWNER)!.status).toBe("active");
    expect(fatalOf(next)).toEqual({});
  });

  it("still retires an unrouted row that vanished", () => {
    const reg = seed();
    const { retired } = mergeDiscovered(reg, sweepWithoutOwner(reg), { scanned: BOTH_PLANES, now: NOW });
    expect(retired).toEqual([OWNER]);
  });
});
