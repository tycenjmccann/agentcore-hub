import { describe, it, expect } from "vitest";
import { provesTransitioned } from "./ticket-transition-refusal";

/**
 * TEAM-6123 — rejectedDetails is a deny-list: it answers null for ANY shape it
 * doesn't recognize as a refusal, including an unparseable payload, "null", "{}",
 * or an unknown object. Both callers (webhook/route.ts, [id]/tickets/transition/
 * route.ts) treated that null as "the ticket moved" and answered success. These
 * pin provesTransitioned, the SUCCESS allow-list that closes the gap: only the
 * two real success shapes — read verbatim off the Lambdas' only success returns —
 * count as proof.
 */

// Verbatim from the Lambdas' only success returns.
const TICKETS_SUCCESS = {
  key: "TEAM-7",
  status: "transitioned",
  from: "in_review",
  to: "done",
  transition: "Done",
}; // lambda/agentcore-hub-tickets/index.mjs:2461
const JIRA_SUCCESS = {
  ticketId: "TEAM-7",
  status: "done",
  message: "Transitioned to done",
}; // lambda/agentcore-hub-jira/index.mjs:2495

describe("provesTransitioned — the real Lambda success shapes", () => {
  it("the real tickets-Lambda success shape proves done", () => {
    expect(provesTransitioned(TICKETS_SUCCESS, "done")).toBe(true);
  });

  it("the real jira-Lambda success shape proves done", () => {
    expect(provesTransitioned(JIRA_SUCCESS, "done")).toBe(true);
  });

  it("tickets shape landing in a DIFFERENT status than requested is not proof", () => {
    expect(provesTransitioned({ ...TICKETS_SUCCESS, to: "blocked" }, "done")).toBe(false);
  });

  it("jira shape landing in a DIFFERENT internal status than requested is not proof", () => {
    expect(provesTransitioned({ ...JIRA_SUCCESS, status: "in_progress" }, "done")).toBe(false);
  });

  it("status/target comparison is case- and whitespace-insensitive", () => {
    expect(provesTransitioned({ ticketId: "TEAM-7", status: " DONE " }, "done")).toBe(true);
    expect(provesTransitioned({ key: "TEAM-7", status: "transitioned", to: "DONE" }, "done")).toBe(true);
  });

  it("the no-`to` tickets fixture (the console tests' default fixture) is proof for ANY target — kept on purpose so the existing suite is not disturbed", () => {
    expect(provesTransitioned({ status: "transitioned" }, "blocked")).toBe(true);
  });

  it("an explicit error field is never proof, even alongside a status field", () => {
    expect(provesTransitioned({ error: "nope", status: "transitioned", to: "done" }, "done")).toBe(false);
  });
});

describe("provesTransitioned — unproven shapes (the P2 false-ack gap)", () => {
  it.each([
    ["JSON null", null],
    ["empty object", {}],
    ["a refusal-shaped-but-unrecognized object", { ok: true, status: "blocked" }],
    ["a bare array", []],
    ["a bare string", "not json"],
    ["a bare number", 42],
    ["undefined", undefined],
  ])("%s is not proof", (_label, payload) => {
    expect(provesTransitioned(payload as unknown, "done")).toBe(false);
  });
});
