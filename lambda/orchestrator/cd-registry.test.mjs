import { describe, it, expect } from "vitest";
import {
  normalizeRepoKey,
  parseCdRegistry,
  findCdEntry,
  isCdRegistered,
  stripShipPhases,
  effectiveWorkflowDef,
  pipelineProjects,
  resolveDelivery,
  deliveryModeContext,
  EMPTY_CD_REGISTRY,
} from "./cd-registry.mjs";

/**
 * CD registry — which repos the hub merges + deploys. Pure helpers; the S3 read
 * and the dispatch/gate/completion wiring are pinned by cd-handoff.test.mjs.
 */

const HUB = { repos: [{ url: "https://github.com/tycenjmccann/agentcore-hub.git", defaultBranch: "main" }] };
const JUNO = { repos: [{ url: "https://github.com/tycenjmccann/juno", defaultBranch: "main" }] };
const REG = parseCdRegistry({ version: 1, repos: [{ repo: "tycenjmccann/agentcore-hub", pipeline: "agentcore-hub-deploy", region: "us-east-1" }] });

const SHIP_DEF = {
  id: "software-delivery",
  intakeAgentId: "agentcore_hub_requirements_analyst",
  featureBranchPhase: "development",
  createsPullRequest: true,
  completionRequiresAgentPhases: ["development", "verification", "review", "ship"],
  reviewGates: [
    { afterPhase: "requirements", name: "Spec Approval", blocking: true, condition: "flagged" },
    { afterPhase: "ship", name: "Merge Approval", blocking: true, condition: "always" },
  ],
  phaseOrder: ["intake", "requirements", "design", "development", "verification", "ship", "complete"],
};

describe("normalizeRepoKey", () => {
  it("canonicalizes https / ssh / bare forms to lower-case owner/repo", () => {
    expect(normalizeRepoKey("https://github.com/Owner/Repo.git")).toBe("owner/repo");
    expect(normalizeRepoKey("git@github.com:Owner/Repo.git")).toBe("owner/repo");
    expect(normalizeRepoKey("Owner/Repo")).toBe("owner/repo");
    expect(normalizeRepoKey("  owner/repo/  ")).toBe("owner/repo");
    // TEAM-4421/TEAM-4426: trailing slash AFTER .git must not survive the strip.
    expect(normalizeRepoKey("https://github.com/owner/repo.git/")).toBe("owner/repo");
    expect(normalizeRepoKey("git@github.com:owner/repo.git/")).toBe("owner/repo");
  });
  it("rejects anything that is not two path segments", () => {
    expect(normalizeRepoKey("")).toBeNull();
    expect(normalizeRepoKey(undefined)).toBeNull();
    expect(normalizeRepoKey("repo")).toBeNull();
    expect(normalizeRepoKey("a/b/c")).toBeNull();
    expect(normalizeRepoKey("https://github.com/owner")).toBeNull();
  });
});

describe("parseCdRegistry", () => {
  it("accepts a JSON string or an object and normalizes entries", () => {
    const fromString = parseCdRegistry(JSON.stringify({ version: 1, repos: [{ repo: "https://github.com/O/R.git", pipeline: " p ", region: "us-east-1", notes: "n" }] }));
    expect(fromString.repos).toEqual([{ repo: "o/r", pipeline: "p", region: "us-east-1", notes: "n" }]);
    expect(parseCdRegistry({ repos: ["o/r"] }).repos).toEqual([{ repo: "o/r" }]);
  });
  it("drops malformed / duplicate entries and never throws — an unparseable registry registers nothing", () => {
    expect(parseCdRegistry("not json")).toEqual(EMPTY_CD_REGISTRY);
    expect(parseCdRegistry(null)).toEqual(EMPTY_CD_REGISTRY);
    expect(parseCdRegistry({ repos: "nope" }).repos).toEqual([]);
    const r = parseCdRegistry({ repos: [{ repo: "o/r" }, { repo: "O/R" }, { repo: "bad" }, 42, null, { pipeline: "x" }] });
    expect(r.repos).toEqual([{ repo: "o/r" }]);
  });
});

describe("findCdEntry / isCdRegistered", () => {
  it("matches the run's first repo URL case-insensitively in any form", () => {
    expect(findCdEntry(REG, HUB)?.pipeline).toBe("agentcore-hub-deploy");
    expect(isCdRegistered(REG, { repos: [{ url: "git@github.com:TycenJMccann/AgentCore-Hub.git" }] })).toBe(true);
    expect(isCdRegistered(REG, JUNO)).toBe(false);
  });
  it("a run with no repo is never registered", () => {
    expect(isCdRegistered(REG, undefined)).toBe(false);
    expect(isCdRegistered(REG, { repos: [] })).toBe(false);
    expect(isCdRegistered(REG, { repos: [{ url: "" }] })).toBe(false);
    expect(isCdRegistered(EMPTY_CD_REGISTRY, HUB)).toBe(false);
  });
});

describe("stripShipPhases / effectiveWorkflowDef", () => {
  it("removes the ship completion phase AND the ship-guarding gate, keeps everything else", () => {
    const eff = stripShipPhases(SHIP_DEF, new Set(["ship"]));
    expect(eff.completionRequiresAgentPhases).toEqual(["development", "verification", "review"]);
    expect(eff.reviewGates.map((g) => g.afterPhase)).toEqual(["requirements"]);
    expect(eff.cdHandoff).toBe(true);
    // untouched: branch/PR flags and the phase order the board advances through
    expect(eff.featureBranchPhase).toBe("development");
    expect(eff.createsPullRequest).toBe(true);
    expect(eff.phaseOrder).toEqual(SHIP_DEF.phaseOrder);
    // the source def is not mutated
    expect(SHIP_DEF.completionRequiresAgentPhases).toContain("ship");
    expect(SHIP_DEF.reviewGates).toHaveLength(2);
  });
  it("returns the def itself when there is nothing to strip", () => {
    const noShip = { ...SHIP_DEF, completionRequiresAgentPhases: ["development"], reviewGates: [] };
    expect(stripShipPhases(noShip)).toBe(noShip);
    expect(stripShipPhases(undefined)).toBeUndefined();
  });
  it("effectiveWorkflowDef: registered → identity; unregistered → stripped", () => {
    expect(effectiveWorkflowDef(SHIP_DEF, REG, HUB)).toBe(SHIP_DEF);
    const juno = effectiveWorkflowDef(SHIP_DEF, REG, JUNO);
    expect(juno).not.toBe(SHIP_DEF);
    expect(juno.completionRequiresAgentPhases).not.toContain("ship");
    expect(juno.reviewGates.some((g) => g.afterPhase === "ship")).toBe(false);
  });
});

describe("pipelineProjects", () => {
  it("derives ci/build/deploy from a -deploy pipeline name (the hub itself)", () => {
    expect(pipelineProjects({ pipeline: "agentcore-hub-deploy" })).toEqual({
      pipeline: "agentcore-hub-deploy",
      region: null,
      ciProject: "agentcore-hub-ci",
      buildProject: "agentcore-hub-build",
      deployProject: "agentcore-hub-deploy",
    });
  });
  it("derives from a hub-<slug>-deploy pipeline name and carries the region", () => {
    expect(pipelineProjects({ pipeline: "hub-foo-deploy", region: "us-west-2" })).toEqual({
      pipeline: "hub-foo-deploy",
      region: "us-west-2",
      ciProject: "hub-foo-ci",
      buildProject: "hub-foo-build",
      deployProject: "hub-foo-deploy",
    });
  });
  it("an explicit entry.ciProject overrides the derived name; build/deploy stay derived", () => {
    const p = pipelineProjects({ pipeline: "hub-foo-deploy", ciProject: "custom-checks" });
    expect(p.ciProject).toBe("custom-checks");
    expect(p.buildProject).toBe("hub-foo-build");
    expect(p.deployProject).toBe("hub-foo-deploy");
  });
  it("a pipeline name not ending in -deploy uses the whole name as the base", () => {
    expect(pipelineProjects({ pipeline: "hub-foo-pipeline" })).toEqual({
      pipeline: "hub-foo-pipeline",
      region: null,
      ciProject: "hub-foo-pipeline-ci",
      buildProject: "hub-foo-pipeline-build",
      deployProject: "hub-foo-pipeline",
    });
  });
  it("no pipeline → null", () => {
    expect(pipelineProjects({})).toBeNull();
    expect(pipelineProjects({ deployDoc: "DEPLOY.md" })).toBeNull();
    expect(pipelineProjects(undefined)).toBeNull();
  });
});

describe("resolveDelivery", () => {
  it("unregistered → handoff, never pipeline mode", () => {
    expect(resolveDelivery(REG, JUNO, { pipelineEnabled: true })).toEqual({
      mode: "handoff", entry: null, pipelineMode: false, pipeline: null, region: null,
      ciProject: null, buildProject: null, deployProject: null,
    });
  });
  it("registered with a pipeline → cd; pipeline mode only when PIPELINE_ENABLED is on; spreads the derived projects", () => {
    const on = resolveDelivery(REG, HUB, { pipelineEnabled: true });
    expect(on.mode).toBe("cd");
    expect(on.pipelineMode).toBe(true);
    expect(on.pipeline).toBe("agentcore-hub-deploy");
    expect(on.region).toBe("us-east-1");
    expect(on.ciProject).toBe("agentcore-hub-ci");
    expect(on.buildProject).toBe("agentcore-hub-build");
    expect(on.deployProject).toBe("agentcore-hub-deploy");
    expect(resolveDelivery(REG, HUB, { pipelineEnabled: false }).pipelineMode).toBe(false);
  });
  it("registered WITHOUT a pipeline → cd via DEPLOY.md (legacy), never pipeline mode, no derived projects", () => {
    const reg = parseCdRegistry({ repos: [{ repo: "o/r", deployDoc: "docs/DEPLOY.md" }] });
    const d = resolveDelivery(reg, { repos: [{ url: "https://github.com/o/r" }] }, { pipelineEnabled: true });
    expect(d.mode).toBe("cd");
    expect(d.pipelineMode).toBe(false);
    expect(d.pipeline).toBeNull();
    expect(d.ciProject).toBeNull();
    expect(d.buildProject).toBeNull();
    expect(d.deployProject).toBeNull();
    expect(d.entry.deployDoc).toBe("docs/DEPLOY.md");
  });
});

describe("deliveryModeContext", () => {
  it("handoff block: CD_REGISTERED false + the three rules every persona needs", () => {
    const txt = deliveryModeContext(resolveDelivery(REG, JUNO), { repo: "tycenjmccann/juno", defaultBranch: "main" });
    expect(txt).toMatch(/^## Delivery Mode\nCD_REGISTERED: false\n/);
    expect(txt).toContain("tycenjmccann/juno is NOT in the hub's CD registry");
    expect(txt).toContain("do NOT create Ship, Merge Approval or CD tickets");
    expect(txt).toContain("never merge into main");
    expect(txt).toContain("leaves it OPEN for the owning team");
    expect(txt).not.toContain("pipeline_name");
  });
  it("cd block names the pipeline (and region) so the RM can pass pipeline_name", () => {
    const txt = deliveryModeContext(resolveDelivery(REG, HUB, { pipelineEnabled: true }), { repo: "tycenjmccann/agentcore-hub", defaultBranch: "main" });
    expect(txt).toContain("CD_REGISTERED: true");
    expect(txt).toContain("pipeline_name: agentcore-hub-deploy");
    expect(txt).toContain("pipeline_region: us-east-1");
    expect(txt).toContain("Merge Approval gate");
  });
  it("cd block without a pipeline points at the repo's deploy doc", () => {
    const reg = parseCdRegistry({ repos: [{ repo: "o/r", deployDoc: "ops/DEPLOY.md", notes: "prod is us-west-2" }] });
    const txt = deliveryModeContext(resolveDelivery(reg, { repos: [{ url: "https://github.com/o/r" }] }), { repo: "o/r" });
    expect(txt).toContain("per the repo's ops/DEPLOY.md");
    expect(txt).toContain("notes: prod is us-west-2");
    expect(txt).not.toContain("pipeline_name");
  });
});
