import { describe, it, expect } from "vitest";
import {
  isWorkflowComplete,
  missingEvidenceTickets,
  shipVerdictOf,
  evaluateShipVerdict,
  SHIP_BLOCKED_OUTCOMES,
  SHIP_SATISFIED_VERDICTS,
  HARVESTED_SHIP_OUTCOMES,
  harvestableShipOutcome,
  SHIP_PHASES,
  TERMINAL_WORKFLOW_PHASES,
  notTerminalPhaseGuard,
  completionRecordHasEvidence,
  evidenceBackfillFields,
  resolveMissingEvidenceFromRecords,
  FIX_KINDS,
  REWORK_FIX_KINDS,
  isAdvisoryTicket,
  advisoryNeverApplies,
  isHumanGateTicket,
  deliveryRollUp,
  FOLLOWUP_LABEL_RE,
  FOLLOWUP_TITLE_RE,
} from "./completion.mjs";

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

  /**
   * TEAM-4121 FR-8 — the two kind sets are PARITY MIRRORS of fix-contract.mjs
   * (this file cannot import it: completion.mjs is loaded by the orchestrator
   * bundle and by the tests, but the kinds must also be known to two ticket
   * Lambdas that ship separately). check-fix-kinds-parity.sh guards the copies;
   * this pins the semantics of the split.
   */
  it("FIX_KINDS gates completion for all six kinds; REWORK_FIX_KINDS escalates for only four", () => {
    expect([...FIX_KINDS]).toEqual(["review_fix", "qa_fix", "codex_fix", "ship_fix", "ci_fix", "sync_fix"]);
    expect([...REWORK_FIX_KINDS]).toEqual(["review_fix", "qa_fix", "codex_fix", "ship_fix"]);
    // The difference is exactly the environmental pair — the kinds a run must
    // wait for but must not be escalated to a human over.
    expect([...FIX_KINDS].filter((k) => !REWORK_FIX_KINDS.has(k))).toEqual(["ci_fix", "sync_fix"]);
  });

  it("an open ci_fix holds the gate even though it never trips the rework cap", () => {
    const open = doneRun([
      { ticketId: "F-3", assignee: "dev", phase: "review", status: "todo", spawnedBy: { kind: "ci_fix", ciTicketId: "T-9" } },
    ]);
    expect(isWorkflowComplete(open, DEF, opts)).toBe(false);

    const done = doneRun([
      { ticketId: "F-3", assignee: "dev", phase: "review", status: "done", spawnedBy: { kind: "ci_fix", ciTicketId: "T-9" } },
    ]);
    expect(isWorkflowComplete(done, DEF, opts)).toBe(true);
  });

  it("an open sync_fix holds the gate too", () => {
    const open = doneRun([
      { ticketId: "F-4", assignee: "dev", phase: "ship", status: "in_progress", spawnedBy: { kind: "sync_fix", ciTicketId: "T-9" } },
    ]);
    expect(isWorkflowComplete(open, DEF, opts)).toBe(false);
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
 * TEAM-4453 D1 — the operator run, hub-materialized. Its whole skeleton now
 * exists from the first second (build → Merge Approval → ship), so completion is
 * asked the question on a child list that is fully populated and mostly OPEN —
 * the opposite of the agent-mode runs above, where a phase's ticket does not
 * exist until the upstream agent creates it. One persona (phase "development")
 * owns both agent tickets, so the ship ticket is only recognized as the ship
 * phase through its hub-stamped `phase` — the same stamp the dispatcher reads.
 */
describe("isWorkflowComplete — hub-materialized operator skeleton", () => {
  const OPERATOR_DEF = {
    completionRequiresAgentPhases: ["development", "ship"],
    reviewGates: [{ afterPhase: "development", blocking: true, condition: "always", onReject: "rework" }],
  };
  // The def's ship phase is stripped for a handoff (cd-registry.mjs), and the
  // hub's planner plans no ship ticket to match.
  const HANDOFF_DEF = {
    completionRequiresAgentPhases: ["development"],
    reviewGates: OPERATOR_DEF.reviewGates,
  };
  const OP = "agentcore_hub_operator";
  const operatorOpts = { getAgentPhase: (a) => (a === OP ? "development" : undefined) };

  const build = (status) => ({ ticketId: "TEAM-101", assignee: OP, phase: "development", status });
  const gate = (status) => ({ ticketId: "TEAM-102", assignee: "human:engineer", phase: "development", status });
  const ship = (status) => ({ ticketId: "TEAM-103", assignee: OP, phase: "ship", status });

  it("build done, gate still open → not complete", () => {
    expect(isWorkflowComplete([build("done"), gate("in_review"), ship("blocked")], OPERATOR_DEF, operatorOpts)).toBe(false);
  });

  it("build done, gate approved, ship still open → not complete", () => {
    expect(isWorkflowComplete([build("done"), gate("done"), ship("todo")], OPERATOR_DEF, operatorOpts)).toBe(false);
  });

  it("build done, gate approved, NO ship ticket at all → not complete", () => {
    expect(isWorkflowComplete([build("done"), gate("done")], OPERATOR_DEF, operatorOpts)).toBe(false);
  });

  it("build done, gate approved, ship done → complete", () => {
    expect(isWorkflowComplete([build("done"), gate("done"), ship("done")], OPERATOR_DEF, operatorOpts)).toBe(true);
  });

  it("a handoff run (ship stripped from the def) completes on build + gate alone", () => {
    expect(isWorkflowComplete([build("done"), gate("done")], HANDOFF_DEF, operatorOpts)).toBe(true);
  });
});

/**
 * Advisory tickets: out-of-scope work the reviewers file as backlog. The label
 * is the only marker; a fix ticket or a human gate is never advisory
 * (TEAM-4131 F2). Completion no longer routes on it (DL-009) — these pin the
 * classifier the blueprints and ticket Lambdas still rely on.
 */
describe("advisory ticket classification", () => {
  it("(e) isAdvisoryTicket: the exact label word, any case/whitespace — nothing else", () => {
    expect(isAdvisoryTicket({ labels: ["Advisory"] })).toBe(true);
    expect(isAdvisoryTicket({ labels: [" advisory "] })).toBe(true);
    expect(isAdvisoryTicket({ labels: ["human-review", "ADVISORY"] })).toBe(true);
    expect(isAdvisoryTicket({ labels: ["advisory-ish"] })).toBe(false);
    expect(isAdvisoryTicket({ labels: ["ci:uncertifiable"] })).toBe(false);
    expect(isAdvisoryTicket({ labels: [] })).toBe(false);
    expect(isAdvisoryTicket({ labels: "advisory" })).toBe(false); // a string is not a label list
    expect(isAdvisoryTicket({})).toBe(false);
    expect(isAdvisoryTicket(null)).toBe(false);
    expect(isAdvisoryTicket(undefined)).toBe(false);
  });

  it("(f) TEAM-4131 F2 — advisoryNeverApplies / isAdvisoryTicket on the reserved shapes", () => {
    for (const kind of FIX_KINDS) {
      expect(advisoryNeverApplies({ spawnedBy: { kind } }), kind).toBe(true);
      expect(isAdvisoryTicket({ labels: ["advisory"], spawnedBy: { kind } }), kind).toBe(false);
    }
    expect(advisoryNeverApplies({ assignee: "human:reviewer" })).toBe(true);
    expect(isAdvisoryTicket({ labels: ["ADVISORY"], assignee: "human:approver" })).toBe(false);
    // …and nothing else is reserved: an ordinary ticket is unaffected.
    expect(advisoryNeverApplies({ assignee: "dev" })).toBe(false);
    expect(advisoryNeverApplies({ spawnedBy: { kind: "review_fixx" } })).toBe(false);
    expect(advisoryNeverApplies({ spawnedBy: "review_fix" })).toBe(false); // not an object
    expect(advisoryNeverApplies({})).toBe(false);
    expect(advisoryNeverApplies(null)).toBe(false);
    expect(isAdvisoryTicket({ labels: ["advisory"], assignee: "dev" })).toBe(true);
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

  it("never flags a done HUMAN gate stamped into a required phase (hub-materialized Merge Approval, wf cnyl86/TEAM-4538)", () => {
    // intake-materialize.ts labels the gate `phase:<afterPhase>`; approving it is its
    // whole deliverable and no completions/<gate>.json ever exists for it.
    const children = [
      { ticketId: "T-1", assignee: "dev", status: "done", phase: "development" },
      { ticketId: "G-1", assignee: "human:engineer", status: "done", phase: "development", labels: ["human-review", "phase:development"] },
    ];
    const tasks = { "T-1": { ticketId: "T-1", output: "opened PR #578" } };
    expect(missingEvidenceTickets(children, tasks, REQUIRED, evOpts)).toEqual([]);
  });

  it("recognises a human gate by the human-review label alone (assignee lost/null)", () => {
    const children = [{ ticketId: "G-1", assignee: null, status: "done", phase: "development", labels: ["human-review"] }];
    expect(missingEvidenceTickets(children, {}, REQUIRED, evOpts)).toEqual([]);
    expect(isHumanGateTicket({ assignee: "human:x" })).toBe(true);
    expect(isHumanGateTicket({ labels: ["HUMAN-REVIEW"] })).toBe(true);
    expect(isHumanGateTicket({ assignee: "dev", labels: ["phase:development"] })).toBe(false);
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

/**
 * TEAM-3747 D2 — the ship/CD MERGE-VERDICT gate: "no green close over unshipped
 * work". The crucial difference from missingEvidenceTickets above: for a ship-phase
 * ticket, "done + non-empty output" is NOT proof the work shipped. Only a merge
 * commit / deploy verdict is — or an EXPLICIT terminal block, which is an
 * acceptable (honest) outcome but still NOT a completion.
 */
const SHIP = ["ship"];

/** The agentTasks map for a fully-done run, with the ship entry under test. */
const tasksWithShip = (shipEntry) => ({
  "T-1": { ticketId: "T-1", output: "implemented" },
  "T-2": { ticketId: "T-2", output: "verified" },
  "T-3": { ticketId: "T-3", output: "ci green" },
  "T-4": { ticketId: "T-4", ...shipEntry },
});

describe("shipVerdictOf — one harvested ship entry (TEAM-3747 D2)", () => {
  it("a merge commit IS the positive verdict", () => {
    expect(shipVerdictOf({ ticketId: "T-4", mergeCommit: "9f1c2ab" })).toBe("shipped");
  });

  it("TEAM-3755 F1: a commit sha ALONE is NOT a merge verdict", () => {
    // This assertion is inverted from its original form on purpose. commitSha is
    // harvested from record.commit_sha on EVERY dev/ship completion record and is
    // the HEAD of the still-unmerged feature branch — accepting it as "shipped"
    // is exactly what let a run close "complete" over work that never landed
    // (the 29g73c failure; FR-D2.2 / AC-D2.4). Only a merge commit or the
    // release manager's explicit outcome proves the merge.
    expect(shipVerdictOf({ ticketId: "T-4", commitSha: "abc1234" })).toBeNull();
  });

  it("TEAM-3755 F1: a commit sha alongside a real merge commit still ships", () => {
    // The realistic shape of a landed release record — both fields present. The
    // narrowing must not lose the positive case.
    expect(shipVerdictOf({ ticketId: "T-4", commitSha: "abc1234", mergeCommit: "9f1c2ab" }))
      .toBe("shipped");
  });

  it('an explicit outcome "shipped" counts even with no commit recorded', () => {
    expect(shipVerdictOf({ outcome: "shipped" })).toBe("shipped");
  });

  it('an explicit "deploy-blocked" outcome is its own terminal verdict', () => {
    expect(shipVerdictOf({ outcome: "deploy-blocked", blockReason: "preflight failed" }))
      .toBe("deploy-blocked");
  });

  it("outcome matching is case/whitespace tolerant (agents write prose-ish fields)", () => {
    expect(shipVerdictOf({ outcome: "  Deploy-Blocked " })).toBe("deploy-blocked");
    expect(shipVerdictOf({ outcome: "STATIC-CI-ONLY" })).toBe("static-ci-only");
  });

  it('TEAM-4739: "empty_sweep" is a SHIPPED verdict, not a blocked one', () => {
    // "there was nothing to merge" is a finished run. If it were blocked the run
    // would sit in unfinished work forever and page a human about a success.
    expect(shipVerdictOf({ outcome: "empty_sweep" })).toBe("shipped");
    expect(shipVerdictOf({ outcome: "  Empty_Sweep " })).toBe("shipped");
    expect(SHIP_BLOCKED_OUTCOMES).not.toContain("empty_sweep");
  });

  it("output/artifactKey are NOT a merge verdict — the whole point of the gate", () => {
    expect(
      shipVerdictOf({
        ticketId: "T-4",
        output: "All CI checks are green and the release notes are written.",
        artifactKey: "workflows/wf_1/shared/ship.md",
      })
    ).toBeNull();
  });

  it("whitespace-only merge fields prove nothing", () => {
    expect(shipVerdictOf({ mergeCommit: "   ", commitSha: "" })).toBeNull();
  });

  it("AC-D2.5: a legacy entry with no ship fields at all classifies as null (no verdict)", () => {
    expect(shipVerdictOf({ id: "task_1", ticketId: "T-4", agentId: "rm", status: "complete", output: "done" }))
      .toBeNull();
  });

  it("an unknown outcome value is default-handled — never trusted as shipped", () => {
    expect(shipVerdictOf({ outcome: "banana" })).toBeNull();
    // …but a real merge commit still wins regardless of the unknown label.
    expect(shipVerdictOf({ outcome: "banana", mergeCommit: "9f1c2ab" })).toBe("shipped");
  });

  it("guards: a missing / non-object entry has no verdict", () => {
    expect(shipVerdictOf(undefined)).toBeNull();
    expect(shipVerdictOf(null)).toBeNull();
    expect(shipVerdictOf("shipped")).toBeNull();
  });
});

describe("evaluateShipVerdict — run-level verdict (TEAM-3747 D2)", () => {
  it("a done ship ticket WITH a merge commit ships the run", () => {
    const v = evaluateShipVerdict(doneRun(), tasksWithShip({ mergeCommit: "9f1c2ab", prUrl: "https://github.com/o/r/pull/7" }), SHIP, opts);
    expect(v).toEqual({ required: true, shipped: true, outcome: null, blockReason: null, offenders: [] });
  });

  it("AC-D2.4: a done ship ticket with only output/artifact has NO verdict → static-ci-only", () => {
    const v = evaluateShipVerdict(
      doneRun(),
      tasksWithShip({ output: "CI green, PR open", artifactKey: "workflows/wf_1/shared/ship.md" }),
      SHIP,
      opts
    );
    expect(v).toEqual({
      required: true,
      shipped: false,
      outcome: "static-ci-only",
      blockReason: null,
      offenders: [{ ticketId: "T-4", phase: "ship", verdict: "none" }],
    });
  });

  it("FR-D2.1: a CD ticket that recorded a preflight/deploy BLOCK is not done-with-verdict", () => {
    const v = evaluateShipVerdict(
      doneRun(),
      tasksWithShip({
        output: "deploy preflight failed",
        outcome: "deploy-blocked",
        blockReason: "preflight: required status check cd/deploy is failing — refusing to merge",
      }),
      SHIP,
      opts
    );
    // An explicit block is an ACCEPTABLE terminal outcome — but never a completion.
    expect(v.required).toBe(true);
    expect(v.shipped).toBe(false);
    expect(v.outcome).toBe("deploy-blocked");
    expect(v.blockReason).toContain("refusing to merge");
    expect(v.offenders).toEqual([{ ticketId: "T-4", phase: "ship", verdict: "deploy-blocked" }]);
  });

  it("deploy-blocked outranks static-ci-only across multiple ship tickets", () => {
    const children = doneRun([{ ticketId: "T-5", assignee: "rm", status: "done" }]);
    const tasks = {
      ...tasksWithShip({ output: "nothing merged" }), // T-4 → no verdict
      "T-5": { ticketId: "T-5", outcome: "deploy-blocked", blockReason: "IAM AccessDenied on the deploy role" },
    };
    const v = evaluateShipVerdict(children, tasks, SHIP, opts);
    expect(v.outcome).toBe("deploy-blocked");
    expect(v.blockReason).toBe("IAM AccessDenied on the deploy role");
    expect(v.offenders).toHaveLength(2);
  });

  it("an explicit static-ci-only outcome is itself a blocked verdict (not shipped)", () => {
    const v = evaluateShipVerdict(doneRun(), tasksWithShip({ outcome: "static-ci-only" }), SHIP, opts);
    expect(v.shipped).toBe(false);
    expect(v.outcome).toBe("static-ci-only");
    expect(v.offenders).toEqual([{ ticketId: "T-4", phase: "ship", verdict: "static-ci-only" }]);
  });

  it('TEAM-4739: an empty_sweep ship entry ships the run with no offenders', () => {
    const v = evaluateShipVerdict(doneRun(), tasksWithShip({ outcome: "empty_sweep" }), SHIP, opts);
    expect(v).toEqual({ required: true, shipped: true, outcome: null, blockReason: null, offenders: [] });
  });

  it("resolves the ship entry keyed by task id with a ticketId field", () => {
    const tasks = { task_9_rm: { ticketId: "T-4", mergeCommit: "9f1c2ab" } };
    expect(evaluateShipVerdict(doneRun(), tasks, SHIP, opts).shipped).toBe(true);
  });

  it("human ship GATES owe no merge verdict — with no agent ship ticket it stays green", () => {
    // doneRun minus T-4 leaves only the human gate G-1 in the ship phase: nothing
    // to inspect, so the gate cannot prove a phantom (required, still shipped).
    const children = doneRun().filter((t) => t.ticketId !== "T-4");
    expect(evaluateShipVerdict(children, {}, SHIP, opts)).toEqual({
      required: true, shipped: true, outcome: null, blockReason: null, offenders: [],
    });
  });

  it("a ship ticket that is not done yet is not inspected", () => {
    const children = doneRun();
    children.find((t) => t.ticketId === "T-4").status = "in_review";
    expect(evaluateShipVerdict(children, {}, SHIP, opts).shipped).toBe(true);
  });

  it("skips epics", () => {
    const children = [{ ticketId: "E-1", type: "epic", assignee: "rm", status: "done" }];
    expect(evaluateShipVerdict(children, {}, SHIP, opts).shipped).toBe(true);
  });

  it("an explicit phase stamp routes any assignee's ticket into the ship gate", () => {
    // A dev-assigned CD ticket STAMPED phase=ship owes the merge verdict too.
    const children = [{ ticketId: "CD-1", assignee: "dev", phase: "ship", status: "done" }];
    const v = evaluateShipVerdict(children, { "CD-1": { ticketId: "CD-1", output: "ran the deploy" } }, SHIP, opts);
    expect(v.shipped).toBe(false);
    expect(v.offenders).toEqual([{ ticketId: "CD-1", phase: "ship", verdict: "none" }]);
  });

  it("accepts shipPhases as a Set (SHIP_PHASES) as well as an array", () => {
    const v = evaluateShipVerdict(doneRun(), tasksWithShip({ output: "no merge" }), SHIP_PHASES, opts);
    expect(v.outcome).toBe("static-ci-only");
  });

  it("a null agentTasks map is treated as empty, not a crash", () => {
    const v = evaluateShipVerdict(doneRun(), null, SHIP, opts);
    expect(v.offenders).toEqual([{ ticketId: "T-4", phase: "ship", verdict: "none" }]);
  });

  it("guards: a non-array children list is inert", () => {
    expect(evaluateShipVerdict(undefined, {}, SHIP, opts)).toEqual({
      required: false, shipped: true, outcome: null, blockReason: null, offenders: [],
    });
  });

  it("AC-D2.4 pairing: the phase checks pass — the SHIP GATE is what refuses", () => {
    // isWorkflowComplete has no merge-verdict logic (by design: it answers "is the
    // work finished"), so a phantom ship close is caught only by this gate. This
    // pairing is the regression that lets a green close over unshipped work through
    // if the gate is ever dropped from completeWorkflow / the complete route.
    const children = doneRun();
    const tasks = tasksWithShip({ output: "release notes written" });
    expect(isWorkflowComplete(children, DEF, opts)).toBe(true);
    expect(evaluateShipVerdict(children, tasks, SHIP, opts).shipped).toBe(false);
  });
});

/**
 * TEAM-3747 AC-D2.5 — backwards compatibility. An OLD-shape workflow record (no
 * mergeCommit/outcome/blockReason anywhere in agentTasks) under an OLD def (no
 * "ship" among the completion-required phases) must deserialize and evaluate
 * EXACTLY as it did before D2: the ship gate is inert, and the legacy complete
 * path is unchanged. Unknown/unrecognized outcome values are default-handled.
 */
describe("AC-D2.5 — legacy records evaluate exactly as before D2", () => {
  // A pre-D2 software-delivery def: dev → verification → review, no ship phase,
  // no review gates (the shape FALLBACK_WORKFLOW_DEF still ships with).
  const LEGACY_DEF = {
    completionRequiresAgentPhases: ["development", "verification", "review"],
    reviewGates: [],
  };
  // A pre-D2 agentTasks map: output only — no ship fields at all.
  const LEGACY_TASKS = {
    "T-1": { id: "task_1", ticketId: "T-1", agentId: "dev", status: "complete", output: "implemented" },
    "T-2": { id: "task_2", ticketId: "T-2", agentId: "qa", status: "complete", output: "verified" },
    "T-3": { id: "task_3", ticketId: "T-3", agentId: "ci", status: "complete", output: "ci green" },
  };
  const LEGACY_CHILDREN = [
    { ticketId: "T-1", assignee: "dev", status: "done" },
    { ticketId: "T-2", assignee: "qa", status: "done" },
    { ticketId: "T-3", assignee: "ci", status: "done" },
  ];

  it("the legacy complete path is unchanged (still completes)", () => {
    expect(isWorkflowComplete(LEGACY_CHILDREN, LEGACY_DEF, opts)).toBe(true);
  });

  it("the ship gate is INERT for a def with no ship phase — required=false", () => {
    const shipPhases = LEGACY_DEF.completionRequiresAgentPhases.filter((p) => SHIP_PHASES.has(p));
    expect(shipPhases).toEqual([]);
    expect(evaluateShipVerdict(LEGACY_CHILDREN, LEGACY_TASKS, shipPhases, opts)).toEqual({
      required: false, shipped: true, outcome: null, blockReason: null, offenders: [],
    });
  });

  it("the evidence check on the same legacy shape is unchanged", () => {
    expect(
      missingEvidenceTickets(LEGACY_CHILDREN, LEGACY_TASKS, LEGACY_DEF.completionRequiresAgentPhases, opts)
    ).toEqual([]);
  });

  it("an unknown outcome value on a legacy entry is default-handled, never fatal", () => {
    const tasks = { ...LEGACY_TASKS, "T-3": { ticketId: "T-3", output: "ci green", outcome: "COMPLETED_MAYBE" } };
    expect(isWorkflowComplete(LEGACY_CHILDREN, LEGACY_DEF, opts)).toBe(true);
    expect(missingEvidenceTickets(LEGACY_CHILDREN, tasks, LEGACY_DEF.completionRequiresAgentPhases, opts)).toEqual([]);
    expect(shipVerdictOf(tasks["T-3"])).toBeNull();
  });

  it("PARITY: the terminal outcome list + ship phases are the values the mirrors pin", () => {
    // Mirrored in src/lib/workflow/types.ts (SHIP_BLOCKED_OUTCOMES) and
    // deploy/workflow-manager/toolkit/save_analysis.py (RUN_OUTCOMES). A change
    // here without updating those breaks the three-way contract.
    expect(SHIP_BLOCKED_OUTCOMES).toEqual(["deploy-blocked", "static-ci-only"]);
    expect(SHIP_PHASES.has("ship")).toBe(true);
    expect(SHIP_PHASES.has("review")).toBe(false);
  });
});

/**
 * TEAM-3755 F2 — the ONE terminal-phase list both terminal-claim CASes derive
 * their guard from. Before this, completeWorkflow and claimTerminalOutcome each
 * spelled the list out by hand and had drifted: completeWorkflow omitted the two
 * D2 outcomes, so a completion racing in behind an honest deploy-blocked /
 * static-ci-only close overwrote the verdict with "complete".
 */
describe("terminal-phase guard (TEAM-3755 F2)", () => {
  it("the list is exactly the five phases a run can already be closed on", () => {
    expect([...TERMINAL_WORKFLOW_PHASES]).toEqual([
      "complete",
      "cancelled",
      "error",
      "deploy-blocked",
      "static-ci-only",
    ]);
  });

  it("derives from SHIP_BLOCKED_OUTCOMES, so a sixth outcome cannot be forgotten", () => {
    for (const outcome of SHIP_BLOCKED_OUTCOMES) {
      expect(TERMINAL_WORKFLOW_PHASES).toContain(outcome);
    }
  });

  it("builds a condition refusing every phase, with no unbound or unused values", () => {
    const { condition, values } = notTerminalPhaseGuard("phase");
    // DynamoDB rejects an ExpressionAttributeValues entry the expression never
    // references, so the two sets must match exactly in both directions.
    const referenced = Object.keys(values).filter((k) => condition.includes(`phase <> ${k}`));
    expect(referenced.sort()).toEqual(Object.keys(values).sort());
    expect(Object.values(values).sort()).toEqual([...TERMINAL_WORKFLOW_PHASES].sort());
  });

  it("honours an aliased name ref (#phase) for callers that reserve the word", () => {
    const { condition } = notTerminalPhaseGuard("#phase");
    expect(condition.startsWith("#phase <> :tp0")).toBe(true);
    expect(condition).not.toContain(" phase <> ");
  });

  it("the list is frozen — a caller cannot mutate the shared guard", () => {
    expect(Object.isFrozen(TERMINAL_WORKFLOW_PHASES)).toBe(true);
  });
});

/**
 * TEAM-3976 — the completions-record fallback behind both evidence gates.
 *
 * A ticket closed out-of-band (mark_done) BEFORE its report_completion landed has
 * an evidence-less agentTasks entry; the later report_completion wrote
 * completions/{tid}.json but its done→done transition was a no-op, so nothing
 * re-harvested. These pin: what counts as evidence in a record (a blank record is
 * NOT — AC-D4.1), what gets backfilled (deliverable fields only, fill-if-missing,
 * never the ship-verdict signals), and the resolver's fail-closed contract.
 */
describe("completion-record fallback (TEAM-3976)", () => {
  describe("completionRecordHasEvidence", () => {
    const table = [
      [{ summary: "did it", pr_url: "https://github.com/x/y/pull/1" }, true, "summary + pr_url"],
      [{ pr_url: "https://github.com/x/y/pull/1" }, true, "pr_url only"],
      [{ commit_sha: "abc123" }, true, "commit_sha only"],
      [{ artifacts: "a.md" }, true, "artifacts string"],
      [{ artifacts: ["a.md"] }, true, "artifacts array"],
      [null, false, "null"],
      [{}, false, "empty object"],
      [{ summary: "   " }, false, "whitespace summary"],
      [{ summary: "", artifacts: "", pr_url: null, commit_sha: null }, false, "all blank"],
      [{ artifacts: [] }, false, "empty artifacts array"],
    ];
    for (const [record, expected, label] of table) {
      it(`${label} → ${expected}`, () => {
        expect(completionRecordHasEvidence(record)).toBe(expected);
      });
    }
    it("non-object inputs are never evidence", () => {
      expect(completionRecordHasEvidence("summary")).toBe(false);
      expect(completionRecordHasEvidence(["a.md"])).toBe(false);
      expect(completionRecordHasEvidence(undefined)).toBe(false);
    });
  });

  describe("evidenceBackfillFields", () => {
    const RECORD = {
      summary: "Fixed it",
      branch: "feature/x",
      commit_sha: "abc",
      pr_url: "https://github.com/x/y/pull/1",
      merge_commit: "9f1c2ab",
      outcome: "shipped",
      block_reason: "none",
    };

    it("fills output/branch/commitSha/prUrl on an empty entry", () => {
      expect(evidenceBackfillFields(RECORD, { ticketId: "T-1", status: "complete" })).toEqual({
        output: "Fixed it",
        branch: "feature/x",
        commitSha: "abc",
        prUrl: "https://github.com/x/y/pull/1",
      });
    });

    it("an undefined entry is treated as empty", () => {
      expect(evidenceBackfillFields(RECORD, undefined).output).toBe("Fixed it");
    });

    it("does NOT emit output when the entry already has non-empty output", () => {
      const fields = evidenceBackfillFields(RECORD, { output: "webhook merge landed first" });
      expect(fields).not.toHaveProperty("output");
      expect(fields.branch).toBe("feature/x");
    });

    it("does NOT emit commitSha/prUrl/branch when the entry already has them", () => {
      const fields = evidenceBackfillFields(RECORD, {
        commitSha: "already", prUrl: "https://already", branch: "already",
      });
      expect(fields).toEqual({ output: "Fixed it" });
    });

    it("NEVER emits mergeCommit/outcome/blockReason — ship-verdict signals stay the harvest's job", () => {
      const fields = evidenceBackfillFields(RECORD, {});
      expect(fields).not.toHaveProperty("mergeCommit");
      expect(fields).not.toHaveProperty("outcome");
      expect(fields).not.toHaveProperty("blockReason");
      expect(Object.keys(fields).sort()).toEqual(["branch", "commitSha", "output", "prUrl"]);
    });

    it("output is capped at 10000 chars (same cap as harvestCompletionEvidence)", () => {
      expect(evidenceBackfillFields({ summary: "x".repeat(20000) }, {}).output).toHaveLength(10000);
    });

    it("blank record fields are not emitted", () => {
      expect(evidenceBackfillFields({ summary: "   ", branch: "", commit_sha: null, pr_url: null }, {})).toEqual({});
      expect(evidenceBackfillFields(null, {})).toEqual({});
    });
  });

  describe("resolveMissingEvidenceFromRecords", () => {
    const MISSING = [{ ticketId: "T-1", phase: "development" }];
    const TASKS = { "T-1": { ticketId: "T-1", status: "complete" } };
    const RECORD = { summary: "Fixed it", pr_url: "https://github.com/x/y/pull/1" };

    function deps(overrides = {}) {
      const calls = { reads: [], backfills: [], logs: [] };
      const d = {
        readCompletionRecord: async (tid) => { calls.reads.push(tid); return RECORD; },
        backfill: async (tid, fields) => { calls.backfills.push({ tid, fields }); },
        log: (m) => calls.logs.push(m),
        ...overrides,
      };
      return { d, calls };
    }

    it("(a) a record proving evidence removes the offender AND backfills its entry", async () => {
      const { d, calls } = deps();
      const remaining = await resolveMissingEvidenceFromRecords(MISSING, TASKS, d);
      expect(remaining).toEqual([]);
      expect(calls.reads).toEqual(["T-1"]);
      expect(calls.backfills).toEqual([{ tid: "T-1", fields: { output: "Fixed it", prUrl: "https://github.com/x/y/pull/1" } }]);
    });

    it("(b) no record (read returns null) → still an offender, backfill not called", async () => {
      const { d, calls } = deps({ readCompletionRecord: async () => null });
      const remaining = await resolveMissingEvidenceFromRecords(MISSING, TASKS, d);
      expect(remaining).toEqual(MISSING);
      expect(calls.backfills).toEqual([]);
      expect(calls.logs.some((m) => m.includes("not found"))).toBe(true);
    });

    it("(c) a blank record (whitespace summary, nothing else) → still an offender", async () => {
      const { d, calls } = deps({ readCompletionRecord: async () => ({ summary: "   " }) });
      const remaining = await resolveMissingEvidenceFromRecords(MISSING, TASKS, d);
      expect(remaining).toEqual(MISSING);
      expect(calls.backfills).toEqual([]);
      expect(calls.logs.some((m) => m.includes("carries no evidence"))).toBe(true);
    });

    it("(d) a read that throws keeps the offender and does not throw out", async () => {
      const { d, calls } = deps({ readCompletionRecord: async () => { throw new Error("S3 down"); } });
      const remaining = await resolveMissingEvidenceFromRecords(MISSING, TASKS, d);
      expect(remaining).toEqual(MISSING);
      expect(calls.backfills).toEqual([]);
      expect(calls.logs.some((m) => m.includes("read failed") && m.includes("S3 down"))).toBe(true);
    });

    it("(e) a backfill that throws still resolves the offender (evidence was proven), no throw", async () => {
      const { d, calls } = deps({ backfill: async () => { throw new Error("ddb down"); } });
      const remaining = await resolveMissingEvidenceFromRecords(MISSING, TASKS, d);
      expect(remaining).toEqual([]);
      expect(calls.logs.some((m) => m.includes("backfill failed") && m.includes("ddb down"))).toBe(true);
    });

    it("(f) zero reads when there is nothing missing — the happy path never touches S3", async () => {
      const { d, calls } = deps();
      expect(await resolveMissingEvidenceFromRecords([], TASKS, d)).toEqual([]);
      expect(await resolveMissingEvidenceFromRecords(undefined, TASKS, d)).toBeUndefined();
      expect(calls.reads).toEqual([]);
    });

    it("only the offenders are read — a clean sibling never costs an S3 call", async () => {
      const { d, calls } = deps();
      await resolveMissingEvidenceFromRecords(MISSING, { ...TASKS, "T-2": { ticketId: "T-2", output: "fine" } }, d);
      expect(calls.reads).toEqual(["T-1"]);
    });

    it("resolves the entry through the ticketId secondary index (task-id-keyed agentTasks)", async () => {
      const { d, calls } = deps();
      const tasks = { task_9: { ticketId: "T-1", output: "already has output" } };
      await resolveMissingEvidenceFromRecords(MISSING, tasks, d);
      // output already present → only prUrl is backfilled.
      expect(calls.backfills).toEqual([{ tid: "T-1", fields: { prUrl: "https://github.com/x/y/pull/1" } }]);
    });

    it("mixed: resolved offenders are dropped, unproven ones stay, in order", async () => {
      const { d } = deps({
        readCompletionRecord: async (tid) => (tid === "T-1" ? RECORD : null),
      });
      const remaining = await resolveMissingEvidenceFromRecords(
        [{ ticketId: "T-1", phase: "development" }, { ticketId: "T-2", phase: "verification" }],
        { "T-1": { ticketId: "T-1" }, "T-2": { ticketId: "T-2" } },
        d
      );
      expect(remaining).toEqual([{ ticketId: "T-2", phase: "verification" }]);
    });
  });
});

/**
 * TEAM-4266 — the record a Workflow Manager mark-done writes is accepted by the
 * UNMODIFIED gate.
 *
 * The bug: `intervene.py mark-done --evidence "…"` recorded an operator's proof as
 * prose only (a ticket comment + a manager.intervention event), so when an agent
 * shipped its deliverable and died before report_completion, NOTHING ever wrote
 * completions/{ticketId}.json — and the run emitted
 * workflow.completion_blocked reason=missing_evidence forever.
 *
 * The fix is writer-side (src/app/api/workflow/[id]/tickets/transition/route.ts now
 * PUTs this record). These cases are the contract between the two halves: they pin
 * that the exact bytes that route writes clear the gate here with no gate change,
 * so a future edit to either side that breaks the pairing fails a test.
 */
describe("workflow-manager completion record clears the gate (TEAM-4266)", () => {
  const EVIDENCE = "PR #87 open+green / streamed QA VERDICT: PASS";

  /** Byte-for-byte the record writeCompletionRecord() PUTs in the transition route. */
  const MANAGER_RECORD = {
    ticket_id: "TEAM-X",
    summary: EVIDENCE,
    artifacts: "",
    branch: null,
    commit_sha: null,
    pr_url: null,
    completed_at: "2026-09-08T12:00:00.000Z",
    source: "workflow-manager",
    evidence_kind: "static",
  };

  it("counts as evidence — a non-empty summary is enough, unknown keys are ignored", () => {
    expect(completionRecordHasEvidence(MANAGER_RECORD)).toBe(true);
  });

  it("backfills ONLY output — there is no branch/commit/PR to claim", () => {
    // The operator supplied prose, not merge signals; the record's nulls must not
    // become fabricated branch/commitSha/prUrl on the agentTasks entry.
    const fields = evidenceBackfillFields(MANAGER_RECORD, { ticketId: "TEAM-X", status: "complete" });
    expect(fields).toEqual({ output: EVIDENCE });
  });

  it("resolves the missing-evidence offender through the record fallback", async () => {
    const calls = { reads: [], backfills: [] };
    const remaining = await resolveMissingEvidenceFromRecords(
      [{ ticketId: "TEAM-X", phase: "development" }],
      { "TEAM-X": { ticketId: "TEAM-X", status: "complete" } },
      {
        readCompletionRecord: async (tid) => { calls.reads.push(tid); return MANAGER_RECORD; },
        backfill: async (tid, fields) => { calls.backfills.push({ tid, fields }); },
        log: () => {},
      }
    );
    expect(remaining).toEqual([]);
    expect(calls.reads).toEqual(["TEAM-X"]);
    expect(calls.backfills).toEqual([{ tid: "TEAM-X", fields: { output: EVIDENCE } }]);
  });

  it("the backfilled entry then passes missingEvidenceTickets outright", () => {
    const children = [{ ticketId: "TEAM-X", assignee: "dev", status: "done" }];
    const tasks = { "TEAM-X": { ticketId: "TEAM-X", status: "complete", output: EVIDENCE } };
    expect(missingEvidenceTickets(children, tasks, ["development"], { getAgentPhase })).toEqual([]);
  });

  it("but it is NOT a merge verdict — a ship-phase run still closes static-ci-only", () => {
    // Deliberate: operator prose is not proof anything merged (TEAM-3755 F1). The
    // record unblocks missing_evidence without ever synthesizing a ship signal.
    expect(shipVerdictOf(evidenceBackfillFields(MANAGER_RECORD, {}))).toBeNull();
  });
});

/**
 * TEAM-4740 FR-10 — `empty_sweep`.
 *
 * A dead-code sweep that finds nothing to remove has no honest terminal outcome
 * today, so such a run either fakes a ship or wedges open (run fz514x). It is not a
 * BLOCK — nothing was attempted and refused — and it is not a phantom green either:
 * there was provably nothing to merge. So it maps to the positive verdict, while
 * staying out of SHIP_BLOCKED_OUTCOMES (and therefore out of TERMINAL_WORKFLOW_PHASES,
 * which is derived from it — a run must still close on `complete`, not on a phase
 * called "empty_sweep").
 */
describe("shipVerdictOf — empty_sweep (TEAM-4740 FR-10)", () => {
  it('classifies an empty sweep as "shipped"', () => {
    expect(shipVerdictOf({ ticketId: "T-4", outcome: "empty_sweep" })).toBe("shipped");
    // The agent writes it lowercase; the reader trims/lowers anyway, as for every
    // other outcome.
    expect(shipVerdictOf({ outcome: "  EMPTY_SWEEP " })).toBe("shipped");
  });

  it("is NOT a blocked outcome and NOT a terminal phase", () => {
    expect(SHIP_BLOCKED_OUTCOMES).not.toContain("empty_sweep");
    expect(TERMINAL_WORKFLOW_PHASES).not.toContain("empty_sweep");
  });

  it("lets a sweep run with nothing to remove close green at the run level", () => {
    // The whole point: evaluateShipVerdict stops treating it as a phantom.
    const verdict = evaluateShipVerdict(
      doneRun(),
      tasksWithShip({ outcome: "empty_sweep" }),
      SHIP,
      opts
    );
    expect(verdict).toEqual({
      required: true,
      shipped: true,
      outcome: null,
      blockReason: null,
      offenders: [],
    });
  });

  it("still refuses a ship report that claims nothing at all", () => {
    // Guard against over-reach: the new branch must not soften the null case.
    const verdict = evaluateShipVerdict(doneRun(), tasksWithShip({ output: "merged it" }), SHIP, opts);
    expect(verdict.shipped).toBe(false);
    expect(verdict.outcome).toBe("static-ci-only");
  });
});

/**
 * TEAM-4763 P1-A — `handoff`: the work was delivered to another team to land. The
 * defect this pins: report_completion has accepted the value since TEAM-4740 (and
 * DL-030 makes the agent prove it with a PR URL), but the reader admitted it
 * nowhere — the harvest dropped it, shipVerdictOf saw no outcome, and the run that
 * honestly handed over its PR was closed on the static-ci-only terminal phase.
 *
 * It satisfies the gate WITHOUT being a merge. Both halves matter: the D2 gate
 * exists to catch SILENCE (DL-028 positive evidence), which an explicit handoff is
 * not; and nothing merged, so it must not travel as an alias for "shipped" or
 * deliveryRollUp would derive prState "merged" for a PR that workflow-output's own
 * derivePrState calls "open".
 */
describe("shipVerdictOf / evaluateShipVerdict — handoff (TEAM-4763 P1-A)", () => {
  it('classifies an explicit "handoff" as its own verdict, not as shipped', () => {
    expect(shipVerdictOf({ ticketId: "T-4", outcome: "handoff", prUrl: "https://github.com/o/r/pull/7" }))
      .toBe("handoff");
    // Same trim/lower tolerance as every other outcome.
    expect(shipVerdictOf({ outcome: "  HandOff " })).toBe("handoff");
  });

  it("is in the SATISFIED set, and is neither a blocked outcome nor a phase", () => {
    expect(SHIP_SATISFIED_VERDICTS).toEqual(["shipped", "handoff"]);
    expect(SHIP_BLOCKED_OUTCOMES).not.toContain("handoff");
    // An OUTCOME, never a PHASE: landing it in this list would change what the
    // reconcile sweep, the dead-session detector and resolveDedup call a closed run.
    expect(TERMINAL_WORKFLOW_PHASES).not.toContain("handoff");
  });

  it("lets a handed-off run close GREEN at the run level", () => {
    // The assertion that failed before this fix: outcome was "static-ci-only".
    const verdict = evaluateShipVerdict(
      doneRun(),
      tasksWithShip({ outcome: "handoff", prUrl: "https://github.com/o/r/pull/7" }),
      SHIP,
      opts
    );
    expect(verdict).toEqual({
      required: true,
      shipped: true,
      outcome: null,
      blockReason: null,
      offenders: [],
    });
  });

  it("a real block beside a handoff still blocks — the gate is not softened", () => {
    const verdict = evaluateShipVerdict(
      doneRun(),
      { ...tasksWithShip({ outcome: "deploy-blocked", blockReason: "preflight failed" }) },
      SHIP,
      opts
    );
    expect(verdict.shipped).toBe(false);
    expect(verdict.outcome).toBe("deploy-blocked");
  });
});

/**
 * TEAM-4763 P1-A — `harvestableShipOutcome` is the predicate
 * harvestCompletionEvidence calls, moved here so the set of values the harvest
 * ADMITS and the table that says what each one MEANS are one decision in one file.
 * They had drifted, which is how `handoff` became writable-but-unreadable.
 */
describe("harvestableShipOutcome — the harvest's closed set (TEAM-4763 P1-A)", () => {
  it("admits exactly the vocabulary shipVerdictOf can classify", () => {
    expect([...HARVESTED_SHIP_OUTCOMES].sort()).toEqual(
      ["deploy-blocked", "empty_sweep", "handoff", "shipped", "static-ci-only"]
    );
    for (const outcome of HARVESTED_SHIP_OUTCOMES) {
      expect(harvestableShipOutcome(outcome)).toBe(outcome);
      // The round trip that matters: anything admitted must have a verdict.
      expect(shipVerdictOf({ outcome })).not.toBeNull();
    }
  });

  it("normalizes the way the harvest always has (agents write prose-ish fields)", () => {
    expect(harvestableShipOutcome("  STATIC-CI-ONLY ")).toBe("static-ci-only");
    expect(harvestableShipOutcome("HandOff")).toBe("handoff");
  });

  it("DROPS anything it cannot classify, rather than storing it", () => {
    // Closed on purpose: a garbage or future-schema outcome must never reach the
    // ship gate as a verdict nobody defined.
    for (const junk of ["kinda-shipped", "banana", "", "   ", null, undefined, 7, {}]) {
      expect(harvestableShipOutcome(junk)).toBeNull();
    }
  });
});

/**
 * TEAM-4740 FR-13/FR-14 — `deliveryRollUp`, the pure roll-up the orchestrator
 * splices into its ONE setDelivery write at completion.
 *
 * Two things it must never do: claim a delivery state it cannot derive (an absent
 * field is honest, a wrong one is not), and return `undefined` (the caller spreads
 * the result straight into the write).
 */
describe("deliveryRollUp (TEAM-4740 FR-13/FR-14)", () => {
  /** A materialized follow-up, carrying both markers the materializer mints. */
  const followUp = (over = {}) => ({
    ticketId: "FU-1",
    title: "Re-verify the deploy in prod [fu:1a2b3c4d]",
    labels: ["followup-1a2b3c4d"],
    assignee: "agentcore_hub_qa_verifier",
    status: "todo",
    ...over,
  });

  it("returns {} — never undefined — for a run with nothing to roll up", () => {
    expect(deliveryRollUp([], {})).toEqual({});
    expect(deliveryRollUp(doneRun(), {})).toEqual({});
    // …and for junk, so the spread at the call site can never throw.
    expect(deliveryRollUp(undefined, undefined)).toEqual({});
    expect(deliveryRollUp(null, "nope")).toEqual({});
  });

  it("says NOTHING while an agent-owned follow-up is still open", () => {
    // Deliberate: that follow-up is a fix ticket, so isWorkflowComplete rule (iii)
    // is holding the run open and there is no completion to describe yet. Claiming
    // "complete-with-handoff" here would label a run that has not finished.
    expect(deliveryRollUp([followUp()], {})).toEqual({});
  });

  it("reports complete-with-handoff when every open follow-up is HUMAN-owned", () => {
    const tickets = [
      ...doneRun(),
      followUp({ ticketId: "FU-1", assignee: "human:engineer", status: "todo" }),
      followUp({ ticketId: "FU-2", assignee: "agentcore_hub_qa_verifier", status: "done" }),
    ];
    expect(deliveryRollUp(tickets, {})).toEqual({ outcome: "complete-with-handoff" });
  });

  it("says nothing once every follow-up is settled", () => {
    const tickets = [
      followUp({ ticketId: "FU-1", assignee: "human:engineer", status: "done" }),
      followUp({ ticketId: "FU-2", assignee: "human:engineer", status: "cancelled" }),
    ];
    expect(deliveryRollUp(tickets, {})).toEqual({});
  });

  it("one open human follow-up beside a still-open agent one says nothing", () => {
    const tickets = [
      followUp({ ticketId: "FU-1", assignee: "human:engineer", status: "todo" }),
      followUp({ ticketId: "FU-2", assignee: "agentcore_hub_backend_dev", status: "in_progress" }),
    ];
    expect(deliveryRollUp(tickets, {})).toEqual({});
  });

  it("recognizes a follow-up by EITHER marker, and ordinary tickets by neither", () => {
    // The label is the filter; the title suffix is the only marker a re-entrant
    // scan can read back, since list_tickets returns `summary` and not `labels`.
    const labelOnly = { ticketId: "FU-1", title: "Hand off the IAM change", labels: ["followup-00ff11aa"], assignee: "human:engineer", status: "todo" };
    const titleOnly = { ticketId: "FU-2", title: "Hand off the IAM change [fu:00ff11aa]", assignee: "human:engineer", status: "todo" };
    expect(deliveryRollUp([labelOnly], {})).toEqual({ outcome: "complete-with-handoff" });
    expect(deliveryRollUp([titleOnly], {})).toEqual({ outcome: "complete-with-handoff" });
    // An ordinary open human gate is NOT a follow-up — it is the run's own review
    // gate, and mislabelling it would report a handoff on every gated run.
    expect(deliveryRollUp([{ ticketId: "G-1", title: "Merge Approval", assignee: "human:tycen", status: "in_review" }], {})).toEqual({});
    // Nor is a near-miss marker (wrong length, wrong separator, not lowercase hex).
    for (const near of ["followup-1a2b3c4", "followup:1a2b3c4d", "followup-1A2B3C4D", "followup-zzzzzzzz"]) {
      expect(FOLLOWUP_LABEL_RE.test(near)).toBe(false);
      expect(deliveryRollUp([{ ...followUp(), title: "no suffix", labels: [near] }], {})).toEqual({});
    }
    expect(FOLLOWUP_TITLE_RE.test("Re-verify [fu:1a2b3c4d] then stop")).toBe(false); // must be the SUFFIX
    expect("Re-verify [fu:1a2b3c4d]  ".match(FOLLOWUP_TITLE_RE)[1]).toBe("1a2b3c4d");
  });

  it("derives prState=merged from a merge commit or an explicit shipped", () => {
    expect(deliveryRollUp([], tasksWithShip({ mergeCommit: "9f1c2ab" }))).toEqual({ prState: "merged" });
    expect(deliveryRollUp([], tasksWithShip({ outcome: "shipped" }))).toEqual({ prState: "merged" });
    // FR-10: an empty sweep landed nothing, but it has nothing outstanding either —
    // it rides the same positive verdict, so prState agrees with shipVerdictOf.
    expect(deliveryRollUp([], tasksWithShip({ outcome: "empty_sweep" }))).toEqual({ prState: "merged" });
  });

  it("derives prState=open from a pr url alone — a PR exists, it did not land", () => {
    const tasks = tasksWithShip({ prUrl: "https://github.com/o/r/pull/7" });
    expect(deliveryRollUp([], tasks)).toEqual({ prState: "open" });
    // TEAM-3755 F1 again, one layer up: the unmerged branch HEAD is not a merge.
    expect(deliveryRollUp([], tasksWithShip({ commitSha: "abc1234" }))).toEqual({});
    // A merge commit alongside the PR url wins — merged is the stronger signal.
    expect(deliveryRollUp([], tasksWithShip({ prUrl: "https://github.com/o/r/pull/7", mergeCommit: "9f1c2ab" })))
      .toEqual({ prState: "merged" });
  });

  it("omits prState entirely when nothing was harvested", () => {
    // Not "unknown": an absent key lets the UI keep whatever the last write knew,
    // and setDelivery is a whole-object SET.
    expect(deliveryRollUp([], tasksWithShip({ output: "did stuff" }))).toEqual({});
    expect(deliveryRollUp([], { "T-4": null })).toEqual({});
    expect(deliveryRollUp([], tasksWithShip({ prUrl: "   " }))).toEqual({});
  });

  it("carries the handoff outcome and the prState together", () => {
    const tickets = [followUp({ assignee: "human:engineer" })];
    expect(deliveryRollUp(tickets, tasksWithShip({ mergeCommit: "9f1c2ab" }))).toEqual({
      outcome: "complete-with-handoff",
      prState: "merged",
    });
  });

  /**
   * TEAM-4763 P1-A — the `{ mode }` argument and the two-value `delivery.outcome`
   * union (src/lib/workflow/types.ts). `delivery.mode` is the only discriminator
   * between them and lives at the caller, hence the third argument; before this
   * ticket nothing in the repo could emit "complete:handoff:static-only" at all.
   */
  describe("the delivery.outcome union, chosen by mode", () => {
    /** The ship entry a CD handoff produces: an OPEN PR, no merge. */
    const handoffShip = () => tasksWithShip({ outcome: "handoff", prUrl: "https://github.com/o/r/pull/7" });

    it("cd mode + a handoff ship record → complete-with-handoff, PR open", () => {
      expect(deliveryRollUp(doneRun(), handoffShip(), { mode: "cd" })).toEqual({
        outcome: "complete-with-handoff",
        prState: "open",
      });
    });

    it("handoff mode with nothing merged → complete:handoff:static-only", () => {
      // The CD-registry miss: cd-registry.mjs stripped the ship phase, so there was
      // no deploy and no merge — static CI is the only verification the run had.
      expect(deliveryRollUp(doneRun(), tasksWithShip({ prUrl: "https://github.com/o/r/pull/7" }), { mode: "handoff" }))
        .toEqual({ outcome: "complete:handoff:static-only", prState: "open" });
      // With no ship evidence at all it is still the honest label for the run.
      expect(deliveryRollUp(doneRun(), {}, { mode: "handoff" }))
        .toEqual({ outcome: "complete:handoff:static-only" });
    });

    it("the more specific label wins when both rules apply — only one key is legal", () => {
      const tickets = [...doneRun(), followUp({ assignee: "human:engineer" })];
      expect(deliveryRollUp(tickets, handoffShip(), { mode: "handoff" })).toEqual({
        outcome: "complete:handoff:static-only",
        prState: "open",
      });
    });

    it("handoff mode STOPS claiming static-only once something proves a merge", () => {
      // A registered repo can be delivered by handoff mid-run, and a merge is a
      // merge: the run is described by the weaker label, never by a false one.
      expect(deliveryRollUp(doneRun(), tasksWithShip({ mergeCommit: "9f1c2ab" }), { mode: "handoff" }))
        .toEqual({ prState: "merged" });
    });

    it("cd mode with a plain merge says nothing about a handoff", () => {
      expect(deliveryRollUp(doneRun(), tasksWithShip({ outcome: "shipped" }), { mode: "cd" }))
        .toEqual({ prState: "merged" });
    });

    it("stays spread-safe: no mode, junk mode, junk opts — never an undefined key", () => {
      for (const opt of [undefined, {}, null, { mode: "" }, { mode: 7 }, { mode: "nonsense" }, "nope"]) {
        const out = deliveryRollUp(doneRun(), handoffShip(), opt);
        // The handoff verdict still speaks for itself without a mode.
        expect(out).toEqual({ outcome: "complete-with-handoff", prState: "open" });
        expect(Object.values(out)).not.toContain(undefined);
      }
      expect(Object.keys(deliveryRollUp([], {}, { mode: "cd" }))).toEqual([]);
    });
  });
});

/**
 * TEAM-4740 FR-13 — the reason the materializer files agent-owned follow-ups as
 * FIX tickets: rule (iii) then gates the epic with zero new completion logic. This
 * pins that dependency, so a future refactor of the roll-up cannot quietly become
 * the thing that holds a run open.
 */
describe("isWorkflowComplete — agent follow-ups gate via rule (iii) (TEAM-4740)", () => {
  const postDeploy = (status) => ({
    ticketId: "FU-1",
    title: "Re-verify the deploy against prod [fu:1a2b3c4d]",
    labels: ["followup-1a2b3c4d"],
    assignee: "qa",
    phase: "verification",
    status,
    spawnedBy: { kind: "qa_fix", qaTicketId: "T-4" },
  });
  const mainPr = (status) => ({
    ticketId: "FU-2",
    title: "Open a PR to main for the hub-infra fix [fu:9988aabb]",
    labels: ["followup-9988aabb"],
    assignee: "dev",
    phase: "ship",
    status,
    spawnedBy: { kind: "ship_fix", shipTicketId: "T-4" },
  });

  it("an open post_deploy_verification follow-up (qa_fix) holds the run open", () => {
    expect(isWorkflowComplete(doneRun([postDeploy("todo")]), DEF, opts)).toBe(false);
    expect(isWorkflowComplete(doneRun([postDeploy("done")]), DEF, opts)).toBe(true);
  });

  it("an open main-PR follow-up (ship_fix) holds the run open", () => {
    expect(isWorkflowComplete(doneRun([mainPr("in_progress")]), DEF, opts)).toBe(false);
    expect(isWorkflowComplete(doneRun([mainPr("done")]), DEF, opts)).toBe(true);
  });

  it("a HUMAN follow-up does not gate — which is why it becomes complete-with-handoff", () => {
    // The complement of the two cases above, and the whole reason the roll-up
    // exists: nothing in the completion gate can see a human's inbox, so the
    // handoff has to be recorded on the run instead of blocking it.
    const human = { ticketId: "FU-3", title: "Grant the console role [fu:77665544]", labels: ["followup-77665544"], assignee: "human:engineer", status: "todo" };
    expect(isWorkflowComplete(doneRun([human]), DEF, opts)).toBe(true);
    expect(deliveryRollUp(doneRun([human]), {})).toEqual({ outcome: "complete-with-handoff" });
  });
});
