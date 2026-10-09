"use client";

/**
 * The way back. Every save writes a new version and keeps the one before it, so a
 * change that turns out to be wrong is one click to undo — which is what makes the
 * rest of this page safe to touch.
 *
 * Rollback is not a revert: it writes the old content FORWARD as a new version, so
 * history stays append-only and nobody has to reason about a document that went
 * backwards. The confirmation says that in those terms, and also says that prices
 * and smoke test results come back with it, because those are the parts people
 * forget are in the same document.
 *
 * The GET does not return the previous document's contents today, only its version
 * and timestamp — so there is a slot for a diff, rendered only if the API ever
 * starts sending one, and no fake diff in the meantime.
 */

import { Undo2 } from "lucide-react";
import { diffRegistry } from "./diff";
import { absoluteUtc } from "./format";
import type { RegistryDoc } from "./types";

/** The confirmation copy, exported so the page's one dialog can render it. */
export function rollbackConfirmBody(toVersion: number, currentVersion: number): string {
  return `Roll back to v${toVersion}? This writes v${toVersion}'s content as version ${currentVersion + 1}. Catalog prices and smoke test results from v${currentVersion} are rolled back too.`;
}

export function PriorVersionPanel({
  previous,
  currentVersion,
  previousRegistry,
  serverDoc,
  onRequestRollback,
}: {
  previous: { version: number; updatedAt: string } | null;
  currentVersion: number;
  previousRegistry?: RegistryDoc;
  serverDoc: RegistryDoc;
  onRequestRollback: (toVersion: number) => void;
}) {
  return (
    <section className="card" data-testid="prior-version-panel" aria-labelledby="prior-version-heading">
      {!previous ? (
        <p className="text-xs text-muted" id="prior-version-heading">
          No previous version on record yet.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <h3 id="prior-version-heading" className="text-sm font-semibold text-primary">
              Previous version (v{previous.version}, saved {absoluteUtc(previous.updatedAt)})
            </h3>
            <button
              type="button"
              onClick={() => onRequestRollback(previous.version)}
              data-testid="rollback-button"
              className="text-xs px-3 py-1.5 rounded-lg border border-theme text-secondary hover:text-primary transition-colors inline-flex items-center gap-1.5"
            >
              <Undo2 className="w-3 h-3" aria-hidden />
              Roll back to v{previous.version}
            </button>
          </div>
          <p className="text-xs text-muted mt-1">
            Rolling back writes v{previous.version}&apos;s content as version {currentVersion + 1}.
          </p>
          {previousRegistry && (
            <ul className="mt-3 space-y-0.5" data-testid="prior-version-diff">
              {diffRegistry(previousRegistry, serverDoc).map((c) => (
                <li key={c.path} className="text-[11px] font-mono text-secondary truncate">
                  {c.path}: {c.from} -&gt; {c.to}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
