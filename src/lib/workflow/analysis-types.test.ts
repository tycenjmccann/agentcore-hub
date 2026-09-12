import { describe, it, expect } from "vitest";
import {
  SHIP_BLOCKED_OUTCOMES,
  TERMINAL_PHASES,
  isTerminalPhase,
} from "@/lib/workflow/types";
import type {
  HumanReviewMetric,
  RunOutcome,
  WorkflowMetrics,
} from "@/lib/workflow/analysis-types";

/**
 * TEAM-3758 / AC-D2.5 — the analyzer RunOutcome type accepts the new values, and
 * a REAL consumer that branches on those values handles them.
 *
 * analysis-types.ts:18 defines `RunOutcome = "complete" | "cancelled" | "error"
 * | ShipBlockedOutcome`. A tsc-only or constants-parity assertion would not
 * prove any running code actually handles the new members, so this exercises
 * them through `isTerminalPhase` — the shared terminal-aware predicate
 * (types.ts, commit 76ca5a6) that the board/analysis surfaces branch on to
 * decide "is this run finished". Every RunOutcome denotes a finished run, so it
 * must read terminal; a legacy analysis row that carries NO outcome (undefined)
 * must NOT — the exact pre-D2 reading the panel still relies on.
 *
 * The RunOutcome type import is value-free (erased at build); it documents that
 * the runtime list below is the same value space as the type. The `satisfies`
 * check binds them: if RunOutcome loses a member, this stops compiling.
 */

// Every RunOutcome value, as data. `satisfies` pins it to the type so the two
// cannot drift — drop "static-ci-only" from RunOutcome and tsc fails here.
const RUN_OUTCOMES = [
  "complete",
  "cancelled",
  "error",
  "deploy-blocked",
  "static-ci-only",
] as const satisfies readonly RunOutcome[];

describe("AC-D2.5 — RunOutcome new values are handled by a real consumer (isTerminalPhase)", () => {
  it("treats every RunOutcome — legacy AND ship-blocked — as a terminal (finished) run", () => {
    for (const outcome of RUN_OUTCOMES) {
      expect(isTerminalPhase(outcome)).toBe(true);
    }
  });

  it("specifically accepts the D2 additions deploy-blocked / static-ci-only", () => {
    // The two members TEAM-3747 D2 added; before it, both read as non-terminal
    // and a blocked run masqueraded as still-running.
    expect(isTerminalPhase("deploy-blocked")).toBe(true);
    expect(isTerminalPhase("static-ci-only")).toBe(true);
    for (const outcome of SHIP_BLOCKED_OUTCOMES) {
      expect(RUN_OUTCOMES).toContain(outcome);
    }
  });

  it("still rejects non-terminal phases and legacy absent outcomes (pre-D2 reading preserved)", () => {
    // A legacy analysis row carries no runOutcome; the consumer must invent
    // nothing — undefined/unknown reads exactly as it did before this helper.
    expect(isTerminalPhase(undefined)).toBe(false);
    expect(isTerminalPhase(null)).toBe(false);
    expect(isTerminalPhase("")).toBe(false);
    expect(isTerminalPhase("development")).toBe(false);
    expect(isTerminalPhase("review")).toBe(false);
  });

  it("the RunOutcome value space equals the shared terminal-phase set (parity)", () => {
    // If either list gains a member without the other, this fails — the
    // single-source-of-truth invariant the D2 parity note (types.ts) documents.
    expect([...RUN_OUTCOMES].sort()).toEqual([...TERMINAL_PHASES].sort());
  });
});

/**
 * TEAM-4453 D3 — the business-hours wait split (compute_metrics.py's
 * split_wait_by_window) is additive on both shapes it touches. A metrics.json
 * written before this change has neither the per-review inHoursMs/
 * outsideHoursMs nor the run-level humanWait*HoursMs totals; both fixtures
 * below must satisfy the real interfaces so a regression that widens either
 * field from optional to required fails HERE, at compile time, rather than as
 * a runtime crash the first time an old file is read.
 */
const baseMetrics = (): WorkflowMetrics => ({
  startedAt: null,
  completedAt: null,
  totalDurationMs: null,
  phases: [],
  agentTasks: [],
  humanReviews: [],
  humanWaitTotalMs: 0,
  changeRequests: { count: 0, cycles: [] },
  fixTickets: { count: 0, ticketIds: [] },
  nudgeCount: 0,
  managerInterventions: [],
  errors: [],
  tokens: null,
  evalSummaries: [],
  counts: { tickets: 0, events: 0, artifacts: 0, completions: 0 },
  dataQuality: { ticketProvider: "dynamodb", missingSignals: [], notes: [] },
});

const baseReview = (): HumanReviewMetric => ({
  gateTicketId: "TEAM-9",
  reviewer: "human:alice@example.com",
  gateName: "Merge Approval",
  requestedAt: "2026-09-09T06:30:00Z",
  resolvedAt: "2026-09-09T16:22:00Z",
  waitMs: 35_520_000,
  outcome: "approved",
  cycle: 1,
});

describe("TEAM-4453 D3 — the business-hours wait split stays additive", () => {
  it("HumanReviewMetric compiles and reads correctly WITH the split present", () => {
    const review: HumanReviewMetric = { ...baseReview(), inHoursMs: 1_320_000, outsideHoursMs: 34_200_000 };
    expect(review.inHoursMs! + review.outsideHoursMs!).toBe(review.waitMs);
  });

  it("HumanReviewMetric compiles and reads correctly WITHOUT the split (legacy file)", () => {
    const review: HumanReviewMetric = baseReview();
    expect(review.inHoursMs).toBeUndefined();
    expect(review.outsideHoursMs).toBeUndefined();
  });

  it("WorkflowMetrics compiles and reads correctly WITH the run-level totals present", () => {
    const metrics: WorkflowMetrics = {
      ...baseMetrics(),
      humanReviews: [{ ...baseReview(), inHoursMs: 1_320_000, outsideHoursMs: 34_200_000 }],
      humanWaitTotalMs: 35_520_000,
      humanWaitInHoursMs: 1_320_000,
      humanWaitOutsideHoursMs: 34_200_000,
    };
    expect(metrics.humanWaitInHoursMs! + metrics.humanWaitOutsideHoursMs!).toBe(metrics.humanWaitTotalMs);
  });

  it("WorkflowMetrics compiles and reads correctly WITHOUT the run-level totals (legacy file)", () => {
    const metrics: WorkflowMetrics = { ...baseMetrics(), humanReviews: [baseReview()], humanWaitTotalMs: 35_520_000 };
    expect(metrics.humanWaitInHoursMs).toBeUndefined();
    expect(metrics.humanWaitOutsideHoursMs).toBeUndefined();
  });
});
