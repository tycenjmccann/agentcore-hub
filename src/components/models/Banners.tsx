"use client";

/**
 * The three things that can come back from a write and are not a success, each
 * with the one thing to do about it. They live together because they are one
 * screen's worth of markup and because the copy is the point — a save that half
 * worked has to say which half, or an operator will assume cost math is fine when
 * it is running on stale prices.
 *
 * None of them is dismissible-and-forget: the conflict banner's only action
 * reloads, and the pricing banner stays until pricing is re-applied.
 */

import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

/**
 * 409. Someone else saved while this draft was open. The server holds the newer
 * document already, so reloading is a swap, not a second request — and it does
 * cost the unsaved edits, which is why that is stated rather than implied.
 */
export function ConflictBanner({
  serverVersion,
  loadedVersion,
  onReload,
}: {
  serverVersion: number;
  loadedVersion: number;
  onReload: () => void;
}) {
  return (
    <div role="alert" data-testid="conflict-banner" className="card border-danger-subtle">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 text-danger-fg flex-shrink-0 mt-0.5" aria-hidden />
        <div className="min-w-0">
          <p className="text-xs text-danger-fg leading-relaxed">
            This document changed while you were editing. The server is on version {serverVersion}, you loaded version{" "}
            {loadedVersion}. Reload to get the latest; your unsaved edits will be lost.
          </p>
          <button
            type="button"
            onClick={onReload}
            data-testid="conflict-reload"
            className="mt-2 text-xs px-3 py-1.5 rounded-lg border border-theme text-secondary hover:text-primary transition-colors"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 207. The registry landed but the pricing projection did not, so every dollar
 * figure downstream is still computed from the previous prices. Saved-but-wrong is
 * worse than not saved, so this one names the version AND what is stale.
 */
export function PricingFailedBanner({
  version,
  error,
  busy,
  onReapply,
}: {
  version: number;
  error: string;
  busy?: boolean;
  onReapply: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="pricing-failed-banner"
      className="rounded-xl border px-4 py-3 bg-warning-subtle border-warning-fg/30 text-warning-fg"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden />
        <div className="min-w-0">
          <p className="text-xs leading-relaxed">
            Registry saved as version {version}, but the pricing projection failed: {error}. Cost math is using the
            previous prices until you re-apply.
          </p>
          <button
            type="button"
            onClick={onReapply}
            disabled={busy}
            data-testid="pricing-reapply"
            className="mt-2 text-xs px-3 py-1.5 rounded-lg border border-warning-fg/30 inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <RefreshCw className="w-3 h-3" aria-hidden />
            )}
            Re-apply pricing
          </button>
        </div>
      </div>
    </div>
  );
}

/** Everything else that failed outright: 400, 403, 503, a dead network, a refusal. */
export function AlertBanner({ message, testId }: { message: string; testId?: string }) {
  return (
    <div role="alert" data-testid={testId ?? "models-alert"} className="card border-danger-subtle">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 text-danger-fg flex-shrink-0 mt-0.5" aria-hidden />
        <p className="text-xs text-danger-fg leading-relaxed">{message}</p>
      </div>
    </div>
  );
}

/**
 * The copy for a failed write, keyed on status. Kept next to the banner that
 * shows it so there is one place to read what the page says when a save fails.
 *
 * `status: 0` is a request that never reached the server; it gets the 503 wording
 * because the operator's situation is identical — nothing was written, the draft
 * is intact, press Save again.
 */
export function writeErrorMessage(status: number, error?: string): string {
  if (status === 400) return "The page sent something the server could not read. Reload and try again.";
  if (status === 403) return "You need admin rights to change the model registry.";
  if (status === 503 || status === 0) {
    return `The save did not reach S3 (${error || "no response"}). Your changes are still here; press Save to retry.`;
  }
  return `The save failed with status ${status}${error ? ` (${error})` : ""}. Your changes are still here; press Save to retry.`;
}
