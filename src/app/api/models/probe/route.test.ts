import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import seed from "@/config/models.json";
import type { ModelsRegistry, ProbeOutcome } from "@/lib/models-registry";
import { __resetModelsCaches } from "@/lib/models-registry";
import { settleDetached } from "./detached";
import { __resetProbeWriteDeps, __setProbeWriteDeps } from "./record";
import { POST } from "./route";

/**
 * TEAM-4997 — the probe route. It accepts work and answers 202, so the tests
 * assert both halves: the immediate response, and the row the DETACHED run
 * eventually writes (awaited through the `settleDetached` seam in ./detached.ts,
 * since nothing in the response depends on it — TEAM-5016 finding 7 retired the
 * `vi.waitFor` poll and its implicit timeout).
 *
 * The three refusals are the interesting ones: an id that is not a model id
 * never reaches the catalog, an unknown model is a 404 rather than a probe of
 * nothing, and a second probe of the same model+mode is a 409 — a double-click
 * must not start two coding sessions.
 *
 * The route is imported ONCE (TEAM-5028). Reloading the whole module registry
 * per test used to race the detached runs this file exists to observe — one has
 * been seen resolving the REAL S3 client mid-reload and calling the live bucket.
 * Isolation is explicit instead: `h.state` is re-seeded, the registry cache is
 * emptied through `__resetModelsCaches`, and the route's in-flight map empties
 * itself because `afterEach` settles every detached run (each releases its claim
 * in a `finally`).
 */

const h = vi.hoisted(() => {
  // models-registry reads ARTIFACT_BUCKET at module load and this file imports
  // the route statically, so the value has to be in place before the import
  // graph is evaluated. vi.hoisted is the only code that runs that early.
  const savedBucket = process.env.ARTIFACT_BUCKET;
  process.env.ARTIFACT_BUCKET = "test-bucket";
  const state = {
    objects: {} as Record<string, string>,
    etags: {} as Record<string, string>,
    puts: [] as Array<{ Key: string; Body: string; IfMatch?: string }>,
    /** PutObjects with an IfMatch to fail with a 412 before one succeeds. */
    conditionalFailures: 0,
    apiCalls: [] as string[],
    cliCalls: [] as string[],
    /** When set, runApiProbe waits for this to be resolved. */
    gate: null as null | Promise<void>,
    /** Resolver for `gate`, so afterEach can free a run a failed test left held. */
    release: null as null | (() => void),
    outcome: { ok: true, at: "2026-09-24T12:00:00Z" } as ProbeOutcome,
  };
  return { savedBucket, state };
});

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

vi.mock("@/lib/models/probe", () => ({
  runApiProbe: async (row: { modelId: string }) => {
    h.state.apiCalls.push(row.modelId);
    if (h.state.gate) await h.state.gate;
    return h.state.outcome;
  },
  runCliProbe: async (row: { modelId: string }) => {
    h.state.cliCalls.push(row.modelId);
    if (h.state.gate) await h.state.gate;
    return h.state.outcome;
  },
}));

const SEED = seed as unknown as ModelsRegistry;
const MODELS_KEY = "config/models.json";

function seatLive(version = 5): ModelsRegistry {
  const live = JSON.parse(JSON.stringify(SEED)) as ModelsRegistry;
  live.version = version;
  h.state.objects[MODELS_KEY] = JSON.stringify(live);
  h.state.etags[MODELS_KEY] = '"etag-live"';
  return live;
}

function req(body: unknown): NextRequest {
  return new NextRequest("https://hub.example.com/api/models/probe", {
    method: "POST",
    headers: { "content-type": "application/json", host: "hub.example.com" },
    body: JSON.stringify(body),
  });
}

/** AUTH_MODE only: `isAdmin` reads it per request, so no module reload is needed. */
const SAVED = ["AUTH_MODE"] as const;
const savedEnv: Partial<Record<(typeof SAVED)[number], string | undefined>> = {};

/**
 * Hold every probe at its runApiProbe/runCliProbe call until the returned
 * function is called. The resolver is parked on `h.state` too, so a test that
 * fails while the gate is shut cannot strand a detached run (and with it the
 * route's in-flight claim) into the next test.
 */
function holdProbes(): () => void {
  let release: () => void = () => {};
  h.state.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.state.release = release;
  return release;
}

beforeEach(() => {
  h.state.objects = {};
  h.state.etags = {};
  h.state.puts.length = 0;
  h.state.conditionalFailures = 0;
  h.state.apiCalls.length = 0;
  h.state.cliCalls.length = 0;
  h.state.gate = null;
  h.state.release = null;
  h.state.outcome = { ok: true, at: "2026-09-24T12:00:00Z" };
  for (const k of SAVED) savedEnv[k] = process.env[k];
  process.env.AUTH_MODE = "none";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // The registry has a 60s TTL, so a document seated by the previous test would
  // still be cached here.
  __resetModelsCaches();
  // A lost write backs off 100-500ms before retrying; the tests don't wait.
  __setProbeWriteDeps({ sleep: async () => {} });
});

afterEach(async () => {
  // Settle BEFORE the spies are restored, or a late detached run logs to the real
  // console; release first, so a gated run can actually reach its `finally`.
  h.state.release?.();
  h.state.release = null;
  h.state.gate = null;
  await settleDetached();
  __resetProbeWriteDeps();
  for (const k of SAVED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

afterAll(() => {
  if (h.savedBucket === undefined) delete process.env.ARTIFACT_BUCKET;
  else process.env.ARTIFACT_BUCKET = h.savedBucket;
});

/** The row as it was last written to S3. */
function savedRow(modelId: string) {
  const doc = JSON.parse(h.state.objects[MODELS_KEY]) as ModelsRegistry;
  return doc.catalog.find((r) => r.modelId === modelId)!;
}

describe("POST /api/models/probe", () => {
  it("202s immediately and records the outcome on the row", async () => {
    seatLive(5);
    const res = await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      accepted: true,
      modelId: "us.anthropic.claude-opus-5",
      mode: "api",
      pollAfterMs: 15_000,
    });

    await settleDetached();
    expect(h.state.puts).toHaveLength(1);
    expect(h.state.apiCalls).toEqual(["us.anthropic.claude-opus-5"]);
    expect(savedRow("us.anthropic.claude-opus-5").probe?.api).toEqual({
      ok: true,
      at: "2026-09-24T12:00:00Z",
    });
    const doc = JSON.parse(h.state.objects[MODELS_KEY]) as ModelsRegistry;
    expect(doc.version).toBe(6);
    expect(doc.updatedBy).toBe("probe");
    // Conditional on the document the probe read, not the one the request saw.
    expect(h.state.puts[0].IfMatch).toBe('"etag-live"');
  });

  it("keeps the other mode's result when it writes its own", async () => {
    const live = seatLive(5);
    live.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5")!.probe = {
      api: { ok: true, at: "2026-01-01T00:00:00Z" },
    };
    h.state.objects[MODELS_KEY] = JSON.stringify(live);

    await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "cli" }));
    await settleDetached();
    expect(h.state.puts).toHaveLength(1);

    const probe = savedRow("us.anthropic.claude-opus-5").probe!;
    expect(probe.api?.at).toBe("2026-01-01T00:00:00Z");
    expect(probe.cli?.ok).toBe(true);
    expect(h.state.cliCalls).toEqual(["us.anthropic.claude-opus-5"]);
    expect(h.state.apiCalls).toEqual([]);
  });

  it("records a failed probe as a result, not as a dropped request", async () => {
    seatLive(5);
    h.state.outcome = { ok: false, at: "2026-09-24T12:00:00Z", error: "HTTP 400" };

    await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }));
    await settleDetached();
    expect(h.state.puts).toHaveLength(1);

    expect(savedRow("us.anthropic.claude-opus-5").probe?.api).toEqual({
      ok: false,
      at: "2026-09-24T12:00:00Z",
      error: "HTTP 400",
    });
  });

  it("retries its write when an operator save lands mid-probe", async () => {
    seatLive(5);
    h.state.conditionalFailures = 1;

    await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }));
    await settleDetached();
    expect(h.state.puts).toHaveLength(1);
    expect(savedRow("us.anthropic.claude-opus-5").probe?.api?.ok).toBe(true);
  });

  it("400s an id that is not a model id, before touching the catalog", async () => {
    seatLive(5);
    const res = await POST(req({ modelId: "us.anthropic.claude-opus-5; rm -rf /", mode: "api" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_model_id" });
    expect(h.state.apiCalls).toEqual([]);
  });

  it("400s an unknown mode", async () => {
    seatLive(5);
    const res = await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "smoke" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_mode");
  });

  it("404s a model that is not in the catalog", async () => {
    seatLive(5);
    const res = await POST(req({ modelId: "us.anthropic.claude-nonesuch-9", mode: "api" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_model" });
    expect(h.state.apiCalls).toEqual([]);
  });

  it("409s a duplicate of an in-flight probe, and frees the slot when it finishes", async () => {
    seatLive(5);
    const release = holdProbes();

    expect((await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }))).status).toBe(202);
    const dup = await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: "probe_in_flight" });
    // The OTHER mode of the same model is a different probe and is accepted.
    expect((await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "cli" }))).status).toBe(202);

    release();
    await settleDetached();
    expect(h.state.puts.length).toBeGreaterThanOrEqual(2);
    h.state.gate = null;
    expect((await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }))).status).toBe(202);
  });

  /**
   * TEAM-5008 finding 5. The coding runtime's `resolve_coding_model` answers null
   * for a retired or quarantined id and silently falls through to
   * `defaults.coding*`, and the turn result carries no model echo — so a green
   * `probe.cli` on such a row would be a green result for a DIFFERENT model, and
   * finding 2's adoption gate would then trust it.
   */
  it("409s a probe of a retired row — the runtime would substitute a default", async () => {
    seatLive(5);
    for (const mode of ["api", "cli"]) {
      const res = await POST(req({ modelId: "us.anthropic.claude-opus-4-8", mode }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "not_probeable",
        modelId: "us.anthropic.claude-opus-4-8",
        status: "retired",
      });
    }
    expect(h.state.apiCalls).toEqual([]);
    expect(h.state.cliCalls).toEqual([]);
  });

  it("409s a quarantined row, listed by status or by the quarantine array", async () => {
    const byStatus = seatLive(5);
    byStatus.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5-5")!.status = "quarantined";
    h.state.objects[MODELS_KEY] = JSON.stringify(byStatus);
    const first = await POST(req({ modelId: "us.anthropic.claude-opus-5-5", mode: "cli" }));
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ error: "not_probeable", status: "quarantined" });

    // The other spelling: the row stays `active` and the id is quarantined
    // document-wide. `resolveModel` refuses it either way, so the route must too.
    // Only the cached document is in the way — the refusal above started no run.
    __resetModelsCaches();
    const byList = seatLive(5);
    byList.quarantine = ["us.anthropic.claude-opus-5-5"];
    h.state.objects[MODELS_KEY] = JSON.stringify(byList);
    const second = await POST(req({ modelId: "us.anthropic.claude-opus-5-5", mode: "cli" }));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "not_probeable", status: "quarantined" });

    expect(h.state.cliCalls).toEqual([]);
  });

  it("still probes an active row, and a candidate awaiting its two green probes", async () => {
    const live = seatLive(5);
    // A candidate is exactly the row a probe exists for: it resolves to itself,
    // it just has no result yet.
    live.catalog.find((r) => r.modelId === "us.anthropic.claude-opus-5-5")!.status = "candidate";
    h.state.objects[MODELS_KEY] = JSON.stringify(live);

    expect((await POST(req({ modelId: "us.anthropic.claude-opus-5-5", mode: "cli" }))).status).toBe(202);
    expect((await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }))).status).toBe(202);
    await settleDetached();
    expect(h.state.puts.length).toBeGreaterThanOrEqual(2);
    expect(h.state.cliCalls).toEqual(["us.anthropic.claude-opus-5-5"]);
    expect(h.state.apiCalls).toEqual(["us.anthropic.claude-opus-5"]);
  });

  it("refuses a non-admin and a cross-site POST", async () => {
    seatLive(5);
    process.env.AUTH_MODE = "oidc";
    expect((await POST(req({ modelId: "us.anthropic.claude-opus-5", mode: "api" }))).status).toBe(403);

    process.env.AUTH_MODE = "none";
    const hostile = new NextRequest("https://hub.example.com/api/models/probe", {
      method: "POST",
      headers: { "content-type": "application/json", host: "hub.example.com", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ modelId: "us.anthropic.claude-opus-5", mode: "api" }),
    });
    expect((await POST(hostile)).status).toBe(403);
    expect(h.state.apiCalls).toEqual([]);
  });
});
