import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import bundledPricing from "@/config/pricing.json";

/**
 * TEAM-4688 — GET /api/evaluations, the scorecard + metrics feed.
 *
 * The defect this pins: `days` used to be `Number(...)`-parsed and then clamped
 * to MAX_WINDOW_DAYS = 14, so `?days=30` and `?days=90` silently returned 14 days
 * of data under a "30 days"/"90 days" label — worse than an error, because it
 * looks right. The window is now a closed set (7 | 30 | 90 | all) and an unknown
 * value is a 400.
 *
 * The 2-minute module-level cache is keyed by that window STRING, so `all` and
 * `7` can no longer collide (they previously shared a numeric day-count key).
 * Because the cache is module state, every test re-imports the route
 * (vi.resetModules + dynamic import) — the idiom of api/bugs/route.test.ts.
 *
 * Seam-mocked at @/lib/eval-config (our own helper, not a raw SDK call), like
 * api/workflow/list/route.test.ts.
 */

const h = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  daily: [] as Array<Record<string, unknown>>,
  configError: null as Error | null,
  dailyCalls: 0,
  /** Body served for config/pricing.json, or null to fail the GET. */
  pricingObject: null as string | null,
}));

// TEAM-4997: prices come from the LIVE projection per request, so S3 is mocked at
// the module seam and the real loadPricingProjection runs — including its
// fallbacks, which are the reason a broken projection cannot black out the cost
// column.
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send(cmd: { constructor: { name: string } }) {
      if (cmd.constructor.name !== "GetObjectCommand") throw new Error("unexpected S3 write");
      if (h.pricingObject === null) {
        const e = new Error("no such key");
        e.name = "NoSuchKey";
        throw e;
      }
      return { Body: { transformToString: async () => h.pricingObject }, ETag: '"etag"' };
    }
  },
  GetObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
  PutObjectCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

vi.mock("@/lib/eval-config", () => ({
  getAllEvalConfigs: vi.fn(async () => {
    if (h.configError) throw h.configError;
    return h.configs;
  }),
  getAllEvalDaily: vi.fn(async () => {
    h.dailyCalls += 1;
    return h.daily;
  }),
}));

// The live roster the route derives its columns from: the hub owns the shared
// runtime, two personas ride on it, the Workflow Manager has its own harness.
const SHARED_ARN = "arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/agentcore_hub_agent-ITPP0eBToO";
vi.mock("@/lib/eval-roster", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/eval-roster")>()),
  loadEvalRoster: vi.fn(async () => [
    { agentId: "agentcore_hub_requirements_analyst", displayName: "Requirements Analyst", evaluationsEnabled: true, runtimeArn: SHARED_ARN },
    { agentId: "agentcore_hub_ios_designer", displayName: "iOS Designer", evaluationsEnabled: true, runtimeArn: SHARED_ARN },
    { agentId: "agentcore_hub_workflow_manager", displayName: "Workflow Manager", evaluationsEnabled: true, runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/harness_agentcore_hub_workflow_manager-cJ6kEr51cY" },
    { agentId: "agentcore_hub_agent", displayName: "Hub Agent (Shared Runtime)", evaluationsEnabled: true, runtimeArn: SHARED_ARN },
    { agentId: "agentcore_hub_builder", displayName: "Builder", evaluationsEnabled: false, runtimeArn: null },
  ]),
}));

// An evaluations-enabled roster agent that OWNS its runtime, and a persona that
// shares it.
const AGENT = "agentcore_hub_agent";
const AGENT_NAME = "Hub Agent (Shared Runtime)";
const PERSONA = "agentcore_hub_ios_designer";
const PERSONA_NAME = "iOS Designer";

/** "now" is pinned so the 7/30/90-day windows are exact, not relative. */
const NOW = new Date("2026-09-15T12:00:00Z");

/**
 * One row per band, with session counts that only add up if the right window was
 * used: 7d = 1, 30d = 11, 90d = 111, all = 1111.
 */
function seedDaily() {
  h.daily = [
    { agentId: AGENT, day: "2026-09-15", sessions: 1, calls: 1, "e|Builtin.Helpfulness|sum": 0.9, "e|Builtin.Helpfulness|count": 1 },
    { agentId: AGENT, day: "2026-09-01", sessions: 10 }, // inside 30d, outside 7d
    { agentId: AGENT, day: "2026-07-20", sessions: 100 }, // inside 90d, outside 30d
    { agentId: AGENT, day: "2026-01-05", sessions: 1000 }, // all-time only
    // Persona rows share the table, keyed `${agentId}#${persona}`.
    { agentId: `${AGENT}#${PERSONA}`, day: "2026-09-15", sessions: 4, calls: 6, "e|Builtin.Correctness|sum": 0.4, "e|Builtin.Correctness|count": 1 },
    { agentId: `${AGENT}#${PERSONA}`, day: "2026-01-05", sessions: 400 },
    // An agent with no eval-config row, and one not on the roster: both ignored.
    { agentId: "unknown_agent", day: "2026-09-15", sessions: 7 },
  ];
}

async function get(query = "") {
  vi.resetModules(); // the route holds a module-level cache Map
  const { GET } = await import("./route");
  return GET(new NextRequest(`http://localhost/api/evaluations${query}`));
}

const SAVED_BUCKET = process.env.ARTIFACT_BUCKET;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.configs = [{ agentId: AGENT }, { agentId: "some_agent_not_on_the_roster" }];
  h.configError = null;
  h.dailyCalls = 0;
  h.pricingObject = null;
  // Read at module load by models-registry, so it must be set before the import.
  process.env.ARTIFACT_BUCKET = "test-bucket";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  seedDaily();
});

afterEach(() => {
  if (SAVED_BUCKET === undefined) delete process.env.ARTIFACT_BUCKET;
  else process.env.ARTIFACT_BUCKET = SAVED_BUCKET;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GET /api/evaluations — window parsing", () => {
  it("days=7 is the default window: today plus the previous 6 UTC days", async () => {
    const res = await get("?days=7");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window).toEqual({ days: 7, start: "2026-09-09", end: "2026-09-15", timezone: "UTC" });
    expect(body.windowLabel).toBe("last 7 days");
    expect(body.metrics[AGENT_NAME].sessions).toBe(1);
    // No `days` param at all is the same window.
    expect((await (await get()).json()).window).toEqual(body.window);
  });

  it("days=30 really means 30 days (the old 14-day clamp truncated it)", async () => {
    const body = await (await get("?days=30")).json();
    expect(body.window).toEqual({ days: 30, start: "2026-08-17", end: "2026-09-15", timezone: "UTC" });
    expect(body.windowLabel).toBe("last 30 days");
    expect(body.metrics[AGENT_NAME].sessions).toBe(11);
  });

  it("days=90 really means 90 days", async () => {
    const body = await (await get("?days=90")).json();
    expect(body.window).toEqual({ days: 90, start: "2026-06-18", end: "2026-09-15", timezone: "UTC" });
    expect(body.windowLabel).toBe("last 90 days");
    expect(body.metrics[AGENT_NAME].sessions).toBe(111);
  });

  it("days=all unions every day present, not just the last 7", async () => {
    const body = await (await get("?days=all")).json();
    expect(body.metrics[AGENT_NAME].sessions).toBe(1111);
    expect(body.windowLabel).toBe("all time");
    // Bounds are the oldest/newest day ON RECORD — there is no fixed start.
    expect(body.window).toEqual({ days: "all", start: "2026-01-05", end: "2026-09-15", timezone: "UTC" });
  });

  it("an unknown days value is a 400, not a silently different period", async () => {
    for (const bad of ["14", "0", "-7", "365", "7.5", "week", "everything"]) {
      const res = await get(`?days=${bad}`);
      expect(res.status, bad).toBe(400);
      expect((await res.json()).error, bad).toMatch(/7, 30, 90/);
    }
  });
});

describe("GET /api/evaluations — the 2-minute cache", () => {
  it("serves a repeat request for the same window from cache", async () => {
    vi.resetModules();
    const { GET } = await import("./route");
    const req = () => GET(new NextRequest("http://localhost/api/evaluations?days=7"));
    expect((await (await req()).json()).metrics[AGENT_NAME].sessions).toBe(1);
    expect(h.dailyCalls).toBe(1);
    await req();
    expect(h.dailyCalls).toBe(1); // second read came from cache
  });

  it("does not let 'all' collide with a numeric window in the cache", async () => {
    vi.resetModules();
    const { GET } = await import("./route");
    const call = (days: string) => GET(new NextRequest(`http://localhost/api/evaluations?days=${days}`));

    expect((await (await call("7")).json()).metrics[AGENT_NAME].sessions).toBe(1);
    // Pre-4688 the key was the day COUNT, so an all-time response could be
    // served under a 7-day key (and vice versa).
    const all = await (await call("all")).json();
    expect(all.metrics[AGENT_NAME].sessions).toBe(1111);
    expect(all.windowLabel).toBe("all time");
    expect((await (await call("30")).json()).metrics[AGENT_NAME].sessions).toBe(11);
    // ...and each window is still cached independently.
    expect(h.dailyCalls).toBe(3);
    await call("all");
    expect(h.dailyCalls).toBe(3);
  });
});

describe("GET /api/evaluations — personas", () => {
  it("reports each agent's persona rows separately from the runtime totals", async () => {
    const body = await (await get("?days=7")).json();
    expect(body.personas[AGENT_NAME]).toEqual([
      {
        persona: PERSONA,
        displayName: PERSONA_NAME,
        sessions: 4,
        calls: 6,
        cost: 0,
        costPerSession: 0,
        scores: { Correctness: { avg: 0.4, count: 1, passing: 40 } },
      },
    ]);
    // Persona sessions are NOT folded into the agent's own row (no double count).
    expect(body.metrics[AGENT_NAME].sessions).toBe(1);
  });

  it("folds persona rows over the same window as the agent", async () => {
    const body = await (await get("?days=all")).json();
    expect(body.personas[AGENT_NAME][0].sessions).toBe(404);
  });

  it("names an unknown persona by its raw id and omits agents with no persona rows", async () => {
    h.daily = [
      { agentId: AGENT, day: "2026-09-15", sessions: 1 },
      { agentId: `${AGENT}#ghost_agent`, day: "2026-09-15", sessions: 2 },
    ];
    const body = await (await get("?days=7")).json();
    expect(body.personas[AGENT_NAME]).toEqual([
      { persona: "ghost_agent", displayName: "ghost_agent", sessions: 2, calls: 0, cost: 0, costPerSession: 0, scores: null },
    ]);

    h.daily = [{ agentId: AGENT, day: "2026-09-15", sessions: 1 }];
    expect((await (await get("?days=7")).json()).personas).toEqual({});
  });
});

describe("GET /api/evaluations — existing contract is unchanged", () => {
  it("keeps agents/scorecard/metrics/evaluators/lastUpdated and the roster filter", async () => {
    const body = await (await get("?days=7")).json();
    expect(body.agents).toEqual([AGENT_NAME]); // the off-roster config row is dropped
    expect(body.scorecard[AGENT_NAME]).toEqual({ Helpfulness: { avg: 0.9, count: 1, passing: 100 } });
    expect(body.evaluators).toContain("DependencyChainCompliance");
    expect(typeof body.lastUpdated).toBe("string");
    expect(body.metrics[AGENT_NAME]).toMatchObject({ sessions: 1, calls: 1, models: [] });
    expect(body.metrics[AGENT_NAME].evalScores).toBeUndefined(); // still omitted
  });

  it("strips the Builtin. prefix and reports sub-threshold averages as the raw percentage", async () => {
    h.daily = [{
      agentId: AGENT,
      day: "2026-09-15",
      sessions: 2,
      "e|Builtin.Helpfulness|sum": 1.0,
      "e|Builtin.Helpfulness|count": 2, // avg 0.5 → passing 50
      "e|custom_dependency_chain_compliance|sum": 1.4,
      "e|custom_dependency_chain_compliance|count": 2, // avg 0.7 → passing 100
    }];
    const body = await (await get("?days=7")).json();
    expect(body.scorecard[AGENT_NAME]).toEqual({
      Helpfulness: { avg: 0.5, count: 2, passing: 50 },
      DependencyChainCompliance: { avg: 0.7, count: 2, passing: 100 },
    });
  });

  it("still 500s with the error message when the config scan fails", async () => {
    h.configError = new Error("ddb blip");
    const res = await get("?days=7");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("ddb blip");
  });
});

/**
 * TEAM-4997 — the pricing projection. What matters is not which file wins but
 * that the cost column is never silently wrong: the live projection is used when
 * it is trustworthy, and the BUNDLED copy is used the moment it is not. A shape
 * gate is the difference between "no rate for this model" (billed at the default,
 * a guess) and "every rate, one deploy stale".
 */
describe("GET /api/evaluations — pricing projection", () => {
  const MODEL = "us.anthropic.claude-fable-5-1";
  /** One priced million input tokens, so the cost IS the per-1M rate in dollars. */
  function seedOneMillionTokens() {
    h.daily = [{ agentId: AGENT, day: "2026-09-15", sessions: 1, calls: 1, [`m|${MODEL}|input`]: 1_000_000 }];
  }
  const bundledRate = (bundledPricing as { models: Record<string, { input: number }> }).models[MODEL].input;

  async function cost(query = "?days=7") {
    return (await (await get(query)).json()).metrics[AGENT_NAME].cost as number;
  }

  it("prices from the LIVE projection, not the bundled file", async () => {
    seedOneMillionTokens();
    h.pricingObject = JSON.stringify({ models: { [MODEL]: { input: 99, output: 99 } }, default: { input: 1, output: 1 } });
    expect(await cost()).toBeCloseTo(99, 6);
    expect(bundledRate).not.toBe(99); // the assertion above would be vacuous otherwise
  });

  it("falls back to the bundled projection when the S3 read fails", async () => {
    seedOneMillionTokens();
    h.pricingObject = null; // NoSuchKey
    expect(await cost()).toBeCloseTo(bundledRate, 6);
  });

  it("falls back to the bundled projection when the live document's shape is wrong", async () => {
    seedOneMillionTokens();
    for (const broken of [
      // An empty models map would reprice EVERY model to the default rate.
      { models: {}, default: { input: 1, output: 1 } },
      // No usable default: nothing to fall back to for an unlisted model.
      { models: { [MODEL]: { input: 99, output: 99 } } },
      { models: { [MODEL]: { input: 99, output: 99 } }, default: { input: 0, output: 1 } },
      // Not a pricing document at all.
      [],
    ]) {
      h.pricingObject = JSON.stringify(broken);
      expect(await cost(), JSON.stringify(broken)).toBeCloseTo(bundledRate, 6);
    }
  });

  it("reports an unpriced model instead of passing its guessed cost off as a rate", async () => {
    h.daily = [{ agentId: AGENT, day: "2026-09-15", sessions: 1, "m|zz.not-in-the-catalog|input": 1_000_000 }];
    h.pricingObject = JSON.stringify({ models: { [MODEL]: { input: 11, output: 55 } }, default: { input: 5.5, output: 27.5 } });
    const metrics = (await (await get("?days=7")).json()).metrics[AGENT_NAME];
    expect(metrics.unpricedModels).toEqual(["zz.not-in-the-catalog"]);
    expect(metrics.cost).toBeCloseTo(5.5, 6); // the default rate, flagged as such

    h.daily = [{ agentId: AGENT, day: "2026-09-15", sessions: 1, [`m|${MODEL}|input`]: 1_000_000 }];
    expect((await (await get("?days=7")).json()).metrics[AGENT_NAME].unpricedModels).toEqual([]);
  });
});

describe("GET /api/evaluations — hosted personas", () => {
  it("does not list a persona sharing the hub's runtime as an agent, even with an eval-config row and daily rows of its own", async () => {
    h.configs.push({ agentId: "agentcore_hub_requirements_analyst" });
    h.daily.push({ agentId: "agentcore_hub_requirements_analyst", day: "2026-09-15", sessions: 3 });
    const res = await get("?days=7");
    const body = await res.json();
    expect(body.agents).toEqual([AGENT_NAME]);
    expect(body.metrics["Requirements Analyst"]).toBeUndefined();
    expect(body.scorecard["Requirements Analyst"]).toBeUndefined();
  });

  it("reports the derived column universe and the persona → host map", async () => {
    const body = await (await get("?days=7")).json();
    expect(body.columns).toEqual([
      { agentId: "agentcore_hub_workflow_manager", displayName: "Workflow Manager" },
      { agentId: AGENT, displayName: AGENT_NAME },
    ]);
    expect(body.hosted).toEqual({
      agentcore_hub_requirements_analyst: AGENT,
      agentcore_hub_ios_designer: AGENT,
    });
  });
});
