"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";

interface DeleteConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  isLoading: boolean;
  error?: string | null;
}

export default function DeleteConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  isLoading,
  error,
}: DeleteConfirmationModalProps) {
  const [mounted, setMounted] = useState(false);
  const [exiting, setExiting] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (isOpen && cancelRef.current) {
      cancelRef.current.focus();
    }
  }, [isOpen]);

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
        aria-labelledby="delete-modal-title"
        aria-describedby="delete-modal-desc"
        aria-busy={isLoading}
      >
        <div className="flex justify-center mb-4">
          <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
            <Trash2 className="w-6 h-6 text-red-500" />
          </div>
        </div>

        <h2
          id="delete-modal-title"
          className="text-base font-semibold text-[var(--pipeline-text,#e2e8f0)] text-center mb-2"
        >
          Delete Workflow?
        </h2>

        <p
          id="delete-modal-desc"
          className="text-[13px] text-[var(--pipeline-text-secondary,#94a3b8)] text-center mb-6 leading-relaxed"
        >
          Delete this workflow run? This removes its events and cannot be undone.
        </p>

        {error && (
          <p className="text-xs text-red-400 text-center mb-4 px-2">
            {error}
          </p>
        )}

        <div className="border-t border-[var(--pipeline-border,#1e293b)] pt-4">
          <div className="flex justify-end gap-3">
            <button
              ref={cancelRef}
              onClick={handleClose}
              disabled={isLoading}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-[var(--pipeline-border,#1e293b)] bg-transparent text-[var(--pipeline-text-secondary,#94a3b8)] hover:border-[var(--pipeline-text-muted,#64748b)] hover:text-[var(--pipeline-text,#e2e8f0)] transition-all disabled:opacity-50 disabled:pointer-events-none"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={isLoading}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-red-500 text-white hover:bg-red-600 active:bg-red-700 transition-all disabled:opacity-80 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isLoading ? (
                <>
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
