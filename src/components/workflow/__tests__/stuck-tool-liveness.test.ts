import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// TEAM-3858 / TEAM-3862: the STUCK badge tripped during in-flight tool calls
// because only streamed-text growth advanced lastActivityRef — tool events
// were invisible to the stale computation — and the modal header derived
// "Working" from task.status alone, contradicting the STUCK footer.
// Behavioral coverage of the verdict itself lives in src/lib/workflow/stale.test.ts;
// these assertions pin the wiring in the components (node-only test env, no DOM).
describe("stuck detection counts tool activity as liveness (TEAM-3858)", () => {
  const boardContent = fs.readFileSync(
    path.resolve(__dirname, "../WorkflowBoard.tsx"),
    "utf-8"
  );
  const panelContent = fs.readFileSync(
    path.resolve(__dirname, "../AgentOutputPanel.tsx"),
    "utf-8"
  );

  it("WorkflowBoard resets the idle clock on liveness events (tool_use/tool_end/agent_output)", () => {
    expect(boardContent).toContain('from "@/lib/workflow/stale"');
    // The live SSE handler must gate on the shared liveness predicate and
    // advance lastActivityRef + clear staleness inside that gate.
    const gate = boardContent.match(
      /if \(isLivenessEvent\(event\.type\)\) \{[\s\S]*?\}/
    );
    expect(gate).not.toBeNull();
    expect(gate![0]).toContain("lastActivityRef.current = Date.now()");
    expect(gate![0]).toContain("setIsStale(false)");
  });

  it("WorkflowBoard derives the stale verdict from the shared helper", () => {
    expect(boardContent).toContain("computeIsStale({");
    expect(boardContent).toContain("staleThresholdFor(");
  });

  it("modal header cannot say Working while the footer says STUCK", () => {
    // Header label and style must branch on the same isStale flag the footer uses.
    expect(panelContent).toMatch(/isStale \? "Stalled" : "Working"/);
    expect(panelContent).toMatch(/isStale \? "error" : "running"/);
  });
});
