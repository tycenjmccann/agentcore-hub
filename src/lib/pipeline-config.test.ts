import { describe, it, expect } from "vitest";
import { getPipelinePhases } from "@/lib/pipeline-config";
import { BUNDLED_REGISTRY, type ModelsRegistry } from "@/lib/models-registry";

/**
 * TEAM-4997 — the board's model label comes from the registry, not from
 * agents.json's hand-written `model:` string (which had drifted: the seed
 * routes the Workflow Manager to Fable 5.1, agents.json still said "Claude
 * Opus 5"). These pin that the label follows resolution, not the config file.
 *
 * The Workflow Manager itself never appears here to relabel: its agents.json
 * `phase` is "management", which no workflow def maps into a board phase, so
 * `getPipelinePhases()` has never listed it (true before this ticket too).
 * The two agents below stand in for it, exercising the same
 * `agentModelLabel` path against a runtime agent in a single-agent phase and
 * one in a multi-agent phase.
 */
describe("getPipelinePhases — registry-derived model labels", () => {
  it("labels agents from the bundled seed's defaults.persona", () => {
    const phases = getPipelinePhases();
    const agents = phases.flatMap((p) => p.agents);
    const analyst = agents.find((a) => a.agentId === "agentcore_hub_requirements_analyst");
    const backendDev = agents.find((a) => a.agentId === "agentcore_hub_backend_dev");
    expect(analyst?.model).toBe("Claude Fable 5.1");
    expect(backendDev?.model).toBe("Claude Fable 5.1");
  });

  it("relabels an agent when a passed-in registry pins it to a different catalog row", () => {
    const pinned: ModelsRegistry = {
      ...BUNDLED_REGISTRY,
      agents: { ...BUNDLED_REGISTRY.agents, agentcore_hub_requirements_analyst: "us.anthropic.claude-opus-5" },
    };
    const agents = getPipelinePhases(undefined, pinned).flatMap((p) => p.agents);
    const analyst = agents.find((a) => a.agentId === "agentcore_hub_requirements_analyst");
    const backendDev = agents.find((a) => a.agentId === "agentcore_hub_backend_dev");
    expect(analyst?.model).toBe("Claude Opus 5");
    // Nothing else moved with it.
    expect(backendDev?.model).toBe("Claude Fable 5.1");
  });

  it("rolls a phase's `models` up to the distinct set of its agents' labels", () => {
    // "development" runs 3 agents; pinning just one diverges the phase, so the
    // roll-up must be a 2-element set, not a 3-element list with a duplicate.
    const pinned: ModelsRegistry = {
      ...BUNDLED_REGISTRY,
      agents: { ...BUNDLED_REGISTRY.agents, agentcore_hub_backend_dev: "us.anthropic.claude-opus-5" },
    };
    const development = getPipelinePhases(undefined, pinned).find((p) => p.id === "development");
    const labels = development?.agents.map((a) => a.model) ?? [];
    expect(new Set(labels).size).toBeGreaterThan(1); // the pin actually diverged this phase
    expect(development?.models).toEqual([...new Set(labels)]);
  });
});
