"use client";

/**
 * Starting a smoke test (a "probe" in the registry). The two cost very different
 * things — the API check is one cheap call, the CLI check starts a real coding
 * turn — so the menu says so before the click rather than after. Labels are
 * operator vocabulary; the data-testids keep the old names on purpose.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { probeModeLabel } from "./format";
import type { ProbeMode } from "./types";

export function TestMenu({
  modelId,
  disabled,
  onStart,
}: {
  modelId: string;
  disabled?: boolean;
  onStart: (mode: ProbeMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!container.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function start(mode: ProbeMode) {
    setOpen(false);
    onStart(mode);
  }

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid={`catalog-test-${modelId}`}
        className="text-[11px] px-2 py-1 rounded-lg border border-theme text-secondary hover:text-primary transition-colors inline-flex items-center gap-1 disabled:opacity-40"
      >
        Test
        <ChevronDown className="w-3 h-3" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Test ${modelId}`}
          className="absolute right-0 z-20 mt-1 w-64 rounded-lg border border-theme bg-surface-2 p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => start("api")}
            data-testid={`catalog-test-api-${modelId}`}
            className="w-full text-left text-[11px] px-2 py-1.5 rounded text-secondary hover:text-primary hover:bg-surface-3 transition-colors"
          >
            {probeModeLabel("api")}
            <span className="block text-[10px] text-muted">One small call against the model endpoint.</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => start("cli")}
            data-testid={`catalog-test-cli-${modelId}`}
            className="w-full text-left text-[11px] px-2 py-1.5 rounded text-secondary hover:text-primary hover:bg-surface-3 transition-colors"
          >
            {probeModeLabel("cli")} (~2 min)
            <span className="block text-[10px] text-muted">Runs a real coding turn and takes 60 to 120 seconds.</span>
          </button>
        </div>
      )}
    </div>
  );
}
