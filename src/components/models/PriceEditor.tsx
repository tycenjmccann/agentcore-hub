"use client";

/**
 * Hand-entering a model's price, for the gap between AWS shipping a model and
 * shipping its published rate. A manual price is a staged edit like any other —
 * nothing is written until Save — and it is stamped `manual` so the badge tells
 * everyone downstream that the cost figures built on it are somebody's typing
 * rather than a price list.
 *
 * Input and output are required because a half-price is worse than no price: cost
 * math would silently treat the missing side as zero. The cache rates are optional
 * and left empty rather than zeroed when unknown.
 */

import { useState } from "react";
import type { Price } from "./types";

const FIELD =
  "w-24 px-2 py-1 text-xs rounded-lg bg-surface-2 border border-theme text-primary tabular-nums focus:outline-none focus:border-brand-600/50";

function parseRate(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function PriceEditor({
  modelId,
  price,
  onSave,
  onCancel,
}: {
  modelId: string;
  price: Price | undefined;
  onSave: (price: Price) => void;
  onCancel: () => void;
}) {
  const [input, setInput] = useState(price?.input != null ? String(price.input) : "");
  const [output, setOutput] = useState(price?.output != null ? String(price.output) : "");
  const [cacheRead, setCacheRead] = useState(price?.cacheReadInput != null ? String(price.cacheReadInput) : "");
  const [cacheWrite, setCacheWrite] = useState(price?.cacheWrite != null ? String(price.cacheWrite) : "");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const parsedInput = parseRate(input);
    const parsedOutput = parseRate(output);
    if (parsedInput == null || parsedOutput == null) {
      setError("Input and output rates are required, as numbers of dollars per 1M tokens.");
      return;
    }
    const parsedCacheRead = parseRate(cacheRead);
    const parsedCacheWrite = parseRate(cacheWrite);
    if ((cacheRead.trim() && parsedCacheRead == null) || (cacheWrite.trim() && parsedCacheWrite == null)) {
      setError("Cache rates must be numbers of dollars per 1M tokens, or left empty.");
      return;
    }
    setError(null);
    onSave({
      input: parsedInput,
      output: parsedOutput,
      ...(parsedCacheRead != null ? { cacheReadInput: parsedCacheRead } : {}),
      ...(parsedCacheWrite != null ? { cacheWrite: parsedCacheWrite } : {}),
      source: "manual",
      asOf: new Date().toISOString().slice(0, 10),
    });
  }

  return (
    <div className="mt-2 p-3 rounded-lg bg-surface-2 border border-theme" data-testid={`catalog-price-editor-${modelId}`}>
      <p className="text-[11px] text-muted mb-2">Dollars per 1M tokens. Saved as a manual price.</p>
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label htmlFor={`price-input-${modelId}`} className="block text-[10px] text-muted mb-1">
            input
          </label>
          <input
            id={`price-input-${modelId}`}
            inputMode="decimal"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            data-testid={`catalog-price-input-${modelId}`}
            className={FIELD}
          />
        </div>
        <div>
          <label htmlFor={`price-output-${modelId}`} className="block text-[10px] text-muted mb-1">
            output
          </label>
          <input
            id={`price-output-${modelId}`}
            inputMode="decimal"
            value={output}
            onChange={(e) => setOutput(e.target.value)}
            data-testid={`catalog-price-output-${modelId}`}
            className={FIELD}
          />
        </div>
        <div>
          <label htmlFor={`price-cache-read-${modelId}`} className="block text-[10px] text-muted mb-1">
            cache-read
          </label>
          <input
            id={`price-cache-read-${modelId}`}
            inputMode="decimal"
            value={cacheRead}
            onChange={(e) => setCacheRead(e.target.value)}
            data-testid={`catalog-price-cache-read-${modelId}`}
            className={FIELD}
          />
        </div>
        <div>
          <label htmlFor={`price-cache-write-${modelId}`} className="block text-[10px] text-muted mb-1">
            cache-write
          </label>
          <input
            id={`price-cache-write-${modelId}`}
            inputMode="decimal"
            value={cacheWrite}
            onChange={(e) => setCacheWrite(e.target.value)}
            data-testid={`catalog-price-cache-write-${modelId}`}
            className={FIELD}
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            data-testid={`catalog-price-cancel-${modelId}`}
            className="text-[11px] px-2 py-1 rounded-lg border border-theme text-secondary hover:text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            data-testid={`catalog-price-save-${modelId}`}
            className="text-[11px] px-2 py-1 rounded-lg bg-brand-600 text-white font-medium"
          >
            Stage price
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-danger-fg mt-2">
          {error}
        </p>
      )}
    </div>
  );
}
