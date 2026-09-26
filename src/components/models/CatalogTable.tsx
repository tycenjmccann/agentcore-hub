"use client";

/**
 * The catalog: every model the registry knows about, and the only place prices,
 * probes and lifecycle change.
 *
 * Refresh is deliberately awkward. It re-discovers models and republishes prices
 * by rewriting the catalog ON THE SERVER, which would silently clobber staged
 * local edits — so with unsaved changes the button explains itself instead of
 * running. Retired rows are collapsed because they are history, not choices.
 *
 * Read-only judge models are NOT listed here: they cannot be selected anywhere, so
 * an Adopt or Quarantine button on them would be meaningless. They have their own
 * card, which says why they are pinned elsewhere.
 */

import { Loader2, RefreshCw } from "lucide-react";
import { CatalogTableRow } from "./CatalogRow";
import { parseCatalogPath } from "./types";
import type { CatalogRow, InvalidReason, Price, ProbeMode, RegistryDoc } from "./types";

export function CatalogTable({
  draft,
  interimOverdue,
  probesRunning,
  editingPrice,
  editingAliases,
  invalidFields,
  refreshing,
  refreshMessage,
  refreshBlockedMessage,
  showRetired,
  onToggleRetired,
  onRefresh,
  onEdit,
  onEditCancel,
  onPrice,
  onEditAliases,
  onEditAliasesCancel,
  onAliases,
  onAdopt,
  onQuarantine,
  onLiftQuarantine,
  onProbe,
}: {
  draft: RegistryDoc;
  interimOverdue: string[];
  probesRunning: Set<string>;
  editingPrice: string | null;
  editingAliases: string | null;
  /** The 422's rejected fields; a row shows the ones on its own aliases. */
  invalidFields: Record<string, { reason: InvalidReason; message: string }>;
  refreshing: boolean;
  refreshMessage: string | null;
  /** Set when there are unsaved changes; the button explains rather than acts. */
  refreshBlockedMessage: string | null;
  showRetired: boolean;
  onToggleRetired: () => void;
  onRefresh: () => void;
  onEdit: (modelId: string) => void;
  onEditCancel: () => void;
  onPrice: (modelId: string, price: Price) => void;
  onEditAliases: (modelId: string) => void;
  onEditAliasesCancel: () => void;
  onAliases: (modelId: string, aliases: string[]) => void;
  onAdopt: (modelId: string) => void;
  onQuarantine: (modelId: string) => void;
  onLiftQuarantine: (modelId: string) => void;
  onProbe: (modelId: string, mode: ProbeMode) => void;
}) {
  const quarantine = draft.quarantine ?? [];
  const rows = draft.catalog.filter((r) => !r.readOnly);
  const live = rows.filter((r) => r.status !== "retired");
  const retired = rows.filter((r) => r.status === "retired");

  const aliasErrors = new Map<string, string[]>();
  for (const [path, { message }] of Object.entries(invalidFields)) {
    const p = parseCatalogPath(path);
    if (p?.field !== "aliases") continue;
    aliasErrors.set(p.modelId, [...(aliasErrors.get(p.modelId) ?? []), message]);
  }

  const render = (row: CatalogRow) => (
    <CatalogTableRow
      key={row.modelId}
      row={row}
      quarantined={quarantine.includes(row.modelId)}
      interimOverdue={interimOverdue.includes(row.modelId)}
      probesRunning={probesRunning}
      editing={editingPrice === row.modelId}
      onEdit={onEdit}
      onEditCancel={onEditCancel}
      onPrice={onPrice}
      editingAliases={editingAliases === row.modelId}
      aliasErrors={aliasErrors.get(row.modelId) ?? []}
      onEditAliases={onEditAliases}
      onEditAliasesCancel={onEditAliasesCancel}
      onAliases={onAliases}
      onAdopt={onAdopt}
      onQuarantine={onQuarantine}
      onLiftQuarantine={onLiftQuarantine}
      onProbe={onProbe}
    />
  );

  return (
    <section
      id="catalog-section"
      tabIndex={-1}
      className="card"
      data-testid="catalog-section"
      aria-labelledby="catalog-heading"
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 id="catalog-heading" className="text-sm font-semibold text-primary">
            Catalog
          </h3>
          <p className="text-xs text-muted mt-1">
            {live.length} live row{live.length === 1 ? "" : "s"}
            {retired.length > 0 ? `, ${retired.length} retired` : ""}. A model has to be active and priced before
            anything can point at it.
          </p>
        </div>
        <div className="text-right">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing || Boolean(refreshBlockedMessage)}
            aria-describedby={refreshBlockedMessage ? "catalog-refresh-blocked" : undefined}
            data-testid="catalog-refresh"
            className="text-xs px-3 py-1.5 rounded-lg border border-theme text-secondary hover:text-primary transition-colors inline-flex items-center gap-1.5 disabled:opacity-40"
          >
            {refreshing ? (
              <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <RefreshCw className="w-3 h-3" aria-hidden />
            )}
            Refresh catalog
          </button>
          {refreshBlockedMessage && (
            <p id="catalog-refresh-blocked" className="text-[11px] text-warning-fg mt-1 max-w-xs">
              {refreshBlockedMessage}
            </p>
          )}
          {refreshMessage && (
            <p className="text-[11px] text-muted mt-1" data-testid="catalog-refresh-result">
              {refreshMessage}
            </p>
          )}
        </div>
      </div>

      <div className="mt-2">{live.map(render)}</div>

      {retired.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={onToggleRetired}
            aria-expanded={showRetired}
            data-testid="catalog-show-retired"
            className="text-xs text-secondary hover:text-primary transition-colors"
          >
            {showRetired ? "Hide" : "Show"} {retired.length} retired row{retired.length === 1 ? "" : "s"}
          </button>
          {showRetired && <div className="mt-2 opacity-70">{retired.map(render)}</div>}
        </div>
      )}
    </section>
  );
}
