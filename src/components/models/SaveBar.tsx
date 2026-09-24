"use client";

/**
 * The page's one commit point. Nothing else writes the registry document, so a
 * visible save bar is the whole answer to "have I changed anything".
 *
 * It renders only when there is something to save, and it sits early in the DOM
 * (fixed to the bottom visually, but reachable by Tab right after the header)
 * because a keyboard user who has just edited a select at the bottom of a 46-row
 * list should not have to traverse the rest of the page to commit.
 *
 * The change list is the honest version of the diff: dotted registry path, old
 * value, new value — the same paths the server speaks in a 422, so what you read
 * here is what the server will name if it objects.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import type { Change } from "./types";

export function SaveBar({
  changes,
  saving,
  onSave,
  onDiscard,
}: {
  changes: Change[];
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (changes.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      data-testid="save-bar"
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-theme bg-surface-2/95 backdrop-blur px-6 py-3 flex items-center justify-between gap-4 transition-transform duration-150 motion-reduce:transition-none motion-reduce:animate-none"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <p className="text-xs text-primary font-medium">
            {changes.length} unsaved change{changes.length === 1 ? "" : "s"}
          </p>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="text-xs text-secondary hover:text-primary inline-flex items-center gap-1 transition-colors"
          >
            {open ? <ChevronDown className="w-3 h-3" aria-hidden /> : <ChevronRight className="w-3 h-3" aria-hidden />}
            Review
          </button>
        </div>
        {open && (
          <ul data-testid="save-changes-list" className="mt-2 max-h-40 overflow-y-auto space-y-0.5">
            {changes.map((c) => (
              <li key={c.path} className="text-[11px] font-mono text-secondary truncate">
                {c.path}: {c.from} -&gt; {c.to}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          type="button"
          onClick={onDiscard}
          disabled={saving}
          data-testid="save-discard"
          className="text-xs px-3 py-1.5 rounded-lg border border-theme text-secondary hover:text-primary transition-colors disabled:opacity-60"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          data-testid="save-button"
          className="text-xs px-4 py-1.5 rounded-lg bg-brand-600 text-white font-medium inline-flex items-center gap-1.5 disabled:opacity-60"
        >
          {saving && <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden />}
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}
