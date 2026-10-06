import { describe, it, expect } from "vitest";
import { ticketKeyOf, ticketToolRefusal } from "./ticket-tools";

describe("ticketToolRefusal — both twins refuse inside a 200 payload", () => {
  it.each([
    ["tickets twin success", { key: "T-1", status: "created" }],
    ["tickets twin update", { key: "T-1", status: "updated" }],
    ["jira twin success", { ticketId: "TEAM-1", message: "Updated" }],
  ])("%s is not a refusal", (_l, p) => {
    expect(ticketToolRefusal(p)).toBeNull();
  });

  it.each([
    ["tickets twin textResult", { content: [{ text: "Error: 'summary' is required" }] }, "Error: 'summary' is required"],
    ["tickets twin not-found", { content: [{ text: "Issue T-9 not found." }] }, "Issue T-9 not found."],
    ["structured refusal", { ok: false, reason: "gate_frozen", content: [{ text: "Error: frozen" }] }, "gate_frozen"],
    ["jira twin error", { error: "Invalid parent" }, "Invalid parent"],
    ["not an object", "oops", "unreadable ticket tool payload"],
  ])("%s is a refusal", (_l, p, want) => {
    expect(ticketToolRefusal(p)).toBe(want);
  });
});

describe("ticketKeyOf", () => {
  it("reads the tickets twin key, the jira twin ticketId, or ticket.key", () => {
    expect(ticketKeyOf({ key: "T-1" })).toBe("T-1");
    expect(ticketKeyOf({ ticketId: "TEAM-2" })).toBe("TEAM-2");
    expect(ticketKeyOf({ ticket: { key: "T-3" } })).toBe("T-3");
    expect(ticketKeyOf({})).toBeNull();
  });
});
