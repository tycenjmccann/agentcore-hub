/**
 * TEAM-5226: ANALYZE died with MaxTokensReachedException because the per-response
 * cap (model.bedrockModelConfig.maxTokens) was never set and the top-level
 * maxTokens — a TOTAL across the invocation — was 32000. Pins both values on
 * the create and update paths of setup-workflow-manager.mjs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WM_MAX_TOKENS_PER_RESPONSE,
  WM_MAX_TOKENS_PER_INVOCATION,
  wmModel,
  wmUpdateInput,
} from "./harness-config.mjs";

const MODEL = "us.anthropic.claude-fable-5-1";

describe("workflow-manager harness output caps", () => {
  it("uses 64000 per response and 200000 per invocation", () => {
    expect(WM_MAX_TOKENS_PER_RESPONSE).toBe(64000);
    expect(WM_MAX_TOKENS_PER_INVOCATION).toBe(200000);
  });

  it("create input: model carries the per-response cap", () => {
    expect(wmModel(MODEL)).toEqual({ bedrockModelConfig: { modelId: MODEL, maxTokens: 64000 } });
  });

  it("update input carries both caps (Update retains an omitted top-level maxTokens)", () => {
    const input = wmUpdateInput({ harnessId: "h-1", modelId: MODEL, systemPrompt: [{ text: "p" }], skills: [] });
    expect(input.harnessId).toBe("h-1");
    expect(input.model.bedrockModelConfig).toEqual({ modelId: MODEL, maxTokens: 64000 });
    expect(input.maxTokens).toBe(200000);
    expect(input.systemPrompt).toEqual([{ text: "p" }]);
  });

  it("setup-workflow-manager.mjs builds both create and update from harness-config.mjs", () => {
    const src = readFileSync(join(process.cwd(), "deploy/workflow-manager/setup-workflow-manager.mjs"), "utf8");
    expect(src).toMatch(/from "\.\/harness-config\.mjs"/);
    expect(src).toMatch(/model: wmModel\(MODEL_ID\)/);
    expect(src).toMatch(/maxTokens: WM_MAX_TOKENS_PER_INVOCATION/);
    expect(src).toMatch(/new UpdateHarnessCommand\(wmUpdateInput\(/);
    expect(src).not.toMatch(/maxTokens:\s*32000/);
    expect(src).not.toMatch(/per-response output cap/);
  });
});
