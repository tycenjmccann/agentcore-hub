"use client";

/**
 * Models the fleet actually invoked that the cost report could not price.
 *
 * This is the page's one piece of outside evidence: everything else here is the
 * registry describing itself, while this is spans describing what really ran. An
 * unpriced model does not fail anything — it silently drops out of cost math, so a
 * run looks cheaper than it was. That gap is invisible until something goes
 * looking for it, which is what this strip does.
 *
 * Two constraints shape it:
 *
 *  - It reads the Workflow module's route by URL STRING and types the response
 *    locally (in api.ts), and it renders nothing at all when that module is not
 *    part of this deployment. Core may not import an optional module, and the
 *    module check is a module-scope constant so it reflects the build.
 *  - The ids come from span attributes, i.e. data the fleet wrote. Offering "Add
 *    to catalog" on an arbitrary string would turn telemetry into a write, so an
 *    id that does not look like a model id is rendered as inert text with a reason
 *    and no button (TEAM-4994 finding 9).
 */

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { NAV_ITEMS } from "@/config/modules";
import { getFleetPerformance } from "./api";
import { isValidModelId } from "./types";

/** Whether the Workflow module is part of this build at all. */
const WORKFLOW_PRESENT = NAV_ITEMS.some((i) => i.module === "workflow");

const RECENT_CARDS = 20;

export function UnpricedStrip({
  knownModelIds,
  adding,
  onAdd,
}: {
  knownModelIds: string[];
  adding: Set<string>;
  onAdd: (modelId: string) => void;
}) {
  const [unpriced, setUnpriced] = useState<string[] | null>(null);

  useEffect(() => {
    if (!WORKFLOW_PRESENT) return;
    let alive = true;
    getFleetPerformance().then(({ status, body }) => {
      if (!alive) return;
      if (status !== 200 || !body?.runs) {
        setUnpriced([]);
        return;
      }
      const recent = [...body.runs]
        .filter((r) => r.completedAt)
        .sort((a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!))
        .slice(0, RECENT_CARDS);
      const seen = new Set<string>();
      for (const run of recent) {
        for (const id of run.cost?.unpricedModels ?? []) seen.add(id);
      }
      setUnpriced([...seen].sort());
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!WORKFLOW_PRESENT) return null;

  const known = new Set(knownModelIds);
  const missing = (unpriced ?? []).filter((id) => !known.has(id));

  return (
    <section className="card" data-testid="unpriced-strip" aria-labelledby="unpriced-heading">
      {unpriced === null ? (
        <p className="text-xs text-muted">Checking the last {RECENT_CARDS} runs for unpriced models...</p>
      ) : missing.length === 0 ? (
        <p className="text-xs text-muted" id="unpriced-heading">
          All models seen in the last {RECENT_CARDS} cards are priced.
        </p>
      ) : (
        <>
          <h3 id="unpriced-heading" className="text-sm font-semibold text-primary">
            {missing.length} unpriced model{missing.length === 1 ? "" : "s"} seen in spans
          </h3>
          <p className="text-xs text-muted mt-1">
            These ran in the last {RECENT_CARDS} cards and contributed no cost, so those runs read cheaper than they
            were.
          </p>
          <div className="mt-3 space-y-1">
            {missing.map((id) => {
              const valid = isValidModelId(id);
              return (
                <div
                  key={id}
                  data-testid={`unpriced-row-${id}`}
                  className="flex items-center justify-between gap-3 py-1.5 border-b border-theme last:border-0"
                >
                  <span className="text-[11px] font-mono text-secondary truncate" title={id}>
                    {id}
                  </span>
                  {valid ? (
                    <button
                      type="button"
                      onClick={() => onAdd(id)}
                      disabled={adding.has(id)}
                      data-testid={`unpriced-add-${id}`}
                      className="text-[11px] px-2 py-1 rounded-lg border border-theme text-secondary hover:text-primary transition-colors inline-flex items-center gap-1 disabled:opacity-40 flex-shrink-0"
                    >
                      <Plus className="w-3 h-3" aria-hidden />
                      Add to catalog
                    </button>
                  ) : (
                    <span className="text-[11px] text-warning-fg flex-shrink-0">not a valid model id</span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
