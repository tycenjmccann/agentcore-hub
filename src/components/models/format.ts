/**
 * Display formatting for the Models page.
 *
 * Every rate on this page is dollars per 1M tokens, and the same three shapes
 * (a rate, a rate pair, a relative timestamp) show up in the selects, the facts
 * lines, the catalog table and the save bar's change list. They live here so a
 * price never renders two different ways on one screen.
 */

import type { CatalogRow, InvalidFieldAction, InvalidFieldUi, InvalidReason, Price, ProbeMode } from "./types";

export type { InvalidFieldAction } from "./types";

/**
 * `$11.00`, and `$0.275` / `$1.375` for the cache rates that must not round to cents.
 *
 * Cents are the right precision for a token rate, except that published cache rates land
 * on the third decimal ($0.022, $0.275, $1.375, $6.875). Rounding those to cents prints
 * two different rates as the same number, so a displayed rate keeps its third decimal
 * whenever it has one — at ANY magnitude, because a displayed rate must equal the stored
 * rate it will bill on. Nothing else grows a trailing zero.
 */
export function rate(usd: number | null | undefined): string {
  if (usd == null || Number.isNaN(usd)) return "-";
  const needsThird = Math.round(usd * 1000) % 10 !== 0;
  return `$${usd.toFixed(needsThird ? 3 : 2)}`;
}

/** `$11.00 / $55.00 per 1M` — input then output, the pair used in option text. */
export function ratePair(price: Price | undefined): string {
  if (!price) return "no price on record";
  return `${rate(price.input)} / ${rate(price.output)} per 1M`;
}

/** `$1.10 / $5.50 / $0.11 / $1.375 per 1M` — in / out / cache-read / cache-write. */
export function rateQuad(price: Price | undefined): string {
  if (!price) return "no price on record";
  return `${rate(price.input)} / ${rate(price.output)} / ${rate(price.cacheReadInput)} / ${rate(price.cacheWrite)} per 1M`;
}

/** `bedrock-runtime, us-east-1, cache-read $0.275, cache-write $13.75 per 1M`. */
export function factsLine(row: CatalogRow): string {
  const parts = [row.endpoint, row.region];
  if (row.price?.cacheReadInput != null) parts.push(`cache-read ${rate(row.price.cacheReadInput)}`);
  if (row.price?.cacheWrite != null) parts.push(`cache-write ${rate(row.price.cacheWrite)} per 1M`);
  return parts.join(", ");
}

/** Option text for every model `<select>` on the page. */
export function optionText(row: CatalogRow): string {
  return `${row.label} - ${ratePair(row.price)}`;
}

/** `4 minutes ago` / `in 2 hours` — coarse, because nothing here is second-sensitive. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "unknown";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.round((now - then) / 1000);
  const future = seconds < 0;
  const abs = Math.abs(seconds);
  const [value, unit] =
    abs < 60 ? [abs, "second"]
    : abs < 3600 ? [Math.round(abs / 60), "minute"]
    : abs < 86400 ? [Math.round(abs / 3600), "hour"]
    : [Math.round(abs / 86400), "day"];
  const plural = `${value} ${unit}${value === 1 ? "" : "s"}`;
  return future ? `in ${plural}` : `${plural} ago`;
}

/** `2026-09-22 14:07 UTC` — the absolute form, used in titles and the prior-version header. */
export function absoluteUtc(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/**
 * The last segment of a model id. Re-exported, not implemented: the compact label
 * sites outside this page (agent cards, the board's phase roll-up) need the same
 * shortening, so it lives in core — see @/lib/model-label.
 */
export { shortModelId } from "@/lib/model-label";

/**
 * The copy for one rejected field in a 422.
 *
 * The server sends a machine reason and the path it belongs to; this turns that
 * into the sentence shown under the control. Each one names the offending model
 * AND the fix, because "invalid" on its own would send the operator hunting
 * through a 13-row catalog to guess which rule they tripped.
 *
 * `aliasCount` is only used by `duplicate_alias`; the page counts the rows
 * claiming the alias in its own draft, and falls back to 2 (the minimum a
 * duplicate can be) if the alias is not in the draft it holds.
 */
export function invalidFieldMessage(reason: InvalidReason, subject: string, aliasCount?: number): string {
  switch (reason) {
    case "unpriced":
      return `${subject} has no published or manual price. Set a price in the catalog, then save again.`;
    case "inactive":
      return `${subject} is not active. Adopt it in the catalog first, then point this at it.`;
    case "quarantined":
      return `${subject} is quarantined. Pick another model, or lift the quarantine in the catalog.`;
    case "unprobed":
      return `${subject} has not been verified yet. Run its two smoke tests (a one-call API check, then a ~2 minute CLI coding turn) from the Test menu on its Catalog row, then pick it here.`;
    case "read_only":
      return `${subject} is a read-only judge model. It is priced for cost math only and cannot be a default, tier or agent model.`;
    case "duplicate_alias":
      return `${subject} is claimed by ${Math.max(aliasCount ?? 2, 2)} catalog rows. Remove the alias from one row before saving.`;
    default:
      return `${subject} was rejected by the server.`;
  }
}

/**
 * The sentence AND the button for one rejected field, from one resolution.
 *
 * They used to be built separately — the sentence at 422 time, the button at
 * render — and could disagree: "run it from the Test menu on its Catalog row" over
 * no button at all (TEAM-5077). Now every call site gets both from here, against the
 * same catalog snapshot, so what the sentence points at is what the button opens.
 *
 * The one rejection an operator can act on from here is `unprobed`. Every other
 * reason is fixed in place or has no single destination, so it keeps its copy from
 * `invalidFieldMessage` and gets no action. For `unprobed`:
 *
 *  - `subject` (a model id or alias) resolves to a row the Catalog table mounts
 *    (not read-only, not retired) → the row action. Its two ids are built from the
 *    row's real `modelId`, never the raw input (TEAM-5070); `catalog-row-<id>` is
 *    owned by CatalogRow.tsx and `catalog-test-<id>` by TestMenu.tsx.
 *  - anything else (unknown id, read-only judge row, retired row, or the path
 *    itself when the draft had nothing there) → the Catalog itself, aimed at its
 *    Refresh. The server decides unknown_model / read_only / retired BEFORE it
 *    ever says unprobed, and only says it about a candidate it can see
 *    (models-registry.ts targetReason) — so no live row HERE means this page's
 *    catalog is stale, and the sentence says so instead of naming a row that is not
 *    on the page. Refresh is disabled while the draft is dirty (and a 422 leaves it
 *    dirty), so the sentence gives the order — discard, refresh, test — and the
 *    focus lands on the button only once it is enabled; the scroll always happens.
 *    `catalog-section` / `catalog-refresh` are owned by CatalogTable.tsx.
 *
 * format.test.ts pins the invariant: the message mentions the Test menu exactly
 * when an action is returned.
 */
export function invalidFieldUi(reason: InvalidReason, subject: string, catalog: readonly CatalogRow[]): InvalidFieldUi {
  if (reason === "duplicate_alias") {
    const claimed = catalog.filter((r) => r.aliases.includes(subject)).length;
    return { message: invalidFieldMessage(reason, subject, claimed), action: null };
  }
  if (reason !== "unprobed") return { message: invalidFieldMessage(reason, subject), action: null };

  const row = catalog.find((r) => r.modelId === subject || r.aliases.includes(subject));
  if (row && !row.readOnly && row.status !== "retired") {
    return {
      message: invalidFieldMessage(reason, subject),
      action: {
        label: "Open its Catalog row",
        targetId: `catalog-row-${row.modelId}`,
        focusTestId: `catalog-test-${row.modelId}`,
      },
    };
  }
  return {
    message: `${subject} has not been verified yet, and this page's catalog has no live row to test it from. Discard your changes, Refresh catalog to pick up its row, then run its two smoke tests (a one-call API check, then a ~2 minute CLI coding turn) from the Test menu on that row.`,
    action: { label: "Open the Catalog", targetId: "catalog-section", focusTestId: "catalog-refresh" },
  };
}

/** The operator-facing name of a probe plane — one source for the Test menu and the announcements. */
export function probeModeLabel(mode: ProbeMode): string {
  return mode === "api" ? "API smoke test" : "CLI smoke test";
}
