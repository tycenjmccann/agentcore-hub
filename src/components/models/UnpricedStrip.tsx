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
 *  - It is READ ONLY. The ids come from span attributes, i.e. data the fleet
 *    wrote. Discovery is the ONLY catalog intake (TEAM-5011): there is no route
 *    that adopts an id out of a span, because a span-derived string staged as a
 *    catalog row was TEAM-4994 finding 9's injection origin, and because a
 *    row's endpoint/region/api cannot be derived from a bare id — discovery
 *    reads them from the account sweep instead of guessing. So every row here
 *    is inert text: a valid, discoverable id gets the "press Refresh" hint; a
 *    valid id a sweep will never list (a bare CLI short name, or a bare
 *    foundation-model id) gets told so honestly, since /models can only price
 *    it as an alias on an existing row, which is a manual edit (TEAM-5065); and
 *    one that does not even look like a model id says so instead.
 *
 *  - "Known" means id OR alias (knownModelNames, TEAM-5065): a span naming a
 *    model by its bare CLI name is priced the moment that name is an alias on
 *    some row, so checking ids alone would keep flagging it as missing forever.
 */

import { useEffect, useState } from "react";
import { NAV_ITEMS } from "@/config/modules";
import { isDiscoverableModelId, isValidModelId } from "@/lib/models/model-id";
import { getFleetPerformance } from "./api";
import { knownModelNames, type CatalogRow } from "./types";

/** Whether the Workflow module is part of this build at all. */
const WORKFLOW_PRESENT = NAV_ITEMS.some((i) => i.module === "workflow");

const RECENT_CARDS = 20;

export function UnpricedStrip({ catalog }: { catalog: CatalogRow[] }) {
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

  const known = knownModelNames(catalog);
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
              const discoverable = valid && isDiscoverableModelId(id);
              return (
                <div
                  key={id}
                  data-testid={`unpriced-row-${id}`}
                  className="flex items-center flex-wrap sm:flex-nowrap justify-between gap-3 py-1.5 border-b border-theme last:border-0"
                >
                  <span className="text-[11px] font-mono text-secondary truncate" title={id}>
                    {id}
                  </span>
                  {!valid ? (
                    <span className="text-[11px] text-warning-fg min-w-0 sm:flex-shrink-0">not a valid model id</span>
                  ) : discoverable ? (
                    <span className="text-[11px] text-muted min-w-0 sm:flex-shrink-0 text-right">
                      Not in the catalog. Press Refresh catalog to discover it, then set a price.
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted min-w-0 sm:flex-shrink-0 text-right">
                      Refresh catalog will not find this id — discovery only lists us.* / global.* profiles and
                      openai.* Mantle models. Add it as an alias on the catalog row that serves this model, then save.
                    </span>
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
