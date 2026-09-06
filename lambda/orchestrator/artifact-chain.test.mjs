import { describe, it, expect } from "vitest";
import {
  normalizeChainGateMode, chainFor, chainDir, requiredArtifactsForTicket, sdlcFrameworkContext,
  gateInstructionOverride, fallbackReviewPackagePhase, artifactRepoPath, missingArtifactNote, isPlanTicket,
} from "./artifact-chain.mjs";
import workflows from "../../src/config/workflows.json";

const playbook = workflows.workflows.find((w) => w.id === "sdlc-playbook");
const standard = workflows.workflows.find((w) => w.id === "software-delivery");
const INTAKE = "agentcore_hub_requirements_analyst";
const dev = { agentId: "agentcore_hub_frontend_dev", phase: "development" };
const reviewer = { agentId: "agentcore_hub_code_reviewer", phase: "review" };
const ci = { agentId: "agentcore_hub_ci_agent", phase: "review" };

describe("artifact chain — def shape (workflows.json)", () => {
  it("sdlc-playbook declares the intent → spec → plan → findings chain", () => {
    expect(chainFor(playbook)).not.toBeNull();
    expect(playbook.artifactChain.artifacts.map((a) => a.name)).toEqual(["intent.md", "spec.md", "plan.md", "findings.md"]);
    expect(chainDir(playbook, "wf_1")).toBe(".sdlc/wf_1");
  });
  it("software-delivery has no chain (standard pipeline is untouched)", () => {
    expect(chainFor(standard)).toBeNull();
    expect(chainDir(standard, "wf_1")).toBeNull();
    expect(standard.sdlcFramework).toBe("standard");
  });
  it("every playbook gate is always-on and human-assigned", () => {
    for (const g of playbook.reviewGates) {
      expect(g.condition).toBe("always");
      expect(g.blocking).toBe(true);
      expect(g.assignee.startsWith("human:")).toBe(true);
    }
    expect(playbook.reviewGates.map((g) => g.name)).toEqual(["Intent Acceptance", "Spec Approval", "Plan Approval", "Merge Approval"]);
  });
  it("the spec author is dispatched onto the shared branch (branch created at requirements)", () => {
    expect(playbook.featureBranchPhase).toBe("requirements");
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
    expect(gateInstructionOverride(playbook.reviewGates[0])).toContain("Intent Acceptance");
    expect(gateInstructionOverride(playbook.reviewGates[2])).toContain("Plan Approval");
    expect(gateInstructionOverride(playbook.reviewGates[1])).toBeNull();
    expect(gateInstructionOverride(null)).toBeNull();
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
