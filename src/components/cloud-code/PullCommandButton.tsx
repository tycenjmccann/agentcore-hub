"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Copy, Check, Terminal } from "lucide-react";

interface PullCommandButtonProps {
  /** The session's `cc-...` id — already carries its own prefix. */
  sessionId: string;
  className?: string;
}

/**
 * Copies the exact CLI command to pull this session down to a local terminal.
 * A web-started session has no easy way to surface its id to the terminal, so
 * we hand the user the whole command — tap to copy, paste into Claude Code. The
 * slash form matches the hub MCP (`/mcp__agentcore-hub__pull`).
 */
export function PullCommandButton({ sessionId, className }: PullCommandButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const command = `/mcp__agentcore-hub__pull ${sessionId}`;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = command;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [command]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={`Copy pull command — ${command}`}
      aria-label="Copy the command to pull this session into your terminal"
      className={`flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium border transition-colors ${
        copied
          ? "text-brand-300 border-brand-500/40 bg-brand-500/10"
          : "text-[var(--color-text-muted)] border-[var(--color-border)] hover:text-[var(--color-text-primary)]"
      } ${className ?? ""}`}
    >
      {copied ? (
        <>
          <Check className="w-3 h-3" strokeWidth={2.4} /> Copied
        </>
      ) : (
        <>
          <Terminal className="w-3 h-3" strokeWidth={2.2} /> Pull
          <Copy className="w-3 h-3 opacity-60" strokeWidth={2.2} />
        </>
      )}
    </button>
  );
}

