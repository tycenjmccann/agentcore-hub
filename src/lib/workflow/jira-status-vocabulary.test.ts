/**
 * TEAM-5375: the hub's one Jira status vocabulary. Any spelling of Won't Do /
 * Cancelled reads as cancelled, and a cancel transition is picked by its
 * DESTINATION alone — a transition named "Cancel" that ends in Done is a Done.
 */

import { describe, it, expect } from "vitest";
import {
  CancelStatusMissingError,
  CANCEL_STATUS_MISSING,
  INTERNAL_STATUS_TO_JIRA,
  isCancelledStatusName,
  mapJiraStatusToInternal,
  pickCancelTransition,
} from "./jira-status-vocabulary";

/** [input, isCancelled, mapJiraStatusToInternal]. PARITY: the same rows in jira-status-lambda-parity.test.ts. */
const STATUS_TABLE: Array<[string, boolean, string]> = [
  ["Won't Do", true, "cancelled"],
  ["Wont Do", true, "cancelled"],
  ["won't do", true, "cancelled"],
  ["WON'T DO", true, "cancelled"],
  ["Won’t Do", true, "cancelled"],
  ["Cancelled", true, "cancelled"],
  ["Canceled", true, "cancelled"],
  [" canceled ", true, "cancelled"],
  ["Done", false, "done"],
  ["To Do", false, "todo"],
  ["In Review", false, "in_review"],
];

describe("jira-status-vocabulary — status names (TEAM-5375)", () => {
  it.each(STATUS_TABLE)("%s: cancelled=%s, maps to %s", (name, cancelled, internal) => {
    expect(isCancelledStatusName(name)).toBe(cancelled);
    expect(mapJiraStatusToInternal(name)).toBe(internal);
  });

  it("an unknown status falls back to its lowercased name, as before", () => {
    expect(mapJiraStatusToInternal("Some Custom")).toBe("some custom");
  });

  it("is not fooled by near-misses", () => {
    for (const s of ["Cancel", "Won't", "Done", "", undefined, null]) expect(isCancelledStatusName(s), String(s)).toBe(false);
  });

  it("cancelled lands on Won't Do", () => {
    expect(INTERNAL_STATUS_TO_JIRA.cancelled).toBe("Won't Do");
  });
});

describe("pickCancelTransition — destination only (TEAM-5375)", () => {
  it('a transition named "Cancel" that ends in Done is refused', () => {
    expect(pickCancelTransition([{ id: "41", name: "Cancel", to: { name: "Done", statusCategory: { key: "done" } } }])).toBeNull();
  });

  it('a transition named "Won\'t Do" that ends in Done is refused', () => {
    expect(pickCancelTransition([{ id: "61", name: "Won't Do", to: { name: "Done" } }])).toBeNull();
  });

  it("a transition with no destination is refused, whatever its name", () => {
    expect(pickCancelTransition([{ id: "31", name: "Won't Do" }])).toBeNull();
  });

  it("a differently named transition into Won't Do is taken", () => {
    expect(pickCancelTransition([{ id: "71", name: "Close", to: { name: "Won't Do" } }])?.id).toBe("71");
  });

  it("the real cancel is taken even when a Done-bound decoy is listed first", () => {
    const picked = pickCancelTransition([
      { id: "41", name: "Cancel", to: { name: "Done" } },
      { id: "61", name: "Won't Do", to: { name: "Done" } },
      { id: "51", name: "Won't Do", to: { name: "Won't Do", statusCategory: { key: "done" } } },
    ]);
    expect(picked?.id).toBe("51");
  });

  it("CancelStatusMissingError carries the cancel_status_missing code", () => {
    const err = new CancelStatusMissingError("TEAM-1", ["Done (-> Done)"]);
    expect(err.code).toBe(CANCEL_STATUS_MISSING);
    expect(CANCEL_STATUS_MISSING).toBe("cancel_status_missing");
    expect(err.issueKey).toBe("TEAM-1");
    expect(err.available).toEqual(["Done (-> Done)"]);
  });
});
