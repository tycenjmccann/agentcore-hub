import { describe, it, expect } from "vitest";
import {
  normalizeChainGateMode, chainFor, chainDir, requiredArtifactsForTicket, sdlcFrameworkContext,
  gateInstructionOverride, fallbackReviewPackagePhase, artifactRepoPath, missingArtifactNote, isPlanTicket,
  applyFramework, resolveFramework, frameworkOfWorkflow, designArtifactName,
} from "./artifact-chain.mjs";
import workflows from "../../src/config/workflows.json";

const standard = workflows.workflows.find((w) => w.id === "software-delivery");
// The playbook is an OVERLAY on software-delivery, selected per run.
const playbook = applyFramework(standard, "playbook");
const ios = { agentId: "agentcore_hub_ios_designer", phase: "design" };
const INTAKE = "agentcore_hub_requirements_analyst";
const dev = { agentId: "agentcore_hub_frontend_dev", phase: "development" };
const reviewer = { agentId: "agentcore_hub_code_reviewer", phase: "review" };
const ci = { agentId: "agentcore_hub_ci_agent", phase: "review" };

describe("framework overlay (software-delivery + playbook)", () => {
  it("software-delivery itself has no chain and is standard", () => {
    expect(chainFor(standard)).toBeNull();
    expect(chainDir(standard, "wf_1")).toBeNull();
    expect(standard.sdlcFramework).toBe("standard");
    expect(standard.featureBranchPhase).toBe("development");
  });
  it("the playbook overlay keeps the def identity and phases, replaces gates/chain/branch phase", () => {
    expect(playbook.id).toBe("software-delivery");
    expect(playbook.phases).toBe(standard.phases);
    expect(playbook.sdlcFramework).toBe("playbook");
    expect(playbook.featureBranchPhase).toBe("requirements");
    expect(playbook.artifactChain.artifacts.map((a) => a.name)).toEqual(["intent.md", "spec.md", "design/<agent>.md", "plan.md", "findings.md"]);
    expect(chainDir(playbook, "wf_1")).toBe(".sdlc/wf_1");
    expect(playbook.label).toBeUndefined(); // overlay-only presentation fields do not leak onto the def
  });
  it("every playbook gate is human-assigned; ship gate is cdRegistered, per-role Design Review is flagged, the rest always-on", () => {
    for (const g of playbook.reviewGates) {
      expect(g.blocking).toBe(true);
      expect(g.assignee.startsWith("human:")).toBe(true);
      // TEAM-4167 D3a: a ship gate must never be condition:"always" (a phantom
      // human expectation on a handoff run) — it is "cdRegistered" (auto-absent
      // on handoff). The per-role Design Review stays "flagged"; all else always-on.
      const expected = g.afterPhase === "ship" ? "cdRegistered" : g.scope === "role" ? "flagged" : "always";
      expect(g.condition).toBe(expected);
    }
    expect(playbook.reviewGates.map((g) => g.name)).toEqual([
      "Intent Acceptance", "Spec Approval", "Design Review", "Design Approval", "Plan Approval", "Merge Approval",
    ]);
  });
  it("resolveFramework / applyFramework / frameworkOfWorkflow", () => {
    expect(resolveFramework(standard, "playbook")).toBe("playbook");
    expect(resolveFramework(standard, "standard")).toBe("standard");
    expect(resolveFramework(standard, "nope")).toBe("standard");
    expect(resolveFramework(standard, undefined)).toBe("standard");
    expect(applyFramework(standard, "standard")).toBe(standard);
    expect(applyFramework(standard, "nope")).toBe(standard);
    expect(applyFramework(standard, undefined)).toBe(standard);
    expect(frameworkOfWorkflow(standard, { sdlcFramework: "playbook" })).toBe("playbook");
    expect(frameworkOfWorkflow(standard, { input: { sdlcFramework: "playbook" } })).toBe("playbook");
    expect(frameworkOfWorkflow(standard, {})).toBe("standard");
    // a def without overlays ignores the request
    const legal = workflows.workflows.find((w) => w.id === "legal");
    expect(resolveFramework(legal, "playbook")).toBe("standard");
    expect(applyFramework(legal, "playbook")).toBe(legal);
  });
});

describe("requiredArtifactsForTicket", () => {
  it("intake agent owes intent.md + spec.md", () => {
    const t = { assignee: INTAKE, title: "Spec: x" };
    expect(requiredArtifactsForTicket({ def: playbook, ticket: t, agentDef: { phase: "requirements" }, intakeAgentId: INTAKE }))
      .toEqual(["intent.md", "spec.md"]);
  });
  it("Plan: ticket owes plan.md; implementation ticket owes nothing", () => {
    expect(requiredArtifactsForTicket({ def: playbook, ticket: { assignee: dev.agentId, title: "Plan: dark mode shortcut" }, agentDef: dev, intakeAgentId: INTAKE }))
      .toEqual(["plan.md"]);
    expect(requiredArtifactsForTicket({ def: playbook, ticket: { assignee: dev.agentId, title: "Implement: dark mode shortcut" }, agentDef: dev, intakeAgentId: INTAKE }))
      .toEqual([]);
    expect(isPlanTicket({ title: "  plan: x" }, dev)).toBe(true);
    expect(isPlanTicket({ title: "Plan: x" }, reviewer)).toBe(false);
  });
  it("design-phase personas owe design/<agent>.md", () => {
    expect(requiredArtifactsForTicket({ def: playbook, ticket: { assignee: ios.agentId, title: "iOS design" }, agentDef: ios, intakeAgentId: INTAKE }))
      .toEqual(["design/ios-designer.md"]);
    expect(designArtifactName("agentcore_hub_security_reviewer")).toBe("design/security-reviewer.md");
  });
  it("code reviewer owes findings.md; CI agent (same phase) owes nothing", () => {
    expect(requiredArtifactsForTicket({ def: playbook, ticket: { assignee: reviewer.agentId, title: "Review" }, agentDef: reviewer, intakeAgentId: INTAKE }))
      .toEqual(["findings.md"]);
    expect(requiredArtifactsForTicket({ def: playbook, ticket: { assignee: ci.agentId, title: "CI" }, agentDef: ci, intakeAgentId: INTAKE }))
      .toEqual([]);
  });
  it("standard def never owes anything", () => {
    expect(requiredArtifactsForTicket({ def: standard, ticket: { assignee: INTAKE, title: "Requirements" }, agentDef: { phase: "requirements" }, intakeAgentId: INTAKE }))
      .toEqual([]);
  });
});

describe("context + gate helpers", () => {
  const wf = { id: "wf_9", featureBranch: "feature/TEAM-1-x" };
  it("SDLC block names dir, branch, chain and the owed artifact", () => {
    const ctx = sdlcFrameworkContext({ def: playbook, workflow: wf, ticket: { assignee: INTAKE, title: "Spec" }, agentDef: { phase: "requirements" }, intakeAgentId: INTAKE });
    expect(ctx).toContain("## SDLC Framework");
    expect(ctx).toContain("artifact_dir: .sdlc/wf_9");
    expect(ctx).toContain("artifact_branch: feature/TEAM-1-x");
    expect(ctx).toContain("your_artifact: intent.md, spec.md");
    expect(ctx).toContain("BEFORE WorkflowOutput___report_completion");
  });
  it("Plan ticket block says plan only; implementation block points at plan.md", () => {
    const plan = sdlcFrameworkContext({ def: playbook, workflow: wf, ticket: { assignee: dev.agentId, title: "Plan: x" }, agentDef: dev, intakeAgentId: INTAKE });
    expect(plan).toContain("This is the PLAN ticket");
    const impl = sdlcFrameworkContext({ def: playbook, workflow: wf, ticket: { assignee: dev.agentId, title: "Implement x" }, agentDef: dev, intakeAgentId: INTAKE });
    expect(impl).toContain("implement per .sdlc/wf_9/plan.md");
  });
  it("standard def yields no block", () => {
    expect(sdlcFrameworkContext({ def: standard, workflow: wf, ticket: {}, agentDef: dev, intakeAgentId: INTAKE })).toBe("");
  });
  it("gate instruction override only for gates that carry instructions", () => {
    const byName = Object.fromEntries(playbook.reviewGates.map((g) => [g.name, g]));
    expect(gateInstructionOverride(byName["Intent Acceptance"])).toContain("Intent Acceptance");
    expect(gateInstructionOverride(byName["Plan Approval"])).toContain("Plan Approval");
    expect(gateInstructionOverride(byName["Design Review"])).toContain("Design Review");
    expect(gateInstructionOverride(byName["Spec Approval"])).toBeNull();
    expect(gateInstructionOverride(byName["Design Approval"])).toBeNull();
    expect(gateInstructionOverride(null)).toBeNull();
  });
  it("design persona context names its owed design file", () => {
    const ctx = sdlcFrameworkContext({ def: playbook, workflow: wf, ticket: { assignee: ios.agentId, title: "iOS design" }, agentDef: ios, intakeAgentId: INTAKE });
    expect(ctx).toContain("your_artifact: design/ios-designer.md");
    expect(ctx).toContain("Design-phase persona");
  });
  it("review-package phase fallbacks: plan by title, intake when no agent blockers", () => {
    expect(fallbackReviewPackagePhase({ title: "Plan Approval: x", blockedBy: ["T-1"] })).toBe("plan");
    expect(fallbackReviewPackagePhase({ title: "Intent Acceptance: x", blockedBy: [] })).toBe("intake");
    expect(fallbackReviewPackagePhase({ title: "Merge Approval", blockedBy: [] })).toBe("intake");
    expect(fallbackReviewPackagePhase({ title: "Spec Approval", blockedBy: ["T-2"] })).toBeUndefined();
  });
  it("repo path + missing note", () => {
    expect(artifactRepoPath(playbook, "wf_9", "spec.md")).toBe(".sdlc/wf_9/spec.md");
    expect(artifactRepoPath(standard, "wf_9", "spec.md")).toBeNull();
    const note = missingArtifactNote({ missing: ["plan.md"], dir: ".sdlc/wf_9", branch: "feature/x" });
    expect(note).toContain(".sdlc/wf_9/plan.md");
    expect(note).toContain("feature/x");
  });
  it("gate mode normalizes to enforce unless explicitly off", () => {
    expect(normalizeChainGateMode(undefined)).toBe("enforce");
    expect(normalizeChainGateMode("OFF")).toBe("off");
    expect(normalizeChainGateMode("shadow")).toBe("enforce");
  });
});
