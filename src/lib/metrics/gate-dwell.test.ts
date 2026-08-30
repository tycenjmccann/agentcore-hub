import { describe, it, expect } from "vitest";
import {
  extractStatusTransitions,
  statusIntervals,
  unionMs,
  humanWaitIntervals,
  humanWaitMs,
} from "./gate-dwell";

const T0 = Date.parse("2026-08-29T00:00:00Z");
const min = (n: number) => n * 60000;

function changelog(entries: Array<[offsetMin: number, from: string, to: string]>) {
  return {
    histories: entries.map(([off, from, to]) => ({
      created: new Date(T0 + min(off)).toISOString(),
      items: [{ field: "status", fromString: from, toString: to }],
    })),
  };
}

describe("extractStatusTransitions", () => {
  it("flattens and sorts status items, ignoring other fields", () => {
    const log = {
      histories: [
        {
          created: new Date(T0 + min(10)).toISOString(),
          items: [
            { field: "labels", fromString: "", toString: "x" },
            { field: "status", fromString: "Ready", toString: "In Review" },
          ],
        },
        {
          created: new Date(T0).toISOString(),
          items: [{ field: "status", fromString: "To Do", toString: "Ready" }],
        },
      ],
    };
    const ts = extractStatusTransitions(log);
    expect(ts).toHaveLength(2);
    expect(ts[0].to).toBe("Ready");
    expect(ts[1].to).toBe("In Review");
  });

  it("handles empty/missing changelog", () => {
    expect(extractStatusTransitions(undefined)).toEqual([]);
    expect(extractStatusTransitions({})).toEqual([]);
  });
});

describe("statusIntervals", () => {
  it("captures closed intervals with exit status", () => {
    const log = changelog([
      [0, "To Do", "In Review"],
      [10, "In Review", "In Progress"],
      [40, "In Progress", "In Review"],
      [55, "In Review", "Done"],
    ]);
    expect(statusIntervals(extractStatusTransitions(log), "In Review", T0 + min(60))).toEqual([
      { start: T0, end: T0 + min(10), exitTo: "In Progress" },
      { start: T0 + min(40), end: T0 + min(55), exitTo: "Done" },
    ]);
  });

  it("leaves an open interval running to now with no exitTo", () => {
    const log = changelog([[0, "To Do", "Blocked"]]);
    expect(statusIntervals(extractStatusTransitions(log), "Blocked", T0 + min(90))).toEqual([
      { start: T0, end: T0 + min(90) },
    ]);
  });
});

describe("humanWaitMs", () => {
  it("counts a closed In Review interval", () => {
    const log = changelog([
      [0, "To Do", "In Review"],
      [30, "In Review", "Done"],
    ]);
    expect(humanWaitMs(log, T0 + min(60))).toBe(min(30));
  });

  it("counts Blocked dwell that a human resolved — merge-approval gates park in Blocked", () => {
    const log = changelog([
      [0, "To Do", "Blocked"],
      [45, "Blocked", "Done"],
    ]);
    expect(humanWaitMs(log, T0 + min(60))).toBe(min(45));
  });

  it("does NOT count Blocked time that ended by dependencies completing (exit to Ready)", () => {
    const log = changelog([
      [0, "To Do", "Blocked"],
      [30, "Blocked", "Ready"],
      [35, "Ready", "In Review"],
      [50, "In Review", "Done"],
    ]);
    expect(humanWaitMs(log, T0 + min(60))).toBe(min(15));
  });

  it("counts an open Blocked interval up to now (human still owns it)", () => {
    const log = changelog([[0, "To Do", "Blocked"]]);
    expect(humanWaitMs(log, T0 + min(90))).toBe(min(90));
  });

  it("merges touching Blocked→In Review into one continuous wait", () => {
    const log = changelog([
      [0, "To Do", "Blocked"],
      [20, "Blocked", "In Review"],
      [50, "In Review", "Done"],
    ]);
    expect(humanWaitMs(log, T0 + min(60))).toBe(min(50));
  });

  it("returns 0 when the ticket never enters a counted status", () => {
    const log = changelog([
      [0, "To Do", "In Progress"],
      [10, "In Progress", "Done"],
    ]);
    expect(humanWaitMs(log, T0 + min(60))).toBe(0);
  });
});

describe("humanWaitIntervals", () => {
  it("returns In Review plus non-dependency Blocked intervals", () => {
    const log = changelog([
      [0, "To Do", "Blocked"],
      [10, "Blocked", "Ready"], // dependency wait — excluded
      [20, "Ready", "In Review"],
      [30, "In Review", "Done"],
    ]);
    expect(humanWaitIntervals(log, T0 + min(60))).toEqual([
      { start: T0 + min(20), end: T0 + min(30), exitTo: "Done" },
    ]);
  });
});

describe("unionMs", () => {
  it("merges overlapping gate intervals — two open gates count once", () => {
    expect(unionMs([
      { start: 0, end: min(60) },
      { start: min(30), end: min(90) },
    ])).toBe(min(90));
  });

  it("sums disjoint intervals", () => {
    expect(unionMs([
      { start: 0, end: min(10) },
      { start: min(20), end: min(30) },
    ])).toBe(min(20));
  });

  it("handles containment and empty input", () => {
    expect(unionMs([])).toBe(0);
    expect(unionMs([
      { start: 0, end: min(100) },
      { start: min(10), end: min(20) },
    ])).toBe(min(100));
  });
});
