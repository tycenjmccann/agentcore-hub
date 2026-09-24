import { NextResponse } from "next/server";
import { loadModelsRegistry } from "@/lib/models-registry";
import { projectModelOptions } from "@/lib/models/model-options";
import type { ModelOption, ModelsApiResponse } from "@/lib/workflow/model-config";

export const dynamic = "force-dynamic";

/**
 * GET /api/models
 *
 * Every option comes from the registry catalog (active, priced, routable) — see
 * `projectModelOptions`, which owns the filters and the (Recommended) label.
 *
 * TEAM-5008: the hardcoded `gpt-4-turbo` option this route used to append when
 * OPENAI_API_KEY_ARN was set is gone. It was the one option the picker offered
 * that nothing downstream could honour: it produced an `openAiModelConfig`
 * override (`modelOptionToOverride`), and `lambda/orchestrator/agent-invoker.mjs`
 * reads only `bedrockModelConfig` — so choosing it silently ran the default
 * model. The workflow front door now refuses that shape outright
 * (`validateModelOverride`), and offering a choice the front door rejects would
 * just move the failure from silent to loud. OpenAI models reachable through
 * Bedrock Mantle are catalog rows and are offered like any other.
 *
 * @returns {ModelsApiResponse} { models: ModelOption[] }
 */
export async function GET(): Promise<NextResponse<ModelsApiResponse>> {
  const registry = await loadModelsRegistry();
  const models: ModelOption[] = projectModelOptions(registry);
  return NextResponse.json({ models });
}
