import { describe, it, expect } from "vitest";
import {
  HARNESS_MODELS,
  DEFAULT_HARNESS_MODEL_ID,
  findHarnessModel,
  buildHarnessModelConfig,
} from "./harness-models";

describe("harness model catalog", () => {
  it("has exactly one default and it exists", () => {
    const defaults = HARNESS_MODELS.filter((m) => m.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(DEFAULT_HARNESS_MODEL_ID);
  });

  it("has unique ids and modelIds", () => {
    const ids = HARNESS_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("builds a native Converse config for a converse_stream bedrock model", () => {
    const cfg = buildHarnessModelConfig("claude-opus-4-6");
    expect(cfg.bedrockModelConfig).toEqual({
      modelId: "us.anthropic.claude-opus-4-6",
      apiFormat: "converse_stream",
    });
    expect(cfg.openAiModelConfig).toBeUndefined();
  });

  it("pins opus-4-8 to the Mantle Responses endpoint (the whole point)", () => {
    const cfg = buildHarnessModelConfig("claude-opus-4-8-mantle");
    expect(cfg.bedrockModelConfig).toEqual({
      modelId: "us.anthropic.claude-opus-4-8",
      apiFormat: "responses",
    });
  });

  it("resolves a raw provider modelId to its catalog endpoint", () => {
    // Passing the bare opus-4-8 id must still route through Mantle, not Converse.
    const cfg = buildHarnessModelConfig("us.anthropic.claude-opus-4-8");
    expect(cfg.bedrockModelConfig?.apiFormat).toBe("responses");
  });

  it("builds an OpenAI-via-Mantle config with no api key", () => {
    const cfg = buildHarnessModelConfig("gpt-5-4-mantle");
    expect(cfg.openAiModelConfig).toEqual({
      modelId: "gpt-5.4",
      apiFormat: "responses",
      endpoint: { bedrockMantle: {} },
    });
    expect(cfg.openAiModelConfig?.apiKeyArn).toBeUndefined();
  });

  it("falls back to native Converse for unknown ids", () => {
    const cfg = buildHarnessModelConfig("some-unknown-model");
    expect(cfg.bedrockModelConfig).toEqual({
      modelId: "some-unknown-model",
      apiFormat: "converse_stream",
    });
  });

  it("findHarnessModel matches by id or modelId", () => {
    expect(findHarnessModel("claude-fable-5")?.id).toBe("claude-fable-5");
    expect(findHarnessModel("gpt-5.4")?.id).toBe("gpt-5-4-mantle");
    expect(findHarnessModel("nope")).toBeUndefined();
  });
});
