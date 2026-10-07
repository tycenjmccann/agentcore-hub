"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";

// TEAM-5358 FR-3: /cancel and /stop both refuse an empty reason (400
// reason_required) and one over this many characters (reason_too_long, never
// clamped). Equal to CANCEL_REASON_MAX in src/lib/workflow/cancel-run.ts, which
// pulls the AWS SDK and so cannot be imported into a client component;
// __tests__/cancel-reason-max.test.ts pins the two together.
const REASON_MAX = 1000;

/** What POST /api/workflow/[id]/stop answered on a 200 (TEAM-5358 FR-8). */
export interface StopResult {
  gatesStopped: string[];
  gatesNotStopped: { ticketId: string; error: string }[];
  humanGatesLeftOpen?: unknown[];
}

interface CancelConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the trimmed, non-empty reason the user typed. */
  onConfirm: (reason: string) => Promise<void>;
  isLoading: boolean;
  error?: string | null;
  /** "stop" = Stop the run (/stop): every open human gate gets a stopped decision, then cancel. */
  mode?: "cancel" | "stop";
  /** Prefills the reason (the user still edits and confirms it). */
  initialReason?: string;
  /** Stop mode only: the committed stop's result, shown instead of the form. */
  result?: StopResult | null;
}

export default function CancelConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  isLoading,
  error,
  mode = "cancel",
  initialReason,
  result,
}: CancelConfirmationModalProps) {
  const [mounted, setMounted] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [reason, setReason] = useState("");
  const keepRunningRef = useRef<HTMLButtonElement>(null);
  const stopping = mode === "stop";

  // Fresh reason on every open.
  useEffect(() => {
    if (isOpen) setReason(initialReason ?? "");
  }, [isOpen, initialReason]);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Focus "Keep Running" on open (safe default)
  useEffect(() => {
    if (isOpen && keepRunningRef.current) {
      keepRunningRef.current.focus();
    }
  }, [isOpen]);

  // Escape key to close (disabled during loading)
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isLoading) {
        handleClose();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, isLoading]);

  const handleClose = useCallback(() => {
    if (isLoading) return;
    setExiting(true);
    setTimeout(() => {
      setExiting(false);
      onClose();
    }, 180);
  }, [isLoading, onClose]);

  if (!mounted || !isOpen) return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-[200] grid place-items-center p-4 ${exiting ? "modal-backdrop-exit" : "modal-backdrop-enter"}`}
      style={{ background: "rgba(0, 0, 0, 0.6)" }}
      onClick={() => { if (!isLoading) handleClose(); }}
      role="presentation"
    >
      <div
        className={`relative z-[201] w-full max-w-md bg-[var(--pipeline-card-bg,#1a2332)] border border-[var(--pipeline-border,#1e293b)] rounded-xl p-6 ${exiting ? "modal-card-exit" : "modal-card-enter"}`}
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-labelledby="cancel-modal-title"
        aria-describedby="cancel-modal-desc"
        aria-busy={isLoading}
      >
        {/* Warning Icon */}
        <div className="flex justify-center mb-4">
          <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-amber-500" />
          </div>
        </div>

        {/* Title */}
        <h2
          id="cancel-modal-title"
          className="text-base font-semibold text-[var(--pipeline-text,#e2e8f0)] text-center mb-2"
        >
          {stopping ? "Stop the run?" : "Cancel Workflow?"}
        </h2>

        {/* Description */}
        <p
          id="cancel-modal-desc"
          className="text-[13px] text-[var(--pipeline-text-secondary,#94a3b8)] text-center mb-6 leading-relaxed"
        >
          {stopping
            ? "Every open human gate is closed with a recorded stopped decision, then the run is cancelled. Requires a signed-in human."
            : "This will stop all pending work. Agents currently running will finish their current turn but no new agents will be started. Completed artifacts, PRs, and branches will be preserved."}
        </p>

        {result ? (
          <div data-testid="stop-result" className="text-[12px] text-[var(--pipeline-text-secondary,#94a3b8)] mb-4 space-y-2">
            <p>
              Stopped {result.gatesStopped.length} gate{result.gatesStopped.length === 1 ? "" : "s"}
              {result.gatesStopped.length > 0 && <>: <span className="font-mono">{result.gatesStopped.join(", ")}</span></>}
            </p>
            {result.gatesNotStopped.length > 0 && (
              <div className="text-red-400">
                <p>Not stopped (these gates stay open):</p>
                <ul className="list-disc pl-5">
                  {result.gatesNotStopped.map((g) => (
                    <li key={g.ticketId}>
                      <span className="font-mono">{g.ticketId}</span> — {g.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <div className="mb-4">
            <label
              htmlFor="cancel-modal-reason"
              className="block text-[11px] uppercase tracking-wider text-[var(--pipeline-text-muted,#64748b)] mb-1.5"
            >
              Reason (required)
            </label>
            <textarea
              id="cancel-modal-reason"
              data-testid="cancel-modal-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={REASON_MAX}
              required
              aria-required="true"
              rows={3}
              disabled={isLoading}
              placeholder={stopping ? "Why stop this run?" : "Why cancel this run?"}
              className="w-full rounded-lg border border-[var(--pipeline-border,#1e293b)] bg-transparent px-3 py-2 text-[13px] text-[var(--pipeline-text,#e2e8f0)] placeholder:text-[var(--pipeline-text-muted,#64748b)] focus:outline-none focus:ring-1 focus:ring-red-500/50"
            />
            <p className="text-[10px] text-right text-[var(--pipeline-text-muted,#64748b)]">
              {reason.length}/{REASON_MAX}
            </p>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <p className="text-xs text-red-400 text-center mb-4 px-2">
            {error}
          </p>
        )}

        {/* Divider */}
        <div className="border-t border-[var(--pipeline-border,#1e293b)] pt-4">
          {/* Actions */}
          <div className="flex justify-end gap-3">
            {result ? (
              <button
                onClick={handleClose}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-[var(--pipeline-border,#1e293b)] bg-transparent text-[var(--pipeline-text-secondary,#94a3b8)] hover:text-[var(--pipeline-text,#e2e8f0)] transition-all"
              >
                Close
              </button>
            ) : (
            <>
            <button
              ref={keepRunningRef}
              onClick={handleClose}
              disabled={isLoading}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-[var(--pipeline-border,#1e293b)] bg-transparent text-[var(--pipeline-text-secondary,#94a3b8)] hover:border-[var(--pipeline-text-muted,#64748b)] hover:text-[var(--pipeline-text,#e2e8f0)] transition-all disabled:opacity-50 disabled:pointer-events-none"
            >
              Keep Running
            </button>
            <button
              onClick={() => onConfirm(reason.trim())}
              disabled={isLoading || !reason.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-red-500 text-white hover:bg-red-600 active:bg-red-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isLoading ? (
                <>
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  {stopping ? "Stopping..." : "Cancelling..."}
                </>
              ) : (
                stopping ? "Stop the run" : "Cancel Workflow"
              )}
            </button>
            </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
