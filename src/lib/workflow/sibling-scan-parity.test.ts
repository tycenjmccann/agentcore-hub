import { describe, it, expect } from "vitest";

// The two ticket twins, imported directly — same trick as base-branch-parity.test.ts
// (both modules are import-side-effect free, so one vitest process can hold BOTH
// providers to the same contract).
import * as tickets from "../../../lambda/agentcore-hub-tickets/index.mjs";
import * as jira from "../../../lambda/agentcore-hub-jira/index.mjs";

/**
 * TEAM-4752 D1 parity contract — `siblingScanRefusal` across the twins.
 *
 * The open-gate autowire used to read "the sibling scan failed" as "no merge gate
 * is open" and file the ticket UNFROZEN, which dispatches it onto the very branch
 * the open merge is about to supersede. Both twins now refuse the create instead,
 * and the refusal body is the only thing the agent reads in order to retry — so it
 * has to be the SAME body under either backend. The delivery differs (tickets
 * returns `Error: <body>` in a textResult, jira throws `<body>`); the body may not.
 *
 * Two layers, because "equal today" is weaker than "cannot drift":
 *   1. identical OUTPUT, byte for byte, over a matrix of (parentKey, error);
 *   2. identical SOURCE — `Function.prototype.toString()` compared byte for byte,
 *      so a reworded sentence in one twin fails CI even if a future caller happens
 *      to pass arguments that make the two agree.
 */

const CASES: Array<[string, string]> = [
  ["TEAM-4734", "Requested resource not found: parentId-index"],
  ["TEAM-1", "Jira API 500: boom"],
  ["TEAM-4100", "connect ETIMEDOUT"],
  // Degenerate inputs: an error object stringified to nothing, and a parent whose
  // shape check is what threw. Neither should make the two twins diverge.
  ["TEAM-9999", ""],
  ["", "throttled"],
];

describe("siblingScanRefusal — byte-identical body, per-twin delivery", () => {
  it.each(CASES)("is byte-identical for (%j, %j)", (parentKey, error) => {
    const t = tickets.siblingScanRefusal(parentKey, error);
    const j = jira.siblingScanRefusal(parentKey, error);
    expect(typeof t).toBe("string");
    expect(t.length).toBeGreaterThan(0);
    expect(Buffer.from(j, "utf8").equals(Buffer.from(t, "utf8"))).toBe(true);
  });

  it("is byte-identical SOURCE, so the wording cannot drift", () => {
    const t = tickets.siblingScanRefusal.toString();
    const j = jira.siblingScanRefusal.toString();
    expect(Buffer.from(j, "utf8").equals(Buffer.from(t, "utf8"))).toBe(true);
  });

  it("names the parent and the underlying error, so a retry is possible", () => {
    const body = tickets.siblingScanRefusal("TEAM-4734", "Requested resource not found: parentId-index");
    expect(body).toContain("TEAM-4734");
    expect(body).toContain("Requested resource not found: parentId-index");
  });

  it("says nothing was created and that a retry is the correct response", () => {
    // The refusal's whole justification over "create it blocked": it is
    // recoverable. If it stopped saying so, an agent would treat it as terminal.
    const body = tickets.siblingScanRefusal("TEAM-4734", "throttled");
    expect(body).toContain("Nothing was created.");
    expect(body).toContain("Retry the call.");
    expect(body.startsWith("create_ticket refused:")).toBe(true);
  });
});
