import { describe, it, expect } from "vitest";
import { GATE_STATES, classifyRejection, normalizeGateGuardMode } from "./gate-state.mjs";

/**
 * TEAM-4120 FR-1 — the review-gate truth table (gate-state.mjs).
 *
 * gate-state.mjs is pure (zero imports), so everything here is direct. What is
 * pinned is the DIRECTION of every cell: the guard's job is to stop the
 * orchestrator acting on a `→ blocked` nobody requested, and its failure mode is
 * asymmetric — dropping a human's "Request changes" is far worse than acting on
 * one extra edge — so every uncertain cell must resolve to "presented".
 */

const PRESENTED_STATUSES = ["ready", "in_progress", "in_review", "In Review", " IN_REVIEW ", "blocked", "done"];
const CREATION_STATUSES = ["", "  ", "todo", "TODO", " Todo ", "new", "NEW", undefined, null];

const requested = { state: "requested", requestedAt: "2026-09-05T10:00:00.000Z", cycles: [] };
const rejected = { state: "rejected", requestedAt: "2026-09-05T10:00:00.000Z", resolvedAt: "2026-09-05T11:00:00.000Z", cycles: [{}] };
const approved = { state: "approved", requestedAt: "2026-09-05T10:00:00.000Z", resolvedAt: "2026-09-05T11:00:00.000Z", cycles: [{}] };
const seed = { state: "none", cycles: [] };

const classify = (over) =>
  classifyRejection({ gateTicket: { ticketId: "TEAM-900", status: "blocked" }, oldStatus: "in_review", ...over });

describe("classifyRejection — creation-time block (TEAM-4044, defensive twin)", () => {
  it("is creation_block for every no-status/new/todo spelling, whatever the state says", () => {
    for (const oldStatus of CREATION_STATUSES) {
      for (const gateState of [undefined, null, seed, requested, rejected, approved]) {
        for (const hasReviewNeeded of [true, false]) {
          expect(classify({ oldStatus, gateState, hasReviewNeeded }), `${oldStatus} / ${gateState?.state}`)
            .toBe("creation_block");
        }
      }
    }
  });
});

describe("classifyRejection — recorded state decides for a PRESENTED transition", () => {
  it("requested → presented (a human was asked; this is their answer)", () => {
    for (const oldStatus of PRESENTED_STATUSES) {
      expect(classify({ oldStatus, gateState: requested, hasReviewNeeded: false })).toBe("presented");
    }
  });

  it("rejected → duplicate (the same Request-changes arriving twice)", () => {
    for (const oldStatus of PRESENTED_STATUSES) {
      expect(classify({ oldStatus, gateState: rejected, hasReviewNeeded: true })).toBe("duplicate");
    }
  });

  it("approved → unrequested (the review already concluded; nothing is pending)", () => {
    for (const oldStatus of PRESENTED_STATUSES) {
      expect(classify({ oldStatus, gateState: approved, hasReviewNeeded: true })).toBe("unrequested");
    }
  });

  it("the recorded state OUTRANKS the notification fallback in both directions", () => {
    // A stale notification cannot resurrect a decided gate…
    expect(classify({ gateState: approved, hasReviewNeeded: true })).toBe("unrequested");
    // …and a missing notification cannot mute a pending one.
    expect(classify({ gateState: requested, hasReviewNeeded: false })).toBe("presented");
  });
});

describe("classifyRejection — no usable state (pre-guard runs) falls back to the notification", () => {
  it("absent gateState + a review_needed → presented (fail-open: a human WAS asked)", () => {
    for (const gateState of [undefined, null]) {
      expect(classify({ gateState, hasReviewNeeded: true })).toBe("presented");
    }
  });

  it("absent gateState + no notification → unrequested", () => {
    expect(classify({ gateState: undefined, hasReviewNeeded: false })).toBe("unrequested");
  });

  it('the "none" seed is treated as absent, not as a pending review', () => {
    expect(classify({ gateState: seed, hasReviewNeeded: true })).toBe("presented");
    expect(classify({ gateState: seed, hasReviewNeeded: false })).toBe("unrequested");
  });

  it("an unknown/garbage state is treated as absent too (never as pending)", () => {
    for (const state of ["REQUESTED", "pending", "", null, 7, {}]) {
      expect(classify({ gateState: { state }, hasReviewNeeded: true })).toBe("presented");
      expect(classify({ gateState: { state }, hasReviewNeeded: false })).toBe("unrequested");
    }
  });

  it("hasReviewNeeded absent behaves as false", () => {
    expect(classifyRejection({ oldStatus: "in_review" })).toBe("unrequested");
  });
});

describe("classifyRejection — the gate ticket cannot influence the verdict", () => {
  it("ignores the ticket entirely (its status is already `blocked` by then)", () => {
    const base = { oldStatus: "in_review", gateState: requested, hasReviewNeeded: false };
    const verdict = classifyRejection(base);
    for (const gateTicket of [
      undefined,
      { ticketId: "TEAM-900" },
      { ticketId: "TEAM-900", status: "todo", assignee: "human:engineer" },
      { ticketId: "TEAM-900", status: "done", labels: ["human-review"] },
    ]) {
      expect(classifyRejection({ ...base, gateTicket })).toBe(verdict);
    }
  });

  it("is total — a call with no arguments at all does not throw", () => {
    expect(classifyRejection()).toBe("creation_block");
  });
});

describe("normalizeGateGuardMode — STRICT allow-list", () => {
  it("accepts exactly the three modes, trimmed + case-insensitively", () => {
    expect(normalizeGateGuardMode("off")).toBe("off");
    expect(normalizeGateGuardMode("shadow")).toBe("shadow");
    expect(normalizeGateGuardMode("enforce")).toBe("enforce");
    expect(normalizeGateGuardMode("Enforce ")).toBe("enforce");
    expect(normalizeGateGuardMode("  SHADOW\n")).toBe("shadow");
  });

  it("coalesces everything else to off — including the legacy truthies", () => {
    // Dropping a human's Request-changes is the dangerous failure, so an
    // unrecognized value gets neither enforce NOR shadow (shadow writes).
    for (const v of ["on", "true", "1", "yes", "enforced", "shado", "false", "0", "", "   ", undefined, null, 1, {}]) {
      expect(normalizeGateGuardMode(v), String(v)).toBe("off");
    }
  });
});

describe("GATE_STATES", () => {
  it('lists the three real states and NOT the "none" seed', () => {
    expect(GATE_STATES).toEqual(["requested", "rejected", "approved"]);
    expect(GATE_STATES).not.toContain("none");
  });
});
