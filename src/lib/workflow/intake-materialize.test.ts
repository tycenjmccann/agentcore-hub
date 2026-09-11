import { describe, it, expect } from "vitest";
import {
  DEFAULT_GATE_ASSIGNEE,
  HUB_MATERIALIZED_MARKER,
  activeGates,
  assertWriteOrder,
  effectiveDefFor,
  gateSlug,
  intakeTicketTitle,
  isMaterialized,
  planIntakeTickets,
  resolvePhaseAssignee,
} from "./intake-materialize";
import type { PlanContext, TicketPlanItem } from "./intake-materialize";
import type { RosterAgent } from "./roster-loader";
import type { WorkflowInput } from "./types";
import type { ReviewGate, WorkflowDef, WorkflowDefPhase } from "./workflow-defs";
import { getWorkflowDef } from "./workflow-defs";

/**
 * TEAM-4453 D1 — the hub-side intake planner.
 *
 * Two things are pinned here. First, PARITY: every def that has not opted in
 * (`intakeMaterialization` absent) must plan exactly one ticket, with the same
 * title/description/assignee/blockers the route wrote before this module existed
 * — those runs must not change at all. Second, the operator SKELETON: the exact
 * items, order, assignees and dependency wiring, for both a CD-registered repo
 * and a handoff, because the executor writes them blindly in array order.
 */

const INPUT: WorkflowInput = {
  title: "Add a retry to the uploader",
  description: "It fails on 502.",
  repoConfig: { layout: "multi-repo", repos: [] },
  sources: [],
};

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  return { workflowId: "wf_1", epicId: "TEAM-1", roster: [], cdRegistered: false, ...over };
}

/** The bundled operator def — this also pins the workflows.json opt-in. */
const OPERATOR = getWorkflowDef("operator");
const SOFTWARE_DELIVERY = getWorkflowDef("software-delivery");

const AGENT_DEF: WorkflowDef = {
  id: "two-phase",
  name: "Two Phase",
  description: "test",
  icon: "Workflow",
  intakeAgentId: "planner_agent",
  requiresRepo: false,
  featureBranchPhase: null,
  createsPullRequest: false,
  completionRequiresAgentPhases: ["development"],
  phases: [
    { id: "intake", name: "Intake", type: "app", agentPhase: "intake" },
    { id: "spec", name: "Spec", type: "agent", agentPhase: "requirements" },
    { id: "build", name: "Build", type: "agent", agentPhase: "development" },
  ],
};

/** Same def, hub-materialized — the isolated way to exercise the loop's branches. */
function hubDef(over: Partial<WorkflowDef> = {}): WorkflowDef {
  return { ...AGENT_DEF, intakeMaterialization: "hub", ...over };
}

const ROSTER: RosterAgent[] = [
  { agentId: "spec_writer", phase: "requirements", workflowDefIds: ["two-phase"] },
  { agentId: "dev_one", phase: "development", workflowDefIds: ["two-phase"] },
];

describe("agent-mode parity (every def that has not opted in)", () => {
  it("plans exactly one item — the legacy intake ticket, unchanged", () => {
    const plan = planIntakeTickets(SOFTWARE_DELIVERY, INPUT, ctx());
    expect(plan.mode).toBe("agent");
    expect(plan.items).toHaveLength(1);
    expect(plan.deferred).toEqual([]);
    const [item] = plan.items;
    expect(item.key).toBe("phase:requirements");
    expect(item.summary).toBe(intakeTicketTitle(SOFTWARE_DELIVERY, INPUT.title));
    expect(item.summary).toBe(`Intake: ${SOFTWARE_DELIVERY.intakeAgentId} — ${INPUT.title}`);
    expect(item.assignee).toBe(SOFTWARE_DELIVERY.intakeAgentId);
    expect(item.description).toBe(
      `Analyze the request and create tickets for the relevant agents.\n\nTitle: ${INPUT.title}\nDescription: ${INPUT.description}`
    );
    expect(item.description).not.toContain(HUB_MATERIALIZED_MARKER);
    expect(item.blockedByKeys).toEqual([]);
    expect(item.externalBlockedBy).toEqual([]);
    expect(item.readyOnCreate).toBe(true);
    expect(item.labels).toEqual(["wfdef:software-delivery", "phase:requirements"]);
  });

  it("waits behind a hub-created Intent Acceptance gate when there is one", () => {
    const plan = planIntakeTickets(SOFTWARE_DELIVERY, INPUT, ctx({ intentGateTicketId: "TEAM-2" }));
    expect(plan.items).toHaveLength(1);
    const [item] = plan.items;
    expect(item.externalBlockedBy).toEqual(["TEAM-2"]);
    expect(item.readyOnCreate).toBe(false);
    expect(item.description).toBe(
      `Turn the accepted intent (workflows/wf_1/shared/intent.md) into the spec and the ticket plan. ` +
        `Blocked until the product owner approves the Intent Acceptance gate TEAM-2.\n\nTitle: ${INPUT.title}`
    );
  });

  it("ignores review gates entirely — the agent still plans them", () => {
    const plan = planIntakeTickets(SOFTWARE_DELIVERY, INPUT, ctx({ cdRegistered: true }));
    expect(plan.items.map((i) => i.kind)).toEqual(["phase"]);
    expect(plan.deferred).toEqual([]);
  });
});

describe("operator skeleton (hub mode)", () => {
  it("CD-registered → build, Merge Approval gate, ship — in write order", () => {
    const plan = planIntakeTickets(OPERATOR, INPUT, ctx({ cdRegistered: true }));
    expect(plan.mode).toBe("hub");
    expect(plan.deferred).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(
      plan.items.map((i) => ({ key: i.key, assignee: i.assignee, phase: i.phase, blockedBy: i.blockedByKeys }))
    ).toEqual([
      { key: "phase:development", assignee: "agentcore_hub_operator", phase: "development", blockedBy: [] },
      {
        key: "gate:merge-approval@development",
        assignee: "human:engineer",
        phase: "development",
        blockedBy: ["phase:development"],
      },
      {
        key: "phase:ship",
        assignee: "agentcore_hub_operator",
        phase: "ship",
        blockedBy: ["gate:merge-approval@development"],
      },
    ]);

    const [build, gate, ship] = plan.items;
    // Item 0 is the operator's REAL Build ticket, titled with the Build phase
    // (not "Intake:"), and it says the skeleton already exists.
    expect(build.summary).toBe(`Build: agentcore_hub_operator — ${INPUT.title}`);
    expect(build.description).toContain(HUB_MATERIALIZED_MARKER);
    expect(build.description).toContain("do not create gate or ship tickets");
    expect(build.readyOnCreate).toBe(true);
    expect(build.labels).toEqual(["wfdef:operator", "phase:development"]);

    expect(gate.kind).toBe("gate");
    expect(gate.gateName).toBe("Merge Approval");
    expect(gate.summary).toBe(`Merge Approval: ${INPUT.title}`);
    expect(gate.labels).toEqual(["wfdef:operator", "phase:development", "gate:merge-approval"]);
    expect(gate.readyOnCreate).toBe(false);
    expect(gate.description).toContain("Blocking: yes");
    expect(gate.description).toContain("Assignee: human:engineer");
    expect(gate.description).toContain("Review cap: 3 round(s)");
    expect(gate.description).toContain("CD_REGISTERED");
    expect(gate.description).toContain(`"materializedBy":"hub"`);

    expect(ship.summary).toBe(`Ship: agentcore_hub_operator — ${INPUT.title}`);
    expect(ship.description).toContain("report outcome=shipped");
    expect(ship.readyOnCreate).toBe(false);

    assertWriteOrder(plan.items);
  });

  it("handoff → build + gate only; no ship ticket is planned", () => {
    const plan = planIntakeTickets(OPERATOR, INPUT, ctx({ cdRegistered: false }));
    expect(plan.items.map((i) => i.key)).toEqual(["phase:development", "gate:merge-approval@development"]);
    expect(plan.deferred).toEqual([]);
    expect(plan.items[1].description).toContain("HANDOFF");
    expect(plan.items[1].description).toContain("approving here does not trigger a deploy");
  });

  it("a gate's assignee comes from the def, never from the request", () => {
    const spoofed = { ...INPUT, reviewGates: ["development"], intent: undefined } as WorkflowInput & {
      gateAssignee?: string;
    };
    spoofed.gateAssignee = "human:attacker";
    const plan = planIntakeTickets(OPERATOR, spoofed, ctx({ cdRegistered: true }));
    expect(plan.items.find((i) => i.kind === "gate")!.assignee).toBe("human:engineer");
  });

  it("defaults a reviewer-less gate to human:reviewer", () => {
    const def = hubDef({
      reviewGates: [{ afterPhase: "requirements", name: "Spec Review", blocking: true, condition: "always", onReject: "hold" }],
    });
    const plan = planIntakeTickets(def, INPUT, ctx({ roster: ROSTER }));
    expect(plan.items.find((i) => i.kind === "gate")!.assignee).toBe(DEFAULT_GATE_ASSIGNEE);
  });
});

describe("dependency wiring in hub mode", () => {
  it("a blocking gate takes the next phase's place in the chain; an advisory one does not", () => {
    const blocking = planIntakeTickets(
      hubDef({
        reviewGates: [{ afterPhase: "requirements", name: "Spec Review", blocking: true, condition: "always", onReject: "rework" }],
      }),
      INPUT,
      ctx({ roster: ROSTER })
    );
    expect(blocking.items.map((i) => i.key)).toEqual([
      "phase:requirements",
      "gate:spec-review@requirements",
      "phase:development",
    ]);
    expect(blocking.items[2].blockedByKeys).toEqual(["gate:spec-review@requirements"]);

    const advisory = planIntakeTickets(
      hubDef({
        reviewGates: [{ afterPhase: "requirements", name: "Spec Review", blocking: false, condition: "always", onReject: "hold" }],
      }),
      INPUT,
      ctx({ roster: ROSTER })
    );
    // Same tickets, but development waits on the WORK, not on the advisory gate.
    expect(advisory.items[2].blockedByKeys).toEqual(["phase:requirements"]);
  });

  it("resolves the downstream assignee from the roster and needs no warning", () => {
    const plan = planIntakeTickets(hubDef(), INPUT, ctx({ roster: ROSTER }));
    expect(plan.items.map((i) => i.assignee)).toEqual(["planner_agent", "dev_one"]);
    expect(plan.warnings).toEqual([]);
  });

  it("an empty roster falls back to the intake agent and warns once per phase", () => {
    const plan = planIntakeTickets(hubDef(), INPUT, ctx({ roster: [] }));
    expect(plan.items.map((i) => i.assignee)).toEqual(["planner_agent", "planner_agent"]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('phase "development" has no roster agent bound to def "two-phase"');
  });

  it("an ambiguous phase is deferred, and everything after it is deferred too", () => {
    const def = hubDef({
      phases: [
        ...AGENT_DEF.phases,
        { id: "verify", name: "Verify", type: "agent", agentPhase: "verification" },
      ],
    });
    const roster: RosterAgent[] = [
      { agentId: "dev_two", phase: "development", workflowDefIds: ["two-phase"] },
      ...ROSTER,
    ];
    const plan = planIntakeTickets(def, INPUT, ctx({ roster }));
    expect(plan.items.map((i) => i.key)).toEqual(["phase:requirements"]);
    expect(plan.deferred).toEqual([
      {
        phase: "development",
        reason: "multiple-assignees",
        detail: 'phase "development" has 2 candidate agents — refusing to guess',
        candidates: ["dev_one", "dev_two"],
      },
      {
        phase: "verification",
        reason: "upstream-deferred",
        detail: 'an earlier phase was deferred, so "verification" has no hub-planned blocker to wait on',
      },
    ]);
  });

  it("an active gate whose phase is never materialized is reported, not dropped", () => {
    const def = hubDef({
      reviewGates: [{ afterPhase: "ship", name: "Merge Approval", blocking: true, condition: "always", onReject: "rework" }],
    });
    // cdRegistered so effectiveDefFor keeps the ship gate; the def has no ship phase.
    const plan = planIntakeTickets(def, INPUT, ctx({ roster: ROSTER, cdRegistered: true }));
    expect(plan.items.every((i) => i.kind === "phase")).toBe(true);
    expect(plan.deferred).toEqual([
      {
        phase: "ship",
        reason: "no-planned-upstream",
        detail: 'gate "Merge Approval" guards phase "ship", which this plan does not materialize',
      },
    ]);
  });
});

describe("effectiveDefFor (mirror of stripShipPhases)", () => {
  it("returns the def itself when CD-registered", () => {
    expect(effectiveDefFor(OPERATOR, { cdRegistered: true })).toBe(OPERATOR);
  });

  it("returns the def itself for a handoff with nothing to strip", () => {
    expect(effectiveDefFor(AGENT_DEF, { cdRegistered: false })).toBe(AGENT_DEF);
  });

  it("strips ship completion phases and ship gates on a handoff", () => {
    const eff = effectiveDefFor(OPERATOR, { cdRegistered: false });
    expect(eff).not.toBe(OPERATOR);
    expect(eff.completionRequiresAgentPhases).toEqual(["development"]);
    expect(eff.reviewGates!.map((g) => g.afterPhase)).toEqual(["development"]);
    expect((eff as WorkflowDef & { cdHandoff?: boolean }).cdHandoff).toBe(true);
    // The mirror does NOT filter phases — the planner skips them itself.
    expect(eff.phases.map((p) => p.agentPhase)).toEqual(OPERATOR.phases.map((p) => p.agentPhase));
  });
});

describe("resolvePhaseAssignee", () => {
  const phase: WorkflowDefPhase = { id: "build", name: "Build", type: "agent", agentPhase: "development" };

  it("phase.agentId always wins", () => {
    expect(resolvePhaseAssignee({ ...phase, agentId: "chosen" }, AGENT_DEF, ROSTER)).toEqual({
      assignee: "chosen",
      how: "phase-agentId",
    });
  });

  it("a single roster match is used", () => {
    expect(resolvePhaseAssignee(phase, AGENT_DEF, ROSTER)).toEqual({ assignee: "dev_one", how: "roster-unique" });
  });

  it("de-dupes a doubly-listed agent instead of calling it ambiguous", () => {
    const roster = [...ROSTER, { agentId: "dev_one", phase: "development", workflowDefIds: ["two-phase"] }];
    expect(resolvePhaseAssignee(phase, AGENT_DEF, roster)).toEqual({ assignee: "dev_one", how: "roster-unique" });
  });

  it("falls back to the intake agent (with a warning) when the roster is empty", () => {
    const res = resolvePhaseAssignee(phase, AGENT_DEF, []);
    expect(res.assignee).toBe("planner_agent");
    expect(res.how).toBe("intake-fallback");
  });

  it("refuses to guess between candidates, sorted", () => {
    const roster = [{ agentId: "dev_z", phase: "development" as string, workflowDefIds: ["two-phase"] }, ...ROSTER];
    expect(resolvePhaseAssignee(phase, AGENT_DEF, roster)).toEqual({
      assignee: null,
      how: "multiple",
      candidates: ["dev_one", "dev_z"],
    });
  });

  it("applies the repo-wide def fallback: an untagged agent belongs to software-delivery", () => {
    const untagged: RosterAgent[] = [{ agentId: "legacy_dev", phase: "development" }];
    // Not bound to "two-phase"…
    expect(resolvePhaseAssignee(phase, AGENT_DEF, untagged).how).toBe("intake-fallback");
    // …but bound to software-delivery, whose defId it inherits.
    expect(resolvePhaseAssignee(phase, SOFTWARE_DELIVERY, untagged)).toEqual({
      assignee: "legacy_dev",
      how: "roster-unique",
    });
  });
});

describe("activeGates", () => {
  const gates: ReviewGate[] = [
    { afterPhase: "intake", name: "Intent Acceptance", blocking: true, condition: "always", onReject: "hold" },
    { afterPhase: "development", name: "Merge Approval", blocking: true, condition: "always", onReject: "rework" },
    { afterPhase: "requirements", name: "Spec Review", blocking: true, condition: "flagged", onReject: "rework" },
  ];
  const def = { ...AGENT_DEF, reviewGates: gates };

  it("keeps always-gates and excludes the intake gate (the route creates that one)", () => {
    expect(activeGates(def).map((g) => g.afterPhase)).toEqual(["development"]);
  });

  it("includes a flagged gate only when the run requested it", () => {
    expect(activeGates(def, ["requirements"]).map((g) => g.afterPhase)).toEqual(["development", "requirements"]);
    expect(activeGates(def, ["intake"]).map((g) => g.afterPhase)).toEqual(["development"]);
  });

  it("tolerates junk in place of the requested list", () => {
    expect(activeGates(def, undefined as unknown as string[]).map((g) => g.afterPhase)).toEqual(["development"]);
    expect(activeGates(def, "requirements" as unknown as string[]).map((g) => g.afterPhase)).toEqual(["development"]);
  });
});

describe("assertWriteOrder", () => {
  const item = (key: string, blockedByKeys: string[]): TicketPlanItem => ({
    key,
    kind: "phase",
    summary: key,
    assignee: "a",
    phase: "p",
    description: "",
    blockedByKeys,
    externalBlockedBy: [],
    readyOnCreate: false,
    labels: [],
  });

  it("accepts a backward reference", () => {
    expect(() => assertWriteOrder([item("a", []), item("b", ["a"])])).not.toThrow();
  });

  it("throws on a forward reference", () => {
    expect(() => assertWriteOrder([item("a", ["b"]), item("b", [])])).toThrow(/write-order violation/);
  });

  it("throws on a self reference", () => {
    expect(() => assertWriteOrder([item("a", ["a"])])).toThrow(/write-order violation/);
  });
});

describe("isMaterialized (the blueprint's verify-then-create fallback)", () => {
  const plan = planIntakeTickets(OPERATOR, INPUT, ctx({ cdRegistered: true }));
  const [build, gate, ship] = plan.items;

  it("matches a gate on its title prefix or its gate label", () => {
    expect(isMaterialized({ title: `Merge Approval: ${INPUT.title}`, assignee: "human:engineer" }, gate, "wf_1")).toBe(true);
    expect(isMaterialized({ title: "Something else", assignee: "human:x", labels: ["gate:merge-approval"] }, gate, "wf_1")).toBe(true);
  });

  it("never matches a gate to an agent-assigned ticket", () => {
    expect(isMaterialized({ title: `Merge Approval: ${INPUT.title}`, assignee: "agentcore_hub_operator" }, gate, "wf_1")).toBe(false);
  });

  it("matches a phase ticket on its phase stamp", () => {
    expect(isMaterialized({ title: "anything", assignee: "agentcore_hub_operator", phase: "ship" }, ship, "wf_1")).toBe(true);
    expect(isMaterialized({ title: "anything", assignee: "agentcore_hub_operator", phase: "development" }, ship, "wf_1")).toBe(false);
  });

  it("SR-1.2: falls back to the title prefix when list_tickets exposes no phase", () => {
    expect(isMaterialized({ title: `Ship: agentcore_hub_operator — ${INPUT.title}`, assignee: "agentcore_hub_operator" }, ship, "wf_1")).toBe(true);
    expect(isMaterialized({ title: `Build: agentcore_hub_operator — ${INPUT.title}`, assignee: "agentcore_hub_operator" }, ship, "wf_1")).toBe(false);
  });

  it("derives the phase from the roster when the ticket carries no stamp", () => {
    const roster: RosterAgent[] = [{ agentId: "dev_one", phase: "development" }];
    expect(isMaterialized({ title: "no prefix", assignee: "dev_one" }, build, "wf_1", roster)).toBe(true);
  });

  it("rejects another run's ticket, the epic, and a cancelled ticket", () => {
    expect(isMaterialized({ title: `Ship: x — y`, assignee: "a", workflowId: "wf_2", phase: "ship" }, ship, "wf_1")).toBe(false);
    expect(isMaterialized({ title: `Ship: x — y`, assignee: "a", type: "epic", phase: "ship" }, ship, "wf_1")).toBe(false);
    expect(isMaterialized({ title: `Ship: x — y`, assignee: "a", status: "cancelled", phase: "ship" }, ship, "wf_1")).toBe(false);
    expect(isMaterialized(undefined as unknown as { title: string }, ship, "wf_1")).toBe(false);
  });
});

describe("gateSlug", () => {
  it("lower-cases, collapses punctuation, and trims", () => {
    expect(gateSlug("Merge Approval")).toBe("merge-approval");
    expect(gateSlug("  QA & CI  ")).toBe("qa-ci");
    expect(gateSlug("...")).toBe("review");
    expect(gateSlug(undefined)).toBe("review");
  });
});
