"use client";

/**
 * The judge models — read-only here, on purpose.
 *
 * An evaluation score is only comparable to the scores before it if the judge has
 * not moved. So judges are pinned at deploy time in the eval configs, and this
 * card exists to say that out loud where someone looking for "the place models are
 * changed" will find it. It has no `<select>` by design: there is nothing to
 * choose, and a disabled dropdown would imply the pin is a UI restriction rather
 * than a correctness one.
 *
 * They are still priced and still listed, because judge invocations cost real money
 * and land in the same cost math as everything else.
 */

import { PriceSourceBadge } from "./badges";
import { rateQuad } from "./format";
import type { RegistryDoc } from "./types";
import { JUDGE_PIN_FILES } from "./types";

export function JudgesCard({ draft }: { draft: RegistryDoc }) {
  const judges = draft.catalog.filter((r) => r.readOnly);

  return (
    <section className="card" data-testid="judges-card" aria-labelledby="judges-heading">
      <h3 id="judges-heading" className="text-sm font-semibold text-primary">
        Judges
      </h3>
      <p className="text-xs text-muted mt-1 leading-relaxed">
        Judges are pinned in eval configs, not in this registry (DD8). Moving a judge model breaks score comparability
        across history, so it is a deploy-time edit in deploy/evaluations applied by setup-evaluations.sh. The model is
        listed here priced, because judge invocations still cost money and still land in cost math.
      </p>

      <ul className="mt-3 space-y-1">
        {JUDGE_PIN_FILES.map((file) => (
          <li key={file} className="text-[11px] font-mono text-muted">
            {file}
          </li>
        ))}
      </ul>

      <div className="mt-3">
        {judges.length === 0 ? (
          <p className="text-xs text-muted">No read-only judge model in the catalog.</p>
        ) : (
          judges.map((row) => (
            <div
              key={row.modelId}
              data-testid={`judge-row-${row.modelId}`}
              className="py-2 border-b border-theme last:border-0 flex items-start justify-between gap-3 flex-wrap"
            >
              <div className="min-w-0">
                <p className="text-xs text-primary font-medium truncate">{row.label}</p>
                <p className="text-[10px] text-muted font-mono truncate">{row.modelId}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] tabular-nums text-secondary">{rateQuad(row.price)}</span>
                {row.price && <PriceSourceBadge source={row.price.source} />}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
