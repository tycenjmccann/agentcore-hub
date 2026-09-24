"use client";

/**
 * One deployable. Answers three questions in one line: what it is going to run,
 * how it got that (an override of its own, or inheritance), and whether that is
 * actually true of the live thing right now.
 *
 * The third question is the one that matters and the one nothing else in the
 * console answers. A harness holds a PINNED model, so the registry saying fable
 * and the harness running sonnet is a real, invisible-until-now state; `drift`
 * names it and says both models in the tooltip. A runtime reads the registry at
 * the start of every run, so it cannot drift and has nothing to re-apply — which
 * is why the pill explains itself instead of offering a button that would do
 * nothing.
 */

import { Loader2, RefreshCw } from "lucide-react";
import { ApplyStatusPill, TypeChip } from "./badges";
import { harnessDrift, shortModelId } from "./format";
import { ModelSelect } from "./ModelSelect";
import type { ApplyStatus, CatalogRow, Deployable, ResolvedModel } from "./types";

export interface AgentRowStatus {
  status: ApplyStatus;
  title?: string;
  /** Whether a re-apply is a meaningful action for this row at all. */
  reapplyable: boolean;
}

/**
 * What the row's pill says.
 *
 * `applying` is client knowledge (a save or a re-apply just returned that status
 * and the poll has not settled it yet); `drift` and `failed` come from the server.
 * Anything with no pinned model to compare is `live`, with the reason in the
 * tooltip. `personal_assistant_agent` is reported like any other harness — it can
 * drift the same way the other three can — it is just never `reapplyable`,
 * because it has no apply path to re-pin it with.
 */
export function agentRowStatus(
  d: Deployable,
  resolved: ResolvedModel | undefined,
  applying: boolean,
  failure?: string,
): AgentRowStatus {
  if (failure) return { status: "failed", title: failure, reapplyable: true };
  if (applying) return { status: "applying", title: "Waiting for the harness to report the new model.", reapplyable: false };

  if (d.type === "runtime") {
    return {
      status: "live",
      title: "Runtime agents read the registry at the start of every run, so there is nothing to re-apply.",
      reapplyable: false,
    };
  }
  const harnessModel = resolved?.harnessModel;
  const drifted = harnessDrift(resolved);

  if (d.agentId === "personal_assistant_agent") {
    if (drifted) {
      return {
        status: "drift",
        title: `Harness runs ${drifted}; registry resolves ${resolved!.modelId} - not managed by the registry apply path.`,
        reapplyable: false,
      };
    }
    return {
      status: "live",
      title: harnessModel ? `Running ${harnessModel}. Not managed by the registry apply path.` : "Not managed by the registry apply path.",
      reapplyable: false,
    };
  }
  if (drifted) {
    return { status: "drift", title: `Running ${drifted}, registry says ${resolved!.modelId}.`, reapplyable: true };
  }
  return { status: "live", title: harnessModel ? `Running ${harnessModel}.` : undefined, reapplyable: Boolean(harnessModel) };
}

export function AgentRow({
  deployable,
  override,
  resolved,
  inheritedModelId,
  inheritedPath,
  catalog,
  quarantine,
  invalidMessage,
  rowStatus,
  reapplying,
  onChange,
  onReapply,
}: {
  deployable: Deployable;
  /** The draft's per-agent override, or "" when this row inherits. */
  override: string;
  resolved: ResolvedModel | undefined;
  /** What this row falls back to with no override of its own. */
  inheritedModelId: string;
  inheritedPath: string;
  catalog: CatalogRow[];
  quarantine: string[];
  invalidMessage?: string;
  rowStatus: AgentRowStatus;
  reapplying: boolean;
  onChange: (agentId: string, modelId: string) => void;
  onReapply: (agentId: string) => void;
}) {
  const { agentId, displayName, type } = deployable;
  const inheritedRow = catalog.find((r) => r.modelId === inheritedModelId);
  const inheritedLabel = inheritedRow?.label || shortModelId(inheritedModelId) || "nothing";
  const source = override ? "override" : (resolved?.source ?? "defaults");

  // Only meaningful once the pill has already called it `drift`: what the select
  // says is a plan, not a fact, when the harness is actually running something else.
  const liveHarness = rowStatus.status === "drift" ? harnessDrift(resolved) : undefined;
  const liveHarnessLabel = liveHarness
    ? catalog.find((r) => r.modelId === liveHarness)?.label || shortModelId(liveHarness)
    : "";

  return (
    <div
      id={`agent-${agentId}`}
      data-testid={`agent-row-${agentId}`}
      className="grid grid-cols-[1fr_auto] md:grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 py-2 border-b border-theme last:border-0 scroll-mt-24"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-xs text-primary font-medium truncate">{displayName}</p>
          <TypeChip type={type} />
        </div>
        <p className="text-[10px] text-muted font-mono truncate">{agentId}</p>
        <p className="text-[10px] text-muted" data-testid={`agent-source-${agentId}`}>
          via {source}
        </p>
      </div>

      <div className="min-w-0 md:w-72">
        <ModelSelect
          id={`agent-${agentId}-select`}
          label={`${displayName} model`}
          value={override}
          field="agent"
          catalog={catalog}
          quarantine={quarantine}
          invalidMessage={invalidMessage}
          inheritLabel={`Inherit (${inheritedPath} -> ${inheritedLabel})`}
          testId={`agent-select-${agentId}`}
          onChange={(modelId) => onChange(agentId, modelId)}
        />
        {liveHarness && (
          <p
            className="text-[10px] text-warning-fg truncate mt-0.5"
            title={liveHarness}
            data-testid={`agent-harness-model-${agentId}`}
          >
            harness runs {liveHarnessLabel} ({liveHarness})
          </p>
        )}
      </div>

      <ApplyStatusPill status={rowStatus.status} title={rowStatus.title} testId={`agent-status-${agentId}`} />

      <div className="flex items-center justify-end">
        {rowStatus.reapplyable ? (
          <button
            type="button"
            onClick={() => onReapply(agentId)}
            disabled={reapplying}
            data-testid={`agent-reapply-${agentId}`}
            className="text-[11px] px-2 py-1 rounded-lg border border-theme text-secondary hover:text-primary transition-colors inline-flex items-center gap-1 disabled:opacity-60"
          >
            {reapplying ? (
              <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <RefreshCw className="w-3 h-3" aria-hidden />
            )}
            Re-apply
          </button>
        ) : (
          // The reason lives on the pill's tooltip; an aria-disabled button here
          // would promise an action that does not exist for this kind of row.
          <span className="text-[11px] text-muted">-</span>
        )}
      </div>
    </div>
  );
}
