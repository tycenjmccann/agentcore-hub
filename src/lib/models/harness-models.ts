/**
 * Harness model catalog — one source of truth mapping a model choice to the
 * EXACT `model` config the AgentCore harness expects.
 *
 * Why this exists: the harness runs an agentic loop server-side (we don't build
 * its per-turn `messages`). The only levers we control are the model id, the
 * provider config, and the `apiFormat`. Some models reject request shapes the
 * managed loop emits on a given endpoint — e.g. `claude-opus-4-8` on the
 * `converse_stream` endpoint rejects a trailing-assistant (prefill) turn with
 * "conversation must end with a user message", while the same model on the
 * `responses` (Bedrock Mantle) endpoint tolerates it. Pinning each model to a
 * known-good (endpoint, apiFormat) pair makes the WM (and any harness agent)
 * work across models instead of only the ones whose defaults happen to match.
 *
 * The lanes AgentCore supports (see AWS docs "Models and instructions"):
 *   1. bedrock + converse_stream   → bedrock-runtime  (native Converse; default)
 *   2. bedrock + responses         → bedrock-mantle   (OpenAI-compatible Responses)
 *   3. bedrock + chat_completions  → bedrock-mantle   (OpenAI-compatible Chat)
 *   4. openai  + responses/chat    → a direct OpenAI endpoint; requires an API key
 *      ARN in AgentCore Identity (apiKeyArn). NOTE: the JS control SDK models an
 *      OpenAI config as { modelId, apiKeyArn, apiFormat } only — there is no
 *      "route OpenAI through Mantle without a key" shape it can serialize, so the
 *      catalog ships only the Bedrock lanes for Mantle. To add a direct-OpenAI
 *      model, give its entry an apiKeyArn.
 *
 * TEAM-4997: the lane DATA is no longer its own file. It is a projection of the
 * model registry — `catalog[].harnessLanes[]` in `src/config/models.json` (live:
 * `s3://$ARTIFACT_BUCKET/config/models.json`) — so a harness lane and the model's
 * price, endpoint and probe results can no longer disagree about what a model is.
 * `harness-models.mjs` derives the same list for deploy scripts with the same
 * rule, and `harness-models-parity.test.ts` proves the two agree.
 *
 * Lanes on RETIRED rows are kept: an already-deployed harness still references
 * them, and a config we can't resolve is worse than one we no longer recommend.
 */

import { BUNDLED_REGISTRY } from "@/lib/models-registry";

export type BedrockApiFormat = "converse_stream" | "responses" | "chat_completions";
export type OpenAiApiFormat = "responses" | "chat_completions";

/** The `model` object accepted by CreateHarness / UpdateHarness / InvokeHarness. */
export interface HarnessModelConfig {
  bedrockModelConfig?: {
    modelId: string;
    apiFormat?: BedrockApiFormat;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    additionalParams?: Record<string, any>;
  };
  openAiModelConfig?: {
    modelId: string;
    apiFormat?: OpenAiApiFormat;
    /** ARN of the OpenAI API key in AgentCore Identity. Required by the SDK. */
    apiKeyArn: string;
  };
}

export type ModelProvider = "bedrock" | "openai";

export interface HarnessModelOption {
  /** Stable UI id, e.g. "claude-opus-4-8-mantle". */
  id: string;
  label: string;
  provider: ModelProvider;
  /** Provider model id used in API calls. */
  modelId: string;
  /** Endpoint/protocol this model is pinned to. */
  apiFormat: BedrockApiFormat | OpenAiApiFormat;
  /** For `openai` provider entries only: ARN of the API key in AgentCore Identity. */
  apiKeyArn?: string;
  description?: string;
  isDefault?: boolean;
  /**
   * True when this model is known to reject the harness loop's trailing-assistant
   * (prefill) turn on the native Converse endpoint, so it MUST run on a Mantle
   * endpoint (responses/chat_completions). Drives selection + validation.
   */
  requiresMantle?: boolean;
}

/** The minimum shape the derivation needs — a parsed registry or the raw doc. */
export interface RegistryLike {
  defaults?: { persona?: string };
  catalog?: Array<{
    modelId: string;
    label?: string;
    requiresMantle?: boolean;
    harnessLanes?: Array<{
      id: string;
      apiFormat: string;
      requiresMantle?: boolean;
      apiKeyArn?: string;
      label?: string;
      description?: string;
    }>;
  }>;
}

export interface HarnessCatalog {
  models: HarnessModelOption[];
  defaultId: string;
}

/**
 * Flatten a registry's harness lanes into the catalog this module has always
 * exported. THIS RULE IS DUPLICATED, BYTE FOR BYTE, IN harness-models.mjs —
 * deploy scripts cannot import TypeScript, and the parity test is what keeps the
 * two honest:
 *   provider       = lane.apiKeyArn ? "openai" : "bedrock"
 *   label          = lane.label ?? row.label ?? row.modelId
 *   requiresMantle = lane.requiresMantle ?? row.requiresMantle
 *   isDefault      = the FIRST lane of the `defaults.persona` row
 * Display order is catalog order, then lane order within a row.
 */
export function harnessModelsFrom(registry: RegistryLike): HarnessCatalog {
  const models: HarnessModelOption[] = [];
  const persona = registry.defaults?.persona || "";
  let defaultId = "";

  for (const row of registry.catalog || []) {
    for (const lane of row.harnessLanes || []) {
      if (!lane?.id || !lane?.apiFormat) continue;
      const option: HarnessModelOption = {
        id: lane.id,
        label: lane.label || row.label || row.modelId,
        provider: lane.apiKeyArn ? "openai" : "bedrock",
        modelId: row.modelId,
        apiFormat: lane.apiFormat as BedrockApiFormat | OpenAiApiFormat,
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

  // A persona with no harness lane (e.g. an openai default) still needs SOME
  // resolvable default, or every CreateHarness call would have to name a lane.
  if (!defaultId && models.length) {
    models[0].isDefault = true;
    defaultId = models[0].id;
  }
  return { models, defaultId };
}

const BUNDLED: HarnessCatalog = harnessModelsFrom(BUNDLED_REGISTRY);

/** Curated catalog (order = display order; exactly one `isDefault`). */
export const HARNESS_MODELS: HarnessModelOption[] = BUNDLED.models;

export const DEFAULT_HARNESS_MODEL_ID: string = BUNDLED.defaultId;

/**
 * Look up a catalog entry by UI id OR by raw provider modelId. `models` defaults
 * to the bundled seed's lanes; a caller holding a LIVE registry passes
 * `harnessModelsFrom(registry).models` so there is still exactly one lookup rule.
 */
export function findHarnessModel(
  idOrModelId: string,
  models: HarnessModelOption[] = HARNESS_MODELS
): HarnessModelOption | undefined {
  return (
    models.find((m) => m.id === idOrModelId) ||
    models.find((m) => m.modelId === idOrModelId)
  );
}

/**
 * Build the exact `model` config for CreateHarness/UpdateHarness/InvokeHarness
 * from a catalog id/modelId. This is the whole point of the module: callers pass
 * a model choice, get back a shape that is valid for THAT model's endpoint.
 *
 * Falls back to a native-Converse bedrock config for unknown Bedrock model ids
 * (safe default), so passing a raw `us.anthropic.*` id still works.
 */
export function buildHarnessModelConfig(
  idOrModelId: string,
  models: HarnessModelOption[] = HARNESS_MODELS
): HarnessModelConfig {
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
        apiFormat: opt.apiFormat as OpenAiApiFormat,
        apiKeyArn: opt.apiKeyArn,
      },
    };
  }

  return {
    bedrockModelConfig: {
      modelId: opt.modelId,
      apiFormat: opt.apiFormat as BedrockApiFormat,
    },
  };
}
