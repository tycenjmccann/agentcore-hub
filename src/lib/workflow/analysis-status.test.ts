import { describe, it, expect } from "vitest";
import { analysisPollOutcome } from "./analysis-status";
import type { AnalysisFailure, WorkflowAnalysis } from "./analysis-types";

const analysis = (analysisId: string) => ({ analysisId }) as WorkflowAnalysis;
const failure: AnalysisFailure = {
  eventId: "1790000000000-ab12",
  timestamp: "2026-09-28T12:00:00.000Z",
  detail: {
    errorClass: "MaxTokensReachedException",
    message: "Harness error: MaxTokensReachedException",
    attempts: 4,
    trigger: "manual",
    stopReason: "max_tokens",
  },
};
const base = { baselineId: "an-old", now: 1_000, pollUntil: 10_000 };

describe("analysisPollOutcome (TEAM-5226)", () => {
  it("stays pending while nothing new has appeared", () => {
    expect(analysisPollOutcome({ ...base, latest: analysis("an-old"), latestFailure: null }).state).toBe("pending");
    expect(analysisPollOutcome({ ...base, baselineId: null, latest: null, latestFailure: undefined }).state).toBe("pending");
  });

  it("is done when a new analysis appears", () => {
    expect(analysisPollOutcome({ ...base, latest: analysis("an-new"), latestFailure: null })).toEqual({ state: "done" });
  });

  it("surfaces a workflow.analysis_failed written after the click", () => {
    const out = analysisPollOutcome({ ...base, latest: analysis("an-old"), latestFailure: failure });
    expect(out.state).toBe("failed");
    expect(out.message).toMatch(/^Analysis failed: MaxTokensReachedException after 4 attempts/);
  });

  it("a new analysis wins over an earlier failure", () => {
    expect(analysisPollOutcome({ ...base, latest: analysis("an-new"), latestFailure: failure }).state).toBe("done");
  });

  it("times out with a message instead of resetting silently", () => {
    const out = analysisPollOutcome({ ...base, now: 10_001, latest: analysis("an-old"), latestFailure: null });
    expect(out.state).toBe("timeout");
    expect(out.message).toMatch(/No analysis after 10 minutes/);
  });
});
