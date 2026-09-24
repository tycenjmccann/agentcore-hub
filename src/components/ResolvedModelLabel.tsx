"use client";

/**
 * "Which model does this run?" rendered in one place.
 *
 * Three render sites used to print a hand-maintained string from agents.json; they
 * now all print this, so there is exactly one answer and one way of showing it.
 *
 * The short label is what is readable in a table cell; the full model id is the
 * title, because that is what someone comparing against a log or a span needs. A
 * violet dot marks an agent whose model is an OVERRIDE rather than the persona
 * default — the thing worth noticing when scanning a fleet, since an override is a
 * deliberate exception somebody has to keep justifying.
 *
 * Every non-answer renders as a dash: loading, a failed registry read, and an agent
 * the registry has never heard of. A dash is honest; a blank cell looks like a
 * layout bug and a bare id looks like an answer.
 */

import { useModelsRegistry } from "@/lib/models-registry-client";

/** The one non-answer, so all three cases look identical. */
function Dash() {
  return <span className="text-muted">-</span>;
}

export function ResolvedModelLabel({ agentId, className = "" }: { agentId: string; className?: string }) {
  const { resolve, loading, error } = useModelsRegistry();

  if (loading || error) return <Dash />;

  const model = resolve(agentId);
  if (model.unknown || !model.shortLabel) return <Dash />;

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} title={model.modelId}>
      <span className="truncate">{model.shortLabel}</span>
      {!model.inherited && (
        <span
          className="w-1.5 h-1.5 rounded-full bg-violet-fg flex-shrink-0"
          title="Override set in the model registry"
          aria-label="Override set in the model registry"
        />
      )}
    </span>
  );
}
