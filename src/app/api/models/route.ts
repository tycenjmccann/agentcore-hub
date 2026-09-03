import { NextResponse } from "next/server";
import type { ModelOption, ModelsApiResponse } from "@/lib/workflow/model-config";

/**
 * Static list of available models.
 * Bedrock models are always available.
 * External provider models are filtered based on environment configuration.
 */
const BEDROCK_MODELS: ModelOption[] = [
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5 (Recommended)",
    provider: "bedrock",
    modelId: "us.anthropic.claude-sonnet-5",
    description: "Balanced performance and cost. Default for all workflows.",
    isDefault: true,
  },
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    provider: "bedrock",
    modelId: "us.anthropic.claude-opus-5",
    description: "Latest and most capable model. Best for complex reasoning and code generation.",
  },
];

/**
 * GET /api/models
 * 
 * Returns the list of available AI models for workflow execution.
 * Models are filtered based on environment configuration:
 * - Bedrock models (Claude) are always included
 * - OpenAI models only included if OPENAI_API_KEY_ARN is set
 * - Gemini models only included if GEMINI_API_KEY is set (future)
 * 
 * Response time target: < 100ms (static data)
 * 
 * @returns {ModelsApiResponse} { models: ModelOption[] }
 */
export async function GET(): Promise<NextResponse<ModelsApiResponse>> {
  const models: ModelOption[] = [...BEDROCK_MODELS];

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
