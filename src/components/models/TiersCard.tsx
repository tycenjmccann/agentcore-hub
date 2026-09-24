"use client";

/**
 * The named tiers an agent can ask for by hand: `claude_code(model="opus")`,
 * `codex(model="sol")`. The two families are shown one after the other rather
 * than side by side because they are peers — an agent that asks for the opus tier
 * on codex gets sol — and reading them in the same order makes a mismatched pair
 * obvious.
 *
 * The full four-part rate sits on every row (in / out / cache-read / cache-write)
 * because tiers are the lever people reach for to make a run cheaper, and the
 * cache rates are usually the reason one tier costs what it does.
 */

import { InterimAgeChip, PriceSourceBadge } from "./badges";
import { rateQuad } from "./format";
import { ModelSelect, rowFor } from "./ModelSelect";
import type { InvalidReason, RegistryDoc } from "./types";
import { CLAUDE_TIERS, CODEX_TIERS } from "./types";

const TIER_CHIP = "text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-3 border border-theme text-secondary";

function TierRows({
  family,
  tiers,
  draft,
  interimOverdue,
  invalidFields,
  onChange,
}: {
  family: "claude" | "codex";
  tiers: readonly string[];
  draft: RegistryDoc;
  interimOverdue: string[];
  invalidFields: Record<string, { reason: InvalidReason; message: string }>;
  onChange: (family: "claude" | "codex", tier: string, modelId: string) => void;
}) {
  const map = (draft.tiers?.[family] ?? {}) as Record<string, string>;
  return (
    <div className="space-y-3">
      {tiers.map((tier) => {
        const value = map[tier] ?? "";
        const row = rowFor(draft.catalog, value);
        const overdue = interimOverdue.includes(value);
        return (
          <div key={tier} className="grid grid-cols-[auto_minmax(0,1fr)] md:grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3">
            <span className={`${TIER_CHIP} mt-6`}>{tier}</span>
            <ModelSelect
              id={`tier-${family}-${tier}`}
              label={`${family} ${tier}`}
              value={value}
              field={family === "codex" ? "codexTier" : "claudeTier"}
              catalog={draft.catalog}
              quarantine={draft.quarantine ?? []}
              invalidMessage={invalidFields[`tiers.${family}.${tier}`]?.message}
              testId={`tier-select-${family}-${tier}`}
              onChange={(modelId) => onChange(family, tier, modelId)}
            />
            <div className="md:mt-6 flex items-center gap-2 flex-wrap">
              <span className={`text-[11px] tabular-nums ${row?.price ? "text-muted" : "text-danger-fg"}`}>
                {rateQuad(row?.price)}
              </span>
              {row?.price && <PriceSourceBadge source={row.price.source} />}
              {overdue && row?.price?.asOf && <InterimAgeChip asOf={row.price.asOf} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TiersCard({
  draft,
  interimOverdue,
  invalidFields,
  onChange,
}: {
  draft: RegistryDoc;
  interimOverdue: string[];
  invalidFields: Record<string, { reason: InvalidReason; message: string }>;
  onChange: (family: "claude" | "codex", tier: string, modelId: string) => void;
}) {
  return (
    <section className="card" data-testid="tiers-card" aria-labelledby="tiers-heading">
      <h3 id="tiers-heading" className="text-sm font-semibold text-primary">
        Tiers
      </h3>
      <p className="text-xs text-muted mt-1 leading-relaxed">
        Codex tiers are the codex(model=...) peers of the Claude tiers: astra matches fable, sol matches opus, terra
        matches sonnet, luna matches haiku. An agent that asks for the opus tier on codex gets sol.
      </p>

      <div className="mt-4 space-y-5">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted mb-2">Claude</p>
          <TierRows
            family="claude"
            tiers={CLAUDE_TIERS}
            draft={draft}
            interimOverdue={interimOverdue}
            invalidFields={invalidFields}
            onChange={onChange}
          />
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted mb-2">Codex</p>
          <TierRows
            family="codex"
            tiers={CODEX_TIERS}
            draft={draft}
            interimOverdue={interimOverdue}
            invalidFields={invalidFields}
            onChange={onChange}
          />
        </div>
      </div>
    </section>
  );
}
