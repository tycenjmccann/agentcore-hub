/**
 * TEAM-5226: ANALYZE died with MaxTokensReachedException because the per-response
 * cap (model.bedrockModelConfig.maxTokens) was never set and the top-level
 * maxTokens — a TOTAL across the invocation — was 32000. Pins both values on
 * the create and update paths of setup-workflow-manager.mjs.
 *
 * TEAM-5238: the per-response cap is per model — min(64000, the catalog row's
 * published maxOutputTokens), 32000 when the row has none.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WM_MAX_TOKENS_PER_RESPONSE,
  WM_MAX_TOKENS_PER_INVOCATION,
  WM_UNKNOWN_MODEL_MAX_OUTPUT,
  wmMaxTokensPerResponse,
  wmModel,
  wmUpdateInput,
} from "./harness-config.mjs";

const MODEL = "us.anthropic.claude-fable-5-1";
const CATALOG = JSON.parse(readFileSync(join(process.cwd(), "src/config/models.json"), "utf8")).catalog;

describe("workflow-manager harness output caps", () => {
  it("uses 64000 per response and 200000 per invocation", () => {
    expect(WM_MAX_TOKENS_PER_RESPONSE).toBe(64000);
    expect(WM_MAX_TOKENS_PER_INVOCATION).toBe(200000);
  });

  it("create input: model carries the per-response cap", () => {
    expect(wmModel(MODEL, CATALOG)).toEqual({ bedrockModelConfig: { modelId: MODEL, maxTokens: 64000 } });
  });

  it("clamps the per-response cap to the model's published max output", () => {
    expect(WM_UNKNOWN_MODEL_MAX_OUTPUT).toBe(32000);
    // 128K published → the 64K ceiling
    expect(wmMaxTokensPerResponse("us.anthropic.claude-fable-5-1", CATALOG)).toBe(64000);
    expect(wmMaxTokensPerResponse("global.anthropic.claude-opus-5-5", CATALOG)).toBe(64000);
    expect(wmMaxTokensPerResponse("claude-fable-5-1", CATALOG)).toBe(64000); // alias
    // 64K published
    expect(wmMaxTokensPerResponse("us.anthropic.claude-haiku-4-5-20251001-v1:0", CATALOG)).toBe(64000);
    // smaller than the ceiling wins
    expect(wmMaxTokensPerResponse("m-small", [{ modelId: "m-small", maxOutputTokens: 16000 }])).toBe(16000);
    // no published value, unknown model, no catalog → conservative fallback
    expect(wmMaxTokensPerResponse("openai.gpt-5.5", CATALOG)).toBe(32000);
    expect(wmMaxTokensPerResponse("us.anthropic.claude-new-thing", CATALOG)).toBe(32000);
    expect(wmMaxTokensPerResponse(MODEL, undefined)).toBe(32000);
  });

  it("falls back to the repo catalog when the live registry row predates maxOutputTokens", () => {
    // The live S3 registry is seed-once: its rows can lack the field.
    const live = CATALOG.map(({ maxOutputTokens, ...row }) => row);
    expect(wmMaxTokensPerResponse(MODEL, live)).toBe(32000);
    expect(wmMaxTokensPerResponse(MODEL, live, CATALOG)).toBe(64000);
    // a live value wins over the repo one
    const liveSmall = [{ modelId: MODEL, maxOutputTokens: 8000 }];
    expect(wmMaxTokensPerResponse(MODEL, liveSmall, CATALOG)).toBe(8000);
    expect(wmUpdateInput({ harnessId: "h", modelId: MODEL, catalog: live, seedCatalog: CATALOG }).model.bedrockModelConfig.maxTokens).toBe(64000);
  });

  it("update input carries both caps (Update retains an omitted top-level maxTokens)", () => {
    const input = wmUpdateInput({ harnessId: "h-1", modelId: MODEL, catalog: CATALOG, systemPrompt: [{ text: "p" }], skills: [] });
    expect(input.harnessId).toBe("h-1");
    expect(input.model.bedrockModelConfig).toEqual({ modelId: MODEL, maxTokens: 64000 });
    expect(input.maxTokens).toBe(200000);
    expect(input.systemPrompt).toEqual([{ text: "p" }]);
  });

  it("setup-workflow-manager.mjs builds both create and update from harness-config.mjs", () => {
    const src = readFileSync(join(process.cwd(), "deploy/workflow-manager/setup-workflow-manager.mjs"), "utf8");
    expect(src).toMatch(/from "\.\/harness-config\.mjs"/);
    expect(src).toMatch(/model: wmModel\(MODEL_ID, CATALOG, SEED_CATALOG\)/);
    expect(src).toMatch(/catalog: CATALOG,\s*seedCatalog: SEED_CATALOG,/);
    expect(src).toMatch(/maxTokens: WM_MAX_TOKENS_PER_INVOCATION/);
    expect(src).toMatch(/new UpdateHarnessCommand\(wmUpdateInput\(/);
    expect(src).not.toMatch(/maxTokens:\s*32000/);
    expect(src).not.toMatch(/per-response output cap/);
  });
});
