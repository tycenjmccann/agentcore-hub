/**
 * Deploy-script view of the harness model catalog.
 *
 * Reads the SAME data as harness-models.ts (harness-models.json) so setup
 * scripts and the app never drift. See harness-models.ts for the rationale:
 * each model is pinned to a (provider, apiFormat) pair that yields a request
 * shape valid for that model's endpoint under the managed harness loop.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(__dirname, "harness-models.json"), "utf8"),
);

export const HARNESS_MODELS = catalog.models;
export const DEFAULT_HARNESS_MODEL_ID = catalog.defaultId;

export function findHarnessModel(idOrModelId) {
  return (
    HARNESS_MODELS.find((m) => m.id === idOrModelId) ||
    HARNESS_MODELS.find((m) => m.modelId === idOrModelId)
  );
}

/**
 * Build the harness `model` config for CreateHarness/UpdateHarness from a
 * catalog id or raw model id. Unknown ids fall back to Bedrock native Converse.
 */
export function buildHarnessModelConfig(idOrModelId) {
  const opt = findHarnessModel(idOrModelId);

  if (!opt) {
    return { bedrockModelConfig: { modelId: idOrModelId, apiFormat: "converse_stream" } };
  }

  if (opt.provider === "openai") {
    if (!opt.apiKeyArn) {
      throw new Error(
        `Harness model "${opt.id}" is provider "openai" but has no apiKeyArn; ` +
          `the control SDK requires one (there is no keyless Mantle route for OpenAI).`,
      );
    }
    return {
      openAiModelConfig: {
        modelId: opt.modelId,
        apiFormat: opt.apiFormat,
        apiKeyArn: opt.apiKeyArn,
      },
    };
  }

  return {
    bedrockModelConfig: {
      modelId: opt.modelId,
      apiFormat: opt.apiFormat,
    },
  };
}
