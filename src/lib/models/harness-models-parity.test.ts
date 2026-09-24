/**
 * harness-models.ts and harness-models.mjs derive the SAME lane catalog from the
 * SAME registry with the SAME rule, byte-duplicated because a deploy script
 * cannot import TypeScript. This test is the only thing that keeps the duplicate
 * honest: if the two drift, a deploy pins a harness to a config the console never
 * offers (or vice versa), and nothing else in the repo would notice.
 */

import { describe, it, expect } from "vitest";
import * as ts from "./harness-models";
import * as mjs from "./harness-models.mjs";

describe("harness-models .ts / .mjs parity", () => {
  it("exports the same catalog, in the same order, field for field", () => {
    expect(mjs.HARNESS_MODELS).toEqual(ts.HARNESS_MODELS);
  });

  it("exports the same default lane id", () => {
    expect(mjs.DEFAULT_HARNESS_MODEL_ID).toBe(ts.DEFAULT_HARNESS_MODEL_ID);
    expect(ts.DEFAULT_HARNESS_MODEL_ID).toBeTruthy();
  });

  it("findHarnessModel agrees for every lane id, every modelId, and an unknown id", () => {
    const probes = [
      ...ts.HARNESS_MODELS.map((m) => m.id),
      ...ts.HARNESS_MODELS.map((m) => m.modelId),
      "definitely-not-a-model",
    ];
    for (const id of probes) {
      expect(mjs.findHarnessModel(id)).toEqual(ts.findHarnessModel(id));
    }
  });

  it("buildHarnessModelConfig agrees for every lane id, every modelId, and an unknown id", () => {
    const probes = [
      ...ts.HARNESS_MODELS.map((m) => m.id),
      ...ts.HARNESS_MODELS.map((m) => m.modelId),
      "definitely-not-a-model",
    ];
    expect(probes.length).toBeGreaterThan(8);
    for (const id of probes) {
      expect(mjs.buildHarnessModelConfig(id)).toEqual(ts.buildHarnessModelConfig(id));
    }
  });

  it("harnessModelsFrom agrees on a registry neither one bundles", () => {
    const registry = {
      defaults: { persona: "b.model" },
      catalog: [
        {
          modelId: "a.model",
          label: "A",
          requiresMantle: true,
          harnessLanes: [{ id: "a", apiFormat: "converse_stream" }],
        },
        {
          modelId: "b.model",
          harnessLanes: [
            { id: "b1", apiFormat: "responses", label: "B one", description: "d" },
            { id: "b2", apiFormat: "chat_completions", apiKeyArn: "arn:aws:key/b" },
          ],
        },
      ],
    };
    expect(mjs.harnessModelsFrom(registry)).toEqual(ts.harnessModelsFrom(registry));
  });

  it("loadHarnessModels returns the bundled catalog when not asked for live", async () => {
    const loaded = await mjs.loadHarnessModels();
    expect(loaded.models).toEqual(ts.HARNESS_MODELS);
    expect(loaded.defaultId).toBe(ts.DEFAULT_HARNESS_MODEL_ID);
  });
});
