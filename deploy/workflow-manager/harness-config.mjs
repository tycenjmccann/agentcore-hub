/**
 * Workflow Manager harness output limits (TEAM-5226) — pure, so the create and
 * update inputs setup-workflow-manager.mjs sends can be unit-tested.
 *
 * The harness API has TWO maxTokens fields and they mean different things
 * (@aws-sdk/client-bedrock-agentcore-control, HarnessBedrockModelConfig vs
 * Create/UpdateHarnessRequest):
 *   - model.bedrockModelConfig.maxTokens — cap on ONE model response. Unset, a
 *     long tool call (the analysis.json heredoc) hits it mid-call and Strands
 *     aborts the whole invocation with MaxTokensReachedException.
 *   - top-level maxTokens — TOTAL output across every model call in one
 *     invocation. Was 32000 (commented as a per-response cap, which it is not):
 *     Fable's always-on thinking over a ~75-iteration ANALYZE blows through it.
 * The SDK documents no range for either. The per-response value is per model
 * (TEAM-5238): min(64000, the model's published max output), from the shared
 * clamp in src/lib/models/harness-output-cap.mjs — which also carries the
 * source URL and the cost ceiling. The /models console repin uses the same one.
 */

import {
  HARNESS_MAX_TOKENS_PER_RESPONSE,
  UNKNOWN_MODEL_MAX_OUTPUT,
  harnessMaxTokensPerResponse,
} from "../../src/lib/models/harness-output-cap.mjs";

/** Upper bound per model response (was: unset, harness default). */
export const WM_MAX_TOKENS_PER_RESPONSE = HARNESS_MAX_TOKENS_PER_RESPONSE;
/** Per response for a model the catalog has no published max output for. */
export const WM_UNKNOWN_MODEL_MAX_OUTPUT = UNKNOWN_MODEL_MAX_OUTPUT;
/** Total per InvokeHarness (was: 32000). The 900s invoke timeout bounds it in practice. */
export const WM_MAX_TOKENS_PER_INVOCATION = 200000;

/**
 * Per-response cap for `modelId`: the live registry `catalog` rows first, then
 * the repo `seedCatalog` for a row the live registry predates the field on.
 */
export function wmMaxTokensPerResponse(modelId, catalog, seedCatalog) {
  return harnessMaxTokensPerResponse(modelId, catalog, seedCatalog);
}

export function wmModel(modelId, catalog, seedCatalog) {
  return { bedrockModelConfig: { modelId, maxTokens: wmMaxTokensPerResponse(modelId, catalog, seedCatalog) } };
}

/**
 * UpdateHarness input. Update RETAINS any top-level maxTokens it is not given,
 * so both limits are always sent — an update that dropped them would leave the
 * old cap live.
 */
export function wmUpdateInput({ harnessId, modelId, catalog, seedCatalog, systemPrompt, skills }) {
  return {
    harnessId,
    model: wmModel(modelId, catalog, seedCatalog),
    systemPrompt,
    skills,
    maxTokens: WM_MAX_TOKENS_PER_INVOCATION,
  };
}
