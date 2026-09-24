import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import seed from "@/config/models.json";
import type { ModelsRegistry } from "@/lib/models-registry";

/**
 * TEAM-4997 — the two recovery routes, tested together because they are the two
 * halves of one story: what an operator does after a save that went wrong.
 *
 *   • reapply — the save landed, its SIDE EFFECTS did not. Redo the projection
 *     and the harness push against the live document, write no new version.
 *   • rollback — the save landed and was wrong. Re-enter the save sequence with
 *     the previous document, moving the version FORWARD (history is append-only,
 *     so a rollback is itself a save that can be rolled back).
 *
 * Same S3-at-the-seam mock as ./route.test.ts; only the control plane behind
 * applyHarnessModels is faked.
 */

const h = vi.hoisted(() => ({
  state: {
    objects: {} as Record<string, string>,
    etags: {} as Record<string, string>,
    puts: [] as Array<{ Key: string; Body: string }>,
    failPut: {} as Record<string, string>,
    apply: [] as Array<{ agentId: string; current: string; status: string }>,
    applyCalls: [] as Array<readonly string[] | undefined>,
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
        const failure = h.state.failPut[key];
        if (failure) {
          const e = new Error(`injected ${failure}`);
          e.name = failure;
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

vi.mock("@/lib/models/harness-apply", () => ({
  APPLY_HARNESS_AGENT_IDS: [
    "agentcore_hub_workflow_manager",
    "agentcore_hub_builder",
    "agentcore_hub_routine_builder",
  ],
  applyHarnessModels: async (_live: unknown, _next: unknown, agentIds?: readonly string[]) => {
    h.state.applyCalls.push(agentIds);
    return h.state.apply;
  },
}));

const SEED = seed as unknown as ModelsRegistry;
const MODELS_KEY = "config/models.json";
const PREV_KEY = "config/models.prev.json";
const PRICING_KEY = "config/pricing.json";

let reapply: typeof import("./reapply/route").POST;
let rollback: typeof import("./rollback/route").POST;

async function load() {
  vi.resetModules();
  reapply = (await import("./reapply/route")).POST;
  rollback = (await import("./rollback/route")).POST;
}

function clone(reg: ModelsRegistry): ModelsRegistry {
  return JSON.parse(JSON.stringify(reg)) as ModelsRegistry;
}

function seatLive(version = 7): ModelsRegistry {
  const live = clone(SEED);
  live.version = version;
  h.state.objects[MODELS_KEY] = JSON.stringify(live);
  h.state.etags[MODELS_KEY] = '"etag-live"';
  return live;
}

/** A prev document that pins the WM to opus-5 — a real routing difference. */
function seatPrev(version = 6): ModelsRegistry {
  const prev = clone(SEED);
  prev.version = version;
  prev.agents.agentcore_hub_workflow_manager = "us.anthropic.claude-opus-5";
  h.state.objects[PREV_KEY] = JSON.stringify(prev);
  return prev;
}

function req(path: string, body: unknown): NextRequest {
  return new NextRequest(`https://hub.example.com/api/models/registry/${path}`, {
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
  h.state.failPut = {};
  h.state.apply = [];
  h.state.applyCalls.length = 0;
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

describe("POST /api/models/registry/reapply", () => {
  it("reprojects pricing and repushes the harnesses without writing a new version", async () => {
    seatLive(7);
    h.state.apply = [
      { agentId: "agentcore_hub_workflow_manager", current: "us.anthropic.claude-fable-5-1", status: "live" },
    ];

    const res = await reapply(req("reapply", { version: 7 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.registry.version).toBe(7);
    expect(body.pricing.status).toBe("projected");
    // Pricing only: the registry document is untouched.
    expect(h.state.puts.map((p) => p.Key)).toEqual([PRICING_KEY]);
    expect(h.state.applyCalls).toEqual([undefined]);
  });

  it("narrows the harness push to one agent when asked", async () => {
    seatLive(7);
    const res = await reapply(req("reapply", { version: 7, agentId: "agentcore_hub_builder" }));
    expect(res.status).toBe(200);
    expect(h.state.applyCalls).toEqual([["agentcore_hub_builder"]]);
  });

  it("409s against a version that is no longer live", async () => {
    seatLive(9);
    const res = await reapply(req("reapply", { version: 7 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "version_conflict", live: { version: 9 } });
    expect(h.state.puts).toEqual([]);
  });

  it("400s a missing version and an agent outside the apply set", async () => {
    seatLive(7);
    expect((await reapply(req("reapply", {}))).status).toBe(400);
    const res = await reapply(req("reapply", { version: 7, agentId: "personal_assistant_agent" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unknown_agent" });
    expect(h.state.puts).toEqual([]);
  });

  it("207s when the projection fails again", async () => {
    seatLive(7);
    h.state.failPut[PRICING_KEY] = "AccessDenied";
    const res = await reapply(req("reapply", { version: 7 }));
    expect(res.status).toBe(207);
    expect((await res.json()).pricing).toMatchObject({ status: "failed" });
  });

  it("refuses a non-admin", async () => {
    seatLive(7);
    process.env.AUTH_MODE = "oidc";
    expect((await reapply(req("reapply", { version: 7 }))).status).toBe(403);
  });
});

describe("POST /api/models/registry/rollback", () => {
  it("404s when there is nothing to roll back to", async () => {
    seatLive(7);
    const res = await rollback(req("rollback", { baseVersion: 7 }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no_previous" });
    expect(h.state.puts).toEqual([]);
  });

  it("restores the previous routing as a NEW version", async () => {
    seatLive(7);
    seatPrev(6);

    const res = await rollback(req("rollback", { baseVersion: 7 }));
    expect(res.status).toBe(200);
    const body = await res.json();

    // The routing is the prev document's, the version is forward, not back.
    expect(body.registry.agents.agentcore_hub_workflow_manager).toBe("us.anthropic.claude-opus-5");
    expect(body.registry.version).toBe(8);
    expect(h.state.puts.map((p) => p.Key)).toEqual([PREV_KEY, MODELS_KEY, PRICING_KEY]);
    // The new prev is what was live a moment ago, so a second rollback undoes this one.
    const newPrev = JSON.parse(h.state.puts[0].Body) as ModelsRegistry;
    expect(newPrev.version).toBe(7);
    expect(newPrev.agents.agentcore_hub_workflow_manager).toBe("us.anthropic.claude-fable-5-1");
  });

  it("restores a target nothing else routes to — the adoption gate is off for a rollback", async () => {
    seatLive(7);
    // opus-5.5 is a catalogued, active, priced row with no probe block, and no
    // other field in the live document points at it. As a SAVE this document is
    // a 422 adoption (TEAM-5008 finding 2); as a rollback it must land, or an
    // operator loses the recovery path exactly when they need it.
    const prev = clone(SEED);
    prev.version = 6;
    prev.agents.agentcore_hub_workflow_manager = "us.anthropic.claude-opus-5-5";
    h.state.objects[PREV_KEY] = JSON.stringify(prev);

    const res = await rollback(req("rollback", { baseVersion: 7 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registry.agents.agentcore_hub_workflow_manager).toBe("us.anthropic.claude-opus-5-5");
  });

  /**
   * TEAM-5016 finding 1. prev can hold a routed `candidate` (adopted through the
   * API before the server flipped status itself) whose re-probe has since
   * failed. `validateRegistry` says `unprobed`; as a rollback that must not
   * matter — a document that was once live is always restorable — so the save
   * sequence judges a rollback by the READ-time verdict and activates the row.
   */
  it("restores a prev document whose routed candidate has since failed a probe", async () => {
    seatLive(7);
    const prev = clone(SEED);
    prev.version = 6;
    prev.catalog.push({
      modelId: "us.anthropic.claude-opus-6",
      label: "Claude Opus 6",
      vendor: "anthropic",
      family: "opus",
      endpoint: "bedrock-runtime",
      region: "us-east-1",
      api: "converse",
      contextWindow: 200_000,
      aliases: [],
      price: { input: 5.5, output: 27.5, source: "interim", asOf: "2026-09-24" },
      status: "candidate",
      probe: {
        api: { ok: true, at: "2026-09-24T00:00:00Z" },
        cli: { ok: false, at: "2026-09-24T01:00:00Z", error: "turn failed" },
      },
    });
    prev.agents.agentcore_hub_workflow_manager = "us.anthropic.claude-opus-6";
    h.state.objects[PREV_KEY] = JSON.stringify(prev);

    const res = await rollback(req("rollback", { baseVersion: 7 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.registry.agents.agentcore_hub_workflow_manager).toBe("us.anthropic.claude-opus-6");
    expect(body.registry.catalog.find((r: { modelId: string }) => r.modelId === "us.anthropic.claude-opus-6").status).toBe(
      "active"
    );
    expect(h.state.puts.map((p) => p.Key)).toEqual([PREV_KEY, MODELS_KEY, PRICING_KEY]);
  });

  it("409s when the operator's page is behind the live document", async () => {
    seatLive(9);
    seatPrev(6);
    const res = await rollback(req("rollback", { baseVersion: 7 }));
    expect(res.status).toBe(409);
    expect(h.state.puts).toEqual([]);
  });

  it("refuses a non-admin and a cross-site POST", async () => {
    seatLive(7);
    seatPrev(6);
    process.env.AUTH_MODE = "oidc";
    expect((await rollback(req("rollback", { baseVersion: 7 }))).status).toBe(403);

    process.env.AUTH_MODE = "none";
    const hostile = new NextRequest("https://hub.example.com/api/models/registry/rollback", {
      method: "POST",
      headers: { "content-type": "application/json", host: "hub.example.com", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ baseVersion: 7 }),
    });
    expect((await rollback(hostile)).status).toBe(403);
    expect(h.state.puts).toEqual([]);
  });
});
