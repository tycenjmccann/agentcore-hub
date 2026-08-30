import { describe, it, expect } from "vitest";
import { extractStatusTransitions, dwellMs, humanWaitMs, HUMAN_WAIT_STATUSES } from "./gate-dwell";

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

describe("dwellMs", () => {
  it("counts a closed In Review interval", () => {
    const log = changelog([
      [0, "To Do", "In Review"],
      [30, "In Review", "Done"],
    ]);
    expect(dwellMs(extractStatusTransitions(log), HUMAN_WAIT_STATUSES, T0 + min(60))).toBe(min(30));
  });

  it("counts Blocked dwell — merge-approval gates park in Blocked, not In Review", () => {
    const log = changelog([
      [0, "To Do", "Blocked"],
      [45, "Blocked", "Done"],
    ]);
    expect(dwellMs(extractStatusTransitions(log), HUMAN_WAIT_STATUSES, T0 + min(60))).toBe(min(45));
  });

  it("treats Blocked → In Review as one continuous human wait, not two", () => {
    const log = changelog([
      [0, "To Do", "Blocked"],
      [20, "Blocked", "In Review"],
      [50, "In Review", "Done"],
    ]);
    expect(dwellMs(extractStatusTransitions(log), HUMAN_WAIT_STATUSES, T0 + min(60))).toBe(min(50));
  });

  it("accrues an open interval up to now", () => {
    const log = changelog([[0, "To Do", "Blocked"]]);
    expect(dwellMs(extractStatusTransitions(log), HUMAN_WAIT_STATUSES, T0 + min(90))).toBe(min(90));
  });

  it("sums multiple separate intervals", () => {
    const log = changelog([
      [0, "To Do", "In Review"],
      [10, "In Review", "In Progress"],
      [40, "In Progress", "In Review"],
      [55, "In Review", "Done"],
    ]);
    expect(dwellMs(extractStatusTransitions(log), HUMAN_WAIT_STATUSES, T0 + min(60))).toBe(min(25));
  });

  it("returns 0 when the ticket never enters a counted status", () => {
    const log = changelog([
      [0, "To Do", "In Progress"],
      [10, "In Progress", "Done"],
    ]);
    expect(dwellMs(extractStatusTransitions(log), HUMAN_WAIT_STATUSES, T0 + min(60))).toBe(0);
  });
});

describe("humanWaitMs", () => {
  it("computes wait from a raw changelog", () => {
    const log = changelog([
      [0, "To Do", "Blocked"],
      [15, "Blocked", "Done"],
    ]);
    expect(humanWaitMs(log, T0 + min(60))).toBe(min(15));
  });
});
