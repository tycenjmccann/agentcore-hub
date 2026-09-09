import { describe, it, expect } from "vitest";
import {
  sessionTicketId, pickTicketSession, renderPriorSessionBlock, renderRejectionSessionHint,
} from "./coding-session-hint.mjs";

// The 2026-09-04 collision: six backend_dev tickets in one run, one session.
const ROWS = [
  { sessionId: "cc-orig", title: "[wf] TEAM-3940 backend_dev", updatedAt: "2026-09-04T10:00:00Z" },
  { sessionId: "cc-3963", ticketId: "TEAM-3963", title: "[wf] TEAM-3963 backend_dev", updatedAt: "2026-09-04T12:56:00Z" },
  { sessionId: "cc-3963-old", ticketId: "TEAM-3963", title: "[wf] TEAM-3963 backend_dev", updatedAt: "2026-09-04T11:00:00Z" },
  { sessionId: "cc-untitled", title: "", updatedAt: "2026-09-04T13:00:00Z" },
];

describe("sessionTicketId", () => {
  it("prefers the ticketId column", () => {
    expect(sessionTicketId({ ticketId: "TEAM-1", title: "[wf] TEAM-2 x" })).toBe("TEAM-1");
  });
  it("falls back to the legacy title encoding", () => {
    expect(sessionTicketId({ title: "[wf] TEAM-3940 backend_dev" })).toBe("TEAM-3940");
  });
  it("is null when neither is present", () => {
    expect(sessionTicketId({ title: "" })).toBeNull();
    expect(sessionTicketId({ title: "[wf]  backend_dev" })).toBeNull();
    expect(sessionTicketId(null)).toBeNull();
  });
});

describe("pickTicketSession", () => {
  it("returns only the requesting ticket's own session, newest first", () => {
    expect(pickTicketSession(ROWS, "TEAM-3963")).toBe("cc-3963");
  });
  it("never hands a sibling ticket the agent's most recent session", () => {
    // TEAM-3964 (parallel fix ticket, same agent) has no session of its own.
    expect(pickTicketSession(ROWS, "TEAM-3964")).toBeNull();
  });
  it("matches legacy title-only rows for a reopened ticket", () => {
    expect(pickTicketSession(ROWS, "TEAM-3940")).toBe("cc-orig");
  });
  it("ignores rows with no ticket and bad input", () => {
    expect(pickTicketSession(ROWS, "")).toBeNull();
    expect(pickTicketSession(null, "TEAM-3963")).toBeNull();
    expect(pickTicketSession([{ sessionId: "cc-x" }], "TEAM-3963")).toBeNull();
  });
});

describe("render", () => {
  it("prior-session block names the ticket and forbids sibling ids", () => {
    const out = renderPriorSessionBlock("TEAM-3963", "cc-3963");
    expect(out).toMatch(/^## Prior Coding Session/);
    expect(out).toContain('resume_session="cc-3963"');
    expect(out).toContain("This ticket (TEAM-3963)");
    expect(out).toContain("Never resume a session id from another ticket");
  });
  it("rejection hint is empty without a session", () => {
    expect(renderRejectionSessionHint(null)).toBe("");
    expect(renderRejectionSessionHint("cc-1")).toContain("resume_session");
  });
});
