"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import type { AuthorizerType } from "./types";

export interface RegistrySubmitPayload {
  name: string;
  description: string;
  authorizerType: AuthorizerType;
  autoApproval: boolean;
}

const inputCls =
  "w-full px-3 py-2 text-sm rounded-lg bg-surface-2 border border-theme text-primary placeholder:text-muted focus:outline-none focus:border-brand-600/50";
const labelCls = "block text-xs font-medium text-secondary mb-1";

export default function RegistryModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (payload: RegistrySubmitPayload) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [authorizerType, setAuthorizerType] = useState<AuthorizerType>("AWS_IAM");
  const [autoApproval, setAutoApproval] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        authorizerType,
        autoApproval,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create registry.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="card w-full max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-primary">New Registry</h3>
          <button onClick={onClose} className="text-muted hover:text-primary" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className={labelCls}>Name</label>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-registry"
            />
          </div>
          <div>
            <label className={labelCls}>Description</label>
            <input
              className={inputCls}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this registry catalogs"
            />
          </div>
          <div>
            <label className={labelCls}>Authorizer type</label>
            <select
              className={inputCls}
              value={authorizerType}
              onChange={(e) => setAuthorizerType(e.target.value as AuthorizerType)}
            >
              <option value="AWS_IAM">AWS_IAM</option>
              <option value="CUSTOM_JWT">CUSTOM_JWT</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={autoApproval}
              onChange={(e) => setAutoApproval(e.target.checked)}
              className="rounded border-theme"
            />
            Auto-approve new records
          </label>

          {error && <p className="text-xs text-danger-fg">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-3 py-2 text-sm rounded-lg border border-theme text-secondary hover:text-primary"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-50"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
