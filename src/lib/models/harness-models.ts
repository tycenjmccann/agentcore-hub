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
 * The catalog DATA lives in `harness-models.json` so deploy scripts (.mjs) and
 * this module share exactly one list. This file adds the types + config builder.
 */

import catalog from "./harness-models.json";

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

/** Curated catalog (order = display order; exactly one `isDefault`). */
export const HARNESS_MODELS: HarnessModelOption[] =
  catalog.models as HarnessModelOption[];

export const DEFAULT_HARNESS_MODEL_ID: string = catalog.defaultId;

/** Look up a catalog entry by UI id OR by raw provider modelId. */
export function findHarnessModel(idOrModelId: string): HarnessModelOption | undefined {
  return (
    HARNESS_MODELS.find((m) => m.id === idOrModelId) ||
    HARNESS_MODELS.find((m) => m.modelId === idOrModelId)
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
export function buildHarnessModelConfig(idOrModelId: string): HarnessModelConfig {
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
