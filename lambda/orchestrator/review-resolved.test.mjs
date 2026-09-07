/**
 * TEAM-4167 D3 (FR-3.2) — review-resolved.mjs: the canonical detail builder for
 * the ONE review.resolved event every human gate emits at completion. Pure, so
 * this is direct: the invariant that matters is that resolvedAt and timestamp
 * are the SAME stamp (a consumer keys on either) and that the outcome vocabulary
 * is carried through verbatim.
 */
import { describe, it, expect } from "vitest";
import { buildReviewResolved } from "./review-resolved.mjs";

const NOW = "2026-09-07T12:00:00.000Z";

describe("buildReviewResolved", () => {
  it("carries the canonical fields with a single shared stamp", () => {
    const d = buildReviewResolved({
      workflowId: "wf_1",
      ticketId: "TEAM-1",
      assignee: "human:designer",
      outcome: "approved",
      now: NOW,
    });
    expect(d).toEqual({
      workflowId: "wf_1",
      ticketId: "TEAM-1",
      outcome: "approved",
      resolvedAt: NOW,
      reviewer: "human:designer",
      timestamp: NOW,
    });
    // resolvedAt and timestamp must never diverge — one clock read, both fields.
    expect(d.resolvedAt).toBe(d.timestamp);
  });

  it.each(["approved", "rejected", "approved_with_advisory", "skipped"])(
    "passes the %s outcome through verbatim",
    (outcome) => {
      const d = buildReviewResolved({ workflowId: "wf", ticketId: "T", assignee: "human:x", outcome, now: NOW });
      expect(d.outcome).toBe(outcome);
    }
  );

  it("reviewer falls back to null when no assignee is given", () => {
    const d = buildReviewResolved({ workflowId: "wf", ticketId: "T", outcome: "skipped", now: NOW });
    expect(d.reviewer).toBeNull();
  });
});
