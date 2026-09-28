/**
 * Per-response output cap for harness agents (TEAM-5226, TEAM-5238) — the ONE
 * place the clamp lives. Plain .mjs with no imports so both callers can share it:
 * deploy/workflow-manager/harness-config.mjs (setup script, create + update) and
 * src/lib/models/harness-apply.ts (the /models console repin). A repin that
 * dropped the cap would bring back the TEAM-5226 failure, so both must agree.
 *
 * The cap is model.bedrockModelConfig.maxTokens: the limit on ONE model
 * response. It is min(HARNESS_MAX_TOKENS_PER_RESPONSE, the model's published
 * max output). Published values are the catalog rows' `maxOutputTokens`
 * (src/config/models.json), taken from
 * https://docs.anthropic.com/en/docs/about-claude/models/overview (max output:
 * Fable 5.1 128K, Opus 5.5 128K, Sonnet 5 128K, Haiku 4.5 64K). A row that doc
 * does not cover — OpenAI and older Claude rows — has no value and gets the
 * conservative UNKNOWN_MODEL_MAX_OUTPUT.
 *
 * The live registry (s3 config/models.json) is seeded once and never
 * overwritten from the repo, so its rows can predate the field. Callers pass
 * the repo catalog as `seedCatalog`: a published max output is a fact about the
 * model, not operator routing, so the repo value stands in when the live row
 * has none.
 *
 * Cost ceiling at that doc's Fable 5.1 output price ($50/MTok): one response
 * ≤ 64K × $50/MTok = $3.20. The Workflow Manager's top-level maxTokens (200K
 * output per invocation, harness-config.mjs) × 4 invocations (1 + the
 * analyzer's MAX_CONTINUATIONS) = 800K ≈ $40 worst case per ANALYZE, against
 * 32K total per invocation before TEAM-5226.
 */

/** Upper bound on one model response, whatever the model allows. */
export const HARNESS_MAX_TOKENS_PER_RESPONSE = 64000;

/** For a model with no published max output in the catalog. */
export const UNKNOWN_MODEL_MAX_OUTPUT = 32000;

/** The harness agents whose model config carries the cap. */
export const OUTPUT_CAPPED_HARNESS_AGENT_IDS = ["agentcore_hub_workflow_manager"];

/**
 * @typedef {ReadonlyArray<{modelId?: string, aliases?: string[], maxOutputTokens?: number}> | null | undefined} OutputCapCatalog
 */

/** @param {string} modelId @param {OutputCapCatalog} catalog @returns {number | undefined} */
function publishedMaxOutput(modelId, catalog) {
  const rows = Array.isArray(catalog) ? catalog : [];
  const row =
    rows.find((r) => r?.modelId === modelId) ||
    rows.find((r) => Array.isArray(r?.aliases) && r.aliases.includes(modelId));
  const n = Number(row?.maxOutputTokens);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * @param {string} modelId  catalog modelId or alias
 * @param {OutputCapCatalog} catalog  the live registry's catalog
 * @param {OutputCapCatalog} [seedCatalog]  the repo catalog, for rows the live one lacks the value on
 * @returns {number}
 */
export function harnessMaxTokensPerResponse(modelId, catalog, seedCatalog) {
  const max =
    publishedMaxOutput(modelId, catalog) ?? publishedMaxOutput(modelId, seedCatalog) ?? UNKNOWN_MODEL_MAX_OUTPUT;
  return Math.min(HARNESS_MAX_TOKENS_PER_RESPONSE, max);
}
