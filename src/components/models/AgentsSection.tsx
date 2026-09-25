"use client";

/**
 * All 46 deployables, grouped by where they sit in the pipeline.
 *
 * 46 selects on one screen is unreadable, so the groups collapse — but the
 * grouping is not just tidiness: the pinned group at the top holds every row that
 * can actually be wrong (the harnesses and the intake Lambda), and the rest are
 * runtimes that always read the registry fresh. Collapse state is owned by the
 * page so a `/models#agent-<id>` deep link can open the right group before
 * scrolling to the row.
 *
 * Search matches name, id and the model each row resolves to, because "which
 * agents are still on sonnet" is the question this list gets asked most.
 */

import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { AgentRow, agentRowStatus } from "./AgentRow";
import type { Deployable, GroupName, InvalidFields, RegistryDoc, ResolvedModel } from "./types";
import { DEPLOYABLES, GROUP_ORDER, groupFor } from "./types";

/** Which registry field a row falls back to when it has no override. */
const INHERIT_PATH = "defaults.persona";

export function groupSlug(group: string): string {
  return group.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function matches(d: Deployable, effectiveModel: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    d.displayName.toLowerCase().includes(q) ||
    d.agentId.toLowerCase().includes(q) ||
    effectiveModel.toLowerCase().includes(q)
  );
}

export function AgentsSection({
  draft,
  resolved,
  query,
  expanded,
  invalidFields,
  applying,
  failures,
  reapplying,
  onQueryChange,
  onToggleGroup,
  onChange,
  onReapply,
  onResetAll,
}: {
  draft: RegistryDoc;
  resolved: Record<string, ResolvedModel>;
  query: string;
  expanded: Record<string, boolean>;
  invalidFields: InvalidFields;
  applying: Set<string>;
  failures: Record<string, string>;
  reapplying: Set<string>;
  onQueryChange: (q: string) => void;
  onToggleGroup: (group: string) => void;
  onChange: (agentId: string, modelId: string) => void;
  onReapply: (agentId: string) => void;
  onResetAll: () => void;
}) {
  const overrides = draft.agents ?? {};
  const overrideCount = Object.keys(overrides).length;
  const inheritedModelId = draft.defaults?.persona ?? "";

  const visible = DEPLOYABLES.filter((d) => {
    const effective = overrides[d.agentId] || resolved[d.agentId]?.modelId || inheritedModelId;
    return matches(d, effective, query);
  });

  const byGroup = new Map<GroupName, Deployable[]>();
  for (const d of visible) {
    const group = groupFor(d);
    const list = byGroup.get(group);
    if (list) list.push(d);
    else byGroup.set(group, [d]);
  }

  return (
    <section className="card" data-testid="agents-section" aria-labelledby="agents-heading">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 id="agents-heading" className="text-sm font-semibold text-primary">
            Deployables
          </h3>
          <p className="text-xs text-muted mt-1">
            <span data-testid="agents-overrides-count">
              {overrideCount} override{overrideCount === 1 ? "" : "s"}
            </span>
            . Everything else inherits {INHERIT_PATH}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-muted absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden />
            <label htmlFor="agents-search" className="sr-only">
              Filter deployables
            </label>
            <input
              id="agents-search"
              type="search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder={`Filter ${DEPLOYABLES.length} deployables by name, id or model...`}
              data-testid="agents-search"
              className="w-72 pl-8 pr-3 py-1.5 text-xs rounded-lg bg-surface-2 border border-theme text-primary placeholder-muted focus:outline-none focus:border-brand-600/50"
            />
          </div>
          <button
            type="button"
            onClick={onResetAll}
            disabled={overrideCount === 0}
            data-testid="agents-reset-all"
            className="text-xs px-3 py-1.5 rounded-lg border border-theme text-secondary hover:text-primary transition-colors disabled:opacity-40"
          >
            Reset all to inherit
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="text-xs text-muted mt-6">No deployable matches &quot;{query.trim()}&quot;.</p>
      ) : (
        <div className="mt-4 space-y-2">
          {GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => {
            const rows = byGroup.get(group)!;
            // A search that narrows to a handful of rows should show them, not ask
            // for another click per group.
            const open = expanded[group] ?? Boolean(query.trim());
            return (
              <div key={group} className="border border-theme rounded-lg">
                <button
                  type="button"
                  onClick={() => onToggleGroup(group)}
                  aria-expanded={open}
                  data-testid={`agents-group-${groupSlug(group)}`}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
                >
                  <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
                    {open ? <ChevronDown className="w-3 h-3" aria-hidden /> : <ChevronRight className="w-3 h-3" aria-hidden />}
                    {group}
                  </span>
                  <span className="text-[10px] text-muted">{rows.length}</span>
                </button>
                {open && (
                  <div className="px-3 pb-2">
                    {rows.map((d) => {
                      const invalid = invalidFields[`agents.${d.agentId}`];
                      return (
                        <AgentRow
                          key={d.agentId}
                          deployable={d}
                          override={overrides[d.agentId] ?? ""}
                          resolved={resolved[d.agentId]}
                          inheritedModelId={inheritedModelId}
                          inheritedPath={INHERIT_PATH}
                          catalog={draft.catalog}
                          quarantine={draft.quarantine ?? []}
                          invalidMessage={invalid?.message}
                          invalidAction={invalid?.action}
                          rowStatus={agentRowStatus(
                            d,
                            resolved[d.agentId],
                            applying.has(d.agentId),
                            failures[d.agentId],
                          )}
                          reapplying={reapplying.has(d.agentId)}
                          onChange={onChange}
                          onReapply={onReapply}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
