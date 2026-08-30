import { describe, it, expect } from "vitest";
import { summarizeThroughput, median } from "./throughput";

const min = (n: number) => n * 60000;

describe("median", () => {
  it("handles empty, odd, even", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("summarizeThroughput", () => {
  it("uses SUMS for the AI/human split so minority long waits are not hidden", () => {
    // 5 runs, only 1 hits a gate — median human = 0, but the gate wait was 10h
    // of the type's 15h total. Sum-based split must show it.
    const wfs = [
      { type: "SDLC", e2eMs: min(60), humanMs: 0 },
      { type: "SDLC", e2eMs: min(60), humanMs: 0 },
      { type: "SDLC", e2eMs: min(60), humanMs: 0 },
      { type: "SDLC", e2eMs: min(60), humanMs: 0 },
      { type: "SDLC", e2eMs: min(660), humanMs: min(600) },
    ];
    const [row] = summarizeThroughput(wfs);
    expect(row.totalE2eMin).toBe(900);
    expect(row.totalHumanMin).toBe(600);
    expect(row.totalAiMin).toBe(300);
    // median e2e still reported per-run
    expect(row.e2eMin).toBe(60);
  });

  it("caps human dwell at e2e per workflow", () => {
    const [row] = summarizeThroughput([{ type: "Bug-Fix", e2eMs: min(30), humanMs: min(500) }]);
    expect(row.totalHumanMin).toBe(30);
    expect(row.totalAiMin).toBe(0);
  });

  it("drops non-positive e2e and sorts by count desc", () => {
    const rows = summarizeThroughput([
      { type: "A", e2eMs: 0, humanMs: 0 },
      { type: "A", e2eMs: min(10), humanMs: 0 },
      { type: "B", e2eMs: min(10), humanMs: 0 },
      { type: "B", e2eMs: min(20), humanMs: 0 },
    ]);
    expect(rows.map((r) => r.type)).toEqual(["B", "A"]);
    expect(rows[1].count).toBe(1);
  });

  it("clamps negative human dwell to 0", () => {
    const [row] = summarizeThroughput([{ type: "A", e2eMs: min(10), humanMs: -min(5) }]);
    expect(row.totalHumanMin).toBe(0);
    expect(row.totalAiMin).toBe(10);
  });
});
