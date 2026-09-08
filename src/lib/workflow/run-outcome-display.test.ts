import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  NO_OP_OUTCOMES,
  SHIP_BLOCKED_OUTCOMES,
  TERMINAL_PHASES,
} from "./types";
import {
  describeOrchestratorEvent,
  describeRunOutcome,
  isNoOpPhase,
} from "./run-outcome-display";

/**
 * TEAM-4249 D2.9 — the console's terminal-outcome vocabulary.
 *
 * The point of the helper is that a run which closes on ANY terminal outcome
 * reads as finished, in one place, with strings the two rendering surfaces share.
 * So the central assertion here is derived, not enumerated: every member of
 * TERMINAL_PHASES must produce `finished: true` and a non-empty label. Adding a
 * seventh outcome to types.ts fails this suite (and `tsc`, via the
 * Record<TerminalPhase,…> table) rather than silently rendering as
 * "In Progress: <slug>".
 */

const NOTHING_TO_REMOVE = NO_OP_OUTCOMES[0];

describe("describeRunOutcome — terminal outcomes", () => {
  it("renders each terminal outcome with its exact label, text and tone", () => {
    expect(describeRunOutcome("complete")).toEqual({
      label: "Complete",
      text: "Workflow finished successfully!",
      tone: "complete",
      finished: true,
    });
    expect(describeRunOutcome("error")).toEqual({
      label: "Error",
      text: "Workflow encountered an error.",
      tone: "error",
      finished: true,
    });
    expect(describeRunOutcome("cancelled")).toEqual({
      label: "Cancelled",
      text: "Workflow was cancelled.",
      tone: "cancelled",
      finished: true,
    });
    expect(describeRunOutcome("deploy-blocked")).toEqual({
      label: "Deploy Blocked",
      text: "CI passed but the deploy/preflight was blocked — nothing shipped.",
      tone: "ship-blocked",
      finished: true,
    });
    expect(describeRunOutcome("static-ci-only")).toEqual({
      label: "CI-Only (Not Shipped)",
      text: "CI was green but no merge/deploy happened — work is not shipped.",
      tone: "ship-blocked",
      finished: true,
    });
    expect(describeRunOutcome(NOTHING_TO_REMOVE)).toEqual({
      label: "Nothing to Remove",
      text: "The sweep verified there was nothing safe to remove — no changes were made.",
      tone: "no-op",
      finished: true,
    });
  });

  it("EVERY member of TERMINAL_PHASES is finished with a label (derived, not listed)", () => {
    for (const phase of TERMINAL_PHASES) {
      const outcome = describeRunOutcome(phase);
      expect(outcome.finished, `${phase} must read as finished`).toBe(true);
      expect(outcome.label, `${phase} must have a header label`).toBeTruthy();
      expect(outcome.text, `${phase} must have explanatory text`).toBeTruthy();
      expect(outcome.tone).not.toBe("running");
    }
  });

  it("the ship-blocked and no-op outcomes carry DIFFERENT tones (a no-op is not a block)", () => {
    for (const o of SHIP_BLOCKED_OUTCOMES) {
      expect(describeRunOutcome(o).tone).toBe("ship-blocked");
    }
    for (const o of NO_OP_OUTCOMES) {
      expect(describeRunOutcome(o).tone).toBe("no-op");
    }
  });
});

describe("describeRunOutcome — complete with open fix-it tickets", () => {
  it("is NOT finished and has no label, so the board keeps naming the working phase", () => {
    const outcome = describeRunOutcome("complete", { hasOpenTickets: true });
    expect(outcome.finished).toBe(false);
    expect(outcome.label).toBeNull();
    // Tone stays "complete" — isComplete is `tone === "complete" && finished`,
    // which reproduces the board's old `phase === "complete" && !hasOpenTickets`.
    expect(outcome.tone).toBe("complete");
  });

  it("is finished when there are no open tickets (explicit false and omitted)", () => {
    expect(describeRunOutcome("complete", { hasOpenTickets: false }).finished).toBe(true);
    expect(describeRunOutcome("complete", {}).finished).toBe(true);
    expect(describeRunOutcome("complete").label).toBe("Complete");
  });

  it("hasOpenTickets does not un-finish any OTHER terminal outcome", () => {
    for (const phase of TERMINAL_PHASES) {
      if (phase === "complete") continue;
      expect(describeRunOutcome(phase, { hasOpenTickets: true }).finished).toBe(true);
    }
  });
});

describe("describeRunOutcome — non-terminal and unknown phases", () => {
  it("reads as running with no label", () => {
    for (const phase of ["intake", "requirements", "design", "development", "verification", "review", "ship"]) {
      const outcome = describeRunOutcome(phase);
      expect(outcome).toEqual({ label: null, text: "", tone: "running", finished: false });
    }
  });

  it("treats null / undefined / empty / legacy values as running (no crash)", () => {
    for (const phase of [null, undefined, "", "bogus", "COMPLETE"]) {
      const outcome = describeRunOutcome(phase);
      expect(outcome.finished).toBe(false);
      expect(outcome.tone).toBe("running");
      expect(outcome.label).toBeNull();
    }
  });
});

describe("isNoOpPhase", () => {
  it("is true for every NO_OP_OUTCOMES member and false for everything else", () => {
    for (const o of NO_OP_OUTCOMES) expect(isNoOpPhase(o)).toBe(true);
    for (const o of SHIP_BLOCKED_OUTCOMES) expect(isNoOpPhase(o)).toBe(false);
    for (const p of ["complete", "error", "cancelled", "development", "ship", "", "bogus"]) {
      expect(isNoOpPhase(p)).toBe(false);
    }
    expect(isNoOpPhase(null)).toBe(false);
    expect(isNoOpPhase(undefined)).toBe(false);
  });
});

describe("describeOrchestratorEvent — orchestrator.completion_blocked", () => {
  // Payload shape from lambda/orchestrator/index.mjs (publishEvent
  // "orchestrator.completion_blocked"), flattened by transform-event.ts.
  const event = {
    type: "orchestrator.completion_blocked",
    workflowId: "wf-1",
    reason: "head-divergence",
    heads: { qa: "933ea6f", ci: "933ea6f", pr: "001259d" },
    offenders: [],
    mode: "enforce",
    timestamp: "2026-09-08T00:00:00.000Z",
  };

  it("does NOT close the run (phase null) — completion was refused, not finished", () => {
    const d = describeOrchestratorEvent(event);
    expect(d).not.toBeNull();
    expect(d!.phase).toBeNull();
    expect(d!.tone).toBe("ship-blocked");
    expect(d!.text).toContain("Completion blocked");
    expect(d!.text).toContain("verified");
  });

  it("names the offenders for the open-fix reason", () => {
    const d = describeOrchestratorEvent({
      ...event,
      reason: "open-fix",
      offenders: ["TEAM-4101", "TEAM-4102"],
    });
    expect(d!.text).toContain("fix tickets are still open");
    expect(d!.text).toContain("2");
    expect(d!.text).toContain("TEAM-4101");
    expect(d!.text).toContain("TEAM-4102");
  });

  it("falls back to the raw slug for an unmapped reason, and never renders undefined", () => {
    const unmapped = describeOrchestratorEvent({ ...event, reason: "some-new-reason" });
    expect(unmapped!.text).toContain("some-new-reason");
    const missing = describeOrchestratorEvent({ type: "orchestrator.completion_blocked" });
    expect(missing!.text).toBe("Completion blocked — reason not reported");
    expect(missing!.text).not.toContain("undefined");
  });
});

describe("describeOrchestratorEvent — workflow.skipped", () => {
  // Payload from src/app/api/workflow/start/route.ts (writeSweepEvent), with the
  // evidence shapes from ./sweep-cadence.
  it("explains a recent-sweep skip without setting a phase (tombstone, never ran)", () => {
    const d = describeOrchestratorEvent({
      type: "workflow.skipped",
      workflowId: "wf-skip-1",
      reason: "recent-sweep",
      evidence: {
        repo: "tycenjmccann/agentcore-hub",
        lastRunId: "wf-prev",
        lastRunAt: "2026-09-05T00:00:00.000Z",
        ageDays: 3,
        minIntervalDays: 7,
        runsConsidered: 4,
        prProbe: { probed: true },
      },
      repo: "tycenjmccann/agentcore-hub",
      defId: "dead-code-sweep",
      mode: "enforce",
    });
    expect(d!.phase).toBeNull();
    expect(d!.tone).toBe("cancelled");
    expect(d!.text).toContain("Run skipped");
    expect(d!.text).toContain("minimum interval");
    expect(d!.text).toContain("tycenjmccann/agentcore-hub");
  });

  it("explains an open-sweep-pr skip", () => {
    const d = describeOrchestratorEvent({
      type: "workflow.skipped",
      reason: "open-sweep-pr",
      evidence: {
        repo: "tycenjmccann/agentcore-hub",
        pr: 428,
        url: "https://github.com/tycenjmccann/agentcore-hub/pull/428",
        headRef: "feature/sweep",
        title: "chore: dead-code sweep",
        prProbe: { probed: true },
      },
      repo: "tycenjmccann/agentcore-hub",
    });
    expect(d!.phase).toBeNull();
    expect(d!.text).toContain("sweep PR is still open");
  });
});

describe("describeOrchestratorEvent — workflow.nothing_to_remove", () => {
  const base = {
    type: "workflow.nothing_to_remove",
    workflowId: "wf-noop-1",
    outcome: NOTHING_TO_REMOVE,
    verifiedRemovable: 0,
    prUrl: "",
    featureBranch: "",
  };

  it("is the ONE new event that closes the run, onto the no-op phase", () => {
    const d = describeOrchestratorEvent({ ...base, candidates: 7 });
    expect(d!.phase).toBe(NOTHING_TO_REMOVE);
    expect(d!.tone).toBe("no-op");
    expect(d!.text).toBe("Nothing to remove — 0 of 7 candidates verified removable.");
  });

  it("singularizes one candidate and copes with a null / non-integer count", () => {
    expect(describeOrchestratorEvent({ ...base, candidates: 1 })!.text).toBe(
      "Nothing to remove — 0 of 1 candidate verified removable."
    );
    for (const candidates of [null, undefined, 2.5, "7", {}]) {
      const d = describeOrchestratorEvent({ ...base, candidates });
      expect(d!.phase).toBe(NOTHING_TO_REMOVE);
      expect(d!.text).toBe(
        "Nothing to remove — the sweep verified no candidate was safely removable."
      );
    }
  });
});

describe("describeOrchestratorEvent — everything else returns null", () => {
  it("ignores every member of the closed WorkflowEvent union (they keep their own cases)", () => {
    const known = [
      { type: "phase_change", phase: "design" },
      { type: "agent_output", agentId: "dev-1", chunk: "…" },
      { type: "agent_status", agentId: "dev-1", status: "running" },
      { type: "tool_use", agentId: "dev-1", toolName: "Tickets___update" },
      { type: "workflow_complete" },
      { type: "manager_intervention", action: "nudge" },
      { type: "manager_escalation", message: "…" },
      { type: "error", error: "boom" },
      { type: "nudge", nudged: 1 },
    ];
    for (const event of known) expect(describeOrchestratorEvent(event)).toBeNull();
  });

  it("ignores malformed input without throwing", () => {
    for (const raw of [null, undefined, 42, "str", [], [{ type: "workflow.skipped" }], {}, { type: 123 }, { type: null }, true]) {
      expect(describeOrchestratorEvent(raw)).toBeNull();
    }
  });
});

describe("describeOrchestratorEvent — untrusted Lambda fields are sanitized", () => {
  it("clamps the notice to 240 chars", () => {
    const d = describeOrchestratorEvent({
      type: "orchestrator.completion_blocked",
      reason: "x".repeat(5000),
      offenders: Array.from({ length: 200 }, (_, i) => `TEAM-${i}`),
    });
    expect(d!.text.length).toBeLessThanOrEqual(240);
    expect(d!.text.endsWith("…")).toBe(true);
  });

  it("strips control characters and ANSI escapes, and collapses whitespace", () => {
    const d = describeOrchestratorEvent({
      type: "workflow.skipped",
      reason: "line1\n\u001b[31mred\u001b[0m\tline2",
      repo: "owner/repo ",
    });
    expect(d!.text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(d!.text).not.toContain("  ");
    expect(d!.text).toContain("line1");
    expect(d!.text).toContain("owner/repo");
  });

  it("never leaks undefined / [object Object] from non-string fields", () => {
    const d = describeOrchestratorEvent({
      type: "workflow.skipped",
      reason: { nested: true },
      repo: ["a", "b"],
    });
    expect(d!.text).not.toContain("undefined");
    expect(d!.text).not.toContain("[object Object]");
    expect(d!.text).toBe("Run skipped — reason not reported");
  });
});

/**
 * Source-content parity (the WorkflowBoard convention — TEAM-2141): the whole
 * reason the helper exists is that two surfaces render this vocabulary. These
 * assertions fail if a future edit re-hardcodes an outcome string in a component
 * instead of reading it from here.
 */
describe("the rendering surfaces consume this helper", () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf-8");

  it("PipelineVisualization's pre-existing outcome strings still match the helper exactly", () => {
    const viz = read("../../components/workflow/PipelineVisualization.tsx");
    for (const phase of ["complete", "error", "deploy-blocked", "static-ci-only"] as const) {
      const d = describeRunOutcome(phase);
      expect(viz, `${phase} drifted from run-outcome-display`).toContain(
        `{ label: "${d.label}", text: "${d.text}" }`
      );
    }
  });

  it("PipelineVisualization handles the no-op outcome instead of falling through to Idle", () => {
    const viz = read("../../components/workflow/PipelineVisualization.tsx");
    expect(viz).toContain(`case "${NOTHING_TO_REMOVE}":`);
    expect(viz).toContain("describeRunOutcome");
  });

  it("WorkflowBoard derives its header + gates from the helper", () => {
    const board = read("../../components/workflow/WorkflowBoard.tsx");
    expect(board).toContain("describeRunOutcome(state?.phase");
    expect(board).toContain("isNoOpPhase(state.phase)");
    expect(board).toContain("describeOrchestratorEvent");
    // The old hand-rolled ship-blocked-only chain is gone.
    expect(board).not.toContain("shipBlockedLabel");
  });

  it("the workflow list sorts and dots the no-op outcome via the shared predicates", () => {
    const page = read("../../app/workflow/page.tsx");
    expect(page).toContain("isNoOpPhase(workflow.phase)");
    // Both comparators route through the shared terminal predicate.
    expect(page).not.toContain('a.phase !== "complete"');
    expect(page).not.toContain('b.phase !== "complete"');
  });
});
