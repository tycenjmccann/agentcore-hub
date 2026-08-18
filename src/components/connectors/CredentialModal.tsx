"use client";

/**
 * Secure credential entry for a connector. The values typed here POST straight to
 * /api/connectors/[id]/credentials → Secrets Manager. They are never echoed back,
 * never stored in the registry, and never seen by the builder/LLM. Fields are
 * password inputs; nothing is persisted client-side.
 */

import { useState } from "react";
import { X, KeyRound, ShieldCheck } from "lucide-react";
import type { ConnectorSummary } from "@/lib/connectors/types";

export default function CredentialModal({
  connector,
  onClose,
  onSaved,
}: {
  connector: ConnectorSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allFilled = connector.secretKeys.every((k) => values[k]?.trim());

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/connectors/${connector.id}/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to save credentials");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-[#8b5cf6]" />
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Connect {connector.name}
            </h2>
          </div>
          <button onClick={onClose} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="flex items-start gap-2 text-xs text-[var(--color-text-muted)]">
            <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0 text-green-500" />
            Stored encrypted in AWS Secrets Manager. Never shown to agents or the
            builder, never returned by the API.
          </p>

          {connector.secretKeys.map((key) => (
            <label key={key} className="block">
              <span className="text-xs font-medium text-[var(--color-text-secondary)]">{key}</span>
              <input
                type="password"
                autoComplete="off"
                value={values[key] || ""}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                className="mt-1 w-full rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:ring-1 focus:ring-[#8b5cf6]"
                placeholder={`Enter ${key}`}
              />
            </label>
          ))}

          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--color-border)]">
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-lg text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!allFilled || saving}
            className="px-4 py-2 rounded-lg bg-[#8b5cf6] hover:bg-[#7c3aed] disabled:opacity-50 text-white text-sm font-medium transition-colors"
          >
            {saving ? "Saving…" : "Save credentials"}
          </button>
        </div>
      </div>
    </div>
  );
}
