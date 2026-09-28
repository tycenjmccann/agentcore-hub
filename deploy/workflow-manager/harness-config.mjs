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
 * The SDK documents no range for either. Fable 5.1's max output is 128K.
 */

/** Per model response (was: unset, harness default). */
export const WM_MAX_TOKENS_PER_RESPONSE = 64000;
/** Total per InvokeHarness (was: 32000). The 900s invoke timeout bounds it in practice. */
export const WM_MAX_TOKENS_PER_INVOCATION = 200000;

export function wmModel(modelId) {
  return { bedrockModelConfig: { modelId, maxTokens: WM_MAX_TOKENS_PER_RESPONSE } };
}

/**
 * UpdateHarness input. Update RETAINS any top-level maxTokens it is not given,
 * so both limits are always sent — an update that dropped them would leave the
 * old cap live.
 */
export function wmUpdateInput({ harnessId, modelId, systemPrompt, skills }) {
  return {
    harnessId,
    model: wmModel(modelId),
    systemPrompt,
    skills,
    maxTokens: WM_MAX_TOKENS_PER_INVOCATION,
  };
}
