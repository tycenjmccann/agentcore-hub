"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, AlertCircle, FileText, TerminalSquare, Send, ChevronRight } from "lucide-react";
import type { AgentTask, AgentRun } from "@/lib/workflow/types";
import { MarkdownRenderer } from "./MarkdownRenderer";
import "./pipeline.css";

interface AgentOutputPanelProps {
  task: AgentTask | null;
  /** Per-run output (newest handling done in-panel). One card per dispatch. */
  runs?: AgentRun[];
  /** Ticket id of the run that is currently live (auto-expanded, marked "Working"). */
  currentTicketId?: string;
  isOpen: boolean;
  onClose: () => void;
  isLoading?: boolean;
  isStale?: boolean;
  workflowId?: string;
  triggerRef?: React.RefObject<HTMLElement | null>;
  lastToolName?: string;
  lastEvent?: string; // Human-readable last event from the SSE stream (from DDB)
  lastActivityTime?: number; // Date.now() timestamp of last streaming activity
  staleThreshold?: number; // ms — threshold for stale detection (720_000 or 180_000)
  onRestart?: () => void;
}

/** Insert paragraph breaks between statements jammed together by buffer
 *  concatenation (e.g. "...implementation:Let me" → two paragraphs). */
function unjam(text: string): string {
  return text.replace(/(:)([A-Z])/g, "$1\n\n$2");
}

function fmtClock(iso: string): string {
  if (!iso) return "";
  // Timestamps are "YYYY-MM-DDTHH:MM:SS.nnnnZ" (UTC) — show HH:MM local.
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Remote coding sessions leave a footer in the agent's output:
 *  [coding-session: cc-<hex> cli=claude conversation=<id>]
 *  Each session id is a live, resumable Cloud Code session. */
function extractCodingSessions(output: string): { sessionId: string; cli: string }[] {
  const seen = new Set<string>();
  const sessions: { sessionId: string; cli: string }[] = [];
  for (const m of output.matchAll(/\[coding-session:\s*(cc-[a-f0-9]+)\s+cli=(\w+)/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      sessions.push({ sessionId: m[1], cli: m[2] });
    }
  }
  return sessions;
}

/** Format agent ID to display name */
function formatAgentName(agentId: string): string {
  return agentId
    .replace(/^agentcore_hub_/, "")
    .split(/[_-]/)
    .map((word) => {
      const upper = word.toUpperCase();
      if (["IOS", "API", "UI", "QA"].includes(upper)) return upper;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/** One collapsible card = one dispatch of the agent. Its own streamed text +
 *  its own summary, so re-runs never bleed into each other. */
function RunCard({
  run,
  index,
  total,
  isCurrent,
  defaultOpen,
}: {
  run: AgentRun;
  index: number; // 1-based, in chronological order
  total: number;
  isCurrent: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // Keep the live run expanded as it streams even if props re-mount.
  useEffect(() => {
    if (isCurrent) setOpen(true);
  }, [isCurrent]);

  const stream = run.stream ? unjam(run.stream) : "";
  const started = fmtClock(run.startedAt);

  return (
    <div className={`run-card ${isCurrent ? "run-card-live" : ""}`}>
      <button
        type="button"
        className="run-card-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ChevronRight size={14} className={`run-card-chevron ${open ? "open" : ""}`} aria-hidden="true" />
        <span className="run-card-index">Run {index}<span className="run-card-of">/{total}</span></span>
        {run.ticketId && <span className="run-card-ticket">{run.ticketId}</span>}
        <span className={`run-card-badge ${isCurrent ? "live" : "done"}`}>
          {isCurrent ? "Working" : "Done"}
        </span>
        <span className="run-card-spacer" />
        {started && <span className="run-card-time">{started}</span>}
      </button>
      {open && (
        <div className="run-card-body">
          {stream && (
            <div className="run-card-stream">
              <MarkdownRenderer content={stream} />
            </div>
          )}
          {run.summary && (
            <div className="run-card-summary">
              <div className="run-card-summary-label">Summary</div>
              <MarkdownRenderer content={run.summary} />
            </div>
          )}
          {!stream && !run.summary && (
            <div className="run-card-empty">
              {isCurrent ? "Waiting for output…" : "No output recorded for this run."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AgentOutputPanel({
  task,
  runs = [],
  currentTicketId = "",
  isOpen,
  onClose,
  isLoading,
  isStale,
  workflowId,
  triggerRef,
  lastToolName,
  lastEvent,
  lastActivityTime,
  staleThreshold,
  onRestart,
}: AgentOutputPanelProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [isAnimatingOut, setIsAnimatingOut] = useState(false);
  const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Count-up timer: seconds since last activity
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    if (!isOpen || !lastActivityTime || task?.status === "complete") {
      setElapsedSec(0);
      return;
    }
    const tick = () => setElapsedSec(Math.floor((Date.now() - lastActivityTime) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [isOpen, lastActivityTime, task?.status]);

  // Clear restarting state when agent comes back to life (isStale clears)
  // or after 30s timeout (so button isn't stuck disabled forever if agent never starts)
  useEffect(() => {
    if (!isStale && isRestarting) {
      setIsRestarting(false);
    }
  }, [isStale, isRestarting]);

  useEffect(() => {
    if (!isRestarting) return;
    const timeout = setTimeout(() => setIsRestarting(false), 30_000);
    return () => clearTimeout(timeout);
  }, [isRestarting]);

  // Portal mount (client-only)
  useEffect(() => {
    setMounted(true);
  }, []);

  // Operator message composer — queue a mid-flow message for a running agent.
  const [messageDraft, setMessageDraft] = useState("");
  const [messageState, setMessageState] = useState<"idle" | "sending" | "queued" | "error">("idle");
  // The panel stays mounted across agent switches — drop any draft typed for
  // the previous agent so it can't be sent to the wrong one.
  useEffect(() => {
    setMessageDraft("");
    setMessageState("idle");
  }, [workflowId, task?.agentId]);
  const sendOperatorMessage = useCallback(async () => {
    const message = messageDraft.trim();
    if (!message || !workflowId || !task?.agentId || messageState === "sending") return;
    setMessageState("sending");
    try {
      const resp = await fetch(`/api/workflow/${workflowId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: task.agentId, message }),
      });
      if (!resp.ok) throw new Error(`${resp.status}`);
      setMessageDraft("");
      setMessageState("queued");
      setTimeout(() => setMessageState("idle"), 3000);
    } catch {
      setMessageState("error");
      setTimeout(() => setMessageState("idle"), 4000);
    }
  }, [messageDraft, workflowId, task?.agentId, messageState]);

  // Remote coding sessions this agent-task ran (Cloud Code runtime). Primary
  // source is the sessions table (footer text may not survive streaming);
  // footers found in the output text are merged in as a fallback.
  const [codingSessions, setCodingSessions] = useState<{ sessionId: string; cli: string }[]>([]);
  useEffect(() => {
    if (!isOpen || !workflowId || !task?.agentId) {
      setCodingSessions([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/cloud-code/sessions?workflowId=${encodeURIComponent(workflowId)}&agentId=${encodeURIComponent(task.agentId)}`)
      .then((r) => (r.ok ? r.json() : { sessions: [] }))
      .then((d) => {
        if (cancelled) return;
        const fromTable = (d.sessions || []).map(
          (s: { sessionId: string; cli: string }) => ({ sessionId: s.sessionId, cli: s.cli })
        );
        const fromFooter = task?.output ? extractCodingSessions(task.output) : [];
        const seen = new Set<string>();
        setCodingSessions(
          [...fromTable, ...fromFooter].filter((s) => {
            if (seen.has(s.sessionId)) return false;
            seen.add(s.sessionId);
            return true;
          })
        );
      })
      .catch(() => {
        if (!cancelled && task?.output) setCodingSessions(extractCodingSessions(task.output));
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, workflowId, task?.agentId, task?.output]);

  // Auto-scroll to bottom when output changes (streaming)
  useEffect(() => {
    if (contentRef.current && task?.output && isAutoScrollEnabled) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [task?.output, isAutoScrollEnabled]);

  // Scroll to summary section when panel opens OR when output loads (async fetch)
  const hasScrolledRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      hasScrolledRef.current = false;
      return;
    }
    if (hasScrolledRef.current || !contentRef.current || !task?.output) return;
    // Wait a frame for the DOM to render the summary ref
    requestAnimationFrame(() => {
      if (summaryRef.current && contentRef.current) {
        hasScrolledRef.current = true;
        contentRef.current.scrollTop = summaryRef.current.offsetTop - contentRef.current.offsetTop;
      } else if (contentRef.current && task?.status !== "running") {
        // No summary section and not streaming — scroll to bottom
        hasScrolledRef.current = true;
        contentRef.current.scrollTop = contentRef.current.scrollHeight;
      }
    });
  }, [isOpen, task?.output, task?.status]);

  // Focus management: trap focus, return on close
  useEffect(() => {
    if (!isOpen || !modalRef.current) return;

    // Save previous focus
    previousFocusRef.current = document.activeElement as HTMLElement;

    // Focus close button on open
    const timer = setTimeout(() => {
      closeButtonRef.current?.focus();
    }, 50);

    return () => clearTimeout(timer);
  }, [isOpen]);

  // Focus trap
  useEffect(() => {
    if (!isOpen || !modalRef.current) return;

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !modalRef.current) return;

      const focusableSelector =
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
      const focusableEls = modalRef.current.querySelectorAll(focusableSelector);
      if (focusableEls.length === 0) return;

      const firstFocusable = focusableEls[0] as HTMLElement;
      const lastFocusable = focusableEls[focusableEls.length - 1] as HTMLElement;

      if (e.shiftKey) {
        if (document.activeElement === firstFocusable) {
          e.preventDefault();
          lastFocusable?.focus();
        }
      } else {
        if (document.activeElement === lastFocusable) {
          e.preventDefault();
          firstFocusable?.focus();
        }
      }
    };

    document.addEventListener("keydown", handleTab);
    return () => document.removeEventListener("keydown", handleTab);
  }, [isOpen]);

  // Scroll lock
  useEffect(() => {
    if (isOpen) {
      const scrollY = window.scrollY;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
        window.scrollTo(0, scrollY);
      };
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    setIsAnimatingOut(true);
  }, []);

  // Close on Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen && !isAnimatingOut) {
        handleClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, isAnimatingOut, handleClose]);

  const handleAnimationEnd = useCallback(() => {
    if (isAnimatingOut) {
      setIsAnimatingOut(false);
      onClose();
      // Return focus to trigger element
      if (triggerRef?.current) {
        triggerRef.current.focus();
      } else if (previousFocusRef.current) {
        previousFocusRef.current.focus();
      }
    }
  }, [isAnimatingOut, onClose, triggerRef]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        handleClose();
      }
    },
    [handleClose]
  );

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const isAtBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setIsAutoScrollEnabled(isAtBottom);
  }, []);

  // Don't render if not open (and not animating out)
  if ((!isOpen && !isAnimatingOut) || !mounted) return null;

  const agentName = task ? formatAgentName(task.agentId) : "Agent Output";
  const isRunning = task?.status === "running";

  const statusClass = task?.status === "running"
    ? "running"
    : task?.status === "complete"
    ? "complete"
    : task?.status === "error"
    ? "error"
    : "";

  const statusLabel = task?.status === "running"
    ? "Working"
    : task?.status === "complete"
    ? "Complete"
    : task?.status === "error"
    ? "Error"
    : task?.status || "";

  const modal = (
    <div
      className={`modal-backdrop ${isAnimatingOut ? "modal-backdrop-exit" : "modal-backdrop-enter"}`}
      onClick={handleBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-output-title"
        className={`agent-output-modal ${isAnimatingOut ? "modal-card-exit" : "modal-card-enter"}`}
        ref={modalRef}
        onAnimationEnd={handleAnimationEnd}
      >
        {/* Header */}
        <div className="modal-header">
          <div className="flex items-center min-w-0 flex-1">
            <h2
              id="agent-output-title"
              className="modal-header-title truncate"
            >
              {agentName}
            </h2>
            {statusLabel && (
              <span className={`modal-header-status ${statusClass}`}>
                {statusLabel}
              </span>
            )}
          </div>
          <button
            ref={closeButtonRef}
            className="modal-close-btn"
            onClick={handleClose}
            aria-label="Close agent output"
            type="button"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Content */}
        <div
          className="modal-content"
          ref={contentRef}
          onScroll={handleScroll}
        >
          {isLoading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: "rgba(15, 15, 20, 0.85)", backdropFilter: "blur(2px)" }}>
              <div className="flex flex-col items-center gap-3">
                <div className="w-6 h-6 border-2 border-[var(--pipeline-text-dim)] border-t-[var(--pipeline-text)] rounded-full animate-spin" />
                <span className="text-xs text-[var(--pipeline-text-secondary)]">Loading output...</span>
              </div>
            </div>
          )}
          {runs.length > 0 ? (
            <div className="run-list">
              {runs.length > 1 && (
                <div className="run-list-caption">
                  {runs.length} runs · newest first
                </div>
              )}
              {/* Newest on top. The run matching the live ticket (while the agent
                  is running) is the current one — auto-expanded and badged Working. */}
              {[...runs].reverse().map((run, revIdx) => {
                const chronoIndex = runs.length - revIdx; // 1-based chronological
                const isCurrent = isRunning && !!currentTicketId && run.ticketId === currentTicketId;
                return (
                  <RunCard
                    key={run.ticketId || `run-${chronoIndex}`}
                    run={run}
                    index={chronoIndex}
                    total={runs.length}
                    isCurrent={isCurrent}
                    defaultOpen={isCurrent || revIdx === 0}
                  />
                );
              })}
            </div>
          ) : isRunning ? (
            <div className="flex flex-col items-center justify-center h-48 text-center">
              <div className="streaming-indicator" aria-hidden="true">
                <span className="streaming-cursor" />
                <span className="streaming-dots">
                  <span className="streaming-dot" />
                  <span className="streaming-dot" />
                  <span className="streaming-dot" />
                </span>
              </div>
              <p className="text-sm mt-3" style={{ color: "var(--pipeline-text-muted)" }}>
                Waiting for output...
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-center">
              <div className="w-8 h-8 rounded-full flex items-center justify-center mb-3" style={{ background: "rgba(100, 116, 139, 0.15)" }}>
                <FileText size={16} style={{ color: "var(--pipeline-text-muted)" }} aria-hidden="true" />
              </div>
              <p className="text-sm" style={{ color: "var(--pipeline-text-muted)" }}>
                No output yet.
              </p>
              <p className="text-xs mt-1" style={{ color: "var(--pipeline-text-dim)" }}>
                Output will appear here when the agent starts working.
              </p>
            </div>
          )}
        </div>

        {/* Operator message composer — only for a live agent */}
        {task && workflowId && (task.status === "running" || task.status === "waiting_response") && (
          <div
            className="flex items-center gap-2 px-4 py-2 border-t"
            style={{ borderColor: "var(--pipeline-border)", background: "rgba(15, 15, 20, 0.6)" }}
          >
            <input
              type="text"
              value={messageDraft}
              onChange={(e) => setMessageDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendOperatorMessage();
                }
              }}
              placeholder="Message this agent — delivered at its next tool call…"
              maxLength={4000}
              className="flex-1 bg-transparent text-sm outline-none px-2 py-1.5 rounded border"
              style={{
                color: "var(--pipeline-text)",
                borderColor: "rgba(99, 102, 241, 0.25)",
              }}
              aria-label="Send a message to this agent"
            />
            <button
              onClick={sendOperatorMessage}
              disabled={!messageDraft.trim() || messageState === "sending"}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors disabled:opacity-40"
              style={{
                background: "rgba(99, 102, 241, 0.15)",
                color: "#a5b4fc",
                border: "1px solid rgba(99, 102, 241, 0.3)",
              }}
              type="button"
            >
              <Send size={13} aria-hidden="true" />
              {messageState === "sending" ? "Queuing…" : messageState === "queued" ? "Queued ✓" : messageState === "error" ? "Failed — retry" : "Send"}
            </button>
          </div>
        )}

        {/* Footer */}
        {task && (() => {
          const threshold = staleThreshold || 720_000;
          const thresholdSec = threshold / 1000;
          const isRunningAgent = task.status === "running" || task.status === "waiting_response";
          // Timer color: green → orange (last 30s before threshold) → red (past threshold)
          const timerColor = elapsedSec >= thresholdSec
            ? "#ef4444" // red — stale
            : elapsedSec >= thresholdSec - 30
            ? "#f59e0b" // amber — approaching
            : "#22c55e"; // green — healthy
          const timerGlow = elapsedSec >= thresholdSec
            ? "0 0 8px rgba(239, 68, 68, 0.6)"
            : elapsedSec >= thresholdSec - 30
            ? "0 0 6px rgba(245, 158, 11, 0.4)"
            : "none";
          const formatTime = (s: number) => {
            const m = Math.floor(s / 60);
            const sec = s % 60;
            return `${m}:${sec.toString().padStart(2, "0")}`;
          };
          // Format tool name for display
          const displayTool = lastToolName
            ? lastToolName.replace(/___/g, ".").replace(/_/g, " ")
            : null;

          return (
            <div className="modal-footer">
              <div className="flex items-center gap-3">
                {/* Status */}
                <span className="text-xs font-medium" style={{ color: isStale ? "#ef4444" : "#22c55e" }}>
                  {isStale ? "STUCK" : isRunningAgent ? "ACTIVE" : task.status.toUpperCase()}
                </span>

                {/* Idle timer */}
                {isRunningAgent && lastActivityTime && (
                  <span
                    className="text-xs font-mono font-bold tabular-nums"
                    style={{
                      color: timerColor,
                      textShadow: timerGlow,
                      transition: "color 0.5s, text-shadow 0.5s",
                    }}
                  >
                    {formatTime(elapsedSec)}
                  </span>
                )}

                {/* Last event from DB stream */}
                {isRunningAgent && (lastEvent || displayTool) && (
                  <span
                    className="px-2 py-0.5 rounded text-xs font-mono truncate max-w-[300px]"
                    style={{
                      background: "rgba(99, 102, 241, 0.12)",
                      color: "#a5b4fc",
                      border: "1px solid rgba(99, 102, 241, 0.25)",
                    }}
                  >
                    {lastEvent || (displayTool ? `Tool: ${displayTool}` : "")}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {codingSessions.map(({ sessionId, cli }) => (
                  <a
                    key={sessionId}
                    href={`/cloud-code?session=${sessionId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors"
                    style={{
                      background: "rgba(34, 197, 94, 0.12)",
                      color: "#4ade80",
                      border: "1px solid rgba(34, 197, 94, 0.3)",
                    }}
                    title={`Resume this agent's ${cli} session in Cloud Code`}
                  >
                    <TerminalSquare size={13} aria-hidden="true" />
                    Open in Cloud Code{cli === "codex" ? " (codex)" : ""}
                  </a>
                ))}
                {task.error && (
                  <div className="flex items-center gap-1.5">
                    <AlertCircle size={14} style={{ color: "var(--pipeline-error)" }} aria-hidden="true" />
                    <span className="modal-footer-error truncate max-w-[400px]">
                      {task.error}
                    </span>
                  </div>
                )}
                {(isStale || task.status === "error") && workflowId && (
                  <button
                    onClick={async () => {
                      if (isRestarting) return;
                      setIsRestarting(true);
                      try {
                        const resp = await fetch(`/api/workflow/${workflowId}/retry`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ agentId: task.agentId }),
                        });
                        if (resp.ok) {
                          onRestart?.();
                        }
                      } catch { setIsRestarting(false); }
                    }}
                    disabled={isRestarting}
                    className="px-3 py-1.5 text-xs font-medium rounded bg-amber-600/80 text-white hover:bg-amber-500 disabled:opacity-50 transition-colors"
                  >
                    {isRestarting ? "Starting session..." : "Restart Agent"}
                  </button>
                )}
              </div>
            </div>
          );
        })()}

        {/* Screen reader live region */}
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {isRunning && "Agent is producing output..."}
          {task?.status === "complete" && "Agent output complete."}
          {task?.status === "error" && `Agent encountered an error: ${task.error}`}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
