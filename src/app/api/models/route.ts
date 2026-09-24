import { NextResponse } from "next/server";
import { loadModelsRegistry } from "@/lib/models-registry";
import { projectModelOptions } from "@/lib/models/model-options";
import type { ModelOption, ModelsApiResponse } from "@/lib/workflow/model-config";

export const dynamic = "force-dynamic";

/**
 * GET /api/models
 *
 * Returns the list of available AI models for workflow execution:
 * - Bedrock models come from the registry catalog (active, priced, routable) —
 *   see `projectModelOptions`, which owns the filters and the (Recommended) label
 * - OpenAI models only included if OPENAI_API_KEY_ARN is set
 * - Gemini models only included if GEMINI_API_KEY is set (future)
 *
 * The response contract (`ModelOption[]`, `modelOptionToOverride`) is unchanged,
 * including the OpenAI append below.
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
