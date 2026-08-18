/**
 * Build the /api/workflow/start payload from a routine's input template.
 *
 * Shared by the "Run now" route and (in spirit — reimplemented, since it runs in a
 * separate bundle) the routines-runner Lambda. `firedAt` lets both callers stamp a
 * deterministic date into the title so a scheduled run and a manual run format the
 * same way. Keep this in sync with lambda/routines-runner/index.mjs::buildPayload.
 */

import type { RoutineInputTemplate } from "./types";

export function buildStartPayload(input: RoutineInputTemplate, firedAt: Date) {
  const date = firedAt.toISOString().slice(0, 10);
  const title = input.titleTemplate.replace(/\{date\}/g, date);
  return {
    title,
    description: input.description || "",
    workflowDefId: input.workflowDefId,
    repoConfig: input.repoConfig,
    sources: input.sources || [],
    ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
    ...(input.connectors?.length ? { connectors: input.connectors } : {}),
  };
}
