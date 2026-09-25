"use client";

/**
 * The three defaults every unnamed model resolves to. Changing one of these moves
 * the whole fleet, so each select carries the facts that decide whether it is a
 * safe choice — endpoint, region, cache rates, and where the price came from —
 * right underneath it rather than three sections away in the catalog.
 */

import { PriceSourceBadge } from "./badges";
import { factsLine } from "./format";
import { ModelSelect, rowFor } from "./ModelSelect";
import type { CatalogRow, DefaultsField, InvalidFields, RegistryDoc, SelectField } from "./types";
import { DEFAULTS_FIELDS } from "./types";

const FIELD_CAPTIONS: Record<DefaultsField, string> = {
  persona: "Every fleet persona that names no model of its own.",
  codingClaude: "The model the claude_code tool runs when no tier is named.",
  codingCodex:
    "codingCodex is the model the codex tool runs when no tier is named. Its endpoint (bedrock-runtime or bedrock-mantle) comes from the catalog row, so Mantle-only models are valid here and in the Codex tiers, nowhere else.",
};

const FIELD_SELECT_KIND: Record<DefaultsField, SelectField> = {
  persona: "persona",
  codingClaude: "codingClaude",
  codingCodex: "codingCodex",
};

/** Endpoint, region and cache rates for the chosen model — or the reason there are none. */
function Facts({ row, modelId }: { row: CatalogRow | undefined; modelId: string }) {
  if (!modelId) return <p className="text-[11px] text-muted mt-1">nothing selected</p>;
  if (!row) {
    // The registry points at a model the catalog has never heard of: every cost
    // figure built on it is guesswork, so say so instead of rendering a blank.
    return <p className="text-[11px] text-danger-fg mt-1">no price on record</p>;
  }
  return (
    <div className="mt-1 flex items-center gap-2 flex-wrap">
      <span className={`text-[11px] ${row.price ? "text-muted" : "text-danger-fg"}`}>
        {row.price ? factsLine(row) : "no price on record"}
      </span>
      {row.price && <PriceSourceBadge source={row.price.source} />}
    </div>
  );
}

export function DefaultsCard({
  draft,
  invalidFields,
  onChange,
}: {
  draft: RegistryDoc;
  /** Dotted path -> reason, straight from the last 422. */
  invalidFields: InvalidFields;
  onChange: (field: DefaultsField, modelId: string) => void;
}) {
  return (
    <section className="card" data-testid="defaults-card" aria-labelledby="defaults-heading">
      <h3 id="defaults-heading" className="text-sm font-semibold text-primary">
        Defaults
      </h3>
      <p className="text-xs text-muted mt-1 leading-relaxed">
        Only active, priced models can be a default. A candidate becomes selectable once both its smoke tests pass and you adopt
        it. Quarantined, unpriced and read-only judge models never appear here.
      </p>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        {DEFAULTS_FIELDS.map((field) => {
          const value = draft.defaults?.[field] ?? "";
          const invalid = invalidFields[`defaults.${field}`];
          return (
            <div key={field} className="min-w-0">
              <ModelSelect
                id={`defaults-${field}`}
                label={field}
                value={value}
                field={FIELD_SELECT_KIND[field]}
                catalog={draft.catalog}
                quarantine={draft.quarantine ?? []}
                invalidMessage={invalid?.message}
                invalidAction={invalid?.action}
                testId={`defaults-select-${field}`}
                onChange={(modelId) => onChange(field, modelId)}
              />
              <Facts row={rowFor(draft.catalog, value)} modelId={value} />
              <p className="text-[11px] text-muted mt-1 leading-relaxed">{FIELD_CAPTIONS[field]}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
