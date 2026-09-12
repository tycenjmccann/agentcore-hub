import { describe, it, expect } from "vitest";
import {
  finishedAtMs,
  startedAtMs,
  byFinishedDesc,
  byActiveThenStartedDesc,
  listRankMs,
  type RunTimes,
  type RunTimesWithPhase,
} from "@/lib/workflow/run-order";

describe("finishedAtMs precedence", () => {
  it("completedAt beats startedAt", () => {
    expect(finishedAtMs({ startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-02T00:00:00Z" }))
      .toBe(Date.parse("2026-01-02T00:00:00Z"));
  });

  it("uses cancelledAt when completedAt is absent", () => {
    expect(finishedAtMs({ startedAt: "2026-01-01T00:00:00Z", cancelledAt: "2026-01-03T00:00:00Z" }))
      .toBe(Date.parse("2026-01-03T00:00:00Z"));
  });

  it("uses erroredAt when completedAt/cancelledAt are absent", () => {
    expect(finishedAtMs({ startedAt: "2026-01-01T00:00:00Z", erroredAt: "2026-01-04T00:00:00Z" }))
      .toBe(Date.parse("2026-01-04T00:00:00Z"));
  });

  it("uses finalizedAt when completedAt/cancelledAt/erroredAt are absent", () => {
    expect(finishedAtMs({ startedAt: "2026-01-01T00:00:00Z", finalizedAt: "2026-01-05T00:00:00Z" }))
      .toBe(Date.parse("2026-01-05T00:00:00Z"));
  });

  it("falls back to startedAt when nothing else is present", () => {
    expect(finishedAtMs({ startedAt: "2026-01-01T00:00:00Z" }))
      .toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("missing everything -> 0", () => {
    expect(finishedAtMs({})).toBe(0);
  });
});

describe("degenerate inputs never produce NaN", () => {
  const rows: RunTimes[] = [
    {},
    { startedAt: "" },
    { startedAt: "not-a-date" },
    { startedAt: "2026-01-01T00:00:00Z", completedAt: "also-not-a-date" },
  ];

  it("startedAtMs/finishedAtMs are always finite", () => {
    for (const r of rows) {
      expect(Number.isFinite(startedAtMs(r))).toBe(true);
      expect(Number.isFinite(finishedAtMs(r))).toBe(true);
    }
  });

  it("finishedAtMs falls through a garbage completedAt to startedAt", () => {
    expect(finishedAtMs({ startedAt: "2026-01-01T00:00:00Z", completedAt: "also-not-a-date" }))
      .toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("byFinishedDesc is total and never returns NaN, sort preserves membership", () => {
    for (const a of rows) {
      for (const b of rows) {
        expect(Number.isFinite(byFinishedDesc(a, b))).toBe(true);
      }
    }
    const sorted = [...rows].sort(byFinishedDesc);
    expect(sorted).toHaveLength(rows.length);
    expect(sorted).toEqual(expect.arrayContaining(rows));
  });
});

describe("byFinishedDesc against the prod repro (TEAM-4504)", () => {
  // The six rows from the bug report, keyed by which finish signal they carry.
  const sessionReaper = { id: "session-reaper", startedAt: "2026-09-11T23:27:00Z", completedAt: "2026-09-12T03:06:00Z" };
  const benchD = { id: "bench-d", startedAt: "2026-09-11T06:24:00Z", completedAt: "2026-09-11T16:43:00Z" };
  const benchB = { id: "bench-b", startedAt: "2026-09-11T06:23:00Z", completedAt: "2026-09-11T17:33:00Z" };
  const reconcileSweep = { id: "reconcile-sweep", startedAt: "2026-09-11T03:01:00Z", cancelledAt: "2026-09-11T04:05:00Z" };
  const deployGateBanner = { id: "deploy-gate-banner", startedAt: "2026-09-10T22:22:00Z", cancelledAt: "2026-09-11T05:59:00Z" };
  const multiCd = { id: "multi-cd", startedAt: "2026-09-09T23:48:00Z", completedAt: "2026-09-10T21:47:00Z" };

  it("orders by finish time desc, not start time desc", () => {
    const rows = [sessionReaper, benchD, benchB, reconcileSweep, deployGateBanner, multiCd];
    const sorted = [...rows].sort(byFinishedDesc).map((r) => r.id);
    expect(sorted).toEqual([
      "session-reaper",      // 09-12T03:06
      "bench-b",             // 09-11T17:33 (finished after bench-d despite starting 1 min earlier)
      "bench-d",             // 09-11T16:43
      "deploy-gate-banner",  // 09-11T05:59 (cancelled, finished after reconcile-sweep)
      "reconcile-sweep",     // 09-11T04:05 (cancelled)
      "multi-cd",            // 09-10T21:47
    ]);
  });
});

describe("byActiveThenStartedDesc (unchanged Active behaviour)", () => {
  it("puts non-terminal rows first regardless of startedAt", () => {
    const active: RunTimesWithPhase = { phase: "dev", startedAt: "2026-01-01T00:00:00Z" };
    const terminal: RunTimesWithPhase = { phase: "complete", startedAt: "2026-01-05T00:00:00Z" };
    expect(byActiveThenStartedDesc(active, terminal)).toBeLessThan(0);
    expect(byActiveThenStartedDesc(terminal, active)).toBeGreaterThan(0);
  });

  it("orders each group by startedAt desc", () => {
    const a: RunTimesWithPhase = { phase: "dev", startedAt: "2026-01-01T00:00:00Z" };
    const b: RunTimesWithPhase = { phase: "dev", startedAt: "2026-01-02T00:00:00Z" };
    expect(byActiveThenStartedDesc(a, b)).toBeGreaterThan(0);
    expect(byActiveThenStartedDesc(b, a)).toBeLessThan(0);
  });

  it("ignores completedAt — a late completedAt does not jump the row", () => {
    const early: RunTimesWithPhase = { phase: "complete", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T01:00:00Z" };
    const late: RunTimesWithPhase = { phase: "complete", startedAt: "2026-01-02T00:00:00Z", completedAt: "2026-01-02T01:00:00Z" };
    // late started after early, so late still sorts first — completedAt plays no role.
    expect(byActiveThenStartedDesc(late, early)).toBeLessThan(0);
  });
});

describe("listRankMs (Dynamo top-50 cut)", () => {
  it("a run started 3 days ago that finished an hour ago ranks above one started yesterday and cancelled two days ago", () => {
    const now = Date.parse("2026-09-12T00:00:00Z");
    const slowButRecentlyFinished: RunTimes = {
      startedAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      completedAt: new Date(now - 60 * 60 * 1000).toISOString(),
    };
    const quickButStaleCancel: RunTimes = {
      startedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      cancelledAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
    };
    expect(listRankMs(slowButRecentlyFinished)).toBeGreaterThan(listRankMs(quickButStaleCancel));
  });

  it("slicing top 50 by listRankMs desc keeps every active row and the late-finisher", () => {
    const now = Date.parse("2026-09-12T00:00:00Z");
    const lateFinisher: RunTimes = {
      startedAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
      completedAt: new Date(now - 30 * 60 * 1000).toISOString(),
    };
    const activeRuns: RunTimes[] = Array.from({ length: 5 }, (_, i) => ({
      startedAt: new Date(now - i * 60 * 1000).toISOString(),
    }));
    const oldQuickRuns: RunTimes[] = Array.from({ length: 55 }, (_, i) => ({
      startedAt: new Date(now - (20 + i) * 24 * 60 * 60 * 1000).toISOString(),
      completedAt: new Date(now - (19 + i) * 24 * 60 * 60 * 1000).toISOString(),
    }));

    const all = [lateFinisher, ...activeRuns, ...oldQuickRuns];
    const kept = [...all].sort((a, b) => listRankMs(b) - listRankMs(a)).slice(0, 50);

    expect(kept).toContain(lateFinisher);
    for (const r of activeRuns) expect(kept).toContain(r);
  });
});
