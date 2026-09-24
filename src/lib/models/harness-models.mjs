/**
 * Deploy-script view of the harness model catalog.
 *
 * Reads the SAME data as harness-models.ts — `catalog[].harnessLanes[]` in
 * src/config/models.json, the model registry (TEAM-4997) — so setup scripts and
 * the app never drift. See harness-models.ts for the rationale: each model is
 * pinned to a (provider, apiFormat) pair that yields a request shape valid for
 * that model's endpoint under the managed harness loop.
 *
 * The lane-flattening rule below is a BYTE-FOR-BYTE duplicate of
 * `harnessModelsFrom` in harness-models.ts (a deploy script cannot import
 * TypeScript). harness-models-parity.test.ts imports both and fails the build if
 * they disagree, so edit the two together or not at all.
 *
 * `loadHarnessModels({live:true})` reads the LIVE registry from S3 instead of the
 * bundled seed, so a deploy re-pins a harness to whatever the console last saved
 * rather than to whatever was baked into the image.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dirname, "..", "..", "config", "models.json");
const REGISTRY_KEY = "config/models.json";

const seed = JSON.parse(readFileSync(SEED_PATH, "utf8"));

/**
 * Flatten a registry's harness lanes. Mirrors harnessModelsFrom() in the .ts:
 *   provider       = lane.apiKeyArn ? "openai" : "bedrock"
 *   label          = lane.label ?? row.label ?? row.modelId
 *   requiresMantle = lane.requiresMantle ?? row.requiresMantle
 *   isDefault      = the FIRST lane of the `defaults.persona` row
 * Display order is catalog order, then lane order within a row.
 */
export function harnessModelsFrom(registry) {
  const models = [];
  const persona = registry?.defaults?.persona || "";
  let defaultId = "";

  for (const row of registry?.catalog || []) {
    for (const lane of row?.harnessLanes || []) {
      if (!lane?.id || !lane?.apiFormat) continue;
      const option = {
        id: lane.id,
        label: lane.label || row.label || row.modelId,
        provider: lane.apiKeyArn ? "openai" : "bedrock",
        modelId: row.modelId,
        apiFormat: lane.apiFormat,
      };
      if (lane.apiKeyArn) option.apiKeyArn = lane.apiKeyArn;
      if (lane.description) option.description = lane.description;
      const requiresMantle = lane.requiresMantle ?? row.requiresMantle;
      if (requiresMantle) option.requiresMantle = true;
      if (!defaultId && row.modelId === persona) {
        option.isDefault = true;
        defaultId = lane.id;
      }
      models.push(option);
    }
  }

  if (!defaultId && models.length) {
    models[0].isDefault = true;
    defaultId = models[0].id;
  }
  return { models, defaultId };
}

const bundled = harnessModelsFrom(seed);

export const HARNESS_MODELS = bundled.models;
export const DEFAULT_HARNESS_MODEL_ID = bundled.defaultId;

export function findHarnessModel(idOrModelId, models = HARNESS_MODELS) {
  return (
    models.find((m) => m.id === idOrModelId) ||
    models.find((m) => m.modelId === idOrModelId)
  );
}

/**
 * Build the harness `model` config for CreateHarness/UpdateHarness from a
 * catalog id or raw model id. Unknown ids fall back to Bedrock native Converse.
 */
export function buildHarnessModelConfig(idOrModelId, models = HARNESS_MODELS) {
  const opt = findHarnessModel(idOrModelId, models);

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

/**
 * The lane catalog a deploy should use. `{live:true}` prefers the live registry
 * (s3://$ARTIFACT_BUCKET/config/models.json) so a deploy does not revert a
 * console edit; any failure — no bucket, missing key, unreadable JSON — falls
 * back to the bundled seed, because a deploy must never be blocked on S3.
 */
export async function loadHarnessModels({ live = false } = {}) {
  const bucket = process.env.ARTIFACT_BUCKET || "";
  if (!live || !bucket) return bundled;
  try {
    const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: REGISTRY_KEY }));
    const doc = JSON.parse(await obj.Body.transformToString());
    const derived = harnessModelsFrom(doc);
    if (!derived.models.length) throw new Error("live registry has no harness lanes");
    return derived;
  } catch (err) {
    console.warn(`[models] harness-models fallback to seed: ${err?.message || err}`);
    return bundled;
  }
}
