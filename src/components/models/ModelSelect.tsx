"use client";

/**
 * The one model `<select>`. Every place on this page where a model is chosen — the
 * three defaults, the eight tiers, the 46 deployables — renders this, so the rules
 * about what may be offered and how a rejected field looks cannot diverge between
 * them.
 *
 * Two behaviours worth keeping:
 *
 *  - The current value is always present as an option, even when it is not
 *    offerable any more. A model that was retired or lost its price under a live
 *    registry must still be VISIBLE as what this field points at — silently
 *    re-selecting the first legal option would change the registry without anyone
 *    asking. The stale option is rendered disabled, so it can be read but not
 *    re-picked.
 *  - A field the server rejected carries `aria-invalid` plus a real sentence
 *    underneath, wired by `aria-describedby`. Colour alone would not survive a
 *    screen reader, and "invalid" alone would not tell anyone which rule fired.
 */

import { useEffect, useRef, type MutableRefObject } from "react";
import { isSelectable } from "./diff";
import { optionText, type InvalidFieldAction } from "./format";
import type { CatalogRow, SelectField } from "./types";

const SELECT_CLASSES =
  "w-full px-3 py-2 text-sm rounded-lg bg-surface-2 border text-primary focus:outline-none focus:border-brand-600/50";

// Literal class names so Tailwind's content scan emits them: they are applied via
// classList, which the scanner cannot see through.
const HIGHLIGHT = ["ring-2", "ring-brand-500"];

/** The one in-flight highlight, so a second click can undo the first rather than race it. */
interface HighlightHandle {
  el: HTMLElement;
  timer: number;
}

/**
 * Scroll to the row that can fix a rejected field and put focus on its control.
 * `block: "start"` pairs with the row's `scroll-mt-24`; `preventScroll` stops
 * focus() from fighting the smooth scroll. The fallback focus on the row itself is
 * a no-op for a div with no tabindex, but the scroll has still happened.
 *
 * `highlight` carries the PREVIOUS call's timer (if any): a click inside the prior
 * 2s window has to cancel that timer, not let it strip the ring out from under a
 * highlight it didn't start (TEAM-5070).
 *
 * `invalidFieldAction` only ever names a row the Catalog table actually mounts, so
 * `target` missing here should not happen — but a click must never be a silent
 * no-op (that IS finding 3), so if the draft has moved on since the button
 * rendered (a poll landing between render and click), this still takes the
 * operator somewhere real instead of doing nothing.
 */
function revealTarget(action: InvalidFieldAction, highlight: MutableRefObject<HighlightHandle | null>) {
  const target = document.getElementById(action.targetId);
  if (!target) {
    document.querySelector<HTMLElement>('[data-testid="catalog-section"]')?.scrollIntoView({
      block: "start",
      behavior: "smooth",
    });
    return;
  }
  target.scrollIntoView({ block: "start", behavior: "smooth" });
  const focusable = document.querySelector<HTMLElement>(`[data-testid="${action.focusTestId}"]`) ?? target;
  focusable.focus({ preventScroll: true });

  const prev = highlight.current;
  if (prev) {
    window.clearTimeout(prev.timer);
    if (prev.el !== target) prev.el.classList.remove(...HIGHLIGHT);
  }
  target.classList.add(...HIGHLIGHT);
  const timer = window.setTimeout(() => {
    target.classList.remove(...HIGHLIGHT);
    highlight.current = null;
  }, 2000);
  highlight.current = { el: target, timer };
}

/** The catalog row a value points at, if the catalog still has one. */
export function rowFor(catalog: CatalogRow[], modelId: string): CatalogRow | undefined {
  return catalog.find((r) => r.modelId === modelId);
}

export function ModelSelect({
  id,
  label,
  value,
  field,
  catalog,
  quarantine,
  invalidMessage,
  invalidAction,
  inheritLabel,
  disabled,
  testId,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  field: SelectField;
  catalog: CatalogRow[];
  quarantine: string[];
  /** Set when the server rejected this exact field in a 422. */
  invalidMessage?: string;
  /** A one-click route to where the rejection can be fixed, shown under the message. */
  invalidAction?: InvalidFieldAction | null;
  /** When set, an empty value is offered under this label (the per-agent rows). */
  inheritLabel?: string;
  disabled?: boolean;
  testId: string;
  onChange: (modelId: string) => void;
}) {
  const options = catalog.filter((r) => isSelectable(r, field, quarantine));
  const current = value ? rowFor(catalog, value) : undefined;
  const staleCurrent = Boolean(value) && !options.some((r) => r.modelId === value);
  const errorId = `${id}-error`;

  const highlight = useRef<HighlightHandle | null>(null);
  // A row highlighted then abandoned mid-2s (the operator navigates away) must not
  // keep a timer alive to poke a DOM node this component no longer owns. Reading
  // `highlight.current` inside the cleanup itself is deliberate — it has to see
  // whatever the LATEST click left behind, not a value captured at mount.
  useEffect(() => {
    return () => {
      const h = highlight.current; // eslint-disable-line react-hooks/exhaustive-deps
      if (!h) return;
      window.clearTimeout(h.timer);
      h.el.classList.remove(...HIGHLIGHT);
    };
  }, []);

  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-[11px] text-muted mb-1">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        aria-invalid={invalidMessage ? "true" : undefined}
        aria-describedby={invalidMessage ? errorId : undefined}
        className={`${SELECT_CLASSES} ${invalidMessage ? "border-danger-fg/50" : "border-theme"} disabled:opacity-60`}
      >
        {inheritLabel && <option value="">{inheritLabel}</option>}
        {staleCurrent && (
          // Present so the field reads truthfully, disabled so it cannot be re-chosen.
          <option value={value} disabled>
            {current ? `${current.label} - ${current.status}` : value} (not selectable)
          </option>
        )}
        {options.map((row) => (
          <option key={row.modelId} value={row.modelId}>
            {optionText(row)}
          </option>
        ))}
      </select>
      {invalidMessage && (
        <div className="mt-1">
          {/* role=alert and aria-describedby stay on the sentence alone, so the
              select's description does not swallow the button's label. */}
          <p id={errorId} role="alert" className="text-[11px] text-danger-fg leading-relaxed">
            {invalidMessage}
          </p>
          {invalidAction && (
            <button
              type="button"
              onClick={() => revealTarget(invalidAction, highlight)}
              data-testid={`${id}-error-action`}
              data-target={invalidAction.targetId}
              className="mt-1 text-[11px] underline text-secondary hover:text-primary transition-colors"
            >
              {invalidAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
