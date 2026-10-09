/**
 * TEAM-5238: a /models console repin replaces the harness `model` object whole.
 * For the Workflow Manager it must carry the same per-response cap the setup
 * script sets (deploy/workflow-manager/harness-config.mjs) — dropping it brings
 * back the TEAM-5226 max-tokens failure.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/agentcore-sdk", () => ({
  DEFAULT_REGION: "us-east-1",
  discoverAgents: vi.fn(),
  getHarnessDetail: vi.fn(),
}));

import seedJson from "@/config/models.json";
import { parseModelsRegistry } from "@/lib/models-registry";
import { harnessModelForApply } from "./harness-apply";
import { wmModel } from "../../../deploy/workflow-manager/harness-config.mjs";

const reg = parseModelsRegistry(JSON.parse(JSON.stringify(seedJson))).registry;
const WM = "agentcore_hub_workflow_manager";

describe("harnessModelForApply", () => {
  it("carries the per-response cap for the Workflow Manager, clamped per model", () => {
    expect(harnessModelForApply(WM, "us.anthropic.claude-fable-5-1", reg).bedrockModelConfig?.maxTokens).toBe(64000);
    expect(harnessModelForApply(WM, "us.anthropic.claude-sonnet-5", reg).bedrockModelConfig?.maxTokens).toBe(64000);
    expect(harnessModelForApply(WM, "us.anthropic.claude-opus-5", reg).bedrockModelConfig?.maxTokens).toBe(32000);
  });

  it("matches the setup script's cap for every catalog model", () => {
    for (const row of reg.catalog) {
      const applied = harnessModelForApply(WM, row.modelId, reg).bedrockModelConfig;
      if (!applied) continue; // OpenAI lane: no bedrockModelConfig to cap
      expect(applied.maxTokens, row.modelId).toBe(wmModel(row.modelId, reg.catalog, seedJson.catalog).bedrockModelConfig.maxTokens);
    }
  });

  it("fills the cap from the bundled seed when the live registry rows lack maxOutputTokens", () => {
    const live = { ...reg, catalog: reg.catalog.map(({ maxOutputTokens: _drop, ...row }) => row) };
    expect(harnessModelForApply(WM, "us.anthropic.claude-fable-5-1", live).bedrockModelConfig?.maxTokens).toBe(64000);
  });

  it("leaves other harness agents' model config as built", () => {
    const m = harnessModelForApply("agentcore_hub_builder", "us.anthropic.claude-fable-5-1", reg);
    expect(m.bedrockModelConfig).not.toHaveProperty("maxTokens");
  });
});
