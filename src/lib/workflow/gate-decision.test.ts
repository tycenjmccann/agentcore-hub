import { describe, it, expect } from "vitest";
import { parseDecision, withDefaultDecision } from "./gate-decision";

const GATE = "Escalation #2: ship-review not converging (TEAM-3891, round 7)";

describe("parseDecision", () => {
  it("accepts a bare line and tolerates markdown noise; last one wins", () => {
    expect(parseDecision("DECISION: continue")).toBe("continue");
    expect(parseDecision("- **DECISION: merge-with-known-findings**.")).toBe("merge-with-known-findings");
    expect(parseDecision("DECISION: cancel\nDECISION: continue")).toBe("continue");
  });

  it("rejects a decision buried in prose or malformed (fail closed)", () => {
    expect(parseDecision("I think DECISION: continue is right")).toBeNull();
    expect(parseDecision("DECISION: ship-it")).toBeNull();
    expect(parseDecision("looks fine, keep going")).toBeNull();
    expect(parseDecision(undefined)).toBeNull();
  });
});

describe("withDefaultDecision (TEAM-3971)", () => {
  it("a bare approve on an escalation gate records merge-with-known-findings", () => {
    const { comment, decisionDefaulted } = withDefaultDecision("Approved via Telegram", "done", GATE);
    expect(decisionDefaulted).toBe("merge-with-known-findings");
    expect(parseDecision(comment)).toBe("merge-with-known-findings");
    expect(comment).toContain("Approved via Telegram");
  });

  it("never overrides an explicit DECISION", () => {
    const { comment, decisionDefaulted } = withDefaultDecision("DECISION: continue", "done", GATE);
    expect(decisionDefaulted).toBeNull();
    expect(comment).toBe("DECISION: continue");
  });

  it("never defaults to continue — the safe direction is merge-with-known-findings", () => {
    expect(withDefaultDecision(undefined, "done", GATE).decisionDefaulted).not.toBe("continue");
  });

  it("leaves ordinary gates and non-approve transitions untouched", () => {
    expect(withDefaultDecision("ok", "done", "Review: spec sign-off").decisionDefaulted).toBeNull();
    expect(withDefaultDecision("nope", "blocked", GATE).decisionDefaulted).toBeNull();
    expect(withDefaultDecision(undefined, "done", undefined).comment).toBeUndefined();
  });
});
