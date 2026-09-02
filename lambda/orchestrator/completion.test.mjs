import { describe, it, expect } from "vitest";
import { isWorkflowComplete, missingEvidenceTickets } from "./completion.mjs";

/**
 * TEAM-3619 D4c — per-phase completion re-verify. These pin the three rules
 * (done work + approved blocking gates + no open spawned fixes), the AC-D4.3
 * open/closed-review-fix behavior, and the preserved legacy heuristic.
 */

// A software-delivery-shaped def: dev→verification→review→ship required, an
// always-on blocking Merge Approval gate after ship.
const DEF = {
  completionRequiresAgentPhases: ["development", "verification", "review", "ship"],
  reviewGates: [{ afterPhase: "ship", blocking: true, condition: "always", onReject: "rework" }],
};

// Roster phase by assignee for the tests.
const PHASE = {
  dev: "development",
  qa: "verification",
  ci: "review",
  rm: "ship",
};
const getAgentPhase = (a) => PHASE[a];

// Gate tickets in these tests carry an explicit `phase` (the guarded phase),
// so gatePhaseOf falls back to ticket.phase — no upstream lookup needed.
const opts = { getAgentPhase };

/** A fully-done run: one done agent ticket per required phase + an approved gate. */
function doneRun(extra = []) {
  return [
    { ticketId: "T-1", assignee: "dev", status: "done" },
    { ticketId: "T-2", assignee: "qa", status: "done" },
    { ticketId: "T-3", assignee: "ci", status: "done" },
    { ticketId: "T-4", assignee: "rm", status: "done" },
    { ticketId: "G-1", assignee: "human:reviewer", phase: "ship", status: "done" },
    ...extra,
  ];
}

describe("isWorkflowComplete — config-driven per-phase", () => {
  it("completes when every required phase is done and the ship gate is approved", () => {
    expect(isWorkflowComplete(doneRun(), DEF, opts)).toBe(true);
  });

  it("is not complete when a required phase has no done ticket", () => {
    const children = doneRun().filter((t) => t.ticketId !== "T-4"); // no ship ticket
    expect(isWorkflowComplete(children, DEF, opts)).toBe(false);
  });

  it("is not complete while an agent ticket in a required phase is still open", () => {
    const children = doneRun([{ ticketId: "T-5", assignee: "dev", status: "in_progress" }]);
    expect(isWorkflowComplete(children, DEF, opts)).toBe(false);
  });

  it("is not complete while the blocking ship gate is unapproved (gate ticket open)", () => {
    const children = doneRun();
    children.find((t) => t.ticketId === "G-1").status = "in_review";
    expect(isWorkflowComplete(children, DEF, opts)).toBe(false);
  });

  it("is not complete when a required blocking gate has no ticket yet", () => {
    const children = doneRun().filter((t) => t.ticketId !== "G-1");
    expect(isWorkflowComplete(children, DEF, opts)).toBe(false);
  });

  it("ignores advisory/backlog tickets outside the required phases", () => {
    // A design ticket (phase not required for completion) left open must not wedge.
    const children = doneRun([
      { ticketId: "D-9", assignee: "designer", status: "in_progress" },
    ]);
    expect(isWorkflowComplete(children, DEF, { getAgentPhase: (a) => (a === "designer" ? "design" : PHASE[a]) })).toBe(true);
  });
});

describe("isWorkflowComplete — spawned-fix routing (AC-D4.3)", () => {
  it("an OPEN review_fix routed under ship blocks completion", () => {
    // Fix assigned to a dev (natural phase development) but STAMPED phase=ship —
    // it must gate the ship phase, not development.
    const children = doneRun([
      { ticketId: "F-1", assignee: "dev", phase: "ship", status: "todo", spawnedBy: { gateTicketId: "G-1", kind: "review_fix" } },
    ]);
    expect(isWorkflowComplete(children, DEF, opts)).toBe(false);
  });

  it("the same review_fix, once DONE, unblocks completion", () => {
    const children = doneRun([
      { ticketId: "F-1", assignee: "dev", phase: "ship", status: "done", spawnedBy: { gateTicketId: "G-1", kind: "review_fix" } },
    ]);
    expect(isWorkflowComplete(children, DEF, opts)).toBe(true);
  });

  it("an open qa_fix under a required phase blocks; a cancelled one does not", () => {
    const open = doneRun([
      { ticketId: "F-2", assignee: "dev", phase: "verification", status: "in_progress", spawnedBy: { kind: "qa_fix", qaTicketId: "T-2" } },
    ]);
    expect(isWorkflowComplete(open, DEF, opts)).toBe(false);

    const cancelled = doneRun([
      { ticketId: "F-2", assignee: "dev", phase: "verification", status: "cancelled", spawnedBy: { kind: "qa_fix", qaTicketId: "T-2" } },
    ]);
    expect(isWorkflowComplete(cancelled, DEF, opts)).toBe(true);
  });

  it("tolerates legacy tickets with no spawnedBy", () => {
    const children = doneRun([{ ticketId: "L-1", assignee: "rm", status: "done" }]);
    expect(isWorkflowComplete(children, DEF, opts)).toBe(true);
  });
});

describe("isWorkflowComplete — legacy heuristic (no completionRequiresAgentPhases)", () => {
  const LEGACY = { completionRequiresAgentPhases: [] };

  it("requires a dev/qa/ci done ticket AND every child done", () => {
    const children = [
      { ticketId: "T-1", assignee: "agentcore_hub_backend_dev", status: "done" },
      { ticketId: "T-2", assignee: "agentcore_hub_requirements_analyst", status: "done" },
    ];
    expect(isWorkflowComplete(children, LEGACY, {})).toBe(true);
  });

  it("is not complete when a child is still open", () => {
    const children = [
      { ticketId: "T-1", assignee: "agentcore_hub_backend_dev", status: "done" },
      { ticketId: "T-2", assignee: "agentcore_hub_qa_verifier", status: "in_progress" },
    ];
    expect(isWorkflowComplete(children, LEGACY, {})).toBe(false);
  });

  it("is not complete with no terminal (dev/qa/ci) done ticket", () => {
    const children = [{ ticketId: "T-1", assignee: "agentcore_hub_requirements_analyst", status: "done" }];
    expect(isWorkflowComplete(children, LEGACY, {})).toBe(false);
  });
});

describe("isWorkflowComplete — guards", () => {
  it("returns false for an empty child list", () => {
    expect(isWorkflowComplete([], DEF, opts)).toBe(false);
  });
});

/**
 * TEAM-3686 F3 — the deliverable-evidence check behind the orchestrator's
 * completion path (hand-port of the route's missingEvidenceTickets; the route
 * copy is pinned by src/app/api/workflow/[id]/complete/route.test.ts). A done
 * ticket in a required phase must carry proof of work in its agentTasks entry:
 * a non-empty `output` OR an `artifactKey`. Cancelled tickets and phases the
 * def doesn't require owe nothing.
 */
describe("missingEvidenceTickets — deliverable evidence (TEAM-3686 F3)", () => {
  const REQUIRED = ["development", "verification"];
  const evOpts = { getAgentPhase };

  it("flags a done required-phase ticket with empty output and no artifact", () => {
    const children = [{ ticketId: "T-1", assignee: "dev", status: "done" }];
    const tasks = { "T-1": { ticketId: "T-1", output: "   " } };
    expect(missingEvidenceTickets(children, tasks, REQUIRED, evOpts)).toEqual([
      { ticketId: "T-1", phase: "development" },
    ]);
  });

  it("flags a done required-phase ticket with NO agentTasks entry at all", () => {
    const children = [{ ticketId: "T-1", assignee: "dev", status: "done" }];
    expect(missingEvidenceTickets(children, {}, REQUIRED, evOpts)).toEqual([
      { ticketId: "T-1", phase: "development" },
    ]);
  });

  it("accepts non-empty output as evidence", () => {
    const children = [{ ticketId: "T-1", assignee: "dev", status: "done" }];
    const tasks = { "T-1": { ticketId: "T-1", output: "opened PR #7" } };
    expect(missingEvidenceTickets(children, tasks, REQUIRED, evOpts)).toEqual([]);
  });

  it("accepts an artifactKey as evidence in place of output", () => {
    const children = [{ ticketId: "T-1", assignee: "dev", status: "done" }];
    const tasks = { "T-1": { ticketId: "T-1", output: "", artifactKey: "workflows/wf_1/x.md" } };
    expect(missingEvidenceTickets(children, tasks, REQUIRED, evOpts)).toEqual([]);
  });

  it("never flags cancelled tickets — finished-and-abandoned owes no evidence", () => {
    const children = [{ ticketId: "T-1", assignee: "dev", status: "cancelled" }];
    expect(missingEvidenceTickets(children, {}, REQUIRED, evOpts)).toEqual([]);
  });

  it("never flags tickets outside the required phases (or with unresolvable phase)", () => {
    const children = [
      { ticketId: "T-1", assignee: "rm", status: "done" }, // ship — not required here
      { ticketId: "T-2", assignee: "someone_unknown", status: "done" }, // no phase
    ];
    expect(missingEvidenceTickets(children, {}, REQUIRED, evOpts)).toEqual([]);
  });

  it("skips epics", () => {
    const children = [{ ticketId: "E-1", type: "epic", assignee: "dev", status: "done" }];
    expect(missingEvidenceTickets(children, {}, REQUIRED, evOpts)).toEqual([]);
  });

  it("an explicit phase stamp wins over the assignee's roster phase", () => {
    // Roster says verification, stamp says ship — ship isn't required, so clean.
    const children = [{ ticketId: "T-1", assignee: "qa", phase: "ship", status: "done" }];
    expect(missingEvidenceTickets(children, {}, REQUIRED, evOpts)).toEqual([]);
  });

  it("resolves agentTasks keyed by ticketId OR by task id with a ticketId field", () => {
    const children = [
      { ticketId: "T-1", assignee: "dev", status: "done" },
      { ticketId: "T-2", assignee: "qa", status: "done" },
    ];
    const tasks = {
      "T-1": { ticketId: "T-1", output: "did the work" }, // keyed by ticketId
      task_123_qa: { ticketId: "T-2", output: "verified it" }, // keyed by task id
    };
    expect(missingEvidenceTickets(children, tasks, REQUIRED, evOpts)).toEqual([]);
  });

  it("returns [] when the def requires no phases (legacy runs)", () => {
    const children = [{ ticketId: "T-1", assignee: "dev", status: "done" }];
    expect(missingEvidenceTickets(children, {}, [], evOpts)).toEqual([]);
  });
});
