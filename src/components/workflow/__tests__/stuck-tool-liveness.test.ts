import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// TEAM-3858 / TEAM-3862: the STUCK badge tripped during in-flight tool calls
// because only streamed-text growth advanced the activity clock — tool events
// were invisible to the stale computation — and the modal header derived
// "Working" from task.status alone, contradicting the STUCK footer.
// TEAM-3881 hardened the same derivation: activity clocks and verdicts are
// per agent (one busy agent can't keep a dead sibling alive), the interval
// reads the current task set via a ref, the card/modal share one status
// predicate, and page-load seeding shares the live path's liveness source.
// Behavioral coverage lives in src/lib/workflow/stale.test.ts and
// src/lib/workflow/stale-per-agent.test.ts; these assertions pin the wiring
// in the components (node-only test env, no DOM).
describe("stuck detection counts tool activity as liveness (TEAM-3858)", () => {
  const boardContent = fs.readFileSync(
    path.resolve(__dirname, "../WorkflowBoard.tsx"),
    "utf-8"
  );
  const panelContent = fs.readFileSync(
    path.resolve(__dirname, "../AgentOutputPanel.tsx"),
    "utf-8"
  );
  // The liveness gate in handleEvent: from the shared predicate to the switch.
  const gate = boardContent.match(
    /if \(isLivenessEvent\(event\.type\)\) \{[\s\S]*?\n\s*switch \(event\.type\)/
  );

  it("WorkflowBoard resets idle clocks on liveness events (tool_use/tool_end/agent_output)", () => {
    expect(boardContent).toContain('from "@/lib/workflow/stale"');
    expect(gate).not.toBeNull();
    expect(gate![0]).toContain("lastActivityRef.current = now");
  });

  it("liveness is attributed per agent — the emitting agent's clock and flags only (TEAM-3881 F1)", () => {
    expect(gate).not.toBeNull();
    expect(gate![0]).toContain("lastActivityPerAgentRef.current[agentId] = now");
    // Per-agent clear, not a global wipe: the pre-3881 gate called
    // setIsStale(false) / cleared ALL manual flags on any liveness event.
    expect(gate![0]).toContain("next.delete(agentId)");
    expect(gate![0]).not.toContain("setIsStale(false)");
    expect(gate![0]).not.toContain("new Set<string>()");
  });

  it("the interval derives per-agent verdicts from the CURRENT task set via a ref (TEAM-3881 F1/F2)", () => {
    // Interval body: everything inside setInterval up to its 15s closer.
    const interval = boardContent.match(
      /setInterval\(\(\) => \{[\s\S]*?\}, 15_000\)/
    );
    expect(interval).not.toBeNull();
    expect(interval![0]).toContain("agentTasksRef.current");
    expect(interval![0]).toContain("computeStaleAgentIds({");
    expect(interval![0]).not.toContain("state.agentTasks");
    // The ref is kept current on every render.
    expect(boardContent).toContain("agentTasksRef.current = state?.agentTasks || {}");
  });

  it("card and modal share one stale-eligible status predicate (TEAM-3881 F3)", () => {
    // Board card:
    expect(boardContent).toMatch(
      /staleAgents\.has\(agent\.agentId\) \|\| manualStaleAgents\.has\(agent\.agentId\)\) && agentTask && isStaleEligibleStatus\(agentTask\.status\)/
    );
    // Modal prop — same predicate, so a stale waiting_response task can't
    // show stale on the card but ACTIVE in the modal:
    const modalProp = boardContent.match(/isStale=\{!!expandedAgent[\s\S]*?\?\.status\)\}/);
    expect(modalProp).not.toBeNull();
    expect(modalProp![0]).toContain("staleAgents.has(expandedAgent)");
    expect(modalProp![0]).toContain("isStaleEligibleStatus(");
    expect(modalProp![0]).not.toMatch(/status === "running"/);
  });

  it("page-load seeding uses the shared liveness source (TEAM-3881 F4)", () => {
    expect(boardContent).toContain("seedLastActivityByAgent(evData.events)");
    // Seeded clocks land in the per-agent map, not only the global ref.
    expect(boardContent).toMatch(
      /lastActivityPerAgentRef\.current\[agentId\] = seededActivity\[agentId\]/
    );
  });

  it("modal header cannot say Working (or raw status) while the footer says STUCK", () => {
    // Header label and style branch on the same isStale flag as the footer,
    // under the same running-or-waiting predicate (TEAM-3881 F3).
    expect(panelContent).toMatch(
      /isStale && \(task\?\.status === "running" \|\| task\?\.status === "waiting_response"\)/
    );
    expect(panelContent).toMatch(/isStalledLive\s*\?\s*"Stalled"/);
    expect(panelContent).toMatch(/isStalledLive\s*\?\s*"error"/);
  });
});
