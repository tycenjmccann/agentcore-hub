import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import seed from "@/config/models.json";
import type { CatalogRow, ModelsRegistry, ProbeOutcome } from "@/lib/models-registry";
import { __resetModelsCaches } from "@/lib/models-registry";
import { __resetHarnessDetailCache } from "./harness-detail";
import { GET, POST } from "./route";

/**
 * TEAM-4997 — the registry route. What is worth pinning here is the ORDER and the
 * partial-failure reporting, because that is what an operator's trust rests on: a
 * save either lands everywhere or says exactly how far it got.
 *
 * S3 is mocked at the module seam (same shape as
 * src/app/api/workflow/cd-registry/route.test.ts) rather than mocking
 * models-registry itself, so the real conditional-PUT and projection code runs
 * and the write ORDER is observable as `h.state.puts`. Only the two AWS surfaces
 * this route cannot fake — the control plane behind `applyHarnessModels` and the
 * harness lookups in agentcore-sdk — are replaced.
 *
 * The route is imported ONCE (TEAM-5028). Isolation between tests is explicit:
 * `h.state` is re-seeded, and the two module-level caches are emptied through
 * their own seams. Resetting the module registry per test instead used to hide a
 * real hazard — models-registry's lazy `await import("@aws-sdk/client-s3")` then
 * became module-loader work mid-handler, so under load the 5s harness bound was
 * armed only after this file had already advanced its fake clock past it.
 */

const h = vi.hoisted(() => {
  // models-registry reads ARTIFACT_BUCKET at module load and this file imports
  // the route statically, so the value has to be in place before the import
  // graph is evaluated. vi.hoisted is the only code that runs that early.
  const savedBucket = process.env.ARTIFACT_BUCKET;
  process.env.ARTIFACT_BUCKET = "test-bucket";
  return {
    savedBucket,
    state: {
      objects: {} as Record<string, string>,
      etags: {} as Record<string, string>,
      puts: [] as Array<{ Key: string; Body: string; IfMatch?: string }>,
      /** key → error name to throw on PutObject. */
      failPut: {} as Record<string, string>,
      /** Throw PreconditionFailed for a conditional PUT of the registry. */
      ifMatchFails: false,
      apply: [] as Array<{ agentId: string; current: string; status: string; error?: string }>,
      applyCalls: [] as Array<{ agentIds?: readonly string[] }>,
      /** harnessId → deployed model. */
      detail: {} as Record<string, string>,
      detailCalls: 0,
      /** Never-resolving getHarnessDetail, to prove the GET is bounded. */
      hang: false,
    },
  };
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      const key = cmd.input.Key as string;
      if (name === "GetObjectCommand") {
        const body = h.state.objects[key];
        if (body === undefined) {
          const e = new Error("The specified key does not exist.");
          e.name = "NoSuchKey";
          throw e;
        }
        return { Body: { transformToString: async () => body }, ETag: h.state.etags[key] };
      }
      if (name === "PutObjectCommand") {
        const failure = h.state.failPut[key];
        if (failure) {
          const e = new Error(`injected ${failure}`);
          e.name = failure;
          throw e;
        }
        if (h.state.ifMatchFails && cmd.input.IfMatch) {
          const e = new Error("precondition failed");
          e.name = "PreconditionFailed";
          throw e;
        }
        const body = cmd.input.Body as string;
        h.state.puts.push({ Key: key, Body: body, IfMatch: cmd.input.IfMatch as string | undefined });
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

vi.mock("@/lib/models/harness-apply", () => ({
  APPLY_HARNESS_AGENT_IDS: [
    "agentcore_hub_workflow_manager",
    "agentcore_hub_builder",
    "agentcore_hub_routine_builder",
  ],
  applyHarnessModels: vi.fn(async (_live: unknown, _next: unknown, agentIds?: readonly string[]) => {
    h.state.applyCalls.push({ agentIds });
    return h.state.apply;
  }),
}));

vi.mock("@/lib/agentcore-sdk", () => ({
  DEFAULT_REGION: "us-east-1",
  discoverAgents: async () => [
    { id: "h-wm", name: "agentcore_hub_workflow_manager", type: "harness" },
    { id: "h-builder", name: "agentcore_hub_builder", type: "harness" },
    { id: "h-routine", name: "agentcore_hub_routine_builder", type: "harness" },
    { id: "h-pa", name: "personal_assistant_agent", type: "harness" },
  ],
  getHarnessDetail: async (harnessId: string) => {
    h.state.detailCalls++;
    if (h.state.hang) return new Promise(() => {});
    return { model: h.state.detail[harnessId] };
  },
}));

const SEED = seed as unknown as ModelsRegistry;
const MODELS_KEY = "config/models.json";
const PREV_KEY = "config/models.prev.json";
const PRICING_KEY = "config/pricing.json";

function clone(reg: ModelsRegistry): ModelsRegistry {
  return JSON.parse(JSON.stringify(reg)) as ModelsRegistry;
}

/** Seat a live document at `version` and return the copy the test may edit. */
function seatLive(version = 7): ModelsRegistry {
  const live = clone(SEED);
  live.version = version;
  h.state.objects[MODELS_KEY] = JSON.stringify(live);
  h.state.etags[MODELS_KEY] = '"etag-live"';
  return live;
}

const GREEN: ProbeOutcome = { ok: true, at: "2026-09-20T00:00:00.000Z", seconds: 3 };

/**
 * A brand-new, priced, catalogued model, and `tiers.codex.luna` re-pointed at it
 * — the shape of every adoption an operator can make from the console.
 */
function adoptNewModel(
  candidate: ModelsRegistry,
  probe?: CatalogRow["probe"],
  status: CatalogRow["status"] = "active"
): void {
  candidate.catalog.push({
    modelId: "us.openai.gpt-6-nova",
    label: "GPT-6 Nova",
    vendor: "openai",
    family: "gpt-6",
    endpoint: "bedrock-runtime",
    region: "us-east-1",
    api: "converse",
    contextWindow: 400_000,
    aliases: [],
    price: { input: 2, output: 8, source: "interim", asOf: "2026-09-20" },
    status,
    ...(probe ? { probe } : {}),
  });
  candidate.tiers.codex.luna = "us.openai.gpt-6-nova";
}

function getReq(query = ""): NextRequest {
  return new NextRequest(`https://hub.example.com/api/models/registry${query}`);
}

function postReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://hub.example.com/api/models/registry", {
    method: "POST",
    headers: { "content-type": "application/json", host: "hub.example.com", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** AUTH_MODE only: `isAdmin` reads it per request, so no module reload is needed. */
const SAVED = ["AUTH_MODE"] as const;
const savedEnv: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

beforeEach(() => {
  h.state.objects = {};
  h.state.etags = {};
  h.state.puts.length = 0;
  h.state.failPut = {};
  h.state.ifMatchFails = false;
  h.state.apply = [];
  h.state.applyCalls.length = 0;
  h.state.detail = {};
  h.state.detailCalls = 0;
  h.state.hang = false;
  for (const k of SAVED) savedEnv[k] = process.env[k];
  process.env.AUTH_MODE = "none";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // The two module-level caches the route reads through, emptied by their own
  // seams rather than by reloading the modules that hold them.
  __resetModelsCaches();
  __resetHarnessDetailCache();
});

afterEach(() => {
  for (const k of SAVED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (h.savedBucket === undefined) delete process.env.ARTIFACT_BUCKET;
  else process.env.ARTIFACT_BUCKET = h.savedBucket;
});

describe("GET /api/models/registry", () => {
  it("returns the document, the resolved chain per agent, and the live harness model", async () => {
    seatLive(7);
    h.state.detail["h-wm"] = "us.anthropic.claude-opus-5";

    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.registry.version).toBe(7);
    // Every deployable agent is present, pinned or not.
    expect(body.resolved.agentcore_hub_workflow_manager).toMatchObject({
      modelId: "us.anthropic.claude-fable-5-1",
      source: "agents",
      via: "catalog",
      // The registry says fable-5.1, the harness runs opus-5 — visible, not hidden.
      harnessModel: "us.anthropic.claude-opus-5",
    });
    expect(body.resolved.telegram_intake).toMatchObject({
      modelId: "us.anthropic.claude-sonnet-5",
      source: "agents",
    });
    expect(body.resolved.agentcore_hub_qa_verifier).toMatchObject({ source: "defaults" });
    // A non-harness agent has nothing deployed to compare against.
    expect(body.resolved.agentcore_hub_qa_verifier.harnessModel).toBeUndefined();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("GET reports source seed with the fallback reason when the live doc is refused", async () => {
    // TEAM-5052: what the pre-fix reconcile wrote — a candidate row whose id the
    // retired opus-4-6 row still claims as an alias. The read gate refuses it.
    const live = seatLive(2);
    const { harnessLanes: _lanes, ...owner } = live.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-4-6")!;
    live.catalog.push({ ...owner, modelId: "us.anthropic.claude-opus-4-6-v1", aliases: [], status: "candidate" });
    h.state.objects[MODELS_KEY] = JSON.stringify(live);

    const body = await (await GET(getReq("?fresh=1"))).json();
    expect(body.source).toBe("seed");
    expect(body.registry.version).toBe(1);
    expect(body.fallback).toMatchObject({ reason: "invalid", refusedVersion: 2 });
    expect(body.fallback.detail).toContain("duplicate_alias");

    // The live document again: no fallback on the wire.
    seatLive(7);
    const ok = await (await GET(getReq("?fresh=1"))).json();
    expect(ok).toMatchObject({ source: "s3", fallback: null });
  });

  it("reports whether a rollback target exists without shipping it, unless asked", async () => {
    seatLive(7);
    const prev = clone(SEED);
    prev.version = 6;
    prev.updatedBy = "someone";
    h.state.objects[PREV_KEY] = JSON.stringify(prev);

    const plain = await (await GET(getReq())).json();
    expect(plain.previous).toEqual({ version: 6, updatedAt: prev.updatedAt, updatedBy: "someone" });
    expect(plain.previousRegistry).toBeUndefined();

    const full = await (await GET(getReq("?withPrevious=1"))).json();
    expect(full.previousRegistry.version).toBe(6);
  });

  it("flags an interim price older than 14 days", async () => {
    const live = seatLive(7);
    live.catalog.find((r) => r.modelId === "us.openai.gpt-6-sol")!.price = {
      input: 1,
      output: 2,
      source: "interim",
      asOf: "2000-01-01",
    };
    live.catalog.find((r) => r.modelId === "us.openai.gpt-6-luna")!.price = {
      input: 1,
      output: 2,
      source: "interim",
      asOf: new Date().toISOString().slice(0, 10),
    };
    h.state.objects[MODELS_KEY] = JSON.stringify(live);

    const body = await (await GET(getReq("?fresh"))).json();
    expect(body.interimOverdue).toEqual(["us.openai.gpt-6-sol"]);
  });

  it("stays fast when a harness lookup hangs: 200, and that agent simply has no harnessModel", async () => {
    seatLive(7);
    h.state.hang = true;
    vi.useFakeTimers();

    const pending = GET(getReq());
    // Everything ahead of the 5s bound is microtask-only, so flushing once is
    // enough to arm it — and asserting that it IS armed before the clock moves is
    // the regression itself (TEAM-5028): a lazy import anywhere in that preamble
    // makes this read 0 instead of hanging the test for its whole timeout.
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    // One jump, not a loop of slices: the bound exists before time passes.
    await vi.advanceTimersByTimeAsync(5_001);
    const res = await pending;

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolved.agentcore_hub_workflow_manager.modelId).toBe("us.anthropic.claude-fable-5-1");
    expect(body.resolved.agentcore_hub_workflow_manager.harnessModel).toBeUndefined();
  });

  it("caches a harness model for 60s, so a page that polls does not re-hit the control plane", async () => {
    seatLive(7);
    for (const id of ["h-wm", "h-builder", "h-routine", "h-pa"]) {
      h.state.detail[id] = "us.anthropic.claude-fable-5-1";
    }

    await GET(getReq());
    const first = h.state.detailCalls;
    expect(first).toBe(4);
    await GET(getReq());
    expect(h.state.detailCalls).toBe(first);
  });

  it("does not cache a MISS, so a transient control-plane failure self-heals on the next poll", async () => {
    seatLive(7);
    h.state.detail["h-wm"] = "us.anthropic.claude-fable-5-1";

    await GET(getReq());
    expect(h.state.detailCalls).toBe(4);
    await GET(getReq());
    // Only the one agent that answered is served from cache; the other three retry.
    expect(h.state.detailCalls).toBe(7);
  });
});

describe("POST /api/models/registry", () => {
  it("refuses a non-admin before reading anything", async () => {
    process.env.AUTH_MODE = "oidc";
    seatLive(7);
    const res = await POST(postReq({ baseVersion: 7, registry: SEED }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(h.state.puts).toEqual([]);
  });

  it("refuses a cross-site POST", async () => {
    seatLive(7);
    const res = await POST(postReq({ baseVersion: 7, registry: SEED }, { "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross_origin" });
    expect(h.state.puts).toEqual([]);
  });

  it("400s a body that is not JSON, and one missing baseVersion", async () => {
    seatLive(7);
    expect((await POST(postReq("{nope"))).status).toBe(400);
    expect((await POST(postReq({ registry: SEED }))).status).toBe(400);
    expect((await POST(postReq({ baseVersion: 7 }))).status).toBe(400);
  });

  it("422s with every bad field at once, naming the model by path", async () => {
    seatLive(7);
    const candidate = clone(SEED);
    delete candidate.catalog.find((r) => r.modelId === "us.openai.gpt-6-luna")!.price;

    const res = await POST(postReq({ baseVersion: 7, registry: candidate }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("invalid_registry");
    expect(body.fields["tiers.codex.luna"]).toBe("unpriced");
    expect(h.state.puts).toEqual([]);
  });

  it("409s on a stale baseVersion and reports what is live", async () => {
    seatLive(9);
    const res = await POST(postReq({ baseVersion: 7, registry: SEED }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "version_conflict", live: { version: 9 } });
    expect(h.state.puts).toEqual([]);
  });

  it("writes prev, then the registry, then pricing — in that order — and bumps the version", async () => {
    seatLive(7);
    h.state.apply = [
      { agentId: "agentcore_hub_workflow_manager", current: "us.anthropic.claude-opus-5", status: "applying" },
    ];
    const candidate = clone(SEED);
    candidate.agents.agentcore_hub_workflow_manager = "us.anthropic.claude-opus-5";

    const res = await POST(
      postReq(
        { baseVersion: 7, registry: candidate },
        // The three headers middleware stamps; the email is what the audit needs.
        {
          "x-agentcore-user": "op",
          "x-agentcore-tenant": "default",
          "x-agentcore-email": "op@example.com",
        }
      )
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.registry.version).toBe(8);
    expect(body.registry.updatedBy).toBe("op@example.com");
    expect(body.pricing.status).toBe("projected");
    expect(h.state.puts.map((p) => p.Key)).toEqual([PREV_KEY, MODELS_KEY, PRICING_KEY]);
    // The prev object is the document that WAS live, not the new one.
    expect(JSON.parse(h.state.puts[0].Body).version).toBe(7);
    // The registry PUT is conditional on the ETag we read.
    expect(h.state.puts[1].IfMatch).toBe('"etag-live"');
    const audit = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(audit).toContain("registry.saved email=op@example.com base=7 version=8");
    expect(audit).toContain("agents.agentcore_hub_workflow_manager");
  });

  it("does not write prev when nothing about routing changed", async () => {
    seatLive(7);
    const candidate = clone(SEED);
    candidate.catalog[0].label = "Claude Fable 5.1 (relabelled)";

    const res = await POST(postReq({ baseVersion: 7, registry: candidate }));
    expect(res.status).toBe(200);
    expect(h.state.puts.map((p) => p.Key)).toEqual([MODELS_KEY, PRICING_KEY]);
  });

  it("503s and writes nothing else when the prev write fails", async () => {
    seatLive(7);
    h.state.failPut[PREV_KEY] = "AccessDenied";
    const candidate = clone(SEED);
    candidate.defaults.persona = "us.anthropic.claude-opus-5";

    const res = await POST(postReq({ baseVersion: 7, registry: candidate }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "prev_write_failed" });
    expect(h.state.puts).toEqual([]);
  });

  it("409s when the conditional registry PUT loses the race", async () => {
    seatLive(7);
    h.state.ifMatchFails = true;
    const res = await POST(postReq({ baseVersion: 7, registry: SEED }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "version_conflict" });
  });

  it("207s when the registry landed but the pricing projection did not", async () => {
    seatLive(7);
    h.state.failPut[PRICING_KEY] = "AccessDenied";

    const res = await POST(postReq({ baseVersion: 7, registry: SEED }));
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.pricing).toMatchObject({ status: "failed" });
    // The registry write is real and reported as such.
    expect(body.registry.version).toBe(8);
    expect(JSON.parse(h.state.objects[MODELS_KEY]).version).toBe(8);
  });

  it("207s when a harness update fails, and the version still moved", async () => {
    seatLive(7);
    h.state.apply = [
      { agentId: "agentcore_hub_workflow_manager", current: "x", status: "live" },
      { agentId: "agentcore_hub_routine_builder", current: "x", status: "live" },
      { agentId: "agentcore_hub_builder", current: "x", status: "failed", error: "no harness" },
    ];

    const res = await POST(postReq({ baseVersion: 7, registry: SEED }));
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.registry.version).toBe(8);
    expect(body.agents).toHaveLength(3);
  });

  it("422s a model promoted to a routing target before it was probed, naming the field", async () => {
    seatLive(7);
    const candidate = clone(SEED);
    adoptNewModel(candidate);

    const res = await POST(postReq({ baseVersion: 7, registry: candidate }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("invalid_registry");
    expect(body.fields).toEqual({ "tiers.codex.luna": "unprobed" });
    expect(h.state.puts).toEqual([]);
  });

  it("422s a target with only one green probe — half-proven is not proven", async () => {
    seatLive(7);
    const candidate = clone(SEED);
    adoptNewModel(candidate, { api: GREEN });

    const res = await POST(postReq({ baseVersion: 7, registry: candidate }));
    expect(res.status).toBe(422);
    expect((await res.json()).fields["tiers.codex.luna"]).toBe("unprobed");
    expect(h.state.puts).toEqual([]);
  });

  it("accepts a new target once both probe planes are green", async () => {
    seatLive(7);
    const candidate = clone(SEED);
    adoptNewModel(candidate, { api: GREEN, cli: GREEN });

    const res = await POST(postReq({ baseVersion: 7, registry: candidate }));
    expect(res.status).toBe(200);
    expect((await res.json()).registry.tiers.codex.luna).toBe("us.openai.gpt-6-nova");
  });

  /**
   * TEAM-5016 finding 1. The console flips a row to `active` client-side when the
   * operator adopts it; an API caller can leave it `candidate`. A routed candidate
   * that later failed a re-probe then read as `unprobed` — a FAILED read on every
   * hub task. Adoption is the transition, so the server owns it.
   */
  it("flips a newly adopted candidate to active, so a later failed probe cannot make the document unreadable", async () => {
    seatLive(7);
    const candidate = clone(SEED);
    adoptNewModel(candidate, { api: GREEN, cli: GREEN }, "candidate");

    const res = await POST(postReq({ baseVersion: 7, registry: candidate }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registry.catalog.find((r: CatalogRow) => r.modelId === "us.openai.gpt-6-nova").status).toBe("active");
    const saved = JSON.parse(h.state.puts.find((p) => p.Key === MODELS_KEY)!.Body) as ModelsRegistry;
    expect(saved.catalog.find((r) => r.modelId === "us.openai.gpt-6-nova")!.status).toBe("active");
    // Both probe results stay on the row for the /models page.
    expect(saved.catalog.find((r) => r.modelId === "us.openai.gpt-6-nova")!.probe).toEqual({ api: GREEN, cli: GREEN });
  });

  it("accepts the probe-less seed — a model that is ALREADY routed to is grandfathered", async () => {
    seatLive(7);
    const candidate = clone(SEED);
    // Same model, spelled as one of the row's aliases: re-spelling is not adoption.
    candidate.agents.agentcore_hub_workflow_manager = "claude-opus-5";

    const res = await POST(postReq({ baseVersion: 7, registry: candidate }));
    expect(res.status).toBe(200);
    expect(h.state.puts.map((p) => p.Key)).toEqual([PREV_KEY, MODELS_KEY, PRICING_KEY]);
  });

  it("ignores harnessLanes and readOnly in the body — both are seed-owned", async () => {
    seatLive(7);
    const candidate = clone(SEED);
    const fable = candidate.catalog.find((r) => r.modelId === "us.anthropic.claude-fable-5-1")!;
    fable.harnessLanes = [{ id: "attacker-lane", apiFormat: "responses" }];
    const native = candidate.catalog.find((r) => r.modelId === "anthropic.claude-opus-5")!;
    delete native.readOnly;

    const res = await POST(postReq({ baseVersion: 7, registry: candidate }));
    expect(res.status).toBe(200);
    const saved = JSON.parse(h.state.objects[MODELS_KEY]) as ModelsRegistry;
    const savedFable = saved.catalog.find((r) => r.modelId === "us.anthropic.claude-fable-5-1")!;
    expect(savedFable.harnessLanes?.map((l) => l.id)).toEqual(["claude-fable-5-1"]);
    expect(saved.catalog.find((r) => r.modelId === "anthropic.claude-opus-5")!.readOnly).toBe(true);
  });
});
