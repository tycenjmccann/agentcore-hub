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
    expect(DEFAULT_HARNESS_MODEL_ID).toBe("claude-fable-5-1");
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

  it("pins opus-4-8 chat_completions to the Mantle Chat lane", () => {
    const cfg = buildHarnessModelConfig("claude-opus-4-8-mantle-chat");
    expect(cfg.bedrockModelConfig).toEqual({
      modelId: "us.anthropic.claude-opus-4-8",
      apiFormat: "chat_completions",
    });
  });

  it("resolves the fable-5-1, opus-5, and sonnet-5 catalog entries", () => {
    expect(buildHarnessModelConfig("claude-fable-5-1").bedrockModelConfig).toEqual({
      modelId: "us.anthropic.claude-fable-5-1",
      apiFormat: "converse_stream",
    });
    expect(buildHarnessModelConfig("claude-opus-5").bedrockModelConfig).toEqual({
      modelId: "us.anthropic.claude-opus-5",
      apiFormat: "converse_stream",
    });
    expect(buildHarnessModelConfig("claude-sonnet-5").bedrockModelConfig).toEqual({
      modelId: "us.anthropic.claude-sonnet-5",
      apiFormat: "converse_stream",
    });
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
    // Raw modelId shared by two entries resolves to the first (Responses lane).
    expect(findHarnessModel("us.anthropic.claude-opus-4-8")?.id).toBe("claude-opus-4-8-mantle");
    expect(findHarnessModel("nope")).toBeUndefined();
  });
});
