"use client";

/**
 * Editing a catalog row's aliases — the other names that resolve to it, which is
 * how a span that names a model by its bare CLI id gets priced (TEAM-5065).
 * Discovery only adds rows, so this is the one place an alias is corrected.
 *
 * Staged like a price: nothing is written until Save, and the save path is the
 * same one as every other edit, so the server's validation (duplicate_alias,
 * bad_model_id) is the final word and lands back on this row.
 */

import { useState } from "react";
import { parseAliasInput } from "./format";

export function AliasEditor({
  modelId,
  aliases,
  onSave,
  onCancel,
}: {
  modelId: string;
  aliases: string[];
  onSave: (aliases: string[]) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(aliases.join(", "));
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const parsed = parseAliasInput(value, modelId);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onSave(parsed.aliases);
  }

  return (
    <div className="mt-2 p-3 rounded-lg bg-surface-2 border border-theme" data-testid={`catalog-alias-editor-${modelId}`}>
      <label htmlFor={`aliases-input-${modelId}`} className="block text-[11px] text-muted mb-2">
        Other names that resolve to this row, comma-separated. Leave empty for none.
      </label>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          id={`aliases-input-${modelId}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          aria-invalid={error ? true : undefined}
          data-testid={`catalog-aliases-input-${modelId}`}
          className="flex-1 min-w-[16rem] px-2 py-1 text-xs font-mono rounded-lg bg-surface-2 border border-theme text-primary focus:outline-none focus:border-brand-600/50"
        />
        <button
          type="button"
          onClick={onCancel}
          data-testid={`catalog-aliases-cancel-${modelId}`}
          className="text-[11px] px-2 py-1 rounded-lg border border-theme text-secondary hover:text-primary transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          data-testid={`catalog-aliases-save-${modelId}`}
          className="text-[11px] px-2 py-1 rounded-lg bg-brand-600 text-white font-medium"
        >
          Stage aliases
        </button>
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-danger-fg mt-2">
          {error}
        </p>
      )}
    </div>
  );
}
