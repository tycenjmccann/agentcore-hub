import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * TEAM-4688 — GET /api/evaluations/timeseries, the per-day trend series.
 *
 * Pins the three things the chart depends on:
 *  - the x-axis is the WINDOW, not the rows: a fixed window emits one point per
 *    UTC day ascending, zeros included, so a gap in the data reads as a gap
 *    rather than shifting the line left. `days=all` has no defined start, so it
 *    emits only the days on record (still ascending);
 *  - per-day evaluator averages come from the flat `e|<evaluator>|sum/count`
 *    attributes via the shared bucket parser, with `Builtin.` stripped, so the
 *    names match /api/evaluations' scorecard exactly;
 *  - `persona` reads the `${agentId}#${persona}` row family, never the agent's
 *    own rows (mixing the two would double-count sessions).
 */

const h = vi.hoisted(() => ({ daily: [] as Array<Record<string, unknown>>, error: null as Error | null }));

vi.mock("@/lib/eval-config", () => ({
  getAllEvalDaily: vi.fn(async () => {
    if (h.error) throw h.error;
    return h.daily;
  }),
}));

const { GET } = await import("./route");

const AGENT = "agentcore_hub_requirements_analyst";
const NOW = new Date("2026-09-15T12:00:00Z");

const get = (query: string) => GET(new NextRequest(`http://localhost/api/evaluations/timeseries${query}`));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h.error = null;
  h.daily = [
    { agentId: AGENT, day: "2026-09-15", sessions: 3, "e|Builtin.Helpfulness|sum": 2.4, "e|Builtin.Helpfulness|count": 3, "e|Builtin.Correctness|sum": 0.5, "e|Builtin.Correctness|count": 1 },
    { agentId: AGENT, day: "2026-09-13", sessions: 1, "e|Builtin.Helpfulness|sum": 0.5, "e|Builtin.Helpfulness|count": 1 },
    { agentId: AGENT, day: "2026-01-05", sessions: 9 },
    { agentId: `${AGENT}#agentcore_hub_ios_designer`, day: "2026-09-15", sessions: 2, "e|Builtin.Correctness|sum": 1.8, "e|Builtin.Correctness|count": 2 },
    { agentId: "other_agent", day: "2026-09-15", sessions: 99 },
  ];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GET /api/evaluations/timeseries", () => {
  it("emits one ascending point per day in the window, zero-filled", async () => {
    const res = await get(`?agentId=${AGENT}&days=7`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.series.map((p: { day: string }) => p.day)).toEqual([
      "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15",
    ]);
    expect(body.series.map((p: { sessions: number }) => p.sessions)).toEqual([0, 0, 0, 0, 1, 0, 3]);
    expect(body.series[6].evaluators).toEqual({
      Helpfulness: { avg: 0.8, count: 3 },
      Correctness: { avg: 0.5, count: 1 },
    });
    expect(body.series[5].evaluators).toEqual({}); // a day with no rows
    expect(body.window).toEqual({ days: 7, start: "2026-09-09", end: "2026-09-15", timezone: "UTC" });
    expect(body.windowLabel).toBe("last 7 days");
    expect(body).toMatchObject({ agentId: AGENT, persona: null });
  });

  it("days=all emits only the days on record, ascending", async () => {
    const body = await (await get(`?agentId=${AGENT}&days=all`)).json();
    expect(body.series.map((p: { day: string }) => p.day)).toEqual(["2026-01-05", "2026-09-13", "2026-09-15"]);
    expect(body.window).toEqual({ days: "all", start: "2026-01-05", end: "2026-09-15", timezone: "UTC" });
    expect(body.windowLabel).toBe("all time");
  });

  it("days=90 reaches past the old 14-day clamp", async () => {
    const body = await (await get(`?agentId=${AGENT}&days=90`)).json();
    expect(body.series).toHaveLength(90);
    expect(body.series[0].day).toBe("2026-06-18");
    expect(body.series.reduce((s: number, p: { sessions: number }) => s + p.sessions, 0)).toBe(4);
  });

  it("persona reads the persona row family only", async () => {
    const body = await (await get(`?agentId=${AGENT}&persona=agentcore_hub_ios_designer&days=7`)).json();
    expect(body.persona).toBe("agentcore_hub_ios_designer");
    expect(body.series).toHaveLength(7);
    expect(body.series[6]).toEqual({
      day: "2026-09-15",
      sessions: 2,
      evaluators: { Correctness: { avg: 0.9, count: 2 } },
    });
  });

  it("an agent (or persona) with no rows is an all-zero series, not an error", async () => {
    const body = await (await get("?agentId=nobody&days=7")).json();
    expect(body.series).toHaveLength(7);
    expect(body.series.every((p: { sessions: number }) => p.sessions === 0)).toBe(true);
    const none = await (await get(`?agentId=${AGENT}&persona=ghost&days=all`)).json();
    expect(none.series).toEqual([]);
    expect(none.window).toMatchObject({ days: "all", start: null, end: null });
  });

  it("400s without agentId and on an unknown days value; 500s when the scan fails", async () => {
    expect((await get("?days=7")).status).toBe(400);
    const bad = await get(`?agentId=${AGENT}&days=14`);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/7, 30, 90/);

    h.error = new Error("ddb blip");
    const res = await get(`?agentId=${AGENT}&days=7`);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("ddb blip");
  });
});
