import { describe, it, expect } from "vitest";
import { gateDecisionCommitted, liveStatusOf, type GateDecisionRecordV3, type LiveGate } from "./gate-decision-record";

/**
 * TEAM-5397 F4 — a gate-decision record that stands (sig/run/ticket/cycle/scope)
 * can still be a PENDING claim: both ticket twins claim the record before the
 * status write and never delete it when that write fails (TEAM-5387). These two
 * functions are what the gate-decisions route uses to tell a committed decision
 * from a pending one.
 */

describe("liveStatusOf", () => {
  it("reads the DynamoDB twin's shape (fields.status.name)", () => {
    expect(liveStatusOf({ key: "G-1", fields: { status: { name: "in_review" } } })).toBe("in_review");
    expect(liveStatusOf({ key: "G-1", fields: { status: { name: "done" } } })).toBe("done");
  });

  it("reads the Jira twin's shape (top-level status, already internal)", () => {
    expect(liveStatusOf({ key: "G-1", status: "done" })).toBe("done");
    expect(liveStatusOf({ key: "G-1", status: "in_review" })).toBe("in_review");
  });

  it("normalizes a Jira display-case name the same way the rest of the hub does", () => {
    expect(liveStatusOf({ key: "G-1", fields: { status: { name: "In Review" } } })).toBe("in_review");
    expect(liveStatusOf({ key: "G-1", status: "Done" })).toBe("done");
    expect(liveStatusOf({ key: "G-1", status: "Won't Do" })).toBe("cancelled");
    expect(liveStatusOf({ key: "G-1", status: "Wont Do" })).toBe("cancelled");
  });

  it("parses raw bytes and JSON text the same as an object payload", () => {
    const obj = { key: "G-1", status: "in_review" };
    expect(liveStatusOf(JSON.stringify(obj))).toBe("in_review");
    expect(liveStatusOf(new TextEncoder().encode(JSON.stringify(obj)))).toBe("in_review");
  });

  it("is null for a refusal, unreadable payload, or a response with no status at all", () => {
    expect(liveStatusOf({ key: "G-1", error: "not found" })).toBeNull();
    expect(liveStatusOf("not json")).toBeNull();
    expect(liveStatusOf(null)).toBeNull();
    expect(liveStatusOf([])).toBeNull();
    expect(liveStatusOf({ key: "G-1" })).toBeNull();
    expect(liveStatusOf({ key: "G-1", fields: {} })).toBeNull();
  });
});

describe("gateDecisionCommitted", () => {
  const record = (status: "done" | "cancelled"): GateDecisionRecordV3 => ({
    v: 3,
    ticketId: "G-1",
    workflowId: "wf_1",
    kind: "gate-decision",
    status,
    decision: { option: status === "cancelled" ? "stopped" : "approve", override: false, channel: "hub", by: "eng@example.com" },
    decidedAt: "2026-10-01T00:00:00Z",
    scope: null,
    cycle: null,
    labels: [],
    sig: "sig",
  });
  const live = (status: string | null | undefined): LiveGate => ({ ticketId: "G-1", cycle: null, scope: null, status });

  it("true when the live status equals the record's status", () => {
    expect(gateDecisionCommitted(record("done"), live("done"))).toBe(true);
    expect(gateDecisionCommitted(record("cancelled"), live("cancelled"))).toBe(true);
  });

  it("false when the live status differs (the probe: In Review ticket, done record)", () => {
    expect(gateDecisionCommitted(record("done"), live("in_review"))).toBe(false);
  });

  it("fails closed: an unknown live status is never committed", () => {
    expect(gateDecisionCommitted(record("done"), live(null))).toBe(false);
    expect(gateDecisionCommitted(record("done"), live(undefined))).toBe(false);
    expect(gateDecisionCommitted(record("done"), null)).toBe(false);
  });
});
