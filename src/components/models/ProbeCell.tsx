"use client";

/**
 * A catalog row's two probes. Both have to be green before a candidate can be
 * adopted, so they are shown together and always both — "cli: never run" is the
 * information that explains a disabled Adopt button.
 */

import { ProbeMark } from "./badges";
import type { CatalogRow } from "./types";

export function ProbeCell({ row, running }: { row: CatalogRow; running: Set<string> }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <ProbeMark
        mode="api"
        result={row.probe?.api}
        running={running.has(`${row.modelId}:api`)}
        testId={`catalog-probe-api-${row.modelId}`}
      />
      <ProbeMark
        mode="cli"
        result={row.probe?.cli}
        running={running.has(`${row.modelId}:cli`)}
        testId={`catalog-probe-cli-${row.modelId}`}
      />
    </div>
  );
}
