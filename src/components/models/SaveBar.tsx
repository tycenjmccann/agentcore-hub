"use client";

/**
 * The page's one commit point. Nothing else writes the registry document, so a
 * visible save bar is the whole answer to "have I changed anything".
 *
 * It renders only when there is something to save, and it sits early in the DOM
 * (fixed to the bottom visually, but reachable by Tab right after the header)
 * so a keyboard or screen-reader user tabbing forward from page load reaches
 * Save/Discard before wading through 46 deployable rows and the catalog table,
 * not after. That early DOM position rules out `sticky`: sticky only holds an
 * element at the viewport edge while the page scrolls through content BELOW it
 * in the DOM, and this bar sits above almost everything — a sticky version
 * would scroll away with the header instead of staying visible while editing
 * further down the page.
 *
 * `fixed`, therefore — but the app's sidebar is ALSO viewport-fixed
 * (`Sidebar.tsx`, `z-50`, `md:w-64` / collapsed `md:w-16`) and painted on top of
 * anything spanning the full viewport width, so a plain `left-0 right-0` bar
 * renders its left portion (the change count, the Review toggle) behind the
 * sidebar rather than merely near it — a hit-test at that point returns the
 * sidebar, not the bar. The fix mirrors `MainContent.tsx`'s own offset for the
 * same rail (`ml-0 md:ml-64`, collapsed `md:ml-16`) via the same `useSidebar()`
 * state, so the bar's left edge tracks the content column through the collapse
 * transition and the mobile off-canvas breakpoint with no separate source of
 * truth for the sidebar's width.
 *
 * The change list is the honest version of the diff: dotted registry path, old
 * value, new value — the same paths the server speaks in a 422, so what you read
 * here is what the server will name if it objects.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useSidebar } from "@/components/layout/sidebar/SidebarContext";
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
  const { isCollapsed } = useSidebar();
  if (changes.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      data-testid="save-bar"
      className={`fixed bottom-0 right-0 left-0 ${isCollapsed ? "md:left-16" : "md:left-64"} z-40 border-t border-theme bg-surface-2/95 backdrop-blur px-6 py-3 flex items-center justify-between gap-4 transition-[transform,left] duration-150 motion-reduce:transition-none motion-reduce:animate-none`}
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
