import { describe, it, expect } from "vitest";
import {
  HARNESS_MODELS,
  DEFAULT_HARNESS_MODEL_ID,
  findHarnessModel,
  buildHarnessModelConfig,
  harnessModelsFrom,
} from "./harness-models";
import BUNDLED_SEED from "@/config/models.json";

/**
 * TEAM-4997: the lane data now comes from the model registry's `harnessLanes`.
 * Every assertion below the first block is one the pre-fold file already made —
 * they are what proves the projection did not change the catalog's behaviour.
 */
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

describe("harness catalog is a projection of the registry (TEAM-4997)", () => {
  it("emits every registry lane exactly once, in catalog then lane order", () => {
    const laneIds: string[] = [];
    for (const row of BUNDLED_SEED.catalog) {
      for (const lane of (row as { harnessLanes?: Array<{ id: string }> }).harnessLanes || []) {
        laneIds.push(lane.id);
      }
    }
    expect(laneIds).toHaveLength(8);
    expect(HARNESS_MODELS.map((m) => m.id)).toEqual(laneIds);
  });

  it("carries the owning row's modelId onto each lane", () => {
    const byId = new Map(HARNESS_MODELS.map((m) => [m.id, m]));
    expect(byId.get("claude-opus-4-8-mantle")?.modelId).toBe("us.anthropic.claude-opus-4-8");
    expect(byId.get("claude-opus-4-8-mantle-chat")?.modelId).toBe("us.anthropic.claude-opus-4-8");
    expect(byId.get("claude-fable-5-1")?.modelId).toBe("us.anthropic.claude-fable-5-1");
  });

  it("keeps lanes on retired rows resolvable", () => {
    // An already-deployed harness still references them; a config we cannot
    // resolve is worse than one we no longer recommend.
    for (const id of ["claude-fable-5", "claude-opus-4-6", "claude-sonnet-4-6"]) {
      expect(findHarnessModel(id)?.id).toBe(id);
    }
  });

  it("labels a lane with lane.label, else the row's label", () => {
    const byId = new Map(HARNESS_MODELS.map((m) => [m.id, m]));
    // Lane-level label wins.
    expect(byId.get("claude-opus-4-8-mantle")?.label).toBe("Claude Opus 4.8 (via Mantle)");
    // No lane label -> the row's label, never the raw modelId.
    expect(byId.get("claude-sonnet-5")?.label).toBe("Claude Sonnet 5");
    expect(byId.get("claude-opus-4-6")?.label).toBe("Claude Opus 4.6");
  });

  it("marks exactly one lane '(Recommended)' and it is the default", () => {
    const recommended = HARNESS_MODELS.filter((m) => m.label.includes("(Recommended)"));
    expect(recommended).toHaveLength(1);
    expect(recommended[0].id).toBe(DEFAULT_HARNESS_MODEL_ID);
  });

  it("inherits requiresMantle from the lane or its row", () => {
    const mantle = HARNESS_MODELS.filter((m) => m.requiresMantle).map((m) => m.id);
    expect(mantle).toEqual(["claude-opus-4-8-mantle", "claude-opus-4-8-mantle-chat"]);
  });

  it("all bundled lanes are bedrock-provider (no apiKeyArn in the seed)", () => {
    expect(HARNESS_MODELS.every((m) => m.provider === "bedrock")).toBe(true);
    expect(HARNESS_MODELS.every((m) => m.apiKeyArn === undefined)).toBe(true);
  });

  it("harnessModelsFrom defaults to the first lane of defaults.persona", () => {
    const { models, defaultId } = harnessModelsFrom({
      defaults: { persona: "b.model" },
      catalog: [
        { modelId: "a.model", label: "A", harnessLanes: [{ id: "a", apiFormat: "converse_stream" }] },
        {
          modelId: "b.model",
          label: "B",
          harnessLanes: [
            { id: "b1", apiFormat: "responses" },
            { id: "b2", apiFormat: "chat_completions" },
          ],
        },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["a", "b1", "b2"]);
    expect(defaultId).toBe("b1");
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(["b1"]);
  });

  it("harnessModelsFrom falls back to the first lane when the persona has none", () => {
    // An openai persona has no harness lane, but CreateHarness still needs a
    // resolvable default.
    const { models, defaultId } = harnessModelsFrom({
      defaults: { persona: "openai.gpt-5.5" },
      catalog: [
        { modelId: "a.model", label: "A", harnessLanes: [{ id: "a", apiFormat: "converse_stream" }] },
        { modelId: "openai.gpt-5.5", label: "G" },
      ],
    });
    expect(defaultId).toBe("a");
    expect(models[0].isDefault).toBe(true);
  });

  it("harnessModelsFrom derives the openai provider from apiKeyArn", () => {
    const { models } = harnessModelsFrom({
      catalog: [
        {
          modelId: "openai.gpt-x",
          harnessLanes: [{ id: "gpt-x", apiFormat: "responses", apiKeyArn: "arn:aws:key/x" }],
        },
      ],
    });
    expect(models[0].provider).toBe("openai");
    // No row or lane label -> the modelId, so a lane is never unlabelled.
    expect(models[0].label).toBe("openai.gpt-x");
    expect(buildHarnessModelConfig("gpt-x", models)).toEqual({
      openAiModelConfig: {
        modelId: "openai.gpt-x",
        apiFormat: "responses",
        apiKeyArn: "arn:aws:key/x",
      },
    });
  });

  it("throws for an openai lane with no apiKeyArn (the SDK cannot serialize it)", () => {
    const models = [
      {
        id: "keyless",
        label: "Keyless",
        provider: "openai" as const,
        modelId: "openai.gpt-x",
        apiFormat: "responses" as const,
      },
    ];
    expect(() => buildHarnessModelConfig("keyless", models)).toThrow(/apiKeyArn/);
  });

  it("ignores a lane with no id or no apiFormat", () => {
    const { models } = harnessModelsFrom({
      catalog: [
        {
          modelId: "a.model",
          harnessLanes: [
            { id: "", apiFormat: "responses" },
            { id: "no-format", apiFormat: "" },
            { id: "good", apiFormat: "responses" },
          ],
        },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["good"]);
  });
});
