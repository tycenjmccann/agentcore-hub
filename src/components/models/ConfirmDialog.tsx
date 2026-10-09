"use client";

/**
 * Confirmation for the two actions on this page that are not just a staged edit:
 * quarantining a model (it leaves every select immediately) and rolling back to a
 * previous version (it writes a new version straight away, prices and probes
 * included). Both name their consequence in the body text rather than asking
 * "are you sure".
 *
 * Focus is trapped while it is open and returned to whatever opened it, because
 * the page underneath is a long form — losing your place in it is the real cost
 * of a careless dialog.
 */

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const accept = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    accept.current?.focus();
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>("button:not([disabled])");
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0/80 px-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-body"
        data-testid="confirm-dialog"
        className="card max-w-md w-full"
      >
        <h3 id="confirm-dialog-title" className="text-sm font-semibold text-primary">
          {title}
        </h3>
        <p id="confirm-dialog-body" className="text-xs text-secondary mt-2 leading-relaxed">
          {body}
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid="confirm-cancel"
            className="text-xs px-3 py-1.5 rounded-lg border border-theme text-secondary hover:text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            ref={accept}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-accept"
            className="text-xs px-3 py-1.5 rounded-lg bg-brand-600 text-white font-medium inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            {busy && <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
