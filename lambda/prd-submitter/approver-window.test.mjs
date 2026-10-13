/**
 * lambda/prd-submitter/approver-window.test.mjs
 *
 * The approver window's arithmetic (TEAM-5771). Pure, so no fakes: every case is
 * a UTC instant in and a decision or an instant out.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseWindow, inWindow, nextOpenAt, WINDOW_DEFAULTS } from "./approver-window.mjs";

const W = parseWindow({ SI_APPROVER_HOURS: "15-22" });
const iso = (d) => d.toISOString();

describe("parseWindow", () => {
  it("is OFF when unset, empty or 'off' — CD ships code before the tick rule exists", () => {
    assert.equal(parseWindow({}), null);
    assert.equal(parseWindow({ SI_APPROVER_HOURS: "" }), null);
    assert.equal(parseWindow({ SI_APPROVER_HOURS: "off" }), null);
    assert.equal(parseWindow({ SI_APPROVER_HOURS: " OFF " }), null);
  });

  it("defaults to Mon-Fri 15-22 UTC", () => {
    assert.deepEqual(W, { start: 15, end: 22, days: [1, 2, 3, 4, 5] });
    assert.deepEqual(WINDOW_DEFAULTS.days, [1, 2, 3, 4, 5]);
  });

  it("reads hours and an ISO day range", () => {
    assert.deepEqual(parseWindow({ SI_APPROVER_HOURS: "8-17", SI_APPROVER_DAYS: "1-6" }), {
      start: 8, end: 17, days: [1, 2, 3, 4, 5, 6],
    });
  });

  it("falls back to the defaults on a bad value instead of throwing", () => {
    assert.deepEqual(parseWindow({ SI_APPROVER_HOURS: "22-15" }), { start: 15, end: 22, days: [1, 2, 3, 4, 5] });
    assert.deepEqual(parseWindow({ SI_APPROVER_HOURS: "3pm-10pm" }), { start: 15, end: 22, days: [1, 2, 3, 4, 5] });
    assert.deepEqual(parseWindow({ SI_APPROVER_HOURS: "15-22", SI_APPROVER_DAYS: "5-1" }).days, [1, 2, 3, 4, 5]);
    assert.deepEqual(parseWindow({ SI_APPROVER_HOURS: "15-22", SI_APPROVER_DAYS: "0-9" }).days, [1, 2, 3, 4, 5]);
  });
});

describe("inWindow", () => {
  it("is half-open: 15:00 is in, 22:00 is out", () => {
    assert.equal(inWindow("2026-10-13T15:00:00Z", W), true);
    assert.equal(inWindow("2026-10-13T21:59:59Z", W), true);
    assert.equal(inWindow("2026-10-13T22:00:00Z", W), false);
    assert.equal(inWindow("2026-10-13T14:59:59Z", W), false);
  });

  it("is out all weekend", () => {
    assert.equal(inWindow("2026-10-10T16:00:00Z", W), false); // Saturday
    assert.equal(inWindow("2026-10-11T16:00:00Z", W), false); // Sunday
  });
});

describe("nextOpenAt", () => {
  it("is now itself when already inside", () => {
    assert.equal(iso(nextOpenAt("2026-10-13T16:00:00Z", W)), "2026-10-13T16:00:00.000Z");
  });

  it("Sunday 2026-10-11 11:43Z → Monday 15:00Z", () => {
    assert.equal(iso(nextOpenAt("2026-10-11T11:43:00Z", W)), "2026-10-12T15:00:00.000Z");
  });

  it("a weekday morning → the same day's opening", () => {
    assert.equal(iso(nextOpenAt("2026-10-13T03:00:00Z", W)), "2026-10-13T15:00:00.000Z");
  });

  it("Monday 14:59Z → the same day's 15:00Z", () => {
    assert.equal(iso(nextOpenAt("2026-10-12T14:59:00Z", W)), "2026-10-12T15:00:00.000Z");
    assert.equal(iso(nextOpenAt("2026-10-12T14:59:59.999Z", W)), "2026-10-12T15:00:00.000Z");
  });

  it("a weekday evening → the next day's opening", () => {
    assert.equal(iso(nextOpenAt("2026-10-13T22:30:00Z", W)), "2026-10-14T15:00:00.000Z");
  });

  it("Friday 22:00Z (the close itself) → Monday 15:00Z", () => {
    assert.equal(inWindow("2026-10-16T22:00:00Z", W), false);
    assert.equal(iso(nextOpenAt("2026-10-16T22:00:00Z", W)), "2026-10-19T15:00:00.000Z");
    assert.equal(iso(nextOpenAt("2026-10-16T21:59:59Z", W)), "2026-10-16T21:59:59.000Z", "still inside");
  });

  it("any Sunday 11:43Z → the following Monday 15:00Z", () => {
    for (let week = 0; week < 6; week++) {
      const sunday = new Date(Date.UTC(2026, 9, 11 + week * 7, 11, 43));
      assert.equal(sunday.getUTCDay(), 0);
      const monday = new Date(Date.UTC(2026, 9, 12 + week * 7, 15, 0));
      assert.equal(iso(nextOpenAt(sunday, W)), iso(monday));
    }
  });
});
