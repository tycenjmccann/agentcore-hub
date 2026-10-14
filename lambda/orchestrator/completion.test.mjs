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
// TEAM-5828: namespace import so a missing export fails per test, not the whole file.
import * as completion from "./completion.mjs";

// TEAM-5935/TEAM-5943: per-file proof fixtures — ONE recursive tree per ref the landing probe
// reads (base tip, merged head, branch tip). entries: path → sha (a 100644 blob) | [sha, mode]
// | { sha, mode, type }; an absent path is simply not listed.
const TREE = (treeSha, entries, { truncated = false } = {}) => [
  `/git/trees/${treeSha}?recursive=1`,
  { sha: treeSha, truncated, tree: Object.entries(entries).map(([path, v]) => {
      const e = Array.isArray(v) ? { sha: v[0], mode: v[1] } : typeof v === "string" ? { sha: v } : v;
      return { path, type: "blob", mode: "100644", ...e };
    }) },
];
// commit sha → tree sha routes (`GET /git/commits/{sha}` is how the probe finds a ref's tree).
const COMMIT_TREES = (pairs) => pairs.map(([commit, tree]) => [`/git/commits/${commit}`, { tree: { sha: tree } }]);
// The three indexes of the TEAM-5828/5868 blocks: base tip "tip", merged head "old111", branch head.
const TRIPLE = (base, before, tip) => [TREE("tipTree", base), TREE("oldTree", before), TREE("headTree", tip)];

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
    expect(v).toEqual({ required: true, shipped: true, handoff: false, outcome: null, blockReason: null, offenders: [] });
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
      handoff: false,
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
    expect(v).toEqual({ required: true, shipped: true, handoff: false, outcome: null, blockReason: null, offenders: [] });
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
      required: true, shipped: true, handoff: false, outcome: null, blockReason: null, offenders: [],
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
      required: false, shipped: true, handoff: false, outcome: null, blockReason: null, offenders: [],
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
      required: false, shipped: true, handoff: false, outcome: null, blockReason: null, offenders: [],
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
      // An empty sweep IS shipped, so it is not a handoff — it stays subject to the
      // merge-verify probe (which fails open on a branch with nothing to compare).
      handoff: false,
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
      // TEAM-4768: the run is shipped PURELY by handoff, so completeWorkflow skips
      // the merge-verify probe — this PR is open by definition and there is no merge
      // claim to cross-check. Without this key the probe refused the run forever.
      handoff: true,
      outcome: null,
      blockReason: null,
      offenders: [],
    });
  });

  it("a mixed run (one handoff, one shipped) is NOT probe-exempt (TEAM-4768)", () => {
    // A "shipped" ticket beside the handoff IS a merge claim, so the run keeps
    // paying the GitHub cross-check. handoff must be false, not "any handoff".
    const children = doneRun([{ ticketId: "T-5", assignee: "rm", status: "done" }]);
    const tasks = {
      ...tasksWithShip({ outcome: "handoff", prUrl: "https://github.com/o/r/pull/7" }),
      "T-5": { ticketId: "T-5", mergeCommit: "9f1c2ab" },
    };
    const verdict = evaluateShipVerdict(children, tasks, SHIP, opts);
    expect(verdict.shipped).toBe(true);
    expect(verdict.handoff).toBe(false);
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

describe("resolvePrBase — post-merge fixes target the default branch (TEAM-5828)", () => {
  const FB = "feature/EPIC-1-x";
  const wf = (agentTasks = {}, featureBranch = FB) => ({ featureBranch, agentTasks });
  const RM = "agentcore_hub_release_manager";
  const PHASE = { [RM]: "ship", agentcore_hub_backend_dev: "development" };
  const resolve = (workflow, ticketDescription = "") =>
    completion.resolvePrBase({ workflow, ticketDescription, defaultBranch: "main", getAgentPhase: (id) => PHASE[id] });

  it("unified PR merged (a task carries mergeCommit) → default branch, not shared", () => {
    const r = resolve(wf({ "CD-1": { ticketId: "CD-1", agentId: RM, mergeCommit: "9f1c2ab" } }));
    expect(r).toEqual({ baseBranch: "main", isShared: false, reason: "unified_pr_merged", mergeCommit: "9f1c2ab" });
  });

  it("before the merge → the shared integration branch", () => {
    expect(resolve(wf({ "D-1": { ticketId: "D-1", output: "done" } }))).toEqual({ baseBranch: FB, isShared: true, reason: "default" });
  });

  it("commitSha alone is NOT a merge (TEAM-3755 F1) → still the integration branch", () => {
    expect(resolve(wf({ "D-1": { ticketId: "D-1", commitSha: "deadbee" } })).baseBranch).toBe(FB);
  });

  it("TEAM-5853 #4: merged then deploy-blocked → still merged: default branch", () => {
    expect(resolve(wf({ "CD-1": { ticketId: "CD-1", agentId: RM, mergeCommit: "9f1", outcome: "deploy-blocked" } })))
      .toEqual({ baseBranch: "main", isShared: false, reason: "unified_pr_merged", mergeCommit: "9f1" });
  });

  it("TEAM-5853 #4: a DEV task's mergeCommit (sub-PR into the integration branch) is not the unified merge", () => {
    expect(resolve(wf({ "D-1": { ticketId: "D-1", agentId: "agentcore_hub_backend_dev", mergeCommit: "d1" } })).baseBranch).toBe(FB);
  });

  it("TEAM-5853 #5: a stale stated base_branch naming the merged integration branch → default branch", () => {
    const r = resolve(wf({ "CD-1": { ticketId: "CD-1", agentId: RM, mergeCommit: "9f1" } }), `Fix.\n\nbase_branch: ${FB}`);
    expect(r).toEqual({ baseBranch: "main", isShared: false, reason: "unified_pr_merged", mergeCommit: "9f1" });
  });

  it("the ticket's own base_branch line wins, before and after the merge", () => {
    const desc = "Fix it.\n\nbase_branch: release/2.1";
    expect(resolve(wf(), desc)).toEqual({ baseBranch: "release/2.1", isShared: false, reason: "ticket" });
    expect(resolve(wf({ "CD-1": { ticketId: "CD-1", agentId: RM, mergeCommit: "9f1" } }), desc).baseBranch).toBe("release/2.1");
    expect(resolve(wf(), `x\nbase_branch: ${FB}`).isShared).toBe(true);
  });

  it("no feature branch (single-PR def) → default branch, mergeCommit ignored", () => {
    expect(resolve(wf({}, null))).toEqual({ baseBranch: "main", isShared: false, reason: "default" });
    expect(resolve(wf({ "CD-1": { ticketId: "CD-1", agentId: RM, mergeCommit: "9f1" } }, null)).reason).toBe("default");
  });
});

describe("featureBranchLanding — stranded post-merge commits (TEAM-5828)", () => {
  const HEAD = "feature/EPIC-1-x";
  // routes: path substring → body; first match wins.
  const apiFor = (routes) => async (path) => {
    for (const [k, v] of routes) if (path.includes(k)) return typeof v === "function" ? v(path) : v;
    return {};
  };
  const land = (routes) => completion.featureBranchLanding({ owner: "o", repo: "r", base: "main", head: HEAD, api: apiFor(routes) });
  // TEAM-5913/TEAM-5935: DIFF_TREES only defeats the equal-tree shortcut; a proven strand needs per-file evidence (TRIPLE).
  const DIFF_TREES = (sha) => COMMIT_TREES([["tip", "tipTree"], ["old111", "oldTree"], [sha, "headTree"]]);
  const merged = { number: 846, merged_at: "2026-10-01T00:00:00Z", state: "closed", head: { sha: "old111" }, base: { ref: "main" }, merge_commit_sha: "m846", html_url: "https://github.com/o/r/pull/846" };

  it("merged PR head == branch head → merged (squash-safe even when compare says diverged)", async () => {
    const r = await land([["/pulls?", [merged]], ["/branches/", { commit: { sha: "old111" } }], ["/compare/", { status: "diverged", ahead_by: 4 }]]);
    expect(r).toEqual({ merged: true, mergeCommit: "m846", prUrl: merged.html_url });
  });

  it("commits after the merged PR, no open PR → merged:false naming branch, count and PR", async () => {
    const r = await land([
      ["/pulls?", [merged]], ["/branches/", { commit: { sha: "new222" } }],
      ["/compare/old111...new222", { status: "ahead", ahead_by: 2, files: [{ filename: "a.js" }] }],
      ["/compare/main...", { status: "diverged", ahead_by: 6, files: [{ filename: "a.js" }], base_commit: { sha: "tip" } }],
      ...DIFF_TREES("new222"),
      // TEAM-5935: main still holds a.js at its pre-merge content — the positive proof of a strand.
      ...TRIPLE({ "a.js": "a0" }, { "a.js": "a0" }, { "a.js": "a1" }),
    ]);
    expect(r.merged).toBe(false);
    expect(r.reason).toContain(`feature branch ${HEAD} has 2 commit(s) after its merged PR #846 not contained in main and no open PR to main`);
    expect(r.reason).toContain("main still holds the pre-merge content of: a.js");
  });

  it("same, but an open PR to main carries them → not refused (merged:null)", async () => {
    const open = { number: 900, merged_at: null, state: "open", head: { sha: "new222" }, base: { ref: "main" } };
    const r = await land([["/pulls?", [merged, open]], ["/branches/", { commit: { sha: "new222" } }], ["/compare/", { status: "diverged", ahead_by: 6 }]]);
    expect(r).toEqual({ merged: null, reason: "open PR #900 to main" });
  });

  it("later commits already on main (compare behind) → merged", async () => {
    const r = await land([["/pulls?", [merged]], ["/branches/", { commit: { sha: "new222" } }], ["/compare/main...", { status: "behind", base_commit: { sha: "b1" } }]]);
    expect(r).toEqual({ merged: true, mergeCommit: "b1", prUrl: "" });
  });

  it("TEAM-5853 #1: sync-after-squash (merge of main, empty merge-base..head diff) → merged", async () => {
    // TEAM-5868: realistic fixture — main moved on after the sync (behind_by 1), so the
    // merge-base S must be shown to contain the merge commit m846 (m846...S behind_by 0).
    const r = await land([
      ["/pulls?", [merged]], ["/branches/", { commit: { sha: "M999" } }],
      ["/compare/main...", { status: "diverged", ahead_by: 2, behind_by: 1, files: [], merge_base_commit: { sha: "S" } }],
      ["/compare/m846...S", { status: "ahead", ahead_by: 1, behind_by: 0 }],
      ["/compare/old111...M999", { status: "ahead", ahead_by: 2, behind_by: 0, files: [{ filename: "unrelated.js" }] }],
    ]);
    expect(r).toEqual({ merged: true, mergeCommit: "m846", prUrl: merged.html_url });
  });

  it("TEAM-5853 #1: same shape but the diff carries a file → still stranded (merged:false)", async () => {
    const r = await land([
      ["/pulls?", [merged]], ["/branches/", { commit: { sha: "M999" } }],
      ["/compare/old111...M999", { status: "ahead", ahead_by: 2, files: [{ filename: "a.js" }] }],
      ["/compare/main...", { status: "diverged", ahead_by: 2, files: [{ filename: "a.js" }], base_commit: { sha: "tip" } }],
      ...DIFF_TREES("M999"),
      ...TRIPLE({ "a.js": "a0" }, { "a.js": "a0" }, { "a.js": "a1" }),
    ]);
    expect(r.merged).toBe(false);
  });

  it("TEAM-5853 #2: a PR merged into another base (release/2.1) is not landing on main", async () => {
    const elsewhere = { ...merged, base: { ref: "release/2.1" }, head: { sha: "h1" } };
    const r = await land([["/pulls?", [elsewhere]], ["/branches/", { commit: { sha: "h1" } }], ["/compare/main...", { status: "ahead", ahead_by: 3 }]]);
    expect(r.merged).toBe(false);
  });

  it("TEAM-5853 #3: head branch auto-deleted (404) after its PR merged to main → merged, with the PR's proof", async () => {
    const gone = () => { throw Object.assign(new Error("GitHub GET branches 404: Branch not found"), { status: 404 }); };
    // TEAM-5913: a deleted branch is proof only when the PR's head contains every recorded head.
    const pr = { ...merged, head: { sha: "old111abc" } };
    const r = await completion.featureBranchLanding({ owner: "o", repo: "r", base: "main", head: HEAD, api: apiFor([["/pulls?", [pr]], ["/branches/", gone], ["/compare/", gone]]), recordedHeads: ["old111abc"] });
    expect(r).toEqual({ merged: true, mergeCommit: "m846", prUrl: merged.html_url });
  });

  // 100 closed-unmerged PRs to main fill page 1, so anything on page 2 is only seen by paging.
  const filler = Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i, merged_at: null, state: "closed", head: { sha: `f${i}` }, base: { ref: "main" } }));

  it("TEAM-5853 #6: the merged PR on page 2 is found", async () => {
    const r = await land([["&page=2", [merged]], ["/pulls?", filler], ["/branches/", { commit: { sha: "old111" } }], ["/compare/", { status: "diverged", ahead_by: 4 }]]);
    expect(r).toEqual({ merged: true, mergeCommit: "m846", prUrl: merged.html_url });
  });

  it("TEAM-5853 #6: an open PR to main on page 2 still carries post-merge commits (merged:null)", async () => {
    const open = { number: 900, merged_at: null, state: "open", head: { sha: "new222" }, base: { ref: "main" } };
    const r = await land([
      ["&page=2", [open]], ["/pulls?", [merged, ...filler.slice(1)]], ["/branches/", { commit: { sha: "new222" } }],
      ["/compare/old111...new222", { status: "ahead", ahead_by: 2 }], ["/compare/main...", { status: "diverged", ahead_by: 6 }],
    ]);
    expect(r).toEqual({ merged: null, reason: "open PR #900 to main" });
  });

  it("no PR ever merged → the old compare fallback (ahead → merged:false; unknown → null)", async () => {
    expect((await land([["/pulls?", []], ["/compare/", { status: "ahead", ahead_by: 3 }]])).merged).toBe(false);
    expect(await land([["/pulls?", []], ["/compare/", { status: "weird" }]])).toEqual({ merged: null });
  });
});

describe("featureBranchLanding — TEAM-5868 review fixes (content proof, bound 404, truncation)", () => {
  const HEAD = "feature/EPIC-1-x";
  // routes: path substring → body; first match wins. `calls` records every path requested.
  const apiFor = (routes, calls = []) => async (path) => {
    calls.push(path);
    for (const [k, v] of routes) if (path.includes(k)) return typeof v === "function" ? v(path) : v;
    return {};
  };
  const land = (routes, extra = {}, calls = []) =>
    completion.featureBranchLanding({ owner: "o", repo: "r", base: "main", head: HEAD, api: apiFor(routes, calls), ...extra });
  const merged = { number: 846, merged_at: "2026-10-01T00:00:00Z", state: "closed", head: { sha: "old111" }, base: { ref: "main" }, merge_commit_sha: "m846", html_url: "https://github.com/o/r/pull/846" };
  const PROOF = { merged: true, mergeCommit: "m846", prUrl: merged.html_url };
  const gone = () => { throw Object.assign(new Error("GitHub GET branches 404: Branch not found"), { status: 404 }); };
  const filler = Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i, merged_at: null, state: "closed", head: { sha: `f${i}` }, base: { ref: "main" } }));
  // TEAM-5913/TEAM-5935: DIFF_TREES only defeats the equal-tree shortcut; a proven strand needs per-file evidence (TRIPLE).
  const DIFF_TREES = (sha) => COMMIT_TREES([["tip", "tipTree"], ["old111", "oldTree"], [sha, "headTree"]]);

  // ── N1: an empty THREE-dot diff only proves tree(head) == tree(merge-base) ──
  it("N1 revert repro: feature C-H-R (R reverts H), main C-S (squash of H) → empty main...R diff is NOT proof (merged:false)", async () => {
    const r = await land([
      ["/pulls?", [merged]], ["/branches/", { commit: { sha: "R" } }],
      ["/compare/main...", { status: "diverged", ahead_by: 2, behind_by: 1, files: [], merge_base_commit: { sha: "C" }, base_commit: { sha: "tip" } }],
      ["/compare/m846...C", { status: "behind", ahead_by: 0, behind_by: 1 }],
      ["/compare/old111...R", { status: "ahead", ahead_by: 1, behind_by: 0, files: [{ filename: "feature.txt", status: "removed" }] }],
      ...DIFF_TREES("R"),
      // TEAM-5935: main (post-squash) still has feature.txt exactly as H left it; R removed it → stranded.
      ...TRIPLE({ "feature.txt": "f0" }, { "feature.txt": "f0" }, {}),
    ]);
    expect(r.merged).toBe(false);
    expect(r.reason).toContain("1 commit(s) after its merged PR #846");
    expect(r.reason).toContain("feature.txt");
  });

  it("N1 P2: commits after the merged head whose merged-head..head diff is EMPTY (no-op commits) → merged", async () => {
    const r = await land([
      ["/pulls?", [merged]], ["/branches/", { commit: { sha: "E1" } }],
      ["/compare/old111...E1", { status: "ahead", ahead_by: 1, behind_by: 0, files: [] }],
      ["/compare/main...", { status: "diverged", ahead_by: 3, behind_by: 2, files: [{ filename: "x.js" }] }],
    ]);
    expect(r).toEqual(PROOF);
  });

  it("N1 P3: synced with main AFTER the merge and main moved on since → merged (merge-base contains the merge commit)", async () => {
    const calls = [];
    const r = await land([
      ["/pulls?", [merged]], ["/branches/", { commit: { sha: "M" } }],
      ["/compare/main...", { status: "diverged", ahead_by: 2, behind_by: 1, files: [], merge_base_commit: { sha: "S" } }],
      ["/compare/m846...S", { status: "ahead", ahead_by: 3, behind_by: 0 }],
      ["/compare/old111...M", { status: "ahead", ahead_by: 2, behind_by: 0, files: [{ filename: "other.js" }] }],
    ], {}, calls);
    expect(r).toEqual(PROOF);
    expect(calls.some((p) => p.includes("/compare/m846...S"))).toBe(true);
  });

  it("N1 P3: synced with main's TIP (behind_by 0) → merged without the extra ancestry compare", async () => {
    const calls = [];
    const r = await land([
      ["/pulls?", [merged]], ["/branches/", { commit: { sha: "M" } }],
      ["/compare/main...", { status: "ahead", ahead_by: 2, behind_by: 0, files: [] }],
      ["/compare/old111...M", { status: "ahead", ahead_by: 2, behind_by: 0, files: [{ filename: "other.js" }] }],
    ], {}, calls);
    expect(r).toEqual(PROOF);
    expect(calls.some((p) => p.includes("/compare/m846..."))).toBe(false);
  });

  it("N1 P3: empty diff but no merge_base_commit in the response → not proof, falls to the stranded check", async () => {
    const r = await land([
      ["/pulls?", [merged]], ["/branches/", { commit: { sha: "R" } }],
      ["/compare/main...", { status: "diverged", ahead_by: 2, behind_by: 1, files: [], base_commit: { sha: "tip" } }],
      ["/compare/old111...R", { status: "ahead", ahead_by: 1, behind_by: 0, files: [{ filename: "feature.txt" }] }],
      ...DIFF_TREES("R"),
      ...TRIPLE({ "feature.txt": "f0" }, { "feature.txt": "f0" }, {}),
    ]);
    expect(r.merged).toBe(false);
  });

  // ── N2 / TEAM-5913: a deleted branch proves nothing unless the merged PR's head contains EVERY recorded head ──
  it("N2: branch gone (404) and no recorded head → merged:null naming the PR head", async () => {
    const r = await land([["/pulls?", [merged]], ["/branches/", gone], ["/compare/", gone]]);
    expect(r.merged).toBe(null);
    expect(r.reason).toMatch(/branch feature\/EPIC-1-x is gone/);
    expect(r.reason).toMatch(/recorded head \(none\) is not contained in merged PR #846 head old111/);
  });

  it("N2: branch gone, the only recorded head IS the merged PR head (exact or ≥7-char prefix) → proof", async () => {
    const full = { ...merged, head: { sha: "old111abcdef0123456789abcdef0123456789ab" } };
    expect(await land([["/pulls?", [full]], ["/branches/", gone]], { recordedHeads: [full.head.sha] })).toEqual(PROOF);
    expect(await land([["/pulls?", [full]], ["/branches/", gone]], { recordedHeads: ["old111a"] })).toEqual(PROOF);
  });

  it("N2: branch gone, a recorded head too short (<7) to bind → merged:null", async () => {
    const r = await land([["/pulls?", [merged]], ["/branches/", gone]], { recordedHeads: ["old111"] });
    expect(r.merged).toBe(null);
  });

  it("N2 review scenario: H recorded+merged, branch advanced to F (recorded later), then deleted → merged:null", async () => {
    const r = await land([["/pulls?", [merged]], ["/branches/", gone]], { recordedHeads: ["fff0000"] });
    expect(r.merged).toBe(null);
    expect(r.reason).toMatch(/recorded head fff0000 is not contained in merged PR #846/);
  });

  it("TEAM-5884 R3-2 → TEAM-5913: [H, H, F] tied at one instant — F is not contained in the merged head → merged:null, never the merged PR's head", async () => {
    const t = "2026-10-01T00:00:00Z";
    const full = { ...merged, head: { sha: "old111abcdef0123456789abcdef0123456789ab" } };
    const heads = completion.recordedHeads({
      "B-1": { commitSha: "old111abcdef", completedAt: t },
      "B-2": { commitSha: "old111abcdef", completedAt: t },
      "B-3": { commitSha: "fff0000bbbb", completedAt: t },
    });
    const r = await land([["/pulls?", [full]], ["/branches/", gone], ["/compare/fff0000bbbb...", { status: "diverged", ahead_by: 1, behind_by: 1 }]], { recordedHeads: heads });
    expect(r.merged).toBe(null);
    expect(r.reason).toMatch(/recorded head fff0000bbbb is not contained/);
  });

  // ── N4: a full 10th page means the PR history was truncated, not exhausted ──
  it("N4: ten full pages of closed-unmerged PRs, the merged PR only on page 11 → merged:null, never a definitive false", async () => {
    const r = await land([
      ["/pulls?", (p) => (p.endsWith("&page=11") ? [merged] : filler)],
      ["/compare/", { status: "ahead", ahead_by: 3 }],
    ]);
    expect(r.merged).toBe(null);
    expect(r.reason).toMatch(/truncated at 10 pages/);
  });

  it("N4: cap not hit (page 10 is short) and nothing merged → still definitively merged:false", async () => {
    const r = await land([
      ["/pulls?", (p) => (p.endsWith("&page=10") ? filler.slice(1) : filler)],
      ["/compare/", { status: "ahead", ahead_by: 3 }],
    ]);
    expect(r.merged).toBe(false);
  });

  it("N4: merged PR found on page 1 but history truncated → the stranded verdict is inconclusive (merged:null)", async () => {
    const r = await land([
      ["/pulls?", (p) => (p.endsWith("&page=1") ? [merged, ...filler.slice(1)] : filler)],
      ["/branches/", { commit: { sha: "new222" } }],
      ["/compare/old111...new222", { status: "ahead", ahead_by: 2, behind_by: 0, files: [{ filename: "a.js" }] }],
      ["/compare/main...", { status: "diverged", ahead_by: 6, behind_by: 3, files: [{ filename: "a.js" }], base_commit: { sha: "tip" } }],
      ...DIFF_TREES("new222"),
      // TEAM-5935: a.js IS provably stranded — only the truncated PR history downgrades it to null.
      ...TRIPLE({ "a.js": "a0" }, { "a.js": "a0" }, { "a.js": "a1" }),
    ]);
    expect(r.merged).toBe(null);
    expect(r.reason).toMatch(/truncated at 10 pages/);
    expect(r.reason).toContain("2 commit(s) after its merged PR #846");
  });
});

describe("featureBranchLanding — TEAM-5913 (404 binds every recorded head; false needs positive evidence)", () => {
  const HEAD = "feature/EPIC-1-x";
  const apiFor = (routes) => async (path) => {
    for (const [k, v] of routes) if (path.includes(k)) return typeof v === "function" ? v(path) : v;
    return {};
  };
  const land = (routes, extra = {}) => completion.featureBranchLanding({ owner: "o", repo: "r", base: "main", head: HEAD, api: apiFor(routes), ...extra });
  const merged = { number: 846, merged_at: "2026-10-01T00:00:00Z", state: "closed", head: { sha: "old111abc" }, base: { ref: "main" }, merge_commit_sha: "m846", html_url: "https://github.com/o/r/pull/846" };
  const gone = () => { throw Object.assign(new Error("GitHub GET branches 404: Branch not found"), { status: 404 }); };

  // integration C-H-F, main C-S-T: S squashes H, T lands F's change via a fresh fix branch.
  it("TEAM-5913 (3): F landed independently — tip trees equal, compare diverged → merged:true (not a strand)", async () => {
    const r = await land([
      ["/pulls?", [merged]], ["/branches/", { commit: { sha: "F" } }],
      ["/compare/main...", { status: "diverged", ahead_by: 2, behind_by: 2, files: [{ filename: "f.js" }], merge_base_commit: { sha: "C" }, base_commit: { sha: "T" } }],
      ["/compare/m846...C", { status: "behind", ahead_by: 0, behind_by: 1 }],
      ["/compare/old111abc...F", { status: "ahead", ahead_by: 1, behind_by: 0, files: [{ filename: "f.js" }] }],
      ["/git/commits/T", { tree: { sha: "tree1" } }], ["/git/commits/F", { tree: { sha: "tree1" } }],
    ]);
    expect(r).toEqual({ merged: true, mergeCommit: "T", prUrl: "" }); // base: merged:false
  });

  it("TEAM-5913 (4): compares without `files` reaching the fallback → merged:null, never a proven strand", async () => {
    const r = await land([
      ["/pulls?", [merged]], ["/branches/", { commit: { sha: "F" } }],
      ["/compare/main...", { status: "diverged", ahead_by: 2, behind_by: 2, base_commit: { sha: "T" } }],
      ["/compare/old111abc...F", { status: "ahead", ahead_by: 1, behind_by: 0 }],
      ["/git/commits/T", { tree: { sha: "tree1" } }], ["/git/commits/F", { tree: { sha: "tree2" } }],
    ]);
    expect(r.merged).toBe(null); // base: merged:false
    expect(r.reason).toMatch(/no proof of unlanded content/);
  });

  it("TEAM-5913 → TEAM-5935: a tree lookup that fails → merged:null; files present + trees differ with no per-file evidence → merged:null, never false", async () => {
    const routes = (treeF) => [
      ["/pulls?", [merged]], ["/branches/", { commit: { sha: "F" } }],
      ["/compare/main...", { status: "diverged", ahead_by: 2, behind_by: 2, files: [{ filename: "f.js" }], base_commit: { sha: "T" } }],
      ["/compare/old111abc...F", { status: "ahead", ahead_by: 1, behind_by: 0, files: [{ filename: "f.js" }] }],
      ["/git/commits/T", { tree: { sha: "tree1" } }], ["/git/commits/F", treeF],
    ];
    expect((await land(routes(() => { throw Object.assign(new Error("500"), { status: 500 }); }))).merged).toBe(null);
    const differ = await land(routes({ tree: { sha: "tree2" } }));
    expect(differ.merged).toBe(null); // base (TEAM-5913): merged:false on tree inequality alone
    expect(differ.reason).toMatch(/no proof of unlanded content/);
  });

  it("TEAM-5913: 404 — every recorded head contained (equal or ancestor) → proof; one not contained, or a short sha → null", async () => {
    const ok = [["/pulls?", [merged]], ["/branches/", gone], ["/compare/fff0000...old111abc", { status: "ahead", ahead_by: 1, behind_by: 0 }]];
    expect(await land(ok, { recordedHeads: ["old111abc", "fff0000"] })).toEqual({ merged: true, mergeCommit: "m846", prUrl: merged.html_url });
    const bad = [["/pulls?", [merged]], ["/branches/", gone], ["/compare/fff0000...old111abc", { status: "behind", ahead_by: 0, behind_by: 1 }]];
    expect((await land(bad, { recordedHeads: ["old111abc", "fff0000"] })).merged).toBe(null);
    expect((await land(ok, { recordedHeads: ["old111"] })).merged).toBe(null);
    expect((await land(ok, { recordedHeads: [] })).merged).toBe(null);
  });

  it("TEAM-5913: recordedHeads — distinct, trimmed, independent of completedAt and order", () => {
    const { recordedHeads } = completion;
    expect(recordedHeads({
      "B-2": { commitSha: "fff0000bbbb ", completedAt: "2026-10-01T00:00:00Z" },
      "B-1": { commitSha: "head000aaaa", completedAt: "2026-10-03T00:00:00Z" },
      "B-3": { commitSha: "head000aaaa" },
      "B-4": { mergeCommit: "m846" },
    }).sort()).toEqual(["fff0000bbbb", "head000aaaa"]);
    expect(recordedHeads(undefined)).toEqual([]);
  });
});

describe("featureBranchLanding — TEAM-5935 (per-file proof; tree inequality is not a strand)", () => {
  const HEAD = "feature/EPIC-1-x";
  const apiFor = (routes, calls = []) => async (path) => {
    calls.push(path);
    for (const [k, v] of routes) if (path.includes(k)) return typeof v === "function" ? v(path) : v;
    return {};
  };
  const land = (routes, extra = {}, calls = []) =>
    completion.featureBranchLanding({ owner: "o", repo: "r", base: "main", head: HEAD, api: apiFor(routes, calls), ...extra });
  // integration C-H-F (PR #846 squashed H as S); main C-S-T-U. T independently lands F's change, U adds unrelated.js.
  const merged = { number: 846, merged_at: "2026-10-01T00:00:00Z", state: "closed", head: { sha: "H" }, base: { ref: "main" }, merge_commit_sha: "S", html_url: "https://github.com/o/r/pull/846" };
  const SHAPE = (afterFiles = [{ filename: "f.js" }]) => [
    ["/pulls?", [merged]], ["/branches/", { commit: { sha: "F" } }],
    ["/compare/main...", { status: "diverged", ahead_by: 2, behind_by: 3, files: [{ filename: "h.js" }, { filename: "f.js" }], merge_base_commit: { sha: "C" }, base_commit: { sha: "U" } }],
    ["/compare/S...C", { status: "behind", ahead_by: 0, behind_by: 1 }],
    ["/compare/H...F", { status: "ahead", ahead_by: 1, behind_by: 0, files: afterFiles }],
    ...COMMIT_TREES([["U", "treeU"], ["H", "treeH"], ["F", "treeF"]]),
  ];
  // the three indexes: main tip U, merged head H, branch tip F
  const T = (u, h, f) => [TREE("treeU", u), TREE("treeH", h), TREE("treeF", f)];
  const ALL = (files, sha) => Object.fromEntries(files.map((f) => [f.filename, sha]));
  const PREFIX = `feature branch ${HEAD} has 1 commit(s) after its merged PR #846 not contained in main and no open PR to main`;

  it("regression: F's change landed via T, U adds an unrelated file → trees differ but f.js identical on main → merged:true", async () => {
    const r = await land([...SHAPE(), ...T({ "f.js": "f1", "unrelated.js": "u1" }, { "f.js": "f0" }, { "f.js": "f1" })]);
    expect(r).toEqual({ merged: true, mergeCommit: "U", prUrl: "" }); // base: merged:false
  });

  it("T lands F's change, then U edits f.js further → third state on main → merged:null, never false", async () => {
    const r = await land([...SHAPE(), ...T({ "f.js": "f2" }, { "f.js": "f0" }, { "f.js": "f1" })]);
    expect(r.merged).toBe(null);
    expect(r.reason).toMatch(/unresolvable on base: f\.js/);
  });

  it("genuinely stranded: main still holds f.js at its pre-merge content, tip differs → merged:false naming the file", async () => {
    const r = await land([...SHAPE(), ...T({ "f.js": "f0" }, { "f.js": "f0" }, { "f.js": "f1" })]);
    expect(r.merged).toBe(false);
    expect(r.reason).toContain(PREFIX);
    expect(r.reason).toContain("main still holds the pre-merge content of: f.js");
  });

  it("new file added after the merge and never on main (absent at base AND before) → merged:false", async () => {
    const r = await land([...SHAPE([{ filename: "new.js", status: "added" }]), ...T({}, {}, { "new.js": "n1" })]);
    expect(r.merged).toBe(false);
    expect(r.reason).toContain("new.js");
  });

  it("mixed: one landed + one stranded → false naming only the stranded path; one landed + one unknown → null", async () => {
    const two = SHAPE([{ filename: "f.js" }, { filename: "g.js" }]);
    const r1 = await land([...two, ...T({ "f.js": "f1", "g.js": "g0" }, { "f.js": "f0", "g.js": "g0" }, { "f.js": "f1", "g.js": "g1" })]);
    expect(r1.merged).toBe(false);
    expect(r1.reason).toContain("pre-merge content of: g.js");
    expect(r1.reason).not.toContain("f.js");
    const r2 = await land([...two, ...T({ "f.js": "f1", "g.js": "g2" }, { "f.js": "f0", "g.js": "g0" }, { "f.js": "f1", "g.js": "g1" })]);
    expect(r2.merged).toBe(null);
  });

  it("the path is a tree entry (directory), the base tree read fails, or the base tree is truncated → merged:null, never false", async () => {
    const dir = await land([...SHAPE(), ...T({ "f.js": { sha: "d0", mode: "040000", type: "tree" } }, { "f.js": "f0" }, { "f.js": "f1" })]);
    expect(dir.merged).toBe(null);
    const boom = () => { throw Object.assign(new Error("500"), { status: 500 }); };
    const err = await land([...SHAPE(), ["/git/trees/treeU", boom], TREE("treeH", { "f.js": "f0" }), TREE("treeF", { "f.js": "f1" })]);
    expect(err.merged).toBe(null);
    // truncated index + path missing from it: absence is unknowable → null (a listed path still counts)
    const trunc = await land([...SHAPE(), TREE("treeU", { "other.js": "o1" }, { truncated: true }), TREE("treeH", { "f.js": "f0" }), TREE("treeF", { "f.js": "f1" })]);
    expect(trunc.merged).toBe(null);
    // and with NO tree evidence at all (routes fall through to {}) → null
    expect((await land(SHAPE())).merged).toBe(null);
  });

  it("renamed: new path identical on main AND old path absent on main → true; old path still on main → null", async () => {
    const ren = SHAPE([{ filename: "b.js", status: "renamed", previous_filename: "a.js" }]);
    expect(await land([...ren, ...T({ "b.js": "b1" }, { "a.js": "a0" }, { "b.js": "b1" })])).toEqual({ merged: true, mergeCommit: "U", prUrl: "" });
    expect((await land([...ren, ...T({ "b.js": "b1", "a.js": "a0" }, { "a.js": "a0" }, { "b.js": "b1" })])).merged).toBe(null);
  });

  it("truncation: 300 files all landed → null (list may be truncated); 300 files with one stranded in the first 50 → false", async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `p${i}.js` }));
    const same = ALL(files, "same");
    const r = await land([...SHAPE(files), ...T(same, same, same)]);
    expect(r.merged).toBe(null);
    expect(r.reason).toMatch(/truncated/);
    const r2 = await land([...SHAPE(files), ...T({ ...same, "p3.js": "x0" }, { ...same, "p3.js": "x0" }, { ...same, "p3.js": "x1" })]);
    expect(r2.merged).toBe(false);
  });

  it("cap: 51 files all landed → null (probe cap); 51 files with the first stranded → false", async () => {
    const files = Array.from({ length: 51 }, (_, i) => ({ filename: `p${i}.js` }));
    const same = ALL(files, "same");
    const r = await land([...SHAPE(files), ...T(same, same, same)]);
    expect(r.merged).toBe(null);
    expect(r.reason).toMatch(/probe cap/);
    const r2 = await land([...SHAPE(files), ...T({ ...same, "p0.js": "x0" }, { ...same, "p0.js": "x0" }, { ...same, "p0.js": "x1" })]);
    expect(r2.merged).toBe(false);
  });

  it("TEAM-5943: reads exactly ONE recursive tree per ref (matched by verbatim path) and never the Contents API", async () => {
    const calls = [];
    const r = await land([...SHAPE([{ filename: "src/a b/c#.js" }]), ...T({ "src/a b/c#.js": "same" }, { "src/a b/c#.js": "s0" }, { "src/a b/c#.js": "same" })], {}, calls);
    expect(r).toEqual({ merged: true, mergeCommit: "U", prUrl: "" });
    for (const t of ["treeU", "treeH", "treeF"]) expect(calls.filter((c) => c === `/repos/o/r/git/trees/${t}?recursive=1`)).toHaveLength(1);
    expect(calls.some((c) => c.includes("/contents/"))).toBe(false);
  });
});

describe("featureBranchLanding — TEAM-5943 (tree-entry identity: mode + sha, never blob sha alone)", () => {
  const HEAD = "feature/EPIC-1-x";
  const apiFor = (routes, calls = []) => async (path) => {
    calls.push(path);
    for (const [k, v] of routes) if (path.includes(k)) return typeof v === "function" ? v(path) : v;
    return {};
  };
  const land = (routes, calls = []) =>
    completion.featureBranchLanding({ owner: "o", repo: "r", base: "main", head: HEAD, api: apiFor(routes, calls) });
  // Same shape as TEAM-5935: integration C-H-F (PR #846 squashed H as S), main C-S-T-U.
  const merged = { number: 846, merged_at: "2026-10-01T00:00:00Z", state: "closed", head: { sha: "H" }, base: { ref: "main" }, merge_commit_sha: "S", html_url: "https://github.com/o/r/pull/846" };
  // GitHub lists a mode-only or type-only change as `modified` with changes: 0.
  const SHAPE = (path, afterFiles = [{ filename: path, status: "modified", changes: 0, additions: 0, deletions: 0 }]) => [
    ["/pulls?", [merged]], ["/branches/", { commit: { sha: "F" } }],
    ["/compare/main...", { status: "diverged", ahead_by: 2, behind_by: 3, files: [{ filename: "h.js" }, { filename: path }], merge_base_commit: { sha: "C" }, base_commit: { sha: "U" } }],
    ["/compare/S...C", { status: "behind", ahead_by: 0, behind_by: 1 }],
    ["/compare/H...F", { status: "ahead", ahead_by: 1, behind_by: 0, files: afterFiles }],
    ...COMMIT_TREES([["U", "treeU"], ["H", "treeH"], ["F", "treeF"]]),
  ];
  // What the Contents API really returns for such a change at EVERY ref: type "file" (even for some
  // symlinks) and the SAME blob sha — the legacy route the 59edc4b probe read. Present in every fixture
  // so the tests below are red on the blob-sha implementation and green on tree-entry identity.
  const LEGACY_CONTENTS = ["/contents/", { type: "file", sha: "X" }];
  const T = (u, h, f) => [TREE("treeU", u), TREE("treeH", h), TREE("treeF", f)];
  const REG = ["X", "100644"], EXEC = ["X", "100755"], LINK = ["X", "120000"];

  it("(a) mode-only change (100644 → 100755) not on main: same blob sha at every ref → merged:false (positive strand proof), never true", async () => {
    const calls = [];
    const r = await land([...SHAPE("bin/run.sh"), ...T({ "bin/run.sh": REG }, { "bin/run.sh": REG }, { "bin/run.sh": EXEC }), LEGACY_CONTENTS], calls);
    expect(r.merged).toBe(false);
    expect(r.reason).toContain("feature branch feature/EPIC-1-x has 1 commit(s) after its merged PR #846 not contained in main");
    expect(r.reason).toContain("main still holds the pre-merge content of: bin/run.sh");
    expect(calls.some((c) => c.includes("/contents/"))).toBe(false);
  });

  it("(b) regular file ↔ symlink with the same blob (target text == old content), both directions, not on main → merged:false, never true", async () => {
    const toLink = await land([...SHAPE("config/link"), ...T({ "config/link": REG }, { "config/link": REG }, { "config/link": LINK }), LEGACY_CONTENTS]);
    expect(toLink.merged).toBe(false);
    expect(toLink.reason).toContain("config/link");
    const toFile = await land([...SHAPE("config/link"), ...T({ "config/link": LINK }, { "config/link": LINK }, { "config/link": REG }), LEGACY_CONTENTS]);
    expect(toFile.merged).toBe(false);
    // main moved the entry to a THIRD state (already a symlink, different blob) → null, never false (TEAM-5935 S2-1)
    const third = await land([...SHAPE("config/link"), ...T({ "config/link": ["Y", "120000"] }, { "config/link": REG }, { "config/link": LINK }), LEGACY_CONTENTS]);
    expect(third.merged).toBe(null);
    expect(third.reason).toMatch(/unresolvable on base: config\/link/);
  });

  it("(c) mode change landed on main (identical mode + sha on main's tip) → merged:true; content landed without the mode → null, never false", async () => {
    const landed = await land([...SHAPE("bin/run.sh"), ...T({ "bin/run.sh": EXEC }, { "bin/run.sh": REG }, { "bin/run.sh": EXEC }), LEGACY_CONTENTS]);
    expect(landed).toEqual({ merged: true, mergeCommit: "U", prUrl: "" });
    // main took F's new content but kept 100644 → third state (neither pre-merge nor tip) → null
    const partial = await land([...SHAPE("bin/run.sh"), ...T({ "bin/run.sh": ["X1", "100644"] }, { "bin/run.sh": ["X0", "100644"] }, { "bin/run.sh": ["X1", "100755"] }), LEGACY_CONTENTS]);
    expect(partial.merged).toBe(null);
    // S2-1 restated: landed via T, plus an unrelated file on main (trees differ) → still true
    const unrelated = await land([...SHAPE("bin/run.sh"), ...T({ "bin/run.sh": EXEC, "unrelated.js": "u1" }, { "bin/run.sh": REG }, { "bin/run.sh": EXEC }), LEGACY_CONTENTS]);
    expect(unrelated.merged).toBe(true);
  });

  it("(d) identity unverifiable → merged:null, never true or false: no merged-head tree, truncated base index, non-blob entries", async () => {
    // the merged head's commit lookup fails → no `before` index: LANDED still provable, ABSENT never
    const noBefore = [...SHAPE("bin/run.sh")].filter(([k]) => k !== "/git/commits/H");
    expect((await land([...noBefore, ["/git/commits/H", () => { throw Object.assign(new Error("502"), { status: 502 }); }], ...T({ "bin/run.sh": REG }, {}, { "bin/run.sh": EXEC }), LEGACY_CONTENTS])).merged).toBe(null);
    expect((await land([...noBefore, ["/git/commits/H", () => { throw Object.assign(new Error("502"), { status: 502 }); }], ...T({ "bin/run.sh": EXEC }, {}, { "bin/run.sh": EXEC }), LEGACY_CONTENTS])).merged).toBe(true);
    // main's recursive tree is truncated and lacks the path → absence is unknowable
    expect((await land([...SHAPE("bin/run.sh"), TREE("treeU", { "other.js": "o1" }, { truncated: true }), TREE("treeH", { "bin/run.sh": REG }), TREE("treeF", { "bin/run.sh": EXEC }), LEGACY_CONTENTS])).merged).toBe(null);
    // a submodule (type commit, 160000) or a directory (type tree) entry at the path → unknown
    expect((await land([...SHAPE("vendor"), ...T({ vendor: { sha: "c1", mode: "160000", type: "commit" } }, { vendor: { sha: "c1", mode: "160000", type: "commit" } }, { vendor: { sha: "c2", mode: "160000", type: "commit" } }), LEGACY_CONTENTS])).merged).toBe(null);
    expect((await land([...SHAPE("vendor"), ...T({ vendor: { sha: "d1", mode: "040000", type: "tree" } }, { vendor: "v0" }, { vendor: "v1" }), LEGACY_CONTENTS])).merged).toBe(null);
  });
});

// TEAM-6032 (DL-038) — the open follow-up PR gate's pure pieces. Namespace import so a
// tree without these exports fails only these tests, not the whole file.
import * as completionMod from "./completion.mjs";

describe("TEAM-6032 followUpPrRefs", () => {
  it("one ref per PR number in the run's own repo; foreign repos and non-PR urls dropped", () => {
    const refs = completionMod.followUpPrRefs({
      a: { prUrl: "https://github.com/o/r/pull/12" },
      b: { prUrl: "https://github.com/O/R/pull/12" },          // same PR, case-insensitive repo
      c: { prUrl: "https://github.com/o/r/pull/9" },
      d: { prUrl: "https://github.com/hub/agentcore-hub/pull/7" }, // hub-infra PR: other repo
      e: { prUrl: "TBD" },
      f: { output: "no pr" },
    }, [{ owner: "o", repo: "r", defaultBranch: "main" }]);
    const R = { owner: "o", repo: "r", defaultBranch: "main" }; // TEAM-6062: each ref carries its repo
    expect(refs).toEqual([{ ...R, number: 12, url: "https://github.com/o/r/pull/12" }, { ...R, number: 9, url: "https://github.com/o/r/pull/9" }]);
  });
});

describe("TEAM-6032 classifyFollowUpPr", () => {
  const ctx = { featureBranch: "feature/E-1-x", defaultBranch: "main" };
  const pr = (over) => ({ state: "open", head: { ref: "fix/a" }, base: { ref: "main" }, ...over });
  it("open PR into the default branch → open", () => expect(completionMod.classifyFollowUpPr(pr(), ctx)).toBe("open"));
  it("merged or closed-unmerged → closed", () => {
    expect(completionMod.classifyFollowUpPr(pr({ state: "closed", merged_at: "t" }), ctx)).toBe("closed");
    expect(completionMod.classifyFollowUpPr(pr({ state: "closed", merged_at: null }), ctx)).toBe("closed");
  });
  it("the unified PR (head = feature branch) → skip", () => expect(completionMod.classifyFollowUpPr(pr({ head: { ref: "feature/E-1-x" } }), ctx)).toBe("skip"));
  it("a PR into the integration branch (pre-merge fix) → skip", () => expect(completionMod.classifyFollowUpPr(pr({ base: { ref: "feature/E-1-x" } }), ctx)).toBe("skip"));
  it("missing shape → unknown", () => {
    expect(completionMod.classifyFollowUpPr(null, ctx)).toBe("unknown");
    expect(completionMod.classifyFollowUpPr({}, ctx)).toBe("unknown");
  });
});

describe("TEAM-6032 openFollowUpPrs", () => {
  it("returns open urls; a failed read is unknown, never open", async () => {
    const byNo = { 1: { state: "open", head: { ref: "fix/a" }, base: { ref: "main" } }, 2: { state: "closed", merged_at: "t", head: { ref: "fix/b" }, base: { ref: "main" } } };
    const api = async (path) => {
      const n = path.split("/pulls/")[1];
      if (n === "3") throw Object.assign(new Error("500"), { status: 500 });
      return byNo[n];
    };
    const refs = [1, 2, 3].map((n) => ({ number: n, url: `u${n}` }));
    const r = await completionMod.openFollowUpPrs({ owner: "o", repo: "r", refs, featureBranch: "feature/E-1-x", defaultBranch: "main", api });
    expect(r).toEqual({ open: ["u1"], unknown: ["u3"] });
  });
});

describe("TEAM-6032 completionBlockedNotice open_follow_up_pr", () => {
  it("own slug, names the PRs and the remedy", () => {
    const n = completionMod.completionBlockedNotice("open_follow_up_pr", "https://github.com/o/r/pull/12", {});
    expect(n.slug).toMatch(/^followup_pr_[0-9a-f]{8}$/); // TEAM-6062: keyed by the open-PR set
    expect(n.details).toContain("https://github.com/o/r/pull/12");
    expect(n.details).toContain("CI → Ship → Merge Approval → CD");
  });
});

describe("TEAM-6032 followUpPrGate", () => {
  const OPEN = { state: "open", head: { ref: "fix/a" }, base: { ref: "main" } };
  const wf = (agentTasks) => ({ id: "wf", featureBranch: "feature/E-1-x", repoConfig: { repos: [{ defaultBranch: "main" }] }, agentTasks });
  const tasks = { S: { agentId: "rm", mergeCommit: "m1" }, F: { prUrl: "https://github.com/o/r/pull/12" } };
  const base = { repoRef: () => [{ owner: "o", repo: "r", defaultBranch: "main" }], getAgentPhase: (id) => (id === "rm" ? "ship" : "development"), warn: () => {} };
  it("unified PR merged (ship-phase mergeCommit) + open follow-up → returns it", async () => {
    const open = await completionMod.followUpPrGate({ ...base, workflow: wf(tasks), agentTasks: tasks, mergeProof: null, api: async () => OPEN });
    expect(open).toEqual(["https://github.com/o/r/pull/12"]);
  });
  it("not merged yet → never reads GitHub", async () => {
    const t = { F: tasks.F };
    let calls = 0;
    const open = await completionMod.followUpPrGate({ ...base, workflow: wf(t), agentTasks: t, mergeProof: null, api: async () => (calls++, OPEN) });
    expect([open, calls]).toEqual([[], 0]);
  });
  it("a throwing repoRef is fail-open with a warn", async () => {
    const warns = [];
    const open = await completionMod.followUpPrGate({ ...base, repoRef: () => { throw new Error("no repo"); }, warn: (m) => warns.push(m), workflow: wf(tasks), agentTasks: tasks, mergeProof: { merged: true }, api: async () => OPEN });
    expect(open).toEqual([]);
    expect(warns[0]).toContain("follow-up PR check skipped");
  });
});

// TEAM-6062 — review of #928: the gate must read the record's pr_url (prUrl is
// fill-once), key its notice by the open-PR set, and check every configured repo.
describe("TEAM-6062 follow-up PR gate", () => {
  const ON = (base) => ({ state: "open", head: { ref: "fix/a" }, base: { ref: base } });
  const wf2 = { id: "wf", featureBranch: "feature/E-1-x", repoConfig: { repos: [
    { url: "https://github.com/o/r", defaultBranch: "main" },
    { url: "https://github.com/o/r2.git", defaultBranch: "develop" },
  ] } };
  const MERGED = { S: { agentId: "rm", mergeCommit: "m1" } };
  const getAgentPhase = (id) => (id === "rm" ? "ship" : "development");
  const byPath = (map) => async (path) => map[path];

  it("TEAM-6062 followUpPrRefs: completion-record pr_url is used alongside a stale cached prUrl", () => {
    const refs = completionMod.followUpPrRefs(
      { F: { prUrl: "https://github.com/o/r/pull/11" } },
      [{ owner: "o", repo: "r", defaultBranch: "main" }],
      { F: { pr_url: "https://github.com/o/r/pull/12" } },
    );
    expect(refs.map((r) => r.number).sort()).toEqual([11, 12]);
  });

  it("TEAM-6062 followUpPrGate: stale cached integration PR + record PR open to main → returns the record PR", async () => {
    const tasks = { ...MERGED, F: { prUrl: "https://github.com/o/r/pull/11" } };
    const open = await completionMod.followUpPrGate({
      workflow: wf2, agentTasks: tasks, mergeProof: null, getAgentPhase, warn: () => {},
      readCompletionRecord: async (tid) => (tid === "F" ? { pr_url: "https://github.com/o/r/pull/12" } : null),
      api: byPath({ "/repos/o/r/pulls/11": ON("feature/E-1-x"), "/repos/o/r/pulls/12": ON("main") }),
    });
    expect(open).toEqual(["https://github.com/o/r/pull/12"]);
  });

  it("TEAM-6062 completionBlockedNotice open_follow_up_pr: slug hashes the sorted PR set", () => {
    const slug = (d) => completionMod.completionBlockedNotice("open_follow_up_pr", d, {}).slug;
    const a = "https://github.com/o/r/pull/12", b = "https://github.com/o/r/pull/13";
    expect(slug(`${a}, ${b}`)).toMatch(/^followup_pr_[0-9a-f]{8}$/);
    expect(slug(`${a}, ${b}`)).toBe(slug(`${b}, ${a}`));
    expect(slug(a)).not.toBe(slug(`${a}, ${b}`));
    expect(completionMod.completionBlockedNotice("unmerged_branch", "x", {}).slug).toBe("unmerged");
  });

  it("TEAM-6062 followUpPrGate: two-repo config, open PR in repos[1] into its own default branch → returned", async () => {
    const tasks = { ...MERGED, G: { prUrl: "https://github.com/o/r2/pull/34" } };
    const open = await completionMod.followUpPrGate({
      workflow: wf2, agentTasks: tasks, mergeProof: null, getAgentPhase, warn: () => {},
      api: byPath({ "/repos/o/r2/pulls/34": ON("develop") }),
    });
    expect(open).toEqual(["https://github.com/o/r2/pull/34"]);
  });

  it("TEAM-6062 followUpPrGate: repos[1] PR into a non-default base → skip", async () => {
    const tasks = { ...MERGED, G: { prUrl: "https://github.com/o/r2/pull/34" } };
    const open = await completionMod.followUpPrGate({
      workflow: wf2, agentTasks: tasks, mergeProof: null, getAgentPhase, warn: () => {},
      api: byPath({ "/repos/o/r2/pulls/34": ON("main") }),
    });
    expect(open).toEqual([]);
  });
});

// TEAM-6075 — review round 2 of #928: a non-string record pr_url must not disable the
// gate (per-value skip, not a thrown TypeError into the fail-open catch), and the repo
// parser must keep dotted repo names (`my.repo`) whole.
describe("TEAM-6075 follow-up PR gate hardening", () => {
  const ON = (base) => ({ state: "open", head: { ref: "fix/a" }, base: { ref: base } });
  const MERGED = { S: { agentId: "rm", mergeCommit: "m1" } };
  const getAgentPhase = (id) => (id === "rm" ? "ship" : "development");
  const byPath = (map) => async (path) => map[path];
  const R = [{ owner: "o", repo: "r", defaultBranch: "main" }];
  const wf = (repos) => ({ id: "wf", featureBranch: "feature/E-1-x", repoConfig: { repos } });
  const P12 = "https://github.com/o/r/pull/12", P13 = "https://github.com/o/r/pull/13";

  it("TEAM-6075 followUpPrGate: readCompletionRecord throws synchronously → falls back to cached prUrl", async () => {
    const tasks = { ...MERGED, F: { prUrl: P12 } };
    const open = await completionMod.followUpPrGate({
      workflow: wf([{ url: "https://github.com/o/r", defaultBranch: "main" }]), agentTasks: tasks, mergeProof: null, getAgentPhase, warn: () => {},
      readCompletionRecord: () => { throw new Error("s3"); },
      api: byPath({ "/repos/o/r/pulls/12": ON("main") }),
    });
    expect(open).toEqual([P12]);
  });

  it("TEAM-6075 followUpPrGate: readCompletionRecord rejects → falls back to cached prUrl", async () => {
    const tasks = { ...MERGED, F: { prUrl: P12 } };
    const open = await completionMod.followUpPrGate({
      workflow: wf([{ url: "https://github.com/o/r", defaultBranch: "main" }]), agentTasks: tasks, mergeProof: null, getAgentPhase, warn: () => {},
      readCompletionRecord: async () => { throw new Error("s3 down"); },
      api: byPath({ "/repos/o/r/pulls/12": ON("main") }),
    });
    expect(open).toEqual([P12]);
  });

  it("TEAM-6075 followUpPrRefs: empty-string and null record pr_url fall back to cached prUrl", () => {
    for (const records of [{ F: { pr_url: "" } }, { F: { pr_url: null } }, { F: null }, {}]) {
      const refs = completionMod.followUpPrRefs({ F: { prUrl: P12 } }, R, records);
      expect(refs.map((r) => r.number)).toEqual([12]);
    }
  });

  it("TEAM-6075 repoTargets: repo entry with no defaultBranch is treated as main", async () => {
    expect(completionMod.repoTargets({ repos: [{ url: "https://github.com/o/r" }] })).toEqual(R);
    const tasks = { ...MERGED, F: { prUrl: P12 } };
    const open = await completionMod.followUpPrGate({
      workflow: wf([{ url: "https://github.com/o/r" }]), agentTasks: tasks, mergeProof: null, getAgentPhase, warn: () => {},
      api: byPath({ "/repos/o/r/pulls/12": ON("main") }),
    });
    expect(open).toEqual([P12]);
  });

  it("TEAM-6075 followUpPrRefs: /files suffix, uppercase owner/repo and trailing slash dedupe to one PR", () => {
    const refs = completionMod.followUpPrRefs({
      a: { prUrl: P12 },
      b: { prUrl: "https://github.com/O/R/pull/12/files" },
      c: { prUrl: "https://github.com/o/r/pull/12/" },
    }, R);
    expect(refs).toEqual([{ ...R[0], number: 12, url: P12 }]);
  });

  it("TEAM-6075 followUpPrGate: non-string record pr_url on one ticket is skipped; another ticket's open PR still refuses", async () => {
    const tasks = { ...MERGED, F: { prUrl: "https://github.com/o/r/pull/11" }, G: { prUrl: P13 } };
    const open = await completionMod.followUpPrGate({
      workflow: wf([{ url: "https://github.com/o/r", defaultBranch: "main" }]), agentTasks: tasks, mergeProof: null, getAgentPhase, warn: () => {},
      // A one-element array stringifies to a URL the PR regex matches — then `.trim()` throws.
      readCompletionRecord: async (tid) => (tid === "F" ? { pr_url: [P12] } : null),
      api: byPath({ "/repos/o/r/pulls/11": ON("feature/E-1-x"), "/repos/o/r/pulls/12": ON("main"), "/repos/o/r/pulls/13": ON("main") }),
    });
    expect(open).toEqual([P13]);
  });

  it("TEAM-6075 followUpPrRefs: non-string pr_url (array / number / object) never throws", () => {
    for (const bad of [[P12], 12, { url: P12 }, true]) {
      const refs = completionMod.followUpPrRefs({ F: { prUrl: P13 } }, R, { F: { pr_url: bad } });
      expect(refs.map((r) => r.number)).toEqual([13]);
    }
  });

  it("TEAM-6075 repoTargets: dotted repo name is kept whole (my.repo, my.repo.git, trailing slash)", () => {
    for (const url of ["https://github.com/o/my.repo", "https://github.com/o/my.repo.git", "https://github.com/o/my.repo/"]) {
      expect(completionMod.repoTargets({ repos: [{ url, defaultBranch: "main" }] })).toEqual([{ owner: "o", repo: "my.repo", defaultBranch: "main" }]);
    }
  });

  it("TEAM-6075 followUpPrGate: dotted repo name — the run's PRs are checked (default repoRef)", async () => {
    const P5 = "https://github.com/o/my.repo/pull/5";
    const tasks = { ...MERGED, F: { prUrl: P5 } };
    const open = await completionMod.followUpPrGate({
      workflow: wf([{ url: "https://github.com/o/my.repo.git", defaultBranch: "main" }]), agentTasks: tasks, mergeProof: null, getAgentPhase, warn: () => {},
      api: byPath({ "/repos/o/my.repo/pulls/5": ON("main") }),
    });
    expect(open).toEqual([P5]);
  });
});
