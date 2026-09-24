/**
 * How a resolved model is turned into something a human reads.
 *
 * `GET /api/models/registry` answers with the resolution CHAIN, not with display
 * strings: per agent it sends `{modelId, source, via?}`, where `source` is the step
 * that supplied the value (`agents` = pinned for this agent, `defaults` = the persona
 * default, `env`/`literal` = a fallback nobody chose) and `via` is how that value was
 * looked up. The pretty name lives once, on the catalog row, in the same response.
 *
 * So the label is DERIVED on the client, and it is derived here rather than in the
 * hook (src/lib/models-registry-client.ts) for one reason: this file is pure. No
 * React, no fetch, no `"use client"` — which is what lets the derivation be unit
 * tested under vitest's node environment instead of needing a DOM.
 *
 * It is also the single home for `shortModelId`, which src/components/models/format.ts
 * re-exports. A second copy there is how the Models page and an agent card would come
 * to shorten the same id two different ways.
 */

/** Which step of the resolution chain supplied the model id. */
export type ResolveChainStep = "override" | "agents" | "defaults" | "env" | "literal";

/** How the supplying step's value was looked up. */
export type ResolveLookupKind = "tier" | "legacyAlias" | "catalog" | "passthrough";

/**
 * One resolved deployable, exactly as `/api/models/registry` reports it — no more
 * fields than the wire actually carries, so a render site cannot read a value the
 * server never sent.
 */
export interface ResolvedModelEntry {
  modelId: string;
  source: ResolveChainStep;
  via?: ResolveLookupKind;
  /** What the live harness reports, when the deployable is a harness. */
  harnessModel?: string | null;
}

/** The catalog slice a label needs. The GET returns the whole document, this included. */
export interface CatalogLabelRow {
  modelId: string;
  label?: string;
}

/** The three display fields the wire does NOT carry. */
export interface DerivedModelLabels {
  /** The catalog's name for the model, or the bare id when it has no row. */
  label: string;
  /** What fits in a table cell. The catalog label IS the short form. */
  shortLabel: string;
  /** True when no per-agent pin chose this model. */
  inherited: boolean;
}

/**
 * The last segment of a model id, for the compact label sites (agent cards, the
 * board's phase roll-up) where the full `us.anthropic.claude-fable-5-1` does not
 * fit. Falls back to the whole id.
 */
export function shortModelId(modelId: string): string {
  if (!modelId) return "";
  return modelId.split("/").pop()?.split(":")[0] || modelId;
}

/**
 * `{modelId, source}` + the catalog → the three display fields.
 *
 * `inherited` is about PROVENANCE, not about the value: a model reached through
 * `defaults`, `env` or `literal` is one nobody pinned for this agent, and only
 * `agents`/`override` are a deliberate exception somebody has to keep justifying.
 * That is the distinction the violet dot marks.
 *
 * A missing catalog (an old cached document, a registry read that half-failed) is
 * not an error: the id is a worse label than "Claude Opus 5.5" but a far better one
 * than a dash, so it is what gets rendered.
 */
export function deriveResolved(
  entry: ResolvedModelEntry,
  catalog: readonly CatalogLabelRow[] | undefined,
): DerivedModelLabels {
  const row = catalog?.find((r) => r.modelId === entry.modelId);
  const label = row?.label || entry.modelId;
  return {
    label,
    shortLabel: row?.label || shortModelId(entry.modelId),
    inherited: entry.source !== "agents" && entry.source !== "override",
  };
}

/**
 * The caption under an agent's model on its detail page. Derived from `source`, so
 * an `env`/`literal` fallback is not mislabelled as the persona default — that lie
 * is exactly what sends someone looking for a `defaults.persona` they never set.
 */
export function provenanceCaption(source: ResolveChainStep): string {
  if (source === "agents" || source === "override") return "Override";
  if (source === "defaults") return "Inherited from defaults.persona";
  return `Resolved via ${source}`;
}
