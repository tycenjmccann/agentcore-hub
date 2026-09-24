import { NextResponse } from "next/server";
import { loadModelsRegistry } from "@/lib/models-registry";
import type { CatalogRow, ModelsRegistry } from "@/lib/models-registry";
import type { ModelOption, ModelsApiResponse } from "@/lib/workflow/model-config";

export const dynamic = "force-dynamic";

/**
 * The intake picker, projected from the model registry (TEAM-4997).
 *
 * This list used to be two hardcoded rows that marked Sonnet 5 as the default
 * while every other surface defaulted to Fable 5.1 — the exact disagreement the
 * registry exists to end. The picker now offers what the catalog says is
 * offerable and preselects `defaults.persona`, so intake and the fleet agree by
 * construction.
 *
 * Three filters, each for a different reason:
 *   • `active`      — a candidate is unproven and a retired model is gone.
 *   • priced        — an unpriced model bills at the pricing `default` rate, so
 *                     choosing one makes its own cost card a guess.
 *   • `!readOnly`   — a regional/native id we keep for cost attribution but must
 *                     never route new work to.
 *
 * The response contract (`ModelOption[]`, `modelOptionToOverride`) is unchanged,
 * including the OpenAI append below.
 */

/** UI ids stay short and stable: a bare alias when the row has one. */
function optionIdFor(row: CatalogRow): string {
  return row.aliases[0] || row.modelId;
}

function describe(row: CatalogRow): string {
  const where = row.endpoint === "bedrock-mantle" ? `Bedrock Mantle (${row.region})` : `Bedrock (${row.region})`;
  const rate = row.price ? `$${row.price.input}/$${row.price.output} per 1M in/out` : "unpriced";
  const context = `${Math.round(row.contextWindow / 1000)}K context`;
  return `${where} - ${rate} - ${context}.`;
}

export function projectModelOptions(registry: ModelsRegistry): ModelOption[] {
  const offerable = registry.catalog.filter((row) => row.status === "active" && row.price && !row.readOnly);
  return offerable.map((row) => ({
    id: optionIdFor(row),
    label: row.modelId === registry.defaults.persona ? `${row.label} (Recommended)` : row.label,
    provider: "bedrock" as const,
    modelId: row.modelId,
    description: describe(row),
    ...(row.modelId === registry.defaults.persona ? { isDefault: true } : {}),
  }));
}

/**
 * GET /api/models
 *
 * Returns the list of available AI models for workflow execution:
 * - Bedrock models come from the registry catalog (active, priced, routable)
 * - OpenAI models only included if OPENAI_API_KEY_ARN is set
 * - Gemini models only included if GEMINI_API_KEY is set (future)
 *
 * @returns {ModelsApiResponse} { models: ModelOption[] }
 */
export async function GET(): Promise<NextResponse<ModelsApiResponse>> {
  const registry = await loadModelsRegistry();
  const models: ModelOption[] = projectModelOptions(registry);

  // Include OpenAI models if API key ARN is configured
  const openaiApiKeyArn = process.env.OPENAI_API_KEY_ARN;
  if (openaiApiKeyArn) {
    models.push({
      id: "gpt-4-turbo",
      label: "GPT-4 Turbo (OpenAI)",
      provider: "openai",
      modelId: "gpt-4-turbo-preview",
      description: "OpenAI's most capable model.",
      // apiKeyArn resolved server-side at invocation time, not sent to client
    });
  }

  return NextResponse.json({ models });
}
