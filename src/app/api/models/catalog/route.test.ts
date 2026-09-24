import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import seed from "@/config/models.json";
import type { ModelsRegistry } from "@/lib/models-registry";
import type { DiscoveredModel } from "@/lib/models/discovery";

/**
 * TEAM-4997 — the catalog route. Two properties matter more than the response
 * shape:
 *   1. a refresh cannot change ROUTING. It adds candidates and retires what
 *      vanished; `defaults`/`tiers`/`agents` come out byte-identical.
 *   2. an outage is not an empty account. If every source failed, merging the
 *      empty result would retire the whole catalog, so the route 502s and leaves
 *      the document alone.
 *
 * `mergeDiscovered` and `refreshPrices` run for real — they are the logic under
 * test. Only the network underneath them is stubbed: `discoverModels` directly,
 * and the Price List through `signedFetch`.
 */

const h = vi.hoisted(() => ({
  state: {
    objects: {} as Record<string, string>,
    etags: {} as Record<string, string>,
    puts: [] as Array<{ Key: string; Body: string }>,
    discovered: { models: [] as DiscoveredModel[], errors: [] as string[] } as {
      models: DiscoveredModel[];
      errors: string[];
      /** Omitted = both planes answered, which is what most tests want. */
      scanned?: Set<string>;
      skippedEndpoints?: string[];
    },
    /** Number of PutObjects to fail with a 412 before letting one through. */
    conditionalFailures: 0,
  },
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      const key = cmd.input.Key as string;
      if (name === "GetObjectCommand") {
        const body = h.state.objects[key];
        if (body === undefined) {
          const e = new Error("no such key");
          e.name = "NoSuchKey";
          throw e;
        }
        return { Body: { transformToString: async () => body }, ETag: h.state.etags[key] };
      }
      if (name === "PutObjectCommand") {
        if (cmd.input.IfMatch && h.state.conditionalFailures > 0) {
          h.state.conditionalFailures--;
          const e = new Error("precondition failed");
          e.name = "PreconditionFailed";
          throw e;
        }
        const body = cmd.input.Body as string;
        h.state.puts.push({ Key: key, Body: body });
        h.state.objects[key] = body;
        h.state.etags[key] = `"etag-${h.state.puts.length}"`;
        return { ETag: h.state.etags[key] };
      }
      throw new Error(`unexpected S3 command ${name}`);
    }
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  PutObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

vi.mock("@/lib/models/discovery", async (importOriginal) => ({
  // mergeDiscovered is the logic under test and stays real.
  ...(await importOriginal<typeof import("@/lib/models/discovery")>()),
  discoverModels: async () => ({
    scanned: new Set(["bedrock-runtime", "bedrock-mantle"]),
    skippedEndpoints: [],
    ...h.state.discovered,
  }),
}));

// refreshPrices is real; this is the Price List it reads. An empty PriceList
// means "no published rate", which is the honest answer for a brand-new id.
vi.mock("@/lib/models/sigv4", () => ({
  signedFetch: async () =>
    new Response(JSON.stringify({ PriceList: [] }), { headers: { "content-type": "application/json" } }),
  mintBedrockBearerToken: async () => "bedrock-api-key-test",
}));

const SEED = seed as unknown as ModelsRegistry;
const MODELS_KEY = "config/models.json";
const PRICING_KEY = "config/pricing.json";

let GET: typeof import("./route").GET;
let POST: typeof import("./route").POST;

async function load() {
  vi.resetModules();
  ({ GET, POST } = await import("./route"));
}

function clone(reg: ModelsRegistry): ModelsRegistry {
  return JSON.parse(JSON.stringify(reg)) as ModelsRegistry;
}

function seatLive(version = 3): ModelsRegistry {
  const live = clone(SEED);
  live.version = version;
  h.state.objects[MODELS_KEY] = JSON.stringify(live);
  h.state.etags[MODELS_KEY] = '"etag-live"';
  return live;
}

/** Everything the seed routes to, so a sweep only moves what the test moves. */
function sweepOf(reg: ModelsRegistry, omit: string[] = []): DiscoveredModel[] {
  return reg.catalog
    .filter((r) => r.status === "active" && !r.readOnly && !omit.includes(r.modelId))
    .map((r) => ({
      modelId: r.modelId,
      label: r.label,
      vendor: r.vendor,
      family: r.family,
      endpoint: r.endpoint,
      region: r.region,
      api: r.api,
      contextWindow: r.contextWindow,
    }));
}

function getReq(query = ""): NextRequest {
  return new NextRequest(`https://hub.example.com/api/models/catalog${query}`);
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("https://hub.example.com/api/models/catalog", {
    method: "POST",
    headers: { "content-type": "application/json", host: "hub.example.com" },
    body: JSON.stringify(body),
  });
}

const SAVED = ["ARTIFACT_BUCKET", "AUTH_MODE"] as const;
const savedEnv: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

beforeEach(async () => {
  h.state.objects = {};
  h.state.etags = {};
  h.state.puts.length = 0;
  h.state.discovered = { models: [], errors: [] };
  h.state.conditionalFailures = 0;
  for (const k of SAVED) savedEnv[k] = process.env[k];
  process.env.ARTIFACT_BUCKET = "test-bucket";
  process.env.AUTH_MODE = "none";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await load();
});

afterEach(() => {
  for (const k of SAVED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

describe("GET /api/models/catalog", () => {
  it("returns the catalog and its version", async () => {
    seatLive(3);
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(3);
    expect(body.catalog).toHaveLength(SEED.catalog.length);
  });

  it("405s ?refresh=1 — a refresh writes, and a GET must not", async () => {
    seatLive(3);
    const res = await GET(getReq("?refresh=1"));
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "use_post" });
    expect(h.state.puts).toEqual([]);
  });
});

describe("POST /api/models/catalog", () => {
  it("adds an unseen id as an unpriced candidate and leaves routing untouched", async () => {
    const live = seatLive(3);
    h.state.discovered = {
      models: [
        ...sweepOf(live),
        {
          modelId: "us.anthropic.claude-opus-6",
          label: "Claude Opus 6",
          vendor: "anthropic",
          family: "opus",
          endpoint: "bedrock-runtime",
          region: "us-east-1",
          api: "converse",
        },
      ],
      errors: [],
    };

    const res = await POST(postReq({ refresh: true }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.discovered.added).toEqual(["us.anthropic.claude-opus-6"]);
    expect(body.version).toBe(4);
    const saved = JSON.parse(h.state.objects[MODELS_KEY]) as ModelsRegistry;
    expect(saved.updatedBy).toBe("discovery");
    const added = saved.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-6")!;
    expect(added.status).toBe("candidate");
    // No published rate and no older opus row of its own family to inherit from
    // that the Price List confirmed — an unproven model is left unpriced.
    expect(added.price?.source ?? "unpriced").not.toBe("published");
    // The whole routing block is byte-identical.
    expect(saved.defaults).toEqual(SEED.defaults);
    expect(saved.tiers).toEqual(SEED.tiers);
    expect(saved.agents).toEqual(SEED.agents);
    expect(saved.quarantine).toEqual(SEED.quarantine);
  });

  it("retires a row that vanished from the sweep, but never a routing target", async () => {
    const live = seatLive(3);
    // opus-5-5 is active and nothing routes to it; sonnet-5 is a tier target.
    h.state.discovered = {
      models: sweepOf(live, ["us.anthropic.claude-opus-5-5", "us.anthropic.claude-sonnet-5"]),
      errors: [],
    };

    const body = await (await POST(postReq({ refresh: true }))).json();
    expect(body.discovered.retired).toContain("us.anthropic.claude-opus-5-5");
    expect(body.discovered.retired).not.toContain("us.anthropic.claude-sonnet-5");

    const saved = JSON.parse(h.state.objects[MODELS_KEY]) as ModelsRegistry;
    expect(saved.catalog.find((r) => r.modelId === "us.anthropic.claude-sonnet-5")!.status).toBe("active");
    expect(saved.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5-5")!.retiredAt).toBeTruthy();
  });

  it("reprojects pricing after a successful merge", async () => {
    const live = seatLive(3);
    h.state.discovered = { models: sweepOf(live), errors: [] };
    const res = await POST(postReq({ refresh: true }));
    expect(res.status).toBe(200);
    expect(h.state.puts.map((p) => p.Key)).toEqual([MODELS_KEY, PRICING_KEY]);
    expect((await res.json()).pricing.status).toBe("projected");
  });

  it("502s and leaves the catalog untouched when every discovery source failed", async () => {
    seatLive(3);
    h.state.discovered = { models: [], errors: ["profiles:us-east-1: HTTP 403", "mantle:us-east-2: HTTP 500"] };

    const res = await POST(postReq({ refresh: true }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "discovery_failed" });
    expect(h.state.puts).toEqual([]);
    expect(JSON.parse(h.state.objects[MODELS_KEY]).version).toBe(3);
  });

  it("does not retire an inference profile when that listing failed", async () => {
    const live = seatLive(3);
    // Mantle answered, the profile plane did not: every `us.*`/`global.*` row is
    // absent from the sweep for a reason that says nothing about the model
    // (TEAM-5008 finding 4). The old merge retired them all.
    h.state.discovered = {
      models: sweepOf(live).filter((m) => m.endpoint === "bedrock-mantle"),
      errors: ["profiles:us-east-1: inference-profiles us-east-1 HTTP 403"],
      scanned: new Set(["bedrock-mantle"]),
      skippedEndpoints: ["bedrock-runtime"],
    };

    const res = await POST(postReq({ refresh: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.discovered.retired).toEqual([]);
    const saved = JSON.parse(h.state.objects[MODELS_KEY]) as ModelsRegistry;
    for (const id of ["us.anthropic.claude-opus-5-5", "global.anthropic.claude-opus-5"]) {
      expect(saved.catalog.find((r) => r.modelId === id)!.status).toBe("active");
    }
  });

  it("reports which planes it scanned and which it skipped", async () => {
    const live = seatLive(3);
    h.state.discovered = {
      models: sweepOf(live).filter((m) => m.endpoint === "bedrock-mantle"),
      errors: ["profiles:us-east-1: HTTP 403"],
      scanned: new Set(["bedrock-mantle"]),
      skippedEndpoints: ["bedrock-runtime"],
    };

    const body = await (await POST(postReq({ refresh: true }))).json();
    expect(body.discovered.scanned).toEqual(["bedrock-mantle"]);
    expect(body.discovered.skippedEndpoints).toEqual(["bedrock-runtime"]);
    expect(body.discovered.errors).toContain("profiles:us-east-1: HTTP 403");
  });

  it("retries a lost conditional write exactly once, then 409s", async () => {
    const live = seatLive(3);
    h.state.discovered = { models: sweepOf(live), errors: [] };

    h.state.conditionalFailures = 1;
    expect((await POST(postReq({ refresh: true }))).status).toBe(200);

    h.state.conditionalFailures = 2;
    const res = await POST(postReq({ refresh: true }));
    expect(res.status).toBe(409);
  });

  it("refuses a non-admin and a body that is not a refresh", async () => {
    seatLive(3);
    process.env.AUTH_MODE = "oidc";
    expect((await POST(postReq({ refresh: true }))).status).toBe(403);
    process.env.AUTH_MODE = "none";
    expect((await POST(postReq({ refresh: false }))).status).toBe(400);
    expect(h.state.puts).toEqual([]);
  });
});
