"use client";

import type { EvalWindow } from "./types";
import { EVAL_WINDOWS, windowButtonLabel } from "./window";

/**
 * 7 / 30 / 90 / All segmented control. The caller owns the URL (`?days=`); this
 * only reports the click.
 */
export default function WindowSelector({
  value,
  onChange,
}: {
  value: EvalWindow;
  onChange: (w: EvalWindow) => void;
}) {
  return (
    <div
      data-testid="eval-window-selector"
      role="group"
      aria-label="Evaluation window"
      className="flex rounded-lg overflow-hidden border border-surface-4 text-xs"
    >
      {EVAL_WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          data-testid={`eval-window-${w}`}
          aria-pressed={value === w}
          onClick={() => onChange(w)}
          className={`px-2.5 py-1.5 transition-colors ${
            value === w
              ? "bg-brand-600/30 text-brand-400 font-semibold"
              : "bg-surface-2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          }`}
        >
          {windowButtonLabel(w)}
        </button>
      ))}
    </div>
  );
}
