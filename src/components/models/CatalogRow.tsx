"use client";

/**
 * One catalog row: the model, what it costs, whether it works, and what may be
 * done to it.
 *
 * The catalog is the only place a model's price and probe state can be changed, so
 * every other section of the page sends people here — a 422 on a tier, a disabled
 * option in a select, an unpriced model seen in spans. That makes "why can this
 * not be selected" the question each row has to answer on sight, which is why the
 * price, both probes and the status all sit on the same line rather than behind a
 * detail view.
 */

import { InterimAgeChip, ModelStatusBadge, PriceSourceBadge } from "./badges";
import { rate, rateQuad } from "./format";
import { ProbeCell } from "./ProbeCell";
import { TestMenu } from "./TestMenu";
import { PriceEditor } from "./PriceEditor";
import { adoptBlockedReason } from "./diff";
import type { CatalogRow as CatalogRowData, Price, ProbeMode } from "./types";

const ACTION =
  "text-[11px] px-2 py-1 rounded-lg border border-theme text-secondary hover:text-primary transition-colors";

export function CatalogTableRow({
  row,
  quarantined,
  interimOverdue,
  probesRunning,
  editing,
  onEdit,
  onEditCancel,
  onPrice,
  onAdopt,
  onQuarantine,
  onLiftQuarantine,
  onProbe,
}: {
  row: CatalogRowData;
  quarantined: boolean;
  interimOverdue: boolean;
  probesRunning: Set<string>;
  editing: boolean;
  onEdit: (modelId: string) => void;
  onEditCancel: () => void;
  onPrice: (modelId: string, price: Price) => void;
  onAdopt: (modelId: string) => void;
  onQuarantine: (modelId: string) => void;
  onLiftQuarantine: (modelId: string) => void;
  onProbe: (modelId: string, mode: ProbeMode) => void;
}) {
  const adoptReason = adoptBlockedReason(row);
  const adoptBlockedId = `catalog-adopt-reason-${row.modelId}`;

  return (
    <div
      id={`catalog-row-${row.modelId}`}
      data-testid={`catalog-row-${row.modelId}`}
      className={`py-3 border-b border-theme last:border-0 scroll-mt-24 ${interimOverdue ? "bg-warning-subtle/40" : ""}`}
    >
      <div className="grid md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_auto_auto] items-start gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-xs text-primary font-medium truncate">{row.label}</p>
            <ModelStatusBadge status={quarantined ? "quarantined" : row.status} />
            {row.requiresMantle && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full border bg-info-subtle text-info-fg border-info-fg/30"
                title="Only reachable on Bedrock Mantle, so it is valid for codex and nowhere else."
              >
                mantle only
              </span>
            )}
          </div>
          <p className="text-[10px] text-muted font-mono truncate" title={row.modelId}>
            {row.modelId}
          </p>
          <p className="text-[10px] text-muted">
            {row.vendor}, {row.endpoint}, {row.region}, {(row.contextWindow / 1000).toFixed(0)}k context
          </p>
          {row.aliases.length > 0 && (
            <p className="text-[10px] text-muted font-mono truncate" title={row.aliases.join(", ")}>
              aliases: {row.aliases.join(", ")}
            </p>
          )}
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[11px] tabular-nums ${row.price ? "text-secondary" : "text-danger-fg"}`}>
              {rateQuad(row.price)}
            </span>
            {row.price && <PriceSourceBadge source={row.price.source} />}
            {interimOverdue && row.price?.asOf && <InterimAgeChip asOf={row.price.asOf} />}
          </div>
          {row.price?.asOf && <p className="text-[10px] text-muted">as of {row.price.asOf}</p>}
          {row.priceDrift && (
            <p className="text-[10px] text-warning-fg">
              Published price moved to {rate(row.priceDrift.input)} / {rate(row.priceDrift.output)} per 1M.
            </p>
          )}
        </div>

        <ProbeCell row={row} running={probesRunning} />

        <div className="flex items-center gap-2 justify-end flex-wrap">
          <button type="button" onClick={() => onEdit(row.modelId)} data-testid={`catalog-setprice-${row.modelId}`} className={ACTION}>
            Set price
          </button>
          <TestMenu modelId={row.modelId} onStart={(mode) => onProbe(row.modelId, mode)} />
          {row.status === "candidate" &&
            (adoptReason ? (
              // aria-disabled, not disabled: the button stays focusable so the
              // reason it cannot be used is reachable rather than inferred.
              <button
                type="button"
                aria-disabled="true"
                aria-describedby={adoptBlockedId}
                onClick={(e) => e.preventDefault()}
                data-testid={`catalog-adopt-${row.modelId}`}
                className={`${ACTION} opacity-50 cursor-not-allowed`}
              >
                Adopt
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onAdopt(row.modelId)}
                data-testid={`catalog-adopt-${row.modelId}`}
                className={ACTION}
              >
                Adopt
              </button>
            ))}
          {quarantined ? (
            <button
              type="button"
              onClick={() => onLiftQuarantine(row.modelId)}
              data-testid={`catalog-unquarantine-${row.modelId}`}
              className={ACTION}
            >
              Lift quarantine
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onQuarantine(row.modelId)}
              data-testid={`catalog-quarantine-${row.modelId}`}
              className={ACTION}
            >
              Quarantine
            </button>
          )}
        </div>
      </div>

      {adoptReason && row.status === "candidate" && (
        <p id={adoptBlockedId} className="text-[11px] text-muted mt-1">
          {adoptReason}
        </p>
      )}

      {editing && (
        <PriceEditor
          modelId={row.modelId}
          price={row.price}
          onSave={(price) => onPrice(row.modelId, price)}
          onCancel={onEditCancel}
        />
      )}
    </div>
  );
}
