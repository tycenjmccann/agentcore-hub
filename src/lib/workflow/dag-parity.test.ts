import { describe, it, expect } from "vitest";
import {
  mapPlanToNodes as mapTs,
  validateTicketPlan as validateTs,
  validateRealizedGraph as realizedTs,
  assertDagWellFormed as assertTs,
  type TicketDag,
} from "./dag";
// The orchestrator/workflow-output port. Both copies MUST agree: the .mjs one is
// what submit_ticket_plan enforces at run time, the .ts one is what the console/
// API path would report — a drift means the run and the UI disagree about whether
// a plan is structurally valid.
import {
  mapPlanToNodes as mapMjs,
  validateTicketPlan as validateMjs,
  validateRealizedGraph as realizedMjs,
  assertDagWellFormed as assertMjs,
} from "../../../lambda/orchestrator/dag.mjs";

/**
 * TEAM-3992 D3.4 parity contract (same shape as repo-check-parity.test.ts): drive
 * the SAME (plan × dag × roster) fixtures through both dag validators and assert
 * deep-equal outputs, plus that assertDagWellFormed agrees on malformed dags.
 */

const ROSTER = [
  { agentId: "agentcore_hub_requirements_analyst", phase: "requirements" },
  { agentId: "agentcore_hub_backend_designer", phase: "design" },
  { agentId: "agentcore_hub_backend_dev", phase: "development" },
  { agentId: "agentcore_hub_code_sweeper", phase: "development" },
  { agentId: "agentcore_hub_code_reviewer", phase: "review" },
  { agentId: "agentcore_hub_qa_verifier", phase: "verification" },
  { agentId: "agentcore_hub_ci_agent", phase: "review" },
  { agentId: "agentcore_hub_release_manager", phase: "ship" },
];

// The software-delivery ticketDag, inlined so the parity check does not depend on
// config load order.
const SD_DAG: TicketDag = {
  nodes: {
    requirements: { agentPhases: ["requirements"], min: 1, max: 1 },
    design: { agentPhases: ["design"], min: 0 },
    development: { agentPhases: ["development"], min: 1 },
    review: { agentIds: ["agentcore_hub_code_reviewer"], min: 1, max: 1 },
    verification: { agentIds: ["agentcore_hub_qa_verifier"], min: 1 },
    ci: { agentIds: ["agentcore_hub_ci_agent"], min: 1 },
    ship: { agentIds: ["agentcore_hub_release_manager"], titlePrefix: "Ship:", min: 1, max: 1 },
    mergeGate: { gate: "Merge Approval", min: 1, max: 1 },
    cd: { agentIds: ["agentcore_hub_release_manager"], titlePrefix: "CD:", min: 1, max: 1 },
  },
  edges: [
    { from: "requirements", to: "design" },
    { from: "design", to: "development", fallbackFrom: "requirements" },
    { from: "development", to: "review" },
    { from: "review", to: "verification" },
    { from: "review", to: "ci" },
    { from: "verification", to: "ship" },
    { from: "ci", to: "ship" },
    { from: "ship", to: "mergeGate" },
    { from: "mergeGate", to: "cd" },
  ],
  forbiddenEdges: [
    { from: "verification", to: "ci" },
    { from: "ci", to: "verification" },
  ],
  allowedExtraNodes: {
    fix: { spawnedByKinds: ["review_fix", "qa_fix", "codex_fix"] },
    rearm: { spawnedByKey: "rearmOf" },
    escalationGate: { titlePattern: "^Escalation #\\d+" },
  },
  fixRearm: { review_fix: ["review", "ci"], codex_fix: ["review", "ci"], qa_fix: ["review", "ci", "verification"], shipBlockedByRearmed: true },
};

const validPlan = {
  tickets: [
    { id: "R", assignee: "agentcore_hub_requirements_analyst", title: "Requirements", blocked_by: [] },
    { id: "D", assignee: "agentcore_hub_backend_designer", title: "Design", blocked_by: ["R"] },
    { id: "DEV", assignee: "agentcore_hub_backend_dev", title: "Build", blocked_by: ["D"] },
    { id: "REV", assignee: "agentcore_hub_code_reviewer", title: "Review", blocked_by: ["DEV"] },
    { id: "QA", assignee: "agentcore_hub_qa_verifier", title: "Verify", blocked_by: ["REV"] },
    { id: "CI", assignee: "agentcore_hub_ci_agent", title: "CI", blocked_by: ["REV"] },
    { id: "SHIP", assignee: "agentcore_hub_release_manager", title: "Ship: X", blocked_by: ["QA", "CI"] },
    { id: "GATE", assignee: "human:engineer", title: "Merge Approval", blocked_by: ["SHIP"] },
    { id: "CD", assignee: "agentcore_hub_release_manager", title: "CD: X", blocked_by: ["GATE"] },
  ],
};

const serialForbiddenPlan = {
  tickets: [
    { id: "DEV", assignee: "agentcore_hub_backend_dev", title: "Build", blocked_by: ["R"] },
    { id: "R", assignee: "agentcore_hub_requirements_analyst", title: "Requirements", blocked_by: [] },
    { id: "REV", assignee: "agentcore_hub_code_reviewer", title: "Review", blocked_by: ["DEV"] },
    { id: "QA", assignee: "agentcore_hub_qa_verifier", title: "Verify", blocked_by: ["REV"] },
    { id: "CI", assignee: "agentcore_hub_ci_agent", title: "CI", blocked_by: ["QA"] }, // FORBIDDEN + missing review→ci
    { id: "FIX", assignee: "agentcore_hub_backend_dev", title: "Fix findings", spawned_by: { kind: "codex_fix" }, blocked_by: ["REV"] },
    { id: "ESC", assignee: "human:engineer", title: "Escalation #12 review cap", blocked_by: [] },
  ],
};

const unknownBlockerPlan = {
  tickets: [
    { id: "R", assignee: "agentcore_hub_requirements_analyst", title: "Requirements", blocked_by: ["GHOST"] },
  ],
};

const twoShipPlan = {
  tickets: [
    { id: "SHIP1", assignee: "agentcore_hub_release_manager", title: "Ship: A", blocked_by: [] },
    { id: "SHIP2", assignee: "agentcore_hub_release_manager", title: "Ship: B", blocked_by: [] },
  ],
};

const PLANS: Array<[string, { tickets: unknown[] }]> = [
  ["valid software-delivery", validPlan],
  ["serial forbidden ci", serialForbiddenPlan],
  ["unknown blocker key", unknownBlockerPlan],
  ["two ship tickets", twoShipPlan],
  ["empty", { tickets: [] }],
];

describe("dag validator parity: dag.ts ≡ dag.mjs", () => {
  it.each(PLANS)("mapPlanToNodes agrees on %s", (_label, plan) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mapTs(plan as any, SD_DAG, ROSTER)).toEqual(mapMjs(plan as any, SD_DAG as any, ROSTER));
  });

  it.each(PLANS)("validateTicketPlan agrees on %s", (_label, plan) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(validateTs(plan as any, SD_DAG, ROSTER)).toEqual(validateMjs(plan as any, SD_DAG as any, ROSTER));
  });

  it.each(PLANS)("validateRealizedGraph agrees on %s", (_label, plan) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(realizedTs(plan.tickets as any, SD_DAG, ROSTER)).toEqual(realizedMjs(plan.tickets as any, SD_DAG as any, ROSTER));
  });

  it("both accept the valid plan and reject the forbidden one", () => {
    expect(validateTs(validPlan as never, SD_DAG, ROSTER).ok).toBe(true);
    expect(validateMjs(validPlan as never, SD_DAG as never, ROSTER).ok).toBe(true);
    const ts = validateTs(serialForbiddenPlan as never, SD_DAG, ROSTER);
    expect(ts.ok).toBe(false);
    expect(ts.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "forbidden_edge", from: "verification", to: "ci", ticket: "CI" }),
        expect.objectContaining({ code: "missing_required_edge", from: "review", to: "ci", ticket: "CI" }),
      ])
    );
  });

  it("assertDagWellFormed agrees on malformed dags", () => {
    const bad: TicketDag = { nodes: { a: {}, b: {} }, edges: [{ from: "a", to: "ghost" }] };
    expect(() => assertTs(bad)).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => assertMjs(bad as any)).toThrow();

    const cyclic: TicketDag = { nodes: { a: {}, b: {} }, edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] };
    expect(() => assertTs(cyclic)).toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => assertMjs(cyclic as any)).toThrow();

    expect(assertTs(SD_DAG)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(assertMjs(SD_DAG as any)).toBe(true);
  });
});
