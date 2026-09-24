/**
 * `modelOverride` validation for the workflow front door (TEAM-5008 finding 7).
 *
 * `POST /api/workflow/start` used to spread the request body into the persisted
 * run untouched, so any string at all became the model every dev agent ran on.
 * A typo ("clade-opus-5") resolved to nothing and the agents silently fell back
 * to the default — an invisible model change, which is the failure this epic
 * exists to end — and a retired or quarantined id was accepted just as happily.
 *
 * Two shapes are legal, and nothing else:
 *   • a string — a catalog id, a row alias, a `legacyAliases` key or a Claude
 *     tier word ("opus"), since `resolveModel` with no `cli` reads `tiers.claude`
 *     (DD3) and the persona chain resolves an override exactly that way;
 *   • `{ bedrockModelConfig: { modelId } }` — what the console's own IntakeForm
 *     sends (`modelOptionToOverride`), so a string-only rule would 400 every
 *     model choice made in the UI.
 *
 * `openAiModelConfig` is refused: `lambda/orchestrator/agent-invoker.mjs` only
 * ever honours `bedrockModelConfig`, so accepting it would keep promising a
 * model that never runs. Extra keys are refused rather than ignored — an
 * override carrying an `apiKeyArn` this route does not read is a caller that
 * believes something untrue about where its credentials go.
 *
 * The verdict carries the NORMALIZED override (same shape in, resolved modelId
 * out) so the run is persisted with the id that will actually be invoked rather
 * than the alias or tier word the caller happened to type.
 */

import type { ModelsRegistry } from "@/lib/models-registry";
import { resolveModel } from "@/lib/models-registry";

/**
 * The two legal shapes, declared here rather than imported from
 * `@/lib/workflow/types`: this file is core, Workflow is an optional module, and
 * core may not import from one (CLAUDE.md, "Modular core + bolt-ons"). It is a
 * structural subset of that module's `ModelOverride`, so the route assigns it
 * back into the body without a cast.
 */
export type NormalizedOverride = string | { bedrockModelConfig: { modelId: string } };

/** Reason codes, most specific first — the 400 body quotes one verbatim. */
export type OverrideRejection =
  | "unsupported_shape"
  | "unknown_model"
  | "not_in_catalog"
  | "quarantined"
  | "inactive"
  | "unpriced"
  | "read_only";

export type OverrideVerdict =
  | { ok: true; override: NormalizedOverride | undefined; modelId: string }
  | { ok: false; reason: OverrideRejection };

/** A bare `resolveModel` may only answer with a lookup that found a real row. */
const CATALOG_LOOKUPS: readonly string[] = ["tier", "legacyAlias", "catalog"];

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Exactly one key, and it is `key`. */
function soleKey(obj: Record<string, unknown>, key: string): boolean {
  const keys = Object.keys(obj);
  return keys.length === 1 && keys[0] === key;
}

/**
 * Resolve one override string to a catalog row an agent can actually be pointed
 * at: active, priced, not read-only, not quarantined.
 */
function resolveOverrideId(
  registry: ModelsRegistry,
  value: string
): { ok: true; modelId: string } | { ok: false; reason: OverrideRejection } {
  const resolved = resolveModel(registry, value, {});
  if (!resolved) {
    // `resolveModel` returns null for a quarantined or retired id as well as for
    // a typo; say which, because they call for different operator actions.
    if (registry.quarantine.includes(value)) return { ok: false, reason: "quarantined" };
    const row = registry.catalog.find((r) => r.modelId === value || r.aliases.includes(value));
    if (row?.status === "quarantined") return { ok: false, reason: "quarantined" };
    if (row?.status === "retired") return { ok: false, reason: "inactive" };
    return { ok: false, reason: "unknown_model" };
  }
  // A dotted id nobody catalogued is legal deeper in the stack (an operator-owned
  // document is the input there); at the front door it is an unpriced, unprobed,
  // unknown model chosen by whoever can reach this route.
  if (!resolved.row || !CATALOG_LOOKUPS.includes(resolved.source)) {
    return { ok: false, reason: "not_in_catalog" };
  }
  const row = resolved.row;
  if (row.readOnly) return { ok: false, reason: "read_only" };
  if (row.status !== "active") return { ok: false, reason: "inactive" };
  const price = row.price;
  if (!price || !Number.isFinite(price.input) || !Number.isFinite(price.output)) {
    return { ok: false, reason: "unpriced" };
  }
  return { ok: true, modelId: resolved.modelId };
}

/**
 * Is `value` an override this hub can honour? An absent or empty override is
 * fine — it is the common case, and it means "use the configured default".
 */
export function validateModelOverride(registry: ModelsRegistry, value: unknown): OverrideVerdict {
  if (value === undefined || value === null) return { ok: true, override: undefined, modelId: "" };

  if (typeof value === "string") {
    if (!value.trim()) return { ok: true, override: undefined, modelId: "" };
    const resolved = resolveOverrideId(registry, value.trim());
    if (!resolved.ok) return resolved;
    return { ok: true, override: resolved.modelId, modelId: resolved.modelId };
  }

  if (!isObj(value) || !soleKey(value, "bedrockModelConfig")) {
    return { ok: false, reason: "unsupported_shape" };
  }
  const config = value.bedrockModelConfig;
  if (!isObj(config) || !soleKey(config, "modelId") || typeof config.modelId !== "string") {
    return { ok: false, reason: "unsupported_shape" };
  }
  if (!config.modelId.trim()) return { ok: false, reason: "unknown_model" };
  const resolved = resolveOverrideId(registry, config.modelId.trim());
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    override: { bedrockModelConfig: { modelId: resolved.modelId } },
    modelId: resolved.modelId,
  };
}
