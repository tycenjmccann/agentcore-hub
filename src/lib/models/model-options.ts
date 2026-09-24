/**
 * The intake picker's option list, projected from the model registry (TEAM-4997).
 *
 * This list used to be two hardcoded rows that marked Sonnet 5 as the default
 * while every other surface defaulted to Fable 5.1 — the exact disagreement the
 * registry exists to end. The picker now offers what the catalog says is offerable
 * and preselects `defaults.persona`, so intake and the fleet agree by
 * construction.
 *
 * Three filters, each for a different reason:
 *   • `active`      — a candidate is unproven and a retired model is gone.
 *   • priced        — an unpriced model bills at the pricing `default` rate, so
 *                     choosing one makes its own cost card a guess.
 *   • `!readOnly`   — a regional/native id we keep for cost attribution but must
 *                     never route new work to.
 *
 * Pure, and it lives here rather than in the route because Next.js only permits
 * its own export names (`GET`, `dynamic`, …) from a `route.ts`.
 */

import type { CatalogRow, ModelsRegistry } from "@/lib/models-registry";
import type { ModelOption } from "@/lib/workflow/model-config";

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
