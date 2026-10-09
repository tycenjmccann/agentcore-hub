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

import { isSelectable } from "./diff";
import { optionText, type InvalidFieldAction } from "./format";
import type { CatalogRow, SelectField } from "./types";

const SELECT_CLASSES =
  "w-full px-3 py-2 text-sm rounded-lg bg-surface-2 border text-primary focus:outline-none focus:border-brand-600/50";

// Literal class names so Tailwind's content scan emits them: they are applied via
// classList, which the scanner cannot see through.
const HIGHLIGHT = ["ring-2", "ring-brand-500"];

/**
 * The one in-flight highlight on the page, so a second click can undo the first
 * rather than race it. Module-level, not per instance: the ring is a page-level
 * affordance (one Catalog table, one ring at a time) and any of the ~57 selects on
 * the page may be the one that starts or supersedes it. A per-select handle let a
 * second select's click arm a ring the first select's still-pending timer then
 * stripped, and let an unmounting select strip a ring another select had just put
 * there (TEAM-5077).
 */
interface HighlightHandle {
  el: HTMLElement;
  timer: number;
}
let highlight: HighlightHandle | null = null;

/**
 * True for an element that can actually receive focus right now. `:disabled`
 * catches the Catalog's own Refresh button, which is disabled for exactly the
 * span (an unsaved draft) during which a 422 can point at it (TEAM-5142).
 */
function usable(el: HTMLElement | null): el is HTMLElement {
  return el != null && !el.matches(":disabled");
}

function catalogSection(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="catalog-section"]');
}

/**
 * Scroll to the element that can fix a rejected field and put focus somewhere
 * real. `block: "start"` pairs with the row's `scroll-mt-24`; `preventScroll`
 * stops focus() from fighting the smooth scroll.
 *
 * Focus prefers the named control, falls back to the target itself, and falls
 * back again to the Catalog section — both the row and the section carry
 * `tabIndex={-1}` so they can always take focus even with nothing else usable
 * (TEAM-5142). The two cases that land on the last fallback: the named control
 * is disabled (Refresh, while the draft it would discard is still dirty), or
 * `invalidFieldUi`'s target has since vanished (a poll landed between render and
 * click and absorbed a registry that no longer has the row).
 *
 * The previous call's timer (if any) is cancelled first: a click inside the prior
 * 2s window must own the ring, not have it stripped by a timer it didn't start
 * (TEAM-5070) — whichever select that click came from (TEAM-5077).
 *
 * There is deliberately no unmount cleanup for the timer. It only ever touches the
 * Catalog element it armed, which no select owns: firing on a detached node is a
 * harmless no-op, and firing on a still-mounted row after the select that started
 * it has gone (group collapsed, search narrowed) is exactly the expiry wanted.
 */
function revealTarget(action: InvalidFieldAction) {
  const target = document.getElementById(action.targetId);
  if (!target) {
    const section = catalogSection();
    section?.scrollIntoView({ block: "start", behavior: "smooth" });
    section?.focus({ preventScroll: true });
    return;
  }
  target.scrollIntoView({ block: "start", behavior: "smooth" });
  const control = document.querySelector<HTMLElement>(`[data-testid="${action.focusTestId}"]`);
  const focusable = usable(control) ? control : usable(target) ? target : catalogSection();
  focusable?.focus({ preventScroll: true });

  const prev = highlight;
  if (prev) {
    window.clearTimeout(prev.timer);
    if (prev.el !== target) prev.el.classList.remove(...HIGHLIGHT);
  }
  target.classList.add(...HIGHLIGHT);
  const timer = window.setTimeout(() => {
    target.classList.remove(...HIGHLIGHT);
    // Identity-guarded: a stale callback must never null a newer handle.
    if (highlight?.timer === timer) highlight = null;
  }, 2000);
  highlight = { el: target, timer };
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
              onClick={() => revealTarget(invalidAction)}
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
