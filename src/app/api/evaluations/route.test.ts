import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

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

// An evaluations-enabled roster agent that OWNS its runtime, and a persona that
// shares it (roster: `evalHost: "agentcore_hub_agent"`).
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.configs = [{ agentId: AGENT }, { agentId: "some_agent_not_on_the_roster" }];
  h.configError = null;
  h.dailyCalls = 0;
  seedDaily();
});

afterEach(() => {
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

describe("GET /api/evaluations — hosted personas", () => {
  it("does not list a persona hosted on another runtime as an agent, even with an eval-config row and daily rows of its own", async () => {
    h.configs.push({ agentId: "agentcore_hub_requirements_analyst" });
    h.daily.push({ agentId: "agentcore_hub_requirements_analyst", day: "2026-09-15", sessions: 3 });
    const res = await get("?days=7");
    const body = await res.json();
    expect(body.agents).toEqual([AGENT_NAME]);
    expect(body.metrics["Requirements Analyst"]).toBeUndefined();
    expect(body.scorecard["Requirements Analyst"]).toBeUndefined();
  });
});
